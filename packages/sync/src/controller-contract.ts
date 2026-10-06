/**
 * The sync and conflict parts of the web-facing account contract, structurally
 * identical to `apps/web/src/account/account-service.ts` (the web package depends on this one, so
 * the types are repeated here rather than imported). The coordinator implements `SyncController`
 * and `createConflictService` implements `ConflictService`.
 */

/** A local-only identity is always `local_only`. */
export type SyncStateName =
  | 'local_only'
  | 'signing_in'
  | 'first_upload'
  | 'syncing'
  | 'queued_offline'
  | 'synced'
  | 'needs_attention'
  | 'auth_expired'
  | 'server_unavailable'
  | 'deletion_pending';

export interface SyncStatus {
  readonly state: SyncStateName;
  /** The build has account configuration; without it accounts are not offered. */
  readonly configured: boolean;
  /** The signed-in account, for display only. */
  readonly account?: { readonly email: string };
  /** Queued operations not yet acknowledged. */
  readonly pendingChanges: number;
  readonly openConflicts: number;
  /** Groups the server rejected (schema, ownership): they wait for a person, never retried blindly. */
  readonly rejectedChanges: number;
  readonly lastSyncedAt?: string;
  /** When the next automatic retry runs after a transient failure. */
  readonly nextAttemptAt?: string;
  /** Present while the first upload of a linked local plan runs. */
  readonly firstUpload?: { readonly uploaded: number; readonly total: number };
}

export interface SyncController {
  getStatus(): SyncStatus;
  /** Called after every status change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Push then pull now; resolves when the cycle ends (never rejects). */
  syncNow(): Promise<void>;
  /**
   * A person retries the changes the account did not accept, with the same ids; resolves when the
   * following cycle ends and never rejects.
   */
  retryRejected(): Promise<void>;
}

export type AccountResult<Value = void> =
  | { readonly ok: true; readonly value: Value }
  /** `message` is calm, safe copy for the person; never planning content or a credential. */
  | { readonly ok: false; readonly code: string; readonly message: string };

/** One side of a conflicting field group, as display text (never raw JSON). */
export interface ConflictFieldView {
  readonly field: string;
  readonly label: string;
  readonly base?: string;
  readonly local?: string;
  readonly remote?: string;
}

export interface ConflictSummaryView {
  readonly conflictId: string;
  readonly kindLabel: string;
  /** The record's title from either side, or a neutral label such as "An Action". */
  readonly title: string;
  readonly kind:
    | 'stale_base'
    | 'edit_versus_delete'
    | 'delete_versus_edit'
    | 'create_collision'
    | 'merge_conflict';
  readonly createdAt: string;
}

export interface ConflictDetailView extends ConflictSummaryView {
  readonly fields: readonly ConflictFieldView[];
  /** The choices this conflict offers. */
  readonly choices: readonly (
    'keep_local' | 'keep_remote' | 'merge' | 'keep_deleted' | 'restore_edited'
  )[];
}

export type ConflictChoice =
  | { readonly choice: 'keep_local' | 'keep_remote' | 'keep_deleted' | 'restore_edited' }
  /** Merge details: for every conflicting field, which side to keep. */
  | { readonly choice: 'merge'; readonly fields: Readonly<Record<string, 'local' | 'remote'>> };

export interface ConflictService {
  list(): Promise<readonly ConflictSummaryView[]>;
  get(conflictId: string): Promise<ConflictDetailView | null>;
  resolve(conflictId: string, choice: ConflictChoice): Promise<AccountResult>;
}
