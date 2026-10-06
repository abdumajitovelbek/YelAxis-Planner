import { chromiumExecutableOptions } from './lib/browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

/*
 * Today Today performance gate (brief §6). manual planning runs test/today-performance.html on the dev
 * server: it seeds the large synthetic plan into the browser database and times the Today reads
 * and commands against the budgets fixed in that page. extension serves the production build from
 * the same origin (same browser storage) and times a warm Today render and an offline cold start
 * to the first useful Today. The browser clock is fixed to the seeded planning date.
 */

/** Provisional production budgets from brief §6, fixed before any run; ratified at release. */
const thresholds = Object.freeze({
  warmTodayRenderMs: 2_500,
  offlineColdTodayMs: 5_000,
});
/** 2026-08-12 11:00 in New York: the page's injected clock and planning date. */
const seededNow = new Date('2026-08-12T15:00:00.000Z');
const timeZone = 'America/New_York';
const todayHeading = 'A useful day starts here.';
/** A flexible Action placed on the seeded day (focus and flexible list). */
const seededTitle = 'Synthetic Action 05101';
const screenshot = '/tmp/yelaxis-today-large-today-1440x900.png';

const port = 7900 + (Date.now() % 250);
const origin = `http://127.0.0.1:${String(port)}`;
const profileDirectory = await mkdtemp(join(tmpdir(), 'yelaxis-today-performance-'));
const databaseName = '/yelaxis.sqlite3';
let serverOutput = '';
let server = startServer('dev');

try {
  await waitForServer();
  let context = await launch();
  let report;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const url = new URL('/test/today-performance.html', origin);
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
    if (status !== 'passed') throw new Error(`Today performance failed:\n${content ?? ''}`);
    report = JSON.parse(content ?? '{}');
  } finally {
    await context.close();
  }

  await stopServer(server);
  serverOutput = '';
  server = startServer('preview');
  await waitForServer();

  const errors = [];
  const externalRequests = [];
  context = await launch();
  let page;
  try {
    page = await openToday(context, errors, externalRequests);
    const firstStarted = performance.now();
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await waitForUsefulToday(page);
    const firstTodayRenderMs = elapsed(firstStarted);
    // Let the service worker take the static shell, then time a warm reload.
    await page.evaluate(() => navigator.serviceWorker.ready);
    const warmStarted = performance.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForUsefulToday(page);
    const warmTodayRenderMs = elapsed(warmStarted);
    if (warmTodayRenderMs > thresholds.warmTodayRenderMs)
      throw new Error(
        `Warm Today render ${String(warmTodayRenderMs)}ms exceeded ${String(thresholds.warmTodayRenderMs)}ms.`,
      );
    const width = await page.evaluate(() => [
      document.body.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    if (width[0] > width[1]) throw new Error(`Large Today overflows: ${width.join(' > ')}`);
    await page.screenshot({ path: screenshot });
    await context.close();

    context = await launch();
    page = await openToday(context, errors, externalRequests);
    await context.setOffline(true);
    const coldStarted = performance.now();
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await waitForUsefulToday(page);
    const offlineColdTodayMs = elapsed(coldStarted);
    if (offlineColdTodayMs > thresholds.offlineColdTodayMs)
      throw new Error(
        `Offline cold Today ${String(offlineColdTodayMs)}ms exceeded ${String(thresholds.offlineColdTodayMs)}ms.`,
      );
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    if (externalRequests.length > 0)
      throw new Error(`External requests: ${externalRequests.join(' | ')}`);
    report.productionToday = {
      thresholds,
      firstRenderMs: firstTodayRenderMs,
      warmRenderMs: warmTodayRenderMs,
      offlineColdStartMs: offlineColdTodayMs,
      screenshot,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await context.close();
  }
} finally {
  await stopServer(server);
  await rm(profileDirectory, { force: true, recursive: true });
}

/** A page whose clock starts at the seeded planning time, with errors and requests recorded. */
async function openToday(context, errors, externalRequests) {
  await context.clock.install({ time: seededNow });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) externalRequests.push(request.url());
  });
  return page;
}

/** The first useful Today: the live-today heading and the seeded day's own work. */
async function waitForUsefulToday(page) {
  await page.getByRole('heading', { level: 1, name: todayHeading }).waitFor({ timeout: 30_000 });
  await page.getByText(seededTitle).first().waitFor({ timeout: 30_000 });
}

function elapsed(started) {
  return Math.round((performance.now() - started) * 10) / 10;
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
    timezoneId: timeZone,
    locale: 'en-US',
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
    if (server.exitCode !== null) throw new Error(`Server exited:\n${serverOutput}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the server:\n${serverOutput}`);
}
