/**
 * Maps protocol v1 (`protocol.ts`) to the application's sync contracts and back. Requests are
 * validated before they leave this device; a group that cannot form a valid request is rejected
 * locally (it would be rejected by the server too) instead of being retried.
 */
import type {
  SyncOutgoingGroup,
  SyncPulledPage,
  SyncPushOutcome,
  SyncServerConflict,
  SyncTransientReason,
} from '@yelaxis/application';
import type { UUID } from '@yelaxis/domain';

import {
  pushRequestSchema,
  syncLimits,
  syncProtocolVersion,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type ServerConflict,
  type TransportFailure,
  type TransportResult,
} from './protocol';

export type PushRequestResult =
  | { readonly ok: true; readonly request: PushRequest }
  | { readonly ok: false; readonly code: 'invalid_payload' | 'limit_exceeded' };

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

export function toPushRequest(group: SyncOutgoingGroup): PushRequestResult {
  if (group.operations.length > syncLimits.operationsPerGroup) {
    return { ok: false, code: 'limit_exceeded' };
  }
  for (const operation of group.operations) {
    if (operation.document !== null && byteLength(operation.document) > syncLimits.documentBytes) {
      return { ok: false, code: 'limit_exceeded' };
    }
  }
  const candidate = {
    protocolVersion: syncProtocolVersion,
    replicaId: group.replicaId,
    mutationGroupId: group.mutationGroupId,
    operations: group.operations.map((operation) => ({
      operationId: operation.operationId,
      sequence: operation.sequence,
      entityType: operation.entityType,
      entityId: operation.entityId,
      kind: operation.kind,
      baseServerRevision: operation.baseServerRevision,
      baseSnapshotHash: operation.baseSnapshotHash,
      document: operation.document,
    })),
  };
  const parsed = pushRequestSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: 'invalid_payload' };
  if (byteLength(parsed.data) > syncLimits.requestBytes)
    return { ok: false, code: 'limit_exceeded' };
  return { ok: true, request: parsed.data };
}

function transientReason(failure: TransportFailure): SyncTransientReason {
  switch (failure.kind) {
    case 'offline':
      return 'offline';
    case 'invalid_response':
      return 'invalid_response';
    case 'auth_expired':
    case 'unavailable':
      return 'unavailable';
  }
}

export function toPushOutcome(result: TransportResult<PushResponse>): SyncPushOutcome {
  if (!result.ok) {
    return result.failure.kind === 'auth_expired'
      ? { kind: 'auth_expired' }
      : { kind: 'transient', reason: transientReason(result.failure) };
  }
  const response = result.value;
  switch (response.status) {
    case 'accepted':
      return {
        kind: 'accepted',
        cursor: response.cursor,
        acknowledgments: response.acknowledgments.map((item) => ({
          operationId: item.operationId as UUID,
          entityType: item.entityType,
          entityId: item.entityId as UUID,
          serverRevision: item.serverRevision,
        })),
      };
    case 'conflict':
      return {
        kind: 'conflict',
        conflicts: response.conflicts.map((conflict) => ({
          serverConflictId: conflict.conflictId as UUID,
          operationId: conflict.operationId as UUID,
          entityType: conflict.entityType,
          entityId: conflict.entityId as UUID,
          kind: conflict.kind,
          baseServerRevision: conflict.baseServerRevision,
          remote: {
            serverRevision: conflict.remote.serverRevision,
            deleted: conflict.remote.deleted,
            document: conflict.remote.deleted ? null : conflict.remote.document,
          },
        })),
      };
    case 'rejected':
      if (response.code === 'deletion_pending') return { kind: 'deletion_pending' };
      // A newer protocol is needed: wait (the app updates), never dead-letter every group.
      if (response.code === 'unsupported_protocol') {
        return { kind: 'transient', reason: 'unavailable' };
      }
      return { kind: 'rejected', code: response.code };
  }
}

export function toPulledPage(response: Extract<PullResponse, { status: 'page' }>): SyncPulledPage {
  return {
    nextCursor: response.nextCursor,
    hasMore: response.hasMore,
    changes: response.changes.map((change) => ({
      cursor: change.cursor,
      entityType: change.entityType,
      entityId: change.entityId as UUID,
      serverRevision: change.serverRevision,
      deleted: change.deleted,
      document: change.deleted ? null : change.document,
    })),
  };
}

export function toServerConflict(conflict: ServerConflict): SyncServerConflict {
  return {
    serverConflictId: conflict.conflictId as UUID,
    entityType: conflict.entityType,
    entityId: conflict.entityId as UUID,
    kind: conflict.kind,
    baseServerRevision: conflict.baseServerRevision,
    local: {
      deleted: conflict.local.deleted,
      document: conflict.local.deleted ? null : conflict.local.document,
    },
    remote: {
      serverRevision: conflict.remote.serverRevision,
      deleted: conflict.remote.deleted,
      document: conflict.remote.deleted ? null : conflict.remote.document,
    },
    blockedMutationGroupId: conflict.blockedMutationGroupId as UUID,
  };
}
