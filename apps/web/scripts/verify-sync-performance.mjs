import { chromiumExecutableOptions } from './lib/browser.mjs';
/**
 * Large account sync on the selected local
 * Supabase test stack: a local plan of 10,000 Actions uploads through bounded groups, and a
 * second client pulls it through bounded pages, while the interface stays usable. During each
 * transfer the journey opens Capture, captures an Action, and opens the Inbox, timing each, and it
 * records main-thread long tasks. Afterwards nothing waits in the outbox and both clients hold
 * every record. Chromium only, like the other performance journeys. Keys stay in memory.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from './lib/browser.mjs';

import {
  accountIdOf,
  buildWithAccount,
  cloudRows,
  deleteAccounts,
  redact,
  stackEnvironment,
} from './lib/account-stack.mjs';
import { assert, poll } from './lib/journey.mjs';

const datasetSize = 10_000;
/**
 * Budgets with room for a loaded machine (the measured values are printed): interactions keep the
 * Actions thresholds (quick capture 500 ms, reopening the Inbox 1,500 ms), and no main-thread task may
 * reach 250 ms while a transfer runs.
 */
const budgets = Object.freeze({
  uploadMs: 120_000,
  pullMs: 90_000,
  captureOpenWorstMs: 500,
  captureSaveWorstMs: 1_000,
  inboxOpenWorstMs: 1_500,
  longestTaskMs: 250,
});

stackEnvironment();
const port = 6800 + (Date.now() % 250);
const origin = `http://127.0.0.1:${String(port)}`;
const email = `sync-large-${randomUUID().slice(0, 12)}@example.test`;
const password = `sync-${randomBytes(18).toString('base64url')}`;
const directories = [];
const contexts = new Set();
const accounts = [];
let server;
let serverOutput = '';
let observedClient;
let observedAccount;
const rpcResponses = new Map();
let observedMeasurements;

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

function stopServer(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already stopped */
  }
}

async function waitForServer(child) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited:\n${serverOutput}`);
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the server:\n${serverOutput}`);
}

async function launch(directory) {
  const context = await chromium.launchPersistentContext(directory, {
    ...chromiumExecutableOptions(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--enable-precise-memory-info'],
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Asia/Tashkent',
    locale: 'en-US',
  });
  contexts.add(context);
  context.on('close', () => contexts.delete(context));
  // Main-thread long tasks, from the first script on every page.
  await context.addInitScript(() => {
    window.__longTasks = [];
    // Aggregate worker round trips without retaining SQL, parameters, content or credentials.
    window.__sqliteMetrics = {};
    const observedWorkers = new WeakMap();
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (request, ...args) {
      if (typeof request?.id === 'number' && typeof request.operation === 'string') {
        let pending = observedWorkers.get(this);
        if (!pending) {
          pending = new Map();
          observedWorkers.set(this, pending);
          this.addEventListener('message', ({ data }) => {
            const measured = pending.get(data?.id);
            if (!measured) return;
            pending.delete(data.id);
            const elapsed = performance.now() - measured.start;
            const metric = (window.__sqliteMetrics[measured.kind] ??= {
              count: 0,
              totalMs: 0,
              longestMs: 0,
            });
            metric.count += 1;
            metric.totalMs += elapsed;
            metric.longestMs = Math.max(metric.longestMs, elapsed);
          });
        }
        const kind =
          request.operation === 'get' && /FROM actions\s+WHERE/iu.test(request.sql ?? '')
            ? 'actionRead'
            : request.operation === 'executeScript' && /^COMMIT/iu.test(request.sql ?? '')
              ? 'commit'
              : request.operation;
        pending.set(request.id, { kind, start: performance.now() });
      }
      return postMessage.call(this, request, ...args);
    };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* not supported */
    }
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith('/rest/v1/rpc/')) return;
    const key = `${path}:${String(response.status())}`;
    rpcResponses.set(key, (rpcResponses.get(key) ?? 0) + 1);
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

async function profileDirectory(label) {
  const directory = await mkdtemp(join(tmpdir(), `yelaxis-sync-large-${label}-`));
  directories.push(directory);
  return directory;
}

const rounded = (value) => Math.round(value);

async function timed(operation) {
  const started = performance.now();
  await operation();
  return rounded(performance.now() - started);
}

/** In-app navigation that keeps the running app. */
async function navigate(page, path) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** Capture, a capture, and the Inbox, timed while a transfer runs. */
async function interactions(page, title) {
  const dialog = page.getByRole('dialog', { name: 'Add to Inbox' });
  const captureOpenMs = await timed(async () => {
    await page.keyboard.press('Alt+c');
    await dialog.getByLabel('Title').waitFor();
  });
  await dialog.getByLabel('Title').fill(title);
  const captureSaveMs = await timed(async () => {
    await dialog.getByRole('button', { name: 'Capture', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  });
  const inboxOpenMs = await timed(async () => {
    await navigate(page, '/inbox');
    await page.getByRole('heading', { name: 'Decide what happens next.' }).waitFor();
    await page.locator('.inbox-list > li').first().waitFor();
  });
  return { captureOpenMs, captureSaveMs, inboxOpenMs };
}

async function longTasksSince(page, since) {
  return page.evaluate((start) => window.__longTasks.filter((task) => task.start >= start), since);
}

function summarizeTasks(tasks) {
  const durations = tasks.map((task) => task.duration);
  return {
    count: durations.length,
    longestMs: rounded(Math.max(0, ...durations)),
    totalMs: rounded(durations.reduce((sum, value) => sum + value, 0)),
  };
}

/** This device's record total, as the deletion preview counts it (nothing is deleted). */
async function localRecordCount(page) {
  await navigate(page, '/account');
  await page.getByRole('button', { name: 'Delete account' }).click();
  const form = page.getByRole('form', { name: 'Delete account' });
  const local = form.getByText(/records? on this device\. Deleted unless you keep it\./u);
  await local.waitFor({ timeout: 60_000 });
  const text = await local.innerText();
  await form.getByRole('button', { name: 'Cancel' }).click();
  const match = text.match(/^([\d,]+) records?/u);
  return match === null ? null : Number(match[1].replaceAll(',', ''));
}

try {
  /* ───────────── Seed A's local plan through the dev server ───────────── */
  server = startServer('dev');
  await waitForServer(server);
  const directoryA = await profileDirectory('A');
  let A = await launch(directoryA);
  await A.page.goto(`${origin}/test/sync-seed.html?size=${String(datasetSize)}`);
  await A.page.waitForFunction(
    () => document.querySelector('#result')?.getAttribute('data-status') !== 'running',
    undefined,
    { timeout: 300_000 },
  );
  const seeded = await A.page.locator('#result').textContent();
  assert(
    (await A.page.locator('#result').getAttribute('data-status')) === 'passed',
    `Seeding failed: ${seeded ?? ''}`,
  );
  await A.context.close();
  stopServer(server);
  await new Promise((resolve) => setTimeout(resolve, 500));

  /* ───────────── The account build ───────────── */
  await buildWithAccount();
  serverOutput = '';
  server = startServer('preview');
  await waitForServer(server);

  /* ───────────── A uploads 10,000 Actions ───────────── */
  A = await launch(directoryA);
  observedClient = A;
  await A.page.goto(origin);
  await A.page.getByRole('heading', { name: 'A useful day starts here.' }).waitFor({
    timeout: 60_000,
  });
  await navigate(A.page, '/account');
  const create = A.page.getByRole('form', { name: 'Create account' });
  await create.getByLabel('Email').fill(email);
  await create.getByLabel('Password').fill(password);
  await create.getByRole('button', { name: 'Create account' }).click();
  await A.page.getByRole('button', { name: 'Upload this plan' }).waitFor({ timeout: 60_000 });
  const accountId = accountIdOf(email);
  assert(accountId !== null, 'The account must exist.');
  accounts.push(accountId);
  observedAccount = accountId;
  const uploadStart = await A.page.evaluate(() => performance.now());
  await A.page.evaluate(() => (window.__sqliteMetrics = {}));
  const uploadStarted = performance.now();
  await A.page.getByRole('button', { name: 'Upload this plan' }).click();
  await A.page.locator('.sync-status-line[data-state="first_upload"]').waitFor({
    timeout: 60_000,
  });
  const duringUpload = await interactions(A.page, 'Captured during the large upload');
  await A.page.locator('.sync-status-line[data-state="synced"]').waitFor({
    timeout: budgets.uploadMs,
  });
  const uploadMs = rounded(performance.now() - uploadStarted);
  const uploadTasks = summarizeTasks(await longTasksSince(A.page, uploadStart));
  await poll(
    () => (cloudRows(accountId).byType.action ?? 0) === datasetSize + 1,
    'The cloud must hold every Action.',
    { timeout: 60_000, interval: 2_000 },
  );
  const uploadHeap = await A.page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
  const uploadWorker = await A.page.evaluate(() => window.__sqliteMetrics);

  /* ───────────── B pulls them ───────────── */
  const B = await launch(await profileDirectory('B'));
  observedClient = B;
  await B.page.goto(origin);
  await B.page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
  await B.page.getByRole('button', { name: 'Sign in' }).click();
  const signIn = B.page.getByRole('dialog');
  await signIn.getByLabel('Email').fill(email);
  await signIn.getByLabel('Password').fill(password);
  const pullStart = await B.page.evaluate(() => performance.now());
  const pullStarted = performance.now();
  await signIn.getByRole('button', { name: 'Sign in' }).click();
  // The Profile arrives first; the frame opens while later pages are still being applied.
  await B.page.getByRole('heading', { name: 'A useful day starts here.' }).waitFor({
    timeout: 120_000,
  });
  const frameMs = rounded(performance.now() - pullStarted);
  const duringPull = await interactions(B.page, 'Captured during the large pull');
  await B.page.locator('.sync-status-line[data-state="synced"]').waitFor({
    timeout: budgets.pullMs,
  });
  const pullMs = rounded(performance.now() - pullStarted);
  const pullTasks = summarizeTasks(await longTasksSince(B.page, pullStart));
  const pullHeap = await B.page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
  const pullWorker = await B.page.evaluate(() => window.__sqliteMetrics);
  process.stderr.write(
    `measured: upload ${String(uploadMs)} ms ${JSON.stringify(duringUpload)} ${JSON.stringify(uploadTasks)}; pull ${String(pullMs)} ms (frame ${String(frameMs)} ms) ${JSON.stringify(duringPull)} ${JSON.stringify(pullTasks)}\n`,
  );

  /* ───────────── Both clients hold every record ───────────── */
  // The seeded Actions plus one capture on each client.
  const expected = datasetSize + 2;
  await poll(
    () => (cloudRows(accountId).byType.action ?? 0) === expected,
    'The cloud must hold both captures.',
    { timeout: 60_000, interval: 2_000 },
  );
  const cloud = cloudRows(accountId);
  // A's final pull must start after B's new record has actually reached the server. A previously
  // visible "Synced" label alone neither starts nor awaits the new manual cycle.
  await A.page.getByRole('link', { name: 'Account' }).last().click();
  await A.page.getByRole('button', { name: 'Sync now' }).click();
  await A.page
    .locator('.account-result')
    .filter({ hasText: 'Everything on this device is synced.' })
    .waitFor({ timeout: 120_000 });
  let onA, onB;
  await poll(
    async () => {
      onA = await localRecordCount(A.page);
      onB = await localRecordCount(B.page);
      return onA === cloud.live && onB === cloud.live;
    },
    'Both canonical plans must converge to every live cloud record.',
    { timeout: 120_000, interval: 2_000 },
  );
  assert(onA === cloud.live, `A holds ${String(onA)} records; the cloud ${String(cloud.live)}.`);
  assert(onB === cloud.live, `B holds ${String(onB)} records; the cloud ${String(cloud.live)}.`);
  await navigate(A.page, '/account');
  const waiting = A.page.locator('.account-facts dt', { hasText: 'Changes waiting to sync' });
  assert(
    (await waiting.locator('xpath=following-sibling::dd[1]').innerText()).trim() === '0',
    'Nothing may wait in A’s outbox.',
  );

  const report = {
    backend: 'selected local test stack',
    seeded: JSON.parse(seeded ?? '{}'),
    upload: {
      uploadMs,
      ...duringUpload,
      longTasks: uploadTasks,
      usedJSHeapSize: uploadHeap,
      workerRoundTrips: uploadWorker,
    },
    pull: {
      frameMs,
      pullMs,
      ...duringPull,
      longTasks: pullTasks,
      usedJSHeapSize: pullHeap,
      workerRoundTrips: pullWorker,
    },
    records: { cloudActions: cloud.byType.action, cloudLive: cloud.live, onA, onB },
    budgets,
  };
  observedMeasurements = report;
  for (const [label, measured] of [
    ['upload', report.upload],
    ['pull', report.pull],
  ]) {
    assert(
      measured.captureOpenMs <= budgets.captureOpenWorstMs,
      `${label}: Capture opened slowly.`,
    );
    assert(
      measured.captureSaveMs <= budgets.captureSaveWorstMs,
      `${label}: a capture saved slowly.`,
    );
    assert(measured.inboxOpenMs <= budgets.inboxOpenWorstMs, `${label}: the Inbox opened slowly.`);
    assert(
      measured.longTasks.longestMs <= budgets.longestTaskMs,
      `${label}: a main-thread task took ${String(measured.longTasks.longestMs)} ms.`,
    );
  }
  assert(A.errors.length + B.errors.length === 0, `Page errors: ${[...A.errors, ...B.errors]}`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await A.context.close();
  await B.context.close();
} catch (error) {
  const page = observedClient?.page;
  const screenshot = '/tmp/yelaxis-sync-performance-failure.png';
  if (page) await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
  const state = page
    ? await page
        .evaluate(() => ({
          status: document.querySelector('.sync-status-line')?.getAttribute('data-state'),
          statusText: document.querySelector('.sync-status-line')?.textContent,
          progress: [...document.querySelectorAll('.account-progress progress')].map((node) => ({
            value: node.value,
            max: node.max,
          })),
          visible: document.visibilityState,
          workerRoundTrips: window.__sqliteMetrics,
        }))
        .catch(() => ({ unavailable: true }))
    : null;
  let cloud = null;
  if (observedAccount) {
    try {
      cloud = cloudRows(observedAccount);
    } catch {
      cloud = { unavailable: true };
    }
  }
  process.stderr.write(
    `${JSON.stringify({ failureState: state, cloudCounts: cloud, rpcResponseCounts: Object.fromEntries(rpcResponses), measurements: observedMeasurements, screenshot })}\n`,
  );
  process.stderr.write(
    `${redact(error instanceof Error ? (error.stack ?? error.message) : error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await Promise.all([...contexts].map((context) => context.close()));
  if (server !== undefined) stopServer(server);
  await deleteAccounts(accounts);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
}
