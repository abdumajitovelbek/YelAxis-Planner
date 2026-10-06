import { chromiumExecutableOptions } from './lib/browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from './lib/browser.mjs';

const port = 6500 + (Date.now() % 250);
const origin = `http://127.0.0.1:${String(port)}`;
const profileDirectory = await mkdtemp(join(tmpdir(), 'yelaxis-actions-performance-'));
const databaseName = '/yelaxis.sqlite3';
let serverOutput = '';
let server = startServer('dev');

try {
  await waitForServer();
  let context = await launch();
  let report;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const url = new URL('/test/actions-performance.html', origin);
    url.searchParams.set('database', databaseName);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => {
        const result = document.querySelector('#result');
        return result !== null && result.getAttribute('data-status') !== 'running';
      },
      undefined,
      { timeout: 300_000 },
    );
    const status = await page.locator('#result').getAttribute('data-status');
    const content = await page.locator('#result').textContent();
    if (status !== 'passed') throw new Error(`Performance verification failed:\n${content ?? ''}`);
    report = JSON.parse(content ?? '{}');
  } finally {
    await context.close();
  }

  stopProcessGroup(server);
  await waitForExit(server);
  serverOutput = '';
  server = startServer('preview');
  await waitForServer();

  context = await launch();
  try {
    let page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${origin}/inbox`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Decide what happens next.' }).waitFor();
    const largeInboxRows = await page.locator('.inbox-list > li').count();
    if (largeInboxRows !== 50)
      throw new Error(`Large Inbox rendered ${String(largeInboxRows)} rows instead of 50.`);
    await page.screenshot({
      path: '/tmp/yelaxis-actions-large-inbox-1440x900.png',
    });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Decide what happens next.' }).waitFor();
    await context.close();

    context = await launch();
    page = context.pages()[0] ?? (await context.newPage());
    await context.setOffline(true);
    const started = performance.now();
    await page.goto(`${origin}/inbox`, { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('heading', { name: 'Decide what happens next.' })
      .waitFor({ timeout: 30_000 });
    await page.locator('.inbox-list > li').first().waitFor();
    const offlineColdStartMs = Math.round((performance.now() - started) * 10) / 10;
    const renderedRows = await page.locator('.inbox-list > li').count();
    if (renderedRows !== 50)
      throw new Error(`Offline cold start rendered ${String(renderedRows)} rows instead of 50.`);
    if (offlineColdStartMs > 2_500)
      throw new Error(
        `Offline cold start ${String(offlineColdStartMs)}ms exceeded 2500ms threshold.`,
      );
    report.offlineColdStart = { thresholdMs: 2_500, observedMs: offlineColdStartMs, renderedRows };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await context.close();
  }
} finally {
  stopProcessGroup(server);
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

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => child.once('exit', resolve));
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
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

/** Stop pnpm and the vite server it started (both share the detached process group). */
function stopProcessGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already stopped */
  }
}
