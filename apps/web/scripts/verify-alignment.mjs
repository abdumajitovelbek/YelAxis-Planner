import {
  addDays,
  animatedElementCount,
  assert,
  assertNoOverflow,
  assertSingleH1,
  assertStaticCaches,
  assertTargets,
  buttonNames,
  completeMinimalOnboarding,
  localDate,
  runJourney,
  tabTo,
} from './lib/journey.mjs';

/**
 * alignment production-browser journey (brief §6, steps 1-19): Axes with keyboard order, an Outcome
 * with transparent progress, Milestones, a Project with a next action, transitions with Undo, typed
 * links with "Already linked" and cross-Axis confirmation, Milestone reparenting, unlinking, the
 * keyboard-only relationship list and map with identical controls, a copy audit, archive and
 * restore, blocked and confirmed permanent deletion, Inbox Plan with a Milestone, safe deep links,
 * offline use with restart persistence, layouts, themes, reduced motion, and focus return.
 * `--firefox` runs the same flow; offline use there is website-only (no offline reload).
 */
const timeZone = 'America/New_York';
const today = localDate(new Date(), timeZone);

/** Fictional plan content only. */
const T = {
  axisA: 'Home and garden',
  axisB: 'Community',
  axisOffline: 'Offline notes',
  axisOfflinePurpose: 'Ideas written down while offline.',
  outcome: 'Publish the garden guide',
  outcome2: 'Share seeds with neighbours',
  milestone1: 'Outline approved',
  milestone2: 'First draft done',
  project: 'Photograph the beds',
  project2: 'Old shed notes',
  project3: 'Build a cold frame',
  nextAction: 'Choose the first bed to photograph',
  crossAction: 'Collect seed envelopes',
  inboxAction: 'Water the seedlings',
};
const ids = {};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const titled = (title) => new RegExp(escapeRegExp(title), 'u');
const lastSegment = (page) => new URL(page.url()).pathname.split('/').pop();
const alignmentUrl = (origin, kind, id, view) =>
  `${origin}/axis/alignment?focus=${kind}:${id}${view === undefined ? '' : `&view=${view}`}`;
const focusPattern = (kind, id) => new RegExp(`focus=${kind}(?::|%3A)${id}`, 'u');

await runJourney({ name: 'alignment', title: 'alignment', timeZone, basePort: 7100 }, async (j) => {
  const externalRequests = [];
  const browserErrors = [];
  let context = await j.launch();
  let page = context.pages()[0] ?? (await context.newPage());
  j.observe(page, externalRequests, browserErrors);
  await page.goto(j.origin, { waitUntil: 'networkidle' });
  await completeMinimalOnboarding(page);

  j.step('1 Axes and keyboard order');
  await verifyAxes(j, page);
  j.step('2 Outcome, target, and progress');
  await verifyOutcomeProgress(j, page);
  j.step('3 Milestones and order');
  await verifyMilestones(j, page);
  j.step('4 Project as primary');
  await verifyProject(j, page);
  j.step('5 next action');
  await verifyNextAction(j, page);
  j.step('6 transitions and Undo');
  await verifyTransitions(j, page);
  j.step('7 links');
  await verifyLinks(j, page);
  j.step('8 reparent');
  await verifyReparent(j, page);
  j.step('9 unlink');
  await verifyUnlink(j, page);
  j.step('10 alignment list and map by keyboard');
  await verifyAlignmentKeyboard(j, page);
  j.step('11 copy audit');
  await verifyCopy(j, page);
  j.step('12 archive and restore');
  await verifyArchive(j, page);
  j.step('13 permanent delete');
  await verifyDelete(j, page);
  j.step('14 Inbox Plan with a Milestone');
  await verifyInboxMilestone(j, page);
  j.step('15 deep links');
  await verifyDeepLinks(j, page);
  j.step('16 offline and restart');
  ({ context, page } = await verifyOffline(j, context, page, externalRequests, browserErrors));
  j.step('17 layouts, targets, and 200% text');
  await verifyLayouts(j, page);
  j.step('18 themes and motion');
  await verifyThemes(j, page);
  j.step('19 focus return, unsaved guard, and navigation');
  await verifyFocusAndGuard(j, page);
  await context.close();

  assert(
    externalRequests.length === 0,
    `alignment made external requests: ${externalRequests.join(', ')}`,
  );
  assert(browserErrors.length === 0, `alignment browser errors: ${browserErrors.join(' | ')}`);
  return { today };
});

/* ───────────────────────── Shared page helpers ───────────────────────── */

async function heading1(page, name) {
  await page.getByRole('heading', { level: 1, name, exact: true }).waitFor();
}

/** A command's polite announcement (or the same visible text). */
async function announced(page, text) {
  await page.getByText(text, { exact: true }).first().waitFor();
}

/** Wait until a page has left its loading state. */
async function settle(page) {
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.waitForFunction(() => {
    const heading = document.querySelector('main h1');
    return heading !== null && !(heading.textContent ?? '').startsWith('Opening');
  });
  const url = new URL(page.url());
  if (url.pathname === '/axis/alignment' && url.searchParams.has('focus'))
    await page.getByRole('heading', { level: 2, name: /^Selected: |unavailable$/u }).waitFor();
}

async function waitForFocus(page, locator) {
  const handle = await locator.elementHandle();
  await page.waitForFunction((element) => element === document.activeElement, handle);
}

/** Titles of the first link in each row, in order, until they match (or time runs out). */
async function expectRowOrder(list, expected, label) {
  const deadline = Date.now() + 10_000;
  let actual = [];
  while (Date.now() < deadline) {
    actual = await list
      .locator(':scope > li')
      .evaluateAll((rows) => rows.map((row) => row.querySelector('a')?.textContent?.trim() ?? ''));
    if (actual.join('|') === expected.join('|')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: expected ${expected.join(', ')}, found ${actual.join(', ')}.`);
}

async function idFromLink(scope, title) {
  const href = await scope
    .getByRole('link', { name: title, exact: true })
    .first()
    .getAttribute('href');
  assert(href !== null, `No link to ${title}.`);
  return href.split('/').pop();
}

async function createAxis(j, page, title, purpose, icon) {
  await page.goto(`${j.origin}/axis`, { waitUntil: 'networkidle' });
  await heading1(page, 'Axes');
  await page.getByRole('button', { name: 'New Axis…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Axis' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill(title);
  if (purpose !== undefined) await dialog.getByLabel(/^Purpose/u).fill(purpose);
  if (icon !== undefined)
    await dialog.getByRole('group', { name: 'Icon' }).getByRole('radio', { name: icon }).check();
  await dialog.getByRole('button', { name: 'Create Axis' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await heading1(page, title);
  return lastSegment(page);
}

async function createOutcomeInAxis(j, page, axisId, title, success, target) {
  await page.goto(`${j.origin}/axis/${axisId}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('button', { name: 'Add Outcome…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Outcome' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill(title);
  await dialog.getByLabel(/^Success definition/u).fill(success);
  if (target !== undefined) {
    await dialog.getByLabel(/^Target start/u).fill(target.start);
    await dialog.getByLabel(/^Target end/u).fill(target.end);
  }
  await dialog.getByRole('button', { name: 'Create Outcome' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await heading1(page, title);
  return lastSegment(page);
}

async function createProjectInAxis(j, page, axisId, title, desiredResult) {
  await page.goto(`${j.origin}/axis/${axisId}`, { waitUntil: 'networkidle' });
  await settle(page);
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

async function capture(page, title, { axis } = {}) {
  await page.getByRole('button', { name: /Capture Alt C/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to Inbox' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill(title);
  if (axis !== undefined) {
    const details = dialog.locator('details.expanded-fields');
    if (!(await details.evaluate((element) => element.open)))
      await dialog.getByText('More details').click();
    // A select inside its label is named "Axis <selected option>", so match the role and prefix.
    await dialog.getByRole('combobox', { name: /^Axis\b/u }).selectOption({ label: axis });
  }
  await dialog.getByRole('button', { name: 'Capture', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/** Open a page's Link dialog, choose one candidate, and link it. */
async function linkFromDialog(page, opener, focusTitle, candidate) {
  await page.getByRole('button', { name: opener, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Link “${focusTitle}”` });
  await dialog.waitFor();
  await dialog.getByRole('radio', { name: titled(candidate) }).check();
  await dialog.getByText(`Links “${candidate}” to “${focusTitle}”.`).waitFor();
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await announced(page, `Linked “${candidate}” to “${focusTitle}”.`);
}

async function archiveCurrent(page, label) {
  await page.getByRole('button', { name: 'Archive…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Archive this ${label}?` });
  await dialog.waitFor();
  await dialog.getByText('Nothing is deleted.', { exact: false }).first().waitFor();
  await dialog.getByRole('button', { name: `Archive ${label}`, exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('Archived. Restore it to make changes.').first().waitFor();
}

function forbiddenWording(text) {
  return /score|streak|aligned \d+%/iu.test(text) || /\bAI\b/u.test(text);
}

/* ───────────────────────── 1. Axes ───────────────────────── */

async function verifyAxes(j, page) {
  await page.goto(`${j.origin}/axis`, { waitUntil: 'networkidle' });
  await heading1(page, 'Axes');
  await assertSingleH1(page, 'Axis overview');
  await page.getByText('No Axes yet.').first().waitFor();
  ids.axisA = await createAxis(
    j,
    page,
    T.axisA,
    'Keep the home and garden in good shape.',
    'Standard',
  );
  await axisIconFact(page, 'Standard', true);
  ids.axisB = await createAxis(j, page, T.axisB);
  await axisIconFact(page, 'No icon', false);
  // The edit control sets and clears the icon.
  await editAxisIcon(page, 'Standard');
  await axisIconFact(page, 'Standard', true);
  await editAxisIcon(page, 'No icon');
  await axisIconFact(page, 'No icon', false);

  await page.goto(`${j.origin}/axis`, { waitUntil: 'networkidle' });
  const axes = () => page.getByRole('list', { name: 'Axes', exact: true });
  await expectRowOrder(axes(), [T.axisA, T.axisB], 'Axes');
  await tabTo(page, page.getByRole('button', { name: `Move ${T.axisB} up` }));
  await page.keyboard.press('Enter');
  await expectRowOrder(axes(), [T.axisB, T.axisA], 'Axes after Move up');
  await page.reload({ waitUntil: 'networkidle' });
  await expectRowOrder(axes(), [T.axisB, T.axisA], 'Axes after reload');
  await tabTo(page, page.getByRole('button', { name: `Move ${T.axisA} up` }));
  await page.keyboard.press('Enter');
  await expectRowOrder(axes(), [T.axisA, T.axisB], 'Axes after moving back');
  await rowIconLoaded(page, T.axisA);
  await rowFallback(page, T.axisB, 'C');
  await j.shot(page, 'axis-overview-1280x800');
  j.checks.push('two Axes created and reordered by keyboard; the order persists after reload');
  j.checks.push(
    'Axis icon chosen on create, set and cleared on edit, shown after reload; the initial is the fallback',
  );
}

/** The Axis page states its icon in words and shows the picture, or the initial as a fallback. */
async function axisIconFact(page, label, picture) {
  const fact = page.locator('.axis-icon-fact');
  await fact.filter({ hasText: label }).waitFor();
  if (picture) await imageLoaded(page, fact.locator('img[data-axis-icon="standard"]'));
  else await fact.locator('[data-axis-icon="none"]').waitFor();
}

async function editAxisIcon(page, label) {
  await page.getByRole('button', { name: 'Edit…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Axis' });
  await dialog.getByRole('group', { name: 'Icon' }).getByRole('radio', { name: label }).check();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await announced(page, 'Axis saved.');
}

function axisRow(page, title) {
  return page
    .getByRole('list', { name: 'Axes', exact: true })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: title, exact: true }) });
}

async function rowIconLoaded(page, title) {
  await imageLoaded(page, axisRow(page, title).locator('img[data-axis-icon="standard"]'));
}

async function rowFallback(page, title, initial) {
  const fallback = axisRow(page, title).locator('[data-axis-icon="none"]');
  await fallback.waitFor();
  assert((await fallback.textContent()) === initial, `${title} must fall back to "${initial}".`);
  assert((await fallback.getAttribute('aria-hidden')) === 'true', 'The fallback is decorative.');
}

async function imageLoaded(page, image) {
  await image.waitFor();
  const handle = await image.elementHandle();
  await page.waitForFunction(
    (element) => element.complete && element.naturalWidth > 0 && element.getAttribute('alt') === '',
    handle,
  );
}

/* ───────────────────────── 2. Outcome and progress ───────────────────────── */

async function verifyOutcomeProgress(j, page) {
  ids.outcome = await createOutcomeInAxis(
    j,
    page,
    ids.axisA,
    T.outcome,
    'The guide is shared with the neighbourhood.',
    { start: addDays(today, 7), end: addDays(today, 90) },
  );
  await assertSingleH1(page, 'Outcome');
  await page.getByText('No progress measure').first().waitFor();
  const modes = page.getByRole('group', { name: 'Show progress as' });
  await modes.getByLabel('Set manually').check();
  await page.getByLabel('Percentage', { exact: true }).fill('40');
  await page.getByRole('button', { name: 'Save progress' }).click();
  await page.getByText('40% (set manually)').first().waitFor();
  await modes.getByLabel('From milestones').check();
  await page.getByRole('button', { name: 'Save progress' }).click();
  await page.getByText('No milestones yet').first().waitFor();
  j.checks.push(
    'Outcome in an Axis with a target; progress in words: none, 40% (set manually), from milestones',
  );
}

/* ───────────────────────── 3. Milestones ───────────────────────── */

async function verifyMilestones(j, page) {
  for (const [title, checkpoint] of [
    [T.milestone1, 'The outline is agreed with two neighbours.'],
    [T.milestone2, 'Every section has a first draft.'],
  ]) {
    await page.getByRole('button', { name: /^Add milestone…$/iu }).click();
    const dialog = page.getByRole('dialog', { name: 'New Milestone' });
    await dialog.waitFor();
    await dialog.getByLabel(/^Title/u).fill(title);
    await dialog.getByLabel(/^Measurable checkpoint/u).fill(checkpoint);
    await dialog.getByRole('button', { name: 'Create Milestone' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('link', { name: title, exact: true }).first().waitFor();
  }
  const list = () => page.getByRole('list', { name: `Milestones of ${T.outcome}` });
  await expectRowOrder(list(), [T.milestone1, T.milestone2], 'Milestones');
  await tabTo(page, list().getByRole('button', { name: `Move ${T.milestone2} up` }));
  await page.keyboard.press('Enter');
  await expectRowOrder(list(), [T.milestone2, T.milestone1], 'Milestones after Move up');
  await page.reload({ waitUntil: 'networkidle' });
  await expectRowOrder(list(), [T.milestone2, T.milestone1], 'Milestones after reload');
  await page.getByText('0 of 2 milestones completed').first().waitFor();
  ids.milestone1 = await idFromLink(list(), T.milestone1);
  ids.milestone2 = await idFromLink(list(), T.milestone2);
  j.checks.push('two Milestones created and reordered by keyboard; the order persists');
}

/* ───────────────────────── 4-5. Project and next action ───────────────────────── */

async function verifyProject(j, page) {
  await page.goto(`${j.origin}/outcomes/${ids.outcome}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('button', { name: /^Add project…$/iu }).click();
  const dialog = page.getByRole('dialog', { name: 'New Project' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill(T.project);
  await dialog.getByLabel(/^Desired result/u).fill('Every bed has a clear photo in the guide.');
  await dialog.getByRole('radio', { name: 'Active', exact: true }).check();
  await dialog.getByLabel(/^Notes/u).fill('Morning light works best.');
  await dialog.getByLabel(/^Target start/u).fill(addDays(today, 3));
  await dialog.getByLabel(/^Target end/u).fill(addDays(today, 30));
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await dialog.waitFor({ state: 'hidden' });
  // Creating opens the new Project with a notice and Undo.
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/u);
  ids.project = page.url().split('/').pop();
  await heading1(page, T.project);
  await page.getByText('Project created.').first().waitFor();
  await page.getByText('Every bed has a clear photo in the guide.').first().waitFor();
  // The Outcome lists it as its primary Project.
  await page.goto(`${j.origin}/outcomes/${ids.outcome}`, { waitUntil: 'networkidle' });
  await settle(page);
  const primary = page.getByRole('list', {
    name: `Projects with ${T.outcome} as their primary Outcome`,
  });
  assert(
    (await idFromLink(primary, T.project)) === ids.project,
    'The Outcome must list the new Project as primary.',
  );
  await primary.getByRole('link', { name: T.project, exact: true }).click();
  await heading1(page, T.project);
  j.checks.push('Project with desired result, notes, and target, linked as primary from creation');
}

async function verifyNextAction(j, page) {
  await page.getByText('No next action yet.').first().waitFor();
  await page.getByRole('button', { name: 'Add next action…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add an action' });
  await dialog.waitFor();
  await dialog.getByLabel(/^Title/u).fill(T.nextAction);
  await dialog.getByRole('button', { name: 'Add action', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('No next action yet.').first().waitFor({ state: 'hidden' });
  await page.getByRole('link', { name: T.nextAction, exact: true }).first().waitFor();
  ids.nextAction = await idFromLink(page.locator('main'), T.nextAction);
  await j.shot(page, 'project-next-action-1280x800');
  j.checks.push('an active Project without a next action says so; adding one clears the notice');
}

/* ───────────────────────── 6. Transitions ───────────────────────── */

async function transition(page, group, button, announcement, next) {
  const actions = page.getByRole('group', { name: group });
  await actions.getByRole('button', { name: button, exact: true }).click();
  await announced(page, announcement);
  await actions.getByRole('button', { name: next, exact: true }).waitFor();
}

async function verifyTransitions(j, page) {
  await page.goto(`${j.origin}/outcomes/${ids.outcome}`, { waitUntil: 'networkidle' });
  await settle(page);
  const outcome = 'Outcome actions';
  await transition(page, outcome, 'Pause', 'Outcome paused.', 'Resume');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await announced(page, 'Change undone.');
  await page
    .getByRole('group', { name: outcome })
    .getByRole('button', { name: 'Pause', exact: true })
    .waitFor();
  await transition(page, outcome, 'Pause', 'Outcome paused.', 'Resume');
  await transition(page, outcome, 'Resume', 'Outcome resumed.', 'Mark achieved');
  await transition(page, outcome, 'Mark achieved', 'Outcome marked achieved.', 'Reactivate');
  await transition(page, outcome, 'Reactivate', 'Outcome reactivated.', 'Abandon');
  await transition(
    page,
    outcome,
    'Abandon',
    'Outcome abandoned. Its history stays in reviews.',
    'Reactivate',
  );
  await transition(page, outcome, 'Reactivate', 'Outcome reactivated.', 'Pause');
  j.checks.push('Outcome pause, Undo, resume, achieve, reactivate, and abandon, each announced');

  await page.goto(`${j.origin}/projects/${ids.project}`, { waitUntil: 'networkidle' });
  await settle(page);
  const project = 'Project actions';
  await transition(page, project, 'Mark blocked', 'Project marked blocked.', 'Unblock');
  await transition(page, project, 'Pause', 'Project paused.', 'Resume');
  await transition(page, project, 'Complete', 'Project completed.', 'Reopen');
  await transition(page, project, 'Reopen', 'Project reopened.', 'Mark blocked');
  j.checks.push('Project block, pause, complete, and reopen, each announced');

  await page.goto(`${j.origin}/milestones/${ids.milestone1}`, { waitUntil: 'networkidle' });
  await settle(page);
  const milestone = 'Milestone actions';
  await transition(page, milestone, 'Complete', 'Milestone completed.', 'Reopen');
  await transition(page, milestone, 'Reopen', 'Milestone reopened.', 'Cancel milestone');
  await transition(
    page,
    milestone,
    'Cancel milestone',
    'Milestone canceled. It stays in history.',
    'Reopen',
  );
  await transition(page, milestone, 'Reopen', 'Milestone reopened.', 'Complete');
  j.checks.push('Milestone complete, reopen, and cancel, each announced; completion stays manual');
}

/* ───────────────────────── 7. Links ───────────────────────── */

async function verifyLinks(j, page) {
  // An archived Project outside any Axis: it is never offered for linking.
  await page.goto(`${j.origin}/axis`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('button', { name: 'Add Project…' }).click();
  const create = page.getByRole('dialog', { name: 'New Project' });
  await create.waitFor();
  await create.getByLabel(/^Title/u).fill(T.project2);
  await create.getByRole('button', { name: 'Create Project' }).click();
  await create.waitFor({ state: 'hidden' });
  await heading1(page, T.project2);
  ids.project2 = lastSegment(page);
  await archiveCurrent(page, 'Project');
  ids.project3 = await createProjectInAxis(
    j,
    page,
    ids.axisA,
    T.project3,
    'The cold frame shelters the seedlings.',
  );
  await capture(page, T.crossAction, { axis: T.axisB });

  await page.goto(`${j.origin}/milestones/${ids.milestone1}`, { waitUntil: 'networkidle' });
  await heading1(page, T.milestone1);
  await linkFromDialog(page, 'Link a project…', T.milestone1, T.project);
  await linkFromDialog(page, 'Link an action…', T.milestone1, T.nextAction);

  await page.getByRole('button', { name: 'Link a project…', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: `Link “${T.milestone1}”` });
  const existing = dialog.getByRole('radio', { name: titled(T.project) });
  await existing.waitFor();
  assert(await existing.isDisabled(), 'An existing link must not be offered again.');
  await dialog
    .getByText(/Already linked/u)
    .first()
    .waitFor();
  await dialog.getByText('Archived items are not listed. Restore one to link it.').waitFor();
  assert(
    (await dialog.getByRole('radio', { name: titled(T.project2) }).count()) === 0,
    'An archived Project must not be offered for linking.',
  );
  await j.shot(page, 'link-dialog-already-linked-1280x800');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  j.checks.push(
    'a Project and an Action linked to a Milestone; a duplicate shows "Already linked"; an archived Project is not offered, with the reason stated',
  );

  await page.goto(`${j.origin}/projects/${ids.project}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('button', { name: 'Link an action…', exact: true }).click();
  dialog = page.getByRole('dialog', { name: `Link “${T.project}”` });
  await dialog.getByRole('radio', { name: titled(T.crossAction) }).check();
  await dialog
    .getByText(/In a different Axis/u)
    .first()
    .waitFor();
  const confirm = dialog.getByRole('checkbox', { name: /Link across Axes/u });
  await confirm.waitFor();
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await dialog.getByText('Confirm “Link across Axes”, or choose another item.').waitFor();
  await confirm.check();
  await j.shot(page, 'link-cross-axis-1280x800');
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await announced(page, `Linked “${T.crossAction}” to “${T.project}”.`);
  j.checks.push('linking an Action from another Axis to a Project needs an explicit confirmation');
}

/* ───────────────────────── 8-9. Reparent and unlink ───────────────────────── */

async function verifyReparent(j, page) {
  ids.outcome2 = await createOutcomeInAxis(
    j,
    page,
    ids.axisA,
    T.outcome2,
    'Ten neighbours have seeds to plant.',
  );
  await page.goto(alignmentUrl(j.origin, 'milestone', ids.milestone1), {
    waitUntil: 'networkidle',
  });
  await settle(page);
  const above = page.getByRole('list', { name: `Above ${T.milestone1}` });
  const move = above.getByRole('button', { name: `Move to another Outcome… ${T.milestone1}` });
  await move.waitFor();
  assert(
    (await above.getByRole('button', { name: /^Unlink…/u }).count()) === 0,
    'The required Outcome of a Milestone must offer Move, never Unlink.',
  );
  const dialog = page.getByRole('dialog', { name: `Move “${T.milestone1}” to another Outcome` });
  for (const [outcome, title] of [
    [ids.outcome2, T.outcome2],
    [ids.outcome, T.outcome],
  ]) {
    await above.getByRole('button', { name: `Move to another Outcome… ${T.milestone1}` }).click();
    await dialog.waitFor();
    await dialog.getByLabel('New Outcome').selectOption(outcome);
    await dialog.getByRole('button', { name: 'Move milestone' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await announced(page, `Moved “${T.milestone1}” to “${title}”.`);
    await above.getByRole('link', { name: title, exact: true }).waitFor();
  }
  j.checks.push('a Milestone moves to another Outcome and back; its Outcome is never unlinked');
}

async function verifyUnlink(j, page) {
  await page.goto(`${j.origin}/milestones/${ids.milestone1}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('button', { name: `Unlink… ${T.project}` }).click();
  const dialog = page.getByRole('dialog', {
    name: `Unlink “${T.project}” from “${T.milestone1}”?`,
  });
  await dialog.getByText('Both stay; only this link is removed.').waitFor();
  await dialog.getByRole('button', { name: 'Unlink', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await announced(page, `Unlinked “${T.project}” from “${T.milestone1}”. Both stay.`);
  await page.goto(`${j.origin}/projects/${ids.project}`, { waitUntil: 'networkidle' });
  await heading1(page, T.project);
  await page.goto(`${j.origin}/milestones/${ids.milestone1}`, { waitUntil: 'networkidle' });
  await heading1(page, T.milestone1);
  j.checks.push('unlinking removes only the link; both objects still open');
}

/* ───────────────────────── 10. Alignment list and map, keyboard only ───────────────────────── */

/** Link a supporting Project to the selected Outcome with the keyboard only. */
async function keyboardLinkSupporting(page, view) {
  await tabTo(page, view.getByRole('button', { name: `Link… ${T.outcome}` }));
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: `Link “${T.outcome}”` });
  await dialog.waitFor();
  const supporting = dialog.getByRole('radio', { name: 'A supporting Project' });
  await waitForFocus(page, dialog.getByRole('radio', { checked: true }));
  for (let presses = 0; presses < 5 && !(await supporting.isChecked()); presses += 1)
    await page.keyboard.press('ArrowDown');
  assert(await supporting.isChecked(), 'Arrow keys must choose the relationship.');
  const search = dialog.getByRole('searchbox', { name: 'Search by title' });
  await tabTo(page, search);
  await page.keyboard.type('cold frame');
  const candidate = dialog.getByRole('radio', { name: titled(T.project3) });
  await candidate.waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('dialog[open] .link-candidate-list input').length === 1,
  );
  await tabTo(page, candidate);
  await page.keyboard.press('Space');
  await dialog.getByText(`Links “${T.project3}” to “${T.outcome}”.`).waitFor();
  await tabTo(page, dialog.getByRole('button', { name: 'Link', exact: true }));
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  await announced(page, `Linked “${T.project3}” to “${T.outcome}”.`);
  // The announcement can precede the re-query; wait until this view shows the new link.
  await view
    .getByRole('list', { name: `Supporting Projects below ${T.outcome}` })
    .getByRole('button', { name: `Unlink… ${T.project3}` })
    .waitFor();
}

/** Unlink the supporting Project from the selected Outcome with the keyboard only. */
async function keyboardUnlinkSupporting(page, view) {
  await tabTo(page, view.getByRole('button', { name: `Unlink… ${T.project3}` }));
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: `Unlink “${T.project3}” from “${T.outcome}”?`,
  });
  await dialog.waitFor();
  await waitForFocus(page, dialog.getByRole('button', { name: 'Keep link' }));
  await tabTo(page, dialog.getByRole('button', { name: 'Unlink', exact: true }));
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  await announced(page, `Unlinked “${T.project3}” from “${T.outcome}”. Both stay.`);
  // The dialog's opener left with the link, so focus must land on the selected heading, not the
  // page body.
  await waitForFocus(
    page,
    page.getByRole('heading', { level: 2, name: `Selected: Outcome ${T.outcome}` }),
  );
}

async function verifyAlignmentKeyboard(j, page) {
  await page.goto(`${j.origin}/axis/alignment`, { waitUntil: 'networkidle' });
  await assertSingleH1(page, 'Alignment');
  await heading1(page, 'Alignment');
  await page.getByRole('heading', { level: 2, name: 'Choose where to start' }).waitFor();
  const startLink = page
    .getByRole('list', { name: 'Axes', exact: true })
    .getByRole('link', { name: T.axisA, exact: true });
  await tabTo(page, startLink);
  await page.keyboard.press('Enter');
  await page.waitForURL(focusPattern('axis', ids.axisA));
  let selected = page.getByRole('heading', { level: 2, name: `Selected: Axis ${T.axisA}` });
  await selected.waitFor();
  await waitForFocus(page, selected);
  const summaryId = await selected.getAttribute('aria-describedby');
  assert(summaryId !== null, 'The selected heading must be described by the summary.');
  const summary = (await page.locator(`[id="${summaryId}"]`).textContent()) ?? '';
  assert(
    summary.startsWith(`Axis “${T.axisA}”. Above: nothing. Below: `),
    `Unexpected summary: ${summary}`,
  );

  // List view: Center, Inspect, Link, and Unlink.
  const axisList = page.getByRole('region', { name: `Relationship list for ${T.axisA}` });
  assert(
    (await axisList.getAttribute('aria-describedby')) === summaryId,
    'The relationship list must be described by the summary.',
  );
  await tabTo(page, axisList.getByRole('button', { name: `Center ${T.outcome}` }));
  await page.keyboard.press('Enter');
  await page.waitForURL(focusPattern('outcome', ids.outcome));
  selected = page.getByRole('heading', { level: 2, name: `Selected: Outcome ${T.outcome}` });
  await selected.waitFor();
  await waitForFocus(page, selected);
  const list = page.getByRole('region', { name: `Relationship list for ${T.outcome}` });
  const inspect = list.getByRole('button', { name: `Inspect ${T.milestone1}` });
  await tabTo(page, inspect);
  await page.keyboard.press('Enter');
  assert((await inspect.getAttribute('aria-pressed')) === 'true', 'Inspect must be pressed.');
  await page
    .getByRole('complementary', { name: 'Inspect' })
    .getByText(T.milestone1, { exact: true })
    .waitFor();
  await keyboardLinkSupporting(page, list);
  await list.getByRole('list', { name: `Supporting Projects below ${T.outcome}` }).waitFor();
  await j.shot(page, 'alignment-list-1280x800');
  const listNames = await buttonNames(list);
  await keyboardUnlinkSupporting(page, list);
  j.checks.push('relationship list by keyboard: Center, Inspect, Link, and Unlink');

  // Map view through the Show as radios, with the keyboard.
  await tabTo(page, page.getByRole('radio', { name: 'List', exact: true }));
  await page.keyboard.press('ArrowRight');
  await page.waitForURL(/view=map/u);
  const map = page.getByRole('region', { name: `Alignment map for ${T.outcome}` });
  await map.waitFor();
  assert(
    (await map.getAttribute('aria-describedby')) === summaryId,
    'The map must be described by the summary.',
  );
  assert(
    (await map.locator('svg').first().getAttribute('aria-hidden')) === 'true',
    'Map connectors must be hidden from assistive technology.',
  );
  await keyboardLinkSupporting(page, map);
  const mapNames = await buttonNames(map);
  assert(
    JSON.stringify(mapNames) === JSON.stringify(listNames),
    `List and map must offer the same named buttons.\nList: ${listNames.join(' | ')}\nMap: ${mapNames.join(' | ')}`,
  );
  const mapInspect = map.getByRole('button', { name: `Inspect ${T.project}` });
  await tabTo(page, mapInspect);
  await page.keyboard.press('Enter');
  assert((await mapInspect.getAttribute('aria-pressed')) === 'true', 'Map Inspect is pressed.');
  await j.shot(page, 'alignment-map-1280x800');
  await keyboardUnlinkSupporting(page, map);
  await tabTo(page, map.getByRole('button', { name: `Center ${T.axisA}` }));
  await page.keyboard.press('Enter');
  await page.waitForURL(focusPattern('axis', ids.axisA));
  selected = page.getByRole('heading', { level: 2, name: `Selected: Axis ${T.axisA}` });
  await waitForFocus(page, selected);
  j.checks.push(
    'map by keyboard: the same named buttons as the list; Inspect, Link, Unlink, and Center',
  );

  await page.goBack();
  await page.waitForURL(focusPattern('outcome', ids.outcome));
  await page.getByRole('heading', { level: 2, name: `Selected: Outcome ${T.outcome}` }).waitFor();
  assert(new URL(page.url()).searchParams.get('view') === 'map', 'Back keeps the map view.');
  await page.goForward();
  await page.waitForURL(focusPattern('axis', ids.axisA));
  await page.getByRole('heading', { level: 2, name: `Selected: Axis ${T.axisA}` }).waitFor();
  j.checks.push('Back and Forward restore the selected item from ?focus');
}

/* ───────────────────────── 11. Copy audit ───────────────────────── */

async function verifyCopy(j, page) {
  const paths = [
    '/axis',
    `/axis/${ids.axisA}`,
    `/outcomes/${ids.outcome}`,
    `/projects/${ids.project}`,
    `/milestones/${ids.milestone1}`,
    `/actions/${ids.nextAction}`,
    `/axis/alignment?focus=outcome:${ids.outcome}`,
    `/axis/alignment?focus=outcome:${ids.outcome}&view=map`,
    `/axis/alignment?focus=project:${ids.project}`,
  ];
  for (const path of paths) {
    await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
    await settle(page);
    const text = await page.locator('main').innerText();
    assert(
      !forbiddenWording(text),
      `${path} uses score, streak, assistant, or percentage wording.`,
    );
  }
  j.checks.push('copy audit: no score, streak, assistant, or aligned-percentage wording');
}

/* ───────────────────────── 12. Archive and restore ───────────────────────── */

async function verifyArchive(j, page) {
  await page.goto(`${j.origin}/outcomes/${ids.outcome}`, { waitUntil: 'networkidle' });
  await settle(page);
  await archiveCurrent(page, 'Outcome');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await announced(page, 'Change undone.');
  await page.getByRole('group', { name: 'Outcome actions' }).waitFor();

  await archiveCurrent(page, 'Outcome');
  await page.goto(`${j.origin}/milestones/${ids.milestone1}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByText('Archived parent').first().waitFor();
  await j.shot(page, 'milestone-archived-parent-1280x800');
  await page.goto(`${j.origin}/outcomes/${ids.outcome}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('button', { name: 'Restore', exact: true }).first().click();
  await announced(page, 'Outcome restored.');
  await page.getByRole('group', { name: 'Outcome actions' }).waitFor();
  j.checks.push('archiving an Outcome shows "Archived parent" on its Milestones; Undo and Restore');

  await page.goto(`${j.origin}/axis/${ids.axisA}`, { waitUntil: 'networkidle' });
  await settle(page);
  await archiveCurrent(page, 'Axis');
  await page.getByRole('button', { name: 'Restore', exact: true }).first().click();
  await announced(page, 'Axis restored.');
  await page.getByRole('link', { name: T.outcome, exact: true }).first().waitFor();
  await page.goto(alignmentUrl(j.origin, 'outcome', ids.outcome), { waitUntil: 'networkidle' });
  await settle(page);
  await page
    .getByRole('list', { name: `Above ${T.outcome}` })
    .getByRole('link', { name: T.axisA, exact: true })
    .waitFor();
  j.checks.push('archiving and restoring an Axis keeps every link');
}

/* ───────────────────────── 13. Permanent deletion ───────────────────────── */

async function verifyDelete(j, page) {
  await page.goto(`${j.origin}/outcomes/${ids.outcome}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('button', { name: 'Delete permanently…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Delete this Outcome permanently?' });
  await dialog
    .getByText('This Outcome still owns 2 milestones. Move or delete each one first.')
    .waitFor();
  assert(
    (await dialog.getByRole('button', { name: 'Continue', exact: true }).count()) === 0,
    'An Outcome that owns Milestones must not offer deletion.',
  );
  await j.shot(page, 'delete-blocked-1280x800');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });

  await page.goto(`${j.origin}/milestones/${ids.milestone2}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('button', { name: 'Delete permanently…' }).click();
  dialog = page.getByRole('dialog', { name: 'Delete this Milestone permanently?' });
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  const confirmation = dialog.getByLabel('Type the Milestone title to confirm');
  await confirmation.waitFor();
  await dialog.getByText('This cannot be undone.').waitFor();
  const destroy = dialog.getByRole('button', { name: 'Delete permanently', exact: true });
  assert(await destroy.isDisabled(), 'Delete stays disabled until the title matches.');
  await confirmation.fill(T.milestone2);
  await destroy.click();
  await page.waitForURL(new RegExp(`/outcomes/${ids.outcome}$`, 'u'));
  await heading1(page, T.outcome);
  await page.goto(`${j.origin}/milestones/${ids.milestone2}`, { waitUntil: 'networkidle' });
  await heading1(page, 'This Milestone is unavailable');
  j.checks.push(
    'permanent delete: blocked while an Outcome owns Milestones; a typed title deletes a Milestone and opens its Outcome',
  );
}

/* ───────────────────────── 14. Inbox Plan with a Milestone ───────────────────────── */

async function verifyInboxMilestone(j, page) {
  await page.goto(`${j.origin}/inbox`, { waitUntil: 'networkidle' });
  await capture(page, T.inboxAction);
  const row = page
    .getByRole('list', { name: 'Inbox Actions' })
    .locator('li')
    .filter({ hasText: T.inboxAction });
  await row.getByText('Triage', { exact: true }).click();
  await row.getByLabel('Milestone').selectOption({ label: `${T.milestone1} · ${T.outcome}` });
  await row.getByRole('button', { name: 'Plan', exact: true }).click();
  await row.waitFor({ state: 'detached' });
  await page.goto(`${j.origin}/milestones/${ids.milestone1}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page
    .getByRole('list', { name: `Actions supporting ${T.milestone1}` })
    .getByRole('link', { name: T.inboxAction, exact: true })
    .waitFor();
  j.checks.push('Inbox Plan with an optional Milestone links the Action to that Milestone');
}

/* ───────────────────────── 15. Deep links ───────────────────────── */

async function verifyDeepLinks(j, page) {
  const missing = '00000000-0000-4000-8000-000000000000';
  for (const [path, kind] of [
    ['/axis', 'Axis'],
    ['/outcomes', 'Outcome'],
    ['/projects', 'Project'],
    ['/milestones', 'Milestone'],
  ]) {
    for (const id of ['not-an-id', missing]) {
      await page.goto(`${j.origin}${path}/${id}`, { waitUntil: 'networkidle' });
      await heading1(page, `This ${kind} is unavailable`);
      await assertSingleH1(page, `${path}/${id}`);
    }
  }
  await page.goto(`${j.origin}/axis/alignment?focus=goal:${missing}`, {
    waitUntil: 'networkidle',
  });
  await page.getByRole('heading', { level: 2, name: 'This item is unavailable' }).waitFor();
  await page.goto(alignmentUrl(j.origin, 'outcome', missing), { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 2, name: 'This Outcome is unavailable' }).waitFor();
  await assertSingleH1(page, 'Alignment, missing item');

  await page.goto(`${j.origin}/projects/${ids.project2}`, { waitUntil: 'networkidle' });
  await page.getByText('Archived. Restore it to make changes.').first().waitFor();
  await page.goto(alignmentUrl(j.origin, 'project', ids.project2), { waitUntil: 'networkidle' });
  await settle(page);
  await page
    .getByText(/Archived\. Restore it on its page to make changes\./u)
    .first()
    .waitFor();
  assert(
    (await page.getByRole('button', { name: /^Link…/u }).count()) === 0,
    'An archived item must not offer Link.',
  );
  j.checks.push('malformed, missing, and archived ids show calm, safe states on every route');

  // The planning Month view lists a Milestone that targets the month and opens its alignment page.
  await page.goto(`${j.origin}/milestones/${ids.milestone1}`, { waitUntil: 'networkidle' });
  await heading1(page, T.milestone1);
  await page.getByRole('button', { name: 'Edit…', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Milestone' });
  await edit.getByLabel(/^Target start/u).fill(today);
  await edit.getByLabel(/^Target end/u).fill(today);
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await edit.waitFor({ state: 'hidden' });
  await announced(page, 'Milestone saved.');
  await page.goto(`${j.origin}/plan/month/${today}`, { waitUntil: 'networkidle' });
  await page
    .getByRole('list', { name: 'Milestones this month' })
    .getByRole('link', { name: T.milestone1, exact: true })
    .click();
  await page.waitForURL(new RegExp(`/milestones/${ids.milestone1}$`, 'u'));
  await heading1(page, T.milestone1);
  j.checks.push('the Month view lists a Milestone by its target and opens the Milestone page');
}

/* ───────────────────────── 16. Offline and restart ───────────────────────── */

async function verifyOffline(j, context, page, externalRequests, browserErrors) {
  await page.goto(`${j.origin}/milestones/${ids.milestone1}`, { waitUntil: 'networkidle' });
  await heading1(page, T.milestone1);
  await context.setOffline(true);
  if (j.inFirefox) {
    // Firefox covers website use: go offline on an already loaded plan.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  } else {
    // Chromium also proves the PWA shell reloads offline.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await heading1(page, T.milestone1);
  }
  await page.locator('.offline-banner').waitFor();

  await linkFromDialog(page, 'Link a project…', T.milestone1, T.project3);
  await page.getByRole('button', { name: `Unlink… ${T.project3}` }).click();
  let dialog = page.getByRole('dialog', {
    name: `Unlink “${T.project3}” from “${T.milestone1}”?`,
  });
  await dialog.getByRole('button', { name: 'Unlink', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await linkFromDialog(page, 'Link a project…', T.milestone1, T.project3);

  await page.locator('.primary-nav').getByRole('link', { name: 'Axis', exact: true }).click();
  await heading1(page, 'Axes');
  // Chromium reloaded offline above, so this picture comes from the service-worker precache.
  await rowIconLoaded(page, T.axisA);
  await page.getByRole('button', { name: 'New Axis…' }).click();
  dialog = page.getByRole('dialog', { name: 'New Axis' });
  await dialog.getByLabel(/^Title/u).fill(T.axisOffline);
  await dialog.getByRole('button', { name: 'Create Axis' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await heading1(page, T.axisOffline);
  ids.axisOffline = lastSegment(page);
  // An offline edit is saved locally and survives the offline reload and the restart.
  await page.getByRole('button', { name: 'Edit…', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Axis' });
  await dialog.getByLabel(/^Purpose/u).fill(T.axisOfflinePurpose);
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await announced(page, 'Axis saved.');
  await page.getByText(T.axisOfflinePurpose, { exact: true }).first().waitFor();
  await archiveCurrent(page, 'Axis');
  await page.getByRole('button', { name: 'Restore', exact: true }).first().click();
  await announced(page, 'Axis restored.');
  if (!j.inFirefox) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await heading1(page, T.axisOffline);
    await page.getByText(T.axisOfflinePurpose, { exact: true }).first().waitFor();
  }
  await context.setOffline(false);
  j.checks.push(
    j.inFirefox
      ? 'website offline (Firefox): create, edit, link, unlink, archive, and restore'
      : 'offline (Chromium): create, edit, link, unlink, archive, restore, and an offline reload',
  );

  const cachedCount = await assertStaticCaches(page, j.origin, Object.values(ids));
  j.checks.push(`service-worker caches hold ${String(cachedCount)} static assets only`);

  await context.close();
  const next = await j.launch();
  const nextPage = next.pages()[0] ?? (await next.newPage());
  j.observe(nextPage, externalRequests, browserErrors);
  await nextPage.goto(`${j.origin}/milestones/${ids.milestone1}`, { waitUntil: 'networkidle' });
  await heading1(nextPage, T.milestone1);
  await nextPage
    .getByRole('list', { name: `Projects supporting ${T.milestone1}` })
    .getByRole('link', { name: T.project3, exact: true })
    .waitFor();
  await nextPage.goto(`${j.origin}/axis`, { waitUntil: 'networkidle' });
  await heading1(nextPage, 'Axes');
  await expectRowOrder(
    nextPage.getByRole('list', { name: 'Axes', exact: true }),
    [T.axisA, T.axisB, T.axisOffline],
    'Axes after restart',
  );
  await rowIconLoaded(nextPage, T.axisA);
  await rowFallback(nextPage, T.axisB, 'C');
  await nextPage.goto(`${j.origin}/axis/${ids.axisOffline}`, { waitUntil: 'networkidle' });
  await heading1(nextPage, T.axisOffline);
  await nextPage.getByText(T.axisOfflinePurpose, { exact: true }).first().waitFor();
  j.checks.push(
    'a full browser restart keeps offline changes, the offline edit, and the Axis order',
  );
  return { context: next, page: nextPage };
}

/* ───────────────────────── 17. Layouts ───────────────────────── */

async function verifyLayouts(j, page) {
  const list = `/axis/alignment?focus=outcome:${ids.outcome}`;
  const map = `${list}&view=map`;
  const pages = [
    [list, 'alignment-list'],
    [map, 'alignment-map'],
    ['/axis', 'axis-overview'],
    [`/axis/${ids.axisA}`, 'axis-detail'],
    [`/outcomes/${ids.outcome}`, 'outcome'],
    [`/projects/${ids.project}`, 'project'],
    [`/milestones/${ids.milestone1}`, 'milestone'],
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
      if (label.startsWith('alignment'))
        await j.shot(page, `${label}-${String(width)}x${String(height)}`);
    }
  }
  j.checks.push(
    'no horizontal overflow and 44 px targets at 1024x768, 1280x800, 1440x900, and 1920x1080',
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [path, label] of [
    [list, 'alignment-list'],
    [map, 'alignment-map'],
  ]) {
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
  await page.setViewportSize({ width: 1280, height: 800 });
  j.checks.push('the relationship list and the map reflow at 200% text');
}

/* ───────────────────────── 18. Themes and motion ───────────────────────── */

async function verifyThemes(j, page) {
  const list = `/axis/alignment?focus=outcome:${ids.outcome}`;
  const map = `${list}&view=map`;
  await page.goto(`${j.origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Full', { exact: true }).check();
  await page.goto(`${j.origin}${map}`, { waitUntil: 'networkidle' });
  await settle(page);
  const emphasis = await page.locator('.map-node').evaluateAll((nodes) =>
    Math.max(
      0,
      ...nodes.flatMap((node) =>
        getComputedStyle(node)
          .transitionDuration.split(',')
          .map((part) => Number.parseFloat(part) || 0),
      ),
    ),
  );
  assert(
    emphasis <= 0.18,
    `Map selection emphasis must last at most 180 ms (${String(emphasis)} s).`,
  );
  const animations = await page
    .locator('main *')
    .evaluateAll(
      (elements) =>
        elements.filter((element) => getComputedStyle(element).animationName !== 'none').length,
    );
  assert(animations === 0, `The alignment map must not animate (${String(animations)} animated).`);
  j.checks.push('map selection emphasis at most 180 ms; no ambient animation');

  await page.goto(`${j.origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Dark', { exact: true }).check();
  await page.getByLabel('Reduced', { exact: true }).check();
  for (const [path, name] of [
    [list, 'alignment-list-dark-reduced-1280x800'],
    [map, 'alignment-map-dark-reduced-1280x800'],
    [`/outcomes/${ids.outcome}`, 'outcome-dark-reduced-1280x800'],
    [`/projects/${ids.project}`, 'project-dark-reduced-1280x800'],
  ]) {
    await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
    await settle(page);
    await assertNoOverflow(page, `${path} dark reduced`);
    await j.shot(page, name);
  }
  await page.goto(`${j.origin}${map}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('button', { name: `Inspect ${T.milestone1}` }).click();
  const animated = await animatedElementCount(page);
  assert(animated === 0, `Reduced motion must remove animation (${String(animated)} animated).`);

  await page.goto(`${j.origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Light', { exact: true }).check();
  for (const [path, name] of [
    [list, 'alignment-list-light-reduced-1280x800'],
    [map, 'alignment-map-light-reduced-1280x800'],
  ]) {
    await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
    await settle(page);
    await j.shot(page, name);
  }
  await page.goto(`${j.origin}/settings`, { waitUntil: 'networkidle' });
  await page.getByLabel('Use system appearance').check();
  await page.getByLabel('Use system motion setting').check();
  j.checks.push('dark and light themes with reduced motion and no animated elements in main');
}

/* ───────────────────────── 19. Focus, unsaved guard, navigation ───────────────────────── */

async function verifyFocusAndGuard(j, page) {
  await page.goto(alignmentUrl(j.origin, 'outcome', ids.outcome), { waitUntil: 'networkidle' });
  await settle(page);
  const opener = page.getByRole('button', { name: `Link… ${T.outcome}` });
  await tabTo(page, opener);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: `Link “${T.outcome}”` });
  await dialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.closest('dialog[open]') !== null);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert(
    await opener.evaluate((element) => element === document.activeElement),
    'Escape must return focus to the control that opened the dialog.',
  );
  j.checks.push('Escape closes a link dialog and returns focus to its opener');

  await page.goto(`${j.origin}/outcomes/${ids.outcome}`, { waitUntil: 'networkidle' });
  await settle(page);
  await page.getByRole('group', { name: 'Show progress as' }).getByLabel('Set manually').check();
  await page.getByLabel('Percentage', { exact: true }).fill('55');
  const planLink = page.locator('.primary-nav').getByRole('link', { name: 'Plan', exact: true });
  await planLink.click();
  const leave = page.getByRole('dialog', { name: 'Save your changes before leaving?' });
  await leave.waitFor();
  for (const name of ['Save', 'Discard', 'Continue editing'])
    await leave.getByRole('button', { name, exact: true }).waitFor();
  await leave.getByRole('button', { name: 'Continue editing', exact: true }).click();
  await leave.waitFor({ state: 'hidden' });
  assert(
    new URL(page.url()).pathname === `/outcomes/${ids.outcome}`,
    'Continue editing must stay on the Outcome.',
  );
  await planLink.click();
  await leave.waitFor();
  await leave.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.waitForURL(/\/plan\//u);
  j.checks.push('unsaved progress offers Save, Discard, or Continue editing before leaving');

  for (const path of [
    '/axis',
    `/axis/${ids.axisA}`,
    `/axis/alignment?focus=outcome:${ids.outcome}`,
    `/outcomes/${ids.outcome}`,
    `/projects/${ids.project}`,
    `/milestones/${ids.milestone1}`,
  ]) {
    await page.goto(`${j.origin}${path}`, { waitUntil: 'networkidle' });
    await settle(page);
    const current = await page
      .locator('.primary-nav')
      .getByRole('link', { name: 'Axis', exact: true })
      .getAttribute('aria-current');
    assert(current === 'page', `${path}: the Axis navigation item must stay current.`);
  }
  j.checks.push('the Axis navigation item stays current on every Axis-area page');
}
