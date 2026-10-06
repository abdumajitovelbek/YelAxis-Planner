import type { SyncOutgoingGroup } from '@yelaxis/application';
import type { UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import { toPulledPage, toPushOutcome, toPushRequest, toServerConflict } from './protocol-mapping';
import { syncLimits } from './protocol';

const id = (n: number) => `a1000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as UUID;

function group(operations: number, document: Record<string, unknown> = { title: 'x' }) {
  return {
    mutationGroupId: id(1),
    replicaId: id(2),
    attempt: 1,
    operations: Array.from({ length: operations }, (_, index) => ({
      operationId: id(100 + index),
      sequence: index,
      entityType: 'action' as const,
      entityId: id(10_000 + index),
      kind: 'update' as const,
      baseServerRevision: 3,
      baseSnapshotHash: 'abc',
      document,
    })),
  } satisfies SyncOutgoingGroup;
}

describe('push requests', () => {
  it('carry one complete group in order with protocol version 1', () => {
    const result = toPushRequest(group(2));
    expect(result).toMatchObject({
      ok: true,
      request: {
        protocolVersion: 1,
        replicaId: id(2),
        mutationGroupId: id(1),
        operations: [{ sequence: 0 }, { sequence: 1 }],
      },
    });
  });

  it('are refused locally when they break the limits or the schema', () => {
    expect(toPushRequest(group(syncLimits.operationsPerGroup + 1))).toEqual({
      ok: false,
      code: 'limit_exceeded',
    });
    expect(toPushRequest(group(1, { text: 'x'.repeat(syncLimits.documentBytes) }))).toEqual({
      ok: false,
      code: 'limit_exceeded',
    });
    const broken = group(1);
    expect(toPushRequest({ ...broken, replicaId: 'not-a-uuid' as UUID })).toEqual({
      ok: false,
      code: 'invalid_payload',
    });
  });
});

describe('push answers', () => {
  it('map transport failures without content', () => {
    expect(toPushOutcome({ ok: false, failure: { kind: 'offline' } })).toEqual({
      kind: 'transient',
      reason: 'offline',
    });
    expect(toPushOutcome({ ok: false, failure: { kind: 'unavailable', status: 503 } })).toEqual({
      kind: 'transient',
      reason: 'unavailable',
    });
    expect(toPushOutcome({ ok: false, failure: { kind: 'invalid_response' } })).toEqual({
      kind: 'transient',
      reason: 'invalid_response',
    });
    expect(toPushOutcome({ ok: false, failure: { kind: 'auth_expired' } })).toEqual({
      kind: 'auth_expired',
    });
  });

  it('map rejections: deletion pending pauses, an old protocol waits, the rest dead-letter', () => {
    const rejected = (code: 'deletion_pending' | 'unsupported_protocol' | 'schema_mismatch') =>
      toPushOutcome({
        ok: true,
        value: { status: 'rejected', mutationGroupId: id(1), code },
      });
    expect(rejected('deletion_pending')).toEqual({ kind: 'deletion_pending' });
    expect(rejected('unsupported_protocol')).toEqual({ kind: 'transient', reason: 'unavailable' });
    expect(rejected('schema_mismatch')).toEqual({ kind: 'rejected', code: 'schema_mismatch' });
  });

  it('map acknowledgments and conflicts', () => {
    expect(
      toPushOutcome({
        ok: true,
        value: {
          status: 'accepted',
          mutationGroupId: id(1),
          acknowledgments: [
            { operationId: id(3), entityType: 'action', entityId: id(4), serverRevision: 2 },
          ],
          cursor: '9',
        },
      }),
    ).toEqual({
      kind: 'accepted',
      cursor: '9',
      acknowledgments: [
        { operationId: id(3), entityType: 'action', entityId: id(4), serverRevision: 2 },
      ],
    });
    expect(
      toPushOutcome({
        ok: true,
        value: {
          status: 'conflict',
          mutationGroupId: id(1),
          conflicts: [
            {
              conflictId: id(5),
              operationId: id(3),
              entityType: 'action',
              entityId: id(4),
              kind: 'edit_versus_delete',
              baseServerRevision: 1,
              remote: { serverRevision: 2, deleted: true, document: { leftover: true } },
            },
          ],
        },
      }),
    ).toEqual({
      kind: 'conflict',
      conflicts: [
        {
          serverConflictId: id(5),
          operationId: id(3),
          entityType: 'action',
          entityId: id(4),
          kind: 'edit_versus_delete',
          baseServerRevision: 1,
          remote: { serverRevision: 2, deleted: true, document: null },
        },
      ],
    });
  });
});

describe('pulled pages and server candidates', () => {
  it('drop documents of tombstones', () => {
    expect(
      toPulledPage({
        status: 'page',
        nextCursor: '12',
        hasMore: true,
        changes: [
          {
            cursor: '11',
            entityType: 'note',
            entityId: id(6),
            serverRevision: 4,
            deleted: true,
            document: null,
          },
        ],
      }),
    ).toEqual({
      nextCursor: '12',
      hasMore: true,
      changes: [
        {
          cursor: '11',
          entityType: 'note',
          entityId: id(6),
          serverRevision: 4,
          deleted: true,
          document: null,
        },
      ],
    });
    expect(
      toServerConflict({
        conflictId: id(7),
        entityType: 'action',
        entityId: id(4),
        kind: 'stale_base',
        baseServerRevision: 1,
        local: { deleted: false, document: { title: 'mine' } },
        remote: { serverRevision: 3, deleted: false, document: { title: 'theirs' } },
        blockedMutationGroupId: id(8),
        createdAt: '2026-10-01T09:00:00Z',
      }),
    ).toMatchObject({
      serverConflictId: id(7),
      local: { deleted: false, document: { title: 'mine' } },
      remote: { serverRevision: 3 },
      blockedMutationGroupId: id(8),
    });
  });
});
