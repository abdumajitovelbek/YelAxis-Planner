import { chromiumExecutableOptions } from './lib/browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, firefox } from './lib/browser.mjs';

/**
 * planning production-browser journey: Year/Month/Week/Day horizons, scheduling with an explicit
 * duration, every manual conflict choice, routines, templates, capacity, carry-forward, offline use,
 * restart persistence, both Week layouts, themes, reduced motion, and keyboard paths.
 */
const port = 6400 + (Date.now() % 300);
const origin = `http://127.0.0.1:${String(port)}`;
const timeZone = 'America/New_York';
// `--firefox` runs the same journey in Playwright Firefox (normal website use; no PWA install).
const inFirefox = process.argv.includes('--firefox');
const browserLabel = inFirefox ? 'firefox' : 'chromium';
const profileDirectory = await mkdtemp(
  join(tmpdir(), `yelaxis-planning-horizons-${browserLabel}-`),
);
const screenshots = [];
const checks = [];
const server = spawn(
  'pnpm',
  ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  // Own process group so the vite child is stopped with pnpm (SIGTERM alone leaves it running).
  { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
const stopServer = () => {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already stopped */
  }
};
process.on('exit', stopServer);
const watchdog = setTimeout(() => {
  process.stderr.write(`planning journey exceeded 10 minutes at step: ${currentStep}\n`);
  stopServer();
  process.exit(1);
}, 600_000);
let currentStep = 'start';
/** Latest page, for a failure screenshot. */
let activePage;
function step(name) {
  currentStep = name;
  process.stderr.write(`step: ${name}\n`);
}
let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += String(chunk);
});
server.stderr.on('data', (chunk) => {
  serverOutput += String(chunk);
});

const today = localDate(new Date());
const weekStart = mondayOf(today);
const nextMonday = addDays(weekStart, 7);

try {
  await waitForServer();
  const result = await verifyHorizons().catch(async (error) => {
    const failure = `/tmp/yelaxis-planning-${inFirefox ? 'firefox-' : ''}failure.png`;
    await activePage?.screenshot({ path: failure, fullPage: true }).catch(() => undefined);
    process.stderr.write(`Failure screenshot: ${failure}\n`);
    throw error;
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  clearTimeout(watchdog);
  stopServer();
  await rm(profileDirectory, { force: true, recursive: true });
}

async function verifyHorizons() {
  const externalRequests = [];
  const browserErrors = [];
  let context = await launch();
  let page = context.pages()[0] ?? (await context.newPage());
  observePage(page, externalRequests, browserErrors);
  await page.goto(origin, { waitUntil: 'networkidle' });
  await completeMinimalOnboarding(page);

  step('verifyAvailability');
  await verifyAvailability(page);
  step('verifyWeekAndDay');
  await verifyWeekAndDay(page, context);
  // Chromium runs Routine edits, conflict resolution, and Template apply fully offline (verification contract);
  // Firefox covers the same steps online as normal website use.
  if (!inFirefox) await context.setOffline(true);
  step('verifyRoutines');
  await verifyRoutines(page);
  step('verifyTemplates');
  await verifyTemplates(page);
  if (!inFirefox) {
    await context.setOffline(false);
    checks.push('offline Routine edits, conflict choices, and Template apply/undo (Chromium)');
  }
  step('verifyMonthAndYear');
  await verifyMonthAndYear(page);
  step('verifyLayouts');
  await verifyLayouts(page);

  step('restart: close');
  await context.close();
  step('restart: relaunch');
  context = await launch();
  page = context.pages()[0] ?? (await context.newPage());
  observePage(page, externalRequests, browserErrors);
  step('verifyRestart');
  await verifyRestart(page);
  await context.close();

  // The same profile opened from a device in another zone (travel).
  step('verifyZoneChange');
  context = await launch('Europe/London');
  page = context.pages()[0] ?? (await context.newPage());
  observePage(page, externalRequests, browserErrors);
  await verifyZoneChange(page);
  await context.close();
  context = await launch('Europe/London');
  page = context.pages()[0] ?? (await context.newPage());
  observePage(page, externalRequests, browserErrors);
  await page.goto(`${origin}/plan/week/${nextMonday}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 2, name: 'Backlog' }).waitFor();
  assert(
    (await page.getByText(/Your device is set to/u).count()) === 0,
    'Keeping the planning zone must persist across a restart on the same device zone.',
  );
  await context.close();

  assert(
    externalRequests.length === 0,
    `planning made external requests: ${externalRequests.join(', ')}`,
  );
  assert(browserErrors.length === 0, `planning browser errors: ${browserErrors.join(' | ')}`);
  return {
    browser: inFirefox ? 'Playwright Firefox' : 'Playwright Chromium',
    timeZone,
    today,
    checks,
    screenshots,
  };
}

/* ───────────────────────── Availability and capacity ───────────────────────── */

async function verifyAvailability(page) {
  await page.goto(`${origin}/plan/availability`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1, name: 'Availability and capacity' }).waitFor();
  await assertSingleH1(page, 'Availability');
  await page
    .getByText(/never treated as free/u)
    .first()
    .waitFor();
  await page.getByRole('button', { name: 'Add availability' }).click();
  const editor = page.locator('.availability-editor');
  await editor.getByRole('button', { name: 'Save availability' }).click();
  await editor.getByRole('alert').first().waitFor();
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    await editor.getByRole('checkbox', { name: day, exact: true }).check();
  }
  await editor.getByLabel('Start').fill('09:00');
  await editor.getByLabel('End').fill('17:00');
  await editor.getByLabel(/^Soft/u).check();
  await editor.getByRole('button', { name: 'Save availability' }).click();
  await page.getByText('Availability added.').first().waitFor();
  await page
    .getByText(/defined for 5 of 7 weekdays/u)
    .first()
    .waitFor();
  const dayLimit = page.locator('fieldset.limit-editor').filter({ hasText: 'Day limit' });
  await dayLimit.getByLabel('Hours').fill('6');
  await dayLimit.getByLabel('Minutes').fill('0');
  await dayLimit.getByRole('button', { name: 'Set day limit' }).click();
  await page.getByText('Day limit set.').first().waitFor();
  await shot(page, 'availability-1280x800');
  checks.push('availability windows with validation, soft strength, and a day limit');
}

/* ───────────────────────── Week and Day ───────────────────────── */

async function verifyWeekAndDay(page, context) {
  await page.goto(`${origin}/plan`, { waitUntil: 'networkidle' });
  await page.waitForURL(new RegExp(`/plan/week/${today}$`, 'u'));
  await assertSingleH1(page, 'Current Week');
  checks.push('Plan opens the current Week by default');

  await capture(page, 'Draft proposal', { plannedDate: nextMonday, estimate: 45 });
  await capture(page, 'Old errand', { plannedDate: addDays(weekStart, -3) });
  await capture(page, 'Call supplier', { plannedDate: addDays(nextMonday, 2) });

  await page.goto(`${origin}/plan/week/${nextMonday}`, { waitUntil: 'networkidle' });
  await assertSingleH1(page, 'Week');
  await page.getByRole('heading', { level: 2, name: 'Backlog' }).waitFor();
  const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
  const order = ['Fixed commitments', 'Schedule', 'Carry forward', 'This week', 'Backlog'].map(
    (name) => headings.indexOf(name),
  );
  assert(
    order.every((value, index) => value >= 0 && (index === 0 || value > order[index - 1])),
    `Week must begin with reality: ${headings.join(' | ')}`,
  );
  checks.push(
    'Week orders fixed commitments, schedule and availability, carry-forward, commitments',
  );

  const carry = page.getByRole('list', { name: 'Actions to carry forward' });
  await carry.getByText('Old errand').first().waitFor();
  await carry.getByRole('checkbox', { name: /Old errand/u }).check();
  await page.locator('#carry-destination').selectOption(nextMonday);
  await page.getByRole('button', { name: /^Move to /u }).click();
  await page
    .getByText(/^Moved 1 to/u)
    .first()
    .waitFor();
  await dayCard(page, nextMonday).getByRole('link', { name: 'Old errand', exact: true }).waitFor();
  await carry.getByText('Old errand').waitFor({ state: 'detached' });
  // Only the chosen Action moves. When today falls before the viewed week (every day except the
  // week's first day), the onboarding Action placed today also ended before it  and
  // must stay offered and unchosen.
  for (const box of await carry.getByRole('checkbox').all())
    assert(!(await box.isChecked()), 'Only the chosen Action may move.');
  const firstDay = await page
    .locator('section.day-card [id^="week-day-"]')
    .first()
    .getAttribute('id');
  const viewedWeekStart = (firstDay ?? '').replace('week-day-', '');
  assert(/^\d{4}-\d{2}-\d{2}$/u.test(viewedWeekStart), `Unexpected day card id: ${firstDay}`);
  if (today < viewedWeekStart)
    await carry.getByRole('checkbox', { name: /Onboarding useful Action/u }).waitFor();
  else await page.getByText('Nothing to carry forward.').waitFor();
  checks.push('carry-forward moves an unfinished Action only through an explicit choice');

  const wednesday = dayCard(page, addDays(nextMonday, 2));
  await wednesday.getByRole('button', { name: /Remove from day Call supplier/u }).click();
  await page.getByText('Removed from the day. It is in the Backlog.').first().waitFor();
  const backlog = page.getByRole('list', { name: 'Backlog Actions' });
  await backlog.getByRole('link', { name: 'Call supplier' }).waitFor();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await wednesday.getByRole('link', { name: 'Call supplier' }).waitFor();
  await wednesday.getByRole('button', { name: /Remove from day Call supplier/u }).click();
  await backlog.getByRole('link', { name: 'Call supplier' }).waitFor();
  checks.push('remove from day to Backlog with grouped undo');

  const monday = dayCard(page, nextMonday);
  await monday.getByRole('button', { name: /Schedule… Draft proposal/u }).click();
  const schedule = page.getByRole('dialog', { name: /Schedule “Draft proposal”/u });
  await schedule.waitFor();
  assert(
    (await schedule.getByLabel('Duration (minutes)').inputValue()) === '45',
    'Schedule must prefill the duration from the estimate, visibly editable.',
  );
  await schedule.getByLabel('Date').fill(addDays(nextMonday, 1));
  await schedule.getByLabel('Start time').fill('09:00');
  await schedule
    .getByText(/09:00|9:00\sAM/u)
    .first()
    .waitFor();
  await shot(page, 'schedule-dialog-1280x800');
  await schedule.getByRole('button', { name: 'Schedule', exact: true }).click();
  await schedule.waitFor({ state: 'hidden' });
  await page.getByText('Action scheduled.').first().waitFor();
  const tuesday = dayCard(page, addDays(nextMonday, 1));
  await tuesday.getByRole('link', { name: 'Draft proposal' }).waitFor();
  checks.push('scheduling asks for an explicit duration and previews the resolved interval');

  await page.getByRole('button', { name: 'Add fixed commitment' }).click();
  const commitment = page.getByRole('dialog', { name: 'Add a fixed commitment' });
  await commitment.waitFor();
  await commitment.locator('#commitment-title').fill('Client call');
  await commitment.getByLabel('Date').fill(addDays(nextMonday, 1));
  await commitment.getByLabel('Start time').fill('09:30');
  await commitment.getByLabel('Duration (minutes)').fill('60');
  await commitment.locator('#commitment-hard').check();
  await commitment.getByText('This time overlaps:').waitFor();
  await commitment.getByRole('button', { name: 'Add commitment' }).click();
  await commitment
    .getByText(/Choose Keep this overlap/u)
    .first()
    .waitFor();
  await shot(page, 'commitment-overlap-1280x800');
  await commitment.getByLabel(/Keep this overlap/u).check();
  await commitment.getByRole('button', { name: 'Add commitment' }).click();
  await commitment.waitFor({ state: 'hidden' });
  await page.getByText('Commitment added.').first().waitFor();
  await page.locator('.kept-list').getByText('Overlap kept').waitFor();
  const fixed = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Fixed commitments' }),
  });
  await fixed.getByText('Client call').first().waitFor();
  checks.push('overlap requires explicit Keep this overlap and is then listed as kept');

  const gymDay = addDays(today, 1);
  await page.goto(`${origin}/plan/week/${gymDay}`, { waitUntil: 'networkidle' });
  const addBlock = page.getByRole('button', { name: 'Add time block' });
  await addBlock.focus();
  await page.keyboard.press('Enter');
  const block = page.getByRole('dialog', { name: 'Add a time block' });
  await block.waitFor();
  await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
  await page.keyboard.press('Escape');
  await block.waitFor({ state: 'hidden' });
  assert(
    await addBlock.evaluate((element) => element === document.activeElement),
    'Closing a dialog with Escape must restore focus to its opener.',
  );
  await page.keyboard.press('Enter');
  await block.waitFor();
  await block.locator('#custom-block-title').fill('Gym');
  await block.getByLabel('Date').fill(gymDay);
  await block.getByLabel('Start time').fill('06:45');
  await block.getByLabel('Duration (minutes)').fill('45');
  await block.getByRole('button', { name: 'Add time block' }).click();
  await block.waitFor({ state: 'hidden' });
  await page.getByText('Time block added.').first().waitFor();
  checks.push('keyboard-only dialog open, Escape, and focus restoration');

  await page.goto(`${origin}/plan/day/${gymDay}`, { waitUntil: 'networkidle' });
  await assertSingleH1(page, 'Day');
  const timeline = page.getByRole('list', { name: /^Timed plan for/u });
  await timeline.getByText('Gym').first().waitFor();
  const dayBacklog = page.getByRole('list', { name: 'Backlog Actions' });
  const supplierRow = dayBacklog.locator('li').filter({ hasText: 'Call supplier' });
  const slot = page.locator('.timeline-hour').nth(8);
  // Start the drag on the row itself (not on its link or buttons) and drop on an hour slot.
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await supplierRow.dragTo(slot, { sourcePosition: { x: 4, y: 4 } });
  const dropped = page.getByRole('dialog', { name: /Schedule “Call supplier”/u });
  await dropped.waitFor();
  assert(
    (await dropped.getByLabel('Start time').inputValue()) !== '',
    'Dropping on the timeline must prefill the start time.',
  );
  assert(
    (await dropped.getByLabel('Duration (minutes)').inputValue()) === '',
    'Dropping must not invent a duration.',
  );
  await dropped.getByRole('button', { name: 'Cancel' }).click();
  await dropped.waitFor({ state: 'hidden' });
  await dayBacklog.getByRole('button', { name: /Place on this day Call supplier/u }).click();
  await page
    .getByRole('list', { name: 'Flexible Actions' })
    .getByRole('link', { name: 'Call supplier' })
    .waitFor();
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'day-1280x800');
  checks.push('Day timeline, flexible list, Backlog, and mouse drag with a button alternative');

  if (inFirefox) {
    // Firefox covers website use: go offline on an already loaded plan.
    await page.goto(`${origin}/plan/week/${nextMonday}`, { waitUntil: 'networkidle' });
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  } else {
    // Chromium also proves the PWA shell reloads offline.
    await context.setOffline(true);
    await page.goto(`${origin}/plan/week/${nextMonday}`, { waitUntil: 'domcontentloaded' });
  }
  const draft = dayCard(page, addDays(nextMonday, 1))
    .locator('.timed-entry')
    .filter({ hasText: 'Draft proposal' });
  await draft.locator('summary').click();
  await draft.getByRole('button', { name: /^Skip/u }).click();
  await page.getByText('Marked skipped.').first().waitFor();
  await draft.getByText('Skipped').first().waitFor();
  if (!(await draft.locator('details').evaluate((element) => element.open)))
    await draft.locator('summary').click();
  await draft.getByRole('button', { name: /^Reopen/u }).click();
  await page.getByText('Time block reopened.').first().waitFor();
  await context.setOffline(false);
  checks.push('offline reload and block skip/reopen');
}

async function verifyConflicts(page) {
  const gymDay = addDays(today, 1);
  await page.goto(`${origin}/plan/week/${gymDay}`, { waitUntil: 'networkidle' });
  const overlaps = page.locator('#plan-overlaps');
  const item = () => overlaps.locator('.conflict-item').filter({ hasText: 'Gym' });
  await item().waitFor();
  await overlaps
    .getByText(/Morning pages/u)
    .first()
    .waitFor();
  await shot(page, 'conflict-open-1280x800');

  const choose = async (button, dialogName, confirmName, prepare) => {
    await item().getByRole('button', { name: button }).first().click();
    if (dialogName !== null) {
      const dialog = page.getByRole('dialog', { name: dialogName });
      await dialog.waitFor();
      if (prepare !== undefined) await prepare(dialog);
      await dialog.getByRole('button', { name: confirmName, exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await overlaps.getByText('No overlaps to review.').waitFor();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await item().waitFor();
  };

  await choose(/^Keep overlap…/u, 'Keep this overlap?', 'Keep overlap', undefined);
  checks.push('conflict choice: Keep overlap (explicit confirmation, audited, undoable)');
  await choose(/^Shorten… Gym/u, /Shorten “Gym”/u, 'Shorten', (dialog) =>
    dialog.locator('#shorten-duration').fill('15'),
  );
  checks.push('conflict choice: Shorten');
  await choose(/^Move… Gym/u, /Move “Gym”/u, 'Move', (dialog) =>
    dialog.getByLabel('Start time').fill('08:00'),
  );
  checks.push('conflict choice: Move');
  await choose(/^Cancel… Gym/u, 'Cancel this time block?', 'Cancel time block', undefined);
  checks.push('conflict choice: Cancel');
  await choose(/^Skip this occurrence/u, null, null, undefined);
  checks.push('conflict choice for a routine occurrence: Skip this occurrence');

  await item()
    .getByRole('button', { name: /^Keep overlap…/u })
    .click();
  const keep = page.getByRole('dialog', { name: 'Keep this overlap?' });
  await keep.getByRole('button', { name: 'Keep overlap', exact: true }).click();
  await keep.waitFor({ state: 'hidden' });
  await page.locator('.kept-list').getByText(/Gym/u).first().waitFor();
}

/* ───────────────────────── Routines ───────────────────────── */

async function verifyRoutines(page) {
  await page.goto(`${origin}/plan/routines`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Capture Alt C/u }).click();
  const repeating = page.getByRole('dialog', { name: 'Add to Inbox' });
  await repeating.waitFor();
  await repeating.getByLabel('Title').fill('Water plants');
  const details = repeating.locator('details.expanded-fields');
  if (!(await details.evaluate((element) => element.open)))
    await repeating.getByText('More details').click();
  await repeating.getByLabel('Repeat', { exact: true }).check();
  await repeating.getByRole('button', { name: 'Create routine', exact: true }).click();
  await repeating.waitFor({ state: 'hidden' });
  await page
    .getByRole('link', { name: /Water plants/u })
    .first()
    .waitFor();
  await page.goto(`${origin}/inbox`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1 }).waitFor();
  assert(
    (await page.getByText('Water plants', { exact: true }).count()) === 0,
    'A repeating capture must create a Routine and no one-off Action.',
  );
  checks.push('repeating capture creates a Routine with no one-off Action');
  await page.goto(`${origin}/plan/routines`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1, name: 'Routines' }).waitFor();
  await page.getByRole('button', { name: 'New routine' }).click();
  const dialog = page.getByRole('dialog', { name: 'New routine' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill('Morning pages');
  await dialog.getByLabel('Every N days').check();
  await dialog.getByLabel(/^Starts on/u).fill(today);
  await dialog.getByLabel('At a set time').check();
  await dialog.getByLabel('Time', { exact: true }).fill('07:00');
  await dialog.getByLabel(/^Duration/u).fill('30');
  await dialog.getByText('Next occurrences').waitFor();
  await dialog
    .getByText(/07:00|7:00\sAM/u)
    .first()
    .waitFor();
  await shot(page, 'routine-form-1280x800');
  await dialog.getByRole('button', { name: 'Create routine' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('Routine created.').first().waitFor();
  checks.push('time-specific routine creation with live preview');

  await verifyConflicts(page);

  await page.goto(`${origin}/plan/routines`, { waitUntil: 'networkidle' });
  await page
    .getByRole('link', { name: /Morning pages/u })
    .first()
    .click();
  await page.getByRole('heading', { level: 1, name: 'Morning pages' }).waitFor();

  const upcoming = page.locator('section').filter({ hasText: 'Upcoming' }).first();
  await upcoming
    .getByRole('button', { name: /^Complete/u })
    .first()
    .click();
  await page
    .getByText(/Completed/u)
    .first()
    .waitFor();
  await upcoming.getByRole('button', { name: /^Skip/u }).first().click();
  await page
    .getByText(/Skipped/u)
    .first()
    .waitFor();
  checks.push('occurrence complete and skip from routine detail');

  await page.getByRole('button', { name: 'Change this and future…' }).click();
  const future = page.getByRole('dialog', { name: 'Change this and future occurrences' });
  await future.getByLabel(/^First date the change applies/u).fill(addDays(today, 3));
  await future.getByLabel('Time', { exact: true }).fill('06:30');
  await future.getByRole('button', { name: 'Apply from this date' }).click();
  await future.waitFor({ state: 'hidden' });
  await page.getByText('Routine changed from the chosen date.').first().waitFor();
  await page.getByText('Earlier patterns').first().waitFor();
  checks.push('this-and-future split keeps earlier history');

  await page.getByRole('button', { name: 'Pause…' }).click();
  const pause = page.getByRole('dialog', { name: 'Pause routine' });
  await pause.getByLabel(/^Pause from/u).fill(addDays(today, 7));
  await pause.getByRole('button', { name: 'Pause routine' }).click();
  await pause.waitFor({ state: 'hidden' });
  await page.getByText('Routine paused.').first().waitFor();
  await page.getByRole('button', { name: 'Resume…' }).click();
  const resume = page.getByRole('dialog', { name: 'Resume routine' });
  await resume.getByLabel(/^Resume on/u).fill(addDays(today, 14));
  await resume.getByRole('button', { name: 'Resume routine' }).click();
  await resume.waitFor({ state: 'hidden' });
  await page.getByText('Routine resumed.').first().waitFor();
  await shot(page, 'routine-detail-1280x800');
  checks.push('pause and resume without backfill');
}

/* ───────────────────────── Templates ───────────────────────── */

async function verifyTemplates(page) {
  await page.goto(`${origin}/plan/templates`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1, name: 'Templates' }).waitFor();
  for (const title of [
    'Weekly Reset',
    'Study Week',
    'Product Sprint',
    'Research Block',
    'Balanced Day',
  ]) {
    await page.getByText(title, { exact: true }).first().waitFor();
  }
  await page.getByRole('link', { name: 'Preview and apply Study Week' }).click();
  await page.getByRole('heading', { name: 'Apply this template' }).waitFor();
  await page.getByLabel(/^Start date/u).fill(nextMonday);
  const items = page.getByRole('list', { name: 'Template items' });
  await items.getByText('Review lecture notes').waitFor();
  await items
    .getByText(/America\/New York, UTC/u)
    .first()
    .waitFor();
  const projectItem = items.locator('li').filter({ hasText: 'Study week' }).first();
  await projectItem.getByRole('checkbox').uncheck();
  await page.getByText('Resolve before applying:').waitFor();
  assert(
    await page.getByRole('button', { name: /^Apply \d+ items?$/u }).isDisabled(),
    'Apply must be disabled while a parent is deselected.',
  );
  await shot(page, 'template-deselect-issue-1280x800');
  await projectItem.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Apply 7 items' }).click();
  await page
    .getByText(/Template applied\./u)
    .first()
    .waitFor();
  await shot(page, 'template-applied-1280x800');
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Change undone.').first().waitFor();
  checks.push('built-in template preview, deselection issue, atomic apply, and undo');

  await page.getByRole('button', { name: 'Apply 7 items' }).click();
  await page
    .getByText(/Template applied\./u)
    .first()
    .waitFor();
  await page.getByRole('link', { name: /Open the Week plan/u }).click();
  await page.getByText('Review lecture notes').first().waitFor();
  checks.push('template apply opens the real Week plan');
}

/* ───────────────────────── Month and Year ───────────────────────── */

async function verifyMonthAndYear(page) {
  const month = nextMonday.slice(0, 7);
  await page.goto(`${origin}/plan/month/${month}-01`, { waitUntil: 'networkidle' });
  await assertSingleH1(page, 'Month');
  await page.getByRole('list', { name: 'Weeks in this month' }).waitFor();
  await page
    .getByText(/planned/u)
    .first()
    .waitFor();
  await page.getByRole('button', { name: 'Add a theme' }).click();
  await page.getByLabel(/^Month theme for/u).fill('Steady study, fewer late nights.');
  await page.getByRole('button', { name: 'Save theme' }).click();
  await page.getByText('Steady study, fewer late nights.').first().waitFor();
  await shot(page, 'month-1280x800');
  const monthUrl = page.url();
  const weekLink = page.getByRole('list', { name: 'Weeks in this month' }).getByRole('link').last();
  await weekLink.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 120));
  const scrolled = await page.evaluate(() => Math.round(window.scrollY));
  const scrollEntry = await page.evaluate(() => ({
    key: window.history.state?.key ?? 'default',
    stored: sessionStorage.getItem(`yelaxis:plan:scroll:${window.history.state?.key ?? 'default'}`),
    scrollY: Math.round(window.scrollY),
    maximum: document.documentElement.scrollHeight - innerHeight,
  }));
  await weekLink.evaluate((link) =>
    link.addEventListener(
      'pointerdown',
      () => {
        window.__horizonPointerScroll = Math.round(window.scrollY);
      },
      { once: true },
    ),
  );
  await weekLink.click();
  await page.waitForURL(/\/plan\/week\//u);
  await page.getByRole('heading', { level: 2, name: 'Backlog' }).waitFor();
  process.stderr.write(
    `scroll diagnostic: ${JSON.stringify({ before: scrollEntry, after: await page.evaluate((key) => ({ pointerY: window.__horizonPointerScroll, stored: sessionStorage.getItem(`yelaxis:plan:scroll:${key}`), scrollY: Math.round(window.scrollY) }), scrollEntry.key) })}\n`,
  );
  checks.push('month density text, theme editor, and week drill-in');
  await page.goBack();
  await page.waitForURL(monthUrl);
  await page.getByText('Steady study, fewer late nights.').first().waitFor();
  try {
    await page.waitForFunction((expected) => Math.abs(window.scrollY - expected) <= 4, scrolled, {
      timeout: 5_000,
    });
  } catch (error) {
    process.stderr.write(
      `scroll restoration diagnostic: ${JSON.stringify({ expected: scrolled, actual: await page.evaluate((key) => ({ scrollY: Math.round(window.scrollY), stored: sessionStorage.getItem(`yelaxis:plan:scroll:${key}`), maximum: document.documentElement.scrollHeight - innerHeight }), scrollEntry.key) })}\n`,
    );
    throw error;
  }
  checks.push('Back returns to the previous horizon, date, and scroll position');

  await page.getByRole('button', { name: 'Edit theme' }).click();
  await page.getByLabel(/^Month theme for/u).fill('Draft that is not saved yet.');
  await page
    .getByRole('navigation', { name: 'Horizon' })
    .getByRole('link', { name: 'Week' })
    .click();
  const leave = page.getByRole('dialog', { name: 'Save your changes before leaving?' });
  await leave.waitFor();
  await leave.getByRole('button', { name: 'Continue editing' }).click();
  await leave.waitFor({ state: 'hidden' });
  assert(page.url() === monthUrl, 'Continue editing must stay on the Month.');
  assert(
    (await page.getByLabel(/^Month theme for/u).inputValue()) === 'Draft that is not saved yet.',
    'Continue editing must keep the draft.',
  );
  await page
    .getByRole('navigation', { name: 'Horizon' })
    .getByRole('link', { name: 'Week' })
    .click();
  await leave.waitFor();
  await leave.getByRole('button', { name: 'Discard' }).click();
  await page.waitForURL(/\/plan\/week\//u);
  await page.getByRole('heading', { level: 2, name: 'Backlog' }).waitFor();
  await page.goBack();
  await page.getByText('Steady study, fewer late nights.').first().waitFor();
  checks.push('unsaved theme edits offer Save, Discard, or Continue editing on horizon change');

  await page.goto(`${origin}/plan/year/${month}-01`, { waitUntil: 'networkidle' });
  await assertSingleH1(page, 'Year');
  await page.getByText('Daily actions stay in Week and Day.').waitFor();
  await page.getByText('Steady study, fewer late nights.').first().waitFor();
  await page.getByRole('button', { name: 'Add a direction' }).click();
  await page.getByLabel(/^Year direction for/u).fill('Build durable study habits.');
  await page.getByRole('button', { name: 'Save direction' }).click();
  await page.getByText('Build durable study habits.').first().waitFor();
  await page.getByRole('radio', { name: 'Months' }).check();
  await page.waitForURL(/view=months/u);
  await shot(page, 'year-1280x800');
  checks.push('year direction, month themes, and Quarters/Months view without daily Actions');
}

/* ───────────────────────── Layouts, themes, motion ───────────────────────── */

async function verifyLayouts(page) {
  const week = `${origin}/plan/week/${nextMonday}`;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(week, { waitUntil: 'networkidle' });
  let layout = await weekLayout(page);
  assert(layout.columns, `1920 Week must show day columns: ${JSON.stringify(layout)}`);
  assert(
    layout.sidebar,
    `1920 Week must keep Backlog beside the schedule: ${JSON.stringify(layout)}`,
  );
  await assertNoOverflow(page, 'Week 1920x1080');
  await assertTargets(page, 'Week 1920x1080');
  await shot(page, 'week-columns-1920x1080');

  for (const [width, height] of [
    [1280, 800],
    [1024, 768],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(week, { waitUntil: 'networkidle' });
    layout = await weekLayout(page);
    assert(!layout.columns, `${String(width)} Week must use agenda day cards.`);
    await page.getByRole('heading', { name: 'Backlog' }).waitFor();
    await assertNoOverflow(page, `Week ${String(width)}x${String(height)}`);
    await shot(page, `week-agenda-${String(width)}x${String(height)}`);
  }
  checks.push('adaptive Week: columns with Backlog sidebar at 1920; agenda cards at 1280 and 1024');

  await page.setViewportSize({ width: 1440, height: 900 });
  for (const path of [
    `/plan/week/${nextMonday}`,
    `/plan/day/${addDays(nextMonday, 1)}`,
    `/plan/month/${nextMonday}`,
    `/plan/year/${nextMonday}`,
    '/plan/routines',
    '/plan/templates',
    '/plan/availability',
  ]) {
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await assertNoOverflow(page, `${path} at 200% text`);
    if (path.startsWith('/plan/week/')) {
      assert(!(await weekLayout(page)).columns, 'Week at 200% text must use agenda day cards.');
      await shot(page, 'week-200-percent-text-1440x900');
    }
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('font-size');
    });
  }
  checks.push('200% text reflow without horizontal overflow on every planning view');

  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Dark').check();
  await page.getByLabel('Reduced').check();
  for (const [path, name] of [
    [`/plan/week/${nextMonday}`, 'week-dark-reduced-1440x900'],
    [`/plan/day/${addDays(nextMonday, 1)}`, 'day-dark-reduced-1440x900'],
    [`/plan/month/${nextMonday}`, 'month-dark-reduced-1440x900'],
  ]) {
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1 }).waitFor();
    await assertNoOverflow(page, `${path} dark reduced`);
    await shot(page, name);
  }
  step('layouts: reduced-motion audit');
  const animated = await page.evaluate(
    () =>
      [...document.querySelectorAll('main *')].filter((element) => {
        const style = getComputedStyle(element);
        const seconds = (value) =>
          Math.max(...value.split(',').map((part) => Number.parseFloat(part) || 0));
        return seconds(style.animationDuration) > 0.01 || seconds(style.transitionDuration) > 0.01;
      }).length,
  );
  assert(animated === 0, `Reduced motion must remove animation (${String(animated)} animated).`);
  step('layouts: restore theme');
  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Light').check();
  await page.getByLabel('System').last().check();
  checks.push('dark and light themes with reduced motion and no animated elements');
}

async function weekLayout(page) {
  await page.locator('.week-days > li').nth(6).waitFor();
  await page.locator('.week-side').waitFor();
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.week-days > li')].map((element) =>
      element.getBoundingClientRect(),
    );
    const schedule = document.querySelector('.week-schedule')?.getBoundingClientRect();
    const side = document.querySelector('.week-side')?.getBoundingClientRect();
    return {
      columns: cards.length === 7 && Math.abs(cards[0].top - cards[1].top) < 2,
      sidebar: schedule !== undefined && side !== undefined && side.left >= schedule.right - 1,
    };
  });
}

async function assertTargets(page, label) {
  const small = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'main button, main select, main input:not([type=checkbox]):not([type=radio]), main summary',
      ),
    ]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.height < 44;
      })
      .map((element) => `${element.tagName} "${(element.textContent ?? '').trim().slice(0, 30)}"`),
  );
  assert(small.length === 0, `${label} has targets under 44px: ${small.slice(0, 8).join(', ')}`);
}

function dayCard(page, date) {
  return page.locator('section.day-card').filter({
    has: page.locator(`#week-day-${date}`),
  });
}

async function capture(page, title, { plannedDate, estimate } = {}) {
  await page.getByRole('button', { name: /Capture Alt C/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to Inbox' });
  await dialog.waitFor();
  await dialog.getByLabel('Title').fill(title);
  if (plannedDate !== undefined || estimate !== undefined) {
    const details = dialog.locator('details.expanded-fields');
    if (!(await details.evaluate((element) => element.open)))
      await dialog.getByText('More details').click();
    if (plannedDate !== undefined) await dialog.getByLabel('Planned date').fill(plannedDate);
    if (estimate !== undefined) await dialog.getByLabel('Estimate').fill(String(estimate));
  }
  await dialog.getByRole('button', { name: 'Capture', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function verifyZoneChange(page) {
  await page.goto(`${origin}/plan/week/${nextMonday}`, { waitUntil: 'networkidle' });
  const notice = page.getByText(
    'Your device is set to Europe/London. Your plan uses America/New York.',
  );
  await notice.waitFor();
  const review = page.getByRole('button', { name: 'Review a change to Europe/London…' });
  const dialog = page.getByRole('dialog', { name: 'Change the planning zone?' });
  await review.click();
  const routines = dialog.getByRole('list', { name: 'Upcoming Routine times' });
  await routines.getByText('Morning pages').waitFor();
  await routines
    .getByText(/stays .*, now in Europe\/London/u)
    .first()
    .waitFor();
  await shot(page, 'zone-change-preview-1280x800');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await notice.waitFor();
  checks.push('device-zone change prompt previews floating Routines; Cancel changes nothing');

  await review.click();
  await dialog.getByRole('button', { name: 'Change to Europe/London' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await notice.waitFor({ state: 'hidden' });
  await page.getByText('Planning time zone changed to Europe/London.').first().waitFor();
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await notice.waitFor();
  await page.getByRole('button', { name: 'Keep America/New York' }).click();
  await notice.waitFor({ state: 'hidden' });
  checks.push('explicit planning-zone change with undo, then Keep for this device zone');
}

async function verifyRestart(page) {
  await page.goto(`${origin}/plan/routines`, { waitUntil: 'networkidle' });
  await page.getByText('Morning pages').first().waitFor();
  await page.goto(`${origin}/plan/templates`, { waitUntil: 'networkidle' });
  await page.getByText('Balanced Day', { exact: true }).first().waitFor();
  assert(
    (await page.getByText('Study Week', { exact: true }).count()) === 1,
    'Built-in templates must not duplicate after restart.',
  );
  checks.push('full browser restart persistence and built-in non-duplication');
}

/* ───────────────────────── Helpers ───────────────────────── */

function localDate(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function mondayOf(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

async function shot(page, name) {
  const path = `/tmp/yelaxis-planning-${inFirefox ? 'firefox-' : ''}${name}.png`;
  await page.screenshot({ path, fullPage: true });
  screenshots.push(path);
}

async function assertSingleH1(page, label) {
  const count = await page.getByRole('heading', { level: 1 }).count();
  assert(count === 1, `${label} must have exactly one h1 (found ${String(count)}).`);
}

function observePage(page, externalRequests, browserErrors) {
  activePage = page;
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) externalRequests.push(request.url());
  });
  page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
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

async function launch(deviceZone = timeZone) {
  if (inFirefox)
    return firefox.launchPersistentContext(profileDirectory, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      timezoneId: deviceZone,
      locale: 'en-US',
    });
  return chromium.launchPersistentContext(profileDirectory, {
    ...chromiumExecutableOptions(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    viewport: { width: 1280, height: 800 },
    timezoneId: deviceZone,
    locale: 'en-US',
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
