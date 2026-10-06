import { chromiumExecutableOptions } from './lib/browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

const port = 5600 + (Date.now() % 300);
const origin = `http://127.0.0.1:${String(port)}`;
const profileDirectory = await mkdtemp(join(tmpdir(), 'yelaxis-onboarding-onboarding-'));
const resumeProfileDirectory = await mkdtemp(join(tmpdir(), 'yelaxis-onboarding-resume-'));
const skipProfileDirectory = await mkdtemp(join(tmpdir(), 'yelaxis-onboarding-skip-'));
const server = spawn(
  'pnpm',
  ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  },
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
  const happyPath = await verifyHappyPathAndPersistence();
  const partialResume = await verifyPartialResume();
  const skipPath = await verifySkipPath();
  process.stdout.write(
    `${JSON.stringify({ browser: 'Playwright Chromium', happyPath, partialResume, skipPath }, null, 2)}\n`,
  );
} finally {
  stopProcessGroup(server);
  await Promise.all([
    rm(profileDirectory, { force: true, recursive: true }),
    rm(resumeProfileDirectory, { force: true, recursive: true }),
    rm(skipProfileDirectory, { force: true, recursive: true }),
  ]);
}

async function verifyHappyPathAndPersistence() {
  const externalRequests = [];
  let context = await launch(profileDirectory, { width: 1280, height: 800 });
  let page = context.pages()[0] ?? (await context.newPage());
  await page.bringToFront();
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) externalRequests.push(request.url());
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
  const setupStartedAt = Date.now();
  await assertNoOverflow(page, 'welcome 1280x800');
  await page.screenshot({ path: '/tmp/yelaxis-onboarding-welcome-1280x800.png', fullPage: true });

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByText('Offline — setup saves to this browser.').waitFor();
  await page.getByLabel('Preferred name').fill('Sam');
  await page.getByRole('button', { name: 'Start locally' }).click();
  await page.getByRole('heading', { name: 'Confirm how your calendar works.' }).waitFor();
  await page.screenshot({ path: '/tmp/yelaxis-onboarding-defaults-1280x800.png', fullPage: true });
  await page.getByLabel('Planning time zone').fill('UTC+5');
  await page.getByRole('button', { name: 'Confirm defaults' }).click();
  await page
    .getByRole('alert')
    .getByText('Please check the highlighted setup information.')
    .waitFor();
  await page.screenshot({
    path: '/tmp/yelaxis-onboarding-validation-1280x800.png',
    fullPage: true,
  });
  await page.getByLabel('Planning time zone').fill('America/New_York');
  await page.getByLabel('First day of week').selectOption('sunday');
  await page.getByLabel('12-hour').check();
  await page.getByRole('button', { name: 'Confirm defaults' }).click();
  await page.getByRole('heading', { name: 'Add only the context that helps.' }).waitFor();
  await page.screenshot({ path: '/tmp/yelaxis-onboarding-context-1280x800.png', fullPage: true });
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('heading', { name: 'Name up to three directions.' }).waitFor();
  await page.screenshot({ path: '/tmp/yelaxis-onboarding-axes-1280x800.png', fullPage: true });
  await page.getByLabel('Study').check();
  await page.screenshot({
    path: '/tmp/yelaxis-onboarding-axes-selected-1280x800.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Save Axes' }).click();
  await page.getByRole('heading', { name: 'Describe success, not activity.' }).waitFor();
  await page.screenshot({ path: '/tmp/yelaxis-onboarding-outcome-1280x800.png', fullPage: true });
  await page.getByLabel('Add a first Outcome').check();
  await page.getByLabel('Outcome title').fill('Submit a clear proposal');
  await page
    .getByLabel('Success definition')
    .fill('The reviewer can decide without asking for missing information.');
  await page.getByLabel('Axis link').selectOption('0');
  await page.getByRole('button', { name: 'Save Outcome' }).click();
  await page.getByRole('heading', { name: 'Make Today genuinely useful.' }).waitFor();
  await page.screenshot({ path: '/tmp/yelaxis-onboarding-week-1280x800.png', fullPage: true });
  await page.getByLabel('First concrete Action').fill('Draft the proposal outline');
  await page.getByRole('button', { name: 'Add fixed time' }).click();
  await page.getByLabel('Title').last().fill('Planning session');
  await page.getByLabel('Date').fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel('Start').last().fill('13:00');
  await page.getByLabel('End').last().fill('14:00');
  await page
    .getByLabel('I confirm this is a real fixed commitment, not general availability.')
    .check();
  await page.getByRole('button', { name: 'Continue to handbook' }).click();
  await page.getByRole('heading', { name: 'Learn the manual loop in a safe sandbox.' }).waitFor();
  await page.screenshot({ path: '/tmp/yelaxis-onboarding-handbook-1280x800.png', fullPage: true });
  await page.getByLabel('Sample capture').fill('Disposable sample only');
  await page.getByRole('button', { name: 'Next lesson' }).click();
  await page.getByRole('button', { name: 'Schedule sample for Tuesday' }).click();
  await page.getByRole('button', { name: 'Next lesson' }).click();
  await page.getByLabel('Mark the disposable sample complete').check();
  await page.getByRole('button', { name: 'Next lesson' }).click();
  await page.getByLabel('Sample review').fill('Keep the next step small.');
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('heading', { name: /start with one clear action/u }).waitFor();
  const automatedSetupDurationMs = Date.now() - setupStartedAt;
  assert(
    (await page.getByText('Draft the proposal outline').count()) >= 1,
    'Today must show the persisted Action.',
  );
  assert(
    (await page.getByText('Disposable sample only').count()) === 0,
    'Handbook sample must not enter the canonical plan.',
  );
  // Today no longer shows the onboarding direction strip ; the persisted Outcome is
  // listed once in its Axis. In-app navigation keeps this check offline.
  await page.locator('.primary-nav').getByRole('link', { name: 'Axis', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Axes', exact: true }).waitFor();
  await page
    .getByRole('list', { name: 'Axes', exact: true })
    .getByRole('link', { name: 'Study', exact: true })
    .click();
  await page.getByRole('heading', { level: 1, name: 'Study', exact: true }).waitFor();
  await page
    .getByRole('list', { name: 'Outcomes in Study' })
    .getByRole('link', { name: 'Submit a clear proposal', exact: true })
    .waitFor();
  assert(
    (await page.locator('main').getByText('Submit a clear proposal').count()) === 1,
    'The Axis must list the persisted Outcome once.',
  );
  await context.setOffline(false);

  await page.goto(`${origin}/learn`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Rerun handbook' }).click();
  await page.getByRole('heading', { name: 'Learn the manual loop in a safe sandbox.' }).waitFor();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await page.getByRole('link', { name: 'Learn YelAxis Planner' }).click();
  await page.getByRole('heading', { name: 'Learn the manual loop in a safe sandbox.' }).waitFor();
  await page.getByRole('button', { name: 'Skip handbook' }).click();

  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Light').check();
  await page.getByLabel('Reduced').check();
  await page.setViewportSize({ width: 1024, height: 768 });
  await assertNoOverflow(page, 'settings 1024x768');
  await page.screenshot({
    path: '/tmp/yelaxis-onboarding-settings-1024x768-light.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset progress' }).click();
  await page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
  await page.getByRole('button', { name: 'Leave setup' }).click();
  await page.getByRole('button', { name: 'Resume setup' }).waitFor();
  await page.getByRole('button', { name: 'Resume setup' }).dispatchEvent('click');
  await page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
  await page.getByRole('button', { name: 'Start locally' }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.getByLabel('Planning time zone').fill('Europe/London');
  await page.getByLabel('24-hour').check();
  await page.getByRole('button', { name: 'Confirm defaults' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  assert(
    await page.getByLabel('Study').isChecked(),
    'Rerun must prefill the existing starter Axis.',
  );
  await page.getByLabel('Axis 1 name').fill('Research');
  await page.screenshot({
    path: '/tmp/yelaxis-onboarding-edit-axes-1024x768-light.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Save Axes' }).click();
  await page.getByLabel('Outcome title').fill('Submit the reviewed proposal');
  await page.getByRole('button', { name: 'Save Outcome' }).click();
  await page
    .getByText('This persisted commitment keeps its authoring time zone (America/New_York)')
    .waitFor();
  await page.getByLabel('First concrete Action').fill('Revise the proposal outline');
  await page.getByRole('button', { name: 'Continue to handbook' }).click();
  await page.getByRole('button', { name: 'Skip and open Today' }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.getByRole('heading', { name: /start with one clear action/u }).waitFor();
  // The onboarding Action can show twice on Today: as a focus item and in the flexible list.
  await page.getByText('Revise the proposal outline').first().waitFor();
  await page.getByRole('link', { name: 'Plan', exact: true }).click();
  await page.waitForURL(/\/plan\//u);
  // The commitment's title is visible once; its buttons also name it for screen readers.
  await page
    .locator('main .entry-title')
    .getByText('Planning session', { exact: true })
    .first()
    .waitFor();
  await page.goto(`${origin}/axis`, { waitUntil: 'networkidle' });
  const researchAxis = page
    .getByRole('list', { name: 'Axes', exact: true })
    .getByRole('link', { name: 'Research', exact: true });
  await researchAxis.waitFor();
  assert(
    (await page.getByText('Research', { exact: true }).count()) === 1,
    'Rerun must update the starter Axis in place.',
  );
  assert(
    (await page.getByText('Study', { exact: true }).count()) === 0,
    'Rerun must not duplicate the original starter Axis.',
  );
  // The rerun renames the onboarding Outcome in place, still in its (renamed) Axis.
  await researchAxis.click();
  await page.getByRole('heading', { level: 1, name: 'Research', exact: true }).waitFor();
  await page
    .getByRole('list', { name: 'Outcomes in Research' })
    .getByRole('link', { name: 'Submit the reviewed proposal', exact: true })
    .waitFor();
  assert(
    (await page.locator('main').getByText('Submit a clear proposal').count()) === 0,
    'The rerun must rename the Outcome, not add a second one.',
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Dark').check();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.screenshot({
    path: '/tmp/yelaxis-onboarding-today-1440x900-dark.png',
    fullPage: true,
  });
  await assertNoOverflow(page, 'Today 1440x900');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  assert(
    (await page.locator(':focus').textContent())?.trim() === 'Skip to content',
    'First shell focus must be the skip link.',
  );
  await page.keyboard.press('Enter');
  assert(
    (await page.locator(':focus').getAttribute('id')) === 'main-content',
    'Skip link must focus main content.',
  );

  await context.close();
  context = await launch(profileDirectory, { width: 1440, height: 900 });
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /start with one clear action/u }).waitFor();
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /start with one clear action/u }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByText('Offline — your local plan remains available.').waitFor();
  await context.setOffline(false);
  await context.close();

  assert(
    externalRequests.length === 0,
    `Onboarding must make no external requests: ${externalRequests.join(', ')}`,
  );
  return {
    checks: [
      'fresh offline local happy path',
      'accessible domain validation summary',
      'non-default defaults',
      'useful Today and Week',
      'working isolated handbook',
      'non-destructive reset',
      'idempotent rerun and rapid-submit guard',
      'completed setup edits update stable artifacts',
      'Profile zone edit preserves the fixed commitment authoring zone',
      'keyboard skip focus',
      'browser close/reopen persistence',
      'offline reload',
      'no external auth, analytics, or model requests',
    ],
    automatedSetupDurationMs,
    screenshots: [
      '/tmp/yelaxis-onboarding-welcome-1280x800.png',
      '/tmp/yelaxis-onboarding-defaults-1280x800.png',
      '/tmp/yelaxis-onboarding-validation-1280x800.png',
      '/tmp/yelaxis-onboarding-context-1280x800.png',
      '/tmp/yelaxis-onboarding-axes-1280x800.png',
      '/tmp/yelaxis-onboarding-axes-selected-1280x800.png',
      '/tmp/yelaxis-onboarding-outcome-1280x800.png',
      '/tmp/yelaxis-onboarding-week-1280x800.png',
      '/tmp/yelaxis-onboarding-handbook-1280x800.png',
      '/tmp/yelaxis-onboarding-settings-1024x768-light.png',
      '/tmp/yelaxis-onboarding-edit-axes-1024x768-light.png',
      '/tmp/yelaxis-onboarding-today-1440x900-dark.png',
    ],
  };
}

async function verifyPartialResume() {
  let context = await launch(resumeProfileDirectory, { width: 1280, height: 800 });
  let page = context.pages()[0] ?? (await context.newPage());
  await page.bringToFront();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Start locally' }).click();
  await page.getByRole('heading', { name: 'Confirm how your calendar works.' }).waitFor();
  await context.close();
  context = await launch(resumeProfileDirectory, { width: 1280, height: 800 });
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Confirm how your calendar works.' }).waitFor();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
  await context.close();
  return {
    checks: ['partial progress survives browser restart', 'Back returns to prior meaningful step'],
  };
}

async function verifySkipPath() {
  const context = await launch(skipProfileDirectory, { width: 1280, height: 800 });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.bringToFront();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Start locally' }).click();
  await page.getByRole('button', { name: 'Confirm defaults' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByLabel('First concrete Action').fill('Write one clear next step');
  await page.getByRole('button', { name: 'Continue to handbook' }).click();
  await page.getByRole('button', { name: 'Skip and open Today' }).click();
  // The onboarding Action can show twice on Today: as a focus item and in the flexible list.
  await page.getByText('Write one clear next step').first().waitFor();
  assert(
    (await page.getByText('Direction', { exact: false }).count()) === 0,
    'Skipped Outcome must remain absent.',
  );
  await context.close();
  return {
    checks: [
      'all optional profile/context/Axis/Outcome/commitment/handbook inputs skipped',
      'required concrete Action still reaches useful Today',
    ],
  };
}

function launch(userDataDir, viewport) {
  return chromium.launchPersistentContext(userDataDir, {
    ...chromiumExecutableOptions(),
    headless: process.env.YELAXIS_HEADFUL !== '1',
    args: ['--no-sandbox', '--disable-gpu', '--force-renderer-accessibility'],
    viewport,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
}
async function assertNoOverflow(page, label) {
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(layout.clientWidth === layout.scrollWidth, `${label} must not overflow horizontally.`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null)
      throw new Error(`Vite preview exited before verification:\n${serverOutput}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      /* still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Vite preview:\n${serverOutput}`);
}

/** Stop pnpm and the vite server it started (both share the detached process group). */
function stopProcessGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already stopped */
  }
}
