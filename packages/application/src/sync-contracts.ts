/**
 * Synchronization use-case contracts.
 * These types are protocol-neutral: the sync package maps the wire protocol onto them, and the
 * application owns every write they cause. Documents are record-codec documents with no owner and
 * no sync metadata.
 */
import type { EntityType, Instant, OwnerId, UUID } from '@yelaxis/domain';

export type SyncDocument = Readonly<Record<string, unknown>>;
export type SyncOperationKind = 'create' | 'update' | 'delete';
export type SyncOutboxState =
  'pending' | 'sending' | 'retry_wait' | 'blocked_conflict' | 'acknowledged' | 'dead_letter';

/** One operation of a claimed group, with the base it is pushed from. */
export interface SyncOutgoingOperation {
  readonly operationId: UUID;
  /** Position in the pushed request (0-based, contiguous). */
  readonly sequence: number;
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly kind: SyncOperationKind;
  /** Server revision the intent was made from (0 for a create). */
  readonly baseServerRevision: number;
  /** Hash of the last converged document; null for a create or over a tombstone. */
  readonly baseSnapshotHash: string | null;
  /** The full document for create and update; null for delete. */
  readonly document: SyncDocument | null;
}

/** One complete mutation group, claimed (`sending`) for one push. */
export interface SyncOutgoingGroup {
  readonly mutationGroupId: UUID;
  readonly replicaId: UUID;
  /** Attempts including this one. */
  readonly attempt: number;
  readonly operations: readonly SyncOutgoingOperation[];
}

export interface SyncRemoteCandidate {
  readonly serverRevision: number;
  readonly deleted: boolean;
  /** The server document; null when deleted. */
  readonly document: SyncDocument | null;
}

/** Conflict kinds the server reports for a push (protocol v1). */
export type SyncServerConflictKind =
  'stale_base' | 'edit_versus_delete' | 'delete_versus_edit' | 'create_collision';

/** Local conflict kinds: the server kinds plus a pull-time three-way conflict. */
export type SyncConflictKind = SyncServerConflictKind | 'merge_conflict';

export interface SyncAcknowledgment {
  readonly operationId: UUID;
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly serverRevision: number;
}

export interface SyncPushConflict {
  readonly serverConflictId: UUID;
  readonly operationId: UUID;
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly kind: SyncServerConflictKind;
  readonly baseServerRevision: number;
  readonly remote: SyncRemoteCandidate;
}

/** Why a push did not reach a definite answer. Never planning content. */
export type SyncTransientReason = 'offline' | 'unavailable' | 'invalid_response';

/** What happened to one pushed group. */
export type SyncPushOutcome =
  | {
      readonly kind: 'accepted';
      readonly acknowledgments: readonly SyncAcknowledgment[];
      readonly cursor: string;
    }
  | { readonly kind: 'conflict'; readonly conflicts: readonly SyncPushConflict[] }
  /** Schema, ownership, reference, or limit rejection: waits for a person (`dead_letter`). */
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'transient'; readonly reason: SyncTransientReason }
  | { readonly kind: 'auth_expired' }
  /** The account is being deleted: pushes are frozen, the group waits unchanged. */
  | { readonly kind: 'deletion_pending' };

export type SyncPushRecordResult =
  | { readonly status: 'acknowledged' }
  /** Every conflict merged without a person; the rebased group is ready again. */
  | { readonly status: 'merged' }
  | { readonly status: 'blocked'; readonly conflicts: number }
  | { readonly status: 'dead_letter' }
  | { readonly status: 'retry_wait'; readonly nextAttemptAt: Instant }
  /** Expired session or pending deletion: the group is pending again with the same ids. */
  | { readonly status: 'paused' }
  /** The group was not being sent (already recorded or recovered); nothing changed. */
  | { readonly status: 'stale' };

export interface SyncPulledChange {
  readonly cursor: string;
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly serverRevision: number;
  readonly deleted: boolean;
  /** The current server document; null for a tombstone. */
  readonly document: SyncDocument | null;
}

export interface SyncPulledPage {
  readonly changes: readonly SyncPulledChange[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export interface SyncPullOptions {
  /**
   * Preserve changes whose references stay unsatisfied as conflicts even though more pages are
   * waiting (the caller cannot hold more pages in memory).
   */
  readonly preserveUnsatisfied?: boolean;
}

export type SyncPullApplyResult =
  | {
      readonly status: 'applied';
      /** The cursor stored with the applied pages. */
      readonly cursor: string;
      /** The last page said nothing more was waiting. */
      readonly caughtUp: boolean;
      readonly applied: number;
      readonly merged: number;
      readonly conflicts: number;
      readonly unchanged: number;
      /** Merges queued new groups to push with the remote base. */
      readonly queuedPushes: boolean;
    }
  /** These pages reference records a later page may hold: pull the next page and retry them all. */
  | { readonly status: 'needs_more' }
  /** A group was sent without a definite answer; push it again before pulling. */
  | { readonly status: 'not_ready' }
  /**
   * A change can be neither applied nor kept as a Conflict on this device (the cursor stays): the
   * pages need attention, not a server retry.
   */
  | { readonly status: 'refused' }
  /** The store failed while applying (nothing was kept); try again later. */
  | { readonly status: 'failed' };

/** Facts the coordinator turns into a visible state. */
export interface SyncFacts {
  /** `none`: no identity; `linking`: the first upload has not finished. */
  readonly link: 'none' | 'local' | 'linking' | 'linked';
  readonly ownerId?: OwnerId;
  readonly replicaId?: UUID;
  readonly deletion: 'none' | 'pending';
  /** Operations waiting to be sent (state `pending`). */
  readonly pending: number;
  readonly sending: number;
  /** Operations waiting after a transient failure (`retry_wait`). */
  readonly waiting: number;
  readonly nextAttemptAt?: Instant;
  /** Operations held by an open conflict (`blocked_conflict`). */
  readonly blocked: number;
  /** Operations the server rejected (`dead_letter`); never retried blindly. */
  readonly rejected: number;
  /** Operations sent at least once without a definite answer; pulls wait for them. */
  readonly unconfirmed: number;
  readonly openConflicts: number;
  readonly lastSuccessAt?: Instant;
  readonly cursor: string | null;
  /** Present while linking: acknowledged and total operations of the first upload. */
  readonly firstUpload?: { readonly uploaded: number; readonly total: number };
}

export type SyncResolutionChoice =
  'keep_local' | 'keep_remote' | 'merge' | 'keep_deleted' | 'restore_edited';

export type SyncResolution =
  | { readonly choice: Exclude<SyncResolutionChoice, 'merge'> }
  /** Merge details: for every conflicting field group, which side to keep. */
  | {
      readonly choice: 'merge';
      readonly fields: Readonly<Record<string, 'local' | 'remote'>>;
    };

export interface SyncConflictSide {
  readonly deleted: boolean;
  readonly document: SyncDocument | null;
}

/** A record a version of a conflict links to, as this device knows it (display only). */
export interface SyncConflictLink {
  readonly entityType: EntityType;
  /** `here`: a live record on this device; `deleted`: deleted here; `missing`: never held here. */
  readonly presence: 'here' | 'deleted' | 'missing';
  /** Its title on this device, when it is here and has one. */
  readonly title?: string;
}

/** A conflict as the person compares it: this device's state against the other candidate. */
export interface SyncConflictView {
  readonly conflictId: UUID;
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly kind: SyncConflictKind;
  /** `other_device`: an unsaved candidate another device left on the server. */
  readonly origin: 'this_device' | 'other_device';
  readonly createdAt: Instant;
  /** The last converged document, when known. */
  readonly base: SyncDocument | null;
  /** This device's current version. */
  readonly local: SyncConflictSide;
  /** The other version. */
  readonly remote: SyncConflictSide;
  /** Conflicting field-group keys (see `syncFieldGroups`). */
  readonly fields: readonly string[];
  readonly choices: readonly SyncResolutionChoice[];
  /**
   * The records the base, local, and remote versions link to, by id (`getConflict` only), so each
   * version can say which record it links to without showing an id.
   */
  readonly links?: Readonly<Record<string, SyncConflictLink>>;
}

/** A conflict candidate the server keeps until it is closed (`sync_open_conflicts`). */
export interface SyncServerConflict {
  readonly serverConflictId: UUID;
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly kind: SyncServerConflictKind;
  readonly baseServerRevision: number;
  /** The candidate a replica pushed; null document for a delete. */
  readonly local: SyncConflictSide;
  readonly remote: SyncRemoteCandidate;
  readonly blockedMutationGroupId: UUID;
}

export interface SyncPendingClosure {
  readonly serverConflictId: UUID;
  readonly resolution: SyncResolutionChoice;
}

export type SyncErrorCode =
  | 'no_account'
  | 'not_found'
  | 'not_open'
  | 'invalid_choice'
  | 'invalid_merge'
  | 'still_referenced'
  /** A change to the record was sent without an answer yet: resolve after the next sync. */
  | 'not_ready'
  | 'transaction_failed';

export type SyncResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly code: SyncErrorCode };

export interface SyncApplication {
  /** Status facts: queue states, conflicts, cursor, link and deletion state. */
  facts(): Promise<SyncFacts>;
  /** Restart recovery: `sending` groups return to `pending` with the same ids. */
  recoverStranded(): Promise<number>;
  /** Waiting groups become due now (online, launch, "Sync now"); ids never change. */
  retryNow(): Promise<number>;
  /** A person's explicit retry of rejected groups, with the same ids. */
  retryRejected(): Promise<number>;
  /** The next ready group in local order, marked `sending`; null when nothing is ready. */
  claimNextGroup(): Promise<SyncOutgoingGroup | null>;
  recordPushOutcome(mutationGroupId: UUID, outcome: SyncPushOutcome): Promise<SyncPushRecordResult>;
  /** Apply pulled pages and advance the cursor in one transaction. */
  applyPulledPages(
    pages: readonly SyncPulledPage[],
    options?: SyncPullOptions,
  ): Promise<SyncPullApplyResult>;
  /** An expired cursor: reconcile from the beginning. Local records are never reset. */
  restartFromBeginning(): Promise<void>;
  /** Server conflict candidates this replica has not seen yet become local conflicts. */
  mergeServerConflicts(conflicts: readonly SyncServerConflict[]): Promise<number>;
  /** Resolved conflicts whose server candidates still need closing. */
  pendingServerClosures(): Promise<readonly SyncPendingClosure[]>;
  confirmServerClosure(serverConflictId: UUID): Promise<void>;
  listConflicts(): Promise<readonly SyncConflictView[]>;
  getConflict(conflictId: UUID): Promise<SyncConflictView | null>;
  /** Every resolution is a new command, pushed with the latest base. */
  resolveConflict(
    conflictId: UUID,
    resolution: SyncResolution,
  ): Promise<SyncResult<{ readonly queued: boolean }>>;
}
