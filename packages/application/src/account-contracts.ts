import type {
  EntityType,
  HandbookStatus,
  Instant,
  OnboardingStatus,
  OnboardingStep,
  OwnerId,
  OnboardingDraft,
  UUID,
} from '@yelaxis/domain';

import type { OutboxMutationGroup } from './contracts';
import type { OnboardingArtifacts } from './onboarding';

/*
 * account sync identity, linking, export, and account lifecycle (identity contract,
 * export contract). These are the inner ports: `@yelaxis/data` implements them over SQLite, and the
 * web composition root adds authentication and the per-identity store choice. Email, provider
 * claims, and sessions never appear here; an account identity is known only by its stable subject.
 */

export type PlanningIdentityKind = 'local' | 'account';

/** One row of `planning_identities`. */
export interface PlanningIdentity {
  readonly id: OwnerId;
  readonly kind: PlanningIdentityKind;
  /** The authenticated account subject (account identities only). */
  readonly accountSubjectId: string | null;
  /** This device's replica of the account; it never authorizes access. */
  readonly replicaId: UUID | null;
  /** The command id of every initial upload group of a link. */
  readonly linkId: UUID | null;
  /** The local identity a link replaced; cancel restores it. */
  readonly linkSourceIdentityId: OwnerId | null;
  /**
   * The local Profile id a link replaced with the account's Profile id; cancel restores it. Null
   * when the Profile already had the account's id or the plan had none.
   */
  readonly linkSourceProfileId: UUID | null;
  readonly linkStartedAt: Instant | null;
  readonly linkedAt: Instant | null;
  readonly createdAt: Instant;
}

/**
 * `local` for a local identity; `linking` from a link until its initial upload is acknowledged and
 * a pull checkpoint exists; `linked` for every other account identity.
 */
export type AccountLinkPhase = 'local' | 'linking' | 'linked';

export function accountLinkPhase(identity: PlanningIdentity): AccountLinkPhase {
  if (identity.kind === 'local') return 'local';
  return identity.linkStartedAt !== null && identity.linkedAt === null ? 'linking' : 'linked';
}

/* ───────────────────────── Canonical snapshot ───────────────────────── */

/** One canonical record: its codec document, without owner or sync metadata. */
export interface CanonicalSnapshotRecord {
  readonly type: EntityType;
  readonly id: UUID;
  readonly localRevision: number;
  readonly document: Readonly<Record<string, unknown>>;
}

/** Every canonical record of one owner, read in one transaction, sorted by type and then id. */
export interface CanonicalSnapshot {
  readonly ownerId: OwnerId;
  readonly records: readonly CanonicalSnapshotRecord[];
}

/**
 * The Profile settings that stay on a device and never sync (onboarding owns them): bundle-only,
 * so an export keeps the whole Profile (export contract: Profile and planning preferences).
 */
export interface BundleProfileSettings {
  readonly profileId: UUID;
  readonly localRevision: number;
  readonly preferredName: string | null;
  readonly localeOverride: string | null;
  /** Local setup/handbook state; no account claims or synchronized bookkeeping. */
  readonly deviceState?: Omit<
    AccountProfileSeed,
    'preferredName' | 'localeOverride' | 'planningTimeZone' | 'weekStart' | 'timeFormat'
  >;
  readonly onboardingDraft?: OnboardingDraft | null;
  readonly onboardingArtifacts?: OnboardingArtifacts;
}

/** Content-free permanent-deletion history, with ownership omitted. */
export interface BundleTombstone {
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly localRevision: number;
  readonly deletedAt: Instant;
}

/** Minimized visible history, without receipts, replica/server metadata or undo payloads. */
export interface BundleHistoryEvent {
  readonly eventId: UUID;
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly eventType: string;
  readonly actor: 'user' | 'import' | 'sync' | 'intelligence_proposal';
  readonly occurredAt: Instant;
  readonly localRevision: number;
}

/** One side of an open conflict: a codec document, or a deletion. */
export interface BundleConflictSide {
  readonly deleted: boolean;
  readonly document: Readonly<Record<string, unknown>> | null;
}

/**
 * An open conflict's candidates, minimized for recovery (export contract): the versions and the
 * fields involved, without server or replica authority, outbox groups, or closure bookkeeping.
 */
export interface BundleConflictCandidate {
  readonly conflictId: UUID;
  readonly localRevision: number;
  readonly entityType: EntityType;
  readonly entityId: UUID;
  readonly kind:
    | 'stale_base'
    | 'edit_versus_delete'
    | 'delete_versus_edit'
    | 'create_collision'
    | 'merge_conflict';
  readonly fields: readonly string[];
  readonly base: Readonly<Record<string, unknown>> | null;
  readonly local: BundleConflictSide;
  readonly remote: BundleConflictSide;
  readonly createdAt: Instant;
}

/** What a bundle carries beyond the canonical records, read in the same transaction. */
export interface BundleSupplement {
  readonly profileSettings: BundleProfileSettings | null;
  /** Open conflicts, sorted by id. */
  readonly openConflicts: readonly BundleConflictCandidate[];
  /** Optional history and ledger supplements. Earlier v1 bundles legitimately omit these sections. */
  readonly tombstones?: readonly BundleTombstone[];
  readonly history?: readonly BundleHistoryEvent[];
}

/** Live canonical records of one owner, by entity type (types without records are omitted). */
export interface PlanRecordCounts {
  readonly byType: Readonly<Partial<Record<EntityType, number>>>;
  readonly total: number;
  /** Context entries marked sensitive; they are shown before an upload or export includes them. */
  readonly sensitiveContextCount: number;
}

/* ───────────────────────── Canonical JSON bundle v1 ───────────────────────── */

export type BundleSourceMode = 'local' | 'account';

/** The manifest of the canonical JSON bundle v1 (export contract). */
export interface CanonicalBundleManifest {
  readonly sections: readonly string[];
  readonly recordCounts: Readonly<Record<string, number>>;
  /** Describes the source; it grants no authority. */
  readonly sourceMode: BundleSourceMode;
  readonly containsSensitiveContext: boolean;
  /** True when queued local changes had not reached the account yet. */
  readonly syncWasPending: boolean;
  /** Lowercase hex SHA-256 of the canonical serialization of `data`. */
  readonly dataSha256: string;
}

export interface EncodedBundle {
  readonly bundleId: UUID;
  readonly exportedAt: Instant;
  readonly manifest: CanonicalBundleManifest;
  /** Canonical planning records; the supplement's sections are counted in the manifest. */
  readonly recordCount: number;
  /** The file content (human-readable JSON). Readable private data: never logged. */
  readonly text: string;
}

export type BundleVerificationFailure =
  | 'unreadable'
  | 'unsupported_format'
  | 'invalid_structure'
  | 'invalid_record'
  | 'count_mismatch'
  | 'manifest_mismatch'
  | 'digest_mismatch';

export type BundleVerification =
  | {
      readonly ok: true;
      readonly bundleId: UUID;
      readonly manifest: CanonicalBundleManifest;
      readonly recordCount: number;
    }
  | { readonly ok: false; readonly reason: BundleVerificationFailure };

export interface EncodeBundleInput {
  readonly snapshot: CanonicalSnapshot;
  readonly supplement: BundleSupplement;
  readonly bundleId: UUID;
  readonly exportedAt: Instant;
  readonly appVersion: string;
  readonly sourceMode: BundleSourceMode;
  readonly syncWasPending: boolean;
}

/** Writes and verifies the canonical JSON bundle v1. */
export interface CanonicalBundlePort {
  encode(input: EncodeBundleInput): Promise<EncodedBundle>;
  /** Parses the text back, recomputes the digest, and checks counts, sections, and records. */
  verify(text: string): Promise<BundleVerification>;
}

/** The verified backup made before linking, kept until linkage. */
export interface StoredAccountBackup {
  readonly bundleId: UUID;
  readonly createdAt: Instant;
  readonly recordCount: number;
  readonly syncWasPending: boolean;
  readonly dataSha256: string;
  readonly text: string;
}

/* ───────────────────────── Sync bookkeeping facts ───────────────────────── */

export interface AccountSyncFacts {
  /** Outbox operations not yet acknowledged, in any waiting or blocked state. */
  readonly pendingOperations: number;
  readonly openConflicts: number;
  readonly lastSyncedAt: Instant | null;
}

/** Progress of a link's initial upload. */
export interface FirstUploadProgress {
  readonly totalOperations: number;
  readonly acknowledgedOperations: number;
  readonly totalGroups: number;
  /** Groups with an operation that is neither acknowledged nor superseded. */
  readonly openGroups: number;
  /** A pull checkpoint with a server cursor exists for this replica. */
  readonly pullCheckpoint: boolean;
}

/* ───────────────────────── Account deletion ───────────────────────── */

/** `account_deletion_state.state`. */
export type AccountDeletionPhase =
  'none' | 'requested' | 'pending' | 'confirmed' | 'failed_recoverable';

export type LocalCopyChoice = 'keep' | 'delete';

export interface AccountDeletionStatus {
  readonly phase: AccountDeletionPhase;
  readonly requestId: UUID | null;
  readonly requestedAt: Instant | null;
  readonly confirmedAt: Instant | null;
  readonly localCopy: LocalCopyChoice | null;
  /** A safe error code from the last failed attempt; never content. */
  readonly errorCode: string | null;
}

export type AccountDeletionEvent =
  /** The password was verified and the person chose what happens to this device's copy. */
  | { readonly kind: 'request'; readonly localCopy: LocalCopyChoice }
  /** The server deletion call starts (first attempt, retry, or a resumed one). */
  | { readonly kind: 'start' }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'fail'; readonly errorCode: string }
  | { readonly kind: 'cancel' };

/* ───────────────────────── Profile seed ───────────────────────── */

/**
 * The setup choices copied from this device's local plan into a new, empty account's replica, so the
 * account starts with the confirmed planning defaults and setup progress instead of an empty
 * profile. Onboarding drafts and starter-record references are never copied.
 */
export interface AccountProfileSeed {
  readonly preferredName: string | null;
  readonly planningTimeZone: string;
  readonly weekStart: string;
  readonly timeFormat: '12_hour' | '24_hour';
  readonly localeOverride: string | null;
  readonly defaultsConfirmedAt: Instant | null;
  readonly onboarding: {
    readonly status: OnboardingStatus;
    readonly step: OnboardingStep;
    readonly completedSteps: readonly OnboardingStep[];
    readonly skippedSteps: readonly OnboardingStep[];
    readonly completedAt: Instant | null;
  };
  readonly handbook: {
    readonly status: HandbookStatus;
    readonly lesson: number;
    readonly completedLessons: readonly number[];
  };
}

/* ───────────────────────── Store port ───────────────────────── */

export interface AccountIdentityStore {
  /** Identities that are not retired, oldest first. A store normally has exactly one. */
  listActive(): Promise<readonly PlanningIdentity[]>;
  /** One identity by id, retired or not. */
  find(id: OwnerId): Promise<PlanningIdentity | null>;
  insertLocal(input: { readonly id: OwnerId; readonly at: Instant }): Promise<void>;
  /**
   * A linking account identity when `link` is set (`link_started_at` = `at`); otherwise a replica
   * that is linked from its creation (`linked_at` = `at`).
   */
  insertAccount(input: {
    readonly id: OwnerId;
    readonly accountSubjectId: string;
    readonly replicaId: UUID;
    readonly at: Instant;
    readonly link: {
      readonly linkId: UUID;
      readonly sourceIdentityId: OwnerId;
      /** The local Profile id the link replaces with the account's Profile id, if any. */
      readonly sourceProfileId: UUID | null;
    } | null;
  }): Promise<void>;
  /** Hides an identity whose rows now belong to another identity (kept for cancel). */
  retire(id: OwnerId, at: Instant): Promise<void>;
  restore(id: OwnerId, at: Instant): Promise<void>;
  markLinked(id: OwnerId, at: Instant): Promise<void>;
  /** Removes an identity row that no owned row references any more. */
  remove(id: OwnerId): Promise<void>;
}

export interface OwnershipRemapResult {
  /** Rows moved, by owned table. */
  readonly rowsByTable: Readonly<Record<string, number>>;
}

export interface AccountOwnershipStore {
  /**
   * Moves every owned row of `from` to `to`, including owner-keyed ids and receipts. Undo for
   * earlier commands ends: their descriptors are redacted and expired. Fails unless nothing stays.
   */
  remap(input: {
    readonly from: OwnerId;
    readonly to: OwnerId;
    readonly at: Instant;
  }): Promise<OwnershipRemapResult>;
  /**
   * Gives the owner's Profile the id `to` instead of `from`: the Profile row, every record that
   * refers to it, and the history that names it (events and receipts). Undo that names it ends like
   * undo across an owner remap. Only a Profile that never synchronized is renamed (a link and a
   * cancel clear sync state first). Fails unless the owner's Profile had the id `from` and no row
   * of the owner names `from` afterwards.
   */
  remapProfile(input: {
    readonly ownerId: OwnerId;
    readonly from: UUID;
    readonly to: UUID;
    readonly at: Instant;
  }): Promise<OwnershipRemapResult>;
}

export interface AccountRecordReader {
  counts(ownerId: OwnerId): Promise<PlanRecordCounts>;
  snapshot(ownerId: OwnerId): Promise<CanonicalSnapshot>;
  /** The bundle-only Profile settings and the open conflict candidates of one owner. */
  supplement(ownerId: OwnerId): Promise<BundleSupplement>;
}

export interface AccountSyncReader {
  facts(ownerId: OwnerId): Promise<AccountSyncFacts>;
  firstUpload(input: {
    readonly ownerId: OwnerId;
    readonly linkId: UUID;
    readonly replicaId: UUID;
  }): Promise<FirstUploadProgress>;
}

export interface AccountSyncStore extends AccountSyncReader {
  /** Appends one ordinary outbox group of create operations, exactly as a command's group. */
  appendGroup(group: OutboxMutationGroup): Promise<void>;
  /**
   * Removes the owner's outbox (every state), conflicts, checkpoints, and base snapshots, and resets
   * the server revisions of its records: the state of a plan that never synchronized.
   */
  clear(ownerId: OwnerId): Promise<void>;
}

export interface AccountDeletionStore {
  read(ownerId: OwnerId): Promise<AccountDeletionStatus>;
  /** `rowId` is used only when the owner has no deletion row yet. */
  write(input: {
    readonly ownerId: OwnerId;
    readonly rowId: UUID;
    readonly status: AccountDeletionStatus;
    readonly at: Instant;
  }): Promise<void>;
  clear(ownerId: OwnerId): Promise<void>;
}

export interface AccountBackupStore {
  latest(ownerId: OwnerId): Promise<StoredAccountBackup | null>;
  /** Keeps this backup as the owner's only one. */
  save(input: {
    readonly ownerId: OwnerId;
    readonly bundle: EncodedBundle;
    readonly at: Instant;
  }): Promise<void>;
  clear(ownerId: OwnerId): Promise<void>;
}

export interface AccountProfileStore {
  /** The id of the owner's one Profile, or null when it has none. */
  readId(ownerId: OwnerId): Promise<UUID | null>;
  readSeed(ownerId: OwnerId): Promise<AccountProfileSeed | null>;
  seed(input: {
    readonly ownerId: OwnerId;
    readonly profileId: UUID;
    readonly seed: AccountProfileSeed;
    readonly at: Instant;
  }): Promise<void>;
}

/** Read-only capabilities, outside a write transaction. */
export interface AccountStoreReader {
  readonly identities: Pick<AccountIdentityStore, 'listActive' | 'find'>;
  readonly records: Pick<AccountRecordReader, 'counts'>;
  readonly sync: AccountSyncReader;
  readonly deletion: Pick<AccountDeletionStore, 'read'>;
  readonly backups: Pick<AccountBackupStore, 'latest'>;
  readonly profiles: Pick<AccountProfileStore, 'readSeed'>;
}

/** Capabilities bound to one atomic local transaction with deferred foreign keys. */
export interface AccountTransaction {
  readonly identities: AccountIdentityStore;
  readonly ownership: AccountOwnershipStore;
  readonly records: AccountRecordReader;
  readonly sync: AccountSyncStore;
  readonly deletion: AccountDeletionStore;
  readonly backups: AccountBackupStore;
  readonly profiles: AccountProfileStore;
}

export interface AccountStorePort {
  read<Result>(work: (reader: AccountStoreReader) => Promise<Result>): Promise<Result>;
  /** Capabilities are valid only while `work` runs; a rejection rolls everything back. */
  runInTransaction<Result>(
    work: (transaction: AccountTransaction) => Promise<Result>,
  ): Promise<Result>;
}

/* ───────────────────────── Results ───────────────────────── */

export type AccountErrorCode =
  /** The store has no identity, or more than one. */
  | 'identity_unavailable'
  /** The store already belongs to another identity. */
  | 'identity_exists'
  | 'invalid_account_subject'
  | 'not_local'
  | 'not_account'
  | 'not_linking'
  | 'backup_missing'
  | 'backup_verification_failed'
  | 'export_verification_failed'
  | 'deletion_state_invalid'
  | 'deletion_not_confirmed'
  /** A store operation failed; its transaction rolled back. */
  | 'store_failed';

export interface AccountError {
  readonly code: AccountErrorCode;
}

export type AccountApplicationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: AccountError };

export interface AccountLinkReceipt {
  /** The account identity that now owns every record. */
  readonly ownerId: OwnerId;
  readonly sourceIdentityId: OwnerId;
  readonly linkId: UUID;
  readonly replicaId: UUID;
  readonly groups: number;
  readonly operations: number;
}
