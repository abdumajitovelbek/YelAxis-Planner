/**
 * The account sync SQLite sync store over real SQLite: identity and link state, outbox order and states,
 * sync metadata on every record table, base snapshots, the deletion ledger, conflicts, the cursor,
 * first-upload progress, the remote Profile, Context documents, reference checks before commit, and
 * index use of the statements that read history (EXPLAIN QUERY PLAN).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeCommand,
  type ApplicationDependencies,
  type CanonicalMutation,
  type SyncQueueReceipt,
  type SyncStoredConflict,
  type SyncTransactionStore,
} from '@yelaxis/application';
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
import { afterEach, describe, expect, it } from 'vitest';

import { DataAdapterError } from '../application/errors';
import { SqliteOnboardingPersistence } from '../application/onboarding-adapter';
import { createSqliteApplicationAdapters } from '../application/sqlite-adapters';
import type { SqliteParameter } from '../sqlite/driver';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { SqliteSyncStore } from './sqlite-sync-store';
import { syncSql } from './sync-sql';

const now = '2026-10-01T09:00:00.000Z' as Instant;
const owner = '10000000-0000-4000-8000-0000000000aa' as OwnerId;
const replica = '20000000-0000-4000-8000-0000000000aa' as UUID;
const profileId = '30000000-0000-4000-8000-0000000000aa' as UUID;
const directories: string[] = [];
let sequence = 0;

const nextId = (): UUID => {
  sequence += 1;
  return `40000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}` as UUID;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function database(kind: 'account' | 'local' = 'account'): Promise<NodeSqliteDriver> {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-sync-store-'));
  directories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(driver, schemaMigrations, () => now);
  await driver.run(
    `INSERT INTO planning_identities (
       id, identity_kind, account_subject_id, replica_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?);`,
    [
      owner,
      kind,
      kind === 'account' ? 'subject' : null,
      kind === 'account' ? replica : null,
      now,
      now,
    ],
  );
  return driver;
}

function dependencies(driver: NodeSqliteDriver): ApplicationDependencies {
  return {
    ...createSqliteApplicationAdapters(driver),
    clock: { now: () => now },
    ids: { next: nextId },
    projections: { notifyCommitted: () => undefined },
  };
}

const ref = (type: EntityType, id: UUID): EntityRef => createEntityRef(type, id, owner);
const action = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  captureOrigin: 'global_capture',
  orderKey: 'a0',
  state: 'inbox',
  ...extra,
});

/** One command through `executeCommand` (an account identity queues its outbox group). */
async function command(
  driver: NodeSqliteDriver,
  mutations: readonly CanonicalMutation[],
  expected: readonly { ref: EntityRef; revision: number }[] = [],
) {
  const result = await executeCommand(
    dependencies(driver),
    { commandId: nextId(), ownerId: owner, actor: 'user', expectedRevisions: expected, input: {} },
    ({ context }) =>
      ok({
        value: mutations,
        events: mutations.map((mutation) => ({
          aggregate: mutation.ref,
          eventType: 'test.changed',
          version: 1 as const,
          actor: context.actor,
          commandId: context.commandId,
          occurredAt: context.now,
          payload: { operation: mutation.operation },
        })),
        touched: mutations.map((mutation) => mutation.ref),
      }),
  );
  if (!result.ok) throw new Error(`command failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function queuedGroup(receipt: SyncQueueReceipt): UUID {
  if (!receipt.queued) throw new Error('An account command queues a group.');
  return receipt.mutationGroupId;
}

const create = (target: EntityRef, document: Record<string, unknown>): CanonicalMutation => ({
  operation: 'create',
  ref: target,
  expectedRevision: null,
  baseServerRevision: 0,
  baseSnapshotHash: null,
  document,
});

async function inStore<T>(
  driver: NodeSqliteDriver,
  work: (sync: SyncTransactionStore) => Promise<T>,
): Promise<T> {
  return new SqliteSyncStore(driver).runInTransaction((unitOfWork) => work(unitOfWork.sync));
}

async function plan(driver: NodeSqliteDriver, sql: string, parameters: SqliteParameter[]) {
  const rows = await driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters);
  return rows.map(({ detail }) => detail).join('\n');
}

describe('identity and link state', () => {
  it('reads the account identity, its replica, and treats an identity that never linked as linked', async () => {
    const driver = await database();
    expect(await inStore(driver, (sync) => sync.identity())).toEqual({
      ownerId: owner,
      kind: 'account',
      replicaId: replica,
      linked: true,
      deletion: 'none',
    });
    await driver.close();
  });

  it('reports linking while linked_at is empty, and a pending deletion', async () => {
    const driver = await database();
    await driver.run(
      `UPDATE planning_identities SET link_id = ?, link_source_identity_id = ?, link_started_at = ?;`,
      [nextId(), nextId(), now],
    );
    expect((await inStore(driver, (sync) => sync.identity()))?.linked).toBe(false);
    await driver.run('UPDATE planning_identities SET linked_at = ?;', [now]);
    expect((await inStore(driver, (sync) => sync.identity()))?.linked).toBe(true);
    await driver.run(
      `INSERT INTO account_deletion_state (id, owner_id, state, created_at, updated_at)
       VALUES ('deletion', ?, 'pending', ?, ?);`,
      [owner, now, now],
    );
    expect((await inStore(driver, (sync) => sync.identity()))?.deletion).toBe('pending');
    await driver.close();
  });

  it('reads a local identity', async () => {
    const driver = await database('local');
    expect(await inStore(driver, (sync) => sync.identity())).toMatchObject({
      kind: 'local',
      replicaId: null,
    });
    await driver.close();
  });
});

describe('outbox', () => {
  it('walks groups in local order, whatever their ids, and moves them between states', async () => {
    const driver = await database();
    const first = ref('action', nextId());
    const second = ref('action', nextId());
    // Group ids are random: insertion order is the only local order.
    const one = await command(driver, [
      create(first, action('One')),
      create(second, action('Two')),
    ]);
    const third = ref('action', nextId());
    const two = await command(driver, [create(third, action('Three'))]);
    const groupOne = queuedGroup(one.sync);
    const groupTwo = queuedGroup(two.sync);
    const scanned = await inStore(driver, (sync) => sync.scanOutbox(owner, 0, 10));
    expect(scanned.map((item) => [item.mutationGroupId, item.sequence, item.entityId])).toEqual([
      [groupOne, 0, first.id],
      [groupOne, 1, second.id],
      [groupTwo, 0, third.id],
    ]);
    expect(scanned[0]?.document).toEqual(action('One'));
    const from = scanned[2]?.position ?? 0;
    expect(
      (await inStore(driver, (sync) => sync.scanOutbox(owner, from, 10))).map(
        (item) => item.entityId,
      ),
    ).toEqual([third.id]);

    const later = '2026-10-01T09:05:00.000Z' as Instant;
    await inStore(driver, async (sync) => {
      expect(
        await sync.setGroupState(
          owner,
          groupOne,
          { from: ['pending'], state: 'sending', attemptCount: 1 },
          now,
        ),
      ).toBe(2);
      // The `from` filter guards transitions.
      expect(
        await sync.setGroupState(owner, groupOne, { from: ['pending'], state: 'dead_letter' }, now),
      ).toBe(0);
      await sync.setGroupState(
        owner,
        groupTwo,
        { from: ['pending'], state: 'retry_wait', attemptCount: 2, nextAttemptAt: later },
        now,
      );
    });
    expect(await inStore(driver, (sync) => sync.outboxCounts(owner))).toEqual({
      byState: { sending: 2, retry_wait: 1 },
      unconfirmed: 3,
      nextAttemptAt: later,
    });
    expect(
      await inStore(driver, (sync) =>
        sync.setStateWhere(owner, { from: 'sending', state: 'pending', nextAttemptAt: now }, now),
      ),
    ).toBe(2);
    await inStore(driver, async (sync) => {
      const operation = (await sync.readGroup(owner, groupTwo))[0];
      if (operation === undefined) throw new Error('The group has an operation.');
      await sync.rewriteOperation(
        owner,
        operation.operationId,
        { document: action('Three, rebased'), baseServerRevision: 4, baseSnapshotHash: 'hash' },
        now,
      );
    });
    const rebased = await inStore(driver, (sync) => sync.operationsForEntity(owner, third));
    expect(rebased).toMatchObject([
      { document: action('Three, rebased'), baseServerRevision: 4, baseSnapshotHash: 'hash' },
    ]);
    await inStore(driver, (sync) =>
      sync.acknowledgeOperations(
        owner,
        scanned.slice(0, 2).map((item) => item.operationId),
        now,
      ),
    );
    await inStore(driver, (sync) =>
      sync.dropOperations(owner, [rebased[0]?.operationId as UUID], now),
    );
    expect(await driver.get('SELECT COUNT(*) AS count FROM sync_outbox;')).toEqual({ count: 0 });
    await driver.close();
  });
});

describe('bulk outbox compaction', () => {
  it('removes only requested operations of the owner and rolls back with the transaction', async () => {
    const driver = await database();
    await command(driver, [
      create(ref('action', nextId()), action('One')),
      create(ref('action', nextId()), action('Two')),
    ]);
    const rows = await inStore(driver, (sync) => sync.scanOutbox(owner, 0, 10));
    const first = rows[0]!.operationId;
    const second = rows[1]!.operationId;
    const other = '10000000-0000-4000-8000-0000000000bb' as OwnerId;
    await inStore(driver, (sync) => sync.acknowledgeOperations(other, [first], now));
    expect(await inStore(driver, (sync) => sync.scanOutbox(owner, 0, 10))).toHaveLength(2);
    await inStore(driver, (sync) =>
      sync.acknowledgeOperations(owner, [first, first, nextId()], now),
    );
    expect(
      (await inStore(driver, (sync) => sync.scanOutbox(owner, 0, 10))).map(
        (row) => row.operationId,
      ),
    ).toEqual([second]);
    await expect(
      new SqliteSyncStore(driver).runInTransaction(async (tx) => {
        await tx.sync.dropOperations(owner, [second], now);
        throw new Error('Injected rollback');
      }),
    ).rejects.toThrow('Injected rollback');
    expect(
      (await inStore(driver, (sync) => sync.scanOutbox(owner, 0, 10))).map(
        (row) => row.operationId,
      ),
    ).toEqual([second]);
    await inStore(driver, (sync) => sync.acknowledgeOperations(owner, [second], now));
    expect(await inStore(driver, (sync) => sync.scanOutbox(owner, 0, 10))).toEqual([]);
    await driver.close();
  });
});

describe('record sync metadata', () => {
  it('sets the server revision and base hash without touching the local revision', async () => {
    const driver = await database();
    const target = ref('action', nextId());
    await command(driver, [create(target, action('Tracked'))]);
    await inStore(driver, async (sync) => {
      await sync.setRecordSyncBase(target, 3, 'hash-3');
      await sync.writeBaseSnapshot(
        target,
        { serverRevision: 3, hash: 'hash-3', document: action('Tracked') },
        now,
      );
      await sync.writeBaseSnapshot(
        target,
        { serverRevision: 4, hash: 'hash-4', document: action('Again') },
        now,
      );
    });
    expect(
      await driver.get('SELECT local_revision, server_revision, base_snapshot_hash FROM actions;'),
    ).toEqual({ local_revision: 1, server_revision: 3, base_snapshot_hash: 'hash-3' });
    expect(await inStore(driver, (sync) => sync.readBaseSnapshot(target))).toEqual({
      serverRevision: 4,
      hash: 'hash-4',
      document: action('Again'),
    });
    await inStore(driver, (sync) => sync.deleteBaseSnapshot(target));
    expect(await inStore(driver, (sync) => sync.readBaseSnapshot(target))).toBeNull();
    await expect(
      inStore(driver, (sync) => sync.setRecordSyncBase(ref('action', nextId()), 1, null)),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    await driver.close();
  });

  it('finds Week commitments in their own table and unlinked join rows', async () => {
    const driver = await database();
    await driver.run(
      `INSERT INTO profiles (id, owner_id, planning_time_zone, week_start, time_format, created_at, updated_at)
       VALUES (?, ?, 'UTC', 'monday', '24_hour', ?, ?);`,
      [profileId, owner, now, now],
    );
    const actionRef = ref('action', nextId());
    await command(driver, [create(actionRef, action('Weekly'))]);
    const selection = ref('focus_selection', nextId());
    await command(driver, [
      create(selection, {
        kind: 'week_commitment',
        profileId,
        target: { kind: 'action', actionId: actionRef.id },
        periodStart: '2026-09-28',
        periodEnd: '2026-10-04',
        weekStart: 'monday',
        orderKey: 'a0',
      }),
    ]);
    await inStore(driver, (sync) => sync.setRecordSyncBase(selection, 2, 'week-hash'));
    expect(await driver.get('SELECT server_revision FROM week_selections;')).toEqual({
      server_revision: 2,
    });
    await driver.close();
  });
});

describe('deletion ledger', () => {
  it('records local and remote deletions, keeps the newest server revision, and forgets on restore', async () => {
    const driver = await database();
    const target = ref('action', nextId());
    const created = await command(driver, [create(target, action('Short-lived'))]);
    await inStore(driver, (sync) =>
      sync.acknowledgeOperations(
        owner,
        created.sync.queued ? (created.sync.operationIds as UUID[]) : [],
        now,
      ),
    );
    await command(
      driver,
      [
        {
          operation: 'delete',
          ref: target,
          expectedRevision: 1,
          baseServerRevision: 0,
          baseSnapshotHash: null,
          tombstone: createDeletionTombstone(target, 2, now),
        },
      ],
      [{ ref: target, revision: 1 }],
    );
    expect(await inStore(driver, (sync) => sync.readDeletion(target))).toEqual({
      serverRevision: 0,
      localRevision: 2,
    });
    await inStore(driver, (sync) => sync.setDeletionServerRevision(target, 5, now));
    expect((await inStore(driver, (sync) => sync.readDeletion(target)))?.serverRevision).toBe(5);
    const never = ref('note', nextId());
    await inStore(driver, async (sync) => {
      await sync.recordRemoteDeletion(never, 3, now);
      await sync.recordRemoteDeletion(never, 2, now);
    });
    expect(await inStore(driver, (sync) => sync.readDeletion(never))).toEqual({
      serverRevision: 3,
      localRevision: 1,
    });
    await inStore(driver, (sync) => sync.clearDeletion(never));
    expect(await inStore(driver, (sync) => sync.readDeletion(never))).toBeNull();
    await driver.close();
  });
});

describe('conflicts and cursor', () => {
  const conflict = (
    id: UUID,
    serverIds: UUID[],
    state: SyncStoredConflict['state'] = 'open',
  ): SyncStoredConflict => ({
    conflictId: id,
    entityType: 'action',
    entityId: id,
    kind: 'stale_base',
    state,
    baseServerRevision: 1,
    remoteServerRevision: 2,
    createdAt: now,
    payload: {
      v: 1,
      origin: 'this_device',
      base: { title: 'Base' },
      local: { deleted: false, document: { title: 'Local' } },
      remote: { deleted: false, document: { title: 'Remote' } },
      fields: ['title'],
      blockedGroups: [],
      serverConflictIds: serverIds,
      closure: state === 'resolved' ? 'pending' : 'none',
    },
  });

  it('stores candidates, finds them by server id, and updates them', async () => {
    const driver = await database();
    const open = nextId();
    const closing = nextId();
    const serverId = nextId();
    await inStore(driver, async (sync) => {
      await sync.insertConflict(owner, conflict(open, [serverId]), now);
      await sync.insertConflict(owner, conflict(closing, [nextId()], 'resolved'), now);
    });
    expect(
      (await inStore(driver, (sync) => sync.openConflicts(owner))).map((item) => item.conflictId),
    ).toEqual([open]);
    expect(
      (await inStore(driver, (sync) => sync.conflictsAwaitingClosure(owner))).map(
        (item) => item.conflictId,
      ),
    ).toEqual([closing]);
    expect(
      (await inStore(driver, (sync) => sync.conflictsForServerId(owner, serverId))).map(
        (item) => item.conflictId,
      ),
    ).toEqual([open]);
    await inStore(driver, (sync) =>
      sync.updateConflict(
        owner,
        open,
        { state: 'resolved', resolutionStrategy: 'keep_local', resolvedAt: now },
        now,
      ),
    );
    expect(await inStore(driver, (sync) => sync.readConflict(owner, open))).toMatchObject({
      state: 'resolved',
      resolutionStrategy: 'keep_local',
      resolvedAt: now,
      payload: { fields: ['title'] },
    });
    await driver.close();
  });

  it('stores the cursor and keeps the last success when a page is not the last', async () => {
    const driver = await database();
    expect(await inStore(driver, (sync) => sync.readCheckpoint(owner, replica))).toEqual({
      cursor: null,
      lastSuccessAt: null,
    });
    await inStore(driver, (sync) =>
      sync.writeCheckpoint(owner, replica, { cursor: '10', lastSuccessAt: now }, now),
    );
    await inStore(driver, (sync) => sync.writeCheckpoint(owner, replica, { cursor: '20' }, now));
    expect(await inStore(driver, (sync) => sync.readCheckpoint(owner, replica))).toEqual({
      cursor: '20',
      lastSuccessAt: now,
    });
    await driver.close();
  });
});

describe('records from another replica', () => {
  it('creates the account Profile with setup complete and counts first-upload progress', async () => {
    const driver = await database();
    await inStore(driver, (sync) =>
      sync.createProfileFromRemote(
        ref('profile', profileId),
        { planningTimeZone: 'Asia/Tashkent', weekStart: 'monday', timeFormat: '24_hour' },
        now,
      ),
    );
    const onboarding = await new SqliteOnboardingPersistence(driver).load();
    expect(onboarding).toMatchObject({ status: 'completed', profileId });
    const target = ref('action', nextId());
    await command(driver, [create(target, action('Uploaded'))]);
    await command(driver, [create(ref('action', nextId()), action('Waiting'))]);
    await inStore(driver, (sync) => sync.setRecordSyncBase(target, 1, 'hash'));
    expect(await inStore(driver, (sync) => sync.uploadProgress(owner))).toEqual({
      uploaded: 1,
      total: 3,
    });
    await driver.close();
  });

  it('validates documents through the record codecs', async () => {
    const driver = await database();
    await inStore(driver, (sync) => {
      expect(sync.validateDocument('action', action('Valid'))).toBe(true);
      expect(sync.validateDocument('action', action(''))).toBe(false);
      expect(sync.validateDocument('action', { ...action('x'), unknown: true })).toBe(false);
      expect(
        sync.validateDocument('project', { title: 'Idea', orderKey: 'a0', state: 'idea' }),
      ).toBe(true);
      expect(sync.validateDocument('project', { title: 'No order key', state: 'idea' })).toBe(
        false,
      );
      return Promise.resolve();
    });
    await driver.close();
  });
});

describe('references before commit', () => {
  it('reports a written record whose parent is missing and a deleted record still referred to', async () => {
    const driver = await database();
    const project = ref('project', nextId());
    await command(driver, [create(project, { title: 'Parent', orderKey: 'a0', state: 'idea' })]);
    const child = ref('action', nextId());
    await command(driver, [create(child, action('Child', { projectId: project.id }))]);
    // Both creates reached the server (a pending operation would hold the delete below).
    await driver.run('DELETE FROM sync_outbox;');
    const missing = nextId();
    const store = new SqliteSyncStore(driver);
    // Each check runs inside a transaction that is then rolled back (thrown out) on purpose.
    const dangling = await store
      .runInTransaction(async (unitOfWork) => {
        await unitOfWork.records.apply(
          create(ref('action', nextId()), action('Orphan', { projectId: missing })),
          { ownerId: owner, actor: 'sync', commandId: nextId(), now },
        );
        const found = await unitOfWork.sync.danglingReferences({
          written: ['action'],
          deleted: [],
        });
        throw new Found(found);
      })
      .catch((error: unknown) => (error instanceof Found ? error.value : null));
    expect(dangling).toEqual([
      {
        child: { entityType: 'action', entityId: expect.any(String) as string },
        parent: { entityType: 'project', entityId: missing },
      },
    ]);
    const referrers = await store
      .runInTransaction(async (unitOfWork) => {
        await driverDelete(unitOfWork, project);
        const found = await unitOfWork.sync.danglingReferences({
          written: [],
          deleted: ['project'],
        });
        throw new Found(found);
      })
      .catch((error: unknown) => (error instanceof Found ? error.value : null));
    expect(referrers).toEqual([
      {
        child: { entityType: 'action', entityId: child.id },
        parent: { entityType: 'project', entityId: project.id },
      },
    ]);
    // Nothing was committed: the rolled-back transactions left the store whole.
    expect(await driver.all('PRAGMA foreign_key_check;')).toEqual([]);
    await driver.close();
  });
});

describe('rebasing and refusals', () => {
  const update = (target: EntityRef, title: string): CanonicalMutation => ({
    operation: 'update',
    ref: target,
    expectedRevision: 1,
    baseServerRevision: 1,
    baseSnapshotHash: null,
    document: action(title),
  });

  it('rebases every queued operation on acknowledged records in one statement', async () => {
    const driver = await database();
    const first = ref('action', nextId());
    const second = ref('action', nextId());
    await command(driver, [create(first, action('First')), create(second, action('Second'))]);
    await driver.run('DELETE FROM sync_outbox;');
    await driver.run('UPDATE actions SET server_revision = 1;');
    await command(driver, [update(first, 'First, edited')], [{ ref: first, revision: 1 }]);
    await command(driver, [update(second, 'Second, edited')], [{ ref: second, revision: 1 }]);
    const changed = await inStore(driver, (sync) =>
      sync.rebaseQueuedOperations(
        owner,
        [
          { entityType: 'action', entityId: first.id, serverRevision: 2, hash: 'first-hash' },
          { entityType: 'note', entityId: second.id, serverRevision: 9, hash: null },
        ],
        now,
      ),
    );
    expect(changed).toBe(1);
    expect(
      await driver.all(
        'SELECT entity_id, base_server_revision, base_snapshot_hash FROM sync_outbox ORDER BY rowid;',
      ),
    ).toEqual([
      { entity_id: first.id, base_server_revision: 2, base_snapshot_hash: 'first-hash' },
      { entity_id: second.id, base_server_revision: 1, base_snapshot_hash: null },
    ]);
    await driver.close();
  });

  it('tells a record the plan refuses from a failing store', async () => {
    const driver = await database();
    const errors: unknown[] = [];
    await driver
      .run(
        `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
         VALUES (?, 'local', ?, ?);`,
        [owner, now, now],
      )
      .catch((error: unknown) => errors.push(error));
    errors.push(
      new DataAdapterError('invalid_canonical_document'),
      new DataAdapterError('write_conflict'),
      new Error('day focus is limited to three active selections'),
      new Error('UNIQUE constraint failed: review_checkpoints.owner_id'),
      new DataAdapterError('capability_expired'),
      new Error('disk I/O error'),
      'not an error',
    );
    const verdicts = await new SqliteSyncStore(driver).runInTransaction((unitOfWork) =>
      Promise.resolve(errors.map((error) => unitOfWork.sync.isRecordRefusal(error))),
    );
    expect(verdicts).toEqual([true, true, true, true, true, false, false, false]);
    await driver.close();
  });
});

class Found extends Error {
  constructor(readonly value: unknown) {
    super('found');
  }
}

async function driverDelete(
  unitOfWork: Parameters<Parameters<SqliteSyncStore['runInTransaction']>[0]>[0],
  target: EntityRef,
): Promise<void> {
  const record = await unitOfWork.records.read(target);
  if (record === null) throw new Error('The record exists.');
  await unitOfWork.records.apply(
    {
      operation: 'delete',
      ref: target,
      expectedRevision: record.localRevision,
      baseServerRevision: record.serverRevision,
      baseSnapshotHash: record.baseSnapshotHash,
      tombstone: createDeletionTombstone(target, record.localRevision + 1, now),
    },
    { ownerId: owner, actor: 'sync', commandId: nextId(), now },
  );
}

describe('query plans', () => {
  it('walk the outbox by rowid and read history through unique indexes', async () => {
    const driver = await database();
    expect(await plan(driver, syncSql.scanOutbox, [0, owner, 10])).toMatch(
      /USING INTEGER PRIMARY KEY \(rowid>\?\)/u,
    );
    expect(await plan(driver, syncSql.scanOutbox, [0, owner, 10])).not.toMatch(/TEMP B-TREE/u);
    expect(await plan(driver, syncSql.readGroup, [owner, nextId()])).toMatch(
      /sqlite_autoindex_sync_outbox_\d/u,
    );
    expect(await plan(driver, syncSql.readBaseSnapshot, [owner, 'action', nextId()])).toMatch(
      /sqlite_autoindex_base_snapshots_\d/u,
    );
    expect(await plan(driver, syncSql.readDeletion, [owner, 'action', nextId()])).toMatch(
      /sqlite_autoindex_deletion_ledger_\d/u,
    );
    expect(await plan(driver, syncSql.readCheckpoint, [owner, replica])).toMatch(
      /sqlite_autoindex_sync_checkpoints_\d|idx_sync_checkpoints_cursor/u,
    );
    expect(await plan(driver, syncSql.openConflicts, [owner])).toMatch(/idx_sync_conflicts_open/u);
    expect(await plan(driver, syncSql.conflictsAwaitingClosure, [owner])).toMatch(
      /idx_sync_conflicts_open/u,
    );
    expect(await plan(driver, syncSql.readConflict, [owner, nextId()])).toMatch(
      /sqlite_autoindex_sync_conflicts_\d/u,
    );
    await driver.close();
  });
});
