import type { CommandReceipt, SyncQueueReceipt } from './contracts';
import type { ProjectionInvalidationPort, PlanningUnitOfWork } from './ports';
import type { Clock, EntityType, IdProvider, Instant, OwnerId, UUID } from '@yelaxis/domain';

import type {
  BundleConflictCandidate,
  BundleSupplement,
  CanonicalBundlePort,
  CanonicalSnapshot,
  CanonicalSnapshotRecord,
  EncodedBundle,
} from './account-contracts';

export interface ImportBundle {
  readonly bundleId: UUID;
  readonly exportedAt: Instant;
  readonly records: readonly CanonicalSnapshotRecord[];
  readonly supplement: BundleSupplement;
  readonly containsSensitiveContext: boolean;
  readonly bytes: number;
}

export interface ImportBundleDecoder {
  decode(text: string): Promise<ImportResult<ImportBundle>>;
}

export type ImportMode = 'merge' | 'replace';
export type ImportDecision = 'keep_current' | 'use_imported' | 'duplicate_imported';
export interface ImportChoice {
  readonly type: EntityType;
  readonly id: UUID;
  readonly decision: ImportDecision;
}

export interface ImportConflict {
  readonly type: EntityType;
  readonly id: UUID;
  readonly title: string;
  readonly reason: 'id_collision' | 'deleted_here' | 'imported_tombstone';
  readonly choices: readonly ImportDecision[];
  readonly current: {
    readonly deleted: boolean;
    readonly document: Readonly<Record<string, unknown>> | null;
  };
  readonly imported: {
    readonly deleted: boolean;
    readonly document: Readonly<Record<string, unknown>> | null;
  };
  readonly linkTitles: Readonly<Record<string, string>>;
}

export interface ImportProblem {
  readonly code:
    | 'missing_reference'
    | 'focus_limit'
    | 'invalid_period'
    | 'duplicate_target'
    | 'relationship_mismatch'
    | 'routine_mismatch'
    | 'required_profile'
    | 'unconfirmed_sync'
    | 'destination_conflicts';
  readonly type?: EntityType;
  readonly id?: UUID;
}

export interface ImportPreview {
  readonly previewId: UUID;
  readonly bundleId: UUID;
  readonly mode: ImportMode;
  readonly creates: number;
  readonly updates: number;
  readonly deletes: number;
  readonly identicalSkips: number;
  readonly keeps: number;
  readonly conflicts: readonly ImportConflict[];
  readonly problems: readonly ImportProblem[];
  readonly decisions: readonly ImportChoice[];
  readonly sensitiveContextCount: number;
  readonly recoveryConflicts: number;
  readonly expectedStorageBytes: number;
  readonly accountLinked: boolean;
  readonly backupRequired: boolean;
  readonly canApply: boolean;
}

export interface ImportJournal {
  readonly id: UUID;
  readonly ownerId: OwnerId;
  readonly text: string;
  readonly mode: ImportMode;
  readonly decisions: readonly ImportChoice[];
  readonly duplicatedIds: Readonly<Record<string, UUID>>;
  readonly destinationDigest: string;
  readonly createdAt: Instant;
}

export interface ImportRecoveryBackup {
  readonly backupId: UUID;
  readonly createdAt: Instant;
  readonly recordCount: number;
  readonly text: string;
}

export interface ImportDestination {
  readonly snapshot: CanonicalSnapshot;
  readonly supplement: BundleSupplement;
  readonly accountLinked: boolean;
  readonly syncWasPending: boolean;
  readonly unconfirmedSync: boolean;
}

/** Additional device-only capabilities bound to the ordinary planning transaction. */
export interface ImportTransaction extends PlanningUnitOfWork {
  destination(): Promise<ImportDestination>;
  journal(): Promise<ImportJournal | null>;
  saveJournal(journal: ImportJournal): Promise<void>;
  discardJournal(): Promise<void>;
  saveBackup(bundle: EncodedBundle, at: Instant): Promise<void>;
  backup(): Promise<ImportRecoveryBackup | null>;
  /** Expires only never-sent superseded intents; refuses unconfirmed or unresolved work. */
  prepareReplacementDeletes(
    refs: readonly { readonly type: EntityType; readonly id: UUID }[],
    at: Instant,
  ): Promise<void>;
  clearDeletion(type: EntityType, id: UUID): Promise<number>;
  setRestoredBase(type: EntityType, id: UUID, serverRevision: number): Promise<void>;
  recoveryConflicts(): Promise<readonly BundleConflictCandidate[]>;
  closeRecoveryConflict(conflictId: UUID, at: Instant): Promise<void>;
  /** Rewrites never-sent candidate intents in their original groups so dependency graphs stay atomic. */
  rewriteRecoveryOperations(
    type: EntityType,
    id: UUID,
    document: Readonly<Record<string, unknown>>,
    at: Instant,
  ): Promise<SyncQueueReceipt>;
  applySupplement(
    supplement: BundleSupplement,
    mode: ImportMode,
    remap: Readonly<Record<string, UUID>>,
    at: Instant,
  ): Promise<void>;
  validateCommittedGraph(): Promise<void>;
  /** Creates the Profile of a new empty destination through its existing seed path. */
  createProfile(
    record: CanonicalSnapshotRecord,
    supplement: BundleSupplement,
    at: Instant,
  ): Promise<void>;
}

export interface ImportStorePort {
  /** Serialized read only: validate the active owner and journal without opening a write transaction. */
  readJournal(): Promise<ImportJournal | null>;
  runInTransaction<T>(work: (transaction: ImportTransaction) => Promise<T>): Promise<T>;
}

export type ImportErrorCode =
  | 'invalid_bundle'
  | 'input_limit'
  | 'unsupported_format'
  | 'digest_mismatch'
  | 'invalid_record'
  | 'invalid_graph'
  | 'conflicts_unresolved'
  | 'preview_missing'
  | 'preview_stale'
  | 'confirmation_required'
  | 'backup_failed'
  | 'storage_failed';
export type ImportResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: ImportErrorCode };

export interface ImportApplication {
  preview(
    text: string,
    options?: { readonly mode?: ImportMode; readonly decisions?: readonly ImportChoice[] },
  ): Promise<ImportResult<ImportPreview>>;
  apply(previewId: UUID, confirmation?: string): Promise<ImportResult<CommandReceipt>>;
  pending(): Promise<ImportJournal | null>;
  resume(): Promise<ImportResult<ImportPreview>>;
  discard(): Promise<ImportResult<void>>;
  recoveryBackup(): Promise<ImportRecoveryBackup | null>;
  recoveryConflicts(): Promise<readonly BundleConflictCandidate[]>;
  resolveRecovery(
    conflictId: UUID,
    choice: 'keep_current' | 'use_local' | 'use_remote',
  ): Promise<ImportResult<CommandReceipt>>;
}

export interface ImportApplicationDependencies {
  readonly store: ImportStorePort;
  readonly decoder: ImportBundleDecoder;
  readonly bundles: CanonicalBundlePort;
  readonly clock: Clock;
  readonly ids: IdProvider;
  readonly projections?: ProjectionInvalidationPort;
  readonly appVersion: string;
}
