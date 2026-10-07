/**
 * The sync coordinator: one per open store, single-flight, push then pull. It starts
 * on launch, after a committed change (debounced), when the browser goes online or the page becomes
 * visible, every 60 seconds while visible, and on "Sync now". Every write goes through the
 * application facade, one short transaction at a time, so commands never wait on the network.
 * Transient failures back off (5 s to 15 min, ±20% jitter) and any answer from the server ends the
 * backoff; a timer only ever waits for a time still ahead, and never less than a second, so a retry
 * time already past cannot make it spin. An expired session pauses network work until `resume`; a
 * rejected group waits for a person (`retryRejected`).
 */
import {
  syncBackoffDelay,
  type SyncApplication,
  type SyncFacts,
  type SyncPulledPage,
} from '@yelaxis/application';

import type { SyncController, SyncStatus } from './controller-contract';
import { toPulledPage, toPushOutcome, toPushRequest, toServerConflict } from './protocol-mapping';
import {
  syncLimits,
  syncProtocolVersion,
  type SyncTransport,
  type TransportFailure,
} from './protocol';
import { aggregateSyncStatus } from './status';

export interface SyncScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncNetwork {
  isOnline(): boolean;
  /** Called with the new state on every change; returns the unsubscribe function. */
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface SyncVisibility {
  isVisible(): boolean;
  subscribe(listener: (visible: boolean) => void): () => void;
}

export interface SyncCoordinatorOptions {
  readonly application: SyncApplication;
  readonly transport: SyncTransport;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly scheduler: SyncScheduler;
  readonly network: SyncNetwork;
  readonly visibility: SyncVisibility;
  /** The build has account configuration. Defaults to true. */
  readonly configured?: boolean;
  /** The signed-in account, for display only. */
  readonly account?: () => { readonly email: string } | null;
  /** True while the identity part signs in. */
  readonly signingIn?: () => boolean;
  /** Jitter source in [0, 1). */
  readonly random?: () => number;
  /** Delay after a committed change before a cycle starts. */
  readonly debounceMs?: number;
  /** Cycle interval while the page is visible. */
  readonly intervalMs?: number;
  /** Changes requested per pulled page (at most the protocol limit). */
  readonly pullPageSize?: number;
  /** Pages held in memory while their references wait for a later page. */
  readonly maxHeldPages?: number;
  /** Groups pushed in one cycle before yielding (the next cycle continues). */
  readonly maxGroupsPerCycle?: number;
  /** Pages pulled in one cycle before yielding. */
  readonly maxPagesPerCycle?: number;
  /** Called after every cycle with fresh facts (for example to finish linking). */
  readonly onCycleSettled?: (facts: SyncFacts) => void | Promise<void>;
}

export interface SyncCoordinator extends SyncController {
  /** Launch: recover stranded groups, listen for triggers, and sync once. */
  start(): void;
  /**
   * Stop timers and listeners at once; a running cycle stops at its next step. Resolves (never
   * rejects) when that cycle has ended, so another coordinator can then take over the same store.
   */
  stop(): Promise<void>;
  /** A command committed locally: sync after the debounce delay. */
  notifyLocalChange(): void;
  /** The person signed in again: network work resumes with the same queued groups. */
  resume(): Promise<void>;
  /** Re-read facts (for example after a conflict was resolved) without network work. */
  refresh(): Promise<void>;
}

type Trigger = 'launch' | 'change' | 'online' | 'visible' | 'interval' | 'manual' | 'retry';

/** Triggers after which waiting groups are retried at once (ids never change). */
const retriesNow = new Set<Trigger>(['launch', 'online', 'manual']);

type StepResult = 'done' | 'stopped';

/** The shortest wait of any timer: nothing the coordinator waits for is due sooner. */
const minimumTimerMs = 1_000;

export function createSyncCoordinator(options: SyncCoordinatorOptions): SyncCoordinator {
  return new Coordinator(options);
}

class Coordinator implements SyncCoordinator {
  readonly #options: SyncCoordinatorOptions;
  readonly #listeners = new Set<() => void>();
  readonly #random: () => number;
  #facts: SyncFacts | null = null;
  #status: SyncStatus;
  #syncing = false;
  #authExpired = false;
  /** The server said the account is being deleted: pushes stay frozen until `resume`. */
  #deletionPending = false;
  #lastFailure: 'offline' | 'unavailable' | null = null;
  #retryAt: number | null = null;
  #networkFailures = 0;
  /** Consecutive pulls whose pages could be neither applied nor kept as conflicts here. */
  #refusedPulls = 0;
  #started = false;
  #stopped = false;
  #running: Promise<void> | null = null;
  #again: Trigger | null = null;
  #debounce: unknown = null;
  #timer: unknown = null;
  #unsubscribe: (() => void)[] = [];
  #lastProgressRefresh = 0;
  #settling = false;
  /** Application writes started outside a cycle (`retryRejected`); `stop` waits for them too. */
  readonly #writes = new Set<Promise<unknown>>();

  constructor(options: SyncCoordinatorOptions) {
    this.#options = options;
    this.#random = options.random ?? Math.random;
    this.#status = this.#computeStatus();
  }

  getStatus(): SyncStatus {
    return this.#status;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  syncNow(): Promise<void> {
    return this.#trigger('manual');
  }

  async retryRejected(): Promise<void> {
    if (this.#stopped) return;
    // The same groups with the same ids, back in local order; the server answers them again.
    const write = this.#guard(() => this.#options.application.retryRejected());
    this.#writes.add(write);
    try {
      await write;
    } finally {
      this.#writes.delete(write);
    }
    if (this.#stopped) return;
    await this.#readFacts();
    await this.#trigger('manual');
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#unsubscribe.push(
      this.#options.network.subscribe((online) => {
        this.#publish();
        if (online) void this.#trigger('online');
      }),
      this.#options.visibility.subscribe((visible) => {
        if (visible) void this.#trigger('visible');
        else this.#schedule();
      }),
    );
    void this.#trigger('launch');
  }

  stop(): Promise<void> {
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#clear('debounce');
    this.#clear('timer');
    // Asked from inside the settle hook, the cycle only waits for its caller: nothing else runs.
    const cycle = this.#running === null || this.#settling ? [] : [this.#running];
    return Promise.allSettled([...cycle, ...this.#writes]).then(() => undefined);
  }

  notifyLocalChange(): void {
    if (this.#stopped) return;
    this.#clear('debounce');
    this.#debounce = this.#options.scheduler.setTimeout(() => {
      this.#debounce = null;
      void this.#trigger('change');
    }, this.#options.debounceMs ?? 2_000);
  }

  async resume(): Promise<void> {
    this.#authExpired = false;
    this.#deletionPending = false;
    this.#publish();
    await this.#trigger('manual');
  }

  async refresh(): Promise<void> {
    await this.#readFacts();
  }

  /* ───────────────────────── Single flight ───────────────────────── */

  #trigger(trigger: Trigger): Promise<void> {
    if (this.#running !== null) {
      // Coalesce: one more cycle runs after the current one (a reset trigger wins).
      if (this.#again === null || retriesNow.has(trigger)) this.#again = trigger;
      // A request from inside the settle hook must not wait for the cycle that awaits the hook.
      return this.#settling ? Promise.resolve() : this.#running;
    }
    const run = async (): Promise<void> => {
      let next: Trigger | null = trigger;
      while (next !== null && !this.#stopped) {
        this.#again = null;
        await this.#cycle(next);
        next = this.#again;
      }
    };
    this.#running = run().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #cycle(trigger: Trigger): Promise<void> {
    // Nothing is in flight between cycles (single flight): a `sending` group was stranded by a
    // restart or an interrupted cycle, and returns to `pending` with the same ids.
    await this.#guard(() => this.#options.application.recoverStranded());
    if (this.#stopped) return;
    const facts = await this.#readFacts();
    if (this.#stopped) return;
    const ready =
      facts !== null &&
      facts.link !== 'none' &&
      facts.link !== 'local' &&
      facts.replicaId !== undefined &&
      facts.deletion !== 'pending' &&
      !this.#deletionPending &&
      !this.#authExpired;
    if (!ready || facts === null || facts.replicaId === undefined) {
      this.#schedule();
      return;
    }
    if (!this.#options.network.isOnline()) {
      this.#lastFailure = 'offline';
      this.#publish();
      this.#schedule();
      return;
    }
    if (retriesNow.has(trigger)) {
      this.#retryAt = null;
      await this.#guard(() => this.#options.application.retryNow());
      if (this.#stopped) return;
    } else if (this.#retryAt !== null && this.#options.now() < this.#retryAt) {
      this.#schedule();
      return;
    }

    this.#syncing = true;
    this.#publish();
    let finished = false;
    try {
      finished = await this.#rounds(facts.replicaId);
    } catch {
      // A local failure: nothing was lost (every step is its own transaction); retry later.
      this.#failed('unavailable');
    }
    this.#syncing = false;
    if (this.#stopped) {
      this.#publish();
      return;
    }
    const settled = await this.#readFacts();
    if (finished) {
      this.#lastFailure = null;
      this.#networkFailures = 0;
      this.#retryAt = null;
      this.#publish();
    }
    this.#schedule();
    if (settled === null || this.#stopped || this.#options.onCycleSettled === undefined) return;
    this.#settling = true;
    try {
      await this.#options.onCycleSettled(settled);
    } catch {
      // The hook belongs to another part; a failure there never stops sync.
    } finally {
      this.#settling = false;
    }
  }

  /** Push, answer server candidates, pull; again while merges queued new groups. */
  async #rounds(replicaId: string): Promise<boolean> {
    for (let round = 0; round < 3; round += 1) {
      if ((await this.#push()) === 'stopped') return false;
      if ((await this.#serverConflicts()) === 'stopped') return false;
      const pulled = await this.#pull(replicaId);
      if (pulled === 'stopped') return false;
      if (pulled === 'done') return true;
    }
    return true;
  }

  /* ───────────────────────── Push ───────────────────────── */

  async #push(): Promise<StepResult> {
    const application = this.#options.application;
    const limit = this.#options.maxGroupsPerCycle ?? 2_000;
    for (let count = 0; count < limit; count += 1) {
      if (this.#stopped) return 'stopped';
      const group = await application.claimNextGroup();
      if (group === null) return 'done';
      const request = toPushRequest(group);
      if (!request.ok) {
        await application.recordPushOutcome(group.mutationGroupId, {
          kind: 'rejected',
          code: request.code,
        });
        continue;
      }
      const outcome = toPushOutcome(await this.#options.transport.push(request.request));
      // The answer is recorded even while stopping: it finishes the step already in flight.
      await application.recordPushOutcome(group.mutationGroupId, outcome);
      switch (outcome.kind) {
        case 'auth_expired':
          this.#authExpired = true;
          return 'stopped';
        case 'deletion_pending':
          this.#answered();
          this.#deletionPending = true;
          this.#publish();
          return 'stopped';
        case 'transient':
          this.#failed(outcome.reason === 'offline' ? 'offline' : 'unavailable');
          return 'stopped';
        case 'accepted':
        case 'conflict':
        case 'rejected':
          this.#answered();
          await this.#progress();
          break;
      }
    }
    return 'done';
  }

  /** First-upload progress is refreshed at most twice a second during long pushes. */
  async #progress(): Promise<void> {
    const now = this.#options.now();
    if (now - this.#lastProgressRefresh < 500) return;
    this.#lastProgressRefresh = now;
    await this.#readFacts();
  }

  /* ───────────────────────── Server conflicts ───────────────────────── */

  async #serverConflicts(): Promise<StepResult> {
    const application = this.#options.application;
    const transport = this.#options.transport;
    const open = await transport.openConflicts();
    if (!open.ok) return this.#transportFailed(open.failure);
    this.#answered();
    if (this.#stopped) return 'stopped';
    await application.mergeServerConflicts(open.value.map(toServerConflict));
    for (const closure of await application.pendingServerClosures()) {
      if (this.#stopped) return 'stopped';
      const closed = await transport.closeConflict({
        conflictId: closure.serverConflictId,
        resolution: closure.resolution,
      });
      if (!closed.ok) return this.#transportFailed(closed.failure);
      await application.confirmServerClosure(closure.serverConflictId);
    }
    return this.#stopped ? 'stopped' : 'done';
  }

  /* ───────────────────────── Pull ───────────────────────── */

  /** `queued`: merges queued groups to push; `done`: caught up. */
  async #pull(replicaId: string): Promise<'done' | 'queued' | 'stopped'> {
    const application = this.#options.application;
    const facts = await application.facts();
    if (facts.unconfirmed > 0) {
      // A group was sent without an answer; it is pushed again before anything is pulled.
      return 'stopped';
    }
    const limit = Math.max(
      1,
      // Each applied page persists a durable checkpoint/image. Use the protocol's bounded page
      // capacity by default to avoid repeating that work for unnecessarily small batches.
      Math.min(this.#options.pullPageSize ?? syncLimits.changesPerPage, syncLimits.changesPerPage),
    );
    const maxHeld = Math.max(1, this.#options.maxHeldPages ?? 20);
    const maxPages = this.#options.maxPagesPerCycle ?? 200;
    let cursor = facts.cursor;
    let held: SyncPulledPage[] = [];
    let restarted = false;
    let queued = false;
    for (let pages = 0; pages < maxPages; pages += 1) {
      if (this.#stopped) return 'stopped';
      const result = await this.#options.transport.pull({
        protocolVersion: syncProtocolVersion,
        replicaId,
        afterCursor: cursor,
        limit,
      });
      if (!result.ok) return this.#transportFailed(result.failure);
      this.#answered();
      // A page received while stopping is not applied: the cursor has not moved, so the next
      // coordinator of this store pulls it again.
      if (this.#stopped) return 'stopped';
      if (result.value.status === 'cursor_expired') {
        // Reconcile from the beginning; local records and queued changes all stay.
        if (restarted) return this.#stoppedUnavailable();
        restarted = true;
        await application.restartFromBeginning();
        cursor = null;
        held = [];
        continue;
      }
      const page = toPulledPage(result.value);
      held.push(page);
      const applied = await application.applyPulledPages(held, {
        preserveUnsatisfied: held.length >= maxHeld,
      });
      if (applied.status === 'needs_more') {
        cursor = page.nextCursor;
        continue;
      }
      if (applied.status === 'not_ready') return 'stopped';
      if (applied.status === 'refused') return this.#pullRefused();
      if (applied.status === 'failed') return this.#stoppedUnavailable();
      if (this.#refusedPulls > 0) {
        this.#refusedPulls = 0;
        this.#publish();
      }
      held = [];
      cursor = applied.cursor;
      queued = queued || applied.queuedPushes;
      if (applied.caughtUp) return queued ? 'queued' : 'done';
      await this.#progress();
    }
    // More is waiting: the next cycle continues from the stored cursor.
    this.#again ??= 'retry';
    return 'done';
  }

  /* ───────────────────────── Failures and scheduling ───────────────────────── */

  #transportFailed(failure: TransportFailure): StepResult {
    if (failure.kind === 'auth_expired') {
      this.#authExpired = true;
      this.#publish();
      return 'stopped';
    }
    this.#failed(failure.kind === 'offline' ? 'offline' : 'unavailable');
    return 'stopped';
  }

  #stoppedUnavailable(): StepResult {
    this.#failed('unavailable');
    return 'stopped';
  }

  /**
   * Pulled pages this device can neither apply nor keep as conflicts: Needs attention, not a
   * server outage. The same pages are tried again later, backing off (a later app may hold them).
   */
  #pullRefused(): StepResult {
    this.#refusedPulls += 1;
    this.#retryAt = this.#options.now() + syncBackoffDelay(this.#refusedPulls, this.#random);
    this.#publish();
    return 'stopped';
  }

  /** The server answered: an earlier failure is over, and nothing waits on its backoff. */
  #answered(): void {
    if (this.#lastFailure === null && this.#retryAt === null && this.#networkFailures === 0) {
      return;
    }
    this.#lastFailure = null;
    this.#retryAt = null;
    this.#networkFailures = 0;
    this.#publish();
  }

  #failed(reason: 'offline' | 'unavailable'): void {
    // A fetch that fails while the browser reports a connection reached no server.
    this.#lastFailure =
      reason === 'offline' && this.#options.network.isOnline() ? 'unavailable' : reason;
    this.#networkFailures += 1;
    this.#retryAt = this.#options.now() + syncBackoffDelay(this.#networkFailures, this.#random);
    this.#publish();
  }

  async #guard<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch {
      return null;
    }
  }

  async #readFacts(): Promise<SyncFacts | null> {
    const facts = await this.#guard(() => this.#options.application.facts());
    if (facts !== null) this.#facts = facts;
    this.#publish();
    return facts;
  }

  #schedule(): void {
    this.#clear('timer');
    if (this.#stopped || !this.#started || this.#authExpired) return;
    const now = this.#options.now();
    // A time already past was the cycle's to act on: only a time still ahead wakes it again.
    const retryAt = this.#retryAt !== null && this.#retryAt > now ? this.#retryAt : null;
    const nextAttempt = Date.parse(this.#facts?.nextAttemptAt ?? '');
    const candidates: number[] = [];
    if (this.#options.visibility.isVisible()) {
      candidates.push(now + (this.#options.intervalMs ?? 60_000));
    }
    if (retryAt !== null) candidates.push(retryAt);
    if (nextAttempt > now) candidates.push(nextAttempt);
    if (candidates.length === 0) return;
    // Before the coordinator's own retry time a cycle would only wait again: nothing runs sooner.
    const at = Math.max(Math.min(...candidates), retryAt ?? Number.NEGATIVE_INFINITY);
    const trigger: Trigger = at === retryAt ? 'retry' : 'interval';
    this.#timer = this.#options.scheduler.setTimeout(
      () => {
        this.#timer = null;
        void this.#trigger(trigger);
      },
      Math.max(minimumTimerMs, at - now),
    );
  }

  #clear(which: 'debounce' | 'timer'): void {
    const handle = which === 'debounce' ? this.#debounce : this.#timer;
    if (handle !== null) this.#options.scheduler.clearTimeout(handle);
    if (which === 'debounce') this.#debounce = null;
    else this.#timer = null;
  }

  #computeStatus(): SyncStatus {
    return aggregateSyncStatus({
      configured: this.#options.configured ?? true,
      account: this.#options.account?.() ?? null,
      signingIn: this.#options.signingIn?.() ?? false,
      facts:
        this.#facts !== null && this.#deletionPending
          ? { ...this.#facts, deletion: 'pending' }
          : this.#facts,
      syncing: this.#syncing,
      authExpired: this.#authExpired,
      lastFailure: this.#lastFailure,
      online: this.#options.network.isOnline(),
      retryAt: this.#retryAt === null ? null : new Date(this.#retryAt).toISOString(),
      pullRefused: this.#refusedPulls > 0,
    });
  }

  #publish(): void {
    const next = this.#computeStatus();
    if (JSON.stringify(next) === JSON.stringify(this.#status)) return;
    this.#status = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure never stops sync or other listeners.
      }
    }
  }
}
