import type {
  AccountApplication,
  AccountApplicationResult,
  AccountProfileSeed,
  PlanningIdentity,
} from '@yelaxis/application';
import type { SqliteDriver } from '@yelaxis/data';

import {
  accountDatabaseName,
  defaultLocalDatabaseName,
  emptyIdentityIndex,
  isRemovalPending,
  localDatabaseName,
  preserveIdentityIndex,
  readStoredIdentityIndex,
  withEntry,
  withoutDatabase,
  writeIdentityIndex,
  type AccountIdentityEntry,
  type IdentityIndex,
  type IdentityIndexEntry,
  type KeyValueStorage,
} from './identity-index';

/*
 * One database per planning identity (identity contract). Exactly one identity's
 * store is open in a tab; every database has its own Web Lock (held by its worker), so a store open
 * in another tab fails closed instead of being shared or overwritten. Switching closes the current
 * store before the next becomes active, and listeners rebuild every service on the new store. A
 * copy the person chose to delete is marked in the index before anything switches, never opens
 * again, and its removal is retried at each launch until it succeeds.
 */

/** One open planning database. */
export interface OpenedPlanningStore {
  readonly databaseName: string;
  /** The one serialized connection every service of this store shares. */
  readonly driver: SqliteDriver;
  readonly durability: 'best-effort' | 'persistent';
  close(): Promise<void>;
}

/** Browser persistence, injected by the composition root (tests pass fakes). */
export interface StoreHost {
  /** Opens (creating when new) and migrates one database under its own lock. */
  open(databaseName: string): Promise<OpenedPlanningStore>;
  /** Opens a database that is not open in this tab, under its lock, and removes it. */
  remove(databaseName: string): Promise<void>;
  accounts(driver: SqliteDriver): AccountApplication;
}

export interface IdentityStore {
  readonly entry: IdentityIndexEntry;
  readonly identity: PlanningIdentity;
  readonly opened: OpenedPlanningStore;
  readonly accounts: AccountApplication;
}

export type IdentityStoreEvent =
  { readonly type: 'switching' } | { readonly type: 'ready'; readonly store: IdentityStore };

export type StoreTarget =
  /** An identity this browser already holds. */
  | { readonly kind: 'entry'; readonly entry: IdentityIndexEntry }
  /** A new, empty local identity. */
  | { readonly kind: 'new_local' }
  /** An account's replica: the existing one, or a new one (seeded for an empty account). */
  | {
      readonly kind: 'account';
      readonly accountSubjectId: string;
      readonly email: string;
      readonly profileSeed: AccountProfileSeed | null;
    };

export type IdentityStoreErrorCode = 'database_busy' | 'storage' | 'identity_mismatch';

const defaultMessages: Readonly<Record<IdentityStoreErrorCode, string>> = {
  database_busy: 'The plan is already open in another tab.',
  storage: 'Persistent browser storage could not be opened.',
  identity_mismatch: 'This browser’s plan does not match the identity it was opened for.',
};

/** A content-free failure to open or switch a store; the message is safe to show. */
export class IdentityStoreError extends Error {
  constructor(
    readonly code: IdentityStoreErrorCode,
    message: string = defaultMessages[code],
  ) {
    super(message);
    this.name = 'IdentityStoreError';
  }
}

function errorCode(error: unknown): IdentityStoreErrorCode {
  if (error instanceof IdentityStoreError) return error.code;
  return error instanceof Error && 'code' in error && error.code === 'database_busy'
    ? 'database_busy'
    : 'storage';
}

/** Keeps the storage adapter's own (static, content-free) message when it has one. */
function wrapped(error: unknown): IdentityStoreError {
  if (error instanceof IdentityStoreError) return error;
  const code = errorCode(error);
  return new IdentityStoreError(
    code,
    code === 'storage' && error instanceof Error && error.message.length > 0
      ? error.message
      : defaultMessages[code],
  );
}

function unwrap<Value>(result: AccountApplicationResult<Value>): Value {
  if (!result.ok) {
    throw new IdentityStoreError(
      result.error.code === 'identity_exists' ? 'identity_mismatch' : 'storage',
    );
  }
  return result.value;
}

function entryFor(
  identity: PlanningIdentity,
  databaseName: string,
  previous: IdentityIndexEntry | null,
  email: string | null,
): IdentityIndexEntry {
  if (identity.kind === 'local' || identity.accountSubjectId === null) {
    return { id: identity.id, kind: 'local', databaseName };
  }
  const knownEmail =
    email ??
    (previous?.kind === 'account' && previous.accountSubjectId === identity.accountSubjectId
      ? previous.email
      : null);
  return {
    id: identity.id,
    kind: 'account',
    databaseName,
    accountSubjectId: identity.accountSubjectId,
    email: knownEmail,
  };
}

/** The most recently used local entry other than `except` (the index is in order of use). */
function latestLocal(index: IdentityIndex, except: string | null): IdentityIndexEntry | null {
  for (let position = index.identities.length - 1; position >= 0; position -= 1) {
    const entry = index.identities[position];
    if (entry !== undefined && entry.kind === 'local' && entry.databaseName !== except) {
      return entry;
    }
  }
  return null;
}

export class IdentityStores {
  readonly #host: StoreHost;
  readonly #storage: KeyValueStorage | null;
  readonly #token: () => string;
  readonly #listeners = new Set<(event: IdentityStoreEvent) => void>();
  /** The session's copy, used when storage refuses. */
  #index: IdentityIndex = emptyIdentityIndex;
  /** The text of a stored index that was not read exactly as written, until it is kept. */
  #damaged: string | null = null;
  /** A damaged index could not be kept: this session never overwrites it. */
  #memoryOnly = false;
  #current: IdentityStore | null = null;

  /** `token` names new local databases (a random UUID in the browser). */
  constructor(host: StoreHost, storage: KeyValueStorage | null, token: () => string) {
    this.#host = host;
    this.#storage = storage;
    this.#token = token;
  }

  current(): IdentityStore | null {
    return this.#current;
  }

  /** The stored index, re-read so another tab's additions survive; else this session's copy. */
  index(): IdentityIndex {
    if (this.#memoryOnly) return this.#index;
    const stored = readStoredIdentityIndex(this.#storage);
    if (stored === null) return this.#index;
    if (!stored.intact) this.#damaged ??= stored.text;
    return stored.index ?? this.#index;
  }

  subscribe(listener: (event: IdentityStoreEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The account's copy on this device; never one that waits to be removed. */
  findAccount(accountSubjectId: string): IdentityIndexEntry | null {
    return (
      this.index().identities.find(
        (entry) =>
          entry.kind === 'account' &&
          entry.accountSubjectId === accountSubjectId &&
          !isRemovalPending(entry),
      ) ?? null
    );
  }

  /**
   * The local identity to return to: the one this browser used most recently, other than the open
   * store.
   */
  localFallback(): IdentityIndexEntry | null {
    return latestLocal(this.index(), this.#current?.opened.databaseName ?? null);
  }

  /**
   * Opens the active identity's store at launch. A missing or unreadable index starts from the
   * original local database; the entry is reconciled with the identity the database holds, which
   * also repairs an index left behind by an interrupted link or cancel. A copy that waits to be
   * removed never opens: the most recent local plan (or a new one) opens instead.
   */
  async open(): Promise<IdentityStore> {
    if (this.#current !== null) return this.#current;
    const index = this.index();
    const active = index.identities.find(({ id }) => id === index.activeId) ?? null;
    const removed = new Set(
      index.identities.filter(isRemovalPending).map(({ databaseName }) => databaseName),
    );
    const entry =
      active !== null && removed.has(active.databaseName) ? latestLocal(index, null) : active;
    const databaseName =
      entry?.databaseName ??
      (removed.has(defaultLocalDatabaseName)
        ? localDatabaseName(this.#token())
        : defaultLocalDatabaseName);
    const store = await this.#openStore(databaseName, entry, null);
    this.#current = store;
    this.#save(withEntry(index, store.entry, true));
    return store;
  }

  /**
   * Marks an account's copy for removal before the local plan opens in its place, so a removal that
   * fails or is cut short happens at the next launch instead of leaving the copy behind.
   */
  markForRemoval(entry: IdentityIndexEntry): void {
    if (entry.kind !== 'account') return;
    const marked: AccountIdentityEntry = { ...entry, removalPending: true };
    this.#save(withEntry(this.index(), marked, false));
  }

  /** Removes every copy that waits to be removed and is not open; a failure waits for next time. */
  async removePending(): Promise<void> {
    const open = this.#current?.opened.databaseName;
    for (const entry of this.index().identities.filter(isRemovalPending)) {
      if (entry.databaseName === open) continue;
      try {
        await this.remove(entry);
      } catch {
        // Another tab may hold it; the next launch tries again.
      }
    }
  }

  /** Opens another identity's store without making it active (nothing changes on failure). */
  async prepare(target: StoreTarget): Promise<IdentityStore> {
    if (target.kind === 'entry') {
      this.#assertNotOpen(target.entry.databaseName);
      const store = await this.#openStore(target.entry.databaseName, target.entry, null);
      if (
        target.entry.kind === 'account' &&
        (store.entry.kind !== 'account' ||
          store.entry.accountSubjectId !== target.entry.accountSubjectId)
      ) {
        await this.discard(store);
        throw new IdentityStoreError('identity_mismatch');
      }
      return store;
    }
    if (target.kind === 'new_local') {
      return this.#openStore(localDatabaseName(this.#token()), null, null);
    }
    const existing = this.findAccount(target.accountSubjectId);
    const databaseName = existing?.databaseName ?? accountDatabaseName(target.accountSubjectId);
    this.#assertNotOpen(databaseName);
    // A copy the person chose to delete is removed before the account's new copy takes its name.
    const removal = this.index().identities.find(
      (entry) => entry.databaseName === databaseName && isRemovalPending(entry),
    );
    if (removal !== undefined) await this.remove(removal);
    const opened = await this.#openDatabase(databaseName);
    try {
      const accounts = this.#host.accounts(opened.driver);
      const identity = unwrap(
        await accounts.createAccountReplica({
          accountSubjectId: target.accountSubjectId,
          profileSeed: target.profileSeed,
        }),
      );
      return {
        entry: entryFor(identity, databaseName, existing, target.email),
        identity,
        opened,
        accounts,
      };
    } catch (error) {
      await opened.close().catch(() => undefined);
      throw wrapped(error);
    }
  }

  /** Closes a prepared store that will not become active. */
  async discard(store: IdentityStore): Promise<void> {
    if (store === this.#current) return;
    await store.opened.close().catch(() => undefined);
  }

  /** Closes the current store and makes a prepared one active. */
  async activate(store: IdentityStore): Promise<IdentityStore> {
    this.#emit({ type: 'switching' });
    const previous = this.#current;
    this.#current = null;
    if (previous !== null && previous.opened !== store.opened) {
      await previous.opened.close().catch(() => undefined);
    }
    this.#current = store;
    this.#save(withEntry(this.index(), store.entry, true));
    this.#emit({ type: 'ready', store });
    return store;
  }

  /**
   * Re-reads the open store's identity after a link, cancel, or detach changed its owner, updates
   * the index, and announces the change so every service is rebuilt.
   */
  async reload(options: { readonly email?: string } = {}): Promise<IdentityStore> {
    const current = this.#required();
    this.#emit({ type: 'switching' });
    try {
      const identity = unwrap(await current.accounts.identity());
      if (identity === null) throw new IdentityStoreError('storage');
      const next: IdentityStore = {
        ...current,
        identity,
        entry: entryFor(
          identity,
          current.opened.databaseName,
          current.entry,
          options.email ?? null,
        ),
      };
      this.#current = next;
      this.#save(withEntry(this.index(), next.entry, true));
      return next;
    } finally {
      const store = this.#current;
      if (store !== null) this.#emit({ type: 'ready', store });
    }
  }

  /** Re-reads the open store's identity when only its link state changed (no rebuild needed). */
  async refreshIdentity(): Promise<IdentityStore> {
    const current = this.#required();
    const identity = unwrap(await current.accounts.identity());
    if (identity === null || identity.id !== current.identity.id) {
      throw new IdentityStoreError('identity_mismatch');
    }
    const next: IdentityStore = { ...current, identity };
    this.#current = next;
    return next;
  }

  /** Remembers the sign-in email of the open account (display and signing in again). */
  rememberEmail(email: string): void {
    const current = this.#current;
    if (current === null || current.entry.kind !== 'account') return;
    const entry = { ...current.entry, email };
    this.#current = { ...current, entry };
    this.#save(withEntry(this.index(), entry, true));
  }

  /** Removes a database that is not the open one, and forgets its entry. */
  async remove(entry: IdentityIndexEntry): Promise<void> {
    this.#assertNotOpen(entry.databaseName);
    try {
      await this.#host.remove(entry.databaseName);
    } catch (error) {
      throw wrapped(error);
    }
    this.#save(withoutDatabase(this.index(), entry.databaseName));
  }

  async close(): Promise<void> {
    const current = this.#current;
    this.#current = null;
    if (current !== null) await current.opened.close().catch(() => undefined);
  }

  async #openDatabase(databaseName: string): Promise<OpenedPlanningStore> {
    try {
      return await this.#host.open(databaseName);
    } catch (error) {
      throw wrapped(error);
    }
  }

  async #openStore(
    databaseName: string,
    previous: IdentityIndexEntry | null,
    email: string | null,
  ): Promise<IdentityStore> {
    const opened = await this.#openDatabase(databaseName);
    try {
      const accounts = this.#host.accounts(opened.driver);
      let identity = unwrap(await accounts.identity());
      if (identity === null) {
        // An empty database: an account replica whose copy was cleared is recreated empty (its
        // account fills it again); anything else becomes a local identity.
        identity =
          previous?.kind === 'account'
            ? unwrap(
                await accounts.createAccountReplica({
                  accountSubjectId: previous.accountSubjectId,
                  profileSeed: null,
                }),
              )
            : unwrap(await accounts.ensureLocalIdentity());
      }
      return {
        entry: entryFor(identity, databaseName, previous, email),
        identity,
        opened,
        accounts,
      };
    } catch (error) {
      await opened.close().catch(() => undefined);
      throw wrapped(error);
    }
  }

  #assertNotOpen(databaseName: string): void {
    if (this.#current?.opened.databaseName === databaseName) {
      throw new IdentityStoreError('identity_mismatch');
    }
  }

  #required(): IdentityStore {
    if (this.#current === null) throw new IdentityStoreError('storage');
    return this.#current;
  }

  /**
   * Writes the index. A damaged stored index is kept under its own key first; when it cannot be
   * kept, this session keeps its index in memory and never overwrites the stored one.
   */
  #save(index: IdentityIndex): void {
    this.#index = index;
    if (this.#memoryOnly) return;
    if (this.#damaged !== null) {
      if (!preserveIdentityIndex(this.#storage, this.#damaged)) {
        this.#memoryOnly = true;
        return;
      }
      this.#damaged = null;
    }
    writeIdentityIndex(this.#storage, index);
  }

  #emit(event: IdentityStoreEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A listener's failure never interrupts a switch.
      }
    }
  }
}
