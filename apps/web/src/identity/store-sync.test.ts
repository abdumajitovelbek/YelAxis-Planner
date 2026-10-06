import type { ConflictService, SyncCoordinator, SyncStatus } from '@yelaxis/sync';
import { describe, expect, it, vi } from 'vitest';

import type { AccountService } from '../account/account-service';
import type { IdentityStore, IdentityStoreEvent } from './identity-stores';
import { lazySyncTransport, SyncSwitch, type StoreSync } from './store-sync';
import type { AccountClient } from './supabase-backend';
import { createSyncedAccountService } from './synced-account-service';

/*
 * sync composition: the app-wide controller follows the active store's
 * coordinator, reports Local only or Signing in without one, and the account service keeps the
 * status honest around operations that keep the open store.
 */

const synced: SyncStatus = {
  state: 'synced',
  configured: true,
  account: { email: 'person@example.test' },
  pendingChanges: 0,
  openConflicts: 0,
  rejectedChanges: 0,
};

function fakeStoreSync(status: SyncStatus = synced) {
  const listeners = new Set<() => void>();
  const coordinator = {
    getStatus: vi.fn(() => status),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
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
    resolve: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
  } satisfies ConflictService;
  const sync: StoreSync = { coordinator, conflicts };
  return { sync, coordinator, conflicts, publish: () => listeners.forEach((l) => l()) };
}

describe('the app-wide sync controller', () => {
  it('reports Local only without an account store, and Signing in while a sign-in runs', async () => {
    const control = new SyncSwitch(true);
    expect(control.getStatus()).toMatchObject({ state: 'local_only', configured: true });
    const seen: string[] = [];
    control.subscribe(() => seen.push(control.getStatus().state));
    let finish = (): void => undefined;
    const running = control.whileSigningIn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(control.getStatus().state).toBe('signing_in');
    finish();
    await running;
    expect(control.getStatus().state).toBe('local_only');
    expect(seen).toEqual(['signing_in', 'local_only']);
    await expect(control.list()).resolves.toEqual([]);
    await expect(control.get('anything')).resolves.toBeNull();
    await expect(control.resolve('anything', { choice: 'keep_local' })).resolves.toMatchObject({
      ok: false,
      code: 'not_signed_in',
    });
    await expect(control.syncNow()).resolves.toBeUndefined();
  });

  it('a build without accounts stays Local only', () => {
    expect(new SyncSwitch(false).getStatus()).toMatchObject({
      state: 'local_only',
      configured: false,
    });
  });

  it('follows an attached coordinator and stops it on detach', async () => {
    const control = new SyncSwitch(true);
    const notified = vi.fn();
    control.subscribe(notified);
    const { sync, coordinator, conflicts, publish } = fakeStoreSync();
    control.attach(sync);
    expect(coordinator.start).toHaveBeenCalledOnce();
    expect(control.coordinator).toBe(coordinator);
    expect(control.getStatus()).toBe(synced);
    publish();
    expect(notified).toHaveBeenCalledTimes(2);
    await control.syncNow();
    await control.refresh();
    await control.resume();
    await control.list();
    await control.resolve('conflict', { choice: 'keep_remote' });
    expect(coordinator.syncNow).toHaveBeenCalledOnce();
    expect(coordinator.refresh).toHaveBeenCalledOnce();
    expect(coordinator.resume).toHaveBeenCalledOnce();
    expect(conflicts.list).toHaveBeenCalledOnce();
    expect(conflicts.resolve).toHaveBeenCalledWith('conflict', { choice: 'keep_remote' });

    await control.detach();
    expect(coordinator.stop).toHaveBeenCalledOnce();
    expect(control.coordinator).toBeNull();
    expect(control.getStatus().state).toBe('local_only');
    publish();
    expect(notified).toHaveBeenCalledTimes(3);
  });

  it('attaching a new store stops the previous coordinator first', () => {
    const control = new SyncSwitch(true);
    const first = fakeStoreSync();
    const second = fakeStoreSync({ ...synced, state: 'first_upload' });
    control.attach(first.sync);
    control.attach(second.sync);
    expect(first.coordinator.stop).toHaveBeenCalledOnce();
    expect(second.coordinator.start).toHaveBeenCalledOnce();
    expect(control.getStatus().state).toBe('first_upload');
  });

  it('detach resolves once the stopped coordinator’s running cycle has ended', async () => {
    const control = new SyncSwitch(true);
    const first = fakeStoreSync();
    let ended = (): void => undefined;
    first.coordinator.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ended = resolve;
        }),
    );
    control.attach(first.sync);
    let stopped = false;
    // The switching event detaches without waiting; reconnecting waits for the same stop.
    void control.detach();
    const waiting = control.detach().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(first.coordinator.stop).toHaveBeenCalledOnce();
    ended();
    await waiting;
    expect(stopped).toBe(true);
    // With nothing running, it resolves at once; a stop that fails never makes it reject.
    await expect(control.detach()).resolves.toBeUndefined();
    const second = fakeStoreSync();
    second.coordinator.stop.mockImplementation(() => Promise.reject(new Error('stop failed')));
    control.attach(second.sync);
    await expect(control.detach()).resolves.toBeUndefined();
  });

  it('retries rejected changes through the open account’s coordinator, and at once without one', async () => {
    const control = new SyncSwitch(true);
    await expect(control.retryRejected()).resolves.toBeUndefined();
    const { sync, coordinator } = fakeStoreSync();
    control.attach(sync);
    await control.retryRejected();
    expect(coordinator.retryRejected).toHaveBeenCalledOnce();
    expect(coordinator.syncNow).not.toHaveBeenCalled();
  });

  it('reports an account store’s own state while signing in again, never Signing in', async () => {
    const control = new SyncSwitch(true);
    const { sync } = fakeStoreSync({ ...synced, state: 'auth_expired' });
    control.attach(sync);
    let finish = (): void => undefined;
    const running = control.whileSigningIn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(control.getStatus().state).toBe('auth_expired');
    finish();
    await running;
    expect(control.getStatus().state).toBe('auth_expired');
  });
});

describe('the lazily loaded transport', () => {
  it('loads the account client once, on the first network call', async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({ data: [], error: null, status: 200, statusText: 'OK', count: null }),
    );
    const load = vi.fn(() => Promise.resolve({ rpc } as unknown as AccountClient));
    const transport = lazySyncTransport(load);
    expect(load).not.toHaveBeenCalled();
    await expect(transport.openConflicts()).resolves.toEqual({ ok: true, value: [] });
    await transport.openConflicts();
    expect(load).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('reports an outage when the client cannot load, and tries again next time', async () => {
    const load = vi
      .fn<() => Promise<AccountClient>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue({
        rpc: () => Promise.resolve({ data: [], error: null, status: 200 }),
      } as unknown as AccountClient);
    const transport = lazySyncTransport(load);
    await expect(transport.openConflicts()).resolves.toEqual({
      ok: false,
      failure: { kind: 'unavailable' },
    });
    await expect(transport.openConflicts()).resolves.toEqual({ ok: true, value: [] });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

/** The identity stores' switch events and open database, as the synced service sees them. */
function fakeStores(databaseName = '/yelaxis-acct-a.sqlite3') {
  const listeners = new Set<(event: IdentityStoreEvent) => void>();
  let open: string | null = databaseName;
  return {
    stores: {
      subscribe(listener: (event: IdentityStoreEvent) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      current: () => (open === null ? null : ({ opened: { databaseName: open } } as IdentityStore)),
    },
    /** The open store switches to `next` (the same database for a reload). */
    switchTo(next: string): void {
      for (const listener of [...listeners]) listener({ type: 'switching' });
      open = next;
    },
  };
}

describe('the account service with sync status', () => {
  function service(overrides: Partial<AccountService> = {}) {
    const failure = { ok: false as const, code: 'deletion_failed', message: 'Not deleted.' };
    const base = {
      configured: true,
      currentAccount: () => null,
      signIn: vi.fn(() =>
        Promise.resolve({ ok: true as const, value: { kind: 'opened_account' } }),
      ),
      signUp: vi.fn(() => Promise.resolve(failure)),
      reauthenticate: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
      deleteAccount: vi.fn(() => Promise.resolve(failure)),
      retryDeletion: vi.fn(() => Promise.resolve(failure)),
      cancelDeletion: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
      ...overrides,
    } as unknown as AccountService;
    const control = new SyncSwitch(true);
    const store = fakeStoreSync();
    control.attach(store.sync);
    const { stores } = fakeStores();
    return {
      account: createSyncedAccountService(base, control, stores),
      coordinator: store.coordinator,
    };
  }

  it('resumes queued work after signing in again, and not after a failed attempt', async () => {
    const { account, coordinator } = service();
    await account.signIn('person@example.test', 'secret');
    await account.reauthenticate('secret');
    expect(coordinator.resume).toHaveBeenCalledTimes(2);
    await account.signUp('person@example.test', 'secret');
    expect(coordinator.resume).toHaveBeenCalledTimes(2);
  });

  it('shows a pending deletion before a failed deletion returns, and resumes after cancel', async () => {
    const { account, coordinator } = service();
    let refreshedBeforeReturn = false;
    coordinator.refresh.mockImplementation(() => {
      refreshedBeforeReturn = true;
      return Promise.resolve();
    });
    const result = await account.deleteAccount({ password: 'secret', keepLocalCopy: false });
    expect(result.ok).toBe(false);
    expect(refreshedBeforeReturn).toBe(true);
    await account.retryDeletion('secret');
    expect(coordinator.refresh).toHaveBeenCalledTimes(2);
    await account.cancelDeletion();
    expect(coordinator.resume).toHaveBeenCalledOnce();
  });

  it('resumes queued work when neither the server nor this device has a deletion', async () => {
    const none = { ok: false as const, code: 'no_deletion', message: 'Nothing to retry.' };
    const { account, coordinator } = service({
      retryDeletion: vi.fn(() => Promise.resolve(none)),
      cancelDeletion: vi.fn(() => Promise.resolve(none)),
    });
    await account.retryDeletion('secret');
    await account.cancelDeletion();
    expect(coordinator.resume).toHaveBeenCalledTimes(2);
    expect(coordinator.refresh).not.toHaveBeenCalled();
  });
});
