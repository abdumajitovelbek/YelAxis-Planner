import { chromiumExecutableOptions } from './lib/browser.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { chromium } from 'playwright-core';

const port = 4800 + (Date.now() % 400);
const origin = `http://127.0.0.1:${String(port)}`;
const profileDirectory = await mkdtemp(join(tmpdir(), 'yelaxis-persistence-chrome-'));
const databaseName = `/persistence-${Date.now().toString(16)}.sqlite3`;
const server = spawn(
  'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);

let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += String(chunk);
});
server.stderr.on('data', (chunk) => {
  serverOutput += String(chunk);
});

try {
  await waitForServer();
  const exclusiveLock = await verifyExclusiveLock();
  const seed = await runPhase('seed');
  const reopen = await runPhase('reopen');
  const cleared = await runClearedPhase();
  process.stdout.write(
    `${JSON.stringify({ browser: 'Playwright Chromium', exclusiveLock, seed, reopen, cleared }, null, 2)}\n`,
  );
} finally {
  stopProcessGroup(server);
  await rm(profileDirectory, { force: true, recursive: true });
}

async function verifyExclusiveLock() {
  const context = await chromium.launchPersistentContext(profileDirectory, {
    ...chromiumExecutableOptions(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    viewport: { width: 1440, height: 900 },
  });
  try {
    const holder = context.pages()[0] ?? (await context.newPage());
    const heldUrl = new URL('/test/persistence.html', origin);
    heldUrl.searchParams.set('phase', 'hold');
    heldUrl.searchParams.set('database', databaseName);
    await holder.goto(heldUrl.toString(), { waitUntil: 'domcontentloaded' });
    await holder.waitForFunction(
      () => document.querySelector('#result')?.getAttribute('data-status') === 'holding',
    );
    const contender = await context.newPage();
    return await openVerification(contender, 'expect-busy');
  } finally {
    await context.close();
  }
}

async function runPhase(phase) {
  const context = await chromium.launchPersistentContext(profileDirectory, {
    ...chromiumExecutableOptions(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    return await openVerification(page, phase);
  } finally {
    await context.close();
  }
}

async function runClearedPhase() {
  const context = await chromium.launchPersistentContext(profileDirectory, {
    ...chromiumExecutableOptions(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const session = await context.newCDPSession(page);
    await session.send('Storage.clearDataForOrigin', {
      origin,
      storageTypes: 'all',
    });
    return await openVerification(page, 'cleared');
  } finally {
    await context.close();
  }
}

async function openVerification(page, phase) {
  const url = new URL('/test/persistence.html', origin);
  url.searchParams.set('phase', phase);
  url.searchParams.set('database', databaseName);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('#result').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.querySelector('#result')?.getAttribute('data-status') !== 'running',
    undefined,
    { timeout: 60_000 },
  );
  const status = await page.locator('#result').getAttribute('data-status');
  const content = await page.locator('#result').textContent();
  if (status !== 'passed') {
    throw new Error(`Browser persistence phase ${phase} failed:\n${content ?? ''}`);
  }
  return JSON.parse(content ?? '{}');
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited before verification:\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${origin}/test/persistence.html`);
      if (response.ok) return;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Vite:\n${serverOutput}`);
}

/** Stop pnpm and the vite server it started (both share the detached process group). */
function stopProcessGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already stopped */
  }
}
