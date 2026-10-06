/**
 * Two replicas, each a real SQLite database, converge through the in-memory protocol server
 * (007, 009, 010, 012): disjoint merge, same-field conflicts, Review notes, delete
 * versus edit in both orders, tombstones that never resurrect, and offline edits reconnecting in
 * both orders.
 */
import type { EntityRef, EntityType, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import {
  actionDocument,
  dailyReviewDocument,
  ManualTime,
  Replica,
  removeReplicaFiles,
} from './__fixtures__/replica';
import { FakeSyncServer } from './testing';

const replicaA = 'a1000000-0000-4000-8000-000000000001' as UUID;
const replicaB = 'b1000000-0000-4000-8000-000000000001' as UUID;
const compared: readonly EntityType[] = ['action', 'review', 'profile'];

const open: Replica[] = [];

async function pair() {
  const server = new FakeSyncServer();
  const time = new ManualTime();
  const a = await Replica.open({
    name: 'A',
    replicaId: replicaA,
    transport: server.transport(),
    time,
    withProfile: true,
  });
  const b = await Replica.open({
    name: 'B',
    replicaId: replicaB,
    transport: server.transport(),
    time,
  });
  open.push(a, b);
  await a.coordinator.syncNow();
  await b.coordinator.syncNow();
  return { server, a, b, time };
}

/** Sync both replicas (in the given order) until neither has anything left to exchange. */
async function settle(first: Replica, second: Replica): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await first.coordinator.syncNow();
    await second.coordinator.syncNow();
  }
}

async function expectConverged(a: Replica, b: Replica, server: FakeSyncServer): Promise<void> {
  const left = await a.documents(compared);
  const right = await b.documents(compared);
  expect(right).toEqual(left);
  const live = new Map(
    [...server.liveDocuments()].filter(([key]) =>
      compared.some((type) => key.startsWith(`${type}:`)),
    ),
  );
  expect(live).toEqual(left);
  expect(a.coordinator.getStatus()).toMatchObject({ pendingChanges: 0, openConflicts: 0 });
  expect(b.coordinator.getStatus()).toMatchObject({ pendingChanges: 0, openConflicts: 0 });
}

async function onlyConflict(replica: Replica) {
  const conflicts = await replica.application.listConflicts();
  expect(conflicts).toHaveLength(1);
  const conflict = conflicts[0];
  if (conflict === undefined) throw new Error('A conflict is open.');
  return conflict;
}

function mirror(replica: Replica, ref: EntityRef): EntityRef {
  return replica.ref(ref.type, ref.id);
}

afterEach(async () => {
  for (const replica of open.splice(0)) await replica.close();
  removeReplicaFiles();
});

describe('first replication', () => {
  it('gives a fresh replica the account, its Profile first', async () => {
    const { a, b, server } = await pair();
    const ref = await a.create('action', actionDocument('Write the plan'));
    await settle(a, b);
    expect((await b.read(mirror(b, ref)))?.document).toEqual((await a.read(ref))?.document);
    await expectConverged(a, b, server);
    expect(a.coordinator.getStatus().state).toBe('synced');
  });
});

describe('disjoint edits', () => {
  for (const order of ['A first', 'B first'] as const) {
    it(`merge without a conflict when ${order} reconnects`, async () => {
      const { a, b, server } = await pair();
      const ref = await a.create('action', actionDocument('Draft'));
      await settle(a, b);
      await a.update(ref, { title: 'Draft the outline' });
      await b.update(mirror(b, ref), { note: 'Bring the figures', priority: 'high' });
      if (order === 'A first') await settle(a, b);
      else await settle(b, a);
      expect((await a.read(ref))?.document).toMatchObject({
        title: 'Draft the outline',
        note: 'Bring the figures',
        priority: 'high',
      });
      await expectConverged(a, b, server);
      expect(server.openConflictList()).toEqual([]);
    });
  }
});

describe('same field', () => {
  async function titleConflict() {
    const context = await pair();
    const { a, b } = context;
    const ref = await a.create('action', actionDocument('Draft'));
    await settle(a, b);
    await a.update(ref, { title: 'Title from A' });
    await b.update(mirror(b, ref), { title: 'Title from B' });
    await a.coordinator.syncNow();
    await b.coordinator.syncNow();
    return { ...context, ref };
  }

  it('preserves base, local, and remote and waits for a person', async () => {
    const { b, ref, server } = await titleConflict();
    expect(b.coordinator.getStatus()).toMatchObject({ state: 'needs_attention', openConflicts: 1 });
    const conflict = await onlyConflict(b);
    expect(conflict).toMatchObject({
      kind: 'stale_base',
      fields: ['title'],
      base: { title: 'Draft' },
      local: { deleted: false, document: { title: 'Title from B' } },
      remote: { deleted: false, document: { title: 'Title from A' } },
      choices: ['keep_local', 'keep_remote', 'merge'],
    });
    // Nothing silently won: B still shows its own title and the server kept A's.
    expect((await b.read(mirror(b, ref)))?.document['title']).toBe('Title from B');
    expect(server.liveDocuments().get(`action:${ref.id}`)?.['title']).toBe('Title from A');
    expect(server.openConflictList()).toHaveLength(1);
  });

  it('keeps this device’s version and pushes it from the latest base', async () => {
    const { a, b, ref, server } = await titleConflict();
    const conflict = await onlyConflict(b);
    expect(
      await b.application.resolveConflict(conflict.conflictId, { choice: 'keep_local' }),
    ).toEqual({ ok: true, value: { queued: true } });
    await settle(b, a);
    expect((await a.read(ref))?.document['title']).toBe('Title from B');
    await expectConverged(a, b, server);
    expect(server.openConflictList()).toEqual([]);
  });

  it('keeps the other version and drops the superseded local intent', async () => {
    const { a, b, ref, server } = await titleConflict();
    const conflict = await onlyConflict(b);
    expect(
      await b.application.resolveConflict(conflict.conflictId, { choice: 'keep_remote' }),
    ).toEqual({ ok: true, value: { queued: false } });
    await settle(b, a);
    expect((await b.read(mirror(b, ref)))?.document['title']).toBe('Title from A');
    await expectConverged(a, b, server);
  });

  it('never sends the version the person rejected, even after an edit made while the conflict was open', async () => {
    const { a, b, ref, server } = await titleConflict();
    // B keeps planning while the conflict is open: the edit queues behind it.
    await b.update(mirror(b, ref), { note: 'Note added on B' });
    await b.coordinator.syncNow();
    const conflict = await onlyConflict(b);
    const received: Record<string, unknown>[] = [];
    const push = server.push.bind(server);
    server.push = (request) => {
      for (const operation of request.operations) {
        if (operation.entityId === ref.id && operation.document !== null) {
          received.push(operation.document);
        }
      }
      return push(request);
    };
    expect(
      await b.application.resolveConflict(conflict.conflictId, {
        choice: 'merge',
        fields: { title: 'remote' },
      }),
    ).toEqual({ ok: true, value: { queued: true } });
    await settle(b, a);
    const chosen = { title: 'Title from A', note: 'Note added on B' };
    expect(received.length).toBeGreaterThan(0);
    for (const document of received) expect(document).toMatchObject(chosen);
    expect((await a.read(ref))?.document).toMatchObject(chosen);
    await expectConverged(a, b, server);
  });

  it('merges details field by field', async () => {
    const { a, b, ref, server } = await pair().then(async (context) => {
      const created = await context.a.create('action', actionDocument('Draft'));
      await settle(context.a, context.b);
      await context.a.update(created, { title: 'Title from A', note: 'Note from A' });
      await context.b.update(mirror(context.b, created), {
        title: 'Title from B',
        note: 'Note from B',
      });
      await context.a.coordinator.syncNow();
      await context.b.coordinator.syncNow();
      return { ...context, ref: created };
    });
    const conflict = await onlyConflict(b);
    expect([...conflict.fields].sort()).toEqual(['note', 'title']);
    expect(
      await b.application.resolveConflict(conflict.conflictId, {
        choice: 'merge',
        fields: { title: 'local' },
      }),
    ).toEqual({ ok: false, code: 'invalid_merge' });
    await b.application.resolveConflict(conflict.conflictId, {
      choice: 'merge',
      fields: { title: 'local', note: 'remote' },
    });
    await settle(b, a);
    expect((await a.read(ref))?.document).toMatchObject({
      title: 'Title from B',
      note: 'Note from A',
    });
    await expectConverged(a, b, server);
  });
});

describe('Review notes', () => {
  it('never take the last write: both versions wait for a person', async () => {
    const { a, b, server } = await pair();
    const review = await a.create('review', dailyReviewDocument('2026-10-01', { notes: 'Start' }));
    await settle(a, b);
    await a.update(review, { notes: 'Notes written on A' });
    await b.update(mirror(b, review), { notes: 'Notes written on B' });
    await settle(a, b);
    const conflict = await onlyConflict(b);
    expect(conflict).toMatchObject({ entityType: 'review', fields: ['notes'] });
    expect((await a.read(review))?.document['notes']).toBe('Notes written on A');
    expect((await b.read(mirror(b, review)))?.document['notes']).toBe('Notes written on B');
    await b.application.resolveConflict(conflict.conflictId, { choice: 'keep_local' });
    await settle(b, a);
    expect((await a.read(review))?.document['notes']).toBe('Notes written on B');
    await expectConverged(a, b, server);
  });
});

describe('delete versus edit', () => {
  async function deletedOnAEditedOnB() {
    const context = await pair();
    const ref = await context.a.create('action', actionDocument('Shared'));
    await settle(context.a, context.b);
    expect((await context.a.remove(ref)).ok).toBe(true);
    await context.b.update(mirror(context.b, ref), { title: 'Edited on B' });
    await context.a.coordinator.syncNow();
    await context.b.coordinator.syncNow();
    return { ...context, ref };
  }

  it('preserves the tombstone and the edited copy, offering Keep deleted or Restore edited', async () => {
    const { b, ref, server } = await deletedOnAEditedOnB();
    const conflict = await onlyConflict(b);
    expect(conflict).toMatchObject({
      kind: 'edit_versus_delete',
      local: { deleted: false, document: { title: 'Edited on B' } },
      remote: { deleted: true, document: null },
      choices: ['keep_deleted', 'restore_edited'],
    });
    expect(server.records.get(`action:${ref.id}`)?.deleted).toBe(true);
  });

  it('keeps it deleted on both replicas', async () => {
    const { a, b, ref, server } = await deletedOnAEditedOnB();
    const conflict = await onlyConflict(b);
    expect(
      await b.application.resolveConflict(conflict.conflictId, { choice: 'keep_deleted' }),
    ).toEqual({ ok: true, value: { queued: false } });
    await settle(b, a);
    expect(await b.read(mirror(b, ref))).toBeNull();
    expect(await a.read(ref)).toBeNull();
    await expectConverged(a, b, server);
    expect(server.openConflictList()).toEqual([]);
  });

  it('restores the edited version explicitly on both replicas', async () => {
    const { a, b, ref, server } = await deletedOnAEditedOnB();
    const conflict = await onlyConflict(b);
    await b.application.resolveConflict(conflict.conflictId, { choice: 'restore_edited' });
    await settle(b, a);
    expect((await a.read(ref))?.document['title']).toBe('Edited on B');
    await expectConverged(a, b, server);
  });

  for (const choice of ['keep_deleted', 'restore_edited'] as const) {
    it(`resolves an edit that reached the server first (${choice})`, async () => {
      const { a, b, server } = await pair();
      const ref = await a.create('action', actionDocument('Shared'));
      await settle(a, b);
      await b.update(mirror(b, ref), { title: 'Edited on B' });
      await b.coordinator.syncNow();
      expect((await a.remove(ref)).ok).toBe(true);
      await a.coordinator.syncNow();
      const conflict = await onlyConflict(a);
      expect(conflict).toMatchObject({
        kind: 'delete_versus_edit',
        local: { deleted: true },
        remote: { deleted: false, document: { title: 'Edited on B' } },
      });
      await a.application.resolveConflict(conflict.conflictId, { choice });
      await settle(a, b);
      if (choice === 'keep_deleted') {
        expect(await b.read(mirror(b, ref))).toBeNull();
      } else {
        expect((await a.read(ref))?.document['title']).toBe('Edited on B');
      }
      await expectConverged(a, b, server);
    });
  }
});

describe('tombstones', () => {
  it('apply on a replica without local changes and nothing resurrects', async () => {
    const { a, b, server } = await pair();
    const ref = await a.create('action', actionDocument('Temporary'));
    await settle(a, b);
    const transport = a.transport as ReturnType<FakeSyncServer['transport']>;
    expect((await a.remove(ref)).ok).toBe(true);
    await settle(a, b);
    expect(await b.read(mirror(b, ref))).toBeNull();
    // A stale replica's update against the tombstone is refused as a conflict, never applied.
    const replay = await transport.push({
      protocolVersion: 1,
      replicaId: replicaB,
      mutationGroupId: 'b2000000-0000-4000-8000-000000000001',
      operations: [
        {
          operationId: 'b2000000-0000-4000-8000-000000000002',
          sequence: 0,
          entityType: 'action',
          entityId: ref.id,
          kind: 'update',
          baseServerRevision: 1,
          baseSnapshotHash: null,
          document: actionDocument('Resurrected'),
        },
      ],
    });
    expect(replay).toMatchObject({ ok: true, value: { status: 'conflict' } });
    expect(server.records.get(`action:${ref.id}`)?.deleted).toBe(true);
    // A create with the deleted id is a collision, never a new record.
    const create = await transport.push({
      protocolVersion: 1,
      replicaId: replicaB,
      mutationGroupId: 'b2000000-0000-4000-8000-000000000003',
      operations: [
        {
          operationId: 'b2000000-0000-4000-8000-000000000004',
          sequence: 0,
          entityType: 'action',
          entityId: ref.id,
          kind: 'create',
          baseServerRevision: 0,
          baseSnapshotHash: null,
          document: actionDocument('Resurrected'),
        },
      ],
    });
    expect(create).toMatchObject({ ok: true, value: { status: 'conflict' } });
    // The local ledger refuses a re-create too.
    await expect(b.create('action', actionDocument('Again'), ref.id)).rejects.toThrow();
    await settle(a, b);
    expect(await a.read(ref)).toBeNull();
    expect(await b.read(mirror(b, ref))).toBeNull();
  });

  it('keep a deleted record deleted when a lost answer is retried', async () => {
    const { a, b, server } = await pair();
    const transport = a.transport as ReturnType<FakeSyncServer['transport']>;
    const ref = await a.create('action', actionDocument('Lost answer'));
    transport.loseNextPushAnswer = true;
    await a.coordinator.syncNow();
    expect(a.coordinator.getStatus()).toMatchObject({ pendingChanges: 1 });
    a.time.advance(60_000);
    await a.coordinator.syncNow();
    expect(server.records.get(`action:${ref.id}`)?.revision).toBe(1);
    expect((await a.remove(ref)).ok).toBe(true);
    await settle(a, b);
    expect(server.records.get(`action:${ref.id}`)?.deleted).toBe(true);
    expect(await b.read(mirror(b, ref))).toBeNull();
    await expectConverged(a, b, server);
  });
});

describe('offline on both replicas', () => {
  for (const order of ['A then B', 'B then A'] as const) {
    it(`converges after reconnecting ${order}`, async () => {
      const { a, b, server } = await pair();
      const shared = await a.create('action', actionDocument('Shared', { orderKey: 'a1' }));
      const doomed = await a.create('action', actionDocument('Doomed', { orderKey: 'a2' }));
      const review = await a.create('review', dailyReviewDocument('2026-10-02'));
      await settle(a, b);
      a.online = false;
      b.online = false;
      // A: rename, complete another, new Action. B: note, delete, review energy, new Action.
      await a.update(shared, { title: 'Shared, renamed on A' });
      await a.update(review, { notes: 'Calm day' });
      const fromA = await a.create('action', actionDocument('New on A', { orderKey: 'a3' }));
      await b.update(mirror(b, shared), { note: 'Note from B' });
      expect((await b.remove(mirror(b, doomed))).ok).toBe(true);
      await b.update(mirror(b, review), { energy: 'high' });
      const fromB = await b.create('action', actionDocument('New on B', { orderKey: 'a4' }));
      await a.coordinator.syncNow();
      await b.coordinator.syncNow();
      expect(a.coordinator.getStatus().state).toBe('queued_offline');
      expect(b.coordinator.getStatus().state).toBe('queued_offline');
      a.online = true;
      b.online = true;
      if (order === 'A then B') await settle(a, b);
      else await settle(b, a);
      expect((await a.read(shared))?.document).toMatchObject({
        title: 'Shared, renamed on A',
        note: 'Note from B',
      });
      expect(await a.read(doomed)).toBeNull();
      expect((await a.read(review))?.document).toMatchObject({ notes: 'Calm day', energy: 'high' });
      expect(await b.read(mirror(b, fromA))).not.toBeNull();
      expect(await a.read(mirror(a, fromB))).not.toBeNull();
      await expectConverged(a, b, server);
      const facts = [await a.application.facts(), await b.application.facts()];
      expect(facts.map((item) => item.cursor)).toEqual([
        String(server.sequence),
        String(server.sequence),
      ]);
    });
  }
});
