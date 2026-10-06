import type { EntityType } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import type { AccountResult } from '../account/account-service';
import { FakeIdentityHost, MemoryStorage, sampleSeed } from './__fixtures__/fake-identity-host';
import { FakeSupabase } from './__fixtures__/fake-supabase';
import { accountMessages } from './account-messages';
import {
  accountDatabaseName,
  defaultLocalDatabaseName,
  identityIndexKey,
  readIdentityIndex,
} from './identity-index';
import { IdentityStores } from './identity-stores';
import { createSupabaseAccountBackend, sessionStorageKey } from './supabase-backend';
import { createWebAccountService } from './web-account-service';

const email = 'person@example.test';
const password = 'synthetic-password';

interface SetupOptions {
  readonly local?: Partial<Record<EntityType, number>>;
  readonly sensitive?: number;
  readonly configured?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const host = new FakeIdentityHost();
  const storage = new MemoryStorage();
  const fake = new FakeSupabase(storage);
  const subject = fake.addUser(email, password);
  const local = host.localPlan(
    defaultLocalDatabaseName,
    options.local ?? { profile: 1 },
    options.sensitive ?? 0,
  );
  let token = 0;
  const stores = new IdentityStores(host, storage, () => {
    token += 1;
    return `e0000000-0000-4000-8000-${token.toString(16).padStart(12, '0')}`;
  });
  const backend =
    options.configured === false
      ? null
      : createSupabaseAccountBackend(fake.loader(), {
          storage,
          online: () => fake.network !== 'offline',
        });
  const service = createWebAccountService({ backend, stores });
  const events: string[] = [];
  stores.subscribe((event) =>
    events.push(event.type === 'ready' ? `ready ${event.store.opened.databaseName}` : 'switching'),
  );
  await stores.open();
  await service.start();
  return { host, storage, fake, subject, local, stores, service, events };
}

/** A failure with its calm copy, never an email address or a password. */
function expectFailure(result: AccountResult<unknown>, code: keyof typeof accountMessages): void {
  expect(result).toEqual({ ok: false, code, message: accountMessages[code] });
  if (!result.ok) {
    expect(result.message).not.toContain(email);
    expect(result.message).not.toContain(password);
  }
}

const meaningful = { profile: 1, axis: 2, action: 5, context: 2 } as const;

describe('account service: configuration and input', () => {
  it('names the local test service only when the build reports it', async () => {
    const { service, stores } = await setup();
    expect(service.localTestService).toBe(false);
    expect(
      createWebAccountService({
        backend: createSupabaseAccountBackend(new FakeSupabase(new MemoryStorage()).loader(), {
          storage: null,
        }),
        stores,
        localTestService: true,
      }).localTestService,
    ).toBe(true);
    // Without a backend there is no service at all.
    expect(
      createWebAccountService({ backend: null, stores, localTestService: true }),
    ).toMatchObject({ configured: false, localTestService: false });
  });

  it('offers nothing in a local-only build', async () => {
    const { service, stores } = await setup({ configured: false });
    expect(service.configured).toBe(false);
    expect(service.currentAccount()).toBeNull();
    expectFailure(await service.signIn(email, password), 'not_configured');
    expectFailure(await service.signUp(email, password), 'not_configured');
    expectFailure(
      await service.deleteAccount({ password, keepLocalCopy: false }),
      'not_configured',
    );
    expect(stores.current()?.opened.databaseName).toBe(defaultLocalDatabaseName);
  });

  it('refuses empty input and failed sign-in, leaving the local plan unchanged', async () => {
    const { service, stores, fake, storage } = await setup();
    const before = stores.current();
    expectFailure(await service.signIn('  ', password), 'invalid_input');
    expectFailure(await service.signIn(email, ''), 'invalid_input');
    expectFailure(await service.signIn(email, 'wrong-password'), 'invalid_credentials');
    expectFailure(await service.signUp(email, password), 'user_exists');
    expectFailure(await service.signUp('new@example.test', '123'), 'weak_password');
    fake.confirmEmail = true;
    expectFailure(await service.signUp('confirm@example.test', password), 'confirmation_required');
    fake.network = 'offline';
    expectFailure(await service.signIn(email, password), 'offline');
    fake.network = 'down';
    expectFailure(await service.signIn(email, password), 'unavailable');
    expect(stores.current()).toBe(before);
    expect(service.currentAccount()).toBeNull();
    expect(storage.getItem(sessionStorageKey)).toBeNull();
  });
});

describe('account service: signing in', () => {
  it('opens a new replica seeded from an empty local plan when the account is empty', async () => {
    const { service, stores, host, subject, fake, events, storage } = await setup();
    await expect(service.signIn(email, password)).resolves.toEqual({
      ok: true,
      value: { kind: 'opened_account' },
    });
    const replica = accountDatabaseName(subject);
    expect(stores.current()?.opened.databaseName).toBe(replica);
    expect(host.database(replica).seededFrom).toEqual(sampleSeed);
    expect(events).toEqual(['switching', `ready ${replica}`]);
    expect(service.currentAccount()).toEqual({ email });
    expect(fake.signedIn).toBe(subject);
    // The local plan stays, for signing out later.
    const index = readIdentityIndex(storage);
    expect(index?.identities.map(({ kind, databaseName }) => `${kind} ${databaseName}`)).toEqual([
      `local ${defaultLocalDatabaseName}`,
      `account ${replica}`,
    ]);
    // The index never holds a credential.
    expect(storage.getItem(identityIndexKey)).not.toContain('access');
    expect(storage.getItem(identityIndexKey)).not.toContain(password);
  });

  it('opens an empty replica for an account that already has records, for the first pull', async () => {
    const { service, host, subject, fake } = await setup();
    fake.status = { recordCounts: { action: 4, profile: 1 }, recordCount: 5, deletion: 'none' };
    await expect(service.signUp('second@example.test', password)).resolves.toMatchObject({
      ok: true,
    });
    const created = [...fake.users.values()].find((user) => user.email === 'second@example.test');
    expect(host.database(accountDatabaseName(created!.id)).seededFrom).toBeNull();
    expect(host.databases.has(accountDatabaseName(subject))).toBe(false);
  });

  it('offers the first upload with counts by kind, cloud records, and sensitive Context', async () => {
    const { service, stores, fake } = await setup({ local: meaningful, sensitive: 2 });
    fake.status = { recordCounts: { action: 1 }, recordCount: 1, deletion: 'none' };
    const outcome = await service.signIn(email, password);
    expect(outcome).toEqual({
      ok: true,
      value: {
        kind: 'choose_first_upload',
        preview: {
          accountEmail: email,
          local: {
            kinds: [
              { label: 'Axes', count: 2 },
              { label: 'Actions', count: 5 },
              { label: 'Context entries', count: 2 },
              { label: 'Planning profile', count: 1 },
            ],
            total: 10,
          },
          cloudRecordCount: 1,
          sensitiveContextCount: 2,
        },
      },
    });
    // Nothing is bound yet.
    expect(stores.current()?.identity.kind).toBe('local');
    expect(service.currentAccount()).toEqual({ email });
  });

  it('makes and verifies the backup, then links this device’s plan', async () => {
    const { service, stores, host, subject, events, storage } = await setup({ local: meaningful });
    await service.signIn(email, password);
    await expect(service.startFirstUpload()).resolves.toEqual({ ok: true, value: undefined });
    const store = stores.current();
    expect(store?.opened.databaseName).toBe(defaultLocalDatabaseName);
    expect(store?.identity).toMatchObject({ kind: 'account', accountSubjectId: subject });
    expect(store?.entry).toMatchObject({ kind: 'account', email });
    expect(events).toEqual(['switching', `ready ${defaultLocalDatabaseName}`]);
    expect(host.database(defaultLocalDatabaseName).backup).not.toBeNull();
    expect(readIdentityIndex(storage)?.identities).toEqual([store?.entry]);
    const backup = await service.latestBackup();
    expect(backup).toMatchObject({ fileName: 'yelaxis-backup-2026-10-01.json', recordCount: 10 });
    expect(backup?.blob.type).toBe('application/json');
    expectFailure(await service.startFirstUpload(), 'no_pending_choice');
    // Linkage completes once the sync part's initial upload and pull checkpoint are in place.
    await expect(service.completeLinkIfReady()).resolves.toBe(false);
    host.database(defaultLocalDatabaseName).linkReady = true;
    await expect(service.completeLinkIfReady()).resolves.toBe(true);
    expect(stores.current()?.identity.linkedAt).not.toBeNull();
    await expect(service.latestBackup()).resolves.toBeNull();
  });

  it('uploads nothing when the backup or the link fails, and keeps the choice', async () => {
    const { service, stores, host } = await setup({ local: meaningful });
    await service.signIn(email, password);
    const database = host.database(defaultLocalDatabaseName);
    database.failures.add('backup');
    expectFailure(await service.startFirstUpload(), 'backup_failed');
    database.failures.delete('backup');
    database.failures.add('link');
    expectFailure(await service.startFirstUpload(), 'link_failed');
    expect(stores.current()?.identity.kind).toBe('local');
    // No link needs the backup made for it: it is not kept.
    expect(database.backup).toBeNull();
    await expect(service.latestBackup()).resolves.toBeNull();
    database.failures.delete('link');
    await expect(service.startFirstUpload()).resolves.toMatchObject({ ok: true });
    expect(database.backup).not.toBeNull();
  });

  it('cancels a first upload before it starts and after, keeping every local record', async () => {
    const before = await setup({ local: meaningful });
    await before.service.signIn(email, password);
    await expect(before.service.cancelFirstUpload()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(before.fake.signedIn).toBeNull();
    expect(before.service.currentAccount()).toBeNull();
    expectFailure(await before.service.cancelFirstUpload(), 'nothing_to_cancel');

    const after = await setup({ local: meaningful });
    const localId = after.local.identity?.id;
    await after.service.signIn(email, password);
    await after.service.startFirstUpload();
    after.host.database(defaultLocalDatabaseName).failures.add('cancel');
    expectFailure(await after.service.cancelFirstUpload(), 'cancel_failed');
    after.host.database(defaultLocalDatabaseName).failures.delete('cancel');
    await expect(after.service.cancelFirstUpload()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(after.stores.current()?.identity).toMatchObject({ id: localId, kind: 'local' });
    expect(after.stores.current()?.entry).toEqual({
      id: localId,
      kind: 'local',
      databaseName: defaultLocalDatabaseName,
    });
    expect(after.host.database(defaultLocalDatabaseName).counts).toEqual(meaningful);
    expect(after.fake.signedIn).toBeNull();
    // The backup went with the canceled link.
    await expect(after.service.latestBackup()).resolves.toBeNull();
  });

  it('declines the upload by opening the account’s own copy and keeping the local plan', async () => {
    const { service, stores, host, subject } = await setup({ local: meaningful });
    expectFailure(await service.declineFirstUpload(), 'no_pending_choice');
    await service.signIn(email, password);
    await expect(service.declineFirstUpload()).resolves.toEqual({ ok: true, value: undefined });
    expect(stores.current()?.opened.databaseName).toBe(accountDatabaseName(subject));
    // The account was empty, so its replica starts from this device's setup choices.
    expect(host.database(accountDatabaseName(subject)).seededFrom).toEqual(sampleSeed);
    expect(host.database(defaultLocalDatabaseName).counts).toEqual(meaningful);
  });

  it('refuses an account being deleted or out of reach, and clears the session', async () => {
    const { service, fake, stores } = await setup();
    fake.status = { recordCounts: {}, recordCount: 0, deletion: 'pending' };
    expectFailure(await service.signIn(email, password), 'account_being_deleted');
    expect(fake.signedIn).toBeNull();
    fake.status = { recordCounts: {}, recordCount: 0, deletion: 'none' };
    fake.statusAnswer = 'server_error';
    expectFailure(await service.signIn(email, password), 'unavailable');
    expect(fake.signedIn).toBeNull();
    expect(stores.current()?.identity.kind).toBe('local');
  });

  it('reopens this account’s replica on a later sign-in, even with local planning data', async () => {
    const { service, stores, subject, host } = await setup();
    await service.signIn(email, password);
    await service.signOut();
    // New local work after signing out does not hide the account's own copy.
    host.database(stores.current()!.opened.databaseName).counts = meaningful;
    await expect(service.signIn(email, password)).resolves.toEqual({
      ok: true,
      value: { kind: 'opened_account' },
    });
    expect(stores.current()?.opened.databaseName).toBe(accountDatabaseName(subject));
  });

  it('treats signing in to the open account as signing in again, and refuses another', async () => {
    const { service, fake } = await setup();
    await service.signIn(email, password);
    await expect(service.signIn(email.toUpperCase(), password)).resolves.toEqual({
      ok: true,
      value: { kind: 'opened_account' },
    });
    fake.addUser('other@example.test', password);
    expectFailure(await service.signIn('other@example.test', password), 'account_active');
    expectFailure(await service.signUp('third@example.test', password), 'account_active');
  });

  it('fails closed when the replica is open in another tab', async () => {
    const { service, host, subject, fake, stores } = await setup();
    host.busy.add(accountDatabaseName(subject));
    expectFailure(await service.signIn(email, password), 'database_busy');
    expect(fake.signedIn).toBeNull();
    expect(stores.current()?.opened.databaseName).toBe(defaultLocalDatabaseName);
  });
});

describe('account service: signing out and removing', () => {
  it('signs out to the existing local plan, keeping the replica for later', async () => {
    const { service, stores, subject, fake, host } = await setup();
    await service.signIn(email, password);
    host.database(accountDatabaseName(subject)).pendingOperations = 3;
    host.database(accountDatabaseName(subject)).openConflicts = 1;
    host.database(accountDatabaseName(subject)).lastSyncedAt = '2026-10-01T08:00:00.000Z' as never;
    await expect(service.signOutFacts()).resolves.toEqual({
      pendingChanges: 3,
      openConflicts: 1,
      lastSyncedAt: '2026-10-01T08:00:00.000Z',
    });
    await expect(service.signOut()).resolves.toEqual({ ok: true, value: undefined });
    expect(stores.current()?.opened.databaseName).toBe(defaultLocalDatabaseName);
    expect(fake.signedIn).toBeNull();
    expect(host.databases.has(accountDatabaseName(subject))).toBe(true);
    expect(stores.findAccount(subject)).not.toBeNull();
    await expect(service.signOutFacts()).resolves.toEqual({ pendingChanges: 0, openConflicts: 0 });
  });

  it('says the facts are unknown when they cannot be read, never that nothing waits', async () => {
    const { service, subject, host } = await setup();
    await service.signIn(email, password);
    host.database(accountDatabaseName(subject)).failures.add('facts');
    await expect(service.signOutFacts()).resolves.toBeNull();
    // Removing the copy then refuses instead of guessing.
    expectFailure(
      await service.removeFromDevice({ deleteLocalCopy: true, acceptUnsyncedLoss: false }),
      'storage',
    );
    expect(host.databases.has(accountDatabaseName(subject))).toBe(true);
  });

  it('opens a new local plan after signing out of a linked plan', async () => {
    const { service, stores } = await setup({ local: meaningful });
    await service.signIn(email, password);
    await service.startFirstUpload();
    await service.signOut();
    const store = stores.current();
    expect(store?.opened.databaseName).toBe(
      '/yelaxis-local-e0000000000040008000000000000001.sqlite3',
    );
    expect(store?.identity.kind).toBe('local');
  });

  it('signs out to the local plan used most recently, never an empty one beside it', async () => {
    const plan = { profile: 1, action: 5 } as const;
    const { service, stores, host, fake } = await setup({ local: plan });
    // Link the original plan, then sign out: a new, empty local plan opens beside the account.
    await service.signIn(email, password);
    await service.startFirstUpload();
    await service.signOut();
    expect(stores.current()?.opened.databaseName).not.toBe(defaultLocalDatabaseName);
    // Sign in again and cancel the upload: the original plan is a local plan again.
    await service.signIn(email, password);
    expect(stores.current()?.opened.databaseName).toBe(defaultLocalDatabaseName);
    await expect(service.cancelFirstUpload()).resolves.toMatchObject({ ok: true });
    expect(stores.current()?.identity.kind).toBe('local');
    // Sign in to another account and keep this plan on this device: that account's copy opens.
    fake.addUser('other@example.test', password);
    await expect(service.signIn('other@example.test', password)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'choose_first_upload' },
    });
    await expect(service.declineFirstUpload()).resolves.toMatchObject({ ok: true });
    // Signing out returns to the plan with five Actions, not the empty one.
    await expect(service.signOut()).resolves.toMatchObject({ ok: true });
    expect(stores.current()?.opened.databaseName).toBe(defaultLocalDatabaseName);
    expect(host.database(defaultLocalDatabaseName).counts).toEqual(plan);
  });

  it('removes this device’s copy at the next launch when removing it could not finish', async () => {
    const { service, stores, subject, host, storage, fake } = await setup();
    await service.signIn(email, password);
    const replica = accountDatabaseName(subject);
    const remove = host.remove.bind(host);
    host.remove = (name) => (name === replica ? Promise.reject(new Error('busy')) : remove(name));
    expectFailure(
      await service.removeFromDevice({ deleteLocalCopy: true, acceptUnsyncedLoss: true }),
      'remove_failed',
    );
    expect(fake.signedIn).toBeNull();
    expect(stores.current()?.opened.databaseName).toBe(defaultLocalDatabaseName);
    // The copy the person chose to delete is never opened again.
    expect(stores.findAccount(subject)).toBeNull();
    expect(readIdentityIndex(storage)?.identities).toContainEqual(
      expect.objectContaining({ databaseName: replica, removalPending: true }),
    );

    // The next launch removes it.
    await stores.close();
    const restartedStores = new IdentityStores(host, storage, () => 'unused');
    const restarted = createWebAccountService({
      backend: createSupabaseAccountBackend(fake.loader(), { storage }),
      stores: restartedStores,
    });
    await restartedStores.open();
    await restarted.start();
    expect(host.databases.has(replica)).toBe(true);
    host.remove = remove;
    await restartedStores.close();
    const again = new IdentityStores(host, storage, () => 'unused');
    await again.open();
    await createWebAccountService({
      backend: createSupabaseAccountBackend(fake.loader(), { storage }),
      stores: again,
    }).start();
    expect(host.databases.has(replica)).toBe(false);
    expect(readIdentityIndex(storage)?.identities.map(({ kind }) => kind)).toEqual(['local']);
  });

  it('signing in again after a failed removal starts a new copy, not the deleted one', async () => {
    const { service, stores, subject, host } = await setup();
    await service.signIn(email, password);
    const replica = accountDatabaseName(subject);
    host.database(replica).pendingOperations = 4;
    const remove = host.remove.bind(host);
    host.remove = (name) => (name === replica ? Promise.reject(new Error('busy')) : remove(name));
    expectFailure(
      await service.removeFromDevice({ deleteLocalCopy: true, acceptUnsyncedLoss: true }),
      'remove_failed',
    );
    host.remove = remove;
    await expect(service.signIn(email, password)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'opened_account' },
    });
    expect(stores.current()?.opened.databaseName).toBe(replica);
    expect(host.database(replica).pendingOperations).not.toBe(4);
  });

  it('keeps the account open when the local plan cannot open', async () => {
    const { service, stores, host, subject, fake } = await setup();
    await service.signIn(email, password);
    host.busy.add(defaultLocalDatabaseName);
    expectFailure(await service.signOut(), 'database_busy');
    expect(stores.current()?.opened.databaseName).toBe(accountDatabaseName(subject));
    expect(fake.signedIn).toBe(subject);
  });

  it('signs in again after expiry with the same account only', async () => {
    const { service, fake, stores, subject } = await setup();
    expectFailure(await service.reauthenticate(password), 'not_signed_in');
    await service.signIn(email, password);
    // The session expired; local work continues and queued changes wait.
    await fake.auth.signOut();
    expect(fake.signedIn).toBeNull();
    expectFailure(await service.reauthenticate('wrong-password'), 'invalid_credentials');
    expectFailure(await service.reauthenticate(''), 'invalid_input');
    await expect(service.reauthenticate(password)).resolves.toEqual({ ok: true, value: undefined });
    expect(fake.signedIn).toBe(subject);
    expect(stores.current()?.identity.accountSubjectId).toBe(subject);

    // The email now belongs to a different account (the old one was deleted elsewhere).
    fake.users.delete(email);
    fake.addUser(email, password);
    expectFailure(await service.reauthenticate(password), 'different_account');
    expect(fake.signedIn).toBeNull();
    expect(stores.current()?.identity.accountSubjectId).toBe(subject);

    // The index lost the email: signing in again needs the full sign-in.
    const current = stores.current()!;
    (current as { entry: unknown }).entry = { ...current.entry, email: null };
    expectFailure(await service.reauthenticate(password), 'email_unknown');
  });

  it('removes the account from this device, guarding unsynced changes', async () => {
    const { service, stores, subject, fake, host, storage } = await setup();
    await service.signIn(email, password);
    host.database(accountDatabaseName(subject)).pendingOperations = 2;
    expectFailure(
      await service.removeFromDevice({ deleteLocalCopy: true, acceptUnsyncedLoss: false }),
      'unsynced_changes',
    );
    expect(stores.current()?.opened.databaseName).toBe(accountDatabaseName(subject));
    expect(fake.signedIn).toBe(subject);
    await expect(
      service.removeFromDevice({ deleteLocalCopy: true, acceptUnsyncedLoss: true }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(fake.signedIn).toBeNull();
    expect(host.databases.has(accountDatabaseName(subject))).toBe(false);
    expect(readIdentityIndex(storage)?.identities.map(({ kind }) => kind)).toEqual(['local']);
  });

  it('keeps this device’s copy when only the session is removed, or the copy is busy', async () => {
    const { service, subject, fake, host } = await setup();
    await service.signIn(email, password);
    await expect(
      service.removeFromDevice({ deleteLocalCopy: false, acceptUnsyncedLoss: false }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(host.databases.has(accountDatabaseName(subject))).toBe(true);
    expect(fake.signedIn).toBeNull();

    await service.signIn(email, password);
    const busy = accountDatabaseName(subject);
    const remove = host.remove.bind(host);
    host.remove = (name) => (name === busy ? Promise.reject(new Error('busy')) : remove(name));
    expectFailure(
      await service.removeFromDevice({ deleteLocalCopy: true, acceptUnsyncedLoss: true }),
      'remove_failed',
    );
    expect(host.databases.has(busy)).toBe(true);
  });
});

describe('account service: export and deletion', () => {
  it('exports the open plan, stating pending sync', async () => {
    const { service, host, subject } = await setup();
    await service.signIn(email, password);
    host.database(accountDatabaseName(subject)).pendingOperations = 1;
    const exported = await service.exportAccount();
    expect(exported).toMatchObject({
      ok: true,
      value: { fileName: 'yelaxis-export-2026-10-01.json', syncWasPending: true, recordCount: 1 },
    });
    host.database(accountDatabaseName(subject)).failures.add('export');
    expectFailure(await service.exportAccount(), 'export_failed');
  });

  it('previews deletion scope: cloud, this device, and pending changes', async () => {
    const { service, fake, host, subject } = await setup();
    await service.signIn(email, password);
    fake.status = { recordCounts: { action: 4, axis: 1 }, recordCount: 5, deletion: 'none' };
    host.database(accountDatabaseName(subject)).pendingOperations = 2;
    await expect(service.deletionPreview()).resolves.toEqual({
      ok: true,
      value: {
        accountEmail: email,
        cloud: {
          kinds: [
            { label: 'Axes', count: 1 },
            { label: 'Actions', count: 4 },
          ],
          total: 5,
        },
        local: { kinds: [{ label: 'Planning profile', count: 1 }], total: 1 },
        pendingChanges: 2,
      },
    });
    fake.network = 'offline';
    expectFailure(await service.deletionPreview(), 'offline');
  });

  it('deletes the account and this device’s copy after the password', async () => {
    const { service, stores, subject, fake, host } = await setup();
    await service.signIn(email, password);
    expectFailure(
      await service.deleteAccount({ password: 'wrong-password', keepLocalCopy: false }),
      'wrong_password',
    );
    expect(host.database(accountDatabaseName(subject)).deletion.phase).toBe('none');
    await expect(service.deleteAccount({ password, keepLocalCopy: false })).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(fake.calls).toContain('rpc:account_delete');
    expect(fake.users.size).toBe(0);
    expect(fake.signedIn).toBeNull();
    expect(host.databases.has(accountDatabaseName(subject))).toBe(false);
    expect(stores.current()?.identity.kind).toBe('local');
    expect(stores.findAccount(subject)).toBeNull();
  });

  it('removes a deleted account’s copy at the next launch when removing it could not finish', async () => {
    const { service, stores, subject, fake, host, storage } = await setup();
    await service.signIn(email, password);
    const replica = accountDatabaseName(subject);
    const remove = host.remove.bind(host);
    host.remove = (name) => (name === replica ? Promise.reject(new Error('busy')) : remove(name));
    expectFailure(
      await service.deleteAccount({ password, keepLocalCopy: false }),
      'deleted_copy_remove_failed',
    );
    expect(fake.users.size).toBe(0);
    expect(stores.current()?.identity.kind).toBe('local');
    expect(stores.findAccount(subject)).toBeNull();
    host.remove = remove;
    await stores.close();
    const restartedStores = new IdentityStores(host, storage, () => 'unused');
    await restartedStores.open();
    await createWebAccountService({
      backend: createSupabaseAccountBackend(fake.loader(), { storage }),
      stores: restartedStores,
    }).start();
    expect(host.databases.has(replica)).toBe(false);
    expect(restartedStores.current()?.opened.databaseName).toBe(defaultLocalDatabaseName);
  });

  it('keeps this device’s copy as a local-only plan when chosen', async () => {
    const { service, stores, subject, fake, host } = await setup();
    await service.signIn(email, password);
    const replica = accountDatabaseName(subject);
    await expect(service.deleteAccount({ password, keepLocalCopy: true })).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(fake.signedIn).toBeNull();
    expect(stores.current()?.opened.databaseName).toBe(replica);
    expect(stores.current()?.identity.kind).toBe('local');
    expect(stores.current()?.entry.kind).toBe('local');
    expect(host.database(replica).deletion.phase).toBe('none');
  });

  it('keeps the copy with retry and cancel when the server deletion fails', async () => {
    const { service, subject, fake, host, stores } = await setup();
    await service.signIn(email, password);
    const database = host.database(accountDatabaseName(subject));
    fake.deleteAnswer = 'server_error';
    expectFailure(
      await service.deleteAccount({ password, keepLocalCopy: false }),
      'deletion_failed',
    );
    expect(database.deletion).toMatchObject({
      phase: 'failed_recoverable',
      errorCode: 'unavailable',
      localCopy: 'delete',
    });
    expect(stores.current()?.opened.databaseName).toBe(accountDatabaseName(subject));
    expectFailure(
      await service.deleteAccount({ password, keepLocalCopy: true }),
      'deletion_in_progress',
    );
    await expect(service.cancelDeletion()).resolves.toEqual({ ok: true, value: undefined });
    expect(database.deletion.phase).toBe('none');
    expectFailure(await service.cancelDeletion(), 'no_deletion');
    expectFailure(await service.retryDeletion(password), 'no_deletion');

    expectFailure(
      await service.deleteAccount({ password, keepLocalCopy: false }),
      'deletion_failed',
    );
    // The account still exists: retrying needs the password again (a recent sign-in).
    fake.deleteAnswer = 'already_deleted';
    expectFailure(await service.retryDeletion(''), 'password_required');
    expectFailure(await service.retryDeletion('wrong-password'), 'wrong_password');
    expect(fake.calls.filter((call) => call === 'rpc:account_delete')).toHaveLength(2);
    const calls = fake.calls.length;
    await expect(service.retryDeletion(password)).resolves.toEqual({ ok: true, value: undefined });
    // The server was asked first, then the password signed in again before the deletion.
    expect(fake.calls.slice(calls)).toEqual([
      'load',
      'rpc:account_status',
      'load',
      'signInWithPassword',
      'load',
      'rpc:account_delete',
      'load',
      'signOut:local',
    ]);
    expect(host.databases.has(accountDatabaseName(subject))).toBe(false);
  });

  it('finishes a deletion made on another device, keeping this device’s copy', async () => {
    const { service, stores, subject, fake, host } = await setup();
    await service.signIn(email, password);
    const replica = accountDatabaseName(subject);
    // Another device deleted the account; the password no longer signs in.
    fake.users.clear();
    fake.status = { recordCounts: {}, recordCount: 0, deletion: 'pending' };
    await expect(service.retryDeletion('')).resolves.toEqual({ ok: true, value: undefined });
    expect(fake.calls).not.toContain('rpc:account_delete');
    expect(fake.signedIn).toBeNull();
    // No choice was made here: this device keeps its copy, as a local-only plan.
    expect(stores.current()?.opened.databaseName).toBe(replica);
    expect(stores.current()?.identity.kind).toBe('local');
    expect(host.database(replica).deletion.phase).toBe('none');
  });

  it('records a deletion made elsewhere with the choice of the Delete account dialog', async () => {
    const { service, stores, subject, fake, host } = await setup();
    await service.signIn(email, password);
    fake.users.clear();
    fake.status = { recordCounts: {}, recordCount: 0, deletion: 'pending' };
    const calls = fake.calls.length;
    await expect(
      service.deleteAccount({ password: 'no-longer-valid', keepLocalCopy: false }),
    ).resolves.toEqual({ ok: true, value: undefined });
    // The server already deleted it: no password sign-in and no second deletion call.
    expect(fake.calls.slice(calls)).not.toContain('signInWithPassword');
    expect(fake.calls.slice(calls)).not.toContain('rpc:account_delete');
    expect(host.databases.has(accountDatabaseName(subject))).toBe(false);
    expect(stores.current()?.identity.kind).toBe('local');
  });

  it('refuses to cancel a deletion the server already made, and finishes it with the choice', async () => {
    const { service, stores, subject, fake, host } = await setup();
    await service.signIn(email, password);
    const replica = accountDatabaseName(subject);
    // The server deleted the account, but its answer never arrived.
    fake.deleteAnswer = 'server_error';
    expectFailure(
      await service.deleteAccount({ password, keepLocalCopy: false }),
      'deletion_failed',
    );
    expect(host.database(replica).deletion.phase).toBe('failed_recoverable');
    fake.users.clear();
    fake.status = { recordCounts: {}, recordCount: 0, deletion: 'pending' };
    expectFailure(await service.cancelDeletion(), 'deletion_done_copy_removed');
    expect(host.databases.has(replica)).toBe(false);
    expect(stores.current()?.identity.kind).toBe('local');
    expect(fake.signedIn).toBeNull();
  });

  it('keeps a copy as a local plan when canceling comes after a deletion made elsewhere', async () => {
    const { service, stores, subject, fake } = await setup();
    await service.signIn(email, password);
    fake.users.clear();
    fake.status = { recordCounts: {}, recordCount: 0, deletion: 'pending' };
    expectFailure(await service.cancelDeletion(), 'deletion_done_copy_kept');
    expect(stores.current()?.opened.databaseName).toBe(accountDatabaseName(subject));
    expect(stores.current()?.identity.kind).toBe('local');
  });

  it('says calmly when the deletion cannot be checked, and changes nothing', async () => {
    const { service, stores, subject, fake, host } = await setup();
    await service.signIn(email, password);
    const database = host.database(accountDatabaseName(subject));
    fake.deleteAnswer = 'server_error';
    await service.deleteAccount({ password, keepLocalCopy: true });
    const before = { ...database.deletion };
    fake.network = 'offline';
    expectFailure(await service.retryDeletion(password), 'deletion_check_unavailable');
    expectFailure(await service.cancelDeletion(), 'deletion_check_unavailable');
    fake.network = 'online';
    fake.statusAnswer = 'server_error';
    expectFailure(await service.cancelDeletion(), 'deletion_check_unavailable');
    fake.statusAnswer = 'ok';
    // The session ended: Cancel cannot ask; Retry signs in again with the password first.
    await fake.auth.signOut();
    expectFailure(await service.cancelDeletion(), 'deletion_check_signed_out');
    expectFailure(await service.retryDeletion(''), 'deletion_check_signed_out');
    fake.users.clear();
    expectFailure(await service.retryDeletion(password), 'deletion_password_unverified');
    expect(database.deletion).toEqual(before);
    expect(stores.current()?.opened.databaseName).toBe(accountDatabaseName(subject));
  });

  it('signs in again with the password when the session ended, then retries', async () => {
    const { service, subject, fake, host } = await setup();
    await service.signIn(email, password);
    fake.deleteAnswer = 'server_error';
    await service.deleteAccount({ password, keepLocalCopy: false });
    await fake.auth.signOut();
    fake.deleteAnswer = 'deleted';
    await expect(service.retryDeletion(password)).resolves.toEqual({ ok: true, value: undefined });
    expect(host.databases.has(accountDatabaseName(subject))).toBe(false);
    expect(fake.users.size).toBe(0);
  });

  it('asks to sign in again when the session expired before the deletion call', async () => {
    const { service, subject, fake, host } = await setup();
    await service.signIn(email, password);
    fake.deleteAnswer = 'unauthorized';
    expectFailure(
      await service.deleteAccount({ password, keepLocalCopy: false }),
      'session_expired',
    );
    expect(host.database(accountDatabaseName(subject)).deletion.phase).toBe('failed_recoverable');
  });
});

describe('account service: launch', () => {
  it('clears a stored session the client no longer reports, with no replica open', async () => {
    const first = await setup({ local: meaningful });
    await first.service.signIn(email, password);
    // Offline with an expired access token: no session is reported, but it is still stored.
    first.fake.expiredOffline = true;
    first.fake.network = 'offline';
    first.host.database(defaultLocalDatabaseName).open = false;
    const stores = new IdentityStores(first.host, first.storage, () => 'unused');
    const restarted = createWebAccountService({
      backend: createSupabaseAccountBackend(first.fake.loader(), {
        storage: first.storage,
        online: () => false,
      }),
      stores,
    });
    await stores.open();
    await restarted.start();
    expect(first.storage.getItem(sessionStorageKey)).toBeNull();
    expect(restarted.currentAccount()).toBeNull();
    expect(stores.current()?.opened.databaseName).toBe(defaultLocalDatabaseName);
  });

  it('does not keep a backup made for a link that never happened', async () => {
    const first = await setup({ local: meaningful });
    await first.service.signIn(email, password);
    // The backup was made and checked, and the tab closed before the link.
    const database = first.host.database(defaultLocalDatabaseName);
    await expect(first.stores.current()!.accounts.createVerifiedBackup()).resolves.toMatchObject({
      ok: true,
    });
    expect(database.backup).not.toBeNull();
    database.open = false;
    const stores = new IdentityStores(first.host, first.storage, () => 'unused');
    await stores.open();
    await createWebAccountService({
      backend: createSupabaseAccountBackend(first.fake.loader(), { storage: first.storage }),
      stores,
    }).start();
    expect(database.backup).toBeNull();
    expect(database.counts).toEqual(meaningful);
  });

  it('clears a session left without its replica, keeping the local plan', async () => {
    const first = await setup({ local: meaningful });
    await first.service.signIn(email, password);
    expect(first.fake.signedIn).not.toBeNull();
    // The app restarted while the first-upload choice was open.
    const stores = new IdentityStores(first.host, first.storage, () => 'unused');
    first.host.database(defaultLocalDatabaseName).open = false;
    const restarted = createWebAccountService({
      backend: createSupabaseAccountBackend(first.fake.loader(), { storage: first.storage }),
      stores,
    });
    await stores.open();
    await restarted.start();
    expect(first.fake.signedIn).toBeNull();
    expect(restarted.currentAccount()).toBeNull();
  });

  it('finishes a deletion that was confirmed before a restart', async () => {
    const { service, stores, subject, host, storage, fake } = await setup();
    await service.signIn(email, password);
    const replica = host.database(accountDatabaseName(subject));
    replica.deletion = {
      phase: 'confirmed',
      requestId: null,
      requestedAt: null,
      confirmedAt: '2026-10-01T09:00:00.000Z' as never,
      localCopy: 'delete',
      errorCode: null,
    };
    replica.open = false;
    const restartedStores = new IdentityStores(
      host,
      storage,
      () => 'f0000000-0000-4000-8000-000000000001',
    );
    const restarted = createWebAccountService({
      backend: createSupabaseAccountBackend(fake.loader(), { storage }),
      stores: restartedStores,
    });
    await restartedStores.open();
    expect(restartedStores.current()?.opened.databaseName).toBe(accountDatabaseName(subject));
    await restarted.start();
    expect(restartedStores.current()?.identity.kind).toBe('local');
    expect(host.databases.has(accountDatabaseName(subject))).toBe(false);
    expect(stores).not.toBe(restartedStores);
  });
});
