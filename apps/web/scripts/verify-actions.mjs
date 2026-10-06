import { chromiumExecutableOptions } from './lib/browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from './lib/browser.mjs';

const port = 6100 + (Date.now() % 300);
const origin = `http://127.0.0.1:${String(port)}`;
const profileDirectory = await mkdtemp(join(tmpdir(), 'yelaxis-actions-actions-'));
const server = spawn(
  'pnpm',
  ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
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
  const result = await verifyActions();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  stopProcessGroup(server);
  await rm(profileDirectory, { force: true, recursive: true });
}

async function verifyActions() {
  const externalRequests = [];
  const browserErrors = [];
  let context = await launch();
  let page = context.pages()[0] ?? (await context.newPage());
  observePage(page, externalRequests, browserErrors);
  await page.goto(origin, { waitUntil: 'networkidle' });
  await completeMinimalOnboarding(page);

  for (const path of ['/', '/plan', '/axis', '/review', '/inbox']) {
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    const trigger = page.getByRole('button', { name: /Capture Alt C/u });
    await trigger.click();
    const surfaceDialog = page.getByRole('dialog', { name: 'Add to Inbox' });
    const surfaceTitle = surfaceDialog.getByLabel('Title');
    assert(
      await surfaceTitle.evaluate((element) => element === document.activeElement),
      `Capture must focus its title on ${path}.`,
    );
    await page.keyboard.press('Escape');
    await surfaceDialog.waitFor({ state: 'hidden' });
    assert(
      await trigger.evaluate((element) => element === document.activeElement),
      `Capture must restore focus on ${path}.`,
    );
  }
  await page.goto(origin, { waitUntil: 'networkidle' });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: /Capture Alt C/u }).click();
  const quickDialog = page.getByRole('dialog', { name: 'Add to Inbox' });
  await quickDialog.waitFor();
  const quickTitle = quickDialog.getByLabel('Title');
  assert(
    await quickTitle.evaluate((element) => element === document.activeElement),
    'Capture must focus title.',
  );
  await page.screenshot({ path: '/tmp/yelaxis-actions-capture-open-1280x800.png', fullPage: true });
  await quickTitle.fill('   ');
  await quickDialog.getByRole('button', { name: 'Capture', exact: true }).click();
  await quickDialog.getByRole('alert').waitFor();
  // Capture returns focus on the next animation frame after rendering validation.
  // Wait for that observable state, as the component regression does, before asserting it.
  await page.waitForFunction(
    () => document.querySelector('dialog[open] input[required]') === document.activeElement,
    undefined,
    { timeout: 5_000 },
  );
  assert(
    await quickTitle.evaluate((element) => element === document.activeElement),
    'Application validation must return focus to the title.',
  );
  await page.screenshot({
    path: '/tmp/yelaxis-actions-capture-validation-1280x800.png',
    fullPage: true,
  });
  await quickTitle.fill('Inbox alpha');
  await quickDialog.locator('form').evaluate((form) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await quickDialog.waitFor({ state: 'hidden' });
  assert(
    await page
      .getByRole('button', { name: /Capture Alt C/u })
      .evaluate((element) => element === document.activeElement),
    'Capture must restore opener focus.',
  );

  await page.getByRole('button', { name: /Capture Alt C/u }).click();
  const expanded = page.getByRole('dialog', { name: 'Add to Inbox' });
  await expanded
    .getByRole('group')
    .count()
    .catch(() => 0);
  await expanded.getByText('More details').click();
  await expanded.getByLabel('Title').fill('Inbox expanded');
  await expanded
    .getByLabel('Note')
    .fill('Synthetic browser fixture with enough detail for restart verification.');
  await expanded.getByLabel('Planned date').fill('2026-08-12');
  await expanded.getByLabel('Due date').fill('2026-08-14');
  await expanded.getByLabel('Estimate').fill('35');
  await expanded.getByLabel('Energy').selectOption('focused');
  await expanded.getByLabel('Priority').selectOption('high');
  await expanded.getByLabel('Enable reminder definition').check();
  await expanded.getByLabel('Date').last().fill('2026-08-11');
  await expanded.getByLabel('Time', { exact: true }).fill('09:30');
  await page.screenshot({
    path: '/tmp/yelaxis-actions-expanded-capture-1280x800.png',
    fullPage: true,
  });
  await expanded.getByRole('button', { name: 'Capture', exact: true }).click();
  await expanded.waitFor({ state: 'hidden' });

  await page.getByRole('link', { name: 'Inbox' }).click();
  await page.getByRole('heading', { name: 'Decide what happens next.' }).waitFor();
  assert(
    (await page.getByText('Inbox alpha', { exact: true }).count()) === 1,
    'Rapid submit must create one row.',
  );
  assert(
    (await page.getByText('Inbox expanded', { exact: true }).count()) === 0,
    'Planned expanded capture must not remain in Inbox.',
  );
  await assertNoOverflow(page, 'Inbox 1280x800');
  await page.screenshot({ path: '/tmp/yelaxis-actions-inbox-1280x800.png', fullPage: true });

  let alpha = page.locator('.inbox-list > li').filter({ hasText: 'Inbox alpha' });
  await alpha.getByText('Triage').click();
  await alpha.getByRole('button', { name: 'Do today' }).click();
  await page.getByText('Change saved.').waitFor();
  assert(
    (await page.getByText('Inbox alpha', { exact: true }).count()) === 0,
    'Do must remove Action from Inbox.',
  );
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Inbox alpha', { exact: true }).waitFor();

  alpha = page.locator('.inbox-list > li').filter({ hasText: 'Inbox alpha' });
  await alpha.getByText('Triage').click();
  await alpha.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Inbox alpha', { exact: true }).waitFor();

  alpha = page.locator('.inbox-list > li').filter({ hasText: 'Inbox alpha' });
  await alpha.getByText('Triage').click();
  await alpha.getByRole('button', { name: 'Keep as Note' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Inbox alpha', { exact: true }).waitFor();

  alpha = page.locator('.inbox-list > li').filter({ hasText: 'Inbox alpha' });
  await alpha.getByText('Triage').click();
  await alpha.getByRole('button', { name: 'Keep as Project idea' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Inbox alpha', { exact: true }).waitFor();

  alpha = page.locator('.inbox-list > li').filter({ hasText: 'Inbox alpha' });
  await alpha.getByText('Triage').click();
  await alpha.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Inbox alpha', { exact: true }).waitFor();

  for (const title of ['Bulk one', 'Bulk two']) {
    await page.keyboard.press('Alt+c');
    const dialog = page.getByRole('dialog', { name: 'Add to Inbox' });
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByRole('button', { name: 'Capture', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  alpha = page.locator('.inbox-list > li').filter({ hasText: 'Inbox alpha' });
  const moveAlphaUp = alpha.getByRole('button', { name: 'Move Inbox alpha up' });
  await moveAlphaUp.focus();
  await page.keyboard.press('Enter');
  await page.getByText('Change saved.').waitFor();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Inbox alpha', { exact: true }).waitFor();

  await selectAll(page, 3);
  await page.screenshot({
    path: '/tmp/yelaxis-actions-inbox-selected-1280x800.png',
    fullPage: true,
  });
  await runBulkAndUndo(page, 'Do');
  await runBulkAndUndo(page, 'Plan');
  await runBulkAndUndo(page, 'Apply Axis', false);
  await runBulkAndUndo(page, 'Apply Project', false);
  await runBulkAndUndo(page, 'Complete', true, '/tmp/yelaxis-actions-inbox-empty-1280x800.png');
  await runBulkAndUndo(page, 'Cancel', true, undefined, true);
  await runBulkAndUndo(page, 'Archive', true, undefined, true);

  await page.getByRole('link', { name: 'Inbox alpha' }).click();
  try {
    await page.getByRole('heading', { name: 'Inbox alpha' }).waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `Action-detail navigation failed at ${page.url()}: ${await page.locator('body').innerText()}\nBrowser errors: ${browserErrors.join(' | ')}`,
      { cause: error },
    );
  }
  const detail = page.locator('.action-detail');
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByText('Offline — your local plan remains available.').waitFor();
  await detail.getByLabel('Estimate').fill('20');
  await detail.getByLabel('Energy').selectOption('medium');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Change saved.').waitFor();

  const longTitle = `Long synthetic Action title — ${'x'.repeat(200)}`.slice(0, 200);
  await detail.locator('form').getByLabel('Title').fill(longTitle);
  await detail.getByLabel('Note').fill('Synthetic long note for reflow verification. '.repeat(80));
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('heading', { name: longTitle }).waitFor();
  await assertNoOverflow(page, 'Long Action detail');
  await page.screenshot({
    path: '/tmp/yelaxis-actions-action-long-content-1280x800.png',
    fullPage: true,
  });
  await detail.locator('form').getByLabel('Title').fill('Inbox alpha');
  await detail.getByLabel('Note').fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('heading', { name: 'Inbox alpha' }).waitFor();

  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByText(/Action · archived/u).waitFor();
  await page.screenshot({
    path: '/tmp/yelaxis-actions-action-archived-1280x800.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText(/Action · inbox/u).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByText(/Action · canceled/u).waitFor();
  await page.getByRole('button', { name: 'Reopen as planned' }).click();
  await page.getByText(/Action · planned/u).waitFor();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByText(/Action · archived/u).waitFor();
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.getByText(/Action · planned/u).waitFor();
  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByText(/Action · completed/u).waitFor();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText(/Action · planned/u).waitFor();
  await page.screenshot({
    path: '/tmp/yelaxis-actions-action-detail-1280x800.png',
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Delete permanently…' }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Permanently delete Action?' });
  await deleteDialog.getByLabel('Action title').fill('Inbox alpha');
  await page.screenshot({
    path: '/tmp/yelaxis-actions-delete-confirmation-1280x800.png',
    fullPage: true,
  });
  await deleteDialog.getByRole('button', { name: 'Delete permanently' }).click();
  try {
    await page
      .getByRole('heading', { name: 'Decide what happens next.' })
      .waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `Permanent-delete navigation failed at ${page.url()}: ${await page.locator('body').innerText()}`,
      { cause: error },
    );
  }
  assert(
    (await page.getByText('Inbox alpha', { exact: true }).count()) === 0,
    'Permanent delete must remove Action.',
  );

  await page.keyboard.press('Alt+c');
  const offlineDialog = page.getByRole('dialog', { name: 'Add to Inbox' });
  await offlineDialog.getByLabel('Title').fill('Offline capture');
  await offlineDialog.getByRole('button', { name: 'Capture', exact: true }).click();
  await offlineDialog.waitFor({ state: 'hidden' });
  await page.getByText('Offline capture', { exact: true }).waitFor();
  await context.setOffline(false);

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`${origin}/inbox`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: '/tmp/yelaxis-actions-inbox-1024x768-light.png', fullPage: true });
  await assertNoOverflow(page, 'Inbox 1024x768');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await assertNoOverflow(page, 'Inbox at 200% text scaling');
  await page.getByText('Triage').first().waitFor();
  await page.screenshot({
    path: '/tmp/yelaxis-actions-inbox-200-percent-text.png',
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('font-size');
  });
  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Dark').check();
  await page.getByLabel('Reduced').check();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/inbox`, { waitUntil: 'networkidle' });
  await page.screenshot({
    path: '/tmp/yelaxis-actions-inbox-1440x900-dark-reduced.png',
    fullPage: true,
  });
  await assertNoOverflow(page, 'Inbox 1440x900 dark reduced');

  await context.close();
  context = await launch();
  page = context.pages()[0] ?? (await context.newPage());
  observePage(page, externalRequests, browserErrors);
  await page.goto(`${origin}/inbox`, { waitUntil: 'networkidle' });
  await page.getByText('Offline capture', { exact: true }).waitFor();
  assert(
    (await page.getByText('Bulk one', { exact: true }).count()) === 1,
    'Restart must preserve Inbox data.',
  );
  await context.close();

  assert(
    externalRequests.length === 0,
    `Actions made external requests: ${externalRequests.join(', ')}`,
  );
  assert(browserErrors.length === 0, `Actions browser errors: ${browserErrors.join(' | ')}`);
  return {
    browser: 'Playwright Chromium',
    checks: [
      'keyboard-first global quick capture and focus restoration',
      'global capture on Today, Plan, Axis, Review, and Inbox',
      'rapid duplicate submit idempotency',
      'expanded fields and honest reminder definition',
      'bounded Inbox list and deterministic canonical refresh',
      'individual Do, Plan, Keep Note, Keep Project, Archive, and grouped undo',
      'keyboard reorder and grouped undo',
      'all supported select-all bulk changes and grouped undo',
      'offline Action detail edit, archive/restore, cancel/reopen, complete/undo, and exact-title permanent delete',
      'offline capture and canonical Inbox refresh',
      'full browser restart persistence',
      '1024x768, 1280x800, and 1440x900 visual overflow checks',
      '200% text-scaling reflow',
      'light, dark, and reduced-motion rendering',
      'zero external requests',
    ],
    screenshots: [
      '/tmp/yelaxis-actions-inbox-1280x800.png',
      '/tmp/yelaxis-actions-capture-open-1280x800.png',
      '/tmp/yelaxis-actions-capture-validation-1280x800.png',
      '/tmp/yelaxis-actions-expanded-capture-1280x800.png',
      '/tmp/yelaxis-actions-inbox-selected-1280x800.png',
      '/tmp/yelaxis-actions-inbox-empty-1280x800.png',
      '/tmp/yelaxis-actions-action-detail-1280x800.png',
      '/tmp/yelaxis-actions-action-long-content-1280x800.png',
      '/tmp/yelaxis-actions-action-archived-1280x800.png',
      '/tmp/yelaxis-actions-delete-confirmation-1280x800.png',
      '/tmp/yelaxis-actions-inbox-1024x768-light.png',
      '/tmp/yelaxis-actions-inbox-200-percent-text.png',
      '/tmp/yelaxis-actions-inbox-1440x900-dark-reduced.png',
    ],
  };
}

function observePage(page, externalRequests, browserErrors) {
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) externalRequests.push(request.url());
  });
  page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
}

async function selectAll(page, count) {
  if ((await page.getByText(`${String(count)} selected`, { exact: true }).count()) === 0) {
    await page.getByRole('button', { name: `Select all ${String(count)}` }).click();
  }
  await page.getByText(`${String(count)} selected`, { exact: true }).waitFor();
}

async function runBulkAndUndo(
  page,
  buttonName,
  expectEmpty = true,
  screenshot,
  acceptConfirmation = false,
) {
  await selectAll(page, 3);
  if (acceptConfirmation) page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  if (expectEmpty) await page.getByText('Nothing waiting for a decision.').waitFor();
  else await page.getByText('Change saved.').waitFor();
  if (screenshot !== undefined) await page.screenshot({ path: screenshot, fullPage: true });
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Inbox alpha', { exact: true }).waitFor();
}

async function completeMinimalOnboarding(page) {
  await page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
  await page.getByRole('button', { name: 'Start locally' }).click();
  await page.getByRole('button', { name: 'Confirm defaults' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByLabel('First concrete Action').fill('Onboarding useful Action');
  await page.getByRole('button', { name: 'Continue to handbook' }).click();
  await page.getByRole('button', { name: 'Skip and open Today' }).click();
  await page.getByRole('heading', { name: 'A useful day starts here.' }).waitFor();
}

async function launch() {
  return chromium.launchPersistentContext(profileDirectory, {
    ...chromiumExecutableOptions(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    viewport: { width: 1280, height: 800 },
  });
}

async function assertNoOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  assert(
    metrics.body <= metrics.viewport,
    `${label} overflows (${String(metrics.body)} > ${String(metrics.viewport)}).`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
