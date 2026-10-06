import {
  accessibleDescription,
  addDays,
  animatedElementCount,
  assert,
  assertNoOverflow,
  assertSingleH1,
  assertStaticCaches,
  assertTargets,
  completeMinimalOnboarding,
  escapeRegExp,
  expectListOrder,
  forbiddenCopy,
  poll,
  runJourney,
  setDocumentVisibility,
  sleep,
  tabTo,
  waitForFocus,
} from './lib/journey.mjs';

/**
 * Today/Focus production journey: explicit focus, scheduling, overlaps, End Day and grouped Undo,
 * navigation, midnight/resume, offline restart, keyboard semantics, themes and reduced motion.
 * A fixed clock makes recurrence and rollover independent of the machine's date; relaunches
 * advance rather than reversing it. Firefox exercises the website without PWA offline reloads.
 */
const timeZone = 'America/New_York';

/** Monday. The day under test. */
const DAY = '2026-09-28';
const NEXT_DAY = '2026-09-29';
/** Live today after the clock change in step 9. */
const LATER_DAY = '2026-09-30';
/** A date inside next week, whatever the week start. */
const NEXT_WEEK = '2026-10-05';
const START = new Date('2026-09-28T09:00:00-04:00');
const BEFORE_MIDNIGHT = new Date('2026-09-28T23:59:00-04:00');
const AFTER_MIDNIGHT = new Date('2026-09-29T00:00:30-04:00');
const CLOCK_CHANGE = new Date('2026-09-30T08:00:00-04:00');
/**
 * Fresh pages opened after step 9 start here, not at START: the plan was already written on
 * September 30, and a clock that ran backwards would test something else.
 */
const RELAUNCH = new Date('2026-09-30T10:00:00-04:00');
/** Live-today h1 without a preferred name (onboarding string kept by Today). label: §5.3 */
const LIVE_H1 = 'A useful day starts here.';

/** Fictional plan content only. */
const T = {
  onboarding: 'Onboarding useful Action',
  water: 'Water the tomatoes',
  seeds: 'Sort the seed packets',
  plumber: 'Call the plumber',
  visit: 'Neighbour visit',
  stretch: 'Stretch',
  walk: 'Walk outside',
  tea: 'Tea break',
  twine: 'Buy twine',
  fence: 'Mend the fence',
};
const ids = {};

await runJourney({ name: 'today', title: 'Today', timeZone, basePort: 7500 }, async (j) => {
  const seen = { externalRequests: [], browserErrors: [], dialogs: [] };
  let context = await j.launch();
  let page = await preparePage(j, context, START, seen);
  await page.goto(j.origin, { waitUntil: 'networkidle' });

  j.step('1 onboarding and fresh launch');
  await verifyFreshLaunch(j, page, seen);
  j.step('2 empty day');
  await verifyEmptyDay(j, page);
  j.step('3 seed the day through the UI');
  await seedDay(j, page);
  j.step('4 focus');
  await verifyFocus(j, page);
  j.step('5 flexible list');
  await verifyFlexible(j, page);
  j.step('6 timeline, overlaps, and the current-time marker');
  await verifyTimeline(j, page);
  j.step('7 Focus mode');
  await verifyFocusMode(j, page, seen);
  j.step('8 midnight');
  await verifyMidnight(j, page);
  j.step('9 foreground resume and clock change');
  await verifyResumeAndClockChange(j, page);
  j.step('10 End Day');
  await verifyEndDay(j, page);
  j.step('11 unsaved guard');
  await verifyUnsavedGuard(j, page);
  j.step('12 offline and relaunch');
  ({ context, page } = await verifyOfflineAndRelaunch(j, context, page, seen));
  j.step('13 keyboard and semantics');
  await verifyKeyboardAndSemantics(j, page);
  j.step('14 layouts, targets, 200% text, and themes');
  await verifyLayouts(j, page);
  j.step('15 reduced motion');
  await verifyMotion(j, page);
  j.step('16 browser parity');
  j.checks.push(
    j.inFirefox
      ? 'Firefox: the same journey as website use (no offline reload or service-worker checks)'
      : 'Chromium: the full journey, including offline reload and the service-worker cache audit',
  );
  await context.close();

  assert(
    seen.externalRequests.length === 0,
    `Today made external requests: ${seen.externalRequests.join(', ')}`,
  );
  const artifacts = seen.browserErrors.filter((error) => isFirefoxClockArtifact(j, error));
  const errors = seen.browserErrors.filter((error) => !isFirefoxClockArtifact(j, error));
  assert(errors.length === 0, `Today browser errors: ${errors.join(' | ')}`);
  assert(seen.dialogs.length === 0, `Today opened browser dialogs: ${seen.dialogs.join(' | ')}`);
  j.checks.push('zero external requests, console or page errors, and browser dialogs');
  return {
    today: DAY,
    clockStart: START.toISOString(),
    // Reported, never hidden: see isFirefoxClockArtifact.
    firefoxClockArtifacts: artifacts,
  };
});

/* ───────────────────────── Page setup and shared helpers ───────────────────────── */

/**
 * Playwright's fake clock in Firefox logs this exact message, with no source location and no page
 * error or rejection, when the app page navigates while the fake clock is paused or has been
 * shifted (the midnight and clock-change steps). The same app sequence without the fake clock, and
 * the same clock steps on static pages, log nothing, so it comes from the clock's injected script,
 * not from YelAxis Planner. Only this message, only in Firefox, is set aside; it is still reported.
 */
function isFirefoxClockArtifact(j, error) {
  return (
    j.inFirefox &&
    error.startsWith(
      '[JavaScript Error: "InvalidStateError: An attempt was made to use an object that is not, or is no longer, usable"] [step: ',
    )
  );
}

/** Observe the page and install its clock before the first navigation. */
async function preparePage(j, context, time, seen) {
  const page = context.pages()[0] ?? (await context.newPage());
  j.observe(page, seen.externalRequests, seen.browserErrors);
  // Browser dialogs (beforeunload, confirm) are never part of Today; record any and let it go.
  page.on('dialog', (dialog) => {
    seen.dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.accept().catch(() => undefined);
  });
  await page.clock.install({ time });
  return page;
}

/*
 * Helpers below are function declarations: the journey above runs at module top level, before any
 * `const` declared after it would be initialized.
 */

function titled(title) {
  return new RegExp(escapeRegExp(title), 'u');
}

function longDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

/**
 * The wall time of an instant in the planning zone in both forms the app can show, "9:05 AM" and
 * "09:05", because the Profile's 12- or 24-hour choice comes from the device defaults.
 */
function wallLabels(epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24;
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return [
    `${String(hour % 12 === 0 ? 12 : hour % 12)}:${minute} ${hour < 12 ? 'AM' : 'PM'}`,
    `${String(hour).padStart(2, '0')}:${minute}`,
  ];
}

/** A pattern fragment for a clock time in either the 12- or the 24-hour form. */
function clock(hour, minute = 0) {
  const mm = String(minute).padStart(2, '0');
  const h12 = `${String(hour % 12 === 0 ? 12 : hour % 12)}:${mm}\\s${hour < 12 ? 'AM' : 'PM'}`;
  return `(?:${h12}|${String(hour).padStart(2, '0')}:${mm})`;
}

function pageNow(page) {
  return page.evaluate(() => Date.now());
}

async function heading1(page, name) {
  await page.getByRole('heading', { level: 1, name, exact: true }).waitFor();
}

/** Wait until the page has left its loading state (label: loading h1 "Opening today…", §5.3). */
async function settle(page) {
  await page.locator('main h1').first().waitFor();
  await poll(
    () =>
      page.evaluate(() => {
        const heading = document.querySelector('main h1');
        return heading !== null && !(heading.textContent ?? '').startsWith('Opening');
      }),
    'The page did not leave its loading state.',
  );
}

/**
 * While the page clock is paused, main-thread timers only run when the clock is advanced. Give the
 * page real time first, then advance the paused clock in small steps until `ready()` holds.
 */
async function advanceUntil(page, ready, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await ready().catch(() => false)) return;
    await sleep(100);
    if (await ready().catch(() => false)) return;
    await page.clock.runFor(100).catch(() => undefined);
  }
  throw new Error(message);
}

function visible(locator) {
  return locator.first().isVisible();
}

function pausedTodayReady(page) {
  return page.evaluate(() => {
    const heading = document.querySelector('main h1');
    return heading !== null && !(heading.textContent ?? '').startsWith('Opening');
  });
}

/** label: `nav aria-label="Day"` with "Previous day", "Today", "Next day" (§5.3) */
function dayLink(page, name) {
  return page.getByRole('navigation', { name: 'Day' }).getByRole('link', { name, exact: true });
}

function primaryToday(page) {
  return page.locator('.primary-nav').getByRole('link', { name: 'Today', exact: true });
}

/** label: eyebrow "{Today|Yesterday|Tomorrow|Earlier day|Later day} · {long date}" (§5.3) */
function eyebrow(page, relation, date) {
  return page.getByText(`${relation} · ${longDate(date)}`, { exact: true });
}

/** label: `ol aria-label="Focus for {date}"` (§5.4); the date format is not fixed, so prefix only. */
function focusList(page) {
  return page.getByRole('list', { name: /^Focus for /u });
}

/** label: `ul aria-label="Flexible Actions for {date}"` (§5.3) */
function flexibleList(page) {
  return page.getByRole('list', { name: /^Flexible Actions for /u });
}

function rowOf(list, title) {
  return list.locator(':scope > li').filter({ hasText: title });
}

/** The section around a Today or End Day h2 (label: section h2s, §5.3-§5.6). */
function section(page, name) {
  return page
    .getByRole('heading', { level: 2, name, exact: true })
    .locator('xpath=ancestor::section[1]');
}

function timeline(page) {
  return section(page, 'Timeline');
}

/**
 * A planning TimedEntryCard in Today's timeline, found by its own title (a card in an open overlap
 * also names the other item).
 */
function entryCard(page, title) {
  return timeline(page)
    .locator('.timed-entry')
    .filter({ has: page.locator('.entry-title', { hasText: title }) });
}

function main(page) {
  return page.locator('main');
}

/** The shared runner's Undo (planning UndoBar) in the page. */
function undo(page) {
  return main(page).getByRole('button', { name: 'Undo', exact: true }).first();
}

/** A control that may be built as a link or a button. */
function control(page, name) {
  return main(page)
    .getByRole('link', { name, exact: true })
    .or(main(page).getByRole('button', { name, exact: true }))
    .first();
}

/** label: reorder buttons "Move {title} up|down" (§5.3); focus items may say "Move up|down". */
function moveButton(list, title, direction) {
  const escaped = escapeRegExp(title);
  return rowOf(list, title).getByRole('button', {
    name: new RegExp(`^Move (?:${escaped} ${direction}|${direction}(?: ${escaped})?)$`, 'u'),
  });
}

/** label: "Remove from focus" (§5.4), with or without the title in its name. */
function removeFromFocus(list, title) {
  return rowOf(list, title).getByRole('button', { name: /^Remove\b.*\bfocus\b/u });
}

/** Activate a control from the keyboard, so focus is on it when a command removes it. */
async function press(page, locator) {
  await locator.focus();
  await page.keyboard.press('Enter');
}

/** After a command removes the focused control, focus lands on the view heading (alignment lesson). */
async function expectHeadingFocus(page, what) {
  await waitForFocus(page, page.locator('main h1'), {
    label: `${what}: focus must land on the view heading`,
  });
}

async function listOrder(list, titles) {
  const rows = await list
    .locator(':scope > li')
    .evaluateAll((items) => items.map((item) => item.textContent ?? ''));
  return rows.map((text) => titles.find((title) => text.includes(title)) ?? text.trim());
}

async function idFromLink(scope, title) {
  const href = await scope
    .getByRole('link', { name: title, exact: true })
    .first()
    .getAttribute('href');
  assert(href !== null, `No link to ${title}.`);
  return href.split('/').pop();
}

/** Open a `<details>` disclosure inside `container` when it is closed. */
async function openDetails(container) {
  const details = container.locator('details').first();
  await details.waitFor();
  if (!(await details.evaluate((element) => element.open)))
    await details.locator('summary').first().click();
}

/** label: flexible row "More options" disclosure (§5.3); a `<details>` summary or a button. */
async function openMoreOptions(row) {
  const toggle = row
    .locator('summary, button')
    .filter({ hasText: /^\s*More options/u })
    .first();
  await toggle.waitFor();
  const open = await toggle.evaluate((element) =>
    element.tagName === 'SUMMARY'
      ? element.closest('details')?.open === true
      : element.getAttribute('aria-expanded') === 'true',
  );
  if (!open) await toggle.click();
}

/** label: timeline toolbar text "Now {time}" (§5.3) */
function nowText(page) {
  return page.getByText(/^Now \d{1,2}:\d{2}(?:\s[AP]M)?/u).first();
}

async function readNowText(page) {
  if ((await nowText(page).count()) === 0) return '';
  return ((await nowText(page).textContent()) ?? '').replace(/\s+/gu, ' ').trim();
}

/** The current-time marker is shown and its "Now {time}" text matches the page clock. */
async function expectNowMarker(page, { paused = false } = {}) {
  const read = async () => {
    // label: data-testid="timeline-now" (§5.8)
    if (!(await visible(page.getByTestId('timeline-now')))) return false;
    const now = await pageNow(page);
    const accepted = [now, now - 60_000].flatMap((value) =>
      wallLabels(value).map((label) => `Now ${label}`),
    );
    const text = await readNowText(page);
    return accepted.some((label) => text.startsWith(label)) ? text : false;
  };
  if (paused) {
    let text = '';
    await advanceUntil(
      page,
      async () => {
        text = (await read()) || '';
        return text !== '';
      },
      'The current-time marker must match the paused clock.',
    );
    return text;
  }
  return poll(read, 'The current-time marker must match the page clock.');
}

/** Calm-copy audit of a page region (`main` or a dialog). */
async function auditCopy(scope, label) {
  const text = await scope.innerText();
  const found = forbiddenCopy(text);
  assert(found.length === 0, `${label} uses forbidden wording: ${found.join(', ')}.`);
  // product contract: counts only, never a score, percentage, or ratio.
  assert(!/\d\s?%/u.test(text), `${label} shows a percentage.`);
}

/** Actions capture, optionally placed on a day. */
async function capture(page, title, { plannedDate } = {}) {
  await page.getByRole('button', { name: /Capture Alt C/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to Inbox' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill(title);
  if (plannedDate !== undefined) {
    const details = dialog.locator('details.expanded-fields');
    if (!(await details.evaluate((element) => element.open)))
      await dialog.getByText('More details').click();
    await dialog.getByLabel('Planned date').fill(plannedDate);
  }
  await dialog.getByRole('button', { name: 'Capture', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/** label: flexible "Schedule…" (§5.3) opening the planning Schedule dialog. */
async function scheduleFromFlexible(page, title, { date, start, duration }) {
  const row = rowOf(flexibleList(page), title);
  await press(page, row.getByRole('button', { name: /^Schedule…/u }));
  const dialog = page.getByRole('dialog', { name: `Schedule “${title}”` });
  await dialog.waitFor();
  await dialog.getByLabel('Date').fill(date);
  await dialog.getByLabel('Start time').fill(start);
  await dialog.getByLabel('Duration (minutes)').fill(duration);
  await dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await row.waitFor({ state: 'detached' });
}

/** planning routine form. */
async function createRoutine(j, page, { title, pattern, timesPerWeek, time, duration }) {
  await page.goto(`${j.origin}/plan/routines`, { waitUntil: 'networkidle' });
  await heading1(page, 'Routines');
  await page.getByRole('button', { name: 'New routine' }).click();
  const dialog = page.getByRole('dialog', { name: 'New routine' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill(title);
  await dialog.getByLabel(pattern, { exact: true }).check();
  if (timesPerWeek !== undefined)
    await dialog.getByLabel(/^Times per week/u).fill(String(timesPerWeek));
  await dialog.getByLabel(/^Starts on/u).fill(DAY);
  if (time !== undefined) {
    await dialog.getByLabel('At a set time').check();
    await dialog.getByLabel('Time', { exact: true }).fill(time);
    await dialog.getByLabel(/^Duration/u).fill(String(duration));
  } else if (timesPerWeek === undefined) {
    await dialog.getByLabel('Any time that day').check();
  }
  await dialog.getByRole('button', { name: 'Create routine' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('Routine created.').first().waitFor();
}

/** In-app navigation from live today to an earlier selected date (a fresh load drops `?date`). */
async function openEarlierDay(j, page, date, liveDate) {
  let current = liveDate;
  while (current > date) {
    await dayLink(page, 'Previous day').click();
    current = addDays(current, -1);
    await page.waitForURL(`${j.origin}/?date=${current}`);
    await heading1(page, longDate(current));
  }
}

/* ───────────────────────── 1. Onboarding and fresh launch ───────────────────────── */

async function verifyFreshLaunch(j, page, seen) {
  await completeMinimalOnboarding(page);
  await page.waitForURL(`${j.origin}/`);
  await settle(page);
  await heading1(page, LIVE_H1);
  await assertSingleH1(page, 'Today');
  await eyebrow(page, 'Today', DAY).waitFor();
  // label: Focus help text (§5.4)
  await section(page, 'Focus')
    .getByText('Up to three things you chose for this day. The order is yours.', { exact: true })
    .waitFor();
  await expectListOrder(focusList(page), [T.onboarding], 'Focus after onboarding');
  const flexible = flexibleList(page);
  await rowOf(flexible, T.onboarding)
    .getByRole('link', { name: T.onboarding, exact: true })
    .waitFor();
  ids.onboarding = await idFromLink(flexible, T.onboarding);
  // the onboarding card, direction strip, and placeholder copy left Today.
  assert(
    (await page.getByText('First Action', { exact: true }).count()) === 0,
    'Today must not show the onboarding "First Action" card.',
  );
  assert(
    (await page.getByText(/arrive in P1\.7/u).count()) === 0,
    'Today must not keep the alignment placeholder copy.',
  );
  const current = await dayLink(page, 'Today').getAttribute('aria-current');
  assert(current !== null && current !== 'false', 'Live Today must mark "Today" as current.');
  assert(
    seen.externalRequests.length === 0 && seen.browserErrors.length === 0,
    'The first launch must make no external request and log no error.',
  );
  await j.shot(page, 'today-onboarded-1280x800');
  j.checks.push(
    'fresh Today after onboarding: one h1, the onboarding Action is focus item 1 and flexible, no onboarding card',
  );
}

/* ───────────────────────── 2. Empty day ───────────────────────── */

async function verifyEmptyDay(j, page) {
  await dayLink(page, 'Next day').click();
  await page.waitForURL(`${j.origin}/?date=${NEXT_DAY}`);
  // label: a selected date's h1 is its long date; banner "You are viewing {long date}." (§5.2)
  await heading1(page, longDate(NEXT_DAY));
  await assertSingleH1(page, 'Selected day');
  await eyebrow(page, 'Tomorrow', NEXT_DAY).waitFor();
  await page.getByText(`You are viewing ${longDate(NEXT_DAY)}.`, { exact: true }).waitFor();
  // label: intentional-empty copy and "Choose focus…" (§5.3)
  await page.getByText('Your day is clear.', { exact: true }).waitFor();
  await page
    .getByText('Choose one focus item or leave space intentionally.', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Choose focus…', exact: true }).first().waitFor();
  const current = await dayLink(page, 'Today').getAttribute('aria-current');
  assert(current === null || current === 'false', 'A selected day must not mark "Today" current.');
  assert(
    (await page.getByTestId('timeline-now').count()) === 0,
    'The current-time marker shows only on live today.',
  );
  await auditCopy(main(page), 'Empty selected day');
  await j.shot(page, 'today-empty-selected-1280x800');

  await dayLink(page, 'Today').click();
  await page.waitForURL(`${j.origin}/`);
  await heading1(page, LIVE_H1);
  // In-app Back keeps the selected date .
  await page.goBack();
  await page.waitForURL(`${j.origin}/?date=${NEXT_DAY}`);
  await heading1(page, longDate(NEXT_DAY));
  // label: "Back to today" (§5.2)
  await page.locator('main').getByText('Back to today', { exact: true }).first().click();
  await page.waitForURL(`${j.origin}/`);
  await heading1(page, LIVE_H1);
  j.checks.push(
    'Next day opens /?date= with the intentional-empty copy and "Choose focus…"; Today and Back to today return to /; Back restores the date',
  );
}

/* ───────────────────────── 3. Seed the day ───────────────────────── */

async function seedDay(j, page) {
  for (const title of [T.water, T.seeds, T.plumber])
    await capture(page, title, { plannedDate: DAY });
  await page.goto(`${j.origin}/`, { waitUntil: 'networkidle' });
  await settle(page);
  const flexible = flexibleList(page);
  for (const title of [T.onboarding, T.water, T.seeds, T.plumber])
    await rowOf(flexible, title).getByRole('link', { name: title, exact: true }).waitFor();
  ids.water = await idFromLink(flexible, T.water);
  ids.seeds = await idFromLink(flexible, T.seeds);
  ids.plumber = await idFromLink(flexible, T.plumber);

  // An explicit duration, from Today's flexible list.
  await scheduleFromFlexible(page, T.plumber, { date: DAY, start: '15:00', duration: '60' });
  await timeline(page).getByRole('link', { name: T.plumber, exact: true }).waitFor();

  // A custom block that overlaps it; saving needs the explicit "Keep this overlap" (planning Plan Day).
  await page.goto(`${j.origin}/plan/day/${DAY}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add time block' }).first().click();
  const block = page.getByRole('dialog', { name: 'Add a time block' });
  await block.waitFor();
  await block.locator('#custom-block-title').fill(T.visit);
  await block.getByLabel('Date').fill(DAY);
  await block.getByLabel('Start time').fill('15:30');
  await block.getByLabel('Duration (minutes)').fill('30');
  await block.getByRole('button', { name: 'Add time block' }).click();
  await block
    .getByText(/Choose Keep this overlap/u)
    .first()
    .waitFor();
  await block.getByLabel(/Keep this overlap/u).check();
  await block.getByRole('button', { name: 'Add time block' }).click();
  await block.waitFor({ state: 'hidden' });
  await page.getByText('Time block added.').first().waitFor();

  await createRoutine(j, page, { title: T.stretch, pattern: 'Every N days' });
  await createRoutine(j, page, {
    title: T.walk,
    pattern: 'A number of times per week',
    timesPerWeek: 3,
  });
  // Routines never ask to acknowledge overlaps, so this one leaves an open overlap for step 6.
  await createRoutine(j, page, {
    title: T.tea,
    pattern: 'Every N days',
    time: '15:15',
    duration: 15,
  });

  await page.goto(`${j.origin}/`, { waitUntil: 'networkidle' });
  await settle(page);
  for (const title of [T.plumber, T.visit, T.tea]) await entryCard(page, title).first().waitFor();
  const routines = section(page, 'Routines');
  await routines.getByText(T.stretch, { exact: false }).first().waitFor();
  await routines.getByText(T.walk, { exact: false }).first().waitFor();
  // planning weekly-count status text in the "This week" subgroup (label: §5.3).
  await routines.getByText('0 of 3 this week').first().waitFor();
  await j.shot(page, 'today-seeded-1280x800');
  j.checks.push(
    'seeded through the UI: three captured Actions placed today, one scheduled with an explicit duration, a kept overlap, and three Routines',
  );
}

/* ───────────────────────── 4. Focus ───────────────────────── */

async function verifyFocus(j, page) {
  const focus = focusList(page);
  const focusSection = section(page, 'Focus');
  // Start from an empty day focus so "nothing preselected" is literal.
  await press(page, removeFromFocus(focus, T.onboarding));
  // label: empty strip "No focus chosen." (§5.4)
  await focusSection.getByText('No focus chosen.', { exact: true }).waitFor();
  await expectHeadingFocus(page, 'Removing the only focus item');
  await rowOf(flexibleList(page), T.onboarding).waitFor();

  await focusSection.getByRole('button', { name: 'Choose focus…', exact: true }).click();
  // label: dialog "Choose focus for {weekday, date}", fieldsets, "N of 3 chosen", reason (§5.4)
  const dialog = page.getByRole('dialog', { name: /^Choose focus for /u });
  await dialog.waitFor();
  const group = (name) => dialog.getByRole('group', { name, exact: true });
  const water = group('Flexible').getByRole('checkbox', { name: titled(T.water) });
  const plumber = group('Scheduled').getByRole('checkbox', { name: titled(T.plumber) });
  const stretch = group('Routines').getByRole('checkbox', { name: titled(T.stretch) });
  const fourth = group('Flexible').getByRole('checkbox', { name: titled(T.seeds) });
  for (const box of [water, plumber, stretch, fourth]) await box.waitFor();
  assert(
    (await dialog.getByRole('checkbox', { checked: true }).count()) === 0,
    'Choose focus must not preselect anything.',
  );
  assert(
    !/suggest|recommend/iu.test(await dialog.innerText()),
    'Choose focus must not suggest or recommend.',
  );
  await water.check();
  await plumber.check();
  await stretch.check();
  await dialog.getByText('3 of 3 chosen').first().waitFor();
  assert(
    (await fourth.getAttribute('aria-disabled')) === 'true',
    'A fourth choice must be aria-disabled.',
  );
  assert(
    (await accessibleDescription(fourth)).includes(
      'Three items chosen. Clear one to choose another.',
    ),
    'A fourth choice must be described by its reason.',
  );
  await fourth.click({ force: true });
  assert(!(await fourth.isChecked()), 'A fourth choice must stay unchosen.');
  await auditCopy(dialog, 'Choose focus');
  await j.shot(page, 'choose-focus-full-1280x800');
  await dialog.getByRole('button', { name: 'Save focus', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });

  const chosen = [T.water, T.plumber, T.stretch];
  await poll(
    async () => (await focus.locator(':scope > li').count()) === 3,
    'Focus must hold the three chosen items.',
  );
  const order = await listOrder(focus, chosen);
  assert(
    [...order].sort().join('|') === [...chosen].sort().join('|'),
    `Focus holds unexpected items: ${order.join(', ')}`,
  );
  // label: state/timing pills "Scheduled {start}–{end}" and "Flexible" (§5.4)
  await rowOf(focus, T.plumber)
    .getByText(new RegExp(`^Scheduled ${clock(15)}`, 'u'))
    .first()
    .waitFor();
  await rowOf(focus, T.water).getByText('Flexible', { exact: true }).first().waitFor();
  j.checks.push(
    'Choose focus: nothing preselected, no suggestions, the fourth choice aria-disabled with its reason, saved in one command',
  );

  // Keyboard reorder; focus stays with the moved item, and the order survives a reload.
  const [first, second, third] = order;
  await tabTo(page, moveButton(focus, first, 'down'));
  await page.keyboard.press('Enter');
  await expectListOrder(focus, [second, first, third], 'Focus after Move down');
  await waitForFocus(page, rowOf(focus, first), {
    within: true,
    label: 'After a keyboard reorder, focus must stay with the moved item',
  });
  // label: announcement "{title} moved to position 2 of 3." (§5.4)
  await page.getByText(`${first} moved to position 2 of 3.`).first().waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await settle(page);
  await expectListOrder(focus, [second, first, third], 'Focus after reload');
  j.checks.push('focus reorder by keyboard keeps focus on the item and persists after reload');

  // Remove, then Undo.
  await press(page, removeFromFocus(focus, third));
  await expectListOrder(focus, [second, first], 'Focus after Remove');
  await expectHeadingFocus(page, 'Remove from focus');
  await undo(page).click();
  await expectListOrder(focus, [second, first, third], 'Focus after Undo');
  ids.focusOrder = [second, first, third];
  j.checks.push('Remove from focus with Undo restores the three items in order');

  // Add to focus on a fourth item stays focusable, aria-disabled, and says why (label: §5.4).
  const flexible = flexibleList(page);
  const seedsRow = rowOf(flexible, T.seeds);
  await openMoreOptions(seedsRow);
  const addSeeds = seedsRow.getByRole('button', { name: /^Add to focus/u });
  await addSeeds.waitFor();
  assert(
    (await addSeeds.getAttribute('aria-disabled')) === 'true',
    'Add to focus must be aria-disabled when the day is full.',
  );
  assert(
    (await accessibleDescription(addSeeds)).includes(
      "This day's focus has three items. Remove one first.",
    ),
    'A full day must explain why Add to focus is unavailable.',
  );
  const waterRow = rowOf(flexible, T.water);
  await openMoreOptions(waterRow);
  const addWater = waterRow.getByRole('button', { name: /^Add to focus/u });
  assert(
    (await addWater.getAttribute('aria-disabled')) === 'true' &&
      (await accessibleDescription(addWater)).includes('Already in focus'),
    'An item already in focus must say "Already in focus".',
  );
  await j.shot(page, 'today-focus-full-1280x800');
  j.checks.push(
    'Add to focus on a fourth item is aria-disabled with its reason; "Already in focus"',
  );
}

/* ───────────────────────── 5. Flexible list ───────────────────────── */

async function verifyFlexible(j, page) {
  const flexible = flexibleList(page);
  const before = await listOrder(flexible, [T.onboarding, T.water, T.seeds]);
  assert(before.length === 3, `Flexible must hold three Actions: ${before.join(', ')}`);
  const moving = before[1];
  await flexible.getByRole('button', { name: `Move ${moving} up`, exact: true }).click();
  await expectListOrder(flexible, [before[1], before[0], before[2]], 'Flexible after Move up');
  await flexible.getByRole('button', { name: `Move ${moving} down`, exact: true }).click();
  await expectListOrder(flexible, before, 'Flexible after Move down');
  j.checks.push('flexible Move up and Move down reorder only within the open list');

  // label: row "Complete", Done group "Done today (N)" (§5.3)
  await press(page, rowOf(flexible, T.water).getByRole('button', { name: /^Complete(?:$|\s)/u }));
  const done = page.locator('main summary').filter({ hasText: /Done today \(1\)/u });
  await done.waitFor();
  await rowOf(flexible, T.water).waitFor({ state: 'detached' });
  await expectHeadingFocus(page, 'Complete from the flexible list');
  // A finished focus target stays in focus with its state as text (label: pill "Completed").
  await rowOf(focusList(page), T.water).getByText('Completed', { exact: true }).first().waitFor();
  await auditCopy(main(page), 'Today with a completed Action');
  await undo(page).click();
  await rowOf(flexible, T.water).waitFor();
  await done.waitFor({ state: 'detached' });
  j.checks.push('Complete moves the Action to "Done today (1)" with Undo; focus lands on the h1');

  await scheduleFromFlexible(page, T.seeds, { date: DAY, start: '11:00', duration: '30' });
  await timeline(page).getByRole('link', { name: T.seeds, exact: true }).waitFor();
  await expectHeadingFocus(page, 'Schedule from the flexible list');
  j.checks.push('Schedule… moves a flexible Action into the timeline');

  // label: "More options" → "Move to…" opening the planning Place dialog (§5.3)
  const onboardingRow = rowOf(flexible, T.onboarding);
  await openMoreOptions(onboardingRow);
  await press(page, onboardingRow.getByRole('button', { name: /^Move to…/u }));
  const place = page.getByRole('dialog', { name: titled(T.onboarding) });
  await place.waitFor();
  await place.getByLabel('A week', { exact: true }).check();
  await place.getByLabel('Any date in the week').fill(NEXT_WEEK);
  await place
    .getByText(/will be placed/u)
    .first()
    .waitFor();
  await place.getByRole('button', { name: 'Place', exact: true }).click();
  await place.waitFor({ state: 'hidden' });
  await onboardingRow.waitFor({ state: 'detached' });
  await expectHeadingFocus(page, 'Move to next week');
  await expectListOrder(flexible, [T.water], 'Flexible after scheduling and moving');
  j.checks.push('Move to… places a flexible Action in next week and it leaves Today');
}

/* ───────────────────────── 6. Timeline ───────────────────────── */

async function verifyTimeline(j, page) {
  // planning ConflictsPanel: a section labelled "Overlaps".
  const overlaps = page.getByRole('region', { name: 'Overlaps', exact: true });
  const item = overlaps.locator('.conflict-item').filter({ hasText: T.tea });
  await item.waitFor();
  for (const choice of [/^Move…/u, /^Shorten…/u, /^Cancel…/u, /^Keep overlap…/u])
    await item.getByRole('button', { name: choice }).first().waitFor();
  await item
    .getByText(/^Overlap on /u)
    .first()
    .waitFor();
  await overlaps.locator('.kept-list').getByText(titled(T.visit)).first().waitFor();
  await j.shot(page, 'today-overlap-1280x800');
  await press(page, item.getByRole('button', { name: /^Keep overlap…/u }));
  const keep = page.getByRole('dialog', { name: 'Keep this overlap?' });
  await keep.getByRole('button', { name: 'Keep overlap', exact: true }).click();
  await keep.waitFor({ state: 'hidden' });
  await item.waitFor({ state: 'detached' });
  await overlaps.getByText('No overlaps to review.').waitFor();
  await expectHeadingFocus(page, 'Keep overlap');
  j.checks.push(
    'overlap panel offers Move, Shorten, Cancel, and Keep overlap; nothing is chosen for the user',
  );

  // A Routine occurrence: Skip reads a neutral "Skipped"; then Reopen and Complete (planning controls).
  const tea = entryCard(page, T.tea);
  await openDetails(tea);
  await tea.getByRole('button', { name: /^Skip\b/u }).click();
  await tea.getByText('Skipped', { exact: true }).first().waitFor();
  const teaText = await tea.innerText();
  assert(forbiddenCopy(teaText).length === 0, `A skipped occurrence reads calmly: ${teaText}`);
  await openDetails(tea);
  await tea.getByRole('button', { name: /^Reopen\b/u }).click();
  await tea.getByText('Planned', { exact: true }).first().waitFor();
  await openDetails(tea);
  await tea.getByRole('button', { name: /^Complete\b/u }).click();
  await tea.getByText('Completed', { exact: true }).first().waitFor();
  j.checks.push('occurrence Skip shows a neutral "Skipped"; Reopen and Complete affect only it');

  const marker = await expectNowMarker(page);
  assert(/^Now 0?9:/u.test(marker), `The marker must read the morning time: ${marker}`);
  await j.shot(page, 'today-timeline-1280x800');
  j.checks.push(`current-time marker "${marker}" matches the page clock; data-testid=timeline-now`);
}

/* ───────────────────────── 7. Focus mode ───────────────────────── */

async function verifyFocusMode(j, page, seen) {
  // label: focus item "Focus mode" button (§5.4); page eyebrow "Focus", h1 the Action title (§5.5)
  await rowOf(focusList(page), T.plumber)
    .getByRole('link', { name: /^Focus mode/u })
    .click();
  await page.waitForURL(new RegExp(`/focus/${ids.plumber}$`, 'u'));
  await heading1(page, T.plumber);
  await assertSingleH1(page, 'Focus mode');
  await page.locator('main').getByText('Focus', { exact: true }).first().waitFor();
  const facts = page.locator('main dl').first();
  await facts.waitFor();
  await facts
    .getByText(new RegExp(clock(15), 'u'))
    .first()
    .waitFor();
  j.checks.push("Focus mode shows the Action with its context and today's planned time");

  // label: h2 "Timer (optional)", presets, Start/Pause/Resume timer, role=timer text (§5.5)
  await page.getByRole('heading', { level: 2, name: 'Timer (optional)', exact: true }).waitFor();
  await page.getByRole('radio', { name: /^25 minutes/u }).check();
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  const timer = page.getByRole('timer');
  const reading = async () => ((await timer.textContent()) ?? '').replace(/\s+/gu, ' ').trim();
  await poll(
    async () => /^(?:25:00|24:[0-5]\d) remaining$/u.test(await reading()),
    'A 25-minute timer must start.',
  );
  await page.clock.fastForward('10:00');
  await poll(
    async () => /^(?:15:00|14:[0-5]\d) remaining$/u.test(await reading()),
    'Ten minutes later about 15:00 must remain.',
  );
  await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
  await page.getByRole('button', { name: 'Resume timer', exact: true }).waitFor();
  const paused = await reading();
  await page.clock.fastForward('05:00');
  await sleep(300);
  assert((await reading()) === paused, `A paused timer must not move (${paused}).`);
  j.checks.push('timer: 25 minutes, about 15:00 left after 10 minutes, unchanged while paused');

  // A hidden page: resume, run past zero, show again. Count polite announcements of time-up.
  await page.evaluate(() => {
    const state = { count: 0, seen: new WeakSet() };
    window.__todayTimeUp = state;
    const scan = () => {
      for (const region of document.querySelectorAll(
        '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]',
      )) {
        const says = (region.textContent ?? '').includes('Time is up');
        if (says && !state.seen.has(region)) {
          state.count += 1;
          state.seen.add(region);
        }
        if (!says) state.seen.delete(region);
      }
    };
    new MutationObserver(scan).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await setDocumentVisibility(page, 'hidden');
  await page.getByRole('button', { name: 'Resume timer', exact: true }).click();
  await page.clock.fastForward('20:00');
  await setDocumentVisibility(page, 'visible');
  // label: "Time is up. Continue, pause, or complete when you are ready." (§5.5)
  await page
    .getByText(/^Time is up\./u)
    .first()
    .waitFor();
  await page.clock.fastForward('01:00');
  await sleep(300);
  const announcements = await page.evaluate(() => window.__todayTimeUp.count);
  assert(announcements === 1, `Time-up must be announced once (${String(announcements)}).`);
  await page.getByRole('button', { name: /^Complete…/u }).waitFor();
  j.checks.push('a hidden page keeps timing; "Time is up" is announced once and changes nothing');

  // label: "Complete…" dialog "Complete {title}?" with "Complete Action only" (§5.5)
  await page.getByRole('button', { name: /^Complete…/u }).click();
  const complete = page.getByRole('dialog', { name: /^Complete .*\?$/u });
  await complete.waitFor();
  await complete.getByText('Its time block stays planned.').first().waitFor();
  await complete.getByRole('button', { name: 'Complete Action and its time block' }).waitFor();
  await complete.getByRole('button', { name: 'Complete Action only', exact: true }).click();
  await complete.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^Complete…/u }).waitFor({ state: 'detached' });
  await undo(page).click();
  await page.getByRole('button', { name: /^Complete…/u }).waitFor();
  await auditCopy(main(page), 'Focus mode');
  j.checks.push('Complete… → Complete Action only → Undo; the copy audit passes');

  // label: "Exit focus" (§5.5): no confirmation, nothing recorded.
  const dialogsBefore = seen.dialogs.length;
  await control(page, 'Exit focus').click();
  await page.waitForURL(`${j.origin}/`);
  await settle(page);
  await heading1(page, LIVE_H1);
  assert(seen.dialogs.length === dialogsBefore, 'Exit focus must not open a browser dialog.');
  assert((await page.locator('dialog[open]').count()) === 0, 'Exit focus must not open a dialog.');
  await rowOf(focusList(page), T.plumber)
    .getByText(/^Scheduled/u)
    .first()
    .waitFor();
  await auditCopy(main(page), 'Today');
  j.checks.push('Exit focus returns to Today with no dialog; the Action is unchanged');
}

/* ───────────────────────── 8. Midnight ───────────────────────── */

async function verifyMidnight(j, page) {
  await page.clock.pauseAt(BEFORE_MIDNIGHT);
  await page.goto(`${j.origin}/`, { waitUntil: 'domcontentloaded' });
  await advanceUntil(
    page,
    () => pausedTodayReady(page),
    'Today must open while the clock is paused.',
  );
  await advanceUntil(
    page,
    () => visible(eyebrow(page, 'Today', DAY)),
    'Before midnight Today shows September 28.',
  );
  const before = await expectNowMarker(page, { paused: true });
  assert(
    new RegExp(`^Now ${clock(23, 59)}`, 'u').test(before),
    `Before midnight the marker reads 11:59 PM: ${before}`,
  );

  await page.clock.runFor(AFTER_MIDNIGHT.getTime() - (await pageNow(page)));
  await advanceUntil(
    page,
    () => visible(eyebrow(page, 'Today', NEXT_DAY)),
    'After midnight live Today must show September 29.',
  );
  // label: "A new day started. Today now shows {weekday, date}." (§5.2)
  await page
    .getByText(/^A new day started\. Today now shows /u)
    .first()
    .waitFor();
  const after = await expectNowMarker(page, { paused: true });
  assert(
    new RegExp(`^Now ${clock(0)}`, 'u').test(after),
    `After midnight the marker reads 12:00 AM: ${after}`,
  );
  // Early hours are shown when now is before 06:00 (planning hour labels).
  await timeline(page)
    .locator('.timeline-hour-label')
    .filter({ hasText: new RegExp(`^${clock(0)}$`, 'u') })
    .first()
    .waitFor();
  await j.shot(page, 'today-after-midnight-1280x800');
  j.checks.push(
    'midnight rollover without a reload: live Today moves to September 29, announces the new day, marker 12:00 AM with early hours',
  );

  // A selected date never rolls over; Back and Forward restore both views.
  await dayLink(page, 'Previous day').click();
  await page.waitForURL(`${j.origin}/?date=${DAY}`);
  await advanceUntil(
    page,
    () => visible(page.getByText(`You are viewing ${longDate(DAY)}.`, { exact: true })),
    'Previous day must show the September 28 banner.',
  );
  assert(
    (await page.getByTestId('timeline-now').count()) === 0,
    'A selected day shows no current-time marker.',
  );
  await page.clock.runFor(60_000);
  await sleep(300);
  assert(page.url() === `${j.origin}/?date=${DAY}`, 'A selected date must not roll over.');
  await heading1(page, longDate(DAY));
  await page.goBack();
  await page.waitForURL(`${j.origin}/`);
  await advanceUntil(
    page,
    () => visible(eyebrow(page, 'Today', NEXT_DAY)),
    'Back must restore live Today.',
  );
  await page.goForward();
  await page.waitForURL(`${j.origin}/?date=${DAY}`);
  await advanceUntil(
    page,
    () => visible(page.getByText(`You are viewing ${longDate(DAY)}.`, { exact: true })),
    'Forward must restore the selected date.',
  );
  // A reload is a fresh entry: it drops ?date and opens live today.
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The page clock is paused here, and opening the database after a reload waits on timers (the
  // previous document's lock can take a moment to release in Firefox): let fake time pass.
  await advanceUntil(
    page,
    async () => page.url() === `${j.origin}/`,
    'A reload on /?date= must open /.',
  );
  await advanceUntil(
    page,
    () => visible(eyebrow(page, 'Today', NEXT_DAY)),
    'A reload must open live today.',
  );
  j.checks.push(
    'a selected date stays put across the minute boundary; Back/Forward restore both; reload on /?date= opens live /',
  );
}

/* ───────────────────────── 9. Foreground resume and clock change ───────────────────────── */

async function verifyResumeAndClockChange(j, page) {
  await page.evaluate(() => {
    window.__todaySameDocument = true;
  });
  const shown = await expectNowMarker(page, { paused: true });
  await setDocumentVisibility(page, 'hidden');
  await page.clock.fastForward('08:00:00');
  await sleep(300);
  // verification contract: the minute timer is cleared while hidden, so the marker text stays as it was.
  const whileHidden = await readNowText(page);
  assert(whileHidden === shown, `The clock must not tick while hidden (${whileHidden}).`);
  await setDocumentVisibility(page, 'visible');
  const resumed = await expectNowMarker(page, { paused: true });
  assert(/^Now 0?8:0/u.test(resumed), `Showing the page must refresh the marker: ${resumed}`);
  await eyebrow(page, 'Today', NEXT_DAY).waitFor();
  assert(
    await page.evaluate(() => window.__todaySameDocument === true),
    'Foreground resume must refresh without a reload.',
  );
  j.checks.push('hidden page: no ticking; visible again: the marker refreshes without a reload');

  await page.clock.setSystemTime(CLOCK_CHANGE);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await advanceUntil(
    page,
    () => visible(eyebrow(page, 'Today', LATER_DAY)),
    'A clock change must refresh live Today on focus.',
  );
  const changed = await expectNowMarker(page, { paused: true });
  assert(
    new RegExp(`^Now ${clock(8)}`, 'u').test(changed),
    `After the clock change the marker reads 8:00 AM: ${changed}`,
  );
  assert(
    await page.evaluate(() => window.__todaySameDocument === true),
    'A clock change must refresh without a reload.',
  );
  await page.clock.resume();
  j.checks.push('a system clock change is picked up on focus: September 30, marker 8:00 AM');
}

/* ───────────────────────── 10. End Day ───────────────────────── */

/** The fieldset of one open item (label: legend = title, §5.6). */
function endDayItem(page, title) {
  return section(page, 'Still open').getByRole('group', { name: title, exact: true });
}

async function chooseEndDayDecisions(page) {
  for (const title of [T.water, T.plumber, T.seeds, T.stretch]) {
    const item = endDayItem(page, title);
    await item.waitFor();
    // label: every item defaults to "Decide later" (§5.6)
    assert(
      await item.getByRole('radio', { name: 'Decide later', exact: true }).isChecked(),
      `${title} must default to "Decide later".`,
    );
  }
  assert(
    (await endDayItem(page, T.tea).count()) === 0,
    'A completed occurrence is not listed as open.',
  );
  // label: "Carry all open Actions to {date}" only sets the radios (§5.6)
  await page.getByRole('button', { name: /^Carry all open Actions to /u }).click();
  await page
    .getByText(/^3 Actions set to carry\. Nothing is saved yet\.$/u)
    .first()
    .waitFor();
  for (const title of [T.water, T.plumber, T.seeds])
    assert(
      await endDayItem(page, title)
        .getByRole('radio', { name: /^Carry to /u })
        .isChecked(),
      `${title} must be set to carry.`,
    );

  // label: "Move to…" reveals A day / A week / A month with Date, Any date in the week, Month (§5.6)
  const plumber = endDayItem(page, T.plumber);
  await plumber.getByRole('radio', { name: 'Move to…', exact: true }).check();
  await plumber.getByRole('radio', { name: 'A week', exact: true }).check();
  await plumber.getByLabel('Any date in the week', { exact: true }).fill(NEXT_WEEK);
  await plumber
    .getByText(/marks its .*time block skipped/u)
    .first()
    .waitFor();
  await endDayItem(page, T.seeds).getByRole('radio', { name: 'Cancel', exact: true }).check();
  await endDayItem(page, T.stretch).getByRole('radio', { name: 'Skip', exact: true }).check();

  // label: section h2 "Focus for {weekday, date}" with the FocusDraftEditor (§5.6)
  const next = page
    .getByRole('heading', { level: 2, name: /^Focus for /u })
    .locator('xpath=ancestor::section[1]');
  await next
    .getByRole('checkbox', { name: titled(T.water) })
    .first()
    .check();
  await next
    .getByRole('checkbox', { name: titled(T.stretch) })
    .first()
    .check();
  await next.getByText('2 of 3 chosen').first().waitFor();
}

async function applyEndDay(page) {
  // label: "Finish review" (Reviews daily review; Today "Apply choices"), then a status summary with
  // Undo and "Back to Today" (§5.6)
  await page.getByRole('button', { name: 'Finish review', exact: true }).click();
  await control(page, 'Back to Today').waitFor();
  await undo(page).waitFor();
}

async function verifyEndDay(j, page) {
  await page.goto(`${j.origin}/`, { waitUntil: 'networkidle' });
  await settle(page);
  await eyebrow(page, 'Today', LATER_DAY).waitFor();
  await openEarlierDay(j, page, DAY, LATER_DAY);
  await eyebrow(page, 'Earlier day', DAY).waitFor();
  // label: header "End day…" link when D ≤ today (§5.3)
  await page.getByRole('link', { name: 'End day…', exact: true }).first().click();
  await page.waitForURL(`${j.origin}/end-day/${DAY}`);
  await settle(page);
  // label: h1 "End day", eyebrow long date, intro (§5.6)
  await heading1(page, 'End day');
  await assertSingleH1(page, 'End Day');
  await page.locator('main').getByText(longDate(DAY), { exact: true }).first().waitFor();
  // Reviews: End Day is the daily review ; its intro names Finish review.
  await page
    .getByText(
      'A short look back. Decide what happens next for anything still open. Nothing changes until you finish the review.',
      { exact: true },
    )
    .waitFor();
  await section(page, 'Done').getByText(T.tea).first().waitFor();
  // Reviews adds the optional energy note ; nothing is noted yet.
  const energy = page.getByRole('group', { name: 'How was your energy?' });
  await energy.waitFor();
  assert(
    await energy.getByRole('radio', { name: 'Not noted', exact: true }).isChecked(),
    'The daily review starts with no energy noted.',
  );
  await chooseEndDayDecisions(page);
  await auditCopy(main(page), 'End Day');
  await j.shot(page, 'end-day-choices-1280x800');
  await applyEndDay(page);
  await j.shot(page, 'end-day-applied-1280x800');

  // An Action captured after apply survives the grouped Undo.
  await capture(page, T.twine);
  await undo(page).click();
  // The runner announces only after the undo command commits; the checks below re-read the plan
  // from fresh pages, so no re-query of this page can race them.
  await page.getByText('Your End day choices were undone.').first().waitFor();
  await page.goto(`${j.origin}/`, { waitUntil: 'networkidle' });
  await settle(page);
  await eyebrow(page, 'Today', LATER_DAY).waitFor();
  await section(page, 'Focus').getByText('No focus chosen.', { exact: true }).waitFor();
  assert(
    (await rowOf(flexibleList(page), T.water).count()) === 0,
    'Undo must take the carried Action back off September 30.',
  );
  await openEarlierDay(j, page, DAY, LATER_DAY);
  await rowOf(flexibleList(page), T.water).waitFor();
  await entryCard(page, T.seeds).getByText('Planned', { exact: true }).first().waitFor();
  await entryCard(page, T.plumber).getByText('Planned', { exact: true }).first().waitFor();
  await expectListOrder(focusList(page), ids.focusOrder, 'September 28 focus after Undo');
  await page.goto(`${j.origin}/inbox`, { waitUntil: 'networkidle' });
  await page.getByRole('list', { name: 'Inbox Actions' }).getByText(T.twine).first().waitFor();
  j.checks.push(
    'End Day: Done list, Decide later default, Carry all, carry/move/cancel/skip, next-day focus; one Undo restores everything and keeps a later capture',
  );

  // Apply again and see the next day.
  await page.goto(`${j.origin}/end-day/${DAY}`, { waitUntil: 'networkidle' });
  await settle(page);
  await chooseEndDayDecisions(page);
  await applyEndDay(page);
  await control(page, 'Back to Today').click();
  await page.waitForURL(`${j.origin}/`);
  await settle(page);
  await eyebrow(page, 'Today', LATER_DAY).waitFor();
  await rowOf(flexibleList(page), T.water).waitFor();
  const nextFocus = await listOrder(focusList(page), [T.water, T.stretch]);
  assert(
    nextFocus.length === 2 && nextFocus.includes(T.water) && nextFocus.includes(T.stretch),
    `September 30 focus must hold the two chosen items: ${nextFocus.join(', ')}`,
  );
  ids.nextFocus = nextFocus;
  // The day under test now shows the decisions; its focus is read-only history.
  await openEarlierDay(j, page, DAY, LATER_DAY);
  // label: "Focus for an earlier day is kept as it was." (§5.4)
  await page.getByText('Focus for an earlier day is kept as it was.', { exact: true }).waitFor();
  assert(
    (await focusList(page)
      .getByRole('button', { name: /^Remove\b/u })
      .count()) === 0,
    'Past focus must be read-only.',
  );
  await entryCard(page, T.plumber).getByText('Skipped', { exact: true }).first().waitFor();
  assert(
    (await entryCard(page, T.seeds).count()) === 0,
    'A canceled time block leaves the timeline.',
  );
  assert(
    (await rowOf(flexibleList(page), T.water).count()) === 0,
    'The carried Action leaves the earlier day.',
  );
  await j.shot(page, 'today-earlier-day-after-end-day-1280x800');
  j.checks.push(
    'the carry day shows the carried Action and its focus; the earlier day shows skipped and canceled blocks and read-only focus',
  );
}

/* ───────────────────────── 11. Unsaved guard ───────────────────────── */

async function verifyUnsavedGuard(j, page) {
  await page.goto(`${j.origin}/`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('link', { name: 'End day…', exact: true }).first().click();
  await page.waitForURL(`${j.origin}/end-day/${LATER_DAY}`);
  await heading1(page, 'End day');
  const carry = endDayItem(page, T.water).getByRole('radio', { name: /^Carry to /u });
  await carry.check();
  await primaryToday(page).click();
  const leave = page.getByRole('dialog', { name: 'Save your changes before leaving?' });
  await leave.waitFor();
  for (const name of ['Save', 'Discard', 'Continue editing'])
    await leave.getByRole('button', { name, exact: true }).waitFor();
  await leave.getByRole('button', { name: 'Continue editing', exact: true }).click();
  await leave.waitFor({ state: 'hidden' });
  assert(
    new URL(page.url()).pathname === `/end-day/${LATER_DAY}`,
    'Continue editing must stay on End Day.',
  );
  assert(await carry.isChecked(), 'Continue editing must keep the choices.');
  await primaryToday(page).click();
  await leave.waitFor();
  await leave.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.waitForURL(`${j.origin}/`);
  await heading1(page, LIVE_H1);
  j.checks.push(
    'unsaved End Day choices offer Save, Discard, or Continue editing; Continue keeps them',
  );
}

/* ───────────────────────── 12. Offline and relaunch ───────────────────────── */

async function verifyPersistedToday(page, label) {
  await expectListOrder(focusList(page), ids.focusAfterOffline, `${label}: focus order`);
  await entryCard(page, T.water)
    .locator('.entry-time')
    .filter({ hasText: new RegExp(`^${clock(14)}`, 'u') })
    .waitFor();
  await entryCard(page, T.tea).getByText('Skipped', { exact: true }).first().waitFor();
}

async function verifyOfflineAndRelaunch(j, context, page, seen) {
  await page.goto(`${j.origin}/`, { waitUntil: 'networkidle' });
  await settle(page);
  if (!j.inFirefox) {
    await context.setOffline(true);
    // Chromium also proves the PWA shell reloads offline.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await heading1(page, LIVE_H1);
    await page.locator('.offline-banner').waitFor();
  }

  // A focus change.
  const focus = focusList(page);
  const [first, second] = ids.nextFocus;
  await press(page, moveButton(focus, first, 'down'));
  await expectListOrder(focus, [second, first], 'Focus after an offline reorder');
  ids.focusAfterOffline = [second, first];

  // A reschedule: schedule the carried Action, then move its block (planning Move dialog).
  await scheduleFromFlexible(page, T.water, { date: LATER_DAY, start: '13:00', duration: '30' });
  const card = entryCard(page, T.water);
  await card.waitFor();
  await openDetails(card);
  await card.getByRole('button', { name: /^Move…/u }).click();
  const move = page.getByRole('dialog', { name: `Move “${T.water}”` });
  await move.waitFor();
  await move.getByLabel('Start time').fill('14:00');
  await move.getByRole('button', { name: 'Move', exact: true }).click();
  await move.waitFor({ state: 'hidden' });
  await card
    .locator('.entry-time')
    .filter({ hasText: new RegExp(`^${clock(14)}`, 'u') })
    .waitFor();

  // End Day apply.
  await page.getByRole('link', { name: 'End day…', exact: true }).first().click();
  await page.waitForURL(`${j.origin}/end-day/${LATER_DAY}`);
  await heading1(page, 'End day');
  await endDayItem(page, T.tea).getByRole('radio', { name: 'Skip', exact: true }).check();
  await applyEndDay(page);
  if (!j.inFirefox) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await heading1(page, 'End day');
  }
  await primaryToday(page).click();
  await page.waitForURL(`${j.origin}/`);
  await settle(page);
  await verifyPersistedToday(page, j.inFirefox ? 'After the changes' : 'Offline');
  if (!j.inFirefox) {
    await context.setOffline(false);
    const cached = await assertStaticCaches(
      page,
      j.origin,
      Object.values(ids).filter((value) => typeof value === 'string'),
    );
    j.checks.push(
      `offline (Chromium): focus change, reschedule, and End Day apply, with offline reloads; ${String(cached)} cached URLs are static assets only`,
    );
  } else {
    j.checks.push('website use (Firefox): focus change, reschedule, and End Day apply');
  }

  await context.close();
  const next = await j.launch();
  const nextPage = await preparePage(j, next, RELAUNCH, seen);
  await nextPage.goto(`${j.origin}/`, { waitUntil: 'networkidle' });
  await settle(nextPage);
  await heading1(nextPage, LIVE_H1);
  await eyebrow(nextPage, 'Today', LATER_DAY).waitFor();
  await verifyPersistedToday(nextPage, 'After relaunch');
  j.checks.push('a relaunched browser opens live Today with every change kept');
  return { context: next, page: nextPage };
}

/* ───────────────────────── 13. Keyboard and semantics ───────────────────────── */

async function verifyKeyboardAndSemantics(j, page) {
  await capture(page, T.fence, { plannedDate: LATER_DAY });
  await page.goto(`${j.origin}/`, { waitUntil: 'networkidle' });
  await settle(page);
  await rowOf(flexibleList(page), T.fence).waitFor();

  // Tab order follows reading order: header and day nav, focus, timeline, flexible, routines.
  const ranks = {
    header: 0,
    'day nav': 0,
    Focus: 1,
    Overlaps: 2,
    Timeline: 3,
    Flexible: 4,
    Routines: 5,
    'End of day': 6,
  };
  await page.locator('main h1').focus();
  const visited = [];
  for (let presses = 0; presses < 250; presses += 1) {
    await page.keyboard.press('Tab');
    const region = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active.closest('main') === null) return null;
      if (active.closest('nav[aria-label="Day"]') !== null) return 'day nav';
      let name = 'header';
      for (const heading of document.querySelectorAll('main h2')) {
        if (heading.closest('dialog') !== null) continue;
        if (heading.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING)
          name = (heading.textContent ?? '').replace(/\s+/gu, ' ').trim();
      }
      return name;
    });
    if (region === null) break;
    if (visited.at(-1) !== region) visited.push(region);
    if (region === 'End of day') break;
  }
  const known = visited.filter((region) => region in ranks);
  for (let index = 1; index < known.length; index += 1)
    assert(
      ranks[known[index]] >= ranks[known[index - 1]],
      `Tab order must follow reading order: ${visited.join(' → ')}`,
    );
  for (const required of ['day nav', 'Focus', 'Timeline', 'Flexible', 'Routines'])
    assert(known.includes(required), `Tab never reached ${required}: ${visited.join(' → ')}`);
  j.checks.push(`Tab order: ${known.join(' → ')}`);

  // Escape closes a dialog and returns focus to its opener.
  const opener = rowOf(flexibleList(page), T.fence).getByRole('button', { name: /^Schedule…/u });
  await tabTo(page, opener);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: `Schedule “${T.fence}”` });
  await dialog.waitFor();
  await waitForFocus(page, dialog, { within: true, label: 'The dialog must take focus' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, opener, { label: 'Escape must return focus to the opener' });
  j.checks.push('Escape closes the Schedule dialog and returns focus to its opener');

  // The Today navigation item stays current on Focus mode and End Day.
  for (const path of [`/focus/${ids.water}`, `/end-day/${LATER_DAY}`, '/']) {
    await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
    await settle(page);
    assert(
      (await primaryToday(page).getAttribute('aria-current')) === 'page',
      `${path}: the Today navigation item must be current.`,
    );
    await assertSingleH1(page, path);
  }
  j.checks.push('the Today navigation item is aria-current on /, /focus/*, and /end-day/*');

  // Deep links fail calmly (label: §5.5, §5.6).
  for (const id of ['not-an-id', '00000000-0000-4000-8000-000000000000']) {
    await page.goto(`${j.origin}/focus/${id}`, { waitUntil: 'networkidle' });
    await page
      .getByRole('heading', { level: 1, name: /^This Action is unavailable\.?$/u })
      .waitFor();
    await assertSingleH1(page, `/focus/${id}`);
  }
  await page.goto(`${j.origin}/end-day/2026-10-02`, { waitUntil: 'networkidle' });
  await settle(page);
  await page
    .getByText('End day is available for today or earlier days.', { exact: true })
    .first()
    .waitFor();
  await assertSingleH1(page, 'End Day for a future date');
  j.checks.push('malformed and missing Focus ids and a future End Day date show calm states');
}

/* ───────────────────────── 14. Layouts and themes ───────────────────────── */

async function verifyLayouts(j, page) {
  const pages = [
    ['/', 'today'],
    [`/focus/${ids.water}`, 'focus-mode'],
    [`/end-day/${LATER_DAY}`, 'end-day'],
  ];
  for (const [width, height] of [
    [1024, 768],
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    for (const [path, label] of pages) {
      await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
      await settle(page);
      await assertNoOverflow(page, `${label} ${String(width)}x${String(height)}`);
      await assertTargets(page, `${label} ${String(width)}x${String(height)}`);
      await j.shot(page, `${label}-${String(width)}x${String(height)}`);
    }
  }
  j.checks.push(
    'Today, Focus mode, and End Day: no horizontal overflow and 44 px targets at 1024x768, 1280x800, 1440x900, and 1920x1080',
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [path, label] of pages) {
    await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
    await settle(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await assertNoOverflow(page, `${label} at 200% text`);
    await j.shot(page, `${label}-200-percent-text-1440x900`);
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('font-size');
    });
  }
  j.checks.push('Today, Focus mode, and End Day reflow at 200% text');

  for (const theme of ['Dark', 'Light']) {
    await page.goto(`${j.origin}/settings`, { waitUntil: 'networkidle' });
    await page.getByLabel(theme, { exact: true }).check();
    for (const [path, label] of pages) {
      await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
      await settle(page);
      await assertNoOverflow(page, `${label} ${theme}`);
      await j.shot(page, `${label}-${theme.toLowerCase()}-1440x900`);
    }
  }
  await page.goto(`${j.origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Use system appearance').check();
  await page.setViewportSize({ width: 1280, height: 800 });
  j.checks.push('dark and light themes on Today, Focus mode, and End Day');
}

/* ───────────────────────── 15. Motion ───────────────────────── */

async function verifyMotion(j, page) {
  await page.goto(`${j.origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Full', { exact: true }).check();
  await page.goto(`${j.origin}/`, { waitUntil: 'networkidle' });
  await settle(page);
  const longest = await page.locator('main *').evaluateAll((elements) =>
    Math.max(
      0,
      ...elements.flatMap((element) => {
        const style = getComputedStyle(element);
        return [style.transitionDuration, style.animationDuration].flatMap((value) =>
          value.split(',').map((part) => Number.parseFloat(part) || 0),
        );
      }),
    ),
  );
  assert(longest <= 0.2, `Full motion on Today stays within 200 ms (${String(longest)} s).`);
  const marker = page.getByTestId('timeline-now').first();
  if ((await marker.count()) > 0)
    assert(
      (await marker.evaluate(
        (element) => Number.parseFloat(getComputedStyle(element).transitionDuration) || 0,
      )) === 0,
      'The current-time marker never transitions.',
    );
  j.checks.push(
    'full motion: nothing on Today moves for longer than 200 ms; the marker never transitions',
  );

  await page.goto(`${j.origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Reduced', { exact: true }).check();
  for (const path of ['/', `/focus/${ids.water}`, `/end-day/${LATER_DAY}`]) {
    await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
    await settle(page);
    const animated = await animatedElementCount(page);
    assert(animated === 0, `${path}: reduced motion must remove animation (${String(animated)}).`);
  }
  await page.goto(`${j.origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Use system motion setting').check();
  j.checks.push(
    'reduced motion: no animation or transition over 0.01 s in main on Today, Focus mode, and End Day',
  );
}
