/**
 * Sync protocol v1. These runtime
 * schemas are the single description of what the client sends to and receives from the server
 * functions `sync_push`, `sync_pull`, `sync_open_conflicts`, and `sync_close_conflict`. Every
 * response is parsed before use; an unparseable response is a transport failure, never data.
 *
 * Owners never travel in payloads: the server binds every row to `auth.uid()`. Documents are the
 * record-codec documents (no owner, no sync metadata); a delete carries no document.
 */
import { z } from 'zod';

import { createSnapshotHasher } from './hasher';

export const syncProtocolVersion = 1;

/** Canonical entity types that replicate. Identity rows and local sync bookkeeping never do. */
export const syncEntityTypes = [
  'profile',
  'axis',
  'outcome',
  'milestone',
  'project',
  'action',
  'note',
  'commitment',
  'time_block',
  'routine',
  'routine_occurrence',
  'routine_action_defaults',
  'template',
  'review',
  'review_item',
  'reminder',
  'context',
  'constraint',
  'planning_placement',
  'focus_selection',
  'theme',
  'direction',
  'project_secondary_outcome',
  'milestone_project',
  'milestone_action',
] as const;
export type SyncEntityType = (typeof syncEntityTypes)[number];

export const syncLimits = Object.freeze({
  /** Operations in one pushed mutation group. */
  operationsPerGroup: 500,
  /** Changes in one pulled page. */
  changesPerPage: 500,
  /** Serialized size of one document. */
  documentBytes: 64 * 1024,
  /** Serialized size of one push request. */
  requestBytes: 2 * 1024 * 1024,
});

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().regex(/^\d{1,19}$/u);
const document = z.record(z.string(), z.unknown());
const entityType = z.enum(syncEntityTypes);

export const pushOperationSchema = z.strictObject({
  operationId: uuid,
  sequence: z
    .number()
    .int()
    .min(0)
    .max(syncLimits.operationsPerGroup - 1),
  entityType,
  entityId: uuid,
  kind: z.enum(['create', 'update', 'delete']),
  /** Server revision the local intent was made from (0 for a create). */
  baseServerRevision: revision,
  /** Hash of the last converged document; null for a create. */
  baseSnapshotHash: z.string().min(1).max(128).nullable(),
  /** The full codec document for create and update; null for delete. */
  document: document.nullable(),
});
export type PushOperation = z.infer<typeof pushOperationSchema>;

export const pushRequestSchema = z.strictObject({
  protocolVersion: z.literal(syncProtocolVersion),
  replicaId: uuid,
  mutationGroupId: uuid,
  operations: z.array(pushOperationSchema).min(1).max(syncLimits.operationsPerGroup),
});
export type PushRequest = z.infer<typeof pushRequestSchema>;

export const conflictKinds = [
  /** The record changed on the server after the local base. */
  'stale_base',
  /** A local edit against a record the server deleted. */
  'edit_versus_delete',
  /** A local delete against a record edited on the server after the local base. */
  'delete_versus_edit',
  /** A different create with an id that already exists for this owner. */
  'create_collision',
] as const;
export type ConflictKind = (typeof conflictKinds)[number];

export const remoteCandidateSchema = z.strictObject({
  serverRevision: revision,
  deleted: z.boolean(),
  /** The current server document; null when deleted. */
  document: document.nullable(),
});
export type RemoteCandidate = z.infer<typeof remoteCandidateSchema>;

export const pushConflictSchema = z.strictObject({
  conflictId: uuid,
  operationId: uuid,
  entityType,
  entityId: uuid,
  kind: z.enum(conflictKinds),
  baseServerRevision: revision,
  remote: remoteCandidateSchema,
});
export type PushConflict = z.infer<typeof pushConflictSchema>;

export const pushRejectionCodes = [
  'invalid_payload',
  'unsupported_protocol',
  'limit_exceeded',
  'schema_mismatch',
  'missing_reference',
  'deletion_pending',
] as const;
export type PushRejectionCode = (typeof pushRejectionCodes)[number];

export const pushResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('accepted'),
    mutationGroupId: uuid,
    acknowledgments: z.array(
      z.strictObject({
        operationId: uuid,
        entityType,
        entityId: uuid,
        serverRevision: revision,
      }),
    ),
    /** The change cursor after this group. */
    cursor,
  }),
  z.strictObject({
    status: z.literal('conflict'),
    mutationGroupId: uuid,
    conflicts: z.array(pushConflictSchema).min(1),
  }),
  z.strictObject({
    status: z.literal('rejected'),
    mutationGroupId: uuid,
    code: z.enum(pushRejectionCodes),
    /** The first offending operation, when one is to blame. */
    operationId: uuid.optional(),
    /** A safe request id for diagnostics; never planning content. */
    requestId: z.string().max(64).optional(),
  }),
]);
export type PushResponse = z.infer<typeof pushResponseSchema>;

export const pullRequestSchema = z.strictObject({
  protocolVersion: z.literal(syncProtocolVersion),
  replicaId: uuid,
  /** Changes strictly after this cursor; null reads from the beginning. */
  afterCursor: cursor.nullable(),
  limit: z.number().int().min(1).max(syncLimits.changesPerPage),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const pulledChangeSchema = z.strictObject({
  cursor,
  entityType,
  entityId: uuid,
  serverRevision: revision.min(1),
  deleted: z.boolean(),
  /** The current server document; null for a tombstone. */
  document: document.nullable(),
});
export type PulledChange = z.infer<typeof pulledChangeSchema>;

export const pullResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('page'),
    /** In cursor order; at most one change per record (its latest state). */
    changes: z.array(pulledChangeSchema).max(syncLimits.changesPerPage),
    nextCursor: cursor,
    hasMore: z.boolean(),
  }),
  /** The cursor is older than retained history: reconcile from the start, never reset locally. */
  z.strictObject({ status: z.literal('cursor_expired') }),
]);
export type PullResponse = z.infer<typeof pullResponseSchema>;

/** A conflict candidate the server keeps for the owner until it is closed. */
export const serverConflictSchema = z.strictObject({
  conflictId: uuid,
  entityType,
  entityId: uuid,
  kind: z.enum(conflictKinds),
  baseServerRevision: revision,
  /** The candidate this replica or another one pushed; null for a delete. */
  local: z.strictObject({ deleted: z.boolean(), document: document.nullable() }),
  remote: remoteCandidateSchema,
  blockedMutationGroupId: uuid,
  createdAt: z.string(),
});
export type ServerConflict = z.infer<typeof serverConflictSchema>;

export const closeConflictRequestSchema = z.strictObject({
  conflictId: uuid,
  resolution: z.enum(['keep_local', 'keep_remote', 'merge', 'keep_deleted', 'restore_edited']),
});
export type CloseConflictRequest = z.infer<typeof closeConflictRequestSchema>;

/** Why a transport call did not reach a usable answer. Never planning content. */
export type TransportFailure =
  | { readonly kind: 'offline' }
  | { readonly kind: 'unavailable'; readonly status?: number }
  | { readonly kind: 'auth_expired' }
  | { readonly kind: 'invalid_response' };

export type TransportResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: TransportFailure };

/** The network side of sync. The Supabase adapter implements it; tests use fakes. */
export interface SyncTransport {
  push(request: PushRequest): Promise<TransportResult<PushResponse>>;
  pull(request: PullRequest): Promise<TransportResult<PullResponse>>;
  openConflicts(): Promise<TransportResult<readonly ServerConflict[]>>;
  closeConflict(request: CloseConflictRequest): Promise<TransportResult<{ readonly closed: true }>>;
}

/** `account_status()`: what the account holds, for the first-upload and deletion previews. */
export const accountStatusResponseSchema = z.strictObject({
  /** Live (non-deleted) records of this owner, by entity type. */
  recordCounts: z.partialRecord(entityType, z.number().int().min(0)),
  recordCount: z.number().int().min(0),
  deletion: z.enum(['none', 'pending']),
});
export type AccountStatusResponse = z.infer<typeof accountStatusResponseSchema>;

/**
 * `account_delete()`: deletes every row of this owner (records, change log, receipts, conflicts,
 * replicas) and the sign-in account, idempotently.
 */
export const accountDeleteResponseSchema = z.strictObject({
  status: z.enum(['deleted', 'already_deleted']),
});
export type AccountDeleteResponse = z.infer<typeof accountDeleteResponseSchema>;

/**
 * Canonical JSON of a document is defined once, by the application's merge rules;
 * the base snapshot hash is the SHA-256 of that text (`createSnapshotHasher`). The server and every
 * client hash exactly this text.
 */
export { canonicalJson } from '@yelaxis/application';

/** The base snapshot hash: lowercase hex SHA-256 of the UTF-8 canonical JSON (Web Crypto). */
export function documentHash(document: Readonly<Record<string, unknown>>): Promise<string> {
  return createSnapshotHasher().hash(document);
}
