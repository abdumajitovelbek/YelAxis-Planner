/**
 * Test-only replica: one real SQLite database with an account identity, the application's sync
 * facade over the SQLite sync store, a coordinator driven by a manual scheduler and clock, and
 * small planning commands that run through `executeCommand` (so every edit writes its outbox
 * group in the command transaction, exactly like the app).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSerialQueue,
  createSyncApplication,
  executeCommand,
  type ApplicationDependencies,
  type CanonicalMutation,
  type CanonicalRecordState,
  type CommandReceipt,
  type ApplicationResult,
  type OutboxMutationGroup,
  type SerialQueue,
  type SyncApplication,
} from '@yelaxis/application';
import {
  createSqliteApplicationAdapters,
  runMigrations,
  schemaMigrations,
  SqliteSyncStore,
  SqliteUnitOfWork,
} from '@yelaxis/data';
import {
  createDeletionTombstone,
  createEntityRef,
  ok,
  type EntityRef,
  type EntityType,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import {
  createSyncCoordinator,
  type SyncCoordinator,
  type SyncCoordinatorOptions,
} from '../coordinator';
import { createSnapshotHasher } from '../hasher';
import type { SyncTransport } from '../protocol';
import { NodeSqliteTestDriver } from './node-sqlite-driver';

export const ownerId = '0a000000-0000-4000-8000-000000000001' as OwnerId;
export const profileId = '0b000000-0000-4000-8000-000000000001' as UUID;
const startedAt = Date.parse('2026-10-01T09:00:00.000Z');

const directories: string[] = [];

export function removeReplicaFiles(): void {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
}

/** A manual clock and timer queue: tests advance time explicitly. */
export class ManualTime {
  now = startedAt;
  /** Every delay a timer was asked for, in order. */
  readonly delays: number[] = [];
  #timers = new Map<number, { at: number; callback: () => void }>();
  #next = 1;

  instant(): Instant {
    return new Date(this.now).toISOString() as Instant;
  }

  readonly scheduler = {
    setTimeout: (callback: () => void, delayMs: number): unknown => {
      const handle = this.#next;
      this.#next += 1;
      this.delays.push(delayMs);
      this.#timers.set(handle, { at: this.now + delayMs, callback });
      return handle;
    },
    clearTimeout: (handle: unknown): void => {
      this.#timers.delete(handle as number);
    },
  };

  /** Advance time, firing due timers in order. */
  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].callback();
    }
    this.now = target;
  }

  pendingTimers(): number {
    return this.#timers.size;
  }

  /** When the earliest timer fires, if any is set. */
  nextTimerAt(): number | null {
    let earliest: number | null = null;
    for (const timer of this.#timers.values()) {
      if (earliest === null || timer.at < earliest) earliest = timer.at;
    }
    return earliest;
  }
}

export interface ReplicaOptions {
  readonly name: string;
  readonly replicaId: UUID;
  readonly transport: SyncTransport;
  readonly time?: ManualTime;
  readonly withProfile?: boolean;
  readonly random?: () => number;
  /** Coordinator settings to override (page sizes, intervals). */
  readonly coordinator?: Partial<
    Pick<SyncCoordinatorOptions, 'pullPageSize' | 'maxHeldPages' | 'debounceMs' | 'intervalMs'>
  >;
}

export class Replica {
  readonly driver: NodeSqliteTestDriver;
  readonly time: ManualTime;
  readonly queue: SerialQueue;
  readonly application: SyncApplication;
  readonly coordinator: SyncCoordinator;
  readonly dependencies: ApplicationDependencies;
  readonly store: SqliteSyncStore;
  online = true;
  visible = true;
  #idCounter = 0;
  readonly #prefix: string;

  private constructor(
    readonly name: string,
    readonly replicaId: UUID,
    readonly transport: SyncTransport,
    driver: NodeSqliteTestDriver,
    time: ManualTime,
    random: () => number,
    settings: ReplicaOptions['coordinator'] = {},
  ) {
    this.driver = driver;
    this.time = time;
    this.#prefix = name === 'A' ? 'aa' : name === 'B' ? 'bb' : 'cc';
    this.queue = createSerialQueue();
    const ids = { next: () => this.nextId() };
    const clock = { now: () => time.instant() };
    this.store = new SqliteSyncStore(driver);
    this.application = createSyncApplication(
      { store: this.store, clock, ids, hasher: createSnapshotHasher(), random },
      { queue: this.queue },
    );
    this.dependencies = {
      ...createSqliteApplicationAdapters(driver),
      clock,
      ids,
      projections: { notifyCommitted: () => undefined },
    };
    this.coordinator = createSyncCoordinator({
      application: this.application,
      transport,
      now: () => time.now,
      scheduler: time.scheduler,
      network: { isOnline: () => this.online, subscribe: () => () => undefined },
      visibility: { isVisible: () => this.visible, subscribe: () => () => undefined },
      random,
      account: () => ({ email: 'person@example.test' }),
      ...settings,
    });
  }

  static async open(options: ReplicaOptions): Promise<Replica> {
    const directory = mkdtempSync(join(tmpdir(), 'yelaxis-sync-'));
    directories.push(directory);
    const driver = new NodeSqliteTestDriver(join(directory, `${options.name}.sqlite`));
    const time = options.time ?? new ManualTime();
    await runMigrations(driver, schemaMigrations, () => time.instant());
    await driver.run(
      `INSERT INTO planning_identities (
         id, identity_kind, account_subject_id, replica_id, created_at, updated_at
       ) VALUES (?, 'account', 'test-subject', ?, ?, ?);`,
      [ownerId, options.replicaId, time.instant(), time.instant()],
    );
    const replica = new Replica(
      options.name,
      options.replicaId,
      options.transport,
      driver,
      time,
      options.random ?? (() => 0.5),
      options.coordinator,
    );
    if (options.withProfile === true) await replica.seedProfile();
    return replica;
  }

  nextId(): UUID {
    this.#idCounter += 1;
    return `${this.#prefix}000000-0000-4000-8000-${this.#idCounter.toString(16).padStart(12, '0')}` as UUID;
  }

  ref(type: EntityType, id: UUID): EntityRef {
    return createEntityRef(type, id, ownerId);
  }

  /** The Profile a linked plan uploads first (onboarding wrote it while the plan was local). */
  async seedProfile(): Promise<void> {
    const now = this.time.instant();
    await this.driver.run(
      `INSERT INTO profiles (
         id, owner_id, planning_time_zone, week_start, time_format, onboarding_status,
         onboarding_step, onboarding_artifacts_json, created_at, updated_at
       ) VALUES (?, ?, 'Asia/Tashkent', 'monday', '24_hour', 'completed', 'handbook',
                 '{"axisIds":[],"commitments":[]}', ?, ?);`,
      [profileId, ownerId, now, now],
    );
    await this.queueInitialUpload([this.ref('profile', profileId)]);
  }

  /** What linking does: queue existing records as ordinary create groups (≤ 500 operations). */
  async queueInitialUpload(refs: readonly EntityRef[]): Promise<void> {
    const unitOfWork = new SqliteUnitOfWork(this.driver);
    const now = this.time.instant();
    for (let start = 0; start < refs.length; start += 500) {
      const slice = refs.slice(start, start + 500);
      await unitOfWork.runInTransaction(async (work) => {
        const mutationGroupId = this.nextId();
        const operations = [];
        for (const [sequence, ref] of slice.entries()) {
          const record = await work.records.read(ref);
          if (record === null) throw new Error('A queued record exists.');
          operations.push({
            operationId: this.nextId(),
            mutationGroupId,
            sequence,
            state: 'pending' as const,
            attemptCount: 0 as const,
            nextAttemptAt: now,
            mutation: {
              operation: 'create' as const,
              ref,
              expectedRevision: null,
              baseServerRevision: 0,
              baseSnapshotHash: null,
              document: record.document,
            },
          });
        }
        const group: OutboxMutationGroup = {
          mutationGroupId,
          ownerId,
          commandId: this.nextId(),
          actor: 'import',
          createdAt: now,
          operations,
        };
        await work.outbox.append(group);
      });
    }
  }

  /* ───────────────────────── Commands ───────────────────────── */

  read(ref: EntityRef): Promise<CanonicalRecordState | null> {
    return this.queue.run(() =>
      new SqliteUnitOfWork(this.driver).runInTransaction((work) => work.records.read(ref)),
    );
  }

  async create(
    type: EntityType,
    document: Record<string, unknown>,
    id = this.nextId(),
  ): Promise<EntityRef> {
    const ref = this.ref(type, id);
    const result = await this.#command([], () => [
      {
        operation: 'create',
        ref,
        expectedRevision: null,
        baseServerRevision: 0,
        baseSnapshotHash: null,
        document,
      },
    ]);
    if (!result.ok) throw new Error(`create failed: ${result.error.code}`);
    return ref;
  }

  async update(
    ref: EntityRef,
    patch: Record<string, unknown>,
  ): Promise<ApplicationResult<CommandReceipt>> {
    const current = await this.read(ref);
    if (current === null) throw new Error('update target missing');
    const document: Record<string, unknown> = { ...current.document };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete document[key];
      else document[key] = value;
    }
    return this.#command([{ ref, revision: current.localRevision }], (records) => [
      {
        operation: 'update',
        ref,
        expectedRevision: records.get(ref)?.localRevision ?? current.localRevision,
        baseServerRevision: records.get(ref)?.serverRevision ?? current.serverRevision,
        baseSnapshotHash: records.get(ref)?.baseSnapshotHash ?? current.baseSnapshotHash,
        document,
      },
    ]);
  }

  async remove(ref: EntityRef): Promise<ApplicationResult<CommandReceipt>> {
    const current = await this.read(ref);
    if (current === null) throw new Error('delete target missing');
    return this.#command([{ ref, revision: current.localRevision }], (records, now) => {
      const record = records.get(ref) ?? current;
      return [
        {
          operation: 'delete',
          ref,
          expectedRevision: record.localRevision,
          baseServerRevision: record.serverRevision,
          baseSnapshotHash: record.baseSnapshotHash,
          tombstone: createDeletionTombstone(ref, record.localRevision + 1, now),
        },
      ];
    });
  }

  #command(
    expected: readonly { readonly ref: EntityRef; readonly revision: number }[],
    build: (
      records: ReadonlyMap<EntityRef, CanonicalRecordState>,
      now: Instant,
    ) => CanonicalMutation[],
  ): Promise<ApplicationResult<CommandReceipt>> {
    return this.queue.run(() =>
      executeCommand(
        this.dependencies,
        {
          commandId: this.nextId(),
          ownerId,
          actor: 'user',
          expectedRevisions: expected,
          input: {},
        },
        async ({ records, context }) => {
          const current = new Map<EntityRef, CanonicalRecordState>();
          for (const item of expected) {
            const record = await records.read(item.ref);
            if (record !== null) current.set(item.ref, record);
          }
          const mutations = build(current, context.now);
          return ok({
            value: mutations,
            events: mutations.map((mutation) => ({
              aggregate: mutation.ref,
              eventType: `test.${mutation.operation}`,
              version: 1 as const,
              actor: context.actor,
              commandId: context.commandId,
              occurredAt: context.now,
              payload: { operation: mutation.operation },
            })),
            touched: mutations.map((mutation) => mutation.ref),
          });
        },
      ),
    );
  }

  /* ───────────────────────── Inspection ───────────────────────── */

  /** Every live synced record's document, keyed `type:id` (canonical data for comparison). */
  async documents(types: readonly EntityType[]): Promise<Map<string, Record<string, unknown>>> {
    const tables: Partial<Record<EntityType, string>> = {
      action: 'actions',
      review: 'review_checkpoints',
      profile: 'profiles',
      axis: 'axes',
      project: 'projects',
      planning_placement: 'planning_placements',
    };
    const result = new Map<string, Record<string, unknown>>();
    for (const type of types) {
      const table = tables[type];
      if (table === undefined) throw new Error(`no table for ${type}`);
      const rows = await this.driver.all<{ id: string }>(
        `SELECT id FROM ${table} WHERE owner_id = ? AND deleted_at IS NULL ORDER BY id;`,
        [ownerId],
      );
      for (const row of rows) {
        const record = await this.read(this.ref(type, row.id as UUID));
        if (record !== null) result.set(`${type}:${row.id}`, { ...record.document });
      }
    }
    return result;
  }

  async outboxRows(): Promise<number> {
    const row = await this.driver.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM sync_outbox WHERE owner_id = ?;',
      [ownerId],
    );
    return row?.count ?? 0;
  }

  async close(): Promise<void> {
    await this.coordinator.stop();
    await this.driver.close();
  }
}

export function actionDocument(title: string, extra: Record<string, unknown> = {}) {
  return {
    title,
    captureOrigin: 'global_capture',
    orderKey: 'a0',
    state: 'inbox',
    ...extra,
  };
}

export function dailyReviewDocument(date: string, extra: Record<string, unknown> = {}) {
  return {
    profileId,
    reviewType: 'daily',
    periodKey: date,
    periodStart: date,
    periodEnd: date,
    state: 'draft',
    ...extra,
  };
}
