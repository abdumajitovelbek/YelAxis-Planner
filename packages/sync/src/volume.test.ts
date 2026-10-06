/**
 * (account sync share): 10,000 Actions upload in groups of at most 500 operations and reach a
 * fresh replica in bounded pages, each page applied in its own short transaction, while commands
 * keep committing between sync steps.
 */
import type { UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { ManualTime, ownerId, Replica, removeReplicaFiles } from './__fixtures__/replica';
import type { PullRequest, PushRequest, SyncTransport } from './protocol';
import { FakeSyncServer } from './testing';

const replicaA = 'a1000000-0000-4000-8000-000000000001' as UUID;
const replicaB = 'b1000000-0000-4000-8000-000000000001' as UUID;
const count = 10_000;

const open: Replica[] = [];

afterEach(async () => {
  for (const replica of open.splice(0)) await replica.close();
  removeReplicaFiles();
});

function observed(transport: SyncTransport) {
  const pushes: number[] = [];
  const pulls: { limit: number; changes: number }[] = [];
  const wrapped: SyncTransport = {
    push(request: PushRequest) {
      pushes.push(request.operations.length);
      return transport.push(request);
    },
    async pull(request: PullRequest) {
      const result = await transport.pull(request);
      pulls.push({
        limit: request.limit,
        changes: result.ok && result.value.status === 'page' ? result.value.changes.length : 0,
      });
      return result;
    },
    openConflicts: () => transport.openConflicts(),
    closeConflict: (request) => transport.closeConflict(request),
  };
  return { wrapped, pushes, pulls };
}

describe('10,000 Actions', () => {
  it('push and pull in bounded pages and converge', { timeout: 240_000 }, async () => {
    const server = new FakeSyncServer({ checkReferences: false });
    const time = new ManualTime();
    const upload = observed(server.transport());
    const download = observed(server.transport());
    const a = await Replica.open({
      name: 'A',
      replicaId: replicaA,
      transport: upload.wrapped,
      time,
      withProfile: true,
    });
    const b = await Replica.open({
      name: 'B',
      replicaId: replicaB,
      transport: download.wrapped,
      time,
    });
    open.push(a, b);

    // A linked plan with 10,000 Actions, queued as ordinary create groups.
    const now = time.instant();
    const ids: UUID[] = [];
    await a.driver.transaction(async (transaction) => {
      for (let index = 0; index < count; index += 1) {
        const id = a.nextId();
        ids.push(id);
        await transaction.run(
          `INSERT INTO actions (
             id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at
           ) VALUES (?, ?, ?, 'inbox', 'import', ?, ?, ?);`,
          [
            id,
            ownerId,
            `Action ${String(index)}`,
            `a${index.toString(36).padStart(4, '0')}`,
            now,
            now,
          ],
        );
      }
    });
    await a.queueInitialUpload(ids.map((id) => a.ref('action', id)));

    const pushStarted = performance.now();
    await a.coordinator.syncNow();
    const pushMs = performance.now() - pushStarted;
    expect(a.coordinator.getStatus()).toMatchObject({ state: 'synced', pendingChanges: 0 });
    expect(Math.max(...upload.pushes)).toBeLessThanOrEqual(500);
    expect(upload.pushes.reduce((sum, item) => sum + item, 0)).toBe(count + 1);
    expect(await a.outboxRows()).toBe(0);

    // A command commits between B's sync steps (sync never holds the store).
    const pullStarted = performance.now();
    const syncing = b.coordinator.syncNow();
    const local = b.create('action', {
      title: 'Captured while syncing',
      captureOrigin: 'global_capture',
      orderKey: 'zz',
      state: 'inbox',
    });
    await Promise.all([syncing, local]);
    const pullMs = performance.now() - pullStarted;
    await b.coordinator.syncNow();

    expect(download.pulls.every((pull) => pull.limit <= 500 && pull.changes <= pull.limit)).toBe(
      true,
    );
    expect(download.pulls.length).toBeGreaterThanOrEqual(Math.ceil((count + 1) / 500));
    const rows = await b.driver.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM actions WHERE owner_id = ?;',
      [ownerId],
    );
    expect(rows?.total).toBe(count + 1);
    const sample = ids[count - 1];
    if (sample === undefined) throw new Error('An Action was created.');
    expect((await b.read(b.ref('action', sample)))?.document).toEqual(
      (await a.read(a.ref('action', sample)))?.document,
    );
    expect(b.coordinator.getStatus()).toMatchObject({ state: 'synced', pendingChanges: 0 });
    // Generous bounds: they catch accidental quadratic work, not machine speed.
    expect(pushMs).toBeLessThan(120_000);
    expect(pullMs).toBeLessThan(120_000);
  });
});
