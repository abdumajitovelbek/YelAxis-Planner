import {
  animatedElementCount,
  assert,
  assertNoOverflow,
  assertSingleH1,
  assertStaticCaches,
  assertTargets,
  blockForeignRequests,
  completeMinimalOnboarding,
  poll,
  runJourney,
  tabTo,
  unlabelledFields,
  waitForFocus,
} from './lib/journey.mjs';

// Fictional user-entered data only. Firefox covers offline navigation; Chromium also restarts offline.
const T = {
  axis: 'Search synthetic Axis',
  project: 'Search synthetic Project',
  outcome: 'Search synthetic Outcome',
  milestone: 'Search synthetic Milestone',
  action: 'Search Unicode Action',
  note: 'Search kept Note',
  archived: 'Search archived specimen',
  deleted: 'Search deletion specimen',
};
const actionNote = (
  'CAFÉ—СЛОН Recovery precision ' + 'every complete value is retained. '.repeat(180)
).trim();
const keptNote = (
  'Kept note precision <script>plain text</script> ' +
  'full lightweight prose survives restart. '.repeat(120)
).trim();
const clock = new Date('2026-10-03T10:00:00.000Z');
await runJourney(
  {
    basePort: 9300,
    name: 'recovery-search',
    timeZone: 'Asia/Tashkent',
    title: 'recovery Search',
    timeoutMinutes: 10,
  },
  async (j) => {
    let context = await openContext(j);
    let page = context.pages()[0] ?? (await context.newPage());
    const errors = [];
    const external = [];
    const blocked = [];
    j.observe(page, external, errors);
    await blockForeignRequests(context, j.origin, blocked);
    const ids = {};
    try {
      j.step('local onboarding, empty query, and keyboard Search navigation');
      await page.goto(j.origin, { waitUntil: 'networkidle' });
      await completeMinimalOnboarding(page);
      await tabTo(page, page.getByRole('link', { name: 'Search', exact: true }));
      await page.keyboard.press('Enter');
      await searchReady(page);
      await assertSingleH1(page, 'Search');
      await page.getByRole('searchbox').fill('unique nonexistent search fixture');
      await page.getByText('No matching records.', { exact: true }).waitFor();
      j.checks.push(
        'Search keyboard navigation, live local query, bounded loading and empty state',
      );

      j.step('create canonical Axis, Outcome, Project, and Milestone');
      await page.goto(`${j.origin}/axis`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'New Axis…' }).click();
      let dialog = page.getByRole('dialog', { name: 'New Axis' });
      await dialog.getByLabel(/^Title/u).fill(T.axis);
      await dialog.getByLabel(/^Purpose/u).fill('Search purpose precision');
      await dialog.getByRole('button', { name: 'Create Axis', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await h1(page, T.axis);
      ids.axis = lastId(page);
      await page.getByRole('button', { name: 'Add Outcome…' }).click();
      dialog = page.getByRole('dialog', { name: 'New Outcome' });
      await dialog.getByLabel(/^Title/u).fill(T.outcome);
      await dialog.getByLabel(/^Success definition/u).fill('Search success precision');
      await dialog.getByRole('button', { name: 'Create Outcome', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await h1(page, T.outcome);
      ids.outcome = lastId(page);
      await page.getByRole('button', { name: 'Add Milestone…' }).click();
      dialog = page.getByRole('dialog', { name: 'New Milestone' });
      await dialog.getByLabel(/^Title/u).fill(T.milestone);
      await dialog.getByLabel(/^Measurable checkpoint/u).fill('Search checkpoint precision');
      await dialog.getByRole('button', { name: 'Create Milestone', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.goto(`${j.origin}/axis/${ids.axis}`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Add Project…' }).click();
      dialog = page.getByRole('dialog', { name: 'New Project' });
      await dialog.getByLabel(/^Title/u).fill(T.project);
      await dialog.getByLabel(/^Desired result/u).fill('Search desired-result precision');
      await dialog.getByLabel(/^Notes/u).fill('Search project-prose precision');
      await dialog.getByRole('radio', { name: 'Active', exact: true }).check();
      await dialog.getByRole('button', { name: 'Create Project', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await h1(page, T.project);
      ids.project = lastId(page);
      j.checks.push(
        'normal canonical creation populates Axis purpose, Outcome success, Project prose, and Milestone checkpoint index',
      );

      j.step('manual Capture and full Unicode text');
      await capture(page, T.action, actionNote, {
        axis: ids.axis,
        project: ids.project,
        planned: '2026-10-06',
        due: '2026-10-09',
      });
      await visitSearch(j, page);
      await page.getByRole('searchbox').fill('cafe\u0301 сло');
      await result(page, T.action);
      await page.getByRole('link', { name: T.action, exact: true }).click();
      await h1(page, T.action);
      const full = await page.locator('.search-detail-text').textContent();
      assert(full === actionNote, 'Search detail must contain every original prose character');
      await page.getByRole('link', { name: 'Open Action', exact: true }).click();
      await h1(page, T.action);
      ids.action = lastId(page);
      j.checks.push(
        'Unicode normalization and all prefix words match; full Action note is unchanged and canonical detail remains reachable',
      );

      j.step('Keep as Note, readonly full values, and injection-safe prose');
      await capture(page, T.note, keptNote);
      await page.getByRole('link', { name: 'Inbox', exact: true }).click();
      await page.getByRole('heading', { name: 'Decide what happens next.' }).waitFor();
      const row = page.locator('.inbox-list > li').filter({ hasText: T.note });
      await row.getByText('Triage', { exact: true }).click();
      await row.getByRole('button', { name: 'Keep as Note', exact: true }).click();
      await row.waitFor({ state: 'hidden' });
      await visitSearch(j, page);
      await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption('note');
      await page.getByRole('searchbox').fill('kept precision');
      await result(page, T.note);
      await page.getByRole('link', { name: T.note, exact: true }).click();
      await h1(page, T.note);
      assert(
        (await page.locator('.search-detail-text').textContent()) === keptNote,
        'Full Note body must not be truncated',
      );
      assert(
        (await page.locator('.search-detail-text script').count()) === 0,
        'User prose must render as plain text',
      );
      j.checks.push(
        'Keep as Note is immediately indexed and full Notes display plain text without interpretation',
      );

      j.step('archive and permanent deletion remove stale matches');
      await capture(page, T.archived, 'Archive-only precision');
      await visitSearch(j, page);
      await page.getByRole('searchbox').fill('archived specimen');
      await result(page, T.archived);
      await page.getByRole('link', { name: T.archived, exact: true }).click();
      await page.getByRole('link', { name: 'Open Action', exact: true }).click();
      await h1(page, T.archived);
      await page.getByRole('button', { name: 'Archive', exact: true }).click();
      await page.getByText('Action · archived', { exact: true }).waitFor();
      await visitSearch(j, page);
      await page.getByRole('searchbox').fill('archived specimen');
      await page.getByText('No matching records.', { exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Archive', exact: true }).selectOption('only');
      await result(page, T.archived);
      await capture(page, T.deleted, 'Deletion precision');
      await visitSearch(j, page);
      await page.getByRole('searchbox').fill('deletion specimen');
      await result(page, T.deleted);
      await page.getByRole('link', { name: T.deleted, exact: true }).click();
      await page.getByRole('link', { name: 'Open Action', exact: true }).click();
      await h1(page, T.deleted);
      ids.deleted = lastId(page);
      await page.getByRole('button', { name: 'Delete permanently…' }).click();
      dialog = page.getByRole('dialog', { name: 'Permanently delete Action?' });
      await dialog.getByLabel('Action title').fill(T.deleted);
      await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await visitSearch(j, page);
      await page.getByRole('combobox', { name: 'Archive', exact: true }).selectOption('include');
      await page.getByRole('searchbox').fill('deletion specimen');
      await page.getByText('No matching records.', { exact: true }).waitFor();
      await page.goto(`${j.origin}/search/action/${ids.deleted}`, { waitUntil: 'networkidle' });
      await h1(page, 'Record unavailable');
      j.checks.push(
        'archive defaults, archived-only recovery, permanent deletion and stale deep-link exclusion',
      );

      j.step('saved Review prose is indexed before completion');
      await page.goto(`${j.origin}/end-day/2026-10-03`, { waitUntil: 'networkidle' });
      await h1(page, 'End day');
      await page.getByLabel('Note (optional)').fill('Search reflection precision');
      await page.getByRole('button', { name: 'Save for later', exact: true }).click();
      await page
        .getByText('Saved. You can resume this review from Review.', { exact: true })
        .waitFor();
      await visitSearch(j, page);
      await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption('review');
      await page.getByRole('searchbox').fill('reflection precision');
      await poll(
        () =>
          page
            .locator('.search-result-list > li')
            .count()
            .then((n) => n === 1),
        'Saved review is not indexed',
      );
      j.checks.push(
        'saved review notes are indexed locally without finishing or applying the review',
      );

      j.step('every Search filter and validation');
      await verifyFilters(j, page, ids);
      j.checks.push(
        'type, state, Axis, Project, archive, created/updated/due/planned dates combine and validate',
      );

      j.step('recoverable query interruption and retry');
      await page.evaluate(() => {
        window.__searchFailNext = true;
      });
      await page.getByRole('searchbox').fill('unicode action');
      await page.getByRole('alert').filter({ hasText: 'Search could not be read.' }).waitFor();
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await result(page, T.action);
      j.checks.push(
        'a bounded worker query interruption produces a recoverable Search error and Retry reads the unchanged plan',
      );

      j.step('offline filters and restart');
      if (!j.inFirefox) {
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.reload({ waitUntil: 'networkidle' });
        await searchReady(page);
        await context.close();
        context = await openContext(j);
        page = context.pages()[0] ?? (await context.newPage());
        j.observe(page, external, errors);
        await blockForeignRequests(context, j.origin, blocked);
        await context.setOffline(true);
        await page.goto(`${j.origin}/search`, { waitUntil: 'domcontentloaded' });
        await searchReady(page);
      } else {
        await context.setOffline(true);
        await page.getByRole('button', { name: 'Reset search', exact: true }).click();
      }
      await verifyFilters(j, page, ids);
      j.checks.push(
        j.inFirefox
          ? 'every filter works with network disabled (offline process restart is Chromium coverage)'
          : 'Search and every filter survive a full browser process restart with network disabled',
      );

      j.step('keyboard results, laptop/desktop layouts, themes, zoom, and reduced motion');
      await page.getByRole('button', { name: 'Reset search', exact: true }).click();
      await page.getByRole('searchbox').fill('unicode action');
      await result(page, T.action);
      await tabTo(page, page.getByRole('link', { name: T.action, exact: true }));
      await page.keyboard.press('Enter');
      await h1(page, T.action);
      await assertSingleH1(page, 'Full Search detail');
      await tabTo(page, page.getByRole('link', { name: 'Back to Search', exact: true }));
      await page.keyboard.press('Enter');
      await searchReady(page);
      for (const size of [
        { width: 1280, height: 800 },
        { width: 1440, height: 900 },
        { width: 320, height: 900 },
      ]) {
        await page.setViewportSize(size);
        await assertNoOverflow(page, `Search ${size.width}`);
        await assertTargets(page, `Search ${size.width}`);
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await assertNoOverflow(page, 'Search 200% text');
      await assertTargets(page, 'Search 200% text');
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '';
      });
      for (const theme of ['Light', 'Dark']) {
        await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
        await page.getByLabel(theme, { exact: true }).check();
        await page.getByLabel('Reduced', { exact: true }).check();
        await page.getByRole('link', { name: 'Search', exact: true }).click();
        await searchReady(page);
        assert((await animatedElementCount(page)) === 0, 'Search must honor reduced motion');
        await assertNoOverflow(page, `Search ${theme}`);
        await j.shot(page, `${theme.toLowerCase()}-1280x800`);
      }
      assert(
        (await unlabelledFields(page)).length === 0,
        'Every Search field requires an accessible label',
      );
      j.checks.push(
        'keyboard result/detail navigation; 1280/1440/320 px, 200% text, both themes, 44 px controls, and reduced motion',
      );
      if (!j.inFirefox) {
        const cached = await assertStaticCaches(page, j.origin, Object.values(ids));
        j.checks.push(
          `service-worker caches contain only static assets (${cached} URLs), never query or result data`,
        );
      }
      assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);
      assert(
        external.length === 0 && blocked.length === 0,
        'Local Search must make no external requests',
      );
      j.checks.push('no browser errors or external requests');
      return {
        browserErrors: errors,
        externalRequests: external,
        blockedRequests: blocked,
        offlineRestartSkipped: j.inFirefox,
      };
    } catch (error) {
      await page
        .screenshot({
          path: `/tmp/yelaxis-recovery-search-${j.browserLabel}-failure.png`,
          fullPage: true,
        })
        .catch(() => undefined);
      throw error;
    } finally {
      await context.close();
    }
  },
);

async function openContext(j) {
  const context = await j.launch();
  await context.clock.install({ time: clock });
  await context.addInitScript(() => {
    const Original = window.Worker;
    window.Worker = class extends Original {
      postMessage(message, ...rest) {
        if (
          window.__searchFailNext === true &&
          message?.operation === 'all' &&
          message.sql?.includes('FROM search_documents d') &&
          message.parameters?.includes('unicode')
        ) {
          window.__searchFailNext = false;
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: {
                  id: message.id,
                  ok: false,
                  error: {
                    code: 'database_operation_failed',
                    message: 'Synthetic bounded read interruption',
                  },
                },
              }),
            ),
          );
          return;
        }
        return super.postMessage(message, ...rest);
      }
    };
  });
  return context;
}
async function h1(page, name) {
  await page.getByRole('heading', { name, level: 1, exact: true }).waitFor();
}
function lastId(page) {
  return new URL(page.url()).pathname.split('/').pop();
}
async function searchReady(page) {
  await h1(page, 'Search');
  await page.locator('.search-page[aria-busy=false]').waitFor();
}
async function visitSearch(j, page) {
  await page.goto(`${j.origin}/search`, { waitUntil: 'networkidle' });
  await searchReady(page);
}
async function result(page, title) {
  await page.getByRole('link', { name: title, exact: true }).waitFor();
  await page.locator('.search-page[aria-busy=false]').waitFor();
}
async function capture(page, title, note, { axis, project, planned, due } = {}) {
  await page.getByRole('button', { name: /Capture Alt C/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to Inbox' });
  await dialog.getByText('More details', { exact: true }).click();
  await dialog.getByLabel(/^Title/u).fill(title);
  await dialog.getByLabel(/^Note/u).fill(note);
  if (axis) await dialog.getByRole('combobox', { name: 'Axis', exact: true }).selectOption(axis);
  if (project)
    await dialog.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project);
  if (planned) await dialog.getByLabel('Planned date', { exact: true }).fill(planned);
  if (due) await dialog.getByLabel('Due date', { exact: true }).fill(due);
  await dialog.getByRole('button', { name: 'Capture', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function verifyFilters(j, page, ids) {
  await page.getByRole('button', { name: 'Reset search', exact: true }).click();
  await page.getByRole('searchbox').fill('unicode action');
  await result(page, T.action);
  await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption('action');
  await page.getByRole('combobox', { name: 'State', exact: true }).selectOption('planned');
  await page.getByRole('combobox', { name: 'Axis', exact: true }).selectOption(ids.axis);
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(ids.project);
  await page.getByRole('combobox', { name: 'Archive', exact: true }).selectOption('include');
  await result(page, T.action);
  for (const [basis, date] of [
    ['updated', '2026-10-03'],
    ['created', '2026-10-03'],
    ['due', '2026-10-09'],
    ['planned', '2026-10-06'],
  ]) {
    await page.getByLabel('From date', { exact: true }).fill('');
    await page.getByLabel('Through date', { exact: true }).fill('');
    await page.getByRole('combobox', { name: 'Date basis', exact: true }).selectOption(basis);
    await page.getByLabel('From date', { exact: true }).fill(date);
    await page.getByLabel('Through date', { exact: true }).fill(date);
    await result(page, T.action);
  }
  await page.getByLabel('From date', { exact: true }).fill('2026-10-10');
  await page.getByRole('alert').filter({ hasText: 'Search filters are invalid.' }).waitFor();
  await page.getByLabel('From date', { exact: true }).fill('2026-10-06');
  await result(page, T.action);
  await page.getByRole('button', { name: 'Reset search', exact: true }).click();
  await waitForFocus(page, page.getByRole('searchbox'), {
    label: 'Reset returns focus to Search text',
  });
  for (const [kind, text, title] of [
    ['axis', 'purpose precision', T.axis],
    ['outcome', 'success precision', T.outcome],
    ['project', 'project prose precision', T.project],
    ['milestone', 'checkpoint precision', T.milestone],
    ['note', 'kept precision', T.note],
  ]) {
    await page.getByRole('searchbox').fill(text);
    await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption(kind);
    await result(page, title);
  }
  await page.getByRole('button', { name: 'Reset search', exact: true }).click();
  await page.getByRole('searchbox').fill('archived specimen');
  await page.getByRole('combobox', { name: 'Archive', exact: true }).selectOption('only');
  await result(page, T.archived);
  await page.getByRole('button', { name: 'Reset search', exact: true }).click();
}
