/**
 * account sync web-facing contract for account, sync, and conflicts. The UI renders these
 * services; the identity part implements `AccountService`, and the sync part implements
 * `SyncController` and `ConflictService`. Planning data never flows through them: they report
 * counts, states, and choices, and every change still runs through application commands.
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

export interface CountsByKind {
  /** Kind label (for example "Actions") to count, in display order. */
  readonly kinds: readonly { readonly label: string; readonly count: number }[];
  readonly total: number;
}

/** shown before a local plan's first upload. */
export interface FirstUploadPreview {
  readonly accountEmail: string;
  readonly local: CountsByKind;
  /** Records already in the account (0 for a new account). */
  readonly cloudRecordCount: number;
  /** Sensitive Context entries that would upload (the person is told before confirming). */
  readonly sensitiveContextCount: number;
}

/** What signing in leads to. */
export type SignInOutcome =
  /** The account's own copy on this device opened (or was created and pulled). */
  | { readonly kind: 'opened_account' }
  /** This device has a local plan with data: the person chooses to upload it or not. */
  | { readonly kind: 'choose_first_upload'; readonly preview: FirstUploadPreview };

export interface SignOutFacts {
  readonly pendingChanges: number;
  readonly openConflicts: number;
  readonly lastSyncedAt?: string;
}

export interface DeletionPreview {
  readonly accountEmail: string;
  readonly cloud: CountsByKind;
  readonly local: CountsByKind;
  readonly pendingChanges: number;
}

export interface ExportFile {
  readonly fileName: string;
  readonly blob: Blob;
  readonly recordCount: number;
  /** True when some local changes had not reached the account yet (stated in the file too). */
  readonly syncWasPending: boolean;
}

/**
 * The outcome of an account operation that switched the open plan. The view that started it is
 * gone by then (the app rebuilds every view on the new plan), so the outcome is held here and shown
 * once, where the person is after the switch.
 */
export interface AccountNotice {
  readonly key: number;
  readonly text: string;
  /** An outcome is polite; a failure is announced assertively. */
  readonly tone: 'status' | 'alert';
}

/** One-shot notices, kept outside the views a store switch replaces. */
export interface AccountNotices {
  current(): AccountNotice | null;
  /** Called after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** The notice was shown: it is not shown again. */
  consume(key: number): void;
}

export interface AccountService {
  /** The build has account configuration. */
  readonly configured: boolean;
  /**
   * The build uses the local test service, which holds synthetic data and keeps no
   * backups. False for any other service, whose operator must document its backup retention.
   */
  readonly localTestService: boolean;
  currentAccount(): { readonly email: string } | null;
  signUp(email: string, password: string): Promise<AccountResult<SignInOutcome>>;
  signIn(email: string, password: string): Promise<AccountResult<SignInOutcome>>;
  /** Make and verify the backup, then link this device's plan to the account. */
  startFirstUpload(): Promise<AccountResult>;
  /** Keep this device's plan local and open the account's own copy instead. */
  declineFirstUpload(): Promise<AccountResult>;
  /** Before linkage completes: undo the link and keep every local record. */
  cancelFirstUpload(): Promise<AccountResult>;
  /** The verified backup made before linking, while it is kept. */
  latestBackup(): Promise<ExportFile | null>;
  exportAccount(): Promise<AccountResult<ExportFile>>;
  /**
   * What waits on this device before signing out or removing the account; null when it cannot be
   * read, so the dialogs fail closed and still ask for the acknowledgement.
   */
  signOutFacts(): Promise<SignOutFacts | null>;
  /** Lock this account's copy and return to the local plan. */
  signOut(): Promise<AccountResult>;
  /** Sign in again after the session expired; queued work resumes. */
  reauthenticate(password: string): Promise<AccountResult>;
  /** Clear the session and, when chosen, this device's copy of the account (cloud data stays). */
  removeFromDevice(input: {
    readonly deleteLocalCopy: boolean;
    /** Required when unsynced changes would be lost with the copy. */
    readonly acceptUnsyncedLoss: boolean;
  }): Promise<AccountResult>;
  deletionPreview(): Promise<AccountResult<DeletionPreview>>;
  /**
   * needs the password again; the local copy is deleted unless kept. An account the
   * server already deleted (on another device) is finished here without the password.
   */
  deleteAccount(input: {
    readonly password: string;
    readonly keepLocalCopy: boolean;
  }): Promise<AccountResult>;
  /**
   * Retries a pending deletion. The server is asked first: an account it already deleted is
   * finished here with the choice made (this device's copy is kept when none was made), without
   * the password. Otherwise deleting needs the password again (a recent sign-in).
   */
  retryDeletion(password: string): Promise<AccountResult>;
  /**
   * Cancels a pending deletion once the server confirms the account still exists. An account it
   * already deleted cannot be restored: the deletion is finished instead and the result says so.
   */
  cancelDeletion(): Promise<AccountResult>;
}

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
