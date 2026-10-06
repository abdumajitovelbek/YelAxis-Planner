import {
  animatedElementCount,
  assert,
  assertNoOverflow,
  assertSingleH1,
  assertStaticCaches,
  assertTargets,
  blockForeignRequests,
  completeMinimalOnboarding,
  escapeRegExp,
  forbiddenCopy,
  modelOrRankingCopy,
  modelRouteLinks,
  poll,
  recordForeignRequests,
  recordNotificationRequests,
  runJourney,
  sleep,
  tabTo,
  unlabelledFields,
  waitForFocus,
} from './lib/journey.mjs';

/**
 * Review production journey: daily/weekly/monthly/yearly drafts, explicit decisions, Finish and
 * Undo, archive/delete references, reminders, unsaved navigation and offline restart. Permission
 * and delivery remain separate opt-in workflows. Every launch advances a fixed clock so the
 * result is independent of the machine's date. Fictional content only; Firefox exercises normal
 * website behavior without PWA offline reloads.
 */
const timeZone = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

/** Monday. The Profile is created this day; en-US weeks start on Sunday (device default). */
const DAY1 = '2026-11-23';
const CARRY_DAY = '2026-11-24';
/** The first reviewed week, Sunday November 22 to Saturday November 28, and its weekly key. */
const WEEK1 = '2026-11-22';
const WEEK1_LAST = '2026-11-28';
/** The week the first weekly review plans: Sunday November 29 to Saturday December 5. */
const NEXT_WEEK = '2026-11-29';
const FENCE_DAY = '2026-12-02';
const MEETING_DAY = '2026-12-01';
const MONTH_LAST = '2026-11-30';
const YEAR_LAST = '2026-12-31';
/** The week a draft is saved for before the zone change, and the week that is current after it. */
const DRAFT_WEEK = '2026-12-20';
const ZONE_WEEK = '2026-12-27';
/** Planning today after the change to Asia/Tokyo. */
const TOKYO_DAY = '2027-01-02';
/** The day of the time block that gets a reminder, and the first day of the timed Routine. */
const BLOCK_DAY = '2027-01-05';
const ROUTINE_START = '2027-01-03';
/** The week the Dec 27 – Jan 2 weekly review plans (Sunday January 3 to Saturday January 9). */
const PLAN_WEEK = '2027-01-03';

/**
 * Clock instants. A relaunch is a fresh browser on the same profile, so each one is a new launch
 * of the app at a later moment.
 */
const AT = {
  setup: new Date('2026-11-23T09:00:00-05:00'),
  evening: new Date('2026-11-23T18:00:00-05:00'),
  weekLast: new Date('2026-11-28T10:00:00-05:00'),
  weekLastLater: new Date('2026-11-28T11:00:00-05:00'),
  monthLast: new Date('2026-11-30T10:00:00-05:00'),
  yearLast: new Date('2026-12-31T10:00:00-05:00'),
  /** Friday January 1, 9 PM in New York: already Saturday morning in Tokyo. */
  newYearNight: new Date('2027-01-01T21:00:00-05:00'),
  tokyo: new Date('2027-01-02T11:05:00+09:00'),
  /** The relaunch that checks reminder definitions (offline in Chromium). */
  reminderRelaunch: new Date('2027-01-02T11:20:00+09:00'),
  /** The relaunch that resumes the saved weekly draft (offline in Chromium). */
  resumeRelaunch: new Date('2027-01-02T11:30:00+09:00'),
  tokyoRelaunch: new Date('2027-01-02T11:55:00+09:00'),
};

/** Live-today h1 without a preferred name (onboarding greeting kept by Today). */
const LIVE_H1 = 'A useful day starts here.';
const SAVED = 'Saved. You can resume this review from Review.';

/** Period titles (review-text.ts `periodTitle`): a year is added once the period is not this year. */
const weekWords = 'Week of November 22–28';
const draftWeek = 'Week of December 20–26, 2026';
const zoneWeek = 'Week of December 27, 2026 – January 2, 2027';

/** Pages checked for layout, reflow, themes, and motion (the last step). */
const accessiblePages = [
  ['/review', 'review-overview'],
  ['/review/yearly/2027', 'review-form'],
  [`/review/weekly/${WEEK1}`, 'review-finished'],
  ['/review/monthly/2026-12', 'review-skipped'],
  ['/end-day/2027-01-01', 'end-day-form'],
  [`/end-day/${DAY1}`, 'end-day-finished'],
];

/** Fictional plan content only. */
const T = {
  onboarding: 'Onboarding useful Action',
  axis: 'Home and garden',
  axisPurpose: 'Keep the home and garden in good shape.',
  outcome: 'Publish the garden guide',
  outcomeSuccess: 'The guide is shared with the neighbourhood.',
  project: 'Photograph the beds',
  projectResult: 'Every bed has a clear photo in the guide.',
  project2: 'Build a cold frame',
  project2Result: 'Seedlings stay warm through March.',
  water: 'Water the tomatoes',
  seeds: 'Sort the seed packets',
  feeder: 'Prepare the bird feeder',
  fence: 'Mend the fence',
  twine: 'Buy twine',
  meeting: 'Neighbourhood garden meeting',
  dayNote: 'A slow, steady day in the garden.',
  weekNote: 'Short sessions in the morning worked well.',
  axisNote: 'Morning light and dry weather helped the photos.',
  unsaved: 'Words that were never saved.',
  theme: 'Rest, repair, and plan the spring beds',
  retro: 'The garden guide took shape; small weekly steps mattered most.',
  direction: 'Grow food for the neighbours and share what works.',
  draftAxisNote: 'Fixing the fence before the frost helped.',
  draftAxisNoteEdited: 'Fixing the fence before the frost helped, and so did a dry week.',
  offlineNote: 'Written without a connection.',
  offlineRetro: 'Started early, without a connection.',
  block: 'Prune the apple tree',
  routine: 'Evening watering',
};
/** label: reminder copy (scheduling-dialogs.tsx, routine-form.tsx, routines.tsx). */
const REMINDER_COPY =
  'Reminders are saved on this device. Enable browser alerts in Settings for delivery while YelAxis Planner is open; reminders due while it is closed appear in Notifications after reopening.';
const ids = {};
/** Every page whose copy was audited, for the summary. */
const audited = new Set();

await runJourney(
  { name: 'reviews', title: 'Reviews', timeZone, basePort: 8200, timeoutMinutes: 20 },
  async (j) => {
    const started = Date.now();
    const seen = {
      step: 'start',
      externalRequests: [],
      contextRequests: [],
      blockedRequests: [],
      browserErrors: [],
      dialogs: [],
      notificationCalls: [],
    };
    const step = (name) => {
      seen.step = name;
      j.step(name);
    };
    let { context, page } = await open(j, seen, AT.setup);
    await page.goto(j.origin, { waitUntil: 'networkidle' });

    step('1 onboarding, a fresh Today with no review notice, and seeding');
    await verifyFreshLaunch(j, page);
    await seedPlan(j, page);
    step('2 daily review (End Day)');
    ({ context, page } = await verifyDailyReview(j, seen, context, page));
    step('3 weekly review');
    ({ context, page } = await verifyWeeklyReview(j, seen, context));
    step('4 monthly review');
    ({ context, page } = await verifyMonthlyReview(j, seen, context));
    step('5 yearly review');
    ({ context, page } = await verifyYearlyReview(j, seen, context));
    step('6 history');
    await verifyHistory(j, page);
    step('7 planning-zone change with a draft');
    ({ context, page } = await verifyZoneChange(j, seen, context));
    step('8 permanent delete keeps review decisions');
    await verifyDeleteKeepsDecisions(j, page);
    step('9 reminder definitions for a time block and a timed Routine');
    ({ context, page } = await verifyReminders(j, seen, context, page));
    step(
      '10 offline reviews, a cleared commitments list, and "Remind me to finish", with relaunches',
    );
    ({ context, page } = await verifyOfflineReviews(j, seen, context, page));
    step('11 leaving right after "Saved" asks nothing');
    await verifyLeavingRightAfterSave(j, page, seen);
    step('12 no model surface or traffic, and calm deep links');
    await verifyNoModelSurface(j, page, seen);
    step('13 accessibility: layouts, 320 px, 200% text, themes, motion, keyboard');
    await verifyAccessibility(j, page);
    j.checks.push(
      j.inFirefox
        ? 'Firefox: the same journey as website use (no offline reloads or service-worker checks)'
        : 'Chromium: the full journey, including offline reviews, an offline relaunch, and the cache audit',
    );
    await context.close();

    const external = [...new Set([...seen.externalRequests, ...seen.contextRequests])];
    assert(external.length === 0, `Reviews made external requests: ${external.join(', ')}`);
    assert(
      seen.blockedRequests.length === 0,
      `Reviews tried requests away from the app: ${seen.blockedRequests.join(', ')}`,
    );
    const artifacts = seen.browserErrors.filter((error) => isFirefoxClockArtifact(j, error));
    const errors = seen.browserErrors.filter((error) => !isFirefoxClockArtifact(j, error));
    assert(errors.length === 0, `Reviews browser errors: ${errors.join(' | ')}`);
    assert(
      seen.dialogs.length === 0,
      `Reviews opened browser dialogs: ${seen.dialogs.join(' | ')}`,
    );
    assert(
      seen.notificationCalls.length === 0,
      `Reviews asked for notification permission or showed a notification: ${seen.notificationCalls.join(' | ')}`,
    );
    j.checks.push(
      'zero external requests (pages, workers, and service worker), zero blocked requests, zero console or page errors, zero browser dialogs, and zero notification permission requests across the whole journey',
    );
    return {
      dates: {
        profileCreated: DAY1,
        dailyReview: DAY1,
        weeklyReview: WEEK1_LAST,
        monthlyReview: MONTH_LAST,
        yearlyReview: YEAR_LAST,
        zoneChange: `2027-01-01 21:00 America/New_York → ${TOKYO_DAY} 11:05 Asia/Tokyo`,
      },
      clockStart: AT.setup.toISOString(),
      durationSeconds: Math.round((Date.now() - started) / 1000),
      checkCount: j.checks.length,
      externalRequests: external,
      blockedRequests: seen.blockedRequests,
      browserErrors: errors,
      browserDialogs: seen.dialogs,
      notificationRequests: seen.notificationCalls,
      // Reported, never hidden: see isFirefoxClockArtifact.
      firefoxClockArtifacts: artifacts,
      auditedPages: [...audited],
    };
  },
);

/* ───────────────────────── Browser setup ───────────────────────── */

/**
 * Playwright's fake clock in Firefox can log this exact message, with no source location and no
 * page error, when the app page navigates under a shifted page clock (Today evidence). Only this
 * message, only in Firefox, is set aside; it is still reported.
 */
function isFirefoxClockArtifact(j, error) {
  return (
    j.inFirefox &&
    error.startsWith(
      '[JavaScript Error: "InvalidStateError: An attempt was made to use an object that is not, or is no longer, usable"] [step: ',
    )
  );
}

/**
 * Launch the browser on the journey's profile with every request away from the app aborted and
 * recorded, observe the page, and install its clock before the first navigation.
 */
async function open(j, seen, time, deviceZone = timeZone) {
  const context = await j.launch(deviceZone);
  await blockForeignRequests(context, j.origin, seen.blockedRequests);
  recordForeignRequests(context, j.origin, seen.contextRequests);
  await recordNotificationRequests(context, seen.notificationCalls, () => ` [step: ${seen.step}]`);
  const page = context.pages()[0] ?? (await context.newPage());
  j.observe(page, seen.externalRequests, seen.browserErrors);
  // Browser dialogs (beforeunload, confirm) are never part of a review; record any and let it go.
  page.on('dialog', (dialog) => {
    seen.dialogs.push(
      `${dialog.type()}: ${dialog.message()} [step: ${seen.step}; page: ${page.url()}]`,
    );
    void dialog.accept().catch(() => undefined);
  });
  await page.clock.install({ time });
  return { context, page };
}

/** Close the browser and launch it again later: a fresh launch of the app on the same profile. */
async function relaunch(j, seen, context, time, deviceZone = timeZone) {
  await context.close();
  return open(j, seen, time, deviceZone);
}

/* ───────────────────────── Shared page helpers ───────────────────────── */

/*
 * Helpers below are function declarations: the journey above runs at module top level, before any
 * `const` declared after it would be initialized.
 */

function utcNoon(date) {
  return new Date(`${date}T12:00:00Z`);
}

/** "Monday, November 23". */
function dayWords(date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(utcNoon(date));
}

/** "Monday, November 23, 2026". */
function longDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(utcNoon(date));
}

function main(page) {
  return page.locator('main');
}

async function heading1(page, name) {
  await page.getByRole('heading', { level: 1, name, exact: true }).waitFor();
}

/** Wait until the page has left every loading state (Opening…, Loading…, Reading…, aria-busy). */
async function settle(page) {
  await page.locator('main h1').first().waitFor();
  await poll(
    () =>
      page.evaluate(() => {
        const heading = document.querySelector('main h1');
        if (heading === null || (heading.textContent ?? '').startsWith('Opening')) return false;
        if (document.querySelector('main [aria-busy="true"]') !== null) return false;
        return ![...document.querySelectorAll('main [role="status"]')].some((element) =>
          /^(?:Opening|Loading|Reading|Checking)\b/u.test((element.textContent ?? '').trim()),
        );
      }),
    'The page did not leave its loading state.',
  );
}

async function visit(j, page, path) {
  await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
  await settle(page);
}

/**
 * After in-app navigation: the URL changes before the view does, so wait for the destination's
 * own h1 and only then for its reads to finish.
 */
async function arrive(j, page, path, h1) {
  await page.waitForURL(`${j.origin}${path}`);
  await heading1(page, h1);
  await settle(page);
}

/** After in-app navigation to a page whose h1 is not known: wait until the h1 is a new one. */
async function arriveElsewhere(page, pattern, previousH1) {
  await page.waitForURL(pattern);
  await poll(
    () =>
      page.evaluate((previous) => {
        const heading = document.querySelector('main h1');
        return heading !== null && (heading.textContent ?? '').trim() !== previous;
      }, previousH1),
    `Navigation to ${String(pattern)} must show its own page.`,
  );
  await settle(page);
}

async function currentH1(page) {
  return ((await page.locator('main h1').first().textContent()) ?? '').trim();
}

/** The section around a page's h2. */
function section(page, name) {
  return page
    .getByRole('heading', { level: 2, name, exact: true })
    .locator('xpath=ancestor::section[1]');
}

/** label: Today eyebrow "{Today|…} · {long date}" (Today). */
function eyebrow(page, relation, date) {
  return page.getByText(`${relation} · ${longDate(date)}`, { exact: true });
}

function primaryLink(page, name) {
  return page.locator('.primary-nav').getByRole('link', { name, exact: true });
}

/** From live Today, the next day by in-app navigation (a fresh load always opens live today). */
async function nextDay(j, page, date) {
  await page
    .getByRole('navigation', { name: 'Day' })
    .getByRole('link', { name: 'Next day' })
    .click();
  await page.waitForURL(`${j.origin}/?date=${date}`);
  // The URL changes before the view does: wait for the selected day's own heading.
  await heading1(page, longDate(date));
  await settle(page);
}

/** Wait until the element's whole text is exactly `text` (whitespace collapsed). */
async function expectExactText(locator, text, label) {
  let shown = '';
  await poll(async () => {
    shown = ((await locator.first().textContent()) ?? '').replace(/\s+/gu, ' ').trim();
    return shown === text;
  }, `${label} must read "${text}"`).catch(() => {
    throw new Error(`${label} must read "${text}" (found "${shown}").`);
  });
}

/** label: the page header eyebrow (a review period or End Day's date). */
function expectEyebrow(page, text) {
  return expectExactText(main(page).locator('header .eyebrow'), text, 'The eyebrow');
}

/** Navigate by URL; offline the service worker serves the page, so wait for the DOM only. */
async function go(j, page, path, offline) {
  await page.goto(`${j.origin}${path}`, {
    waitUntil: offline ? 'domcontentloaded' : 'networkidle',
  });
  await settle(page);
}

/** No view in `main` is re-reading after a committed change. */
function idle(page) {
  return page.evaluate(() => document.querySelector('main [aria-busy="true"]') === null);
}

/**
 * Activate a control from the keyboard, so focus is on it when the command runs. Every committed
 * change (even a capture from the header) makes each open view re-read, and a command control is
 * aria-disabled and does nothing while its view re-reads, so wait for the view to be idle first.
 */
async function press(page, locator) {
  await locator.waitFor();
  await poll(
    async () => (await idle(page)) && (await locator.getAttribute('aria-disabled')) !== 'true',
    `${String(locator)} must be enabled before it is pressed.`,
  );
  await locator.focus();
  await page.keyboard.press('Enter');
}

/** After a command removes the focused control, focus lands on the view heading (alignment/Today rule). */
async function expectHeadingFocus(page, what) {
  await waitForFocus(page, page.locator('main h1'), {
    label: `${what}: focus must land on the view heading`,
  });
}

/**
 * A command's result is shown and announced through a status region. The result renders while the
 * view re-reads the saved plan (aria-busy); until that read lands the form still compares itself
 * with the previous save, so wait for it before leaving or reloading the page.
 */
async function expectStatus(page, text) {
  const message = main(page).getByText(text, { exact: true }).first();
  await message.waitFor();
  assert(
    await message.evaluate((element) => element.closest('[role="status"]') !== null),
    `"${text}" must be inside a status region.`,
  );
  await poll(() => idle(page), `The view must finish re-reading after "${text}".`);
}

function button(page, name) {
  return main(page).getByRole('button', { name, exact: true });
}

/** Calm-copy, model, ranking, and route audit of the page (verification contract, verification contract). */
async function auditCopy(page, label) {
  const text = await main(page).innerText();
  const calm = forbiddenCopy(text);
  assert(calm.length === 0, `${label} uses forbidden wording: ${calm.join(', ')}.`);
  const model = modelOrRankingCopy(text);
  assert(
    model.length === 0,
    `${label} shows AI, ranking, or automatic-planning wording: ${model.join(', ')}.`,
  );
  assert(!/\d\s?%/u.test(text), `${label} shows a percentage.`);
  const routes = await modelRouteLinks(page);
  assert(routes.length === 0, `${label} links to a model route: ${routes.join(', ')}.`);
  const unlabelled = await unlabelledFields(page);
  assert(unlabelled.length === 0, `${label} has unlabelled fields: ${unlabelled.join(', ')}.`);
  audited.add(label);
}

/** Exact link texts of a list's rows, in order, until they match. */
async function expectRows(list, expected, label, { timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  let actual = [];
  while (Date.now() < deadline) {
    try {
      actual = await list
        .locator(':scope > li')
        .evaluateAll((rows) =>
          rows.map((row) =>
            (row.querySelector('a')?.textContent ?? '').replace(/\s+/gu, ' ').trim(),
          ),
        );
    } catch {
      actual = [];
    }
    if (actual.join('|') === expected.join('|')) return;
    await sleep(100);
  }
  throw new Error(`${label}: expected ${expected.join(' | ')}; found ${actual.join(' | ')}.`);
}

/** One row of a list, found by the exact text of its link. */
function rowNamed(list, name) {
  return list
    .locator(':scope > li')
    .filter({ has: list.page().getByRole('link', { name, exact: true }) });
}

/** Text of a row's facts line ("Weekly review · Done · 4 decisions · Finished …"). */
async function rowFacts(list, name) {
  const facts = rowNamed(list, name).locator('.review-row-facts');
  await facts.waitFor();
  return ((await facts.textContent()) ?? '').replace(/\s+/gu, ' ').trim();
}

/* ───────────────────────── Review overview helpers ───────────────────────── */

function typeWord(type) {
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

/** Open the Review overview from the primary navigation. */
async function openReview(page) {
  await primaryLink(page, 'Review').click();
  await page.waitForURL(/\/review$/u);
  // The URL changes before the view does: wait for the overview's own heading, then its reads.
  await heading1(page, 'Review');
  await settle(page);
}

/** The h1 of the page a review link opens: End Day for a daily review, else "{Type} review". */
function reviewHeading(path) {
  if (path.startsWith('/end-day/')) return 'End day';
  const type = path.split('/')[2] ?? '';
  return `${typeWord(type)} review`;
}

/** label: a "Current reviews" card (h3 "{Type} review"). */
function checkpointCard(page, type) {
  return section(page, 'Current reviews')
    .locator('li')
    .filter({
      has: page.getByRole('heading', { level: 3, name: `${typeWord(type)} review`, exact: true }),
    });
}

/**
 * label: card period, status ("Not started", "Saved for later", "Skipped", "Done"), due text
 * ("Due today", "Ready when you are", "Due {weekday, date}"; none once settled), and its one link.
 */
async function expectCard(page, type, { due, link, period, status }) {
  const card = checkpointCard(page, type);
  await card.getByText(period, { exact: true }).waitFor();
  await card.getByText(status, { exact: true }).waitFor();
  const dueText = card.getByText(/^(?:Due .+|Ready when you are)$/u);
  if (due === null)
    assert((await dueText.count()) === 0, `The settled ${type} card must show no due text.`);
  else await card.getByText(due, { exact: true }).waitFor();
  await card.getByRole('link', { name: `${link} (${type})`, exact: true }).waitFor();
}

async function openCard(j, page, type, link, path) {
  await checkpointCard(page, type)
    .getByRole('link', { name: `${link} (${type})`, exact: true })
    .click();
  await page.waitForURL(`${j.origin}${path}`);
  await heading1(page, reviewHeading(path));
  await settle(page);
}

function historyList(page) {
  return section(page, 'History').getByRole('list', { name: 'Review history', exact: true });
}

/** label: the review page facts line "{status} · {due}" under the h1. */
async function expectFacts(page, text) {
  await main(page).locator('.review-page-facts').filter({ hasText: text }).waitFor();
  const shown = ((await main(page).locator('.review-page-facts').textContent()) ?? '').trim();
  assert(shown === text, `The review facts must read "${text}" (found "${shown}").`);
}

/* ───────────────────────── Today notice helpers ───────────────────────── */

/**
 * label: "Your {types} review(s) is/are ready." with "Open Review" (product contract): one quiet line,
 * never a dialog, never in a live region, never blocking.
 */
async function expectNotice(page, text) {
  const notice = page.locator('.today-review-notice');
  await notice.waitFor();
  const shown = (await notice.innerText()).replace(/\s+/gu, ' ').trim();
  assert(
    shown === `${text} Open Review`,
    `The review notice must read "${text}" (found "${shown}").`,
  );
  assert(
    await notice.evaluate(
      (element) =>
        element.closest('[aria-live], [role="status"], [role="alert"], dialog') === null &&
        element.querySelector('[aria-live], [role="status"], [role="alert"]') === null,
    ),
    'The review notice is never announced on load or shown as a dialog.',
  );
  assert((await page.locator('dialog[open]').count()) === 0, 'The notice must not open a dialog.');
  return notice;
}

/** No notice appears: the notice is read after Today renders, so watch it for a while. */
async function expectNoNotice(page, label) {
  await section(page, 'End of day').waitFor();
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    assert(
      (await page.locator('.today-review-notice').count()) === 0,
      `${label} must show no review notice.`,
    );
    await sleep(150);
  }
}

/* ───────────────────────── Seeding helpers (Actions-alignment UI) ───────────────────────── */

function lastSegment(page) {
  return new URL(page.url()).pathname.split('/').pop();
}

/** The id at the end of the first link named `title` in `scope`. */
async function idFromLink(scope, title) {
  const href = await scope
    .getByRole('link', { name: title, exact: true })
    .first()
    .getAttribute('href');
  assert(href !== null, `No link to ${title}.`);
  return href.split('/').pop();
}

async function createAxis(j, page, title, purpose) {
  await visit(j, page, '/axis');
  await heading1(page, 'Axes');
  await page.getByRole('button', { name: 'New Axis…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Axis' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill(title);
  await dialog.getByLabel(/^Purpose/u).fill(purpose);
  await dialog.getByRole('button', { name: 'Create Axis' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await heading1(page, title);
  return lastSegment(page);
}

async function createOutcomeInAxis(j, page, axisId, title, success) {
  await visit(j, page, `/axis/${axisId}`);
  await page.getByRole('button', { name: 'Add Outcome…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Outcome' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill(title);
  await dialog.getByLabel(/^Success definition/u).fill(success);
  await dialog.getByRole('button', { name: 'Create Outcome' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await heading1(page, title);
  return lastSegment(page);
}

async function createProjectInAxis(j, page, axisId, title, desiredResult) {
  await visit(j, page, `/axis/${axisId}`);
  await page.getByRole('button', { name: 'Add Project…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Project' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill(title);
  await dialog.getByLabel(/^Desired result/u).fill(desiredResult);
  await dialog.getByRole('radio', { name: 'Active', exact: true }).check();
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await heading1(page, title);
  return lastSegment(page);
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

function flexibleList(page) {
  return page.getByRole('list', { name: /^Flexible Actions for /u });
}

function focusList(page) {
  return page.getByRole('list', { name: /^Focus for /u });
}

function rowOf(list, title) {
  return list.locator(':scope > li').filter({ hasText: title });
}

/** The object page eyebrow "{Type} · {State}" (alignment ObjectHeader). */
async function expectObjectState(j, page, path, kind, state) {
  await visit(j, page, path);
  await main(page).getByText(`${kind} · ${state}`, { exact: true }).first().waitFor();
}

/* ───────────────────────── 1. Fresh launch and seeding ───────────────────────── */

async function verifyFreshLaunch(j, page) {
  await completeMinimalOnboarding(page);
  await page.waitForURL(`${j.origin}/`);
  await settle(page);
  await heading1(page, LIVE_H1);
  await assertSingleH1(page, 'Today');
  await eyebrow(page, 'Today', DAY1).waitFor();
  await expectNoNotice(page, 'A fresh Today');
  await j.shot(page, 'today-fresh-1280x800');

  // every type offers its current period; none is due, and no period that ended
  // before the Profile existed is offered.
  await openReview(page);
  await assertSingleH1(page, 'Review overview');
  await expectCard(page, 'daily', {
    period: `Today, ${dayWords(DAY1)}`,
    status: 'Not started',
    due: 'Due today',
    link: 'Start review',
  });
  await expectCard(page, 'weekly', {
    period: 'Week of November 22–28',
    status: 'Not started',
    due: `Due ${dayWords(WEEK1_LAST)}`,
    link: 'Start early',
  });
  await expectCard(page, 'monthly', {
    period: 'November 2026',
    status: 'Not started',
    due: `Due ${dayWords(MONTH_LAST)}`,
    link: 'Start early',
  });
  await expectCard(page, 'yearly', {
    period: '2026',
    status: 'Not started',
    due: `Due ${dayWords(YEAR_LAST)}`,
    link: 'Start early',
  });
  await section(page, 'In progress')
    .getByText('No other reviews are saved for later.', { exact: true })
    .waitFor();
  await section(page, 'History')
    .getByText('Finished and skipped reviews will appear here.', { exact: true })
    .waitFor();
  await auditCopy(page, 'Review overview (empty)');
  await j.shot(page, 'review-overview-empty-1280x800');
  j.checks.push(
    'fresh Today after onboarding: one h1 and no review notice; Review offers the current daily, weekly, monthly, and yearly periods, none earlier than the Profile, with calm due text and empty history',
  );
}

async function seedPlan(j, page) {
  ids.axis = await createAxis(j, page, T.axis, T.axisPurpose);
  ids.outcome = await createOutcomeInAxis(j, page, ids.axis, T.outcome, T.outcomeSuccess);
  ids.project = await createProjectInAxis(j, page, ids.axis, T.project, T.projectResult);
  ids.project2 = await createProjectInAxis(j, page, ids.axis, T.project2, T.project2Result);
  // Before any review, the Axis page says it has no review notes .
  await visit(j, page, `/axis/${ids.axis}`);
  await section(page, 'Recent review note')
    .getByText('No review notes yet.', { exact: true })
    .waitFor();
  for (const [title, date] of [
    [T.water, DAY1],
    [T.seeds, DAY1],
    [T.feeder, NEXT_WEEK],
    [T.fence, FENCE_DAY],
  ])
    await capture(page, title, { plannedDate: date });
  // Fixed work in the week the first weekly review plans (planning Plan Week).
  await visit(j, page, `/plan/week/${NEXT_WEEK}`);
  await page.getByRole('button', { name: 'Add fixed commitment' }).click();
  const commitment = page.getByRole('dialog', { name: 'Add a fixed commitment' });
  await commitment.waitFor();
  await commitment.locator('#commitment-title').fill(T.meeting);
  await commitment.getByLabel('Date').fill(MEETING_DAY);
  await commitment.getByLabel('Start time').fill('18:00');
  await commitment.getByLabel('Duration (minutes)').fill('60');
  await commitment.locator('#commitment-hard').check();
  await commitment.getByRole('button', { name: 'Add commitment' }).click();
  await commitment.waitFor({ state: 'hidden' });
  await page.getByText('Commitment added.').first().waitFor();
  await visit(j, page, '/');
  for (const title of [T.onboarding, T.water, T.seeds])
    await rowOf(flexibleList(page), title).waitFor();
  j.checks.push(
    'seeded through the UI: an Axis, an Outcome, two active Projects with desired results, four Actions placed on November 23, November 29, and December 2, and a fixed commitment on December 1; the Axis says "No review notes yet."',
  );
}

/* ───────────────────────── 2. Daily review (End Day) ───────────────────────── */

/** label: one open item's fieldset (legend = title) in "Still open". */
function endDayItem(page, title) {
  return section(page, 'Still open').getByRole('group', { name: title, exact: true });
}

function energyGroup(page) {
  return page.getByRole('group', { name: 'How was your energy?', exact: true });
}

/** label: End Day's "Focus for {weekday, date}" section. */
function carryFocus(page) {
  return section(page, `Focus for ${dayWords(CARRY_DAY)}`);
}

function carryRadio(page, title) {
  return endDayItem(page, title).getByRole('radio', {
    name: `Carry to ${dayWords(CARRY_DAY)}`,
    exact: true,
  });
}

async function chooseDayDecisions(page) {
  for (const title of [T.onboarding, T.water, T.seeds])
    assert(
      await endDayItem(page, title)
        .getByRole('radio', { name: 'Decide later', exact: true })
        .isChecked(),
      `${title} must start at "Decide later".`,
    );
  assert(
    await energyGroup(page).getByRole('radio', { name: 'Not noted', exact: true }).isChecked(),
    'Energy must start at "Not noted".',
  );
  await carryRadio(page, T.water).check();
  await endDayItem(page, T.seeds).getByRole('radio', { name: 'Complete', exact: true }).check();
  await energyGroup(page).getByRole('radio', { name: 'Medium', exact: true }).check();
  await page.getByLabel('Note (optional)', { exact: true }).fill(T.dayNote);
  // A carried Action can be chosen as the carry day's focus before it is there.
  await carryFocus(page).getByRole('checkbox', { name: T.water, exact: true }).check();
  await carryFocus(page).getByText('1 of 3 chosen', { exact: true }).waitFor();
}

/** Every saved daily choice is shown again (energy, note, decisions, and the focus draft). */
async function expectDayChoices(page, label) {
  await carryRadio(page, T.water).waitFor();
  const checks = [
    [carryRadio(page, T.water), `${T.water} is set to carry`],
    [
      endDayItem(page, T.seeds).getByRole('radio', { name: 'Complete', exact: true }),
      `${T.seeds} is set to complete`,
    ],
    [
      endDayItem(page, T.onboarding).getByRole('radio', { name: 'Decide later', exact: true }),
      `${T.onboarding} stays at Decide later`,
    ],
    [energyGroup(page).getByRole('radio', { name: 'Medium', exact: true }), 'energy is Medium'],
    [
      carryFocus(page).getByRole('checkbox', { name: T.water, exact: true }),
      `${T.water} is in the focus draft`,
    ],
  ];
  for (const [locator, what] of checks)
    await poll(() => locator.isChecked(), `${label}: ${what}.`, { timeout: 5_000 });
  const note = await page.getByLabel('Note (optional)', { exact: true }).inputValue();
  assert(note === T.dayNote, `${label}: the note must come back (found "${note}").`);
  await carryFocus(page).getByText('1 of 3 chosen', { exact: true }).waitFor();
}

async function verifyDailyReview(j, seen, context, page) {
  await visit(j, page, '/');
  await section(page, 'End of day').getByRole('link', { name: 'End day…', exact: true }).click();
  await arrive(j, page, `/end-day/${DAY1}`, 'End day');
  await assertSingleH1(page, 'End Day');
  await page
    .getByText(
      'A short look back. Decide what happens next for anything still open. Nothing changes until you finish the review.',
      { exact: true },
    )
    .waitFor();
  await chooseDayDecisions(page);
  await auditCopy(page, 'End Day (daily review form)');
  await j.shot(page, 'end-day-choices-1280x800');

  const save = button(page, 'Save for later');
  await press(page, save);
  await expectStatus(page, SAVED);
  await waitForFocus(page, save, { label: 'Save for later keeps focus on its button' });
  await page.reload({ waitUntil: 'networkidle' });
  await settle(page);
  await heading1(page, 'End day');
  await expectDayChoices(page, 'After a reload');
  j.checks.push(
    'End Day as the daily review: items start at Decide later and energy at Not noted; carry, complete, energy Medium, a note, and the carry-day focus are saved for later and come back after a reload',
  );

  // A fresh launch that evening resumes it from the Review overview.
  ({ context, page } = await relaunch(j, seen, context, AT.evening));
  await page.goto(`${j.origin}/`, { waitUntil: 'networkidle' });
  await settle(page);
  await heading1(page, LIVE_H1);
  await openReview(page);
  await expectCard(page, 'daily', {
    period: `Today, ${dayWords(DAY1)}`,
    status: 'Saved for later',
    due: 'Due today',
    link: 'Resume review',
  });
  await openCard(j, page, 'daily', 'Resume review', `/end-day/${DAY1}`);
  await expectDayChoices(page, 'After a fresh launch');
  j.checks.push(
    'a fresh launch shows the daily card as Saved for later; Resume review restores every choice',
  );

  // Finish, then Undo: the plan and the draft come back, and a later capture is kept.
  await press(page, button(page, 'Finish review'));
  await expectStatus(page, 'Review finished.');
  for (const line of [
    `1 Action carried to ${dayWords(CARRY_DAY)}.`,
    '1 Action completed.',
    `Focus for ${dayWords(CARRY_DAY)} set to 1 item.`,
  ])
    await main(page).getByText(line, { exact: true }).waitFor();
  await expectHeadingFocus(page, 'Finish review (End Day)');
  await capture(page, T.twine);
  await press(page, button(page, 'Undo'));
  await main(page).getByText('Your End day choices were undone.').first().waitFor();
  await poll(() => idle(page), 'End Day must finish re-reading after Undo.');
  await expectHeadingFocus(page, 'Undo (End Day)');
  await expectDayChoices(page, 'After Undo');
  // The plan is back: the completed Action is open again and the carried one is still here.
  await endDayItem(page, T.seeds).waitFor();
  await endDayItem(page, T.water).waitFor();
  await section(page, 'Done')
    .getByText('Nothing was marked done for this day.', { exact: true })
    .waitFor();
  await visit(j, page, '/inbox');
  await page.getByRole('list', { name: 'Inbox Actions' }).getByText(T.twine).first().waitFor();
  await visit(j, page, '/');
  for (const title of [T.water, T.seeds]) await rowOf(flexibleList(page), title).waitFor();
  await nextDay(j, page, CARRY_DAY);
  assert(
    (await rowOf(flexibleList(page), T.water).count()) === 0 &&
      (await focusList(page).count()) === 0,
    'After Undo, November 24 has neither the carried Action nor its focus.',
  );
  j.checks.push(
    'Finish review applies everything in one command with a summary; Undo restores the plan and the saved draft, keeps a later capture, and moves focus to the heading',
  );

  // Finish again: the day's review becomes read-only history.
  await visit(j, page, `/end-day/${DAY1}`);
  await expectDayChoices(page, 'Before finishing again');
  await press(page, button(page, 'Finish review'));
  await expectStatus(page, 'Review finished.');
  await expectHeadingFocus(page, 'Finish review again (End Day)');
  await page
    .getByText(
      new RegExp(
        `^Finished ${escapeRegExp(longDate(DAY1))} at \\d{1,2}:\\d{2} PM\\. Its choices are kept here\\.$`,
        'u',
      ),
    )
    .waitFor();
  await section(page, 'Energy').getByText('Medium', { exact: true }).waitFor();
  await section(page, 'Note').getByText(T.dayNote, { exact: true }).waitFor();
  const decisions = page.getByRole('list', { name: `Decisions for ${longDate(DAY1)}` });
  for (const text of [`${T.water} · Carried`, `${T.seeds} · Completed`])
    await decisions.locator('li').filter({ hasText: text }).waitFor();
  await section(page, 'Focus chosen')
    .getByRole('list', { name: 'Focus chosen' })
    .getByText(T.water, { exact: true })
    .waitFor();
  assert(
    (await button(page, 'Finish review').count()) === 0 &&
      (await page.locator('main textarea, main input[type=radio]').count()) === 0,
    'A finished day review is read-only.',
  );
  await auditCopy(page, 'End Day (finished daily review)');
  await j.shot(page, 'end-day-finished-1280x800');

  // The plan: the carried Action and its focus are on November 24.
  await visit(j, page, '/');
  assert(
    (await rowOf(flexibleList(page), T.water).count()) === 0,
    'The carried Action leaves November 23.',
  );
  await nextDay(j, page, CARRY_DAY);
  await rowOf(flexibleList(page), T.water).waitFor();
  await rowOf(focusList(page), T.water).waitFor();
  ids.water = await idFromLink(flexibleList(page), T.water);

  // History lists it.
  await openReview(page);
  await expectCard(page, 'daily', {
    period: `Today, ${dayWords(DAY1)}`,
    status: 'Done',
    due: null,
    link: 'Open review',
  });
  const name = `Today, ${dayWords(DAY1)} (daily review)`;
  await expectRows(historyList(page), [name], 'History after the daily review');
  const facts = await rowFacts(historyList(page), name);
  assert(
    new RegExp(
      `^Daily review · Done · Energy: Medium · 3 decisions · Finished ${escapeRegExp(longDate(DAY1))} at \\d{1,2}:\\d{2} PM$`,
      'u',
    ).test(facts),
    `The daily history row must state its facts (found "${facts}").`,
  );
  j.checks.push(
    'Finish again: a read-only summary (energy, note, Carried and Completed, focus chosen); the Action and its focus move to November 24; Review history lists the day as Done with energy and 3 decisions',
  );
  return { context, page };
}

/* ───────────────────────── 3. Weekly review ───────────────────────── */

function weeklyFocus(page) {
  return section(page, `Focus for ${dayWords(NEXT_WEEK)}`);
}

function projectChoice(page, title, choice) {
  return section(page, 'Projects')
    .getByRole('group', { name: title, exact: true })
    .getByRole('radio', { name: choice, exact: true });
}

function commitmentBox(page, title) {
  return section(page, 'Commitments').getByRole('checkbox', { name: title, exact: true });
}

async function expectWeeklyChoices(page, label) {
  for (const [locator, what] of [
    [projectChoice(page, T.project, 'Pause'), `${T.project} is set to Pause`],
    [projectChoice(page, T.project2, 'Decide later'), `${T.project2} stays at Decide later`],
    [commitmentBox(page, T.fence), `${T.fence} is a chosen commitment`],
    [
      weeklyFocus(page).getByRole('checkbox', { name: T.feeder, exact: true }),
      `${T.feeder} is focus`,
    ],
  ])
    await poll(() => locator.isChecked(), `${label}: ${what}.`, { timeout: 5_000 });
  const axisNote = await page.getByLabel(`What supported ${T.axis}?`, { exact: true }).inputValue();
  assert(axisNote === T.axisNote, `${label}: the Axis note must come back (found "${axisNote}").`);
  const notes = await page.getByLabel('Notes (optional)', { exact: true }).inputValue();
  assert(notes === T.weekNote, `${label}: the notes must come back (found "${notes}").`);
  // The item's visible title (its Remove button repeats the title for screen readers).
  await section(page, 'Commitments')
    .getByRole('list', { name: 'Commitment order' })
    .getByText(T.fence, { exact: true })
    .first()
    .waitFor();
}

async function verifyNoticeNeverBlocks(j, page) {
  for (const [name, pattern] of [
    ['Plan', /\/plan\//u],
    ['Axis', /\/axis$/u],
    ['Review', /\/review$/u],
  ]) {
    const before = await currentH1(page);
    await primaryLink(page, name).click();
    await arriveElsewhere(page, pattern, before);
    assert((await page.locator('dialog[open]').count()) === 0, `${name} opened with a dialog.`);
  }
  const before = await currentH1(page);
  await page.locator('.utility-nav').getByRole('link', { name: 'Inbox', exact: true }).click();
  await arriveElsewhere(page, /\/inbox$/u, before);
  await primaryLink(page, 'Today').click();
  await arrive(j, page, '/', LIVE_H1);
}

async function verifyWeeklyReview(j, seen, context) {
  let page;
  ({ context, page } = await relaunch(j, seen, context, AT.weekLast));
  await visit(j, page, '/');
  await heading1(page, LIVE_H1);
  await eyebrow(page, 'Today', WEEK1_LAST).waitFor();
  await expectNotice(page, 'Your weekly review is ready.');
  await auditCopy(page, 'Today with the review notice');
  await j.shot(page, 'today-review-notice-1280x800');
  await verifyNoticeNeverBlocks(j, page);
  await expectNotice(page, 'Your weekly review is ready.');
  // Today keeps every part of the day around the notice.
  await section(page, 'End of day').getByRole('link', { name: 'End day…', exact: true }).waitFor();
  j.checks.push(
    'on the week’s last day Today shows one quiet line "Your weekly review is ready. Open Review": not a dialog, not a live region; Plan, Axis, Review, Inbox, and Today all open normally around it',
  );

  await page.locator('.today-review-notice').getByRole('link', { name: 'Open Review' }).click();
  await arrive(j, page, '/review', 'Review');
  await expectCard(page, 'weekly', {
    period: weekWords,
    status: 'Not started',
    due: 'Due today',
    link: 'Start review',
  });
  await openCard(j, page, 'weekly', 'Start review', `/review/weekly/${WEEK1}`);
  await heading1(page, 'Weekly review');
  await assertSingleH1(page, 'Weekly review');
  await expectEyebrow(page, weekWords);
  await expectFacts(page, 'Not started · Due today');
  assert(
    (await primaryLink(page, 'Review').getAttribute('aria-current')) === 'page',
    'The Review navigation item is current on a review page.',
  );

  // What it looks back on, plan-scoped like End Day.
  const back = section(page, 'Looking back');
  await back
    .getByRole('list', { name: 'Done in the week of November 22–28' })
    .getByRole('link', { name: T.seeds, exact: true })
    .waitFor();
  await back
    .getByRole('list', { name: 'Still open from the week of November 22–28' })
    .getByRole('link', { name: T.water, exact: true })
    .waitFor();
  await section(page, 'Inbox').getByRole('link', { name: 'Open Inbox', exact: true }).waitFor();

  // Decisions: pause the Project, an Axis note, a commitment, and the first day's focus.
  for (const title of [T.project, T.project2]) {
    assert(
      await projectChoice(page, title, 'Decide later').isChecked(),
      `${title} must start at "Decide later".`,
    );
    await section(page, 'Projects')
      .getByRole('group', { name: title, exact: true })
      .getByText('No next Action', { exact: true })
      .waitFor();
  }
  await projectChoice(page, T.project, 'Pause').check();
  await page.getByLabel(`What supported ${T.axis}?`, { exact: true }).fill(T.axisNote);

  const ahead = section(page, 'Next week');
  await ahead.getByText('Week of November 29 – December 5', { exact: true }).waitFor();
  await ahead.getByRole('heading', { level: 3, name: 'Capacity', exact: true }).waitFor();
  await ahead.getByRole('heading', { level: 3, name: 'Fixed work', exact: true }).waitFor();
  await ahead
    .getByRole('list', { name: 'Fixed work this week', exact: true })
    .locator('li')
    .filter({ hasText: T.meeting })
    .filter({ hasText: 'Tue, Dec 1' })
    .waitFor();
  const placeFixed = ahead.getByRole('link', { name: 'Place fixed work in Plan', exact: true });
  assert(
    (await placeFixed.getAttribute('href')) === `/plan/week/${NEXT_WEEK}`,
    'Place fixed work in Plan must open the planning week.',
  );

  const commitments = section(page, 'Commitments');
  assert(
    (await commitments.getByRole('checkbox', { checked: true }).count()) === 0,
    'No commitment may be preselected.',
  );
  await commitments
    .getByRole('group', { name: 'Actions', exact: true })
    .getByRole('checkbox', { name: T.fence, exact: true })
    .check();
  await commitments.getByText('1 of 3 chosen', { exact: true }).waitFor();
  const focus = weeklyFocus(page);
  assert(
    (await focus.getByRole('checkbox', { checked: true }).count()) === 0,
    'No first-day focus may be preselected.',
  );
  await focus
    .getByRole('group', { name: 'Flexible', exact: true })
    .getByRole('checkbox', { name: T.feeder, exact: true })
    .check();
  await focus.getByText('1 of 3 chosen', { exact: true }).waitFor();
  for (const question of [
    'What supported each Axis?',
    'What was unrealistic?',
    'What is fixed next week?',
  ])
    await section(page, 'Notes').getByText(question, { exact: true }).waitFor();
  await page.getByLabel('Notes (optional)', { exact: true }).fill(T.weekNote);
  await auditCopy(page, 'Weekly review (form)');
  await j.shot(page, 'weekly-review-form-1280x800');

  const save = button(page, 'Save for later');
  await press(page, save);
  await expectStatus(page, SAVED);
  await waitForFocus(page, save, { label: 'Save for later keeps focus on its button' });
  await expectFacts(page, 'Saved for later · Due today');
  j.checks.push(
    'weekly review from the Review card: the week looked back on, the Inbox, Projects with Decide later, an Axis note, next week’s capacity, fixed work, and the Place fixed work in Plan link; nothing preselected; Save for later',
  );

  // A fresh launch resumes the saved choices; Finish applies them in one command.
  ({ context, page } = await relaunch(j, seen, context, AT.weekLastLater));
  await visit(j, page, '/review');
  await expectCard(page, 'weekly', {
    period: weekWords,
    status: 'Saved for later',
    due: 'Due today',
    link: 'Resume review',
  });
  await openCard(j, page, 'weekly', 'Resume review', `/review/weekly/${WEEK1}`);
  await expectWeeklyChoices(page, 'After a fresh launch');
  // A double-click finishes once (verification contract): the second click finds the review busy.
  const finish = button(page, 'Finish review');
  await poll(
    async () => (await idle(page)) && (await finish.getAttribute('aria-disabled')) !== 'true',
    'Finish review must be enabled.',
  );
  await finish.dblclick();
  await expectStatus(page, 'Review finished.');
  await expectHeadingFocus(page, 'Finish review (weekly)');
  assert(
    (await main(page).getByRole('alert').count()) === 0,
    'A double-click on Finish review must not show a refusal.',
  );
  await button(page, 'Undo').waitFor();
  await page
    .getByText(
      /^Finished Saturday, November 28, 2026 at \d{1,2}:\d{2} AM\. Its decisions are kept here\.$/u,
    )
    .waitFor();
  await section(page, 'Decisions')
    .getByRole('list', { name: 'Decisions' })
    .locator('li')
    .filter({ hasText: `${T.project} · Paused` })
    .waitFor();
  await auditCopy(page, 'Weekly review (finished)');
  await j.shot(page, 'weekly-review-finished-1280x800');

  // The plan: the Project is paused, the commitment is in Plan Week, the first day has its focus,
  // the Axis shows its recent review note, and Today's notice is gone.
  await expectObjectState(j, page, `/projects/${ids.project}`, 'Project', 'Paused');
  await visit(j, page, `/plan/week/${NEXT_WEEK}`);
  await page
    .getByRole('list', { name: 'This week’s commitments' })
    .getByText(T.fence)
    .first()
    .waitFor();
  await visit(j, page, `/axis/${ids.axis}`);
  const note = section(page, 'Recent review note');
  await note.getByText(T.axisNote, { exact: true }).waitFor();
  await note.getByText(`From the weekly review of November 22–28`, { exact: false }).waitFor();
  assert(
    (await note.getByRole('link', { name: 'Open this review' }).getAttribute('href')) ===
      `/review/weekly/${WEEK1}`,
    'The Axis note links to its review.',
  );
  await auditCopy(page, 'Axis page (recent review note)');
  await visit(j, page, '/');
  await expectNoNotice(page, 'Today after the weekly review');
  await nextDay(j, page, NEXT_WEEK);
  await rowOf(focusList(page), T.feeder).waitFor();
  j.checks.push(
    'a fresh launch resumes every weekly choice; Finish pauses the Project, commits the Action in Plan Week, sets the first day’s focus, shows the Axis "Recent review note" with its period and link, and the Today notice is gone',
  );
  return { context, page };
}

/* ───────────────────────── 4. Monthly review ───────────────────────── */

function outcomeChoice(page, choice) {
  return section(page, 'Outcomes')
    .getByRole('group', { name: T.outcome, exact: true })
    .getByRole('radio', { name: choice, exact: true });
}

async function verifyMonthlyReview(j, seen, context) {
  let page;
  ({ context, page } = await relaunch(j, seen, context, AT.monthLast));
  await visit(j, page, '/');
  await expectNotice(page, 'Your monthly review is ready.');
  await openReview(page);
  await expectCard(page, 'monthly', {
    period: 'November 2026',
    status: 'Not started',
    due: 'Due today',
    link: 'Start review',
  });
  // The settled weekly review hands over to the current week, which may be started early.
  await expectCard(page, 'weekly', {
    period: 'Week of November 29 – December 5',
    status: 'Not started',
    due: `Due ${dayWords('2026-12-05')}`,
    link: 'Start early',
  });
  await openCard(j, page, 'monthly', 'Start review', '/review/monthly/2026-11');
  await heading1(page, 'Monthly review');
  await expectFacts(page, 'Not started · Due today');

  assert(
    await outcomeChoice(page, 'Decide later').isChecked(),
    'The Outcome starts at Decide later.',
  );
  await outcomeChoice(page, 'Pause').check();
  await section(page, 'Milestones')
    .getByText('No Milestones are active.', { exact: true })
    .waitFor();
  // A paused Project is listed, but Pause is not offered again.
  const paused = section(page, 'Projects').getByRole('group', { name: T.project, exact: true });
  await paused.getByRole('radio', { name: 'Continue', exact: true }).waitFor();
  assert(
    (await paused.getByRole('radio', { name: 'Pause', exact: true }).count()) === 0,
    'A paused Project must not be offered Pause.',
  );
  const theme = section(page, 'Theme for December 2026');
  await theme.getByText('No theme is set for December 2026.', { exact: true }).waitFor();
  await page.getByLabel('New theme (optional)', { exact: true }).fill(T.theme);
  assert(
    (await theme.getByRole('link', { name: 'Open December 2026 in Plan' }).getAttribute('href')) ===
      '/plan/month/2026-12-01',
    'The theme section links to the month in Plan.',
  );
  for (const question of ['Which outcomes moved?', 'What changed?', 'What should pause or stop?'])
    await section(page, 'Notes').getByText(question, { exact: true }).waitFor();
  await auditCopy(page, 'Monthly review (form)');
  await press(page, button(page, 'Save for later'));
  await expectStatus(page, SAVED);

  // Skip with unsaved changes asks first; Escape keeps editing and returns focus to Skip.
  await page.getByLabel('Notes (optional)', { exact: true }).fill(T.unsaved);
  const skip = button(page, 'Skip this review');
  await press(page, skip);
  const confirm = page.getByRole('dialog', { name: 'Skip this review?' });
  await confirm.waitFor();
  await confirm
    .getByText(
      'Your unsaved changes will not be kept. Skipping changes nothing in your plan, and you can undo it.',
      { exact: true },
    )
    .waitFor();
  await waitForFocus(page, confirm.getByRole('button', { name: 'Continue editing' }), {
    label: 'The Skip dialog starts on Continue editing',
  });
  await page.keyboard.press('Escape');
  await confirm.waitFor({ state: 'hidden' });
  await waitForFocus(page, skip, { label: 'Escape returns focus to Skip this review' });
  assert(
    (await page.getByLabel('Notes (optional)', { exact: true }).inputValue()) === T.unsaved,
    'Continue editing keeps the unsaved words.',
  );
  await press(page, skip);
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Skip without saving', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await expectStatus(page, 'Review skipped.');
  await expectHeadingFocus(page, 'Skip (monthly)');
  await button(page, 'Undo').waitFor();
  await page
    .getByText(
      'You skipped this review. Nothing in your plan was changed, and the choices you saved are kept.',
      { exact: true },
    )
    .waitFor();
  await section(page, 'Theme').getByText(`Theme chosen: ${T.theme}`, { exact: true }).waitFor();
  await section(page, 'Decisions')
    .locator('li')
    .filter({ hasText: `${T.outcome} · Pause` })
    .waitFor();
  await section(page, 'Notes').getByText('No notes were written.', { exact: true }).waitFor();
  await auditCopy(page, 'Monthly review (skipped)');
  await j.shot(page, 'monthly-review-skipped-1280x800');

  // Skipping applied nothing, and the notice is gone.
  await visit(j, page, '/plan/month/2026-12-01');
  await section(page, 'Month theme')
    .getByText('No theme set for December 2026. It is optional.', { exact: true })
    .waitFor();
  await expectObjectState(j, page, `/outcomes/${ids.outcome}`, 'Outcome', 'Active');
  await visit(j, page, '/');
  await expectNoNotice(page, 'Today after skipping the monthly review');
  j.checks.push(
    'monthly review: an Outcome decision and next month’s theme saved; Skip with unsaved changes asks first (Escape returns focus to Skip); Skip keeps only saved choices, applies nothing, and clears the notice',
  );

  // Resume from Review, then Finish.
  await openReview(page);
  await expectCard(page, 'monthly', {
    period: 'November 2026',
    status: 'Skipped',
    due: null,
    link: 'Open review',
  });
  await openCard(j, page, 'monthly', 'Open review', '/review/monthly/2026-11');
  await expectFacts(page, 'Skipped');
  await press(page, button(page, 'Resume review'));
  await outcomeChoice(page, 'Pause').waitFor();
  await poll(
    () => outcomeChoice(page, 'Pause').isChecked(),
    'Resume restores the Outcome decision.',
  );
  const themeText = await page.getByLabel('New theme (optional)', { exact: true }).inputValue();
  assert(themeText === T.theme, `Resume restores the theme (found "${themeText}").`);
  assert(
    (await button(page, 'Skip this review').count()) === 0,
    'A skipped review can be finished or saved, not skipped again.',
  );
  await press(page, button(page, 'Finish review'));
  await expectStatus(page, 'Review finished.');
  await expectHeadingFocus(page, 'Finish review (monthly)');
  await section(page, 'Decisions')
    .locator('li')
    .filter({ hasText: `${T.outcome} · Paused` })
    .waitFor();
  await visit(j, page, '/plan/month/2026-12-01');
  await expectExactText(
    section(page, 'Month theme').locator('.theme-text'),
    T.theme,
    'The December theme in Plan Month',
  );
  await expectObjectState(j, page, `/outcomes/${ids.outcome}`, 'Outcome', 'Paused');
  j.checks.push(
    'the skipped monthly review is resumed from its Review card with its choices; Finish pauses the Outcome and the theme shows in Plan Month for December 2026',
  );
  return { context, page };
}

/* ───────────────────────── 5. Yearly review ───────────────────────── */

async function verifyYearlyReview(j, seen, context) {
  let page;
  ({ context, page } = await relaunch(j, seen, context, AT.yearLast));
  await visit(j, page, '/');
  await expectNotice(page, 'Your weekly, monthly, and yearly reviews are ready.');
  await openReview(page);
  await expectCard(page, 'weekly', {
    period: 'Week of December 20–26',
    status: 'Not started',
    due: 'Ready when you are',
    link: 'Start review',
  });
  await expectCard(page, 'monthly', {
    period: 'December 2026',
    status: 'Not started',
    due: 'Due today',
    link: 'Start review',
  });
  await expectCard(page, 'yearly', {
    period: '2026',
    status: 'Not started',
    due: 'Due today',
    link: 'Start review',
  });
  await openCard(j, page, 'yearly', 'Start review', '/review/yearly/2026');
  await heading1(page, 'Yearly review');
  for (const question of [
    'What mattered?',
    'What should continue?',
    'Which direction is now outdated?',
  ])
    await section(page, 'Retrospective').getByText(question, { exact: true }).waitFor();
  // The paused Outcome is listed with the decisions its state allows.
  const outcome = section(page, 'Outcomes').getByRole('group', { name: T.outcome, exact: true });
  for (const choice of ['Decide later', 'Continue', 'Achieved', 'Abandon', 'Archive'])
    await outcome.getByRole('radio', { name: choice, exact: true }).waitFor();
  const direction = section(page, 'Direction');
  await direction.getByText('No direction was written for 2026.', { exact: true }).waitFor();
  const choices = direction.getByRole('group', {
    name: 'What happens to this direction in 2027?',
    exact: true,
  });
  const offered = await choices
    .getByRole('radio')
    .evaluateAll((radios) => radios.map((radio) => radio.labels?.[0]?.textContent?.trim() ?? ''));
  assert(
    offered.join('|') === 'Decide later|Write a new direction',
    `With no direction to continue, only a new one is offered (found ${offered.join(', ')}).`,
  );

  // Longer text is refused, never truncated, and nothing is saved .
  const retro = page.getByLabel('Retrospective (optional)', { exact: true });
  await retro.fill('x'.repeat(10_001));
  await section(page, 'Retrospective')
    .getByText('10,001 of 10,000 characters. Shorten it by 1 to save.', { exact: true })
    .waitFor();
  await press(page, button(page, 'Finish review'));
  const refusal = main(page).getByRole('alert').filter({
    hasText:
      'Your retrospective notes are over the 10,000-character limit. Shorten them to continue; nothing was saved.',
  });
  await refusal.waitFor();
  await waitForFocus(page, refusal, { label: 'A refusal moves focus to its reason' });
  assert((await retro.inputValue()).length === 10_001, 'Refused text must be kept as written.');
  await expectFacts(page, 'Not started · Due today');
  await retro.fill('');
  j.checks.push(
    'a 10,001-character retrospective is refused with focus on the reason; the text is kept and nothing is saved',
  );

  // A keyboard-only path from a fresh load: the skip link, then write, choose a new direction,
  // and Finish review.
  await visit(j, page, '/review/yearly/2026');
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to content', exact: true });
  await waitForFocus(page, skipLink, { label: 'The first Tab stop is the skip link' });
  await page.keyboard.press('Enter');
  await waitForFocus(page, main(page), { label: 'The skip link moves focus to the main content' });
  await tabTo(page, retro);
  await page.keyboard.type(T.retro);
  await tabTo(page, choices.getByRole('radio', { name: 'Decide later', exact: true }));
  await page.keyboard.press('ArrowDown');
  await poll(
    () => choices.getByRole('radio', { name: 'Write a new direction', exact: true }).isChecked(),
    'ArrowDown chooses "Write a new direction".',
  );
  const newDirection = page.getByLabel('New direction for 2027', { exact: true });
  await tabTo(page, newDirection);
  await page.keyboard.type(T.direction);
  await auditCopy(page, 'Yearly review (form)');
  await j.shot(page, 'yearly-review-form-1280x800');
  await tabTo(page, button(page, 'Finish review'));
  await page.keyboard.press('Enter');
  await expectStatus(page, 'Review finished.');
  await expectHeadingFocus(page, 'Finish review by keyboard (yearly)');
  await section(page, 'Direction')
    .getByText(`New direction: ${T.direction}`, { exact: true })
    .waitFor();
  await section(page, 'Retrospective').getByText(T.retro, { exact: true }).waitFor();
  await auditCopy(page, 'Yearly review (finished)');
  await visit(j, page, '/plan/year/2027-01-01');
  await expectExactText(
    section(page, 'Year direction').locator('.theme-text'),
    T.direction,
    'The 2027 direction in Plan Year',
  );
  j.checks.push(
    'yearly review by keyboard alone: Tab to the retrospective, ArrowDown to "Write a new direction", Tab to Finish review and Enter; focus lands on the heading; the direction shows in Plan Year 2027',
  );
  return { context, page };
}

/* ───────────────────────── 6. History ───────────────────────── */

async function verifyHistory(j, page) {
  await visit(j, page, '/review');
  const list = historyList(page);
  const daily = `${longDate(DAY1)} (daily review)`;
  const weekly = `${weekWords} (weekly review)`;
  const monthly = 'November 2026 (monthly review)';
  const yearly = '2026 (yearly review)';
  await expectRows(list, [daily, weekly, monthly, yearly], 'History, newest period first');
  for (const [name, pattern] of [
    [weekly, /^Weekly review · Done · 4 decisions · Finished Saturday, November 28, 2026 at /u],
    [monthly, /^Monthly review · Done · 1 decision · Finished Monday, November 30, 2026 at /u],
    [yearly, /^Yearly review · Done · Finished Thursday, December 31, 2026 at /u],
  ]) {
    const facts = await rowFacts(list, name);
    assert(pattern.test(facts), `History facts for ${name}: found "${facts}".`);
  }
  const filter = section(page, 'History').getByRole('group', { name: 'Review type', exact: true });
  for (const [label, expected] of [
    ['Daily', [daily]],
    ['Weekly', [weekly]],
    ['Monthly', [monthly]],
    ['Yearly', [yearly]],
    ['All', [daily, weekly, monthly, yearly]],
  ]) {
    await filter.getByRole('radio', { name: label, exact: true }).check();
    await expectRows(list, expected, `History filtered to ${label}`);
  }
  await auditCopy(page, 'Review overview (history)');
  await j.shot(page, 'review-history-1280x800');
  j.checks.push(
    'history lists the daily, weekly, monthly, and yearly reviews newest period first with calm facts; the type filter shows each type alone and All again',
  );

  // Opening a finished review shows its decisions, read-only.
  await list.getByRole('link', { name: weekly, exact: true }).click();
  await arrive(j, page, `/review/weekly/${WEEK1}`, 'Weekly review');
  await expectFacts(page, 'Done');
  await section(page, 'Decisions')
    .locator('li')
    .filter({ hasText: `${T.project} · Paused` })
    .waitFor();
  await section(page, 'Commitments')
    .getByRole('list', { name: 'Commitments' })
    .getByText(T.fence, { exact: true })
    .waitFor();
  await section(page, 'Focus')
    .getByRole('list', { name: 'Focus' })
    .getByText(T.feeder, { exact: true })
    .waitFor();
  const axisNotes = section(page, 'What supported each Axis').getByRole('list', {
    name: 'Axis notes',
  });
  await axisNotes.getByText(T.axis, { exact: true }).waitFor();
  await axisNotes.getByText(T.axisNote, { exact: true }).waitFor();
  await section(page, 'Notes').getByText(T.weekNote, { exact: true }).waitFor();
  assert(
    (await button(page, 'Finish review').count()) === 0 &&
      (await page.locator('main textarea, main input').count()) === 0,
    'A finished review is read-only.',
  );
  await main(page).getByRole('link', { name: 'Back to Review', exact: true }).click();
  await arrive(j, page, '/review', 'Review');
  await list.getByRole('link', { name: monthly, exact: true }).click();
  await arrive(j, page, '/review/monthly/2026-11', 'Monthly review');
  await section(page, 'Theme').getByText(`Theme chosen: ${T.theme}`, { exact: true }).waitFor();
  await section(page, 'Decisions')
    .locator('li')
    .filter({ hasText: `${T.outcome} · Paused` })
    .waitFor();
  await page.goBack();
  await arrive(j, page, '/review', 'Review');
  await list.getByRole('link', { name: daily, exact: true }).click();
  await arrive(j, page, `/end-day/${DAY1}`, 'End day');
  await page.getByRole('list', { name: `Decisions for ${longDate(DAY1)}` }).waitFor();
  j.checks.push(
    'opening finished reviews from history shows their decisions read-only: Paused, the commitment, focus, the Axis note, the theme, and the daily decisions',
  );
}

/* ───────────────────────── 7. Planning-zone change with a draft ───────────────────────── */

async function verifyZoneChange(j, seen, context) {
  let page;
  // Friday night in New York: the previous week is the weekly checkpoint.
  ({ context, page } = await relaunch(j, seen, context, AT.newYearNight));
  await visit(j, page, '/review');
  await expectCard(page, 'weekly', {
    period: draftWeek,
    status: 'Not started',
    due: 'Ready when you are',
    link: 'Start review',
  });
  await openCard(j, page, 'weekly', 'Start review', `/review/weekly/${DRAFT_WEEK}`);
  await expectEyebrow(page, draftWeek);
  // The week that has already started is planned , with today's focus.
  await section(page, 'This week').waitFor();
  await section(page, `Focus for ${dayWords('2027-01-01')}`).waitFor();
  assert(
    (await section(page, 'Projects')
      .getByRole('group', { name: T.project, exact: true })
      .count()) === 0,
    'A paused Project is not offered in the weekly review.',
  );
  await projectChoice(page, T.project2, 'Pause').check();
  await page.getByLabel(`What supported ${T.axis}?`, { exact: true }).fill(T.draftAxisNote);
  await press(page, button(page, 'Save for later'));
  await expectStatus(page, SAVED);
  await visit(j, page, '/review');
  const draftName = `${draftWeek} (weekly review)`;
  const draftFacts = await rowFacts(historyList(page), draftName);
  assert(
    draftFacts === 'Weekly review · Saved for later · 2 decisions',
    `The draft is listed with its two decisions (found "${draftFacts}").`,
  );

  // The device now reports Tokyo: the plan does not change until the person chooses.
  ({ context, page } = await relaunch(j, seen, context, AT.tokyo, TOKYO));
  await visit(j, page, '/review');
  const zoneNotice = page.getByText(
    'Your device is set to Asia/Tokyo. Your plan uses America/New York.',
  );
  await zoneNotice.waitFor();
  await expectCard(page, 'weekly', {
    period: draftWeek,
    status: 'Saved for later',
    due: 'Ready when you are',
    link: 'Resume review',
  });
  await page.getByRole('button', { name: 'Review a change to Asia/Tokyo…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the planning zone?' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Change to Asia/Tokyo', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('Planning time zone changed to Asia/Tokyo.').first().waitFor();
  await zoneNotice.waitFor({ state: 'hidden' });

  // Planning today is now Saturday January 2: the current week is due, and the draft keeps its week.
  await visit(j, page, '/');
  await eyebrow(page, 'Today', TOKYO_DAY).waitFor();
  await expectNotice(page, 'Your weekly and monthly reviews are ready.');
  await openReview(page);
  await expectCard(page, 'weekly', {
    period: zoneWeek,
    status: 'Not started',
    due: 'Due today',
    link: 'Start review',
  });
  const inProgress = section(page, 'In progress').getByRole('list', {
    name: 'Reviews in progress',
  });
  await expectRows(inProgress, [draftName], 'In progress after the zone change');
  assert(
    (await rowFacts(inProgress, draftName)) === 'Weekly review · Saved for later · 2 decisions',
    'The draft keeps exactly its two decisions after the zone change.',
  );
  await inProgress.getByRole('link', { name: draftName, exact: true }).click();
  await arrive(j, page, `/review/weekly/${DRAFT_WEEK}`, 'Weekly review');
  await expectEyebrow(page, draftWeek);
  await expectFacts(page, 'Saved for later · Ready when you are');
  await main(page)
    .getByText(
      'This review is for the week of December 20–26, 2026. The current weekly review is for the week of December 27, 2026 – January 2, 2027.',
      { exact: true },
    )
    .waitFor();
  const current = main(page).getByRole('link', {
    name: 'Open the current weekly review',
    exact: true,
  });
  assert(
    (await current.getAttribute('href')) === `/review/weekly/${ZONE_WEEK}`,
    'The draft links to the current weekly checkpoint.',
  );
  await poll(
    () => projectChoice(page, T.project2, 'Pause').isChecked(),
    'The draft keeps its Project decision after the zone change.',
  );
  assert(
    (await page.getByLabel(`What supported ${T.axis}?`, { exact: true }).inputValue()) ===
      T.draftAxisNote,
    'The draft keeps its Axis note after the zone change.',
  );
  await auditCopy(page, 'Weekly review (draft of another period)');
  await j.shot(page, 'weekly-review-other-period-1280x800');
  // Saving the same choices again writes nothing and says so calmly, with focus on the reason.
  await press(page, button(page, 'Save for later'));
  const nothing = main(page)
    .getByRole('alert')
    .filter({ hasText: /^Nothing changed\.$/u });
  await nothing.waitFor();
  await waitForFocus(page, nothing, { label: 'An unchanged Save moves focus to its reason' });
  // An edited note updates its one item: one decision per target and slot in the period.
  const axisNote = page.getByLabel(`What supported ${T.axis}?`, { exact: true });
  await axisNote.fill(T.draftAxisNoteEdited);
  await press(page, button(page, 'Save for later'));
  await expectStatus(page, SAVED);
  await current.click();
  await page.waitForURL(`${j.origin}/review/weekly/${ZONE_WEEK}`);
  // Both pages are a "Weekly review": wait for the current week's own period, then its reads.
  await expectEyebrow(page, zoneWeek);
  await settle(page);
  await expectFacts(page, 'Not started · Due today');
  assert(
    await projectChoice(page, T.project2, 'Decide later').isChecked(),
    'The current week has none of the draft’s decisions.',
  );
  assert(
    (await page.getByLabel(`What supported ${T.axis}?`, { exact: true }).inputValue()) === '',
    'The current week has none of the draft’s notes.',
  );
  await visit(j, page, '/review');
  await expectRows(inProgress, [draftName], 'In progress after saving the draft again');
  assert(
    (await rowFacts(inProgress, draftName)) === 'Weekly review · Saved for later · 2 decisions',
    'Saving the draft again duplicates no decision.',
  );
  j.checks.push(
    'zone change during a draft (New York → Tokyo): the draft keeps its week and decisions, is listed In progress, and links to the current checkpoint, which starts empty; an unchanged Save says "Nothing changed." with focus on it, and an edited note stays one of 2 decisions',
  );

  // Finishing the draft applies each decision once.
  await visit(j, page, `/review/weekly/${DRAFT_WEEK}`);
  assert(
    (await page.getByLabel(`What supported ${T.axis}?`, { exact: true }).inputValue()) ===
      T.draftAxisNoteEdited,
    'The edited note is the saved one.',
  );
  await press(page, button(page, 'Finish review'));
  await expectStatus(page, 'Review finished.');
  await section(page, 'Decisions')
    .locator('li')
    .filter({ hasText: `${T.project2} · Paused` })
    .waitFor();
  await expectObjectState(j, page, `/projects/${ids.project2}`, 'Project', 'Paused');
  await visit(j, page, '/review');
  // The week appears once in history; the current week was only opened, so it is not listed.
  await expectRows(
    historyList(page),
    [
      draftName,
      `${longDate(DAY1)} (daily review)`,
      'Week of November 22–28, 2026 (weekly review)',
      'November 2026 (monthly review)',
      '2026 (yearly review)',
    ],
    'History after finishing the draft',
  );
  const finishedFacts = await rowFacts(historyList(page), draftName);
  assert(
    /^Weekly review · Done · 2 decisions · Finished Saturday, January 2, 2027 at \d{1,2}:\d{2} AM$/u.test(
      finishedFacts,
    ),
    `The finished draft keeps its two decisions (found "${finishedFacts}").`,
  );
  j.checks.push(
    'finishing the draft of the earlier week pauses its Project once; history lists that week once with 2 decisions',
  );
  return { context, page };
}

/* ───────────────────────── 8. Permanent delete keeps review decisions ───────────────────────── */

/** The page's whole visible text, whitespace collapsed. */
async function pageText(page) {
  return (await page.locator('body').innerText()).replace(/\s+/gu, ' ');
}

/** A deleted object's title appears nowhere on the page (no deleted title is copied). */
async function expectTitleGone(page, title, label) {
  const text = await pageText(page);
  assert(!text.includes(title), `${label} still shows the deleted title "${title}".`);
}

/** The daily row and the first weekly row of history with their unchanged decision counts. */
async function expectHistoryCounts(j, page, label) {
  await visit(j, page, '/review');
  const list = historyList(page);
  const daily = await rowFacts(list, `${longDate(DAY1)} (daily review)`);
  assert(
    daily.startsWith('Daily review · Done · Energy: Medium · 3 decisions · '),
    `${label}: the daily review keeps 3 decisions (found "${daily}").`,
  );
  const weekly = await rowFacts(list, 'Week of November 22–28, 2026 (weekly review)');
  assert(
    weekly.startsWith('Weekly review · Done · 4 decisions · '),
    `${label}: the weekly review keeps 4 decisions (found "${weekly}").`,
  );
}

async function verifyDeleteKeepsDecisions(j, page) {
  await expectHistoryCounts(j, page, 'Before the deletes');

  // The Action the daily review carried and chose as the carry day's focus; it is still planned
  // on November 24.
  await visit(j, page, `/plan/day/${CARRY_DAY}`);
  await main(page).getByRole('link', { name: T.water, exact: true }).first().waitFor();
  await visit(j, page, `/actions/${ids.water}`);
  await heading1(page, T.water);
  await main(page).getByRole('button', { name: 'Delete permanently…', exact: true }).click();
  const actionDialog = page.getByRole('dialog', { name: 'Permanently delete Action?' });
  await actionDialog.waitFor();
  // label: actions-ui.tsx delete dialog
  await actionDialog
    .getByText('Review decisions about it stay in history as “Deleted object”.', { exact: true })
    .waitFor();
  const deleteAction = actionDialog.getByRole('button', {
    name: 'Delete permanently',
    exact: true,
  });
  assert(await deleteAction.isDisabled(), 'Delete stays disabled until the title matches.');
  await actionDialog.getByLabel('Action title', { exact: true }).fill(T.water);
  await deleteAction.click();
  await page.waitForURL(`${j.origin}/inbox`);
  await settle(page);
  // The deleted Action's page is unavailable and has nothing unsaved, so leaving it asks nothing.
  await visit(j, page, `/actions/${ids.water}`);
  await heading1(page, 'This Action is unavailable.');
  await visit(j, page, `/plan/day/${CARRY_DAY}`);
  await expectTitleGone(page, T.water, 'Plan Day for November 24 after the delete');
  j.checks.push(
    'permanent delete of an Action the daily review decided is allowed; its dialog says review decisions stay as "Deleted object", and the Action leaves its planned day',
  );

  // The Project the weekly review paused.
  await visit(j, page, `/projects/${ids.project}`);
  await heading1(page, T.project);
  await main(page).getByRole('button', { name: 'Delete permanently…', exact: true }).click();
  const projectDialog = page.getByRole('dialog', { name: 'Delete this Project permanently?' });
  await projectDialog.waitFor();
  // label: lifecycle-dialogs.tsx keptReviewsText
  await projectDialog
    .getByText('1 review decision about it stays in history as “Deleted object”.', {
      exact: true,
    })
    .waitFor();
  assert(
    (await projectDialog.getByText('It cannot be deleted permanently yet:').count()) === 0,
    'A review decision must not block deleting the Project.',
  );
  // Its link to the Axis is optional and is removed only when chosen (alignment delete rules).
  const removeLinks = projectDialog.getByLabel('Also remove optional links and placements');
  const continueButton = projectDialog.getByRole('button', { name: 'Continue', exact: true });
  if ((await continueButton.count()) === 0 && (await removeLinks.count()) > 0) {
    await removeLinks.check();
    await continueButton.waitFor();
  }
  await continueButton.click();
  const confirmation = projectDialog.getByLabel('Type the Project title to confirm');
  await confirmation.waitFor();
  const deleteProject = projectDialog.getByRole('button', {
    name: 'Delete permanently',
    exact: true,
  });
  assert(await deleteProject.isDisabled(), 'Delete stays disabled until the title matches.');
  await confirmation.fill(T.project);
  await deleteProject.click();
  await projectDialog.waitFor({ state: 'hidden' });
  await page.getByText('Project deleted.').first().waitFor();
  await visit(j, page, `/projects/${ids.project}`);
  await heading1(page, 'This Project is unavailable');
  j.checks.push(
    'permanent delete of a Project the weekly review paused is allowed; its dialog says "1 review decision about it stays in history as “Deleted object”."',
  );

  // History keeps the decisions as "Deleted object", and no deleted title is shown.
  await visit(j, page, `/end-day/${DAY1}`);
  const decisions = page.getByRole('list', { name: `Decisions for ${longDate(DAY1)}` });
  await decisions.locator('li').filter({ hasText: 'Deleted object · Carried' }).waitFor();
  await decisions
    .locator('li')
    .filter({ hasText: `${T.seeds} · Completed` })
    .waitFor();
  await section(page, 'Focus chosen')
    .getByRole('list', { name: 'Focus chosen' })
    .getByText('Deleted object', { exact: true })
    .waitFor();
  await expectTitleGone(page, T.water, 'The End Day summary');
  await auditCopy(page, 'End Day (finished, with a deleted object)');
  await j.shot(page, 'end-day-deleted-object-1280x800');

  await visit(j, page, `/review/weekly/${WEEK1}`);
  await section(page, 'Decisions')
    .getByRole('list', { name: 'Decisions' })
    .locator('li')
    .filter({ hasText: 'Deleted object · Paused' })
    .waitFor();
  await expectTitleGone(page, T.project, 'The finished weekly review');
  await auditCopy(page, 'Weekly review (finished, with a deleted object)');
  await j.shot(page, 'weekly-review-deleted-object-1280x800');

  await expectHistoryCounts(j, page, 'After the deletes');
  for (const title of [T.water, T.project]) await expectTitleGone(page, title, 'Review history');
  j.checks.push(
    'after the deletes, End Day shows "Deleted object · Carried" and a "Deleted object" focus, the weekly review shows "Deleted object · Paused", no deleted title appears on those pages or in history, and history still counts 3 and 4 decisions',
  );
}

/* ───────────────────────── 9. Reminder definitions ───────────────────────── */

/** A time block's card on a Plan or Today timeline, found by its own title. */
function blockCard(page, title) {
  return main(page)
    .locator('.timed-entry')
    .filter({ has: page.locator('.entry-title', { hasText: title }) });
}

/** label: the card's "Options" disclosure and one of its block controls ("Move… {title}"). */
async function chooseBlockOption(page, title, option) {
  const card = blockCard(page, title);
  await card.waitFor();
  const details = card.locator('details.entry-options');
  if (!(await details.evaluate((element) => element.open)))
    await details.locator('summary').click();
  await press(
    page,
    card.getByRole('button', { name: new RegExp(`^${escapeRegExp(option)}`, 'u') }),
  );
}

/** label: dialog "Reminder for “{title}”", read before its form shows (scheduling-dialogs.tsx). */
async function openBlockReminder(page) {
  await chooseBlockOption(page, T.block, 'Reminder…');
  const dialog = page.getByRole('dialog', { name: `Reminder for “${T.block}”` });
  await dialog.getByRole('button', { name: 'Save reminder', exact: true }).waitFor();
  return dialog;
}

function reminderChoice(dialog, name) {
  return dialog
    .getByRole('group', { name: 'Reminder', exact: true })
    .getByRole('radio', { name, exact: true });
}

/** The block's reminder dialog shows the saved choice: "at" with its date and time, or minutes. */
async function expectBlockReminder(page, expected, label) {
  const dialog = await openBlockReminder(page);
  await poll(
    () => reminderChoice(dialog, expected.choice).isChecked(),
    `${label}: the reminder must read "${expected.choice}".`,
  );
  if (expected.choice === 'At a time') {
    const date = await dialog.getByLabel('Reminder date', { exact: true }).inputValue();
    const time = await dialog.getByLabel('Reminder time', { exact: true }).inputValue();
    assert(
      date === expected.date && time === expected.time,
      `${label}: the reminder must stay at ${expected.date} ${expected.time} (found ${date} ${time}).`,
    );
  } else {
    const minutes = await dialog.getByLabel(/^Minutes before the start/u).inputValue();
    assert(
      minutes === expected.minutes,
      `${label}: the reminder must be ${expected.minutes} minutes before (found ${minutes}).`,
    );
    await dialog.getByText(`The block starts ${expected.start}.`, { exact: false }).waitFor();
  }
  await dialog.getByText(REMINDER_COPY, { exact: true }).waitFor();
  return dialog;
}

async function closeDialog(dialog) {
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function moveBlock(page, start) {
  await chooseBlockOption(page, T.block, 'Move…');
  const move = page.getByRole('dialog', { name: `Move “${T.block}”` });
  await move.waitFor();
  // label: MoveBlockForm scope note
  await move
    .getByText(
      'If this block has a reminder, it moves with it. A reminder before the start counts from the new start; a reminder at a set time keeps that time.',
      { exact: true },
    )
    .waitFor();
  await move.getByLabel('Start time', { exact: true }).fill(start);
  await move.getByRole('button', { name: 'Move', exact: true }).click();
  await move.waitFor({ state: 'hidden' });
  await page.getByText('Time block moved.').first().waitFor();
  await poll(() => idle(page), 'Plan Day must finish re-reading after the move.');
}

function routineReminderSection(page) {
  return section(page, 'Reminder');
}

async function verifyReminders(j, seen, context, page) {
  // A custom time block, 10:00 to 11:00 on Tuesday January 5 (planning zone Asia/Tokyo).
  await visit(j, page, `/plan/day/${BLOCK_DAY}`);
  await page.getByRole('button', { name: 'Add time block' }).first().click();
  const add = page.getByRole('dialog', { name: 'Add a time block' });
  await add.waitFor();
  await add.locator('#custom-block-title').fill(T.block);
  await add.getByLabel('Date', { exact: true }).fill(BLOCK_DAY);
  await add.getByLabel('Start time', { exact: true }).fill('10:00');
  await add.getByLabel(/^Duration \(minutes\)/u).fill('60');
  await add.getByRole('button', { name: 'Add time block' }).click();
  await add.waitFor({ state: 'hidden' });
  await page.getByText('Time block added.').first().waitFor();

  // At a time: 9:00 AM on the block's day.
  let dialog = await openBlockReminder(page);
  await dialog.getByText(REMINDER_COPY, { exact: true }).waitFor();
  await dialog
    .getByText('Times are in your planning time zone, Asia/Tokyo.', { exact: true })
    .waitFor();
  assert(
    await reminderChoice(dialog, 'Off').isChecked(),
    'A new block starts with its reminder Off.',
  );
  await auditCopy(page, 'Time block reminder dialog');
  await reminderChoice(dialog, 'At a time').check();
  await dialog.getByLabel('Reminder date', { exact: true }).fill(BLOCK_DAY);
  await dialog.getByLabel('Reminder time', { exact: true }).fill('09:00');
  await j.shot(page, 'block-reminder-at-1280x800');
  await dialog.getByRole('button', { name: 'Save reminder', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('Reminder saved.').first().waitFor();

  // Moving the block keeps a reminder at a set time where it is.
  await moveBlock(page, '13:00');
  dialog = await expectBlockReminder(
    page,
    { choice: 'At a time', date: BLOCK_DAY, time: '09:00' },
    'After a move',
  );
  j.checks.push(
    'a time block reminder "At a time" is saved from Options → Reminder…; after Move the dialog still reads 9:00 AM on January 5 (a fixed time stays fixed)',
  );

  // Before the start: 30 minutes, then shorten and move the block.
  await reminderChoice(dialog, 'Before the start').check();
  await dialog.getByLabel(/^Minutes before the start/u).fill('30');
  await dialog.getByText('The block starts Tue, Jan 5, 1:00 PM.', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Save reminder', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('Reminder saved.').first().waitFor();
  await poll(() => idle(page), 'Plan Day must finish re-reading after the reminder.');

  await chooseBlockOption(page, T.block, 'Shorten…');
  const shorten = page.getByRole('dialog', { name: `Shorten “${T.block}”` });
  await shorten.waitFor();
  await shorten
    .getByText('If this block has a reminder, it stays with the shorter block.', { exact: true })
    .waitFor();
  await shorten.getByLabel(/^New duration \(minutes\)/u).fill('30');
  await shorten.getByRole('button', { name: 'Shorten', exact: true }).click();
  await shorten.waitFor({ state: 'hidden' });
  await page.getByText('Time block shortened.').first().waitFor();
  await poll(() => idle(page), 'Plan Day must finish re-reading after shortening.');
  dialog = await expectBlockReminder(
    page,
    { choice: 'Before the start', minutes: '30', start: 'Tue, Jan 5, 1:00 PM' },
    'After shortening',
  );
  await closeDialog(dialog);

  await moveBlock(page, '15:00');
  dialog = await expectBlockReminder(
    page,
    { choice: 'Before the start', minutes: '30', start: 'Tue, Jan 5, 3:00 PM' },
    'After the second move',
  );
  await j.shot(page, 'block-reminder-relative-after-move-1280x800');
  await closeDialog(dialog);
  j.checks.push(
    'switched to "Before the start" (30 minutes); after Shorten and another Move the block keeps it, counted from the new 3:00 PM start',
  );

  // A Routine at a set time, with a reminder before each occurrence.
  await visit(j, page, '/plan/routines');
  await heading1(page, 'Routines');
  await page.getByRole('button', { name: 'New routine' }).click();
  const create = page.getByRole('dialog', { name: 'New routine' });
  await create.waitFor();
  await create.getByLabel(/^Title/u).fill(T.routine);
  await create.getByLabel('Every N days', { exact: true }).check();
  await create.getByLabel(/^Starts on/u).fill(ROUTINE_START);
  assert(
    (await create.getByRole('group', { name: 'Reminder', exact: true }).count()) === 0,
    'A Routine at any time of day offers no reminder.',
  );
  await create.getByLabel('At a set time').check();
  await create.getByLabel('Time', { exact: true }).fill('18:00');
  await create.getByLabel(/^Duration/u).fill('15');
  const routineReminder = create.getByRole('group', { name: 'Reminder', exact: true });
  await routineReminder.getByText(REMINDER_COPY, { exact: true }).waitFor();
  assert(
    await routineReminder.getByRole('radio', { name: 'Off', exact: true }).isChecked(),
    'A new Routine starts with its reminder Off.',
  );
  await routineReminder.getByRole('radio', { name: 'Before each occurrence', exact: true }).check();
  await create.getByLabel(/^Minutes before each occurrence/u).fill('30');
  await create.getByRole('button', { name: 'Create routine' }).click();
  await create.waitFor({ state: 'hidden' });
  await page.getByText('Routine and reminder saved.').first().waitFor();
  await main(page).getByRole('link', { name: T.routine, exact: true }).first().click();
  await page.waitForURL(/\/plan\/routines\/[0-9a-f-]{36}$/u);
  await heading1(page, T.routine);
  await settle(page);
  ids.routine = lastSegment(page);
  await routineReminderSection(page)
    .getByText('30 minutes before each occurrence', { exact: true })
    .waitFor();
  await routineReminderSection(page).getByText(REMINDER_COPY, { exact: true }).waitFor();
  await auditCopy(page, 'Routine detail (reminder)');
  j.checks.push(
    'a Routine at a set time offers "Before each occurrence" (only once "At a set time" is chosen); it is created with a 30-minute reminder and its page says so with the saved-reminder copy',
  );

  // A relaunch (offline in Chromium) keeps both definitions.
  const offline = !j.inFirefox;
  ({ context, page } = await relaunch(j, seen, context, AT.reminderRelaunch, TOKYO));
  if (offline) await context.setOffline(true);
  await go(j, page, `/plan/day/${BLOCK_DAY}`, offline);
  if (offline) await page.locator('.offline-banner').waitFor();
  dialog = await expectBlockReminder(
    page,
    { choice: 'Before the start', minutes: '30', start: 'Tue, Jan 5, 3:00 PM' },
    offline ? 'After an offline relaunch' : 'After a relaunch',
  );
  await closeDialog(dialog);
  await go(j, page, `/plan/routines/${ids.routine}`, offline);
  await routineReminderSection(page)
    .getByText('30 minutes before each occurrence', { exact: true })
    .waitFor();
  j.checks.push(
    offline
      ? 'after an offline relaunch from the service worker, the block reminder and the Routine reminder are still saved'
      : 'after a relaunch, the block reminder and the Routine reminder are still saved',
  );

  // Archiving turns the reminder off as a stated part of the archive; restoring keeps it off.
  await press(page, main(page).getByRole('button', { name: 'Archive…', exact: true }));
  const archive = page.getByRole('dialog', { name: 'Archive this routine?' });
  await archive.waitFor();
  await archive
    .getByText(
      'Its reminder (30 minutes before each occurrence) will be turned off. Restoring the routine later does not turn the reminder back on.',
      { exact: true },
    )
    .waitFor();
  await j.shot(page, 'routine-archive-confirmation-1280x800');
  await archive.getByRole('button', { name: 'Archive routine', exact: true }).click();
  await archive.waitFor({ state: 'hidden' });
  await page.getByText('Routine archived. Its reminder is off.').first().waitFor();
  await routineReminderSection(page).getByText('Off', { exact: true }).waitFor();
  await press(page, main(page).getByRole('button', { name: 'Restore', exact: true }));
  await page.getByText('Routine restored.').first().waitFor();
  await poll(() => idle(page), 'The Routine must finish re-reading after Restore.');
  await routineReminderSection(page).getByText('Off', { exact: true }).waitFor();
  await reloadPage(page);
  await heading1(page, T.routine);
  await routineReminderSection(page).getByText('Off', { exact: true }).waitFor();
  await press(page, main(page).getByRole('button', { name: 'Reminder…', exact: true }));
  const routineDialog = page.getByRole('dialog', { name: 'Routine reminder' });
  await routineDialog.waitFor();
  await poll(
    () =>
      routineDialog
        .getByRole('group', { name: 'Reminder', exact: true })
        .getByRole('radio', { name: 'Off', exact: true })
        .isChecked(),
    'After Restore the Routine reminder dialog reads Off.',
  );
  await routineDialog.getByText(REMINDER_COPY, { exact: true }).waitFor();
  await closeDialog(routineDialog);
  j.checks.push(
    'Archive… says "Its reminder (30 minutes before each occurrence) will be turned off. Restoring the routine later does not turn the reminder back on."; after Archive and Restore the reminder stays Off, also after a reload',
  );

  // Saved definitions only: nothing asked for notification permission.
  const permission = await page.evaluate(() =>
    typeof Notification === 'function' ? Notification.permission : 'unsupported',
  );
  assert(
    seen.notificationCalls.length === 0 && permission !== 'granted',
    `No notification permission may be requested (calls: ${seen.notificationCalls.join(' | ')}; permission: ${permission}).`,
  );
  assert(
    seen.dialogs.length === 0,
    `No permission or other browser prompt may appear: ${seen.dialogs.join(' | ')}`,
  );
  if (offline) await context.setOffline(false);
  j.checks.push(
    `reminders are saved definitions only: Notification.requestPermission, showNotification, and PushManager.subscribe were never called (permission stays "${permission}"), and no prompt appeared`,
  );
  return { context, page };
}

/* ──────────── 10. Offline reviews, a cleared list, and "Remind me to finish" ──────────── */

async function reloadPage(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle(page);
}

async function expectOverviewAfterOffline(page, label) {
  await expectCard(page, 'daily', {
    period: `Today, ${dayWords(TOKYO_DAY)}`,
    status: 'Done',
    due: null,
    link: 'Open review',
  });
  await expectCard(page, 'weekly', {
    period: zoneWeek,
    status: 'Done',
    due: null,
    link: 'Open review',
  });
  await expectCard(page, 'monthly', {
    period: 'January 2027',
    status: 'Not started',
    due: `Due ${dayWords('2027-01-31')}`,
    link: 'Start early',
  });
  await expectCard(page, 'yearly', {
    period: '2027',
    status: 'Saved for later',
    due: `Due ${dayWords('2027-12-31')}`,
    link: 'Resume review',
  });
  await expectRows(
    historyList(page),
    [
      `Today, ${dayWords(TOKYO_DAY)} (daily review)`,
      '2027 (yearly review)',
      `${zoneWeek} (weekly review)`,
      `${draftWeek} (weekly review)`,
      'December 2026 (monthly review)',
      `${longDate(DAY1)} (daily review)`,
      'Week of November 22–28, 2026 (weekly review)',
      'November 2026 (monthly review)',
      '2026 (yearly review)',
    ],
    `${label}: history, newest period first`,
  );
  const skipped = await rowFacts(historyList(page), 'December 2026 (monthly review)');
  assert(
    skipped === 'Monthly review · Skipped',
    `${label}: December is skipped (found "${skipped}").`,
  );
  const draft = await rowFacts(historyList(page), '2027 (yearly review)');
  assert(
    draft === 'Yearly review · Saved for later',
    `${label}: 2027 is a draft (found "${draft}").`,
  );
}

/** label: review-reminder.tsx, the "Remind me to finish" section (h2 "Reminder"). */
function reviewReminder(page) {
  return section(page, 'Reminder');
}

/** "Saved reminder: {long date} at {time}." */
async function expectSavedReminder(page, when, label) {
  await reviewReminder(page)
    .getByText(`Saved reminder: ${when}.`, { exact: true })
    .waitFor()
    .catch(async () => {
      const shown = await reviewReminder(page)
        .innerText()
        .catch(() => 'no Reminder section');
      throw new Error(`${label}: the saved reminder must read ${when} (found: ${shown}).`);
    });
}

/**
 * Set "Remind me to finish" on an open (draft or skipped) review: the section explains itself,
 * shows the honest copy, and its result takes focus with that command's Undo.
 */
async function setReviewReminder(page, { date, time, when }) {
  const reminder = reviewReminder(page);
  await reminder
    .getByText('Set, change, or turn off the reminder saved for this review.', { exact: true })
    .waitFor();
  const fieldset = reminder.getByRole('group', {
    name: 'Remind me to finish this review',
    exact: true,
  });
  await fieldset.getByText(REMINDER_COPY, { exact: true }).waitFor();
  await fieldset
    .getByText('Times are in your planning time zone, Asia/Tokyo.', { exact: true })
    .waitFor();
  await reminder.getByLabel('Reminder date', { exact: true }).fill(date);
  await reminder.getByLabel('Reminder time', { exact: true }).fill(time);
  await press(page, reminder.getByRole('button', { name: 'Save reminder', exact: true }));
  const status = reminder.getByText('Reminder saved.', { exact: true });
  await expectStatus(page, 'Reminder saved.');
  await waitForFocus(page, status, { label: 'A reminder result takes focus' });
  await reminder.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  await expectSavedReminder(page, when, 'After Save reminder');
}

/** After a reminder command only that command's Undo is on screen (the page's own result ends). */
async function expectOnlyReminderUndo(page, label) {
  await poll(
    async () =>
      (await main(page).getByRole('button', { name: 'Undo', exact: true }).count()) === 1 &&
      (await reviewReminder(page).getByRole('button', { name: 'Undo', exact: true }).count()) === 1,
    `${label}: only the reminder command's Undo may be on screen.`,
  );
}

async function verifyOfflineReviews(j, seen, context, page) {
  const offline = !j.inFirefox;
  // The week the weekly review plans already has a commitment: an Inbox Action planned into the
  // week and committed in Plan Week (Actions triage, planning Week commitments).
  await visit(j, page, '/inbox');
  const twine = page.getByRole('list', { name: 'Inbox Actions' }).locator('li').filter({
    hasText: T.twine,
  });
  await twine.getByText('Triage', { exact: true }).click();
  // A select inside its label is named "Horizon <selected option>" (alignment lesson).
  await twine.getByRole('combobox', { name: /^Horizon\b/u }).selectOption('week');
  await twine.getByLabel('Date', { exact: true }).fill(BLOCK_DAY);
  await twine.getByRole('button', { name: 'Plan', exact: true }).click();
  await twine.waitFor({ state: 'detached' });
  await visit(j, page, `/plan/week/${PLAN_WEEK}`);
  await press(
    page,
    page
      .getByRole('list', { name: 'Placed in this week' })
      .locator('li')
      .filter({ hasText: T.twine })
      .getByRole('button', { name: /^Commit this week/u }),
  );
  await page.getByText('Added to this week’s commitments.').first().waitFor();
  const weekCommitments = () => page.getByRole('list', { name: 'This week’s commitments' });
  await weekCommitments().getByText(T.twine).first().waitFor();

  await visit(j, page, '/');
  if (offline) {
    await poll(
      () => page.evaluate(() => navigator.serviceWorker?.controller !== null),
      'The service worker must control the page before going offline.',
    );
    await context.setOffline(true);
    await reloadPage(page);
    await page.locator('.offline-banner').waitFor();
  }

  // Weekly: the plan's commitment starts chosen; clear it, write a note, Save for later.
  await openReview(page);
  await openCard(j, page, 'weekly', 'Start review', `/review/weekly/${ZONE_WEEK}`);
  const commitments = section(page, 'Commitments');
  const twineBox = commitments.getByRole('checkbox', { name: T.twine, exact: true });
  await poll(() => twineBox.isChecked(), 'The week’s current commitment starts chosen.');
  await commitments.getByText('1 of 3 chosen', { exact: true }).waitFor();
  await twineBox.uncheck();
  await commitments.getByText('0 of 3 chosen', { exact: true }).waitFor();
  await commitments.getByText('No commitments chosen.', { exact: true }).waitFor();
  const axisNote = (current) => current.getByLabel(`What supported ${T.axis}?`, { exact: true });
  await axisNote(page).fill(T.offlineNote);
  await press(page, button(page, 'Save for later'));
  await expectStatus(page, SAVED);
  // "Remind me to finish" on the saved draft.
  await setReviewReminder(page, {
    date: TOKYO_DAY,
    time: '18:00',
    when: 'Saturday, January 2, 2027 at 6:00 PM',
  });
  await auditCopy(page, 'Weekly review (draft with a reminder)');
  await j.shot(page, 'weekly-review-reminder-1280x800');
  j.checks.push(
    'a weekly draft whose week had a commitment saves the emptied list; "Remind me to finish" on the saved draft shows its intro, the saved-reminder copy, and "Saved reminder: Saturday, January 2, 2027 at 6:00 PM.", with focus on "Reminder saved." and its Undo',
  );

  // A relaunch (offline in Chromium) resumes the draft: the list stays empty and the reminder stays.
  ({ context, page } = await relaunch(j, seen, context, AT.resumeRelaunch, TOKYO));
  if (offline) await context.setOffline(true);
  await go(j, page, '/review', offline);
  await heading1(page, 'Review');
  if (offline) await page.locator('.offline-banner').waitFor();
  await expectCard(page, 'weekly', {
    period: zoneWeek,
    status: 'Saved for later',
    due: 'Due today',
    link: 'Resume review',
  });
  await openCard(j, page, 'weekly', 'Resume review', `/review/weekly/${ZONE_WEEK}`);
  await poll(
    async () => (await axisNote(page).inputValue()) === T.offlineNote,
    'The resumed draft keeps its note.',
  );
  assert(
    (await section(page, 'Commitments').getByRole('checkbox', { checked: true }).count()) === 0,
    'The resumed draft keeps the emptied commitments list empty.',
  );
  await section(page, 'Commitments').getByText('No commitments chosen.', { exact: true }).waitFor();
  await expectSavedReminder(page, 'Saturday, January 2, 2027 at 6:00 PM', 'After a relaunch');

  // Skip: the skipped review keeps the cleared choice and the reminder; then resume and finish.
  await press(page, button(page, 'Skip this review'));
  await expectStatus(page, 'Review skipped.');
  await expectFacts(page, 'Skipped');
  await section(page, 'Commitments')
    .getByText('Saved choice: clear the week’s commitments.', { exact: true })
    .waitFor();
  await expectSavedReminder(page, 'Saturday, January 2, 2027 at 6:00 PM', 'After Skip');
  await press(page, button(page, 'Resume review'));
  await poll(
    async () => (await axisNote(page).inputValue()) === T.offlineNote,
    'Resume restores the skipped review’s note.',
  );
  assert(
    (await section(page, 'Commitments').getByRole('checkbox', { checked: true }).count()) === 0,
    'Resume keeps the emptied commitments list empty.',
  );
  await press(page, button(page, 'Finish review'));
  await expectStatus(page, 'Review finished.');
  await section(page, 'Commitments')
    .getByText('The week’s commitments were cleared.', { exact: true })
    .waitFor();
  // Finish keeps the reminder until the person turns it off.
  await reviewReminder(page)
    .getByText('This review is finished. Its reminder stays saved until you turn it off.', {
      exact: true,
    })
    .waitFor();
  await expectSavedReminder(page, 'Saturday, January 2, 2027 at 6:00 PM', 'After Finish');
  j.checks.push(
    'after a relaunch the resumed draft keeps its emptied commitments list and its reminder; skipped, it says "Saved choice: clear the week’s commitments."; finished, "The week’s commitments were cleared." and "This review is finished. Its reminder stays saved until you turn it off."',
  );

  // Monthly: skip, then "Remind me to finish" on the skipped review; only its Undo stays.
  await openReview(page);
  await expectCard(page, 'monthly', {
    period: 'December 2026',
    status: 'Not started',
    due: 'Ready when you are',
    link: 'Start review',
  });
  await openCard(j, page, 'monthly', 'Start review', '/review/monthly/2026-12');
  await press(page, button(page, 'Skip this review'));
  await expectStatus(page, 'Review skipped.');
  await button(page, 'Undo').waitFor();
  await setReviewReminder(page, {
    date: '2027-01-03',
    time: '09:00',
    when: 'Sunday, January 3, 2027 at 9:00 AM',
  });
  await expectOnlyReminderUndo(page, 'After a reminder on the skipped review');
  assert(
    (await main(page).getByText('Review skipped.', { exact: true }).count()) === 0,
    'A reminder command ends the page’s own result.',
  );
  await auditCopy(page, 'Monthly review (skipped, with a reminder)');
  j.checks.push(
    'a skipped monthly review takes a reminder; after it, the page’s "Review skipped." and its Undo are gone and only the reminder’s Undo is on screen',
  );

  // Daily: partial save, reload, finish.
  await openReview(page);
  await expectCard(page, 'daily', {
    period: `Today, ${dayWords(TOKYO_DAY)}`,
    status: 'Not started',
    due: 'Due today',
    link: 'Start review',
  });
  await openCard(j, page, 'daily', 'Start review', `/end-day/${TOKYO_DAY}`);
  await energyGroup(page).getByRole('radio', { name: 'Low', exact: true }).check();
  await press(page, button(page, 'Save for later'));
  await expectStatus(page, SAVED);
  await reloadPage(page);
  await poll(
    () => energyGroup(page).getByRole('radio', { name: 'Low', exact: true }).isChecked(),
    'The daily partial save survives a reload.',
  );
  await press(page, button(page, 'Finish review'));
  await expectStatus(page, 'Review finished.');
  await section(page, 'Energy').getByText('Low', { exact: true }).waitFor();

  // Yearly: started early and saved for later.
  await openReview(page);
  await expectCard(page, 'yearly', {
    period: '2027',
    status: 'Not started',
    due: `Due ${dayWords('2027-12-31')}`,
    link: 'Start early',
  });
  await openCard(j, page, 'yearly', 'Start early', '/review/yearly/2027');
  await page.getByLabel('Retrospective (optional)', { exact: true }).fill(T.offlineRetro);
  await press(page, button(page, 'Save for later'));
  await expectStatus(page, SAVED);

  await openReview(page);
  await expectOverviewAfterOffline(page, offline ? 'Offline' : 'After the reviews');
  await auditCopy(page, 'Review overview (every state)');
  await j.shot(page, 'review-overview-every-state-1280x800');
  j.checks.push(
    offline
      ? 'offline (Chromium): weekly partial save, offline relaunch and resume, skip, resume, and finish; monthly skip; daily save, offline reload, and finish; yearly started early and saved; nothing blocks'
      : 'website use (Firefox): weekly partial save, relaunch and resume, skip, resume, and finish; monthly skip; daily save, reload, and finish; yearly started early and saved',
  );

  // A relaunch (offline from the service worker in Chromium) keeps every result.
  await context.close();
  ({ context, page } = await open(j, seen, AT.tokyoRelaunch, TOKYO));
  if (offline) await context.setOffline(true);
  await go(j, page, '/review', offline);
  await heading1(page, 'Review');
  if (offline) await page.locator('.offline-banner').waitFor();
  await expectOverviewAfterOffline(page, offline ? 'Offline relaunch' : 'Relaunch');
  await go(j, page, '/review/monthly/2026-12', offline);
  await expectFacts(page, 'Skipped');
  await expectSavedReminder(page, 'Sunday, January 3, 2027 at 9:00 AM', 'The skipped review');
  await go(j, page, `/review/weekly/${ZONE_WEEK}`, offline);
  await expectFacts(page, 'Done');
  await section(page, 'What supported each Axis')
    .getByText(T.offlineNote, { exact: true })
    .waitFor();
  await section(page, 'Commitments')
    .getByText('The week’s commitments were cleared.', { exact: true })
    .waitFor();
  await expectSavedReminder(page, 'Saturday, January 2, 2027 at 6:00 PM', 'The finished review');
  j.checks.push(
    offline
      ? 'after an offline relaunch both "Remind me to finish" reminders are still saved: the finished weekly review and the skipped monthly review'
      : 'after a relaunch both "Remind me to finish" reminders are still saved: the finished weekly review and the skipped monthly review',
  );

  // A finished review's reminder can be turned off, with Undo.
  const reminder = reviewReminder(page);
  await j.shot(page, 'weekly-review-finished-reminder-1280x800');
  await press(page, reminder.getByRole('button', { name: 'Turn off reminder', exact: true }));
  await expectStatus(page, 'Reminder turned off.');
  await waitForFocus(page, reminder.getByText('Reminder turned off.', { exact: true }), {
    label: 'Turning a reminder off moves focus to its result',
  });
  await reminder.getByText('No reminder is saved.', { exact: true }).waitFor();
  await expectOnlyReminderUndo(page, 'After Turn off reminder');
  await press(page, reminder.getByRole('button', { name: 'Undo', exact: true }));
  await expectStatus(page, 'Undone. The reminder is back as it was.');
  await expectSavedReminder(page, 'Saturday, January 2, 2027 at 6:00 PM', 'After Undo');
  await press(page, reminder.getByRole('button', { name: 'Turn off reminder', exact: true }));
  await expectStatus(page, 'Reminder turned off.');
  await reminder.getByText('No reminder is saved.', { exact: true }).waitFor();
  // Once it is off and its result is gone, a finished review has no Reminder section.
  await go(j, page, `/review/weekly/${ZONE_WEEK}`, offline);
  await expectFacts(page, 'Done');
  assert(
    (await page.getByRole('heading', { level: 2, name: 'Reminder', exact: true }).count()) === 0,
    'A finished review without a reminder shows no Reminder section.',
  );
  await auditCopy(page, 'Weekly review (finished, reminder turned off)');
  j.checks.push(
    'the finished review’s "Turn off reminder" says "Reminder turned off." and "No reminder is saved.", with only its Undo; Undo brings the reminder back; turned off again, the section is gone after a reload',
  );

  // Finishing the emptied list cleared the planning week's commitments.
  await go(j, page, `/plan/week/${PLAN_WEEK}`, offline);
  await page.getByText('No commitments chosen for this week.', { exact: true }).waitFor();
  assert(
    (await weekCommitments().count()) === 0,
    'Plan Week keeps no commitment after the review cleared them.',
  );
  j.checks.push(
    'Plan Week for January 3–9 has no commitments after the weekly review finished with the emptied list',
  );
  if (offline) {
    await context.setOffline(false);
    const cached = await assertStaticCaches(
      page,
      j.origin,
      Object.values(ids).filter((value) => typeof value === 'string'),
    );
    j.checks.push(
      `an offline relaunch from the service worker shows every review result; ${String(cached)} cached URLs are static assets with no plan data`,
    );
  } else j.checks.push('a relaunch shows every review result');
  return { context, page };
}

/* ───────────────────────── 11. Leaving right after "Saved" ───────────────────────── */

/**
 * Save for later shows its result a moment before the page reads the review again. Leaving at
 * once, by a reload or a link in the app, asks nothing: no beforeunload prompt and no "Save your
 * changes before leaving?" dialog, and what was saved is kept.
 */
async function leaveRightAfterSave(j, page, seen, { attempt, label, path, h1 }) {
  const before = seen.dialogs.length;
  await main(page).getByText(SAVED, { exact: true }).first().waitFor();
  // At once, without waiting for the re-read.
  if (attempt % 2 === 0) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await heading1(page, h1);
    await settle(page);
  } else {
    const guard = page.getByRole('dialog', { name: 'Save your changes before leaving?' });
    await primaryLink(page, 'Review').click();
    await poll(
      async () => new URL(page.url()).pathname === '/review' || (await guard.count()) > 0,
      `${label}: the link must leave the page.`,
    );
    assert(
      (await guard.count()) === 0,
      `${label} (attempt ${String(attempt + 1)}): leaving right after Saved asked to save again.`,
    );
    await arrive(j, page, '/review', 'Review');
    await visit(j, page, path);
    await heading1(page, h1);
  }
  assert(
    seen.dialogs.length === before,
    `${label} (attempt ${String(attempt + 1)}): leaving right after Saved raised ${seen.dialogs.slice(before).join(' | ')}`,
  );
}

async function verifyLeavingRightAfterSave(j, page, seen) {
  const energies = ['Low', 'Medium', 'High', 'Focused'];
  const endDayPath = '/end-day/2027-01-01';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await visit(j, page, endDayPath);
    await heading1(page, 'End day');
    const energy = energies[attempt];
    await energyGroup(page).getByRole('radio', { name: energy, exact: true }).check();
    await press(page, button(page, 'Save for later'));
    await leaveRightAfterSave(j, page, seen, {
      attempt,
      label: 'End Day',
      path: endDayPath,
      h1: 'End day',
    });
    await poll(
      () => energyGroup(page).getByRole('radio', { name: energy, exact: true }).isChecked(),
      `End Day (attempt ${String(attempt + 1)}): the saved energy ${energy} must be kept.`,
    );
  }
  j.checks.push(
    'End Day: four times, Save for later then an immediate reload or Review link (no wait for the re-read) asks nothing (no beforeunload, no "Save your changes before leaving?") and keeps the saved energy',
  );

  const yearlyPath = '/review/yearly/2027';
  const retrospective = (current) =>
    current.getByLabel('Retrospective (optional)', { exact: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await visit(j, page, yearlyPath);
    await heading1(page, 'Yearly review');
    const text = `${T.offlineRetro} Pass ${String(attempt + 1)}.`;
    await retrospective(page).fill(text);
    await press(page, button(page, 'Save for later'));
    await leaveRightAfterSave(j, page, seen, {
      attempt,
      label: 'Yearly review',
      path: yearlyPath,
      h1: 'Yearly review',
    });
    await poll(
      async () => (await retrospective(page).inputValue()) === text,
      `Yearly review (attempt ${String(attempt + 1)}): the saved retrospective must be kept.`,
    );
  }
  j.checks.push(
    'Yearly review: four times, Save for later then an immediate reload or Review link asks nothing and keeps the saved retrospective',
  );
}

/* ───────────────────────── 12. No model surface or traffic ───────────────────────── */

async function verifyNoModelSurface(j, page, seen) {
  for (const path of ['/ai', '/assistant', '/chat', '/proposals', '/review/ai']) {
    await visit(j, page, path);
    const heading = ((await page.locator('main h1').textContent()) ?? '').trim();
    assert(
      heading === 'This page is not available' || heading === 'This review is not available',
      `${path} must not be a route (found "${heading}").`,
    );
  }
  await visit(j, page, '/review/proposal/2026');
  await heading1(page, 'This review is not available');
  assert(
    seen.blockedRequests.length === 0 &&
      seen.externalRequests.length === 0 &&
      seen.contextRequests.length === 0,
    'The review journey made no request away from the app.',
  );
  j.checks.push(
    `no model surface: /ai, /assistant, /chat, /proposals, and review AI paths are not routes; ${String(audited.size)} audited pages show no AI, ranking, or automatic-planning wording and no such links`,
  );
  j.checks.push(
    'every context aborted all requests away from the app (context.route) and recorded every request (pages, workers, service worker): the journey worked unchanged with zero such requests',
  );
  await verifyDeepLinks(j, page);
}

/**
 * Review links that name no review the person can work on now fail calmly and offer the current
 * checkpoint (verification contract). Planning today is Saturday January 2, 2027 in Tokyo; weeks start on
 * Sunday.
 */
async function verifyDeepLinks(j, page) {
  const currentLink = () =>
    main(page).getByRole('link', { name: 'Open the current weekly review', exact: true });

  await visit(j, page, '/review/weekly/2027-01-10');
  await heading1(page, 'Weekly review');
  await expectEyebrow(page, 'Week of January 10–16');
  await main(page).getByText('This period has not started yet.', { exact: true }).waitFor();
  assert(
    (await currentLink().getAttribute('href')) === `/review/weekly/${ZONE_WEEK}`,
    'A future week links to the current weekly review.',
  );
  assert(
    (await button(page, 'Finish review').count()) === 0,
    'A future period has nothing to finish.',
  );
  await auditCopy(page, 'Weekly review (future period)');

  await visit(j, page, '/review/weekly/2026-12-28');
  await main(page)
    .getByText(
      'This week starts on Monday. Your weeks now start on Sunday, so weekly reviews look at weeks that start on Sunday. Nothing was saved for this week.',
      { exact: true },
    )
    .waitFor();
  assert(
    (await currentLink().getAttribute('href')) === `/review/weekly/${ZONE_WEEK}`,
    'A week that starts on another weekday links to the current weekly review.',
  );
  await auditCopy(page, 'Weekly review (week not on the first weekday)');

  await visit(j, page, '/review/monthly/2027-02');
  await main(page).getByText('This period has not started yet.', { exact: true }).waitFor();

  for (const path of ['/review/weekly/2026-13-01', '/review/yearly/26', '/review/monthly/2026']) {
    await visit(j, page, path);
    await heading1(page, 'This review is not available');
    await main(page)
      .getByText('This review link could not be read. Your plan is unchanged.', { exact: true })
      .waitFor();
    await assertSingleH1(page, path);
  }
  await auditCopy(page, 'Review unavailable');

  // A daily review link is End Day for that date.
  await page.goto(`${j.origin}/review/daily/${DAY1}`, { waitUntil: 'networkidle' });
  await page.waitForURL(`${j.origin}/end-day/${DAY1}`);
  await heading1(page, 'End day');
  await settle(page);
  await page.getByRole('list', { name: `Decisions for ${longDate(DAY1)}` }).waitFor();
  j.checks.push(
    'calm deep links: a future week or month says it has not started; a week that starts on another weekday explains why and links to the current review; malformed keys show "This review is not available"; a daily link opens End Day',
  );
}

/* ───────────────────────── 13. Accessibility ───────────────────────── */

async function verifyAccessibility(j, page) {
  for (const [width, height] of [
    [320, 720],
    [1024, 768],
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    for (const [path, label] of accessiblePages) {
      await visit(j, page, path);
      await assertSingleH1(page, `${label} ${String(width)}x${String(height)}`);
      await assertNoOverflow(page, `${label} ${String(width)}x${String(height)}`);
      await assertTargets(page, `${label} ${String(width)}x${String(height)}`);
      if (width === 320 || width === 1440)
        await j.shot(page, `${label}-${String(width)}x${String(height)}`);
    }
  }
  j.checks.push(
    'review overview, a review form, finished and skipped reviews, and End Day (form and finished): one h1, no horizontal overflow, and 44 px targets at 320x720, 1024x768, 1280x800, 1440x900, and 1920x1080',
  );

  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [path, label] of accessiblePages) {
    await visit(j, page, path);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await assertNoOverflow(page, `${label} at 200% text`);
    await j.shot(page, `${label}-200-percent-text-1280x800`);
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('font-size');
    });
  }
  j.checks.push('every review page and End Day reflow at 200% text');

  for (const theme of ['Dark', 'Light']) {
    await visit(j, page, '/settings');
    await page.getByLabel(theme, { exact: true }).check();
    for (const [path, label] of accessiblePages) {
      await visit(j, page, path);
      assert(
        (await page.locator('html').getAttribute('data-theme')) === theme.toLowerCase(),
        `${label} must use the ${theme} theme.`,
      );
      await assertNoOverflow(page, `${label} ${theme}`);
      await j.shot(page, `${label}-${theme.toLowerCase()}-1280x800`);
    }
  }
  await visit(j, page, '/settings');
  await page.getByLabel('Use system appearance').check();
  j.checks.push('dark and light themes on every review page and End Day');

  await visit(j, page, '/settings');
  await page.getByLabel('Reduced', { exact: true }).check();
  for (const [path, label] of accessiblePages) {
    await visit(j, page, path);
    const animated = await animatedElementCount(page);
    assert(animated === 0, `${label}: reduced motion must remove animation (${String(animated)}).`);
  }
  await visit(j, page, '/settings');
  await page.getByLabel('Use system motion setting').check();
  j.checks.push(
    'reduced motion: no animation or transition over 0.01 s on every review page and End Day',
  );

  // Tab order follows reading order on a review form, and every field has a name.
  await visit(j, page, '/review/yearly/2027');
  const order = await tabRegions(page, button(page, 'Finish review'));
  const expected = ['Retrospective', 'Outcomes', 'Direction'];
  const seenOrder = order.filter((region) => expected.includes(region));
  assert(
    seenOrder.join('|') === expected.join('|'),
    `Tab order must follow the yearly review's sections: ${order.join(' → ')}`,
  );
  j.checks.push(`Tab order on the yearly review form: ${order.join(' → ')} → Finish review`);
}

/** The h2 region of each focused element while tabbing from the h1 to `stop`. */
async function tabRegions(page, stop) {
  await page.locator('main h1').focus();
  const visited = [];
  for (let presses = 0; presses < 120; presses += 1) {
    await page.keyboard.press('Tab');
    if (await stop.evaluate((element) => element === document.activeElement)) return visited;
    const region = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active.closest('main') === null) return null;
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
  }
  throw new Error(`Tab never reached Finish review: ${visited.join(' → ')}`);
}
