/**
 * Atomicity with injected failures over real SQLite:
 * - /: a command's canonical rows, minimized events, receipt, and outbox
 * group commit together, locally, without any network; a failure anywhere rolls all back.
 * -: an acknowledgment that fails part way leaves the group `sending`; a restart
 * returns it to `pending` with the same ids and the next answer is recorded once.
 * -: a pulled page that fails before its commit leaves no row and no cursor behind;
 * replaying it applies it once.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalJson,
  createSerialQueue,
  createSyncApplication,
  executeCommand,
  type ApplicationDependencies,
  type CanonicalMutation,
  type SyncApplication,
} from '@yelaxis/application';
import {
  createEntityRef,
  ok,
  type EntityRef,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { createSqliteApplicationAdapters } from '../application/sqlite-adapters';
import type {
  SqliteDriver,
  SqliteMigrationTransaction,
  SqliteParameter,
  SqliteTransaction,
} from '../sqlite/driver';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { SqliteSyncStore } from './sqlite-sync-store';

const now = '2026-10-01T09:00:00.000Z' as Instant;
const owner = '10000000-0000-4000-8000-0000000000bb' as OwnerId;
const replica = '20000000-0000-4000-8000-0000000000bb' as UUID;
const directories: string[] = [];
let sequence = 0;
const nextId = (): UUID => {
  sequence += 1;
  return `50000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}` as UUID;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A driver whose transactions fail at the first statement matching `failOn`. */
class FaultyDriver implements SqliteDriver {
  failOn: RegExp | null = null;

  constructor(private readonly inner: NodeSqliteDriver) {}

  run(sql: string, parameters?: readonly SqliteParameter[]) {
    return this.inner.run(sql, parameters);
  }

  get<Row extends object>(sql: string, parameters?: readonly SqliteParameter[]) {
    return this.inner.get<Row>(sql, parameters);
  }

  all<Row extends object>(sql: string, parameters?: readonly SqliteParameter[]) {
    return this.inner.all<Row>(sql, parameters);
  }

  executeScript(sql: string) {
    return this.inner.executeScript(sql);
  }

  transaction<Result>(operation: (transaction: SqliteTransaction) => Promise<Result>) {
    return this.inner.transaction((transaction) => operation(this.#wrap(transaction)));
  }

  migrationTransaction<Result>(
    operation: (transaction: SqliteMigrationTransaction) => Promise<Result>,
  ) {
    return this.inner.migrationTransaction(operation);
  }

  close() {
    return this.inner.close();
  }

  #wrap(transaction: SqliteTransaction): SqliteTransaction {
    const check = (sql: string): void => {
      if (this.failOn?.test(sql) === true) throw new Error('Injected storage failure');
    };
    return {
      run: (sql, parameters) => {
        check(sql);
        return transaction.run(sql, parameters);
      },
      get: <Row extends object>(sql: string, parameters?: readonly SqliteParameter[]) => {
        check(sql);
        return transaction.get<Row>(sql, parameters);
      },
      all: <Row extends object>(sql: string, parameters?: readonly SqliteParameter[]) => {
        check(sql);
        return transaction.all<Row>(sql, parameters);
      },
    };
  }
}

interface Fixture {
  readonly driver: FaultyDriver;
  readonly raw: NodeSqliteDriver;
  readonly sync: SyncApplication;
  readonly dependencies: ApplicationDependencies;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-sync-atomic-'));
  directories.push(directory);
  const raw = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(raw, schemaMigrations, () => now);
  await raw.run(
    `INSERT INTO planning_identities (
       id, identity_kind, account_subject_id, replica_id, created_at, updated_at
     ) VALUES (?, 'account', 'subject', ?, ?, ?);`,
    [owner, replica, now, now],
  );
  const driver = new FaultyDriver(raw);
  const clock = { now: () => now };
  const ids = { next: nextId };
  const queue = createSerialQueue();
  return {
    driver,
    raw,
    sync: createSyncApplication(
      {
        store: new SqliteSyncStore(driver),
        clock,
        ids,
        hasher: {
          hash: (document) =>
            Promise.resolve(createHash('sha256').update(canonicalJson(document)).digest('hex')),
        },
        random: () => 0.5,
      },
      { queue },
    ),
    dependencies: {
      ...createSqliteApplicationAdapters(driver),
      clock,
      ids,
      projections: { notifyCommitted: () => undefined },
    },
  };
}

const action = (title: string) => ({
  title,
  captureOrigin: 'global_capture',
  orderKey: 'a0',
  state: 'inbox',
});

function createCommand(target: EntityRef, title: string): CanonicalMutation {
  return {
    operation: 'create',
    ref: target,
    expectedRevision: null,
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document: action(title),
  };
}

async function capture(state: Fixture, target: EntityRef, title: string) {
  return executeCommand(
    state.dependencies,
    { commandId: nextId(), ownerId: owner, actor: 'user', expectedRevisions: [], input: {} },
    ({ context }) =>
      ok({
        value: [createCommand(target, title)],
        events: [
          {
            aggregate: target,
            eventType: 'action.created',
            version: 1 as const,
            actor: context.actor,
            commandId: context.commandId,
            occurredAt: context.now,
            payload: { operation: 'create' },
          },
        ],
        touched: [target],
      }),
  );
}

async function counts(raw: NodeSqliteDriver) {
  const count = async (table: string) =>
    (await raw.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table};`))?.count ?? 0;
  return {
    actions: await count('actions'),
    events: await count('domain_events'),
    receipts: await count('command_receipts'),
    outbox: await count('sync_outbox'),
    snapshots: await count('base_snapshots'),
    checkpoints: await count('sync_checkpoints'),
  };
}

describe('command and outbox', () => {
  it('commit together locally, and roll back together on any failure', async () => {
    const state = await fixture();
    for (const failOn of [
      /INSERT INTO sync_outbox/u,
      /INSERT INTO command_receipts/u,
      /INSERT INTO domain_events/u,
    ]) {
      state.driver.failOn = failOn;
      const failed = await capture(
        state,
        createEntityRef('action', nextId(), owner),
        'Rolled back',
      );
      expect(failed).toEqual({ ok: false, error: { code: 'transaction_failed' } });
      expect(await counts(state.raw)).toMatchObject({
        actions: 0,
        events: 0,
        receipts: 0,
        outbox: 0,
      });
    }
    state.driver.failOn = null;
    const target = createEntityRef('action', nextId(), owner);
    const receipt = await capture(state, target, 'Committed');
    expect(receipt).toMatchObject({ ok: true, value: { sync: { queued: true } } });
    expect(await counts(state.raw)).toMatchObject({
      actions: 1,
      events: 1,
      receipts: 1,
      outbox: 1,
    });
    expect(await state.sync.facts()).toMatchObject({ pending: 1, sending: 0 });
    await state.raw.close();
  });
});

describe('acknowledgment', () => {
  it('is all or nothing, and a restart resends the same group once', async () => {
    const state = await fixture();
    const target = createEntityRef('action', nextId(), owner);
    await capture(state, target, 'Sent');
    const group = await state.sync.claimNextGroup();
    if (group === null) throw new Error('A group is ready.');
    const operation = group.operations[0];
    if (operation === undefined) throw new Error('The group has an operation.');
    const accepted = {
      kind: 'accepted' as const,
      cursor: '1',
      acknowledgments: [
        {
          operationId: operation.operationId,
          entityType: 'action' as const,
          entityId: target.id,
          serverRevision: 1,
        },
      ],
    };
    // The app stops while recording the answer (after the base snapshot, before compaction).
    state.driver.failOn = /DELETE FROM sync_outbox/u;
    await expect(state.sync.recordPushOutcome(group.mutationGroupId, accepted)).rejects.toThrow();
    expect(await state.raw.get('SELECT server_revision, base_snapshot_hash FROM actions;')).toEqual(
      {
        server_revision: 0,
        base_snapshot_hash: null,
      },
    );
    expect(await counts(state.raw)).toMatchObject({ snapshots: 0, outbox: 1 });
    expect(await state.raw.get('SELECT state, attempt_count FROM sync_outbox;')).toEqual({
      state: 'sending',
      attempt_count: 1,
    });
    // Restart: stranded `sending` returns to `pending`; the same ids go out again.
    state.driver.failOn = null;
    expect(await state.sync.recoverStranded()).toBe(1);
    const again = await state.sync.claimNextGroup();
    expect(again?.mutationGroupId).toBe(group.mutationGroupId);
    expect(again?.operations[0]?.operationId).toBe(operation.operationId);
    expect(await state.sync.recordPushOutcome(group.mutationGroupId, accepted)).toEqual({
      status: 'acknowledged',
    });
    expect(await state.raw.get('SELECT server_revision FROM actions;')).toEqual({
      server_revision: 1,
    });
    expect(await counts(state.raw)).toMatchObject({ snapshots: 1, outbox: 0 });
    // A late duplicate answer changes nothing.
    expect(await state.sync.recordPushOutcome(group.mutationGroupId, accepted)).toEqual({
      status: 'stale',
    });
    await state.raw.close();
  });
});

describe('pulled pages', () => {
  it('never leave a row or a cursor behind when the page fails before commit', async () => {
    const state = await fixture();
    const target = createEntityRef('action', nextId(), owner);
    const page = {
      changes: [
        {
          cursor: '5',
          entityType: 'action' as const,
          entityId: target.id,
          serverRevision: 1,
          deleted: false,
          document: action('From another device'),
        },
      ],
      nextCursor: '5',
      hasMore: false,
    };
    for (const failOn of [
      /INSERT INTO sync_checkpoints/u,
      /INSERT INTO base_snapshots/u,
      /INSERT INTO domain_events/u,
    ]) {
      state.driver.failOn = failOn;
      expect(await state.sync.applyPulledPages([page])).toEqual({ status: 'failed' });
      expect(await counts(state.raw)).toMatchObject({
        actions: 0,
        events: 0,
        snapshots: 0,
        checkpoints: 0,
      });
      expect((await state.sync.facts()).cursor).toBeNull();
    }
    state.driver.failOn = null;
    expect(await state.sync.applyPulledPages([page])).toMatchObject({
      status: 'applied',
      applied: 1,
    });
    expect(await state.sync.applyPulledPages([page])).toMatchObject({
      status: 'applied',
      unchanged: 1,
    });
    expect(await counts(state.raw)).toMatchObject({
      actions: 1,
      events: 1,
      snapshots: 1,
      checkpoints: 1,
    });
    expect((await state.sync.facts()).cursor).toBe('5');
    expect(await state.raw.get('SELECT local_revision, server_revision FROM actions;')).toEqual({
      local_revision: 1,
      server_revision: 1,
    });
    await state.raw.close();
  });
});

describe('soft-deleted rows', () => {
  it('are never written by a pulled change or tombstone, and the cursor still advances', async () => {
    const state = await fixture();
    const target = createEntityRef('action', nextId(), owner);
    await state.raw.run(
      `INSERT INTO actions (
         id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at,
         client_updated_at, deleted_at
       ) VALUES (?, ?, 'Soft deleted here', 'inbox', 'global_capture', 'a0', ?, ?, ?, ?);`,
      [target.id, owner, now, now, now, now],
    );
    const row = () =>
      state.raw.get('SELECT title, deleted_at, local_revision, server_revision FROM actions;');
    const before = await row();
    const update = {
      changes: [
        {
          cursor: '7',
          entityType: 'action' as const,
          entityId: target.id,
          serverRevision: 2,
          deleted: false,
          document: action('Edited on another device'),
        },
      ],
      nextCursor: '7',
      hasMore: false,
    };
    const updated = await state.sync.applyPulledPages([update]);
    expect(updated).toMatchObject({ status: 'applied', cursor: '7' });
    expect(await row()).toEqual(before);
    const tombstone = {
      changes: [
        {
          cursor: '8',
          entityType: 'action' as const,
          entityId: target.id,
          serverRevision: 3,
          deleted: true,
          document: null,
        },
      ],
      nextCursor: '8',
      hasMore: false,
    };
    expect(await state.sync.applyPulledPages([tombstone])).toMatchObject({
      status: 'applied',
      cursor: '8',
    });
    expect(await row()).toEqual(before);
    expect((await state.sync.facts()).cursor).toBe('8');
    await state.raw.close();
  });
});
