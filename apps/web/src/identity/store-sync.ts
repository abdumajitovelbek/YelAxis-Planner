import {
  browserClock,
  browserIdProvider,
  createSyncApplication,
  type SerialQueue,
  type SyncFacts,
} from '@yelaxis/application';
import { SqliteSyncStore, type SqliteDriver } from '@yelaxis/data';
import {
  aggregateSyncStatus,
  createConflictService,
  createSnapshotHasher,
  createSupabaseSyncTransport,
  createSyncCoordinator,
  type ConflictService,
  type SyncController,
  type SyncCoordinator,
  type SyncNetwork,
  type SyncScheduler,
  type SyncStatus,
  type SyncTransport,
  type SyncVisibility,
} from '@yelaxis/sync';

import type { AccountClientLoader } from './supabase-backend';

/*
 * sync composition. An account identity's open store gets one coordinator,
 * built on the store's own command queue so sync transactions wait their turn like every command.
 * `SyncSwitch` is the one SyncController and ConflictService the account UI binds to: it follows the
 * active store across sign-in, sign-out, and linking, and reports Local only (or Signing in) while
 * the active identity is local. An account store's coordinator never reports Signing in: signing in
 * again to an open account keeps its own state (for example Sign in again) until it resumes.
 */

/** The coordinator, its conflict service, and the store they belong to. */
export interface StoreSync {
  readonly coordinator: SyncCoordinator;
  readonly conflicts: ConflictService;
}

export interface StoreSyncOptions {
  readonly driver: SqliteDriver;
  readonly queue: SerialQueue;
  readonly transport: SyncTransport;
  readonly account: () => { readonly email: string } | null;
  /** After every cycle (for example to finish linking); the facts are fresh. */
  readonly afterCycle: (facts: SyncFacts, coordinator: SyncCoordinator) => Promise<void>;
  /** Pulled changes or a resolved conflict changed canonical rows: views re-query. */
  readonly onPlanChanged: () => void;
}

const browserNetwork: SyncNetwork = {
  isOnline: () => navigator.onLine,
  subscribe(listener) {
    const online = (): void => listener(true);
    const offline = (): void => listener(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  },
};

const browserVisibility: SyncVisibility = {
  isVisible: () => document.visibilityState === 'visible',
  subscribe(listener) {
    const changed = (): void => listener(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  },
};

const browserScheduler: SyncScheduler = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/**
 * The Supabase transport over the lazily loaded account client: supabase-js loads on the first
 * network call. A client that cannot load is a transient outage, retried with backoff.
 */
export function lazySyncTransport(load: AccountClientLoader): SyncTransport {
  let transport: Promise<SyncTransport | null> | null = null;
  const resolve = (): Promise<SyncTransport | null> => {
    transport ??= load().then(
      (client) => createSupabaseSyncTransport(client),
      () => {
        transport = null;
        return null;
      },
    );
    return transport;
  };
  const unavailable = { ok: false, failure: { kind: 'unavailable' } } as const;
  return {
    push: async (request) => (await resolve())?.push(request) ?? unavailable,
    pull: async (request) => (await resolve())?.pull(request) ?? unavailable,
    openConflicts: async () => (await resolve())?.openConflicts() ?? unavailable,
    closeConflict: async (request) => (await resolve())?.closeConflict(request) ?? unavailable,
  };
}

/** One coordinator for an account identity's open store; `start` it once the app is composed. */
export function createStoreSync(options: StoreSyncOptions): StoreSync {
  const application = createSyncApplication(
    {
      store: new SqliteSyncStore(options.driver),
      clock: browserClock(),
      ids: browserIdProvider(),
      hasher: createSnapshotHasher(),
      projections: { notifyCommitted: () => options.onPlanChanged() },
    },
    { queue: options.queue },
  );
  const coordinator: SyncCoordinator = createSyncCoordinator({
    application,
    transport: options.transport,
    now: () => Date.now(),
    scheduler: browserScheduler,
    network: browserNetwork,
    visibility: browserVisibility,
    account: options.account,
    onCycleSettled: (facts) => options.afterCycle(facts, coordinator),
  });
  const conflicts = createConflictService({
    application,
    onResolved: () => {
      options.onPlanChanged();
      void coordinator.syncNow();
    },
  });
  return { coordinator, conflicts };
}

const notSignedIn = {
  ok: false,
  code: 'not_signed_in',
  message: 'Conflicts belong to an account. Sign in to see them.',
} as const;

/**
 * The SyncController and ConflictService of the whole app. It never blocks a control: without an
 * active account store it reports Local only, or Signing in while a sign-in runs.
 */
export class SyncSwitch implements SyncController, ConflictService {
  readonly #configured: boolean;
  readonly #listeners = new Set<() => void>();
  #active: StoreSync | null = null;
  #unsubscribe: (() => void) | null = null;
  /** Resolves once every coordinator this switch stopped has ended its running cycle. */
  #stopping: Promise<void> = Promise.resolve();
  #signingIn = 0;
  #localStatus: SyncStatus | null = null;

  constructor(configured: boolean) {
    this.#configured = configured;
  }

  /** The active store's coordinator, if the active identity is an account. */
  get coordinator(): SyncCoordinator | null {
    return this.#active?.coordinator ?? null;
  }

  /**
   * Follows a newly opened account store and starts its coordinator. Await `detach()` first when
   * the previous coordinator worked on the same store, so two never run on one store.
   */
  attach(sync: StoreSync): void {
    void this.detach();
    this.#active = sync;
    this.#unsubscribe = sync.coordinator.subscribe(() => this.#notify());
    sync.coordinator.start();
    this.#notify();
  }

  /**
   * Stops the active coordinator before its store closes or is replaced. Resolves when every
   * coordinator stopped so far has ended its running cycle (at once when none runs); never rejects.
   */
  detach(): Promise<void> {
    const active = this.#active;
    if (active !== null) {
      this.#active = null;
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      const stopped = Promise.resolve(active.coordinator.stop()).catch(() => undefined);
      this.#stopping = Promise.all([this.#stopping, stopped]).then(() => undefined);
      this.#notify();
    }
    return this.#stopping;
  }

  get signingIn(): boolean {
    return this.#signingIn > 0;
  }

  /** Reports Signing in while `work` runs. */
  async whileSigningIn<Value>(work: () => Promise<Value>): Promise<Value> {
    this.#signingIn += 1;
    this.#localStatus = null;
    this.#notify();
    try {
      return await work();
    } finally {
      this.#signingIn -= 1;
      this.#localStatus = null;
      this.#notify();
    }
  }

  getStatus(): SyncStatus {
    const active = this.#active;
    if (active !== null) return active.coordinator.getStatus();
    this.#localStatus ??= aggregateSyncStatus({
      configured: this.#configured,
      account: null,
      signingIn: this.signingIn,
      facts: null,
      syncing: false,
      authExpired: false,
      lastFailure: null,
      online: navigator.onLine,
      retryAt: null,
    });
    return this.#localStatus;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  syncNow(): Promise<void> {
    return this.#active?.coordinator.syncNow() ?? Promise.resolve();
  }

  /** The person retries the changes the account did not accept; at once without an account. */
  retryRejected(): Promise<void> {
    return this.#active?.coordinator.retryRejected() ?? Promise.resolve();
  }

  /** Re-reads the active store's facts after an account change (no network work). */
  refresh(): Promise<void> {
    return this.#active?.coordinator.refresh() ?? Promise.resolve();
  }

  /** The person signed in again: queued work resumes. */
  resume(): Promise<void> {
    return this.#active?.coordinator.resume() ?? Promise.resolve();
  }

  async list() {
    return (await this.#active?.conflicts.list()) ?? [];
  }

  async get(conflictId: string) {
    return (await this.#active?.conflicts.get(conflictId)) ?? null;
  }

  async resolve(conflictId: string, choice: Parameters<ConflictService['resolve']>[1]) {
    const active = this.#active;
    if (active === null) return notSignedIn;
    return active.conflicts.resolve(conflictId, choice);
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
