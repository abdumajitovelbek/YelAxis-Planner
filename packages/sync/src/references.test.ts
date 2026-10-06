/**
 * Pulled pages and references: a record that arrives before what it refers to waits
 * for the next page in the same transaction; a tombstone of a record something here still uses is
 * preserved as a conflict instead of breaking the store; an expired cursor reconciles from the
 * beginning and never resets local data.
 */
import type { SyncUnitOfWork } from '@yelaxis/application';
import type { UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import {
  actionDocument,
  ManualTime,
  profileId,
  Replica,
  removeReplicaFiles,
} from './__fixtures__/replica';
import { FakeSyncServer } from './testing';

const replicaA = 'a1000000-0000-4000-8000-000000000001' as UUID;
const replicaB = 'b1000000-0000-4000-8000-000000000001' as UUID;
const projectDocument = (title: string) => ({ title, orderKey: 'a0', state: 'idea' });

const open: Replica[] = [];

afterEach(async () => {
  for (const replica of open.splice(0)) await replica.close();
  removeReplicaFiles();
});

async function pair(pullPageSize?: number) {
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
    ...(pullPageSize === undefined ? {} : { coordinator: { pullPageSize } }),
  });
  open.push(a, b);
  return { server, a, b };
}

describe('references across pages', () => {
  it('hold a record until the page with what it refers to arrives', async () => {
    const { a, b } = await pair(1);
    const project = await a.create('project', projectDocument('Launch'));
    const action = await a.create(
      'action',
      actionDocument('First task', { projectId: project.id }),
    );
    await a.coordinator.syncNow();
    // The Project changes later, so its latest change comes after the Action's.
    await a.update(project, { title: 'Launch, renamed' });
    await a.coordinator.syncNow();
    await b.coordinator.syncNow();
    expect((await b.read(b.ref('action', action.id)))?.document['projectId']).toBe(project.id);
    expect((await b.read(b.ref('project', project.id)))?.document['title']).toBe('Launch, renamed');
    expect(b.coordinator.getStatus()).toMatchObject({ state: 'synced', openConflicts: 0 });
    expect(await b.application.listConflicts()).toEqual([]);
  });

  it('preserve a tombstone of a record still used here as a conflict', async () => {
    const { a, b, server } = await pair();
    const project = await a.create('project', projectDocument('Shared project'));
    await a.coordinator.syncNow();
    await b.coordinator.syncNow();
    // A deletes the Project; B (offline) files a new Action under it.
    expect((await a.remove(project)).ok).toBe(true);
    await a.coordinator.syncNow();
    const child = await b.create('action', actionDocument('Filed here', { projectId: project.id }));
    await b.coordinator.syncNow();
    // The server refuses the Action (its Project is gone); the tombstone cannot apply here.
    expect(server.records.has(`action:${child.id}`)).toBe(false);
    expect(await b.read(b.ref('project', project.id))).not.toBeNull();
    const conflicts = await b.application.listConflicts();
    expect(conflicts).toMatchObject([
      {
        entityType: 'project',
        kind: 'edit_versus_delete',
        remote: { deleted: true },
        choices: ['keep_deleted', 'restore_edited'],
      },
    ]);
    expect(b.coordinator.getStatus()).toMatchObject({
      state: 'needs_attention',
      openConflicts: 1,
      rejectedChanges: 1,
    });
    const conflictId = conflicts[0]?.conflictId;
    if (conflictId === undefined) throw new Error('A conflict is open.');
    // Keeping it deleted is refused while the Action still uses it; nothing changes.
    expect(await b.application.resolveConflict(conflictId, { choice: 'keep_deleted' })).toEqual({
      ok: false,
      code: 'still_referenced',
    });
    expect(await b.read(b.ref('project', project.id))).not.toBeNull();
    // Restoring pushes an explicit revision over the tombstone; the Action can then be retried.
    expect(await b.application.resolveConflict(conflictId, { choice: 'restore_edited' })).toEqual({
      ok: true,
      value: { queued: true },
    });
    await b.coordinator.syncNow();
    expect(server.records.get(`project:${project.id}`)?.deleted).toBe(false);
    expect(await b.application.retryRejected()).toBe(1);
    await b.coordinator.syncNow();
    await a.coordinator.syncNow();
    expect(server.records.get(`action:${child.id}`)?.revision).toBe(1);
    expect((await a.read(a.ref('project', project.id)))?.document['title']).toBe('Shared project');
    expect((await a.read(a.ref('action', child.id)))?.document['projectId']).toBe(project.id);
    expect(a.coordinator.getStatus()).toMatchObject({ state: 'synced', openConflicts: 0 });
    expect(b.coordinator.getStatus()).toMatchObject({ state: 'synced', openConflicts: 0 });
  });
});

describe('documents the local plan cannot hold', () => {
  it('wait for a person instead of stopping sync (a document the codecs refuse)', async () => {
    const { a, b, server } = await pair();
    await a.coordinator.syncNow();
    await b.coordinator.syncNow();
    // The server checks shapes but not every rule a record codec enforces (a blank title).
    const transport = server.transport();
    const entityId = 'a9000000-0000-4000-8000-000000000001';
    const pushed = await transport.push({
      protocolVersion: 1,
      replicaId: replicaA,
      mutationGroupId: 'a9000000-0000-4000-8000-000000000002',
      operations: [
        {
          operationId: 'a9000000-0000-4000-8000-000000000003',
          sequence: 0,
          entityType: 'action',
          entityId,
          kind: 'create',
          baseServerRevision: 0,
          baseSnapshotHash: null,
          document: actionDocument('   '),
        },
      ],
    });
    expect(pushed).toMatchObject({ ok: true, value: { status: 'accepted' } });
    const later = await a.create('action', actionDocument('After the refused one'));
    await a.coordinator.syncNow();
    await b.coordinator.syncNow();
    expect(await b.read(b.ref('action', entityId as UUID))).toBeNull();
    expect(await b.read(b.ref('action', later.id))).not.toBeNull();
    expect(b.coordinator.getStatus()).toMatchObject({ state: 'needs_attention', openConflicts: 1 });
    expect((await b.application.facts()).cursor).toBe(String(server.sequence));
    expect(await b.application.listConflicts()).toMatchObject([
      {
        entityId,
        kind: 'merge_conflict',
        local: { deleted: false, document: null },
        remote: { deleted: false, document: { title: '   ' } },
        choices: ['keep_local', 'keep_remote'],
      },
    ]);
  });

  it('keep a page of 120 refused documents as conflicts in one transaction, and move on', async () => {
    const { a, b, server } = await pair();
    await a.coordinator.syncNow();
    await b.coordinator.syncNow();
    const id = (prefix: string, index: number) =>
      `${prefix}000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
    const pushed = await server.transport().push({
      protocolVersion: 1,
      replicaId: replicaA,
      mutationGroupId: id('a8', 1),
      operations: Array.from({ length: 120 }, (_, index) => ({
        operationId: id('a7', index + 1),
        sequence: index,
        entityType: 'action' as const,
        entityId: id('a9', index + 1),
        kind: 'create' as const,
        baseServerRevision: 0,
        baseSnapshotHash: null,
        document: actionDocument('   '),
      })),
    });
    expect(pushed).toMatchObject({ ok: true, value: { status: 'accepted' } });
    // Count the transactions of every apply on B.
    const store = b.store;
    const run = store.runInTransaction.bind(store);
    let applying = false;
    const transactions: number[] = [];
    store.runInTransaction = <Result>(work: (unitOfWork: SyncUnitOfWork) => Promise<Result>) => {
      if (applying) transactions[transactions.length - 1] = (transactions.at(-1) ?? 0) + 1;
      return run(work);
    };
    const apply = b.application.applyPulledPages.bind(b.application);
    b.application.applyPulledPages = async (pages, options) => {
      applying = true;
      transactions.push(0);
      try {
        return await apply(pages, options);
      } finally {
        applying = false;
      }
    };
    await b.coordinator.syncNow();
    expect(transactions).toEqual([1]);
    expect((await b.application.facts()).cursor).toBe(String(server.sequence));
    expect(await b.application.listConflicts()).toHaveLength(120);
    expect(b.coordinator.getStatus()).toMatchObject({
      state: 'needs_attention',
      openConflicts: 120,
    });
    expect(await b.read(b.ref('action', id('a9', 1) as UUID))).toBeNull();
  });

  it('wait for a person when two devices fill a day past its three focus items', async () => {
    const { a, b, server } = await pair();
    const actions = [];
    for (const title of ['One', 'Two', 'Three', 'Four']) {
      actions.push(await a.create('action', actionDocument(title)));
    }
    await a.coordinator.syncNow();
    await b.coordinator.syncNow();
    const focus = (actionId: string, orderKey: string) => ({
      kind: 'day_focus',
      profileId,
      target: { kind: 'action', actionId },
      periodStart: '2026-10-03',
      periodEnd: '2026-10-03',
      orderKey,
    });
    const [one, two, three, four] = actions;
    if (one === undefined || two === undefined || three === undefined || four === undefined) {
      throw new Error('Four Actions exist.');
    }
    await a.create('focus_selection', { ...focus(one.id, 'a0') });
    await a.create('focus_selection', { ...focus(two.id, 'a1') });
    await b.create('focus_selection', { ...focus(three.id, 'a2') });
    await b.create('focus_selection', { ...focus(four.id, 'a3') });
    for (let round = 0; round < 3; round += 1) {
      await a.coordinator.syncNow();
      await b.coordinator.syncNow();
    }
    for (const replica of [a, b]) {
      const active = await replica.driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM focus_selections WHERE archived_at IS NULL;',
      );
      expect(active?.count).toBe(3);
      expect(replica.coordinator.getStatus()).toMatchObject({
        state: 'needs_attention',
        openConflicts: 1,
        pendingChanges: 0,
      });
      expect((await replica.application.facts()).cursor).toBe(String(server.sequence));
    }
  });
});

describe('expired cursor', () => {
  it('reconciles from the beginning and keeps every local record and queued change', async () => {
    const { a, b, server } = await pair();
    const kept = await a.create('action', actionDocument('Kept'));
    await a.coordinator.syncNow();
    await b.coordinator.syncNow();
    b.online = false;
    const queued = await b.create('action', actionDocument('Queued on B'));
    await a.update(kept, { title: 'Kept, renamed' });
    await a.coordinator.syncNow();
    server.compactLog();
    b.online = true;
    await b.coordinator.syncNow();
    expect((await b.read(b.ref('action', kept.id)))?.document['title']).toBe('Kept, renamed');
    expect(server.records.get(`action:${queued.id}`)?.revision).toBe(1);
    expect(b.coordinator.getStatus()).toMatchObject({ state: 'synced', pendingChanges: 0 });
    expect((await b.application.facts()).cursor).toBe(String(server.sequence));
  });
});
