import { chromiumExecutableOptions } from './lib/browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { assert, assertNoOverflow } from './lib/journey.mjs';

// Budgets are fixed before running. Their device ratification remains release.
const thresholds = Object.freeze({
  warmRenderMs: 2500,
  queryRenderMs: 1000,
  offlineColdRenderMs: 5000,
  longestTaskMs: 250,
});
const port = 8900 + (Date.now() % 250);
const origin = `http://127.0.0.1:${port}`;
const profile = await mkdtemp(join(tmpdir(), 'yelaxis-recovery-search-performance-'));
let serverOutput = '';
let server = start('dev');
let activePage;
let phase = 'seed';
let failureDiagnosed = false;
const workerLifetimes = [];
const watchdog = setTimeout(() => {
  stop(server);
  process.stderr.write('Search performance exceeded 10 minutes\n');
  process.exit(1);
}, 600000);
try {
  await ready();
  let context = await launch();
  let report;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    activePage = page;
    await page.goto(`${origin}/test/search-performance.html?database=%2Fyelaxis.sqlite3`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(
      () => document.querySelector('#result')?.getAttribute('data-status') !== 'running',
      undefined,
      { timeout: 500000 },
    );
    const status = await page.locator('#result').getAttribute('data-status');
    const result = await page.locator('#result').textContent();
    assert(status === 'passed', `Search worker performance failed: ${result ?? ''}`);
    report = JSON.parse(result ?? '{}');
  } catch (error) {
    await diagnose(activePage);
    throw error;
  } finally {
    await context.close();
  }
  await stop(server);
  serverOutput = '';
  server = start('preview');
  await ready();
  const errors = [];
  const external = [];
  context = await launch();
  let firstRenderMs;
  let warmRenderMs;
  let warmRenderSamplesMs;
  let activeSecondTabBlocked;
  let queryRenderMs;
  let longestTaskMs;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    activePage = page;
    observe(page, errors, external);
    await page.addInitScript(() => {
      window.__searchLongTasks = [];
      window.__searchStartupErrors = [];
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', (event) => {
            const response = event.data;
            if (response?.ok === false) {
              const entry = {
                at: performance.now(),
                code: response.error?.code,
                message: response.error?.message,
              };
              window.__searchStartupErrors.push(entry);
              void navigator.locks.query().then((locks) => {
                entry.locks = locks;
              });
            }
          });
        }
      };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__searchLongTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    });
    let started = performance.now();
    phase = 'first-production-render';
    await page.goto(`${origin}/search`, { waitUntil: 'domcontentloaded' });
    await useful(page);
    firstRenderMs = elapsed(started);
    await page.evaluate(() => navigator.serviceWorker.ready);
    phase = 'service-worker-reload';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await useful(page);
    const warmRuns = process.argv.includes('--startup-stress') ? 12 : 1;
    const warmTimes = [];
    for (let run = 0; run < warmRuns; run += 1) {
      started = performance.now();
      phase = `measured-warm-reload-${run + 1}`;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await useful(page);
      const duration = elapsed(started);
      assert(duration <= thresholds.warmRenderMs, `Warm Search ${duration}ms exceeds budget`);
      warmTimes.push(duration);
    }
    warmRenderMs = Math.max(...warmTimes);
    warmRenderSamplesMs = warmTimes;
    if (process.argv.includes('--startup-stress')) {
      phase = 'active-second-tab';
      const secondPage = await context.newPage();
      try {
        await secondPage.goto(`${origin}/search`, { waitUntil: 'domcontentloaded' });
        await secondPage
          .getByRole('heading', { name: 'Your local plan could not be opened', exact: true })
          .waitFor();
        await secondPage
          .getByText('The plan is already open in another tab.', { exact: true })
          .waitFor();
        await useful(page);
        activeSecondTabBlocked = true;
      } catch (error) {
        await diagnose(secondPage);
        throw error;
      } finally {
        await secondPage.close();
      }
    }
    started = performance.now();
    phase = 'unicode-query';
    await page.getByRole('searchbox').fill('CAFÉ сло 00001');
    await page.getByRole('link', { name: 'Synthetic Search Action 00001', exact: true }).waitFor();
    await page.getByRole('status').filter({ hasText: '1 result on this page.' }).waitFor();
    queryRenderMs = elapsed(started);
    assert(
      queryRenderMs <= thresholds.queryRenderMs,
      `Search query and render ${queryRenderMs}ms exceeds budget`,
    );
    assert(
      (await page.locator('.search-result-list > li').count()) === 1,
      'Unique Unicode query must render exactly one result',
    );
    await assertNoOverflow(page, '10,000-Action Search');
    await page.screenshot({
      path: '/tmp/yelaxis-recovery-search-large-1440x900.png',
      fullPage: true,
    });
    longestTaskMs = await page.evaluate(() => Math.max(0, ...window.__searchLongTasks));
    assert(
      longestTaskMs <= thresholds.longestTaskMs,
      `Search longest task ${longestTaskMs}ms exceeds budget`,
    );
  } catch (error) {
    await diagnose(activePage);
    throw error;
  } finally {
    await context.close();
  }
  context = await launch();
  let offlineColdRenderMs;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    activePage = page;
    observe(page, errors, external);
    await context.setOffline(true);
    const started = performance.now();
    phase = 'offline-cold-render';
    await page.goto(`${origin}/search`, { waitUntil: 'domcontentloaded' });
    await useful(page);
    offlineColdRenderMs = elapsed(started);
    assert(
      offlineColdRenderMs <= thresholds.offlineColdRenderMs,
      `Offline Search ${offlineColdRenderMs}ms exceeds budget`,
    );
    await page.getByRole('searchbox').fill('CAFÉ сло 00001');
    await page.getByRole('status').filter({ hasText: '1 result on this page.' }).waitFor();
    assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);
    assert(external.length === 0, `External requests: ${external.join(' | ')}`);
  } catch (error) {
    await diagnose(activePage);
    throw error;
  } finally {
    await context.close();
  }
  process.stdout.write(
    `${JSON.stringify({ ...report, productionSearch: { thresholds, firstRenderMs, warmRenderMs, warmRenderSamplesMs, activeSecondTabBlocked, queryRenderMs, offlineColdRenderMs, longestTaskMs }, browserErrors: errors, externalRequests: external }, null, 2)}\n`,
  );
} catch (error) {
  await activePage
    ?.screenshot({ path: '/tmp/yelaxis-recovery-search-performance-failure.png', fullPage: true })
    .catch(() => undefined);
  throw error;
} finally {
  clearTimeout(watchdog);
  await stop(server);
  await rm(profile, { recursive: true, force: true });
}
function start(mode) {
  const child = spawn(
    'pnpm',
    [
      'exec',
      'vite',
      ...(mode === 'preview' ? ['preview'] : []),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  child.stdout.on('data', (chunk) => {
    serverOutput += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    serverOutput += String(chunk);
  });
  return child;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  await exited;
}
async function ready() {
  for (let n = 0; n < 600; n += 1) {
    if (server.exitCode !== null) throw new Error(`Preview exited: ${serverOutput}`);
    try {
      if ((await fetch(origin)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Preview startup timed out');
}
function launch() {
  return chromium.launchPersistentContext(profile, {
    ...chromiumExecutableOptions(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Asia/Tashkent',
    locale: 'en-US',
  });
}
function observe(page, errors, external) {
  page.on('worker', (worker) => {
    const lifetime = { url: worker.url(), openedAt: Date.now() };
    workerLifetimes.push(lifetime);
    worker.on('close', () => {
      lifetime.closedAt = Date.now();
    });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) external.push(request.url());
  });
}
async function diagnose(page) {
  if (failureDiagnosed) return;
  failureDiagnosed = true;
  const diagnostic = {
    phase,
    workerLifetimes,
    state: await page
      ?.evaluate(async () => ({
        url: location.href,
        readyState: document.readyState,
        headings: [...document.querySelectorAll('h1')].map((element) => element.textContent),
        statuses: [...document.querySelectorAll('[role=status], [role=alert]')].map(
          (element) => element.textContent,
        ),
        // This benchmark seeds synthetic planning data only. Capture startup messages before close.
        mainText: document.querySelector('main')?.textContent?.slice(0, 1200),
        startupErrors: window.__searchStartupErrors ?? [],
        locks: await navigator.locks.query(),
        serviceWorker: navigator.serviceWorker.controller?.scriptURL ?? null,
      }))
      .catch((error) => ({ diagnosticError: error.message })),
  };
  await writeFile(
    '/tmp/yelaxis-recovery-search-performance-failure.json',
    JSON.stringify(diagnostic, null, 2),
  );
  await page
    ?.screenshot({ path: '/tmp/yelaxis-recovery-search-performance-failure.png', fullPage: true })
    .catch(() => undefined);
  process.stderr.write(`Search benchmark failure state: ${JSON.stringify(diagnostic)}\n`);
}
async function useful(page) {
  await page
    .getByRole('heading', { name: 'Search', level: 1, exact: true })
    .waitFor({ timeout: 30000 });
  await page.locator('.search-result-list > li').first().waitFor({ timeout: 30000 });
  assert(
    (await page.locator('.search-result-list > li').count()) === 40,
    'Search must render bounded 40-row pages',
  );
}
function elapsed(started) {
  return Math.round((performance.now() - started) * 10) / 10;
}
