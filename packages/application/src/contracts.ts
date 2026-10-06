import type {
  CommandActor,
  CommandId,
  DeletionTombstone,
  DomainError,
  DomainEventDraft,
  EntityRef,
  Instant,
  OwnerId,
  UndoDescriptorDraft,
  UUID,
} from '@yelaxis/domain';

export interface ExpectedRevision {
  readonly ref: EntityRef;
  readonly revision: number;
}

/** Every mutation is bound to an active owner and a stable idempotency key. */
export interface CommandEnvelope<TInput> {
  readonly commandId: CommandId;
  readonly ownerId: OwnerId;
  readonly actor: CommandActor;
  readonly expectedRevisions: readonly ExpectedRevision[];
  readonly input: TInput;
  /** Consumes one persisted inverse command atomically with this command. */
  readonly consumesUndoId?: UUID;
}

export interface CanonicalRecordState {
  readonly ref: EntityRef;
  readonly localRevision: number;
  readonly serverRevision: number;
  readonly baseSnapshotHash: string | null;
  readonly document: Readonly<Record<string, unknown>>;
}

interface CanonicalMutationBase {
  readonly ref: EntityRef;
  readonly baseServerRevision: number;
  readonly baseSnapshotHash: string | null;
}

export type CanonicalMutation =
  | (CanonicalMutationBase & {
      readonly operation: 'create';
      readonly expectedRevision: null;
      readonly document: Readonly<Record<string, unknown>>;
    })
  | (CanonicalMutationBase & {
      readonly operation: 'update';
      readonly expectedRevision: number;
      readonly document: Readonly<Record<string, unknown>>;
    })
  | (CanonicalMutationBase & {
      readonly operation: 'delete';
      readonly expectedRevision: number;
      /** Content-free permanent-deletion record; never a copy of the deleted document. */
      readonly tombstone: DeletionTombstone;
    });

export interface AppliedCanonicalChange {
  readonly ref: EntityRef;
  readonly operation: CanonicalMutation['operation'];
  readonly localRevision: number;
}

export interface DomainEventRecord {
  readonly eventId: UUID;
  readonly ownerId: OwnerId;
  readonly event: DomainEventDraft;
}

export interface UndoDescriptorRecord {
  readonly undoId: UUID;
  readonly ownerId: OwnerId;
  readonly commandId: CommandId;
  readonly createdAt: Instant;
  readonly descriptor: UndoDescriptorDraft;
}

export interface StoredUndoDescriptor extends UndoDescriptorRecord {
  readonly localRevision: number;
  readonly state: 'available';
}

export interface OutboxOperation {
  readonly operationId: UUID;
  readonly mutationGroupId: UUID;
  readonly sequence: number;
  readonly state: 'pending';
  readonly attemptCount: 0;
  readonly nextAttemptAt: Instant;
  readonly mutation: CanonicalMutation;
}

export interface OutboxMutationGroup {
  readonly mutationGroupId: UUID;
  readonly ownerId: OwnerId;
  readonly commandId: CommandId;
  readonly actor: CommandActor;
  readonly createdAt: Instant;
  readonly operations: readonly OutboxOperation[];
}

export type UndoAvailability =
  { readonly available: false } | { readonly available: true; readonly undoId: UUID };

export type SyncQueueReceipt =
  | { readonly queued: false }
  | {
      readonly queued: true;
      readonly mutationGroupId: UUID;
      readonly operationIds: readonly UUID[];
    };

export interface CommandReceipt {
  readonly commandId: CommandId;
  readonly ownerId: OwnerId;
  readonly actor: CommandActor;
  readonly acceptedAt: Instant;
  readonly canonical: readonly {
    readonly ref: EntityRef;
    readonly localRevision: number;
  }[];
  readonly eventIds: readonly UUID[];
  readonly undo: UndoAvailability;
  readonly sync: SyncQueueReceipt;
}

export interface ProjectionInvalidation {
  readonly commandId: CommandId;
  readonly ownerId: OwnerId;
  readonly committedAt: Instant;
  readonly touched: readonly EntityRef[];
}

export type InvalidCommandPlanReason =
  | 'duplicate_expected_revision'
  | 'duplicate_mutation'
  | 'duplicate_touched_ref'
  | 'event_context_mismatch'
  | 'invalid_expected_revision'
  | 'invalid_sync_base'
  | 'invalid_delete_tombstone'
  | 'missing_audit_event'
  | 'missing_canonical_change'
  | 'missing_entity_audit_event'
  | 'missing_expected_revision'
  | 'permanent_delete_not_undoable'
  | 'touched_change_mismatch'
  | 'undo_revision_mismatch';

export type ApplicationError =
  | { readonly code: 'domain_rejected'; readonly domainError: DomainError }
  | { readonly code: 'entity_already_exists'; readonly ref: EntityRef }
  | { readonly code: 'entity_not_found'; readonly ref: EntityRef }
  | { readonly code: 'identity_unavailable' }
  | {
      readonly code: 'invalid_command_plan';
      readonly reason: InvalidCommandPlanReason;
      readonly ref?: EntityRef;
    }
  | { readonly code: 'no_active_identity' }
  | { readonly code: 'owner_mismatch' }
  | {
      readonly code: 'revision_conflict';
      readonly ref: EntityRef;
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | { readonly code: 'transaction_failed' }
  | { readonly code: 'undo_unavailable' };

export type ApplicationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApplicationError };
