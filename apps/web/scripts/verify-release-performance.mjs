import { chromiumExecutableOptions } from './lib/browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, firefox } from './lib/browser.mjs';

import { assert, assertNoOverflow } from './lib/journey.mjs';

// Release bounds are fixed before executing either browser. They are not relaxed on failure.
const budgets = Object.freeze({
  warmRenderMs: 2500,
  offlineColdRenderMs: 5000,
  longestTaskMs: 250,
  repeatedHeapGrowthBytes: 64 * 1024 * 1024,
  chromeJavaScriptBytes: 256 * 1024 * 1024,
  ownedBrowserRssBytes: 1536 * 1024 * 1024,
});
const inFirefox = process.argv.includes('--firefox');
const browserName = inFirefox ? 'firefox' : 'chromium';
const port = 9200 + (Date.now() % 250);
const origin = `http://127.0.0.1:${port}`;
const profile = await mkdtemp(join(tmpdir(), `yelaxis-release-performance-${browserName}-`));
const screenshots = [];
const errors = [];
const resourceFailures = [];
const externalRequests = [];
const memorySamples = [];
const retainedMemorySamples = [];
const longTaskSamples = [];
const rssSamples = [];
const productionMeasurements = { budgets, routeSamples: [] };
let activePage;
let phase = 'storage-seed';
let server = start('dev');
let rssMonitor;
let ownedBrowserRssPeakBytes = 0;
let context;
let report;
const watchdog = setTimeout(() => {
  void stop(server);
  process.stderr.write(`Release performance timed out during ${phase}.\n`);
  process.exit(1);
}, 15 * 60_000);

try {
  await ready();
  context = await launch();
  let page = context.pages()[0] ?? (await context.newPage());
  observe(page);
  activePage = page;
  await page.goto(`${origin}/test/release-performance.html?database=%2Fyelaxis.sqlite3`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => document.querySelector('#result')?.getAttribute('data-status') !== 'running',
    undefined,
    { timeout: 600_000 },
  );
  const status = await page.locator('#result').getAttribute('data-status');
  const result = await page.locator('#result').textContent();
  assert(status === 'passed', `Release worker benchmark failed: ${result ?? ''}`);
  report = JSON.parse(result ?? '{}');
  const seededMemory = await memory(context);
  memorySamples.push({ phase, ...seededMemory });
  const seededRetainedMemory = await memory(context, true);
  await writeFile(
    `/tmp/yelaxis-release-performance-${browserName}-seed-memory.json`,
    JSON.stringify(
      {
        phase,
        finalImageBytes: report.finalImageBytes,
        finalDurableCounts: report.finalDurableCounts,
        transient: seededMemory,
        afterFullGc: seededRetainedMemory,
        ownedBrowserRssPeakBytes,
      },
      null,
      2,
    ),
  );
  await closeContext();
  await stop(server);
  server = start('preview');
  await ready();

  context = await launch();
  page = context.pages()[0] ?? (await context.newPage());
  activePage = page;
  observe(page);
  await context.clock.install({ time: new Date(report.testClock) });
  await instrument(page);
  phase = 'first-production-today';
  let started = performance.now();
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await usefulToday(page);
  const firstRenderMs = elapsed(started);
  productionMeasurements.firstRenderMs = firstRenderMs;
  assert(
    firstRenderMs <= budgets.offlineColdRenderMs,
    'First full-validation render exceeds the cold-render ceiling.',
  );
  await page.evaluate(() => navigator.serviceWorker.ready);
  phase = 'warm-production-today';
  started = performance.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await usefulToday(page);
  const warmRenderMs = elapsed(started);
  productionMeasurements.warmRenderMs = warmRenderMs;
  assert(
    warmRenderMs <= budgets.warmRenderMs,
    `Warm Today ${warmRenderMs}ms exceeds ${budgets.warmRenderMs}ms.`,
  );
  await assertNoOverflow(page, 'dense Today');
  await shot(page, 'dense-today');
  await collectLongTasks(page);

  phase = 'today-complete-keyboard-pagination';
  const todayPaging = page.locator('.today-flexible-list .item-pagination');
  await completePagination(
    page,
    todayPaging,
    page.locator('.today-flexible-list .action-row'),
    1003,
  );
  const todayPages = 21;
  await page.getByRole('link', { name: 'Synthetic Release Action 01003', exact: true }).waitFor();
  memorySamples.push({ phase, ...(await memory(context)) });
  await collectLongTasks(page);

  phase = 'dense-day-production';
  const date = report.testClock.slice(0, 10);
  await page.goto(`${origin}/plan/day/${date}`, { waitUntil: 'domcontentloaded' });
  await usefulDay(page);
  const dayActions = page.locator('section[aria-labelledby="day-flexible-heading"] .action-list');
  await completePagination(
    page,
    dayActions.locator('.item-pagination'),
    dayActions.locator('.action-row'),
    1003,
  );
  assert(
    (await page.locator('.timeline-entry').count()) === 50,
    'Dense timeline must render 50 of all 65 entries.',
  );
  assert(
    await page
      .locator('.timeline-grid')
      .first()
      .evaluate((element) => element.classList.contains('is-list')),
    'Extreme overlap uses a readable complete list.',
  );
  const timelinePaging = page.locator('.day-timeline-section .item-pagination');
  await timelinePaging.getByRole('button', { name: 'Next items', exact: true }).focus();
  await page.keyboard.press('Enter');
  await timelinePaging.getByRole('status').filter({ hasText: '51–65' }).waitFor();
  assert(
    (await page.locator('.timeline-entry').count()) === 15,
    'Final timeline page retains all remaining entries.',
  );
  await assertNoOverflow(page, 'dense Day');
  await shot(page, 'dense-day');
  await collectLongTasks(page);

  phase = 'repeated-production-navigation';
  const routes = [
    '/',
    `/plan/day/${date}`,
    `/plan/week/${date}`,
    `/plan/month/${date}`,
    `/plan/year/${date}`,
    '/search',
  ];
  const routeSamples = productionMeasurements.routeSamples;
  const retainedHeapSamples = [];
  for (let cycle = 0; cycle < 8; cycle++) {
    for (const route of routes) {
      started = performance.now();
      await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
      await usefulRoute(page, route);
      const duration = elapsed(started);
      assert(
        duration <= budgets.warmRenderMs,
        `${route} render ${duration}ms exceeds ${budgets.warmRenderMs}ms.`,
      );
      routeSamples.push({ cycle: cycle + 1, route, durationMs: duration });
      await collectLongTasks(page);
      const sample = await memory(context);
      memorySamples.push({ phase, cycle: cycle + 1, route, ...sample });
    }
    const retained = await memory(context, true);
    retainedHeapSamples.push(retained.totalJavaScriptBytes);
    retainedMemorySamples.push({ phase, cycle: cycle + 1, ...retained });
  }
  const heaps = retainedHeapSamples.filter((value) => typeof value === 'number');
  const repeatedHeapGrowthBytes =
    heaps.length === 0 ? 'unavailable' : Math.max(0, heaps.at(-1) - Math.min(...heaps));
  if (typeof repeatedHeapGrowthBytes === 'number')
    assert(
      repeatedHeapGrowthBytes <= budgets.repeatedHeapGrowthBytes,
      `Retained heap grew by ${repeatedHeapGrowthBytes} bytes.`,
    );
  let longestTaskMs = inFirefox ? 'unavailable' : Math.max(0, ...longTaskSamples);
  if (typeof longestTaskMs === 'number')
    assert(
      longestTaskMs <= budgets.longestTaskMs,
      `Longest production task ${longestTaskMs}ms exceeds ${budgets.longestTaskMs}ms.`,
    );
  const availableHeaps = memorySamples
    .map((value) => value.totalJavaScriptBytes)
    .filter((value) => typeof value === 'number');
  let measuredJavaScriptPeakBytes =
    availableHeaps.length === 0 ? 'unavailable' : Math.max(...availableHeaps);
  if (typeof measuredJavaScriptPeakBytes === 'number')
    assert(
      measuredJavaScriptPeakBytes <= budgets.chromeJavaScriptBytes,
      `Measured Chromium JS/WASM bytes ${measuredJavaScriptPeakBytes} exceed ${budgets.chromeJavaScriptBytes}.`,
    );
  await closeContext();

  phase = 'offline-cold-production-today';
  context = await launch();
  await context.clock.install({ time: new Date(report.testClock) });
  page = context.pages()[0] ?? (await context.newPage());
  activePage = page;
  observe(page);
  await instrument(page);
  await context.setOffline(true);
  started = performance.now();
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await usefulToday(page);
  const offlineColdRenderMs = elapsed(started);
  productionMeasurements.offlineColdRenderMs = offlineColdRenderMs;
  assert(
    offlineColdRenderMs <= budgets.offlineColdRenderMs,
    `Offline Today ${offlineColdRenderMs}ms exceeds ${budgets.offlineColdRenderMs}ms.`,
  );
  await page
    .locator('.today-flexible-list .item-pagination')
    .getByRole('status')
    .filter({ hasText: '1,003' })
    .waitFor();
  await assertNoOverflow(page, 'offline dense Today');
  await collectLongTasks(page);
  longestTaskMs = inFirefox ? 'unavailable' : Math.max(0, ...longTaskSamples);
  const offlineMemory = await memory(context);
  memorySamples.push({ phase, ...offlineMemory });
  if (typeof offlineMemory.totalJavaScriptBytes === 'number') {
    measuredJavaScriptPeakBytes = Math.max(
      measuredJavaScriptPeakBytes,
      offlineMemory.totalJavaScriptBytes,
    );
    assert(
      measuredJavaScriptPeakBytes <= budgets.chromeJavaScriptBytes,
      'Offline Chromium JS/WASM memory exceeds its fixed ceiling.',
    );
  }
  assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);
  assert(externalRequests.length === 0, `External requests: ${externalRequests.join(' | ')}`);
  assert(ownedBrowserRssPeakBytes > 0, 'Owned browser process RSS was not measured.');
  assert(
    ownedBrowserRssPeakBytes <= budgets.ownedBrowserRssBytes,
    `Owned browser RSS ${ownedBrowserRssPeakBytes} exceeds ${budgets.ownedBrowserRssBytes}.`,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        ...report,
        browser: browserName,
        browserVersion: context.browser()?.version(),
        production: {
          budgets,
          firstRenderMs,
          warmRenderMs,
          offlineColdRenderMs,
          todayPages,
          dayPages: 21,
          denseTimelinePages: 2,
          routeSamples,
          longestTaskMs,
          longTasksScope:
            'Warm, dense pagination, every repeated route, and offline useful render.',
        },
        memory: {
          source: inFirefox
            ? 'Owned process-tree RSS; Firefox has no CDP heap or Long Tasks API.'
            : 'Owned process-tree RSS and CDP Runtime.getHeapUsage over page/worker targets; includes backing storage/WASM.',
          ownedBrowserRssPeakBytes,
          measuredJavaScriptPeakBytes,
          repeatedHeapGrowthBytes,
          retainedHeapSamples,
          samples: memorySamples,
          retainedSamples: retainedMemorySamples,
          rssSamples,
        },
        screenshots,
        browserErrors: errors,
        resourceFailures,
        externalRequests,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const diagnostic = await activePage
    ?.evaluate(() => ({
      heading: [...document.querySelectorAll('h1')].map((node) => node.textContent),
      messages: [...document.querySelectorAll('[role=alert],[role=status]')].map(
        (node) => node.textContent,
      ),
      pathname: location.pathname,
    }))
    .catch(() => null);
  await writeFile(
    `/tmp/yelaxis-release-performance-${browserName}-failure.json`,
    JSON.stringify(
      {
        phase,
        diagnostic,
        memorySamples,
        retainedMemorySamples,
        finalImageBytes: report?.finalImageBytes,
        ownedBrowserRssPeakBytes,
        rssSamples,
        storageMeasurements: report,
        productionMeasurements,
        browserErrors: errors,
        resourceFailures,
      },
      null,
      2,
    ),
  );
  await activePage
    ?.screenshot({
      path: `/tmp/yelaxis-release-performance-${browserName}-failure.png`,
      fullPage: true,
    })
    .catch(() => undefined);
  process.stderr.write(`Release performance failure during ${phase}.\n`);
  throw error;
} finally {
  clearTimeout(watchdog);
  await closeContext();
  await stop(server);
  await rm(profile, { recursive: true, force: true });
}

async function completePagination(page, controls, rows, total) {
  assert((await rows.count()) === 50, 'First dense Action page must contain 50 rows.');
  const next = controls.getByRole('button', { name: 'Next items', exact: true });
  for (let current = 1; current <= Math.ceil(total / 50); current++) {
    const expected = Math.min(50, total - (current - 1) * 50);
    assert(
      (await rows.count()) === expected,
      `Dense Action page ${current} contains ${expected} rows.`,
    );
    if (current === Math.ceil(total / 50)) {
      assert(
        (await next.getAttribute('aria-disabled')) === 'true',
        'Final-page Next remains focusable and announces unavailable.',
      );
      break;
    }
    await next.focus();
    await page.keyboard.press('Enter');
    const start = current * 50 + 1;
    await controls
      .getByRole('status')
      .filter({ hasText: new Intl.NumberFormat('en').format(start) })
      .waitFor();
    assert(
      await next.evaluate((node) => node === document.activeElement),
      'Keyboard paging retains focus.',
    );
  }
}

async function usefulToday(page) {
  await page
    .getByRole('heading', { level: 1, name: 'A useful day starts here.', exact: true })
    .waitFor({ timeout: 30_000 });
  await page.locator('.today-flexible-list .action-row').first().waitFor({ timeout: 30_000 });
  assert(
    (await page.locator('.today-flexible-list .action-row').count()) === 50,
    'Useful Today renders 50 complete-page rows.',
  );
}
async function usefulDay(page) {
  await page.locator('.day-view').waitFor({ timeout: 30_000 });
  await page
    .locator('section[aria-labelledby="day-flexible-heading"] .action-row')
    .first()
    .waitFor({ timeout: 30_000 });
}
async function usefulRoute(page, route) {
  if (route === '/') return usefulToday(page);
  if (route.includes('/day/')) return usefulDay(page);
  if (route === '/search') {
    await page.getByRole('heading', { level: 1, name: 'Search', exact: true }).waitFor();
    await page.locator('.search-result-list > li').first().waitFor();
    assert(
      (await page.locator('.search-result-list > li').count()) === 40,
      'Search retains its bounded 40-row page.',
    );
    return;
  }
  const horizon = route.split('/')[2];
  await page.locator(`.${horizon}-view`).waitFor({ timeout: 30_000 });
  assert((await page.locator('h1').count()) === 1, 'A production horizon has one heading.');
}
async function instrument(page) {
  await page.addInitScript(() => {
    window.__releaseLongTasks = PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? []
      : null;
    if (window.__releaseLongTasks !== null)
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__releaseLongTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
  });
}
async function collectLongTasks(page) {
  const tasks = await page.evaluate(() => window.__releaseLongTasks);
  if (tasks === null) return;
  assert(Array.isArray(tasks), 'Chromium Long Tasks measurements must be available.');
  const longest = Math.max(0, ...tasks);
  longTaskSamples.push(longest);
  assert(longest <= budgets.longestTaskMs, `Production task during ${phase} took ${longest}ms.`);
}
async function memory(browserContext, collect = false) {
  if (inFirefox) return { totalJavaScriptBytes: 'unavailable', targets: 'unavailable' };
  const browser = browserContext.browser();
  assert(browser !== null, 'Chromium heap measurement requires its owned browser.');
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const targets = [];
    for (const target of targetInfos.filter(
      (value) => ['page', 'worker'].includes(value.type) && value.url.startsWith(origin),
    )) {
      const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: false,
      });
      try {
        if (collect) await targetCommand(cdp, sessionId, 'HeapProfiler.collectGarbage');
        const usage = await targetCommand(cdp, sessionId, 'Runtime.getHeapUsage');
        targets.push({
          type: target.type,
          usedBytes: usage.usedSize,
          backingStorageBytes: usage.backingStorageSize ?? 0,
        });
      } finally {
        await cdp.send('Target.detachFromTarget', { sessionId });
      }
    }
    assert(targets.length > 0, 'Chromium heap measurement found no owned page/worker targets.');
    return {
      usedJavaScriptBytes: targets.reduce((total, value) => total + value.usedBytes, 0),
      externalBackingStorageBytes: targets.reduce(
        (total, value) => total + value.backingStorageBytes,
        0,
      ),
      totalJavaScriptBytes: targets.reduce(
        (total, value) => total + value.usedBytes + value.backingStorageBytes,
        0,
      ),
      targets,
    };
  } finally {
    await cdp.detach();
  }
}
async function targetCommand(cdp, sessionId, method) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cdp.off('Target.receivedMessageFromTarget', received);
      reject(new Error(`Heap capability timed out: ${method}.`));
    }, 5000);
    function received(event) {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== 1) return;
      clearTimeout(timeout);
      cdp.off('Target.receivedMessageFromTarget', received);
      if (message.error) reject(new Error(`Heap capability rejected ${method}.`));
      else resolve(message.result);
    }
    cdp.on('Target.receivedMessageFromTarget', received);
    void cdp
      .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method }) })
      .catch((error) => {
        clearTimeout(timeout);
        cdp.off('Target.receivedMessageFromTarget', received);
        reject(error);
      });
  });
}
async function processTable() {
  const paths = (await readdir('/proc')).filter((value) => /^\d+$/u.test(value));
  return (
    await Promise.all(
      paths.map(async (pid) => {
        try {
          // stat contains numeric ownership/RSS fields only; never read cmdline or environ.
          const value = await readFile(`/proc/${pid}/stat`, 'utf8');
          const close = value.lastIndexOf(')');
          const fields = value
            .slice(close + 2)
            .trim()
            .split(/\s+/u);
          return {
            pid: Number(pid),
            ppid: Number(fields[1]),
            name: value.slice(value.indexOf('(') + 1, close),
            rssBytes: Number(fields[21]) * 4096,
          };
        } catch {
          return null;
        }
      }),
    )
  ).filter((value) => value !== null);
}
async function launch() {
  const before = new Set((await processTable()).map((value) => value.pid));
  const launched = await (inFirefox ? firefox : chromium).launchPersistentContext(profile, {
    ...(inFirefox
      ? {}
      : {
          ...chromiumExecutableOptions(),
          args: ['--no-sandbox', '--disable-gpu', '--enable-precise-memory-info'],
        }),
    headless: true,
    viewport: { width: 1440, height: 900 },
    timezoneId: 'UTC',
    locale: 'en-US',
  });
  const roots = (await processTable()).filter(
    (value) =>
      !before.has(value.pid) && value.ppid === process.pid && /chrome|firefox/iu.test(value.name),
  );
  assert(roots.length === 1, 'Exactly one owned browser process tree must be measured.');
  const rssCdp = inFirefox ? undefined : await launched.browser().newBrowserCDPSession();
  let sampling = false;
  let lastPhase;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const rows = await processTable();
      const owned = new Set(roots.map((value) => value.pid));
      let previous = 0;
      while (owned.size !== previous) {
        previous = owned.size;
        for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
      }
      const ownedRows = rows.filter((value) => owned.has(value.pid));
      const totalBytes = ownedRows.reduce((total, value) => total + value.rssBytes, 0);
      const newPeak = totalBytes > ownedBrowserRssPeakBytes;
      if (newPeak || phase !== lastPhase) {
        const processTypes = await rssCdp?.send('SystemInfo.getProcessInfo').catch(() => undefined);
        const roles = new Map(
          (processTypes?.processInfo ?? []).map((value) => [Number(value.id), value.type]),
        );
        rssSamples.push({
          phase,
          seedPhase:
            phase === 'storage-seed'
              ? await activePage
                  ?.evaluate(() => document.querySelector('#result')?.getAttribute('data-phase'))
                  .catch(() => 'unavailable')
              : undefined,
          atMs: Math.round(performance.now()),
          totalBytes,
          newPeak,
          processes: ownedRows
            .map((value) => ({
              ...value,
              role:
                value.pid === roots[0].pid ? 'browser' : (roles.get(value.pid) ?? 'unavailable'),
            }))
            .sort((left, right) => right.rssBytes - left.rssBytes),
        });
        lastPhase = phase;
      }
      ownedBrowserRssPeakBytes = Math.max(ownedBrowserRssPeakBytes, totalBytes);
    } finally {
      sampling = false;
    }
  };
  await sample();
  rssMonitor = setInterval(() => void sample(), 500);
  return launched;
}
async function closeContext() {
  if (rssMonitor) clearInterval(rssMonitor);
  rssMonitor = undefined;
  if (context) await context.close();
  context = undefined;
}
function observe(page) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const url = message.location()?.url;
      const path = url ? new URL(url).pathname : 'unavailable';
      errors.push(`${message.text()} [${phase}; ${path}]`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      resourceFailures.push({
        phase,
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
  });
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) {
      const url = new URL(request.url());
      externalRequests.push(`${url.origin}${url.pathname}`);
    }
  });
}
async function shot(page, name) {
  const path = `/tmp/yelaxis-release-performance-${browserName}-${name}.png`;
  // Measure the physical viewport. Full-page rasterization of every offscreen dense row would
  // allocate hundreds of MiB in the verification tool and obscure application memory usage.
  await page.screenshot({ path, fullPage: false });
  screenshots.push(path);
}
function elapsed(started) {
  return Math.round((performance.now() - started) * 10) / 10;
}
function start(mode) {
  return spawn(
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
    { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'ignore'], detached: true },
  );
}
async function ready() {
  for (let n = 0; n < 600; n++) {
    if (server.exitCode !== null)
      throw new Error(`Local benchmark server exited ${server.exitCode}.`);
    try {
      if ((await fetch(origin)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Local benchmark server startup timed out.');
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
