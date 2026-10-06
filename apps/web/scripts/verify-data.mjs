/** recovery portable backup/import and ordinary account replication, synthetic content only. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  accountIdOf,
  buildWithAccount,
  cloudDocuments,
  deleteAccounts,
  stackEnvironment,
} from './lib/account-stack.mjs';
import {
  assert,
  assertNoOverflow,
  assertSingleH1,
  assertStaticCaches,
  assertTargets,
  poll,
  runJourney,
  tabTo,
  unlabelledFields,
  completeMinimalOnboarding,
} from './lib/journey.mjs';

await buildWithAccount();
const accounts = new Set();
const email = `recovery-data-${randomUUID().slice(0, 12)}@example.test`;
const password = `recovery-${randomBytes(18).toString('base64url')}`;
const PRIVATE = 'Synthetic protected boundary نور 日本語';
const TITLE = '=Private formula نور 日本語';
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function editBundle(text, edit) {
  const bundle = JSON.parse(text);
  edit(bundle.data);
  bundle.manifest.recordCounts = Object.fromEntries(
    Object.entries(bundle.data).map(([name, rows]) => [name, rows.length]),
  );
  bundle.manifest.dataSha256 = createHash('sha256').update(canonical(bundle.data)).digest('hex');
  return JSON.stringify(bundle);
}
const navigation = (page, path) =>
  page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
async function download(page, name) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const file = await event;
  const path = await file.path();
  assert(path !== null, 'Download must complete.');
  return { text: await readFile(path, 'utf8'), fileName: file.suggestedFilename() };
}
async function file(page, text) {
  await poll(
    () => page.getByLabel('YelAxis Planner JSON backup file').isEnabled(),
    'The prior import operation must finish before choosing a file.',
  );
  await page.getByLabel('YelAxis Planner JSON backup file').setInputFiles({
    name: 'synthetic-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
}
async function imported(page) {
  await page.getByText('Import completed.', { exact: false }).waitFor();
}
async function chooseAll(page, choice) {
  await page.getByRole('heading', { name: 'Import preview', exact: true }).waitFor();
  await poll(
    () => page.getByLabel('YelAxis Planner JSON backup file').isEnabled(),
    'Import preview must finish before choosing conflicts.',
  );
  for (let limit = 0; limit < 100; limit += 1) {
    const button = page
      .locator('.import-preview')
      .getByRole('button', { name: choice, exact: true })
      .first();
    if ((await button.count()) === 0) return;
    await button.click();
    await poll(
      async () =>
        (await page
          .locator('section[aria-labelledby="import-heading"]')
          .getAttribute('aria-busy')) !== 'true' &&
        !(await page.getByLabel('YelAxis Planner JSON backup file').isDisabled()),
      'Import decision must finish.',
    );
  }
  throw new Error('Import conflicts must be bounded and resolve.');
}
try {
  await runJourney(
    {
      name: 'recovery-data',
      title: 'recovery data',
      basePort: 9600,
      timeZone: 'Asia/Tashkent',
      timeoutMinutes: 15,
    },
    async (j) => {
      const errors = [],
        external = [];
      let context = await j.launch();
      let page = context.pages()[0];
      j.observe(page, external, errors);
      const openData = async () => {
        await navigation(page, '/data');
        await page.getByRole('heading', { name: 'Backup, export, and recovery' }).waitFor();
      };
      const sourceTitles = async () => {
        await page.getByRole('button', { name: 'Preview export', exact: true }).click();
        await page.getByRole('heading', { name: 'Export preview', exact: true }).waitFor();
        return download(page, 'Download verified JSON');
      };
      j.step('setup with sensitive Context and Unicode planning prose');
      await page.goto(j.origin);
      await page.getByRole('button', { name: 'Start locally' }).click();
      await page.getByRole('button', { name: 'Confirm defaults' }).click();
      await page.getByLabel('Protected boundary', { exact: true }).check();
      await page.getByLabel('Boundary', { exact: true }).fill(PRIVATE);
      await page.getByRole('button', { name: 'Save context' }).click();
      await page.getByRole('button', { name: 'Skip for now' }).click();
      await page.getByRole('button', { name: 'Skip for now' }).click();
      await page.getByLabel('First concrete Action').fill('Portable source Action');
      await page.getByRole('button', { name: 'Continue to handbook' }).click();
      await page.getByRole('button', { name: 'Skip and open Today' }).click();
      await page.getByRole('heading', { name: 'A useful day starts here.' }).waitFor();
      await page.keyboard.press('Alt+c');
      const capture = page.getByRole('dialog', { name: 'Add to Inbox' });
      await capture.getByLabel('Title').fill(TITLE);
      await capture.getByRole('button', { name: 'Capture', exact: true }).click();
      await capture.waitFor({ state: 'hidden' });
      await openData();
      j.step('full and reduced verified downloads');
      const full = (await sourceTitles()).text;
      const parsed = JSON.parse(full);
      assert(
        parsed.manifest.containsSensitiveContext === true && full.includes(PRIVATE),
        'Complete backup includes previewed sensitive Context.',
      );
      assert(
        createHash('sha256').update(canonical(parsed.data)).digest('hex') ===
          parsed.manifest.dataSha256,
        'Downloaded data digest must match.',
      );
      assert(
        Object.entries(parsed.data).every(
          ([name, rows]) => parsed.manifest.recordCounts[name] === rows.length,
        ),
        'Downloaded section counts must match.',
      );
      const { anonKey, serviceRoleKey } = stackEnvironment();
      for (const forbidden of [
        anonKey,
        serviceRoleKey,
        'owner_id',
        'access_token',
        'refresh_token',
        'replicaId',
        'notification_receipts',
        'sync_outbox',
      ])
        assert(
          !full.includes(forbidden),
          'Portable file contains forbidden authority or operational data.',
        );
      await page.getByLabel(/Include sensitive Context/u).uncheck();
      const reduced = (await download(page, 'Download verified JSON')).text;
      assert(
        !reduced.includes(PRIVATE) &&
          JSON.parse(reduced).manifest.containsSensitiveContext === false,
        'Reduced backup must omit sensitive text everywhere.',
      );
      const csv = await download(page, 'Download Actions CSV');
      assert(
        csv.fileName === 'actions.csv' &&
          csv.text.includes("'=Private formula") &&
          csv.text.includes('نور 日本語'),
        'Action CSV must retain Unicode and neutralize formulas.',
      );
      assert(
        (await download(page, 'Download Time Blocks CSV')).fileName === 'time-blocks.csv',
        'Block CSV filename.',
      );
      assert(
        (await download(page, 'Download Reviews Markdown')).text.startsWith(
          '# YelAxis Planner reviews',
        ),
        'Review Markdown format.',
      );
      j.checks.push(
        'consistent full/reduced private JSON downloads, independent SHA-256/count verification, no credentials/operational authority; UTF-8 CSV/Markdown',
      );
      j.step('invalid inputs preserve canonical data');
      for (const [text, message] of [
        [full.slice(0, 100), 'not a complete valid'],
        [full.replace('"formatVersion": 1', '"formatVersion": 2'), 'not supported'],
        [full.replace(TITLE, 'Tampered'), 'verification digest'],
      ]) {
        await file(page, text);
        await page.getByRole('alert').filter({ hasText: message }).waitFor();
        assert(
          (await page.getByRole('button', { name: 'Apply merge', exact: true }).count()) === 0,
          'Invalid file cannot be applied.',
        );
      }
      const badGraph = editBundle(full, (data) => {
        data.actions[0].document.projectId = randomUUID();
      });
      await file(page, badGraph);
      await chooseAll(page, 'Use imported');
      await page.getByText('A required relationship points to a missing record.').waitFor();
      assert(
        await page.getByRole('button', { name: 'Apply merge', exact: true }).isDisabled(),
        'Broken graph blocks apply.',
      );
      await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
      j.checks.push(
        'truncated/newer/corrupt/missing-reference imports refused before canonical writes',
      );
      j.step('saved journal restart, discard, and explicit collision choices');
      await file(page, full);
      await page.getByRole('heading', { name: 'Import preview', exact: true }).waitFor();
      await page.reload();
      await page.getByRole('button', { name: 'Resume import preview', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Discard unfinished preview', exact: true }).click();
      await page.getByText('Unfinished preview discarded.', { exact: false }).waitFor();
      const collision = editBundle(full, (data) => {
        const row = data.actions.find((row) => row.document.title === TITLE);
        row.document.title = 'Imported alternative';
      });
      await file(page, collision);
      await page.getByRole('button', { name: 'Keep current', exact: true }).click();
      await page.getByRole('button', { name: 'Apply merge', exact: true }).click();
      await imported(page);
      await file(page, collision);
      await page.getByRole('button', { name: 'Use imported', exact: true }).click();
      await page.getByRole('button', { name: 'Apply merge', exact: true }).click();
      await imported(page);
      await file(page, full);
      await page.getByRole('button', { name: 'Duplicate imported', exact: true }).click();
      await page.getByRole('button', { name: 'Apply merge', exact: true }).click();
      await imported(page);
      j.checks.push(
        'durable journal survives reload and discards safely; Keep current/Use imported/Duplicate imported require explicit preview decisions',
      );
      j.step('typed atomic replacement and retained backup restoration');
      const beforeReplace = (await sourceTitles()).text;
      await page.getByLabel('Restore/Replace', { exact: true }).check();
      await file(page, reduced);
      await chooseAll(page, 'Use imported');
      const replace = page.getByRole('button', {
        name: 'Replace plan after verified backup',
        exact: true,
      });
      assert(await replace.isDisabled(), 'Replace needs typed confirmation.');
      await page.getByLabel('Type REPLACE MY PLAN to confirm').fill('REPLACE MY PLAN');
      await replace.click();
      await imported(page);
      const retained = (await download(page, 'Download recovery backup')).text;
      assert(
        JSON.parse(retained).manifest.dataSha256 === JSON.parse(beforeReplace).manifest.dataSha256,
        'Retained backup is the exact pre-replace canonical snapshot.',
      );
      await page.getByRole('button', { name: 'Preview recovery restore', exact: true }).click();
      await chooseAll(page, 'Use imported');
      await page.getByLabel('Type REPLACE MY PLAN to confirm').fill('REPLACE MY PLAN');
      await replace.click();
      await imported(page);
      j.checks.push(
        'typed Restore/Replace is atomic, saves verified prior snapshot, and backup restores the earlier plan',
      );
      j.step('Template structure import, export, and normal application preview');
      const template = {
        format: 'yelaxis.template',
        formatVersion: 1,
        title: 'Portable template',
        blueprint: {
          version: 2,
          items: [
            {
              templateKey: 'portable',
              kind: 'action',
              title: 'Reusable structure',
              relativeDayOffset: 1,
            },
          ],
        },
      };
      await page.getByLabel('Template JSON file').setInputFiles({
        name: 'template.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(template)),
      });
      await page.getByRole('button', { name: 'Save imported Template' }).click();
      await page.getByText('Template saved.', { exact: false }).waitFor();
      await navigation(page, '/plan/templates');
      await page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: 'Portable template', exact: true }) })
        .getByRole('link', { name: 'Preview and apply Portable template', exact: true })
        .click();
      const templateFile = await download(page, 'Export Template structure');
      const structure = JSON.parse(templateFile.text);
      assert(
        structure.format === 'yelaxis.template' &&
          !templateFile.text.includes('owner') &&
          !templateFile.text.includes('history'),
        'Template carries structure only.',
      );
      await page.getByRole('list', { name: 'Template items' }).waitFor();
      await page
        .getByRole('list', { name: 'Template items' })
        .getByText('Reusable structure', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Apply 1 item', exact: true }).click();
      await page.getByText('Template applied.', { exact: true }).waitFor();
      j.checks.push(
        'separate versioned Template file saves structure only and uses normal Plan preview',
      );
      j.step('offline file flows, accessibility, static-only caches');
      await openData();
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await sourceTitles();
      await file(page, full);
      await chooseAll(page, 'Keep current');
      await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
      await assertSingleH1(page, 'Data');
      assert(
        (await unlabelledFields(page)).length === 0,
        'Every Data control has an accessible label.',
      );
      await tabTo(page, page.getByRole('button', { name: 'Preview export', exact: true }));
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Export preview', exact: true }).waitFor();
      for (const theme of ['light', 'dark'])
        for (const width of [1024, 1440, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.dataset.motion = 'reduced';
          }, theme);
          await assertNoOverflow(page, `Data ${theme} ${width}`);
        }
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
      await assertNoOverflow(page, 'Data 200% text');
      await page.evaluate(() => (document.documentElement.style.fontSize = ''));
      await assertTargets(page, 'Data');
      if (!j.inFirefox) await assertStaticCaches(page, j.origin);
      await j.shot(page, 'data-preview');
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      j.checks.push(
        'JSON/CSV/Markdown and import preview work offline; labelled keyboard/focus, themes, 1024/1440/320 widths, 200% text and static-only caches',
      );
      j.step('account-linked offline import and idempotent normal synchronization');
      await navigation(page, '/account');
      const create = page.getByRole('form', { name: 'Create account' });
      await create.getByLabel('Email').fill(email);
      await create.getByLabel('Password').fill(password);
      await create.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.getByRole('button', { name: 'Upload this plan', exact: true }).waitFor();
      const accountId = accountIdOf(email);
      assert(accountId !== null, 'Synthetic account exists.');
      accounts.add(accountId);
      await page.getByRole('button', { name: 'Upload this plan', exact: true }).click();
      await page.locator('.sync-status-line[data-state="synced"]').waitFor({ timeout: 60_000 });
      await openData();
      const accountBackup = (await sourceTitles()).text;
      const newId = randomUUID();
      const incoming = editBundle(accountBackup, (data) => {
        data.actions.push({
          id: newId,
          revision: 1,
          document: {
            title: 'Offline imported account Action',
            state: 'inbox',
            captureOrigin: 'import',
            orderKey: 'z',
          },
        });
        data.actions.sort((a, b) => a.id.localeCompare(b.id));
      });
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.getByLabel('Merge (default)', { exact: true }).check();
      await file(page, incoming);
      await page.getByText('This is an account plan.', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Apply merge', exact: true }).click();
      await imported(page);
      assert(
        !cloudDocuments(accountId, 'action').some((row) => row.id === newId),
        'Offline import is local first.',
      );
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await navigation(page, '/account');
      await page.getByRole('button', { name: 'Sync now', exact: true }).click();
      await page.locator('.sync-status-line[data-state="synced"]').waitFor({ timeout: 60_000 });
      await poll(
        () => cloudDocuments(accountId, 'action').some((row) => row.id === newId),
        'Accepted import must synchronize.',
      );
      await page.getByRole('button', { name: 'Sync now', exact: true }).click();
      await page.locator('.sync-status-line[data-state="synced"]').waitFor({ timeout: 60_000 });
      assert(
        cloudDocuments(accountId, 'action').filter((row) => row.id === newId).length === 1,
        'Retry remains idempotent.',
      );
      j.checks.push(
        'account-linked offline import rewrites owner/Profile, stays local first, then ordinary outbox synchronizes idempotently',
      );
      if (!j.inFirefox) {
        j.step('explicit synthetic site-data loss and portable restore');
        await page.goto('about:blank');
        const cdp = await context.newCDPSession(page);
        await cdp.send('Storage.clearDataForOrigin', { origin: j.origin, storageTypes: 'all' });
        await cdp.detach();
        await page.goto(j.origin);
        await completeMinimalOnboarding(page);
        await openData();
        await page.getByLabel('Restore/Replace', { exact: true }).check();
        await file(page, full);
        await chooseAll(page, 'Use imported');
        await page.getByLabel('Type REPLACE MY PLAN to confirm').fill('REPLACE MY PLAN');
        await page
          .getByRole('button', { name: 'Replace plan after verified backup', exact: true })
          .click();
        await imported(page);
        const restored = JSON.parse((await sourceTitles()).text);
        assert(
          restored.data.actions.some((row) => row.document.title === TITLE),
          'Portable backup restores source work after site-data loss.',
        );
        j.checks.push(
          'explicit Chromium site-data loss produces fresh setup; verified portable restore recovers stable source records',
        );
      }
      assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);
      const apiOrigin = new URL(stackEnvironment().apiUrl).origin;
      assert(
        external.every((url) => new URL(url).origin === apiOrigin),
        'Requests must stay within the app and approved local test API.',
      );
      await context.close();
      return {
        nativeDownloadsVerified: true,
        syntheticAccounts: accounts.size,
        limitations: [
          'Physical share-cancel/disk-full OS checks remain release; SQLite/browser fault injection covers transaction and storage failures.',
        ],
      };
    },
  );
} finally {
  await deleteAccounts(accounts);
}
