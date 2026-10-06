/**
 * SyncApplication use cases over an in-memory store (no SQLite, no network): facts, claiming in
 * local order, every push outcome, pulled pages, conflicts and their resolution, server candidates,
 * and closures.
 */
import type { EntityRef, Instant, OwnerId, UUID } from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import { createSyncApplication } from './sync-application';
import type {
  SyncApplication,
  SyncDocument,
  SyncOutgoingOperation,
  SyncPulledPage,
} from './sync-contracts';
import { canonicalJson } from './sync-merge';
import type { SyncIdentity, SyncStoredConflict } from './sync-ports';
import { memoryRef, MemorySyncStore } from './testing/sync-memory-store';

const owner = '0a000000-0000-4000-8000-000000000001' as OwnerId;
const replicaId = '0b000000-0000-4000-8000-000000000001' as UUID;
const account: SyncIdentity = {
  ownerId: owner,
  kind: 'account',
  replicaId,
  linked: true,
  deletion: 'none',
};
const id = (n: number) => `c0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as UUID;
const hash = (document: SyncDocument) => `h:${canonicalJson(document)}`;
const action = (title: string, extra: Record<string, unknown> = {}): SyncDocument => ({
  title,
  captureOrigin: 'global_capture',
  orderKey: 'a0',
  state: 'inbox',
  ...extra,
});

let store: MemorySyncStore;
let app: SyncApplication;
let now: number;
let counter: number;

function open(identity: SyncIdentity | null = account): void {
  store = new MemorySyncStore(identity);
  now = Date.parse('2026-10-01T09:00:00.000Z');
  counter = 10_000;
  app = createSyncApplication({
    store,
    clock: { now: () => new Date(now).toISOString() as Instant },
    ids: {
      next: () => {
        counter += 1;
        return id(counter);
      },
    },
    hasher: { hash: (document) => Promise.resolve(hash(document)) },
    random: () => 0.5,
  });
}

const ref = (type: Parameters<typeof memoryRef>[0], n: number): EntityRef =>
  memoryRef(type, id(n), owner);

/** A record converged at `revision` (row, base snapshot) like after an earlier pull. */
function converged(target: EntityRef, document: SyncDocument, revision = 1): void {
  store.seed({ ref: target, serverRevision: revision, baseSnapshotHash: hash(document), document });
  store.state.snapshots.set(`${target.type}:${target.id}`, {
    serverRevision: revision,
    hash: hash(document),
    document,
  });
}

/** A local edit: the row changes and its group queues (like a command). */
function edit(target: EntityRef, document: SyncDocument, group: number, operation: number): void {
  const current = store.record(target.type, target.id);
  if (current === undefined) throw new Error('The record exists.');
  store.seed({ ...current, localRevision: current.localRevision + 1, document });
  store.queue(id(group), [
    {
      operationId: id(operation),
      ref: target,
      kind: 'update',
      document,
      baseServerRevision: current.serverRevision,
      baseSnapshotHash: current.baseSnapshotHash,
    },
  ]);
}

/** A group sent once without an answer, waiting for its retry at `retryAt`. */
function sentOnce(group: number, retryAt: number): void {
  store.state.outbox = store.state.outbox.map((operation) =>
    operation.mutationGroupId === id(group)
      ? {
          ...operation,
          state: 'retry_wait',
          attemptCount: 1,
          nextAttemptAt: new Date(retryAt).toISOString() as Instant,
        }
      : operation,
  );
}

/** An open conflict of this device on a record, holding the given groups. */
function openConflictOn(
  conflictId: number,
  target: EntityRef,
  base: SyncDocument,
  local: SyncDocument,
  remote: SyncDocument,
  groups: readonly number[],
): void {
  const conflict: SyncStoredConflict = {
    conflictId: id(conflictId),
    entityType: target.type,
    entityId: target.id,
    kind: 'stale_base',
    state: 'open',
    baseServerRevision: 1,
    remoteServerRevision: 2,
    createdAt: '2026-10-01T09:00:00.000Z' as Instant,
    payload: {
      v: 1,
      origin: 'this_device',
      base,
      local: { deleted: false, document: local },
      remote: { deleted: false, document: remote },
      fields: ['title'],
      blockedGroups: groups.map((group) => id(group)),
      serverConflictIds: [],
      closure: 'none',
    },
  };
  store.state.conflicts.set(id(conflictId), conflict);
  const held = new Set<string>(conflict.payload.blockedGroups);
  store.state.outbox = store.state.outbox.map((operation) =>
    held.has(operation.mutationGroupId) ? { ...operation, state: 'blocked_conflict' } : operation,
  );
}

/** Push every ready group in turn, the server accepting each; returns what was sent. */
async function pushAll(): Promise<SyncOutgoingOperation[]> {
  const sent: SyncOutgoingOperation[] = [];
  for (let round = 0; round < 50; round += 1) {
    const group = await app.claimNextGroup();
    if (group === null) return sent;
    sent.push(...group.operations);
    await app.recordPushOutcome(group.mutationGroupId, {
      kind: 'accepted',
      cursor: '1',
      acknowledgments: group.operations.map((operation) => ({
        operationId: operation.operationId,
        entityType: operation.entityType,
        entityId: operation.entityId,
        serverRevision: operation.baseServerRevision + 1,
      })),
    });
  }
  throw new Error('More groups than expected.');
}

const page = (
  changes: SyncPulledPage['changes'],
  nextCursor: string,
  hasMore = false,
): SyncPulledPage => ({ changes, nextCursor, hasMore });

const change = (
  target: EntityRef,
  revision: number,
  document: SyncDocument | null,
  cursor = '1',
) => ({
  cursor,
  entityType: target.type,
  entityId: target.id,
  serverRevision: revision,
  deleted: document === null,
  document,
});

beforeEach(() => {
  open();
});

describe('facts', () => {
  it('are empty without an identity and local-only for a local identity', async () => {
    open(null);
    expect(await app.facts()).toMatchObject({ link: 'none', pending: 0, cursor: null });
    open({ ...account, kind: 'local', replicaId: null });
    expect(await app.facts()).toMatchObject({ link: 'local', ownerId: owner });
  });

  it('count queue states, conflicts, the cursor, and first-upload progress while linking', async () => {
    open({ ...account, linked: false });
    converged(ref('action', 1), action('Uploaded'));
    store.seed({
      ref: ref('action', 2),
      serverRevision: 0,
      baseSnapshotHash: null,
      document: action('New'),
    });
    store.queue(id(50), [
      { operationId: id(51), ref: ref('action', 2), kind: 'create', document: action('New') },
    ]);
    expect(await app.facts()).toMatchObject({
      link: 'linking',
      pending: 1,
      unconfirmed: 0,
      firstUpload: { uploaded: 1, total: 2 },
      cursor: null,
    });
  });
});

describe('claiming groups', () => {
  it('claims in local order, marks sending, and pushes updates from the record’s base', async () => {
    converged(ref('action', 1), action('One'), 4);
    edit(ref('action', 1), action('One, edited'), 50, 51);
    store.seed({
      ref: ref('action', 2),
      serverRevision: 0,
      baseSnapshotHash: null,
      document: action('Two'),
    });
    store.queue(id(60), [
      { operationId: id(61), ref: ref('action', 2), kind: 'create', document: action('Two') },
    ]);
    const first = await app.claimNextGroup();
    expect(first).toEqual({
      mutationGroupId: id(50),
      replicaId,
      attempt: 1,
      operations: [
        {
          operationId: id(51),
          sequence: 0,
          entityType: 'action',
          entityId: id(1),
          kind: 'update',
          baseServerRevision: 4,
          baseSnapshotHash: hash(action('One')),
          document: action('One, edited'),
        },
      ],
    });
    expect(store.operations().map((operation) => operation.state)).toEqual(['sending', 'pending']);
    // The second group touches another record, so it is ready too.
    expect((await app.claimNextGroup())?.mutationGroupId).toBe(id(60));
    expect(await app.claimNextGroup()).toBeNull();
  });

  it('holds a group behind an earlier one on the same record, and behind an open conflict', async () => {
    converged(ref('action', 1), action('One'));
    edit(ref('action', 1), action('Edit 1'), 50, 51);
    edit(ref('action', 1), action('Edit 2'), 60, 61);
    store.state.outbox = store.state.outbox.map((operation) =>
      operation.mutationGroupId === id(50)
        ? {
            ...operation,
            state: 'retry_wait',
            attemptCount: 1,
            nextAttemptAt: '2026-10-01T10:00:00.000Z' as Instant,
          }
        : operation,
    );
    expect(await app.claimNextGroup()).toBeNull();
    now = Date.parse('2026-10-01T10:00:00.000Z');
    expect((await app.claimNextGroup())?.mutationGroupId).toBe(id(50));
  });

  it('marks a group on a record with an open conflict as held, and claims nothing while deleting', async () => {
    converged(ref('action', 1), action('One'));
    edit(ref('action', 1), action('Mine'), 50, 51);
    store.state.conflicts.set(id(70), {
      conflictId: id(70),
      entityType: 'action',
      entityId: id(1),
      kind: 'merge_conflict',
      state: 'open',
      baseServerRevision: 1,
      remoteServerRevision: 2,
      createdAt: '2026-10-01T09:00:00.000Z' as Instant,
      payload: {
        v: 1,
        origin: 'this_device',
        base: action('One'),
        local: { deleted: false, document: action('Mine') },
        remote: { deleted: false, document: action('Theirs') },
        fields: ['title'],
        blockedGroups: [],
        serverConflictIds: [],
        closure: 'none',
      },
    });
    expect(await app.claimNextGroup()).toBeNull();
    expect(store.operations()[0]?.state).toBe('blocked_conflict');
    open({ ...account, deletion: 'pending' });
    store.queue(id(80), [
      { operationId: id(81), ref: ref('action', 9), kind: 'create', document: action('x') },
    ]);
    expect(await app.claimNextGroup()).toBeNull();
  });

  it('never lets a later change overtake an earlier waiting group that needs its record', async () => {
    // Moved into a Project (sent once, waiting for its retry), moved out again, then the Project
    // deleted: the delete must not reach the server before the move that needs the Project.
    converged(ref('action', 2), action('Call'));
    store.state.ledger.set(`project:${id(1)}`, { serverRevision: 1, localRevision: 2 });
    const base = { baseServerRevision: 1, baseSnapshotHash: hash(action('Call')) };
    store.queue(id(50), [
      {
        operationId: id(51),
        ref: ref('action', 2),
        kind: 'update',
        document: action('Call', { projectId: id(1) }),
        ...base,
      },
    ]);
    sentOnce(50, now + 60_000);
    store.queue(id(60), [
      {
        operationId: id(61),
        ref: ref('action', 2),
        kind: 'update',
        document: action('Call'),
        ...base,
      },
    ]);
    store.queue(id(70), [
      {
        operationId: id(71),
        ref: ref('project', 1),
        kind: 'delete',
        document: null,
        baseServerRevision: 1,
        baseSnapshotHash: 'h:project',
      },
    ]);
    expect(await app.claimNextGroup()).toBeNull();
    now += 60_000;
    expect((await pushAll()).map((operation) => operation.operationId)).toEqual([
      id(51),
      id(61),
      id(71),
    ]);
  });

  it('sends a group sent before again with the same ids, even while a record it needs has a conflict', async () => {
    const project = { title: 'Plan', orderKey: 'a0', state: 'active' };
    converged(ref('project', 1), project);
    const created = action('Call', { projectId: id(1) });
    store.seed({
      ref: ref('action', 2),
      serverRevision: 0,
      baseSnapshotHash: null,
      document: created,
    });
    store.queue(id(50), [
      { operationId: id(51), ref: ref('action', 2), kind: 'create', document: created },
    ]);
    sentOnce(50, now + 5_000);
    edit(ref('project', 1), { ...project, title: 'Mine' }, 60, 61);
    openConflictOn(
      80,
      ref('project', 1),
      project,
      { ...project, title: 'Mine' },
      { ...project, title: 'Theirs' },
      [60],
    );
    // A group never sent that needs the conflicting Project keeps waiting.
    const other = action('Other', { projectId: id(1) });
    store.seed({
      ref: ref('action', 3),
      serverRevision: 0,
      baseSnapshotHash: null,
      document: other,
    });
    store.queue(id(70), [
      { operationId: id(71), ref: ref('action', 3), kind: 'create', document: other },
    ]);
    expect(await app.claimNextGroup()).toBeNull();
    now += 5_000;
    const again = await app.claimNextGroup();
    expect(again).toMatchObject({
      mutationGroupId: id(50),
      attempt: 2,
      operations: [{ operationId: id(51), kind: 'create', document: created }],
    });
    if (again === null) throw new Error('The sent group is claimed again.');
    await app.recordPushOutcome(id(50), {
      kind: 'accepted',
      cursor: '3',
      acknowledgments: [
        { operationId: id(51), entityType: 'action', entityId: id(2), serverRevision: 1 },
      ],
    });
    expect((await app.facts()).unconfirmed).toBe(0);
    expect(await app.claimNextGroup()).toBeNull();
    expect(store.operations().map((operation) => [operation.operationId, operation.state])).toEqual(
      [
        [id(61), 'blocked_conflict'],
        [id(71), 'pending'],
      ],
    );
  });

  it('holds back only what a rejected group owns: later changes to its records and to what needs them', async () => {
    const project = { title: 'Garden', orderKey: 'a0', state: 'active' };
    converged(ref('project', 1), project);
    converged(ref('action', 2), action('Call'));
    converged(ref('action', 5), action('Other'));
    edit(ref('action', 2), action('Call', { projectId: id(1) }), 50, 51);
    expect((await app.claimNextGroup())?.mutationGroupId).toBe(id(50));
    expect(
      await app.recordPushOutcome(id(50), { kind: 'rejected', code: 'missing_reference' }),
    ).toEqual({ status: 'dead_letter' });
    edit(ref('action', 2), action('Call, renamed', { projectId: id(1) }), 60, 61);
    store.seed({
      ref: ref('reminder', 7),
      serverRevision: 0,
      baseSnapshotHash: null,
      document: { actionId: id(2) },
    });
    store.queue(id(70), [
      {
        operationId: id(71),
        ref: ref('reminder', 7),
        kind: 'create',
        document: { actionId: id(2) },
      },
    ]);
    // A record the rejected change only refers to, and an unrelated record, continue.
    edit(ref('project', 1), { ...project, title: 'Garden, renamed' }, 80, 81);
    edit(ref('action', 5), action('Other, renamed'), 90, 91);
    expect((await pushAll()).map((operation) => operation.operationId)).toEqual([id(81), id(91)]);
    expect(store.operations().map((operation) => [operation.operationId, operation.state])).toEqual(
      [
        [id(51), 'dead_letter'],
        [id(61), 'pending'],
        [id(71), 'pending'],
      ],
    );
    // A person retries: the same ids, in local order.
    expect(await app.retryRejected()).toBe(1);
    expect((await pushAll()).map((operation) => operation.operationId)).toEqual([
      id(51),
      id(61),
      id(71),
    ]);
  });
});

describe('push outcomes', () => {
  async function claimed(document = action('Edited')) {
    converged(ref('action', 1), action('Base'));
    edit(ref('action', 1), document, 50, 51);
    const group = await app.claimNextGroup();
    if (group === null) throw new Error('A group is ready.');
    return group;
  }

  it('acknowledges: new revision and base snapshot, later queued operations rebased, rows removed', async () => {
    const group = await claimed();
    edit(ref('action', 1), action('Edited again'), 60, 61);
    expect(
      await app.recordPushOutcome(group.mutationGroupId, {
        kind: 'accepted',
        cursor: '9',
        acknowledgments: [
          { operationId: id(51), entityType: 'action', entityId: id(1), serverRevision: 2 },
        ],
      }),
    ).toEqual({ status: 'acknowledged' });
    expect(store.record('action', id(1))).toMatchObject({
      serverRevision: 2,
      baseSnapshotHash: hash(action('Edited')),
      document: action('Edited again'),
    });
    expect(store.state.snapshots.get(`action:${id(1)}`)).toEqual({
      serverRevision: 2,
      hash: hash(action('Edited')),
      document: action('Edited'),
    });
    expect(store.operations()).toMatchObject([
      { operationId: id(61), baseServerRevision: 2, baseSnapshotHash: hash(action('Edited')) },
    ]);
    // The push cursor never becomes the pull checkpoint.
    expect((await app.facts()).cursor).toBeNull();
  });

  it('waits after a transient failure with growing backoff and keeps the same ids', async () => {
    const group = await claimed();
    expect(
      await app.recordPushOutcome(group.mutationGroupId, {
        kind: 'transient',
        reason: 'unavailable',
      }),
    ).toEqual({ status: 'retry_wait', nextAttemptAt: '2026-10-01T09:00:05.000Z' });
    now += 5_000;
    const again = await app.claimNextGroup();
    expect(again?.attempt).toBe(2);
    expect(again?.operations[0]?.operationId).toBe(id(51));
    expect(
      await app.recordPushOutcome(group.mutationGroupId, { kind: 'transient', reason: 'offline' }),
    ).toEqual({ status: 'retry_wait', nextAttemptAt: '2026-10-01T09:00:15.000Z' });
    expect(await app.facts()).toMatchObject({
      waiting: 1,
      unconfirmed: 1,
      nextAttemptAt: '2026-10-01T09:00:15.000Z',
    });
    expect(await app.retryNow()).toBe(1);
    expect((await app.claimNextGroup())?.attempt).toBe(3);
  });

  it('treats an incomplete acknowledgment as a transient failure', async () => {
    const group = await claimed();
    expect(
      await app.recordPushOutcome(group.mutationGroupId, {
        kind: 'accepted',
        cursor: '1',
        acknowledgments: [],
      }),
    ).toMatchObject({ status: 'retry_wait' });
    expect(store.record('action', id(1))?.serverRevision).toBe(1);
  });

  it('pauses on an expired session without counting the attempt', async () => {
    const group = await claimed();
    expect(await app.recordPushOutcome(group.mutationGroupId, { kind: 'auth_expired' })).toEqual({
      status: 'paused',
    });
    expect(store.operations()).toMatchObject([{ state: 'pending', attemptCount: 0 }]);
    expect((await app.facts()).unconfirmed).toBe(0);
  });

  it('dead-letters a rejection and retries it only when a person asks', async () => {
    const group = await claimed();
    expect(
      await app.recordPushOutcome(group.mutationGroupId, {
        kind: 'rejected',
        code: 'schema_mismatch',
      }),
    ).toEqual({ status: 'dead_letter' });
    expect(await app.claimNextGroup()).toBeNull();
    expect((await app.facts()).rejected).toBe(1);
    expect(await app.retryRejected()).toBe(1);
    expect((await app.claimNextGroup())?.operations[0]?.operationId).toBe(id(51));
  });

  it('ignores an answer for a group that is not being sent', async () => {
    await claimed();
    expect(
      await app.recordPushOutcome(id(999), { kind: 'rejected', code: 'invalid_payload' }),
    ).toEqual({ status: 'stale' });
  });

  it('merges a stale base with disjoint changes and pushes the merged result again', async () => {
    const group = await claimed(action('Base', { note: 'Local note' }));
    const remote = action('Remote title');
    expect(
      await app.recordPushOutcome(group.mutationGroupId, {
        kind: 'conflict',
        conflicts: [
          {
            serverConflictId: id(90),
            operationId: id(51),
            entityType: 'action',
            entityId: id(1),
            kind: 'stale_base',
            baseServerRevision: 1,
            remote: { serverRevision: 3, deleted: false, document: remote },
          },
        ],
      }),
    ).toEqual({ status: 'merged' });
    const merged = action('Remote title', { note: 'Local note' });
    expect(store.record('action', id(1))).toMatchObject({
      serverRevision: 3,
      baseSnapshotHash: hash(remote),
      document: merged,
    });
    expect(store.operations()).toMatchObject([
      { operationId: id(51), state: 'pending', attemptCount: 0, document: merged },
    ]);
    expect(await app.pendingServerClosures()).toEqual([
      { serverConflictId: id(90), resolution: 'merge' },
    ]);
    const again = await app.claimNextGroup();
    expect(again?.operations[0]).toMatchObject({
      baseServerRevision: 3,
      baseSnapshotHash: hash(remote),
    });
  });

  it('holds the group on the same field and keeps both versions', async () => {
    const group = await claimed(action('Mine'));
    expect(
      await app.recordPushOutcome(group.mutationGroupId, {
        kind: 'conflict',
        conflicts: [
          {
            serverConflictId: id(90),
            operationId: id(51),
            entityType: 'action',
            entityId: id(1),
            kind: 'stale_base',
            baseServerRevision: 1,
            remote: { serverRevision: 3, deleted: false, document: action('Theirs') },
          },
        ],
      }),
    ).toEqual({ status: 'blocked', conflicts: 1 });
    expect(store.operations()).toMatchObject([{ state: 'blocked_conflict', attemptCount: 0 }]);
    const [conflict] = await app.listConflicts();
    expect(conflict).toMatchObject({
      kind: 'stale_base',
      origin: 'this_device',
      base: action('Base'),
      local: { deleted: false, document: action('Mine') },
      remote: { deleted: false, document: action('Theirs') },
      fields: ['title'],
    });
    expect(store.record('action', id(1))?.document).toEqual(action('Mine'));
  });
});

describe('pulled pages', () => {
  it('apply remote creates, updates, and tombstones and store the cursor with the page', async () => {
    converged(ref('action', 2), action('Two'));
    converged(ref('action', 3), action('Three'));
    const result = await app.applyPulledPages([
      page(
        [
          change(ref('action', 1), 1, action('One')),
          change(ref('action', 2), 2, action('Two, edited')),
          change(ref('action', 3), 2, null),
          change(ref('action', 4), 3, null),
        ],
        '7',
      ),
    ]);
    expect(result).toEqual({
      status: 'applied',
      cursor: '7',
      caughtUp: true,
      applied: 3,
      merged: 0,
      conflicts: 0,
      unchanged: 1,
      queuedPushes: false,
    });
    expect(store.record('action', id(1))).toMatchObject({
      serverRevision: 1,
      document: action('One'),
    });
    expect(store.record('action', id(2))).toMatchObject({ serverRevision: 2, localRevision: 2 });
    expect(store.record('action', id(3))).toBeUndefined();
    expect(store.state.ledger.get(`action:${id(3)}`)?.serverRevision).toBe(2);
    expect(store.state.ledger.get(`action:${id(4)}`)?.serverRevision).toBe(3);
    expect(store.state.checkpoint).toEqual({
      cursor: '7',
      lastSuccessAt: '2026-10-01T09:00:00.000Z',
    });
    // Remote applies use the sync actor, write only `{ operation }`, and queue nothing.
    expect(store.state.events.map((record) => [record.event.actor, record.event.payload])).toEqual([
      ['sync', { operation: 'create' }],
      ['sync', { operation: 'update' }],
      ['sync', { operation: 'delete' }],
    ]);
    expect(store.operations()).toEqual([]);
  });

  it('keep the last success unchanged until the last page', async () => {
    await app.applyPulledPages([page([], '3', true)]);
    expect(store.state.checkpoint).toEqual({ cursor: '3', lastSuccessAt: null });
  });

  it('skip changes this replica already has', async () => {
    converged(ref('action', 1), action('One'), 5);
    expect(
      await app.applyPulledPages([page([change(ref('action', 1), 5, action('One'))], '9')]),
    ).toMatchObject({
      unchanged: 1,
      applied: 0,
    });
  });

  it('merge disjoint edits and rebase the queued intent onto the remote revision', async () => {
    converged(ref('action', 1), action('Base'));
    edit(ref('action', 1), action('Base', { note: 'Local' }), 50, 51);
    expect(
      await app.applyPulledPages([page([change(ref('action', 1), 2, action('Remote'))], '4')]),
    ).toMatchObject({ status: 'applied', merged: 1 });
    expect(store.record('action', id(1))).toMatchObject({
      serverRevision: 2,
      document: action('Remote', { note: 'Local' }),
    });
    expect(store.operations()).toMatchObject([{ document: action('Remote', { note: 'Local' }) }]);
    expect((await app.claimNextGroup())?.operations[0]).toMatchObject({ baseServerRevision: 2 });
  });

  it('open a conflict for the same field and hold the queued group', async () => {
    converged(ref('action', 1), action('Base'));
    edit(ref('action', 1), action('Mine'), 50, 51);
    expect(
      await app.applyPulledPages([page([change(ref('action', 1), 2, action('Theirs'))], '4')]),
    ).toMatchObject({ status: 'applied', conflicts: 1 });
    expect(store.operations()).toMatchObject([{ state: 'blocked_conflict' }]);
    expect(store.record('action', id(1))).toMatchObject({
      serverRevision: 1,
      document: action('Mine'),
    });
    expect(store.state.checkpoint.cursor).toBe('4');
  });

  it('refuse to run while a sent group has no answer', async () => {
    converged(ref('action', 1), action('Base'));
    edit(ref('action', 1), action('Mine'), 50, 51);
    await app.claimNextGroup();
    await app.recoverStranded();
    expect(await app.applyPulledPages([page([], '1')])).toEqual({ status: 'not_ready' });
  });

  it('preserve a change the local plan refuses as a conflict and still advance the cursor', async () => {
    const result = await app.applyPulledPages([
      page(
        [change(ref('action', 1), 1, action('   ')), change(ref('action', 2), 1, action('Fine'))],
        '5',
      ),
    ]);
    expect(result).toMatchObject({ status: 'applied', applied: 1, conflicts: 1, cursor: '5' });
    expect(store.record('action', id(1))).toBeUndefined();
    expect(store.record('action', id(2))).toBeDefined();
    expect(await app.listConflicts()).toMatchObject([
      { entityId: id(1), kind: 'merge_conflict', choices: ['keep_local', 'keep_remote'] },
    ]);
  });

  it('keep 120 documents the codecs refuse as conflicts in one transaction and advance the cursor', async () => {
    const before = store.transactions;
    const refused = Array.from({ length: 120 }, (_, index) =>
      change(ref('action', 100 + index), 1, action('   '), String(index + 1)),
    );
    expect(await app.applyPulledPages([page(refused, '120')])).toEqual({
      status: 'applied',
      cursor: '120',
      caughtUp: true,
      applied: 0,
      merged: 0,
      conflicts: 120,
      unchanged: 0,
      queuedPushes: false,
    });
    // Checked before anything was written: no transaction restarted for a refusal.
    expect(store.transactions - before).toBe(1);
    expect(store.state.checkpoint.cursor).toBe('120');
    expect(await app.listConflicts()).toHaveLength(120);
    expect(store.record('action', id(100))).toBeUndefined();
  });

  it('restart at most once per change for a refusal the codecs cannot foresee', async () => {
    store.constrain = (_type, document) => document['title'] === 'Taken';
    const before = store.transactions;
    expect(
      await app.applyPulledPages([
        page(
          [
            change(ref('action', 1), 1, action('Taken')),
            change(ref('action', 2), 1, action('Fine')),
            change(ref('action', 3), 1, action('Taken')),
          ],
          '3',
        ),
      ]),
    ).toMatchObject({ status: 'applied', applied: 1, conflicts: 2, cursor: '3' });
    expect(store.transactions - before).toBe(3);
    expect(store.record('action', id(2))).toBeDefined();
  });

  it('report pages that can be neither applied nor kept as conflicts, keeping the cursor', async () => {
    // A damaged store: a record here already refers to a Project this device does not hold.
    store.seed({
      ref: ref('action', 1),
      serverRevision: 1,
      baseSnapshotHash: null,
      document: action('Orphan', { projectId: id(9) }),
    });
    expect(
      await app.applyPulledPages([page([change(ref('action', 2), 1, action('Fine'))], '5')]),
    ).toEqual({ status: 'refused' });
    expect(store.state.checkpoint.cursor).toBeNull();
    expect(store.record('action', id(2))).toBeUndefined();
  });

  it('ask for the next page when a record refers to one not received yet', async () => {
    const child = change(ref('action', 1), 1, action('Child', { projectId: id(2) }));
    expect(await app.applyPulledPages([page([child], '1', true)])).toEqual({
      status: 'needs_more',
    });
    expect(store.record('action', id(1))).toBeUndefined();
    expect(
      await app.applyPulledPages([
        page([child], '1', true),
        page(
          [change(ref('project', 2), 1, { title: 'Parent', orderKey: 'a0', state: 'idea' })],
          '2',
        ),
      ]),
    ).toMatchObject({ status: 'applied', applied: 2, cursor: '2' });
  });
});

describe('resolution', () => {
  async function conflicted() {
    converged(ref('action', 1), action('Base'));
    edit(ref('action', 1), action('Mine', { note: 'Mine' }), 50, 51);
    await app.applyPulledPages([
      page([change(ref('action', 1), 2, action('Theirs', { note: 'Theirs' }))], '4'),
    ]);
    const [conflict] = await app.listConflicts();
    if (conflict === undefined) throw new Error('A conflict is open.');
    return conflict;
  }

  it('keeps this device’s version and pushes it from the remote revision', async () => {
    const conflict = await conflicted();
    expect(await app.resolveConflict(conflict.conflictId, { choice: 'keep_local' })).toEqual({
      ok: true,
      value: { queued: true },
    });
    expect(store.operations()).toMatchObject([
      { state: 'pending', document: action('Mine', { note: 'Mine' }) },
    ]);
    expect((await app.claimNextGroup())?.operations[0]).toMatchObject({ baseServerRevision: 2 });
    expect(await app.listConflicts()).toEqual([]);
    expect(store.state.events.at(-1)?.event).toBeUndefined();
  });

  it('keeps the other version and drops the superseded local intent', async () => {
    const conflict = await conflicted();
    expect(await app.resolveConflict(conflict.conflictId, { choice: 'keep_remote' })).toEqual({
      ok: true,
      value: { queued: false },
    });
    expect(store.operations()).toEqual([]);
    expect(store.record('action', id(1))).toMatchObject({
      serverRevision: 2,
      document: action('Theirs', { note: 'Theirs' }),
    });
    expect(store.state.events.at(-1)?.event).toMatchObject({
      actor: 'user',
      eventType: 'sync.conflict_resolved',
      payload: { operation: 'update' },
    });
  });

  it('merges details and refuses an incomplete or invalid merge', async () => {
    const conflict = await conflicted();
    expect([...conflict.fields].sort()).toEqual(['note', 'title']);
    expect(
      await app.resolveConflict(conflict.conflictId, {
        choice: 'merge',
        fields: { title: 'local' },
      }),
    ).toEqual({ ok: false, code: 'invalid_merge' });
    store.validate = (_type, document) =>
      document['title'] !== 'Mine' || document['note'] !== 'Theirs';
    expect(
      await app.resolveConflict(conflict.conflictId, {
        choice: 'merge',
        fields: { title: 'local', note: 'remote' },
      }),
    ).toEqual({ ok: false, code: 'invalid_merge' });
    store.validate = () => true;
    expect(
      await app.resolveConflict(conflict.conflictId, {
        choice: 'merge',
        fields: { title: 'remote', note: 'local' },
      }),
    ).toEqual({ ok: true, value: { queued: true } });
    expect(store.record('action', id(1))?.document).toEqual(action('Theirs', { note: 'Mine' }));
    expect(await app.resolveConflict(conflict.conflictId, { choice: 'keep_local' })).toEqual({
      ok: false,
      code: 'not_open',
    });
    expect(await app.resolveConflict(id(999), { choice: 'keep_local' })).toEqual({
      ok: false,
      code: 'not_found',
    });
  });

  it('never pushes the version the person rejected, even after an edit made while the conflict was open', async () => {
    const conflict = await conflicted();
    // The person keeps planning: a second edit queues behind the conflict.
    edit(ref('action', 1), action('Mine', { note: 'Mine, later' }), 60, 61);
    expect(await app.claimNextGroup()).toBeNull();
    expect(
      await app.resolveConflict(conflict.conflictId, {
        choice: 'merge',
        fields: { title: 'remote', note: 'local' },
      }),
    ).toEqual({ ok: true, value: { queued: true } });
    const resolved = action('Theirs', { note: 'Mine, later' });
    expect(store.record('action', id(1))?.document).toEqual(resolved);
    const pushed = await pushAll();
    expect(pushed.map((operation) => operation.operationId)).toEqual([id(51), id(61)]);
    // Every update carries the chosen version, from the server's latest base.
    expect(pushed.map((operation) => operation.document)).toEqual([resolved, resolved]);
    expect(pushed[0]).toMatchObject({ baseServerRevision: 2 });
    expect(pushed.some((operation) => operation.document?.['title'] === 'Mine')).toBe(false);
  });

  it('adopts another device’s candidate in every queued local update', async () => {
    converged(ref('action', 1), action('Current'));
    edit(ref('action', 1), action('Mine'), 50, 51);
    edit(ref('action', 1), action('Mine again'), 60, 61);
    await app.mergeServerConflicts([
      {
        serverConflictId: id(90),
        entityType: 'action',
        entityId: id(1),
        kind: 'stale_base',
        baseServerRevision: 1,
        local: { deleted: false, document: action('Unsaved') },
        remote: { serverRevision: 1, deleted: false, document: action('Current') },
        blockedMutationGroupId: id(91),
      },
    ]);
    const [shown] = await app.listConflicts();
    if (shown === undefined) throw new Error('A conflict is open.');
    expect(await app.resolveConflict(shown.conflictId, { choice: 'keep_remote' })).toEqual({
      ok: true,
      value: { queued: true },
    });
    expect((await pushAll()).map((operation) => operation.document)).toEqual([
      action('Unsaved'),
      action('Unsaved'),
    ]);
  });

  it('waits for a change sent without an answer before resolving', async () => {
    converged(ref('action', 1), action('Current'));
    edit(ref('action', 1), action('Mine'), 50, 51);
    sentOnce(50, now + 5_000);
    await app.mergeServerConflicts([
      {
        serverConflictId: id(90),
        entityType: 'action',
        entityId: id(1),
        kind: 'stale_base',
        baseServerRevision: 1,
        local: { deleted: false, document: action('Unsaved') },
        remote: { serverRevision: 1, deleted: false, document: action('Current') },
        blockedMutationGroupId: id(91),
      },
    ]);
    const [shown] = await app.listConflicts();
    if (shown === undefined) throw new Error('A conflict is open.');
    expect(await app.resolveConflict(shown.conflictId, { choice: 'keep_remote' })).toEqual({
      ok: false,
      code: 'not_ready',
    });
    expect(store.record('action', id(1))?.document).toEqual(action('Mine'));
    expect(store.operations()).toMatchObject([{ operationId: id(51), document: action('Mine') }]);
    expect(await app.listConflicts()).toHaveLength(1);
  });

  it('names the records each version links to, without ids', async () => {
    const project = (title: string) => ({ title, orderKey: 'a0', state: 'active' });
    converged(ref('project', 2), project('Launch'));
    converged(ref('project', 3), project('Website'));
    store.state.ledger.set(`project:${id(4)}`, { serverRevision: 2, localRevision: 3 });
    converged(ref('action', 1), action('Call', { projectId: id(2) }));
    edit(ref('action', 1), action('Call', { projectId: id(3) }), 50, 51);
    await app.applyPulledPages([
      page([change(ref('action', 1), 2, action('Call', { projectId: id(4) }))], '4'),
    ]);
    const [listed] = await app.listConflicts();
    if (listed === undefined) throw new Error('A conflict is open.');
    expect(listed.links).toBeUndefined();
    const view = await app.getConflict(listed.conflictId);
    expect(view).toMatchObject({ fields: ['placement'] });
    expect(view?.links).toEqual({
      [id(2)]: { entityType: 'project', presence: 'here', title: 'Launch' },
      [id(3)]: { entityType: 'project', presence: 'here', title: 'Website' },
      [id(4)]: { entityType: 'project', presence: 'deleted' },
    });
  });

  it('offers only Keep deleted or Restore edited for delete versus edit', async () => {
    converged(ref('action', 1), action('Base'));
    edit(ref('action', 1), action('Mine'), 50, 51);
    await app.applyPulledPages([page([change(ref('action', 1), 2, null)], '4')]);
    const [conflict] = await app.listConflicts();
    if (conflict === undefined) throw new Error('A conflict is open.');
    expect(conflict).toMatchObject({
      kind: 'edit_versus_delete',
      choices: ['keep_deleted', 'restore_edited'],
    });
    expect(await app.resolveConflict(conflict.conflictId, { choice: 'keep_local' })).toEqual({
      ok: false,
      code: 'invalid_choice',
    });
    expect(await app.resolveConflict(conflict.conflictId, { choice: 'restore_edited' })).toEqual({
      ok: true,
      value: { queued: true },
    });
    // The restore pushes over the tombstone's revision with no base hash.
    expect((await app.claimNextGroup())?.operations[0]).toMatchObject({
      kind: 'update',
      baseServerRevision: 2,
      baseSnapshotHash: null,
      document: action('Mine'),
    });
  });
});

describe('server candidates and closures', () => {
  it('show another device’s unsaved candidate, close one that already matches, and retire answered ones', async () => {
    converged(ref('action', 1), action('Current'));
    converged(ref('action', 2), action('Same'));
    const candidate = (n: number, entity: number, document: SyncDocument) => ({
      serverConflictId: id(n),
      entityType: 'action' as const,
      entityId: id(entity),
      kind: 'stale_base' as const,
      baseServerRevision: 1,
      local: { deleted: false, document },
      remote: { serverRevision: 1, deleted: false, document: action('Current') },
      blockedMutationGroupId: id(n + 1),
    });
    expect(
      await app.mergeServerConflicts([
        candidate(90, 1, action('Unsaved')),
        candidate(92, 2, action('Same')),
      ]),
    ).toBe(1);
    const [shown] = await app.listConflicts();
    expect(shown).toMatchObject({
      origin: 'other_device',
      local: { document: action('Current') },
      remote: { document: action('Unsaved') },
    });
    expect(await app.pendingServerClosures()).toEqual([
      { serverConflictId: id(92), resolution: 'keep_local' },
    ]);
    await app.confirmServerClosure(id(92));
    expect(await app.pendingServerClosures()).toEqual([]);
    // Answered on another device: the candidate is no longer open on the server.
    expect(await app.mergeServerConflicts([])).toBe(0);
    expect(await app.listConflicts()).toEqual([]);
  });

  it('adopts another device’s candidate as a new command', async () => {
    converged(ref('action', 1), action('Current'));
    await app.mergeServerConflicts([
      {
        serverConflictId: id(90),
        entityType: 'action',
        entityId: id(1),
        kind: 'stale_base',
        baseServerRevision: 1,
        local: { deleted: false, document: action('Unsaved') },
        remote: { serverRevision: 1, deleted: false, document: action('Current') },
        blockedMutationGroupId: id(91),
      },
    ]);
    const [shown] = await app.listConflicts();
    if (shown === undefined) throw new Error('A conflict is open.');
    expect(await app.resolveConflict(shown.conflictId, { choice: 'keep_remote' })).toEqual({
      ok: true,
      value: { queued: true },
    });
    expect(store.record('action', id(1))?.document).toEqual(action('Unsaved'));
    expect(store.operations()).toMatchObject([
      { kind: 'update', document: action('Unsaved'), actor: 'user' },
    ]);
    expect(await app.pendingServerClosures()).toEqual([
      { serverConflictId: id(90), resolution: 'keep_remote' },
    ]);
    await app.confirmServerClosure(id(90));
    const stored = [...store.state.conflicts.values()][0];
    expect(stored?.payload).toMatchObject({
      closure: 'done',
      base: null,
      local: { document: null },
      remote: { document: null },
    });
  });

  it('keep another device’s candidate when the record is deleted, as delete versus edit', async () => {
    converged(ref('action', 1), action('Current'));
    await app.mergeServerConflicts([
      {
        serverConflictId: id(90),
        entityType: 'action',
        entityId: id(1),
        kind: 'stale_base',
        baseServerRevision: 1,
        local: { deleted: false, document: action('Unsaved edit') },
        remote: { serverRevision: 1, deleted: false, document: action('Current') },
        blockedMutationGroupId: id(91),
      },
    ]);
    expect(
      await app.applyPulledPages([page([change(ref('action', 1), 2, null)], '6')]),
    ).toMatchObject({ status: 'applied', applied: 1 });
    expect(store.record('action', id(1))).toBeUndefined();
    const [shown] = await app.listConflicts();
    expect(shown).toMatchObject({
      origin: 'other_device',
      local: { deleted: true },
      remote: { deleted: false, document: action('Unsaved edit') },
      choices: ['keep_deleted', 'restore_edited'],
    });
    if (shown === undefined) throw new Error('A conflict is open.');
    expect(await app.resolveConflict(shown.conflictId, { choice: 'restore_edited' })).toEqual({
      ok: true,
      value: { queued: true },
    });
    expect(store.record('action', id(1))?.document).toEqual(action('Unsaved edit'));
    expect((await app.claimNextGroup())?.operations[0]).toMatchObject({
      kind: 'update',
      baseServerRevision: 2,
      baseSnapshotHash: null,
    });
  });

  it('answer this replica’s own push whose answer was lost', async () => {
    converged(ref('action', 1), action('Base'));
    edit(ref('action', 1), action('Mine'), 50, 51);
    expect(
      await app.mergeServerConflicts([
        {
          serverConflictId: id(90),
          entityType: 'action',
          entityId: id(1),
          kind: 'stale_base',
          baseServerRevision: 1,
          local: { deleted: false, document: action('Mine') },
          remote: { serverRevision: 2, deleted: false, document: action('Theirs') },
          blockedMutationGroupId: id(50),
        },
      ]),
    ).toBe(1);
    expect(store.operations()).toMatchObject([{ state: 'blocked_conflict' }]);
    expect(await app.listConflicts()).toMatchObject([
      { origin: 'this_device', kind: 'stale_base' },
    ]);
  });
});

describe('recovery', () => {
  it('returns stranded sending groups to pending with the same ids', async () => {
    converged(ref('action', 1), action('Base'));
    edit(ref('action', 1), action('Mine'), 50, 51);
    await app.claimNextGroup();
    expect(await app.recoverStranded()).toBe(1);
    expect(store.operations()).toMatchObject([
      { operationId: id(51), state: 'pending', attemptCount: 1 },
    ]);
    expect((await app.facts()).unconfirmed).toBe(1);
  });

  it('rolls a whole pull back when anything fails inside it', async () => {
    store.fault = (operation) => {
      if (operation === 'writeCheckpoint') throw new Error('disk full');
    };
    expect(
      await app.applyPulledPages([page([change(ref('action', 1), 1, action('One'))], '3')]),
    ).toEqual({
      status: 'failed',
    });
    expect(store.record('action', id(1))).toBeUndefined();
    expect(store.state.checkpoint.cursor).toBeNull();
    store.fault = null;
    expect(
      await app.applyPulledPages([page([change(ref('action', 1), 1, action('One'))], '3')]),
    ).toMatchObject({
      status: 'applied',
      cursor: '3',
    });
  });

  it('restarts from the beginning by moving only the cursor', async () => {
    converged(ref('action', 1), action('Kept'));
    store.state.checkpoint = { cursor: '40', lastSuccessAt: '2026-10-01T08:00:00.000Z' as Instant };
    await app.restartFromBeginning();
    expect(store.state.checkpoint).toEqual({
      cursor: null,
      lastSuccessAt: '2026-10-01T08:00:00.000Z',
    });
    expect(store.record('action', id(1))).toBeDefined();
  });
});
