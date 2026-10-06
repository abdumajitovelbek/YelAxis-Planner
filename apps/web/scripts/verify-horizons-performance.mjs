import { chromiumExecutableOptions } from './lib/browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

const port = 6800 + (Date.now() % 250);
const origin = `http://127.0.0.1:${String(port)}`;
const profileDirectory = await mkdtemp(join(tmpdir(), 'yelaxis-planning-performance-'));
const databaseName = '/yelaxis.sqlite3';
let serverOutput = '';
let server = startServer('dev');

try {
  await waitForServer();
  let context = await launch();
  let report;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const url = new URL('/test/horizons-performance.html', origin);
    url.searchParams.set('database', databaseName);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => {
        const result = document.querySelector('#result');
        return result !== null && result.getAttribute('data-status') !== 'running';
      },
      undefined,
      { timeout: 600_000 },
    );
    const status = await page.locator('#result').getAttribute('data-status');
    const content = await page.locator('#result').textContent();
    if (status !== 'passed') throw new Error(`Horizons performance failed:\n${content ?? ''}`);
    report = JSON.parse(content ?? '{}');
  } finally {
    await context.close();
  }

  await stopServer(server);
  serverOutput = '';
  server = startServer('preview');
  await waitForServer();

  context = await launch();
  try {
    let page = context.pages()[0] ?? (await context.newPage());
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const warmStarted = performance.now();
    await page.goto(`${origin}/plan/week/2026-08-12`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    await page
      .getByText(/Synthetic Action/u)
      .first()
      .waitFor({ timeout: 30_000 });
    const warmWeekRenderMs = Math.round((performance.now() - warmStarted) * 10) / 10;
    const bodyWidth = await page.evaluate(() => [
      document.body.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    if (bodyWidth[0] > bodyWidth[1])
      throw new Error(`Large Week overflows: ${bodyWidth.join(' > ')}`);
    await page.screenshot({ path: '/tmp/yelaxis-planning-large-week-1440x900.png' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await context.close();

    context = await launch();
    page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (error) => errors.push(error.message));
    await context.setOffline(true);
    const started = performance.now();
    await page.goto(`${origin}/plan/week/2026-08-12`, { waitUntil: 'domcontentloaded' });
    await page
      .getByText(/Synthetic Action/u)
      .first()
      .waitFor({ timeout: 30_000 });
    const offlineWeekColdStartMs = Math.round((performance.now() - started) * 10) / 10;
    if (offlineWeekColdStartMs > 3_000)
      throw new Error(
        `Offline Week cold start ${String(offlineWeekColdStartMs)}ms exceeded 3000ms threshold.`,
      );
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    report.productionWeek = {
      warmRenderMs: warmWeekRenderMs,
      offlineColdStart: { thresholdMs: 3_000, observedMs: offlineWeekColdStartMs },
      screenshot: '/tmp/yelaxis-planning-large-week-1440x900.png',
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await context.close();
  }
} finally {
  await stopServer(server);
  await rm(profileDirectory, { force: true, recursive: true });
}

function startServer(mode) {
  const command =
    mode === 'preview'
      ? ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
      : ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  const child = spawn('pnpm', command, {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so the vite child stops with pnpm.
    detached: true,
  });
  child.stdout.on('data', (chunk) => {
    serverOutput += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    serverOutput += String(chunk);
  });
  return child;
}

function launch() {
  return chromium.launchPersistentContext(profileDirectory, {
    ...chromiumExecutableOptions(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--enable-precise-memory-info'],
    viewport: { width: 1440, height: 900 },
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  await exited;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Preview exited:\n${serverOutput}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for preview:\n${serverOutput}`);
}
