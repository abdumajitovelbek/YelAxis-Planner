import type { Clock, CommandContext, CommandId, IdProvider, OwnerId } from '@yelaxis/domain';

import type {
  AppliedCanonicalChange,
  CanonicalMutation,
  CanonicalRecordState,
  CommandReceipt,
  DomainEventRecord,
  OutboxMutationGroup,
  ProjectionInvalidation,
  UndoDescriptorRecord,
  StoredUndoDescriptor,
} from './contracts';

export interface ActiveIdentityContext {
  readonly ownerId: OwnerId;
  readonly syncEnabled: boolean;
}

export interface IdentityContextPort {
  getActiveIdentity(): Promise<ActiveIdentityContext | null>;
}

export interface PlanningRecordReader {
  read(ref: CanonicalRecordState['ref']): Promise<CanonicalRecordState | null>;
}

export interface CanonicalRecordRepository extends PlanningRecordReader {
  apply(mutation: CanonicalMutation, context: CommandContext): Promise<AppliedCanonicalChange>;
}

export interface DomainEventStore {
  append(events: readonly DomainEventRecord[]): Promise<void>;
}

export interface UndoDescriptorStore {
  append(undo: UndoDescriptorRecord): Promise<void>;
  find(
    ownerId: OwnerId,
    undoId: UndoDescriptorRecord['undoId'],
  ): Promise<StoredUndoDescriptor | null>;
  markApplied(
    ownerId: OwnerId,
    undoId: UndoDescriptorRecord['undoId'],
    expectedRevision: number,
    appliedAt: ReturnType<Clock['now']>,
  ): Promise<void>;
}

export interface OutboxStore {
  append(group: OutboxMutationGroup): Promise<void>;
}

export interface CommandReceiptStore {
  find(ownerId: OwnerId, commandId: CommandId): Promise<CommandReceipt | null>;
  append(receipt: CommandReceipt): Promise<void>;
}

/** Capabilities that an adapter must bind to one atomic local transaction. */
export interface PlanningUnitOfWork {
  readonly records: CanonicalRecordRepository;
  readonly events: DomainEventStore;
  readonly undo: UndoDescriptorStore;
  readonly outbox: OutboxStore;
  readonly receipts: CommandReceiptStore;
}

export interface UnitOfWorkPort {
  /**
   * Capabilities are valid only while `work` is running. Adapters must reject
   * retained capability use after this promise settles.
   */
  runInTransaction<T>(work: (unitOfWork: PlanningUnitOfWork) => Promise<T>): Promise<T>;
}

/** Rebuildable read-model notification. Implementations must not perform canonical writes. */
export interface ProjectionInvalidationPort {
  notifyCommitted(invalidation: ProjectionInvalidation): void | Promise<void>;
}

export interface ApplicationDependencies {
  readonly unitOfWork: UnitOfWorkPort;
  readonly identityContext: IdentityContextPort;
  readonly projections: ProjectionInvalidationPort;
  readonly clock: Clock;
  readonly ids: IdProvider;
}
