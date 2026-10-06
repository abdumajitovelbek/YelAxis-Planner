import { chromiumExecutableOptions } from './lib/browser.mjs';
/**
 * Account and sync journey on the local selected Supabase test stack. Two browser
 * profiles are two clients of one synthetic account: a local plan becomes an account plan through
 * the first upload, a second client signs in and receives it, and both edit online and offline in
 * both orders. The journey covers disjoint merges, same-field and delete-versus-edit conflicts,
 * restart with queued work, a server outage, an expired session, sign-out isolation and signing in
 * again, a foreign deep link, account export, and account deletion without resurrection. It checks
 * that sessions stay in `yelaxis.auth` only (never in SQLite snapshots, caches, URLs, or exports),
 * that the bundle carries no service-role key, that no request leaves for anywhere but the stack,
 * and the frame's accessibility basics. Keys are read in memory and never printed.
 *
 * `--firefox` runs the same journey in Playwright Firefox.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, firefox } from 'playwright-core';

import {
  accountIdOf,
  buildWithAccount,
  cloudDocuments,
  cloudRows,
  deleteAccounts,
  redact,
  stackEnvironment,
} from './lib/account-stack.mjs';
import {
  assert,
  assertNoOverflow,
  assertSingleH1,
  assertStaticCaches,
  assertTargets,
  completeMinimalOnboarding,
  forbiddenCopy,
  modelOrRankingCopy,
  poll,
  runJourney,
} from './lib/journey.mjs';

const timeZone = 'Asia/Tashkent';
const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const { apiUrl, anonKey, serviceRoleKey } = stackEnvironment();
await buildWithAccount();

const email = `sync-sync-${randomUUID().slice(0, 12)}@example.test`;
const password = `sync-${randomBytes(18).toString('base64url')}`;
const accounts = new Set();

try {
  await runJourney(
    { basePort: 7600, name: 'sync-sync', timeZone, timeoutMinutes: 25, title: 'account sync sync' },
    async (journey) => {
      const { origin, step, shot, checks } = journey;
      const browserErrors = [];
      const directories = [];

      /* ───────────────────────── Two clients ───────────────────────── */

      const launchOptions = {
        viewport: { width: 1280, height: 800 },
        timezoneId: timeZone,
        locale: 'en-US',
      };
      async function relaunch(client) {
        client.context = journey.inFirefox
          ? await firefox.launchPersistentContext(client.directory, {
              headless: true,
              ...launchOptions,
            })
          : await chromium.launchPersistentContext(client.directory, {
              ...chromiumExecutableOptions(),
              headless: true,
              args: ['--no-sandbox', '--disable-gpu'],
              ...launchOptions,
            });
        client.page = client.context.pages()[0] ?? (await client.context.newPage());
        journey.observe(client.page, client.external, browserErrors);
        return client;
      }
      async function openClient(label) {
        const directory = await mkdtemp(
          join(tmpdir(), `yelaxis-sync-sync-${journey.browserLabel}-${label}-`),
        );
        directories.push(directory);
        return relaunch({ label, directory, external: [] });
      }

      /** In-app navigation (works offline, keeps the running app). */
      async function navigate(client, path) {
        await client.page.evaluate((target) => {
          window.history.pushState({}, '', target);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, path);
      }
      async function setOffline(client, offline) {
        await client.context.setOffline(offline);
        await client.page.evaluate(
          (value) => window.dispatchEvent(new Event(value ? 'offline' : 'online')),
          offline,
        );
      }
      const statusLine = (client) => client.page.locator('.sync-status-line');
      async function waitForState(client, state, timeout = 45_000) {
        await client.page.locator(`.sync-status-line[data-state="${state}"]`).waitFor({ timeout });
      }
      /** "Sync now" on the Account page; resolves once the cycle ended and the state is Synced. */
      async function syncNow(client) {
        await navigate(client, '/account');
        const button = client.page.getByRole('button', { name: 'Sync now' });
        await button.waitFor();
        await button.click();
        // The button reads "Syncing…" while the cycle runs, then the result is announced.
        await client.page.getByRole('button', { name: 'Sync now' }).waitFor({ timeout: 45_000 });
        await client.page.locator('.account-state[data-state="synced"]').waitFor({
          timeout: 45_000,
        });
        await waitForState(client, 'synced');
      }
      async function capture(client, title) {
        await client.page.keyboard.press('Alt+c');
        const dialog = client.page.getByRole('dialog', { name: 'Add to Inbox' });
        await dialog.getByLabel('Title').fill(title);
        await dialog.getByRole('button', { name: 'Capture', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
      }
      async function inboxActionId(client, title) {
        await navigate(client, '/inbox');
        const link = client.page.getByRole('link', { name: title, exact: true });
        await link.waitFor({ timeout: 30_000 });
        const href = await link.getAttribute('href');
        const id = href?.match(/\/actions\/([0-9a-f-]{36})$/u)?.[1];
        assert(id !== undefined, `No Action id for ${title}.`);
        return id;
      }
      async function openAction(client, id) {
        await navigate(client, `/actions/${id}`);
        const title = client.page.locator('.action-detail form').getByLabel('Title');
        await title.waitFor({ timeout: 30_000 });
        return client.page.locator('.action-detail');
      }
      async function editAction(client, id, changes) {
        const detail = await openAction(client, id);
        if (changes.title !== undefined) {
          await detail.locator('form').getByLabel('Title').fill(changes.title);
        }
        if (changes.note !== undefined) await detail.getByLabel('Note').fill(changes.note);
        await client.page.getByRole('button', { name: 'Save changes' }).click();
        await client.page.getByText('Change saved.').waitFor();
      }
      async function readAction(client, id) {
        const detail = await openAction(client, id);
        return {
          title: await detail.locator('form').getByLabel('Title').inputValue(),
          note: await detail.getByLabel('Note').inputValue(),
        };
      }
      async function expectAction(client, id, expected, label) {
        await poll(
          async () => {
            const actual = await readAction(client, id);
            return Object.entries(expected).every(([key, value]) => actual[key] === value);
          },
          `${label}: ${client.label} must show ${JSON.stringify(expected)}.`,
          { timeout: 60_000, interval: 1_000 },
        );
      }
      async function resolveConflict(client, title, choice) {
        await navigate(client, '/account/conflicts');
        await client.page.getByRole('heading', { level: 1, name: 'Conflicts' }).waitFor();
        await assertSingleH1(client.page, 'Conflicts');
        // A conflict is titled from either side.
        const link = client.page.locator('main').getByRole('link', { name: title }).first();
        await link.waitFor({ timeout: 30_000 });
        await link.click();
        await client.page.getByRole('heading', { level: 1 }).waitFor();
        await assertSingleH1(client.page, 'Conflict');
        await assertNoOverflow(client.page, 'Conflict');
        await client.page.getByRole('button', { name: choice }).click();
        await client.page.getByRole('heading', { level: 1, name: 'Conflicts' }).waitFor();
      }
      async function accountPageChecks(client, label) {
        await assertSingleH1(client.page, label);
        await assertNoOverflow(client.page, label);
        await assertTargets(client.page, label);
        const text = await client.page.locator('main').innerText();
        const banned = [...forbiddenCopy(text), ...modelOrRankingCopy(text)];
        assert(banned.length === 0, `${label} uses forbidden copy: ${banned.join(', ')}`);
      }
      async function readSession(client) {
        return client.page.evaluate(() => {
          const raw = window.localStorage.getItem('yelaxis.auth');
          if (raw === null) return null;
          const session = JSON.parse(raw);
          return {
            accessToken: session.access_token ?? session.currentSession?.access_token ?? null,
            refreshToken: session.refresh_token ?? session.currentSession?.refresh_token ?? null,
            keys: Object.keys(window.localStorage),
          };
        });
      }
      /** Every SQLite snapshot of this browser, searched for each needle (verification contract). */
      async function snapshotsContain(client, needles) {
        return client.page.evaluate(async (values) => {
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('yelaxis-sqlite-snapshots-v1');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const stores = [...database.objectStoreNames];
          const found = [];
          let snapshots = 0;
          for (const name of stores) {
            const entries = await new Promise((resolve, reject) => {
              const request = database.transaction(name).objectStore(name).getAll();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            for (const entry of entries) {
              const bytes =
                entry instanceof Uint8Array
                  ? entry
                  : entry instanceof ArrayBuffer
                    ? new Uint8Array(entry)
                    : entry instanceof Blob
                      ? new Uint8Array(await entry.arrayBuffer())
                      : entry?.format === 'sqlite-gzip-v1' && entry.bytes instanceof ArrayBuffer
                        ? new Uint8Array(
                            await new Response(
                              new Blob([entry.bytes])
                                .stream()
                                .pipeThrough(new DecompressionStream('gzip')),
                            ).arrayBuffer(),
                          )
                        : entry?.bytes instanceof Uint8Array
                          ? entry.bytes
                          : null;
              if (bytes === null) continue;
              snapshots += 1;
              const text = new TextDecoder('latin1').decode(bytes);
              for (const value of values)
                if (text.includes(value)) found.push('matched-forbidden-needle');
            }
          }
          database.close();
          return { snapshots, found };
        }, needles);
      }
      async function download(client, buttonName) {
        const [file] = await Promise.all([
          client.page.waitForEvent('download'),
          client.page.getByRole('button', { name: buttonName }).click(),
        ]);
        const path = await file.path();
        assert(path !== null, `${buttonName} produced no file.`);
        return { name: file.suggestedFilename(), text: await readFile(path, 'utf8') };
      }

      const A = await openClient('A');
      const B = await openClient('B');
      const clients = [A, B];
      try {
        /* ───────────── A: a local plan that never contacts the server ───────────── */
        step('A starts locally and captures Actions');
        await A.page.goto(origin);
        await completeMinimalOnboarding(A.page);
        await capture(A, 'Sync alpha');
        await capture(A, 'Sync beta');
        await capture(A, 'Sync gamma');
        assert(
          A.external.length === 0,
          `A local plan made requests: ${A.external.slice(0, 3).join(', ')}`,
        );
        assert(
          (await statusLine(A).count()) === 0,
          'A local-only plan must show no sync state in the frame.',
        );
        checks.push('a local plan shows no sync state and makes no network request');

        /* ───────────── A: create the account and upload this plan ───────────── */
        step('A creates the account from Settings');
        await navigate(A, '/settings');
        await A.page.getByRole('heading', { name: 'Account and sync' }).waitFor();
        await A.page.getByRole('link', { name: 'Open Account' }).click();
        await A.page.getByRole('heading', { level: 1, name: 'Account' }).waitFor();
        await accountPageChecks(A, 'Account (signed out)');
        const create = A.page.getByRole('form', { name: 'Create account' });
        await create.getByLabel('Email').fill(email);
        await create.getByLabel('Password').fill(password);
        await create.getByRole('button', { name: 'Create account' }).click();
        await A.page.getByRole('button', { name: 'Upload this plan' }).waitFor({ timeout: 30_000 });
        const preview = await A.page.locator('main').innerText();
        assert(
          /Your account has no planning data yet\./u.test(preview),
          'The first-upload preview must say the account is empty.',
        );
        assert(
          (await A.page.getByRole('list', { name: 'Records on this device' }).count()) === 1,
          'The first-upload preview must count this device’s records.',
        );
        await shot(A.page, 'first-upload-preview');
        await accountPageChecks(A, 'First-upload preview');
        const accountId = accountIdOf(email);
        assert(accountId !== null, 'The account must exist on the stack.');
        accounts.add(accountId);
        assert(
          cloudRows(accountId).live === 0,
          'Nothing may be uploaded before the person chooses.',
        );
        checks.push('signing in with a local plan uploads nothing before the choice');

        step('A uploads this plan');
        await A.page.getByRole('button', { name: 'Upload this plan' }).click();
        await waitForState(A, 'synced', 60_000);
        const uploaded = cloudRows(accountId);
        assert(
          uploaded.byType.action === 4,
          `Expected 4 Actions in the cloud: ${JSON.stringify(uploaded)}`,
        );
        assert(uploaded.byType.profile === 1, 'The cloud must hold exactly one Profile.');
        assert(uploaded.replicas === 1, 'The cloud must know one replica.');
        checks.push(
          `first upload: ${String(uploaded.live)} records, one Profile, one replica (verification contract)`,
        );

        step('A keeps the session only in yelaxis.auth');
        const session = await readSession(A);
        assert(
          session !== null && session.accessToken !== null && session.refreshToken !== null,
          'The session must live in localStorage under yelaxis.auth.',
        );
        const tokens = [session.accessToken, session.refreshToken];
        assert(
          !A.page.url().includes(session.accessToken) && !/code=|access_token/u.test(A.page.url()),
          'No URL may carry a session.',
        );
        const otherKeys = await A.page.evaluate(
          (values) =>
            Object.keys(window.localStorage).filter(
              (key) =>
                key !== 'yelaxis.auth' &&
                values.some((value) => (window.localStorage.getItem(key) ?? '').includes(value)),
            ),
          tokens,
        );
        assert(otherKeys.length === 0, `Another storage key holds the session: ${otherKeys}`);
        const scanned = await snapshotsContain(A, tokens);
        assert(scanned.snapshots > 0, 'The SQLite snapshots must be readable for the scan.');
        assert(scanned.found.length === 0, 'A SQLite snapshot holds a session token.');
        await A.page.evaluate(() => navigator.serviceWorker?.ready);
        const cached = await assertStaticCaches(A.page, origin);
        checks.push(
          `session only in yelaxis.auth: not in ${String(scanned.snapshots)} SQLite snapshots, ${String(cached)} cached assets, other storage keys, or URLs (verification contract)`,
        );
        const bundle = await Promise.all(
          (await readdir(join(distDirectory, 'assets'))).map((file) =>
            readFile(join(distDirectory, 'assets', file), 'utf8').catch(() => ''),
          ),
        );
        assert(
          bundle.every((text) => !text.includes(serviceRoleKey)),
          'The browser bundle must not carry the service-role key.',
        );
        assert(
          bundle.some((text) => text.includes(anonKey)),
          'The account build must carry the public anon key.',
        );
        checks.push(
          'the bundle carries the public anon key and never the service-role key (verification contract)',
        );

        /* ───────────── B: sign in on a fresh browser and receive the plan ───────────── */
        step('B signs in from the welcome step');
        await B.page.goto(origin);
        await B.page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
        await B.page.getByRole('button', { name: 'Sign in' }).click();
        const signIn = B.page.getByRole('dialog');
        await signIn.getByLabel('Email').fill(email);
        await signIn.getByLabel('Password').fill(password);
        await signIn.getByRole('button', { name: 'Sign in' }).click();
        await waitForState(B, 'synced', 60_000);
        const alpha = await inboxActionId(B, 'Sync alpha');
        const beta = await inboxActionId(B, 'Sync beta');
        const gamma = await inboxActionId(B, 'Sync gamma');
        checks.push(
          'a second client signs in with an empty plan and receives the account (verification contract)',
        );

        /* ───────────── C: a failed sign-in, then an interrupted and canceled upload ───────────── */
        step('C: a failed sign-in leaves the local plan unchanged');
        const C = await openClient('C');
        clients.push(C);
        await C.page.goto(origin);
        await completeMinimalOnboarding(C.page);
        await capture(C, 'Only on C');
        await navigate(C, '/account');
        const cForm = C.page.getByRole('form', { name: 'Sign in' });
        await cForm.getByLabel('Email').fill(email);
        await cForm.getByLabel('Password').fill(`${password}-not-it`);
        await cForm.getByRole('button', { name: 'Sign in' }).click();
        await C.page.getByRole('alert').first().waitFor({ timeout: 30_000 });
        assert((await readSession(C)) === null, 'A failed sign-in must keep no session.');
        assert((await statusLine(C).count()) === 0, 'A failed sign-in must leave the plan local.');
        await inboxActionId(C, 'Only on C');
        checks.push(
          'a failed sign-in keeps no session and leaves the local plan unchanged (product contract)',
        );

        step('C: the first upload into an account with data waits offline and survives a restart');
        await navigate(C, '/account');
        await cForm.getByLabel('Email').fill(email);
        await cForm.getByLabel('Password').fill(password);
        await cForm.getByRole('button', { name: 'Sign in' }).click();
        await C.page.getByRole('button', { name: 'Upload this plan' }).waitFor({ timeout: 30_000 });
        assert(
          !(await C.page.locator('main').innerText()).includes(
            'Your account has no planning data yet.',
          ),
          'The preview must say the account already holds data.',
        );
        const cloudBeforeC = cloudRows(accountId).live;
        await setOffline(C, true);
        await C.page.getByRole('button', { name: 'Upload this plan' }).click();
        await waitForState(C, 'first_upload');
        if (!journey.inFirefox) {
          await C.page.evaluate(() => navigator.serviceWorker?.ready);
          await C.context.close();
          await relaunch(C);
          await C.context.setOffline(true);
          await C.page.goto(origin).catch(() => undefined);
          await waitForState(C, 'first_upload');
          checks.push(
            'an interrupted first upload is still queued after a restart (verification contract)',
          );
        }

        step('C: canceling the upload keeps every record local');
        await navigate(C, '/account');
        await C.page.getByRole('button', { name: 'Cancel upload' }).click();
        await poll(
          async () => (await statusLine(C).count()) === 0 && (await readSession(C)) === null,
          'Cancel must return to the local plan and sign out.',
        );
        await inboxActionId(C, 'Only on C');
        await setOffline(C, false);
        await C.page.waitForTimeout(2_000);
        assert(
          cloudRows(accountId).live === cloudBeforeC,
          'Nothing of a canceled upload may reach the account.',
        );
        await C.context.close();
        checks.push(
          'canceling a first upload keeps every record local and uploads nothing (verification contract)',
        );

        /* ───────────── Disjoint edits merge ───────────── */
        step('Disjoint edits on both clients merge');
        await editAction(A, alpha, { title: 'Sync alpha from A' });
        await editAction(B, beta, { note: 'Note from B' });
        await syncNow(A);
        await syncNow(B);
        await syncNow(A);
        await expectAction(B, alpha, { title: 'Sync alpha from A' }, 'disjoint edit');
        await expectAction(A, beta, { title: 'Sync beta', note: 'Note from B' }, 'disjoint edit');
        checks.push(
          'disjoint edits on two clients merge without a conflict (verification contract)',
        );

        /* ───────────── Offline on both, A then B, same field ───────────── */
        step('Both offline: A then B edit the same title');
        await setOffline(A, true);
        await setOffline(B, true);
        await editAction(A, beta, { title: 'Beta from A' });
        await editAction(B, beta, { title: 'Beta from B' });
        await waitForState(A, 'queued_offline');
        assert(
          /Offline: 1 change waiting/u.test(await statusLine(A).innerText()),
          'The frame must count the change waiting offline.',
        );
        await navigate(A, '/');
        await A.page.locator('.today-sync-notice[data-state="queued_offline"]').waitFor();
        await shot(A.page, 'today-offline-waiting');
        checks.push(
          'offline: the frame and the Today header count changes waiting (verification contract)',
        );

        if (!journey.inFirefox) {
          // The offline restart needs the service worker to serve the app shell (Chromium here; the
          // browser persistence PWA journey covers offline launch).
          step('B restarts offline with its change still queued');
          await B.page.evaluate(() => navigator.serviceWorker?.ready);
          await B.context.close();
          await relaunch(B);
          await B.context.setOffline(true);
          await B.page.goto(origin).catch(() => undefined);
          await B.page
            .locator('.sync-status-line[data-state="queued_offline"]')
            .waitFor({ timeout: 45_000 });
          checks.push('a restart keeps the queued change (verification contract)');
        }

        step('A reconnects first, then B gets a conflict');
        await setOffline(A, false);
        await syncNow(A);
        await setOffline(B, false);
        await waitForState(B, 'needs_attention', 60_000);
        await navigate(B, '/');
        await B.page.locator('.today-sync-notice[data-state="needs_attention"]').waitFor();
        await navigate(B, '/account');
        await B.page.getByRole('link', { name: 'Review conflicts' }).waitFor();
        await accountPageChecks(B, 'Account (needs attention)');
        await shot(B.page, 'account-needs-attention');
        await resolveConflict(B, /Beta from (?:A|B)/u, 'Keep this device’s version');
        await syncNow(B);
        await syncNow(A);
        await expectAction(A, beta, { title: 'Beta from B', note: 'Note from B' }, 'keep local');
        checks.push(
          'same-field edits offline, A then B: an explicit conflict, Keep this device’s version converges (verification contract, 012)',
        );

        /* ───────────── Offline on both, B then A ───────────── */
        step('Both offline: B then A edit the same title');
        await setOffline(A, true);
        await setOffline(B, true);
        await editAction(A, alpha, { title: 'Alpha from A again' });
        await editAction(B, alpha, { title: 'Alpha from B' });
        await setOffline(B, false);
        await syncNow(B);
        await setOffline(A, false);
        await waitForState(A, 'needs_attention', 60_000);
        await resolveConflict(A, /Alpha from (?:A again|B)/u, 'Keep the other version');
        await syncNow(A);
        await expectAction(A, alpha, { title: 'Alpha from B' }, 'keep remote');
        await syncNow(B);
        await expectAction(B, alpha, { title: 'Alpha from B' }, 'keep remote');
        checks.push(
          'the other order, B then A: Keep the other version converges (verification contract)',
        );

        /* ───────────── Delete versus edit ───────────── */
        step('A deletes an Action that B edits offline');
        await setOffline(B, true);
        await editAction(B, gamma, { note: 'Edited while deleted elsewhere' });
        const detail = await openAction(A, gamma);
        await A.page.getByRole('button', { name: 'Delete permanently…' }).click();
        const confirm = A.page.getByRole('dialog', { name: 'Permanently delete Action?' });
        await confirm.getByLabel('Action title').fill('Sync gamma');
        await confirm.getByRole('button', { name: 'Delete permanently' }).click();
        await A.page.getByRole('heading', { name: 'Decide what happens next.' }).waitFor();
        void detail;
        await syncNow(A);
        await poll(
          () => cloudDocuments(accountId, 'action').every(({ id }) => id !== gamma),
          'The deleted Action must leave the cloud.',
          { timeout: 30_000, interval: 1_000 },
        );
        await setOffline(B, false);
        await waitForState(B, 'needs_attention', 60_000);
        await resolveConflict(B, 'Sync gamma', 'Keep it deleted');
        await syncNow(B);
        await navigate(B, `/actions/${gamma}`);
        await B.page
          .getByRole('heading', { level: 1, name: 'This Action is unavailable.' })
          .waitFor();
        await syncNow(A);
        assert(
          cloudDocuments(accountId, 'action').every(({ id }) => id !== gamma) &&
            cloudRows(accountId).tombstones >= 1,
          'A tombstone must keep the Action deleted in the cloud.',
        );
        checks.push(
          'delete versus edit: an explicit conflict, Keep it deleted, and the tombstone prevents resurrection (verification contract, 010)',
        );

        /* ───────────── Server outage ───────────── */
        step('A works through a server outage');
        const outage = (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"code":"PGRST001","message":"unavailable"}',
          });
        await A.context.route(`${apiUrl}/rest/v1/rpc/**`, outage);
        await capture(A, 'Captured during outage');
        await navigate(A, '/account');
        await A.page.getByRole('button', { name: 'Sync now' }).click();
        await waitForState(A, 'server_unavailable', 60_000);
        await A.page.getByText('Next try').waitFor();
        await navigate(A, '/');
        await A.page.locator('.today-sync-notice[data-state="server_unavailable"]').waitFor();
        await shot(A.page, 'today-server-unavailable');
        await A.context.unroute(`${apiUrl}/rest/v1/rpc/**`, outage);
        await syncNow(A);
        await syncNow(B);
        await inboxActionId(B, 'Captured during outage');
        checks.push(
          'an outage shows Server unavailable with the next try; work continues and syncs later (verification contract)',
        );

        /* ───────────── Expired session ───────────── */
        step('B continues through an expired session and signs in again');
        const expired = (route) =>
          route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: '{"code":"PGRST303","message":"JWT expired"}',
          });
        await B.context.route(`${apiUrl}/rest/v1/rpc/**`, expired);
        await capture(B, 'Captured while expired');
        await navigate(B, '/account');
        await B.page.getByRole('button', { name: 'Sync now' }).click();
        await waitForState(B, 'auth_expired', 60_000);
        await B.page.getByRole('form', { name: 'Sign in again' }).waitFor();
        await accountPageChecks(B, 'Account (sign in again)');
        await B.context.unroute(`${apiUrl}/rest/v1/rpc/**`, expired);
        const again = B.page.getByRole('form', { name: 'Sign in again' });
        await again.getByLabel('Password').fill(password);
        await again.getByRole('button', { name: 'Sign in again' }).click();
        await waitForState(B, 'synced', 60_000);
        await syncNow(A);
        await inboxActionId(A, 'Captured while expired');
        checks.push(
          'an expired session pauses sync, keeps local work, and resumes after signing in again (product contract)',
        );

        /* ───────────── Sign-out isolation and signing in again ───────────── */
        step('B signs out, sees only its local plan, and signs in again');
        await navigate(B, '/account');
        await B.page.getByRole('button', { name: 'Sign out' }).click();
        const signOut = B.page.getByRole('dialog');
        await signOut.getByText('Nothing waits to sync.').waitFor();
        await signOut.getByRole('button', { name: 'Sign out' }).click();
        await poll(async () => (await readSession(B)) === null, 'Sign-out must clear the session.');
        // B signed in from the welcome step, so its local plan still starts there; setup ends on
        // Today when it starts from Today.
        await navigate(B, '/');
        await completeMinimalOnboarding(B.page);
        assert((await statusLine(B).count()) === 0, 'A signed-out plan shows no sync state.');
        await navigate(B, `/actions/${alpha}`);
        await B.page
          .getByRole('heading', { level: 1, name: 'This Action is unavailable.' })
          .waitFor();
        assert(
          !(await B.page.locator('body').innerText()).includes('Alpha from B'),
          'An account record must not open in the local plan.',
        );
        checks.push(
          'signed out: the account plan is locked away and its deep links fail closed (verification contract)',
        );
        await B.page.goto(`${origin}/account`);
        const signInAgain = B.page.getByRole('form', { name: 'Sign in' });
        await signInAgain.getByLabel('Email').fill(email);
        await signInAgain.getByLabel('Password').fill(password);
        await signInAgain.getByRole('button', { name: 'Sign in' }).click();
        await waitForState(B, 'synced', 60_000);
        await expectAction(B, alpha, { title: 'Alpha from B' }, 'reopened replica');
        checks.push('signing in again reopens the same replica');

        /* ───────────── Export ───────────── */
        step('A exports the account');
        await navigate(A, '/account');
        const exported = await download(A, 'Export account data');
        assert(
          /^yelaxis-export-\d{4}-\d{2}-\d{2}\.json$/u.test(exported.name),
          'Export file name.',
        );
        const exportedSession = (await readSession(A)) ?? { accessToken: '', refreshToken: '' };
        for (const secret of [exportedSession.accessToken, exportedSession.refreshToken, anonKey]) {
          assert(
            secret === '' || !exported.text.includes(secret),
            'The export holds a credential.',
          );
        }
        const parsed = JSON.parse(exported.text);
        const exportedText = JSON.stringify(parsed);
        for (const title of ['Alpha from B', 'Beta from B', 'Captured during outage']) {
          assert(exportedText.includes(title), `The export must include ${title}.`);
        }
        assert(
          !exportedText.includes('Sync gamma'),
          'The export must not resurrect a deleted Action.',
        );
        checks.push(
          'the account export is complete, holds no credential, and keeps deleted items deleted (product contract)',
        );

        /* ───────────── Account deletion ───────────── */
        step('A: a failed deletion waits as pending with pushes frozen');
        const deletionOutage = (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"code":"PGRST001","message":"unavailable"}',
          });
        await A.context.route(`${apiUrl}/rest/v1/rpc/account_delete`, deletionOutage);
        await A.page.getByRole('button', { name: 'Delete account' }).click();
        const deletion = A.page.getByRole('form', { name: 'Delete account' });
        await deletion.getByRole('list', { name: 'Records in the cloud' }).waitFor();
        await accountPageChecks(A, 'Account (deletion preview)');
        await shot(A.page, 'deletion-preview');
        await deletion.getByLabel('Password').fill(password);
        await deletion.getByLabel('Type your account email to confirm').fill(email);
        await deletion.getByRole('button', { name: 'Delete account' }).click();
        await waitForState(A, 'deletion_pending', 60_000);
        const pendingForm = A.page.getByRole('form', { name: 'Account deletion is pending' });
        await pendingForm.waitFor();
        await accountPageChecks(A, 'Account (deletion pending)');
        await shot(A.page, 'deletion-pending');
        const liveWhilePending = cloudRows(accountId).live;
        await capture(A, 'Captured while deletion is pending');
        await A.page.waitForTimeout(4_000);
        assert(
          cloudRows(accountId).live === liveWhilePending,
          'A pending deletion must freeze pushes.',
        );
        checks.push(
          'a failed deletion stays pending with retry and cancel, and freezes pushes (verification contract)',
        );

        step('A retries the deletion with the password');
        await A.context.unroute(`${apiUrl}/rest/v1/rpc/account_delete`, deletionOutage);
        await pendingForm.getByLabel('Password').fill(password);
        await pendingForm.getByRole('button', { name: 'Retry deletion' }).click();
        await poll(
          async () => (await readSession(A)) === null,
          'Deletion must clear the session.',
          {
            timeout: 60_000,
          },
        );
        // The local copy was deleted with the account: a fresh local plan starts at the welcome
        // step, and the outcome is still announced after the switch.
        await A.page
          .getByText('Your account was deleted, and this device’s copy with it.')
          .waitFor({ timeout: 30_000 });
        await A.page.getByRole('heading', { name: 'Connect direction to action.' }).waitFor();
        await poll(() => accountIdOf(email) === null, 'The auth account must be deleted.');
        const remaining = cloudRows(accountId);
        assert(
          remaining.live + remaining.tombstones + remaining.changes + remaining.replicas === 0,
          `Cloud rows remain after deletion: ${JSON.stringify(remaining)}`,
        );
        accounts.delete(accountId);
        checks.push(
          'account deletion removes every cloud row and the sign-in account (verification contract, verification contract)',
        );

        step('B learns the account was deleted elsewhere and keeps its copy as a local plan');
        await capture(B, 'Captured after deletion');
        await navigate(B, '/account');
        await B.page.getByRole('button', { name: 'Sync now' }).click();
        await waitForState(B, 'deletion_pending', 60_000);
        const afterDeletion = cloudRows(accountId);
        assert(
          afterDeletion.live === 0 && afterDeletion.users === 0,
          `A deleted account came back: ${JSON.stringify(afterDeletion)}`,
        );
        checks.push(
          'a second client of a deleted account sends nothing that recreates it (verification contract)',
        );
        // No password: the server already reports the deletion, so this device finishes it with
        // the default choice and keeps its copy as a local plan.
        const bPending = B.page.getByRole('form', { name: 'Account deletion is pending' });
        await bPending.getByRole('button', { name: 'Retry deletion' }).click();
        await poll(
          async () => (await readSession(B)) === null,
          'Finishing must clear the session.',
          {
            timeout: 60_000,
          },
        );
        await B.page
          .getByText('Your account was deleted. This device’s copy is now a local plan.')
          .waitFor({ timeout: 30_000 });
        await inboxActionId(B, 'Captured after deletion');
        assert((await statusLine(B).count()) === 0, 'The kept copy must be a local plan.');
        checks.push(
          'a client of an account deleted elsewhere keeps its copy, with its unsynced work, as a local plan ',
        );

        /* ───────────── Requests and errors ───────────── */
        const allowed = (url) =>
          url.startsWith(`${apiUrl}/auth/v1/`) || url.startsWith(`${apiUrl}/rest/v1/rpc/`);
        const foreignRequests = clients
          .flatMap((client) => client.external)
          .filter((url) => !allowed(url));
        assert(
          foreignRequests.length === 0,
          `Requests left for elsewhere: ${foreignRequests.slice(0, 5).join(', ')}`,
        );
        checks.push(
          'every request goes to the app origin or the local stack’s auth and sync functions',
        );
        // Requests that fail while a client is offline or the server is down are expected; Firefox
        // reports a failed cross-origin request as "CORS request did not succeed".
        const unexpected = browserErrors.filter(
          (error) =>
            !/Failed to load resource|ERR_INTERNET_DISCONNECTED|NetworkError|status of (401|503)|CORS request did not succeed/u.test(
              error,
            ),
        );
        assert(unexpected.length === 0, `Browser errors:\n${unexpected.join('\n')}`);
        return {
          backend: `${apiUrl} (local yelaxis stack)`,
          externalRequests: clients.reduce((sum, client) => sum + client.external.length, 0),
        };
      } catch (error) {
        for (const client of clients) {
          const path = `/tmp/yelaxis-sync-sync-${journey.inFirefox ? 'firefox-' : ''}${client.label}-failure.png`;
          await client.page?.screenshot({ path, fullPage: true }).catch(() => undefined);
          process.stderr.write(`${client.label} at ${client.page?.url() ?? '?'}: ${path}\n`);
        }
        throw error;
      } finally {
        for (const client of clients) await client.context?.close().catch(() => undefined);
        await Promise.all(
          directories.map((directory) => rm(directory, { recursive: true, force: true })),
        );
      }
    },
  );
} catch (error) {
  process.stderr.write(
    `${redact(error instanceof Error ? (error.stack ?? error.message) : error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await deleteAccounts([...accounts]);
}
