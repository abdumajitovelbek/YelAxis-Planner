/**
 * inner ports for synchronization. The application owns them; the SQLite adapter implements
 * them with bounded, owner-scoped, prepared queries. A sync transaction is one SQLite transaction
 * that also exposes the ordinary planning capabilities, so canonical rows, minimized events, outbox
 * groups, sync metadata, conflicts, and the cursor always commit together.
 */
import type {
  CommandActor,
  CommandId,
  EntityRef,
  EntityType,
  Instant,
  OwnerId,
  UUID,
} from '@yelaxis/domain';

import type { PlanningUnitOfWork } from './ports';
import type {
  SyncConflictKind,
  SyncConflictSide,
  SyncDocument,
  SyncOperationKind,
  SyncOutboxState,
  SyncResolutionChoice,
} from './sync-contracts';

export interface SyncIdentity {
  readonly ownerId: OwnerId;
  readonly kind: 'local' | 'account';
  readonly replicaId: UUID | null;
  /** False while the first upload of a linked plan has not finished (`linked_at` is null). */
  readonly linked: boolean;
  readonly deletion: 'none' | 'pending';
}

/** One stored outbox operation; `position` is its local (insertion) order. */
export interface SyncStoredOperation {
  readonly position: number;
  readonly operationId: UUID;
  readonly mutationGroupId: UUID;
  readonly commandId: CommandId;
  readonly actor: CommandActor;
  readonly sequence: number;
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly kind: SyncOperationKind;
  readonly expectedRevision: number | null;
  readonly state: SyncOutboxState;
  readonly attemptCount: number;
  readonly nextAttemptAt: Instant | null;
  readonly baseServerRevision: number;
  readonly baseSnapshotHash: string | null;
  /** The intended document; null for a delete (its payload is a content-free tombstone). */
  readonly document: SyncDocument | null;
}

export interface SyncBaseSnapshot {
  readonly serverRevision: number;
  readonly hash: string;
  readonly document: SyncDocument;
}

/** A deletion-ledger entry: the record was permanently deleted on this replica. */
export interface SyncDeletionRecord {
  readonly serverRevision: number;
  /** The local revision the deletion produced (its tombstone revision). */
  readonly localRevision: number;
}

/** Stored conflict candidates (`sync_conflicts.candidate_payload_json`, version 1). */
export interface SyncConflictPayload {
  readonly v: 1;
  readonly origin: 'this_device' | 'other_device';
  readonly base: SyncDocument | null;
  readonly local: SyncConflictSide;
  readonly remote: SyncConflictSide;
  /** Conflicting field-group keys. */
  readonly fields: readonly string[];
  /** Mutation groups held by this conflict when it opened. */
  readonly blockedGroups: readonly UUID[];
  /** Server conflict candidates this conflict answers; closed after resolution. */
  readonly serverConflictIds: readonly UUID[];
  /** Server candidates already closed. */
  readonly closedServerIds?: readonly UUID[];
  /** `pending` until every server candidate is closed; then raw candidates are cleared. */
  readonly closure: 'none' | 'pending' | 'done';
  readonly resolution?: SyncResolutionChoice;
}

export interface SyncStoredConflict {
  readonly conflictId: UUID;
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly kind: SyncConflictKind;
  readonly state: 'open' | 'resolved' | 'superseded';
  readonly baseServerRevision: number;
  /** The server revision a resolution pushes from (the remote candidate's revision). */
  readonly remoteServerRevision: number;
  readonly payload: SyncConflictPayload;
  readonly createdAt: Instant;
  readonly resolutionStrategy?: string;
  readonly resolvedAt?: Instant;
}

/** A foreign-key reference left unsatisfied inside the current transaction. */
export interface SyncDanglingReference {
  /** The referencing record, when its table maps to a synced entity. */
  readonly child: { readonly entityType: EntityType; readonly entityId: UUID } | null;
  /** The missing referenced record, when its table maps to a synced entity. */
  readonly parent: { readonly entityType: EntityType; readonly entityId: UUID } | null;
}

export interface SyncCheckpoint {
  readonly cursor: string | null;
  readonly lastSuccessAt: Instant | null;
}

export interface SyncOutboxCounts {
  readonly byState: Readonly<Partial<Record<SyncOutboxState, number>>>;
  readonly nextAttemptAt: Instant | null;
  /** Operations sent at least once without a definite answer (pending, sending, retry_wait). */
  readonly unconfirmed: number;
}

/** Sync capabilities bound to one open transaction. */
export interface SyncTransactionStore {
  identity(): Promise<SyncIdentity | null>;

  /* Outbox */
  outboxCounts(ownerId: OwnerId): Promise<SyncOutboxCounts>;
  /** Live synced records, and those the server has acknowledged (first-upload progress). */
  uploadProgress(ownerId: OwnerId): Promise<{ readonly uploaded: number; readonly total: number }>;
  /** Unacknowledged, undropped operations in local order, from `fromPosition` (inclusive). */
  scanOutbox(
    ownerId: OwnerId,
    fromPosition: number,
    limit: number,
  ): Promise<readonly SyncStoredOperation[]>;
  /** Every unacknowledged, undropped operation of one record, in local order. */
  operationsForEntity(
    ownerId: OwnerId,
    ref: Pick<EntityRef, 'type' | 'id'>,
  ): Promise<readonly SyncStoredOperation[]>;
  /** The undropped operations of one group (any state), in sequence order. */
  readGroup(ownerId: OwnerId, mutationGroupId: UUID): Promise<readonly SyncStoredOperation[]>;
  setGroupState(
    ownerId: OwnerId,
    mutationGroupId: UUID,
    update: {
      readonly from: readonly SyncOutboxState[];
      readonly state: SyncOutboxState;
      readonly attemptCount?: number;
      readonly nextAttemptAt?: Instant | null;
    },
    now: Instant,
  ): Promise<number>;
  /** Move every operation in `from` to `state` (owner-wide recovery and retries). */
  setStateWhere(
    ownerId: OwnerId,
    update: {
      readonly from: SyncOutboxState;
      readonly state: SyncOutboxState;
      readonly nextAttemptAt: Instant | null;
      /** A rejected group was never applied: its retry is not unconfirmed. */
      readonly resetAttempts?: boolean;
    },
    now: Instant,
  ): Promise<number>;
  /** Rewrite a never-applied operation in place (rebase); ids never change. */
  rewriteOperation(
    ownerId: OwnerId,
    operationId: UUID,
    update: {
      readonly document?: SyncDocument;
      readonly baseServerRevision?: number;
      readonly baseSnapshotHash?: string | null;
    },
    now: Instant,
  ): Promise<void>;
  /**
   * Every queued operation on these records (any unacknowledged state) now pushes from the given
   * acknowledged revision and document hash (null after a delete).
   */
  rebaseQueuedOperations(
    ownerId: OwnerId,
    bases: readonly {
      readonly entityType: EntityType;
      readonly entityId: UUID;
      readonly serverRevision: number;
      readonly hash: string | null;
    }[],
    now: Instant,
  ): Promise<number>;
  /** Superseded local intents: removed and never sent. */
  dropOperations(ownerId: OwnerId, operationIds: readonly UUID[], now: Instant): Promise<void>;
  /** Acknowledged operations are removed (compacted): an accepted operation is never resent. */
  acknowledgeOperations(
    ownerId: OwnerId,
    operationIds: readonly UUID[],
    now: Instant,
  ): Promise<void>;

  /* Record sync metadata */
  /** Set a live row's `server_revision` and `base_snapshot_hash`; never its local revision. */
  setRecordSyncBase(ref: EntityRef, serverRevision: number, hash: string | null): Promise<void>;
  readBaseSnapshot(ref: EntityRef): Promise<SyncBaseSnapshot | null>;
  writeBaseSnapshot(ref: EntityRef, snapshot: SyncBaseSnapshot, now: Instant): Promise<void>;
  deleteBaseSnapshot(ref: EntityRef): Promise<void>;
  readDeletion(ref: EntityRef): Promise<SyncDeletionRecord | null>;
  setDeletionServerRevision(ref: EntityRef, serverRevision: number, now: Instant): Promise<void>;
  /** A tombstone for a record this replica never held: remembered so it cannot resurrect. */
  recordRemoteDeletion(ref: EntityRef, serverRevision: number, now: Instant): Promise<void>;
  /** Forget a ledger entry before an explicit restore (Restore edited). */
  clearDeletion(ref: EntityRef): Promise<void>;
  /** The Profile row a fresh account replica receives from its account (codecs never create it). */
  createProfileFromRemote(ref: EntityRef, document: SyncDocument, now: Instant): Promise<void>;
  /** True when the document satisfies its record codec's schema. */
  validateDocument(entityType: EntityType, document: SyncDocument): boolean;
  /**
   * True when a failed write means the local plan refuses this record (its codec, a constraint, or
   * a rule the database enforces), as opposed to a failure of the store itself.
   */
  isRecordRefusal(error: unknown): boolean;
  /** Unsatisfied references among the given entity types' tables and their referrers. */
  danglingReferences(scope: {
    readonly written: readonly EntityType[];
    readonly deleted: readonly EntityType[];
  }): Promise<readonly SyncDanglingReference[]>;

  /* Conflicts */
  openConflicts(ownerId: OwnerId): Promise<readonly SyncStoredConflict[]>;
  readConflict(ownerId: OwnerId, conflictId: UUID): Promise<SyncStoredConflict | null>;
  /** Resolved conflicts whose server candidates are not closed yet. */
  conflictsAwaitingClosure(ownerId: OwnerId): Promise<readonly SyncStoredConflict[]>;
  /** Conflicts (any state) that answer one server candidate. */
  conflictsForServerId(
    ownerId: OwnerId,
    serverConflictId: UUID,
  ): Promise<readonly SyncStoredConflict[]>;
  insertConflict(ownerId: OwnerId, conflict: SyncStoredConflict, now: Instant): Promise<void>;
  updateConflict(
    ownerId: OwnerId,
    conflictId: UUID,
    update: {
      readonly state?: 'open' | 'resolved' | 'superseded';
      readonly payload?: SyncConflictPayload;
      readonly resolutionStrategy?: string;
      readonly resolvedAt?: Instant;
    },
    now: Instant,
  ): Promise<void>;

  /* Cursor */
  readCheckpoint(ownerId: OwnerId, replicaId: UUID): Promise<SyncCheckpoint>;
  writeCheckpoint(
    ownerId: OwnerId,
    replicaId: UUID,
    update: { readonly cursor: string | null; readonly lastSuccessAt?: Instant },
    now: Instant,
  ): Promise<void>;
}

export interface SyncUnitOfWork extends PlanningUnitOfWork {
  readonly sync: SyncTransactionStore;
}

export interface SyncStorePort {
  /**
   * Capabilities are valid only while `work` runs; a thrown error rolls every write back. Foreign
   * keys are checked when the transaction commits.
   */
  runInTransaction<T>(work: (unitOfWork: SyncUnitOfWork) => Promise<T>): Promise<T>;
}

/** Hash of a converged document; identical on every replica and on the server. */
export interface SyncDocumentHasher {
  hash(document: SyncDocument): Promise<string>;
}
