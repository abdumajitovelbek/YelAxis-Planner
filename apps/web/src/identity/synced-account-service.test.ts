import type { ConflictService, SyncCoordinator, SyncStatus } from '@yelaxis/sync';
import { describe, expect, it, vi } from 'vitest';

import type { AccountResult, AccountService } from '../account/account-service';
import { accountOutcomes } from '../account/sync-text';
import { FakeIdentityHost, MemoryStorage } from './__fixtures__/fake-identity-host';
import { FakeSupabase } from './__fixtures__/fake-supabase';
import { defaultLocalDatabaseName } from './identity-index';
import { IdentityStores, type IdentityStore, type IdentityStoreEvent } from './identity-stores';
import { SyncSwitch } from './store-sync';
import { createSupabaseAccountBackend } from './supabase-backend';
import { createSyncedAccountService } from './synced-account-service';
import { createWebAccountService } from './web-account-service';

/*
 * A store switch rebuilds every view, so the view that started an account operation is gone when
 * it settles: the outcome of an operation during which the open plan switched is held as a
 * one-shot notice. Without a switch there is no notice; the view says it.
 */

const done: AccountResult = { ok: true, value: undefined };
const accountReplica = '/yelaxis-acct-a.sqlite3';
const localPlan = '/yelaxis.sqlite3';

function harness(databaseName = accountReplica) {
  const listeners = new Set<(event: IdentityStoreEvent) => void>();
  let open = databaseName;
  const stores = {
    subscribe(listener: (event: IdentityStoreEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    current: () => ({ opened: { databaseName: open } }) as IdentityStore,
  };
  /** The open plan switches to `next` (the same database when a store reloads). */
  const switchTo = (next: string): void => {
    for (const listener of [...listeners]) listener({ type: 'switching' });
    open = next;
  };
  /** An operation that switches the plan, then answers. */
  const switching =
    <Value>(next: string, answer: AccountResult<Value>) =>
    () => {
      switchTo(next);
      return Promise.resolve(answer);
    };
  const status: SyncStatus = {
    state: 'synced',
    configured: true,
    pendingChanges: 0,
    openConflicts: 0,
    rejectedChanges: 0,
  };
  const coordinator = {
    getStatus: () => status,
    subscribe: () => () => undefined,
    syncNow: vi.fn(() => Promise.resolve()),
    retryRejected: vi.fn(() => Promise.resolve()),
    start: vi.fn(),
    stop: vi.fn(() => Promise.resolve()),
    notifyLocalChange: vi.fn(),
    resume: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
  } satisfies SyncCoordinator;
  const conflicts = {
    list: vi.fn(() => Promise.resolve([])),
    get: vi.fn(() => Promise.resolve(null)),
    resolve: vi.fn(() => Promise.resolve(done)),
  } satisfies ConflictService;
  const sync = new SyncSwitch(true);
  sync.attach({ coordinator, conflicts });
  const service = (overrides: Partial<AccountService>) =>
    createSyncedAccountService(
      {
        configured: true,
        localTestService: true,
        currentAccount: () => ({ email: 'sam@example.test' }),
        ...overrides,
      } as AccountService,
      sync,
      stores,
    );
  return { service, switching, switchTo };
}

describe('outcomes of operations that switch the open plan', () => {
  it('says what each operation did, once, after the view that started it is gone', async () => {
    const { service, switching } = harness();
    const cases: readonly {
      readonly run: (account: AccountService) => Promise<AccountResult<unknown>>;
      readonly overrides: Partial<AccountService>;
      readonly text: string;
    }[] = [
      {
        overrides: { signOut: switching(localPlan, done) },
        run: (account) => account.signOut(),
        text: accountOutcomes.signedOut,
      },
      {
        overrides: { removeFromDevice: switching(localPlan, done) },
        run: (account) =>
          account.removeFromDevice({ deleteLocalCopy: false, acceptUnsyncedLoss: false }),
        text: accountOutcomes.removedKeptCopy,
      },
      {
        overrides: { removeFromDevice: switching(localPlan, done) },
        run: (account) =>
          account.removeFromDevice({ deleteLocalCopy: true, acceptUnsyncedLoss: true }),
        text: accountOutcomes.removedDeletedCopy,
      },
      {
        overrides: { deleteAccount: switching(accountReplica, done) },
        run: (account) => account.deleteAccount({ password: 'secret', keepLocalCopy: true }),
        text: accountOutcomes.deletedKeptCopy,
      },
      {
        overrides: { deleteAccount: switching(localPlan, done) },
        run: (account) => account.deleteAccount({ password: 'secret', keepLocalCopy: false }),
        text: accountOutcomes.deletedWithCopy,
      },
      {
        overrides: { startFirstUpload: switching(localPlan, done) },
        run: (account) => account.startFirstUpload(),
        text: accountOutcomes.uploadStarted,
      },
      {
        overrides: { declineFirstUpload: switching(accountReplica, done) },
        run: (account) => account.declineFirstUpload(),
        text: accountOutcomes.planKept,
      },
      {
        overrides: { cancelFirstUpload: switching(localPlan, done) },
        run: (account) => account.cancelFirstUpload(),
        text: accountOutcomes.uploadCanceled,
      },
      {
        overrides: {
          signIn: switching(accountReplica, { ok: true, value: { kind: 'opened_account' } }),
        },
        run: (account) => account.signIn(' sam@example.test ', 'secret'),
        text: 'Signed in as sam@example.test. Your account’s plan is open.',
      },
    ];
    for (const { overrides, run, text } of cases) {
      const account = service(overrides);
      expect(account.notices.current()).toBeNull();
      await expect(run(account)).resolves.toMatchObject({ ok: true });
      const notice = account.notices.current();
      expect(notice, text).toMatchObject({ text, tone: 'status' });
      // Shown once: consumed, it is gone.
      account.notices.consume(notice!.key);
      expect(account.notices.current()).toBeNull();
    }
  });

  it('says whether a retried deletion kept this device’s copy', async () => {
    const kept = harness();
    const keepAccount = kept.service({ retryDeletion: kept.switching(accountReplica, done) });
    await keepAccount.retryDeletion('secret');
    expect(keepAccount.notices.current()?.text).toBe(accountOutcomes.deletedKeptCopy);
    const removed = harness();
    const removeAccount = removed.service({ retryDeletion: removed.switching(localPlan, done) });
    await removeAccount.retryDeletion('secret');
    expect(removeAccount.notices.current()?.text).toBe(accountOutcomes.deletedWithCopy);
  });

  it('keeps a failure’s own words after a switch, announced assertively', async () => {
    const { service, switching } = harness();
    const message =
      'You are signed out. This device’s copy could not be removed yet; YelAxis Planner removes it the next time it opens.';
    const account = service({
      removeFromDevice: switching(localPlan, { ok: false, code: 'remove_failed', message }),
    });
    await account.removeFromDevice({ deleteLocalCopy: true, acceptUnsyncedLoss: true });
    expect(account.notices.current()).toMatchObject({ text: message, tone: 'alert' });
    const cancel = service({
      cancelDeletion: switching(localPlan, {
        ok: false,
        code: 'deletion_done_copy_removed',
        message: 'Your account had already been deleted, so the deletion could not be canceled.',
      }),
    });
    await cancel.cancelDeletion();
    expect(cancel.notices.current()).toMatchObject({
      text: 'Your account had already been deleted, so the deletion could not be canceled.',
      tone: 'alert',
    });
  });

  it('holds nothing when the plan did not switch: the view that asked says it', async () => {
    const { service } = harness();
    const account = service({
      signOut: () =>
        Promise.resolve({ ok: false, code: 'database_busy', message: 'Open in another tab.' }),
      cancelFirstUpload: () => Promise.resolve(done),
      cancelDeletion: () => Promise.resolve(done),
      signIn: () =>
        Promise.resolve({
          ok: true,
          value: {
            kind: 'choose_first_upload',
            preview: {
              accountEmail: 'sam@example.test',
              local: { kinds: [], total: 3 },
              cloudRecordCount: 0,
              sensitiveContextCount: 0,
            },
          },
        }),
    });
    await account.signOut();
    await account.cancelFirstUpload();
    await account.cancelDeletion();
    await account.signIn('sam@example.test', 'secret');
    expect(account.notices.current()).toBeNull();
  });

  it('says an operation that switched the plan and never answered did not finish', async () => {
    const { service, switchTo } = harness();
    const account = service({
      startFirstUpload: () => {
        switchTo(localPlan);
        return Promise.reject(new Error('worker'));
      },
    });
    await expect(account.startFirstUpload()).rejects.toThrow('worker');
    expect(account.notices.current()).toMatchObject({
      text: 'An account action did not finish. Open Account to see where it stands.',
      tone: 'alert',
    });
  });

  it('follows the real identity stores: a notice for each switch, none without one', async () => {
    const host = new FakeIdentityHost();
    const storage = new MemoryStorage();
    const fake = new FakeSupabase(storage);
    fake.addUser('sam@example.test', 'synthetic-password');
    host.localPlan(defaultLocalDatabaseName, { profile: 1, action: 3 });
    const stores = new IdentityStores(host, storage, () => 'e0000000-0000-4000-8000-000000000001');
    const web = createWebAccountService({
      backend: createSupabaseAccountBackend(fake.loader(), { storage }),
      stores,
    });
    await stores.open();
    await web.start();
    const account = createSyncedAccountService(web, new SyncSwitch(true), stores);
    const take = (): string | null => {
      const notice = account.notices.current();
      if (notice !== null) account.notices.consume(notice.key);
      return notice?.text ?? null;
    };
    // A plan with records: the choice waits, nothing switched.
    await account.signIn('sam@example.test', 'synthetic-password');
    expect(take()).toBeNull();
    // Cancel sign-in at the choice switches nothing either.
    await account.cancelFirstUpload();
    expect(take()).toBeNull();
    await account.signIn('sam@example.test', 'synthetic-password');
    await account.startFirstUpload();
    expect(take()).toBe(accountOutcomes.uploadStarted);
    await account.cancelFirstUpload();
    expect(take()).toBe(accountOutcomes.uploadCanceled);
    await account.signIn('sam@example.test', 'synthetic-password');
    await account.declineFirstUpload();
    expect(take()).toBe(accountOutcomes.planKept);
    await account.signOut();
    expect(take()).toBe(accountOutcomes.signedOut);
    // Signing out of a local plan switches nothing: no notice.
    await expect(account.signOut()).resolves.toMatchObject({ ok: true });
    expect(take()).toBeNull();
    // The account's own copy on this device reopens.
    await account.signIn('sam@example.test', 'synthetic-password');
    expect(take()).toBe('Signed in as sam@example.test. Your account’s plan is open.');
  });

  it('tells subscribers, replaces an older notice, and ignores a stale consume', async () => {
    const { service, switching } = harness();
    const account = service({
      signOut: switching(localPlan, done),
      startFirstUpload: switching(localPlan, done),
    });
    const listener = vi.fn();
    const unsubscribe = account.notices.subscribe(listener);
    await account.signOut();
    const first = account.notices.current()!;
    await account.startFirstUpload();
    const second = account.notices.current()!;
    expect(second.key).toBeGreaterThan(first.key);
    expect(second.text).toBe(accountOutcomes.uploadStarted);
    account.notices.consume(first.key);
    expect(account.notices.current()).toBe(second);
    account.notices.consume(second.key);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    await account.signOut();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
