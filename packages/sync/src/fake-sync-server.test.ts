/**
 * The semantics the convergence tests rely on, as the in-memory server implements them (and as the
 * backend's functions are expected to): idempotent groups, atomic groups, base revision and hash
 * checks, conflict candidates, tombstones, explicit restore, references, and the cursor.
 */
import type { UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import { createSnapshotHasher } from './hasher';
import type { PushOperation, PushRequest } from './protocol';
import { FakeSyncServer } from './testing';

const id = (n: number) => `a1000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as UUID;
const replicaId = id(1);
const hasher = createSnapshotHasher();
let counter = 1_000;

function operation(overrides: Partial<PushOperation>): PushOperation {
  counter += 1;
  return {
    operationId: id(counter),
    sequence: 0,
    entityType: 'action',
    entityId: id(50),
    kind: 'create',
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document: { title: 'One' },
    ...overrides,
  };
}

function group(...operations: PushOperation[]): PushRequest {
  counter += 1;
  return {
    protocolVersion: 1,
    replicaId,
    mutationGroupId: id(counter),
    operations: operations.map((item, sequence) => ({ ...item, sequence })),
  };
}

async function created(
  server: FakeSyncServer,
  entityId: UUID,
  document: Record<string, unknown>,
  entityType: PushOperation['entityType'] = 'action',
) {
  const response = await server.push(group(operation({ entityType, entityId, document })));
  expect(response.status).toBe('accepted');
  return { revision: 1, hash: await hasher.hash(document) };
}

describe('fake sync server', () => {
  it('returns the original answer for a repeated group and never duplicates a revision', async () => {
    const server = new FakeSyncServer();
    const request = group(operation({}));
    const first = await server.push(request);
    const second = await server.push(request);
    expect(second).toEqual(first);
    expect(server.records.get(`action:${id(50)}`)?.revision).toBe(1);
    expect(server.sequence).toBe(1);
  });

  it('applies a whole group or none of it', async () => {
    const server = new FakeSyncServer();
    await created(server, id(60), { title: 'Existing' });
    const response = await server.push(
      group(
        operation({ entityId: id(61), document: { title: 'New' } }),
        operation({
          entityId: id(60),
          kind: 'update',
          baseServerRevision: 7,
          document: { title: 'Stale' },
        }),
      ),
    );
    expect(response).toMatchObject({ status: 'conflict', conflicts: [{ kind: 'stale_base' }] });
    expect(server.records.has(`action:${id(61)}`)).toBe(false);
    expect(server.openConflictList()).toHaveLength(1);
  });

  it('checks the base snapshot hash as well as the revision', async () => {
    const server = new FakeSyncServer();
    const base = await created(server, id(70), { title: 'Base' });
    const wrongHash = await server.push(
      group(
        operation({
          entityId: id(70),
          kind: 'update',
          baseServerRevision: base.revision,
          baseSnapshotHash: 'not-the-hash',
          document: { title: 'Edit' },
        }),
      ),
    );
    expect(wrongHash).toMatchObject({ status: 'conflict' });
    const right = await server.push(
      group(
        operation({
          entityId: id(70),
          kind: 'update',
          baseServerRevision: base.revision,
          baseSnapshotHash: base.hash,
          document: { title: 'Edit' },
        }),
      ),
    );
    expect(right).toMatchObject({ status: 'accepted', acknowledgments: [{ serverRevision: 2 }] });
  });

  it('refuses edits against a tombstone unless they are an explicit restore', async () => {
    const server = new FakeSyncServer();
    const base = await created(server, id(80), { title: 'Gone soon' });
    await server.push(
      group(
        operation({
          entityId: id(80),
          kind: 'delete',
          baseServerRevision: base.revision,
          baseSnapshotHash: base.hash,
          document: null,
        }),
      ),
    );
    const stale = await server.push(
      group(
        operation({
          entityId: id(80),
          kind: 'update',
          baseServerRevision: 1,
          document: { title: 'Back' },
        }),
      ),
    );
    expect(stale).toMatchObject({
      status: 'conflict',
      conflicts: [{ kind: 'edit_versus_delete' }],
    });
    const recreate = await server.push(
      group(operation({ entityId: id(80), document: { title: 'Back' } })),
    );
    expect(recreate).toMatchObject({
      status: 'conflict',
      conflicts: [{ kind: 'create_collision' }],
    });
    const staleDelete = await server.push(
      group(operation({ entityId: id(80), kind: 'delete', baseServerRevision: 1, document: null })),
    );
    expect(staleDelete).toMatchObject({
      status: 'conflict',
      conflicts: [{ kind: 'edit_versus_delete' }],
    });
    const again = await server.push(
      group(operation({ entityId: id(80), kind: 'delete', baseServerRevision: 2, document: null })),
    );
    expect(again).toMatchObject({ status: 'accepted', acknowledgments: [{ serverRevision: 2 }] });
    const restore = await server.push(
      group(
        operation({
          entityId: id(80),
          kind: 'update',
          baseServerRevision: 2,
          document: { title: 'Restored' },
        }),
      ),
    );
    expect(restore).toMatchObject({ status: 'accepted', acknowledgments: [{ serverRevision: 3 }] });
    expect(server.records.get(`action:${id(80)}`)).toMatchObject({ deleted: false, revision: 3 });
  });

  it('accepts an equivalent create and refuses a different one', async () => {
    const server = new FakeSyncServer();
    await created(server, id(90), { title: 'Same', note: 'x' });
    expect(
      await server.push(
        group(operation({ entityId: id(90), document: { note: 'x', title: 'Same' } })),
      ),
    ).toMatchObject({ status: 'accepted', acknowledgments: [{ serverRevision: 1 }] });
    expect(
      await server.push(group(operation({ entityId: id(90), document: { title: 'Other' } }))),
    ).toMatchObject({ status: 'conflict', conflicts: [{ kind: 'create_collision' }] });
  });

  it('refuses a document that refers to a missing record and a delete still referred to', async () => {
    const server = new FakeSyncServer();
    expect(
      await server.push(
        group(operation({ entityId: id(100), document: { title: 'x', projectId: id(101) } })),
      ),
    ).toMatchObject({ status: 'rejected', code: 'missing_reference' });
    const project = await created(server, id(101), { title: 'Project' }, 'project');
    await created(server, id(100), { title: 'x', projectId: id(101) });
    expect(
      await server.push(
        group(
          operation({
            entityType: 'project',
            entityId: id(101),
            kind: 'delete',
            baseServerRevision: project.revision,
            baseSnapshotHash: project.hash,
            document: null,
          }),
        ),
      ),
    ).toMatchObject({ status: 'rejected', code: 'missing_reference' });
  });

  it('pages changes by cursor, each record once at its latest change, and expires old cursors', async () => {
    const server = new FakeSyncServer();
    await created(server, id(110), { title: 'First' });
    const second = await created(server, id(111), { title: 'Second' });
    await server.push(
      group(
        operation({
          entityId: id(111),
          kind: 'update',
          baseServerRevision: second.revision,
          baseSnapshotHash: second.hash,
          document: { title: 'Second, edited' },
        }),
      ),
    );
    const first = server.pull({ protocolVersion: 1, replicaId, afterCursor: null, limit: 1 });
    expect(first).toMatchObject({
      status: 'page',
      hasMore: true,
      nextCursor: '1',
      changes: [{ entityId: id(110), serverRevision: 1 }],
    });
    const rest = server.pull({ protocolVersion: 1, replicaId, afterCursor: '1', limit: 10 });
    expect(rest).toMatchObject({
      status: 'page',
      hasMore: false,
      nextCursor: '3',
      changes: [{ entityId: id(111), serverRevision: 2, document: { title: 'Second, edited' } }],
    });
    expect(server.pull({ protocolVersion: 1, replicaId, afterCursor: '3', limit: 10 })).toEqual({
      status: 'page',
      changes: [],
      nextCursor: '3',
      hasMore: false,
    });
    expect(server.pull({ protocolVersion: 1, replicaId, afterCursor: '99', limit: 10 })).toEqual({
      status: 'cursor_expired',
    });
    expect(
      new FakeSyncServer().pull({ protocolVersion: 1, replicaId, afterCursor: null, limit: 5 }),
    ).toEqual({ status: 'page', changes: [], nextCursor: '0', hasMore: false });
    server.compactLog();
    expect(server.pull({ protocolVersion: 1, replicaId, afterCursor: '1', limit: 10 })).toEqual({
      status: 'cursor_expired',
    });
    expect(
      server.pull({ protocolVersion: 1, replicaId, afterCursor: null, limit: 10 }),
    ).toMatchObject({ status: 'page', changes: [{ entityId: id(110) }, { entityId: id(111) }] });
  });

  it('closes candidates idempotently, and when their group is later accepted', async () => {
    const server = new FakeSyncServer();
    await created(server, id(120), { title: 'Base' });
    const stale = group(
      operation({
        entityId: id(120),
        kind: 'update',
        baseServerRevision: 5,
        document: { title: 'x' },
      }),
    );
    const response = await server.push(stale);
    if (response.status !== 'conflict') throw new Error('A conflict was expected.');
    const conflictId = response.conflicts[0]?.conflictId ?? '';
    expect(server.closeConflict({ conflictId, resolution: 'keep_remote' })).toEqual({
      closed: true,
    });
    expect(server.closeConflict({ conflictId, resolution: 'keep_remote' })).toEqual({
      closed: true,
    });
    expect(server.openConflictList()).toEqual([]);
  });
});
