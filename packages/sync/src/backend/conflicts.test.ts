import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import type { PushRequest } from '../protocol';
import {
  closeConflict,
  create,
  createTestUser,
  deleteTestUsers,
  documents,
  group,
  openConflicts,
  pushAccepted,
  pushConflict,
  pushRejected,
  queryDatabase,
  rpc,
  update,
  type TestUser,
} from './stack';

afterAll(async () => {
  await deleteTestUsers();
});

async function staleConflict(user: TestUser) {
  const actionId = randomUUID();
  const original = documents.action('Original');
  const remote = { ...original, title: 'Remote edit' };
  const local = { ...original, title: 'Local edit' };
  await pushAccepted(user.client, group([create('action', actionId, original)]));
  await pushAccepted(
    user.client,
    group([update('action', actionId, { revision: 1, document: original }, remote)]),
  );
  const request = group([update('action', actionId, { revision: 1, document: original }, local)]);
  const response = await pushConflict(user.client, request);
  const [conflict] = response.conflicts;
  if (conflict === undefined) throw new Error('Expected a conflict.');
  return { actionId, original, remote, local, request, conflict };
}

describe('sync conflicts', () => {
  it('lists every open conflict with its base, both candidates, and the blocked group', async () => {
    const user = await createTestUser('conflicts-list');
    const started = Date.now();
    const { actionId, remote, local, request, conflict } = await staleConflict(user);
    const listed = await openConflicts(user.client);
    expect(listed).toEqual([
      {
        conflictId: conflict.conflictId,
        entityType: 'action',
        entityId: actionId,
        kind: 'stale_base',
        baseServerRevision: 1,
        local: { deleted: false, document: local },
        remote: { serverRevision: 2, deleted: false, document: remote },
        blockedMutationGroupId: request.mutationGroupId,
        createdAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
        ) as string,
      },
    ]);
    const createdAt = Date.parse(listed[0]?.createdAt ?? '');
    expect(Math.abs(createdAt - started)).toBeLessThan(5 * 60_000);
  });

  it('keeps one conflict for every conflicting operation of a group and lets unrelated groups continue', async () => {
    const user = await createTestUser('conflicts-group');
    const [x, y, z] = [randomUUID(), randomUUID(), randomUUID()];
    const document = documents.axis();
    await pushAccepted(
      user.client,
      group([
        create('axis', x, document),
        create('axis', y, document),
        create('axis', z, document),
      ]),
    );
    const edited = { ...document, title: 'Edited' };
    await pushAccepted(
      user.client,
      group([
        update('axis', x, { revision: 1, document }, edited),
        update('axis', y, { revision: 1, document }, edited),
      ]),
    );
    const blocked = await pushConflict(
      user.client,
      group([
        update('axis', x, { revision: 1, document }, { ...document, title: 'Late x' }),
        update('axis', y, { revision: 1, document }, { ...document, title: 'Late y' }),
      ]),
    );
    expect(blocked.conflicts.map((conflict) => conflict.entityId)).toEqual([x, y]);
    expect((await openConflicts(user.client)).map((conflict) => conflict.entityId).sort()).toEqual(
      [x, y].sort(),
    );
    const unrelated = await pushAccepted(
      user.client,
      group([update('axis', z, { revision: 1, document }, edited)]),
    );
    expect(unrelated.acknowledgments[0]?.serverRevision).toBe(2);
  });

  it('closes a conflict idempotently and clears its candidates', async () => {
    const user = await createTestUser('conflicts-close');
    const { conflict } = await staleConflict(user);
    expect(
      await closeConflict(user.client, {
        conflictId: conflict.conflictId,
        resolution: 'keep_local',
      }),
    ).toEqual({ closed: true });
    expect(
      await closeConflict(user.client, {
        conflictId: conflict.conflictId,
        resolution: 'keep_local',
      }),
    ).toEqual({ closed: true });
    expect(
      await closeConflict(user.client, { conflictId: conflict.conflictId, resolution: 'merge' }),
    ).toEqual({ closed: true });
    expect(await openConflicts(user.client)).toEqual([]);
    const [stored] = queryDatabase<Record<string, unknown>>(
      `select state, resolution, local_document is null as local_cleared,
              remote_document is null as remote_cleared, closed_at is not null as closed
         from yelaxis_sync.conflicts where conflict_id = '${conflict.conflictId}'`,
    );
    expect(stored).toEqual({
      state: 'resolved',
      resolution: 'keep_local',
      local_cleared: true,
      remote_cleared: true,
      closed: true,
    });
  });

  it('accepts every resolution of the protocol', async () => {
    const user = await createTestUser('conflicts-resolutions');
    for (const resolution of [
      'keep_local',
      'keep_remote',
      'merge',
      'keep_deleted',
      'restore_edited',
    ] as const) {
      const { conflict } = await staleConflict(user);
      expect(
        await closeConflict(user.client, { conflictId: conflict.conflictId, resolution }),
      ).toEqual({ closed: true });
    }
    expect(await openConflicts(user.client)).toEqual([]);
  });

  it('supersedes an open conflict when the same group meets a newer remote', async () => {
    const user = await createTestUser('conflicts-supersede');
    const { actionId, remote, request, conflict } = await staleConflict(user);
    const newer = { ...remote, title: 'Newer remote' };
    await pushAccepted(
      user.client,
      group([update('action', actionId, { revision: 2, document: remote }, newer)]),
    );
    const retried = await pushConflict(user.client, request);
    const [replacement] = retried.conflicts;
    expect(replacement?.conflictId).not.toBe(conflict.conflictId);
    expect(replacement?.remote).toEqual({ serverRevision: 3, deleted: false, document: newer });
    expect((await openConflicts(user.client)).map((item) => item.conflictId)).toEqual([
      replacement?.conflictId,
    ]);
    const [old] = queryDatabase<Record<string, unknown>>(
      `select state, resolution, local_document is null and remote_document is null as cleared
         from yelaxis_sync.conflicts where conflict_id = '${conflict.conflictId}'`,
    );
    expect(old).toEqual({ state: 'superseded', resolution: null, cleared: true });
    // Closing a superseded conflict is a no-op.
    expect(
      await closeConflict(user.client, {
        conflictId: conflict.conflictId,
        resolution: 'keep_remote',
      }),
    ).toEqual({ closed: true });
  });

  it('refuses a replayed conflicting operation that carries anything else, and keeps its conflict', async () => {
    const user = await createTestUser('conflicts-replay');
    const { original, local, request, conflict } = await staleConflict(user);
    const [operation] = request.operations;
    if (operation === undefined) throw new Error('Expected an operation.');
    // A second record with the same stale base, so a replay naming it would conflict as well.
    const otherId = randomUUID();
    await pushAccepted(user.client, group([create('action', otherId, original)]));
    await pushAccepted(
      user.client,
      group([
        update(
          'action',
          otherId,
          { revision: 1, document: original },
          { ...original, title: 'Remote edit' },
        ),
      ]),
    );
    const replays: readonly (readonly [string, PushRequest])[] = [
      [
        'another local document',
        {
          ...request,
          operations: [{ ...operation, document: { ...local, title: 'Other local edit' } }],
        },
      ],
      ['another record', { ...request, operations: [{ ...operation, entityId: otherId }] }],
      ['a delete', { ...request, operations: [{ ...operation, kind: 'delete', document: null }] }],
      ['another base', { ...request, operations: [{ ...operation, baseServerRevision: 0 }] }],
      ['another group', { ...request, mutationGroupId: randomUUID() }],
    ];
    for (const [label, replay] of replays) {
      expect(await pushRejected(user.client, replay), label).toMatchObject({
        code: 'invalid_payload',
        operationId: operation.operationId,
      });
    }
    // Nothing was superseded or added: the conflict keeps its own local candidate.
    const open = await openConflicts(user.client);
    expect(open.map((item) => item.conflictId)).toEqual([conflict.conflictId]);
    expect(open[0]?.local).toEqual({ deleted: false, document: local });
    expect(
      queryDatabase<{ state: string; conflicts: number }>(
        `select state, count(*)::int as conflicts from yelaxis_sync.conflicts
          where owner_id = '${user.id}' group by state`,
      ),
    ).toEqual([{ state: 'open', conflicts: 1 }]);
    // The same operation still finds its conflict.
    const again = await pushConflict(user.client, request);
    expect(again.conflicts.map((item) => item.conflictId)).toEqual([conflict.conflictId]);
  });

  it('takes back an operation the client rebased onto the remote after a merge', async () => {
    const user = await createTestUser('conflicts-rebase');
    const { actionId, remote, request, conflict } = await staleConflict(user);
    const [operation] = request.operations;
    if (operation === undefined) throw new Error('Expected an operation.');
    // The client merges its change into the remote document and rewrites the same operation in
    // the same group onto the remote's revision (`rewriteOperation`).
    const merged = { ...remote, note: 'Merged on this device' };
    const rebasedOnto = (revision: number, document: Record<string, unknown>) =>
      group(
        [
          {
            ...update('action', actionId, { revision, document }, merged),
            operationId: operation.operationId,
          },
        ],
        { mutationGroupId: request.mutationGroupId },
      );
    // The remote moved again meanwhile: the rebased operation supersedes its conflict.
    const newer = { ...remote, title: 'Newer remote' };
    await pushAccepted(
      user.client,
      group([update('action', actionId, { revision: 2, document: remote }, newer)]),
    );
    const again = await pushConflict(user.client, rebasedOnto(2, remote));
    const [superseding] = again.conflicts;
    expect(superseding?.conflictId).not.toBe(conflict.conflictId);
    expect(superseding?.remote).toEqual({ serverRevision: 3, deleted: false, document: newer });
    // Rebased onto the current remote, it applies.
    const accepted = await pushAccepted(user.client, rebasedOnto(3, newer));
    expect(accepted.acknowledgments[0]?.serverRevision).toBe(4);
  });

  it('refuses to close an unknown conflict or another owner’s', async () => {
    const user = await createTestUser('conflicts-owner');
    const other = await createTestUser('conflicts-other');
    const { conflict } = await staleConflict(user);
    for (const [client, conflictId] of [
      [user.client, randomUUID()],
      [other.client, conflict.conflictId],
    ] as const) {
      const outcome = await rpc(client, 'sync_close_conflict', {
        request: { conflictId, resolution: 'keep_remote' },
      });
      expect(outcome).toMatchObject({ status: 404, code: 'PT404', data: null });
    }
    expect((await openConflicts(user.client)).map((item) => item.conflictId)).toEqual([
      conflict.conflictId,
    ]);
    expect(await openConflicts(other.client)).toEqual([]);
  });

  it('rejects malformed close requests', async () => {
    const user = await createTestUser('conflicts-malformed');
    const { conflict } = await staleConflict(user);
    const requests: readonly unknown[] = [
      null,
      { conflictId: conflict.conflictId },
      { conflictId: conflict.conflictId, resolution: 'last_write_wins' },
      { conflictId: 'conflict-1', resolution: 'keep_local' },
      { conflictId: conflict.conflictId, resolution: 'keep_local', extra: true },
    ];
    for (const request of requests) {
      const outcome = await rpc(user.client, 'sync_close_conflict', { request });
      expect(outcome, JSON.stringify(request)).toMatchObject({
        status: 400,
        code: '22023',
        data: null,
      });
    }
    expect(await openConflicts(user.client)).toHaveLength(1);
  });
});
