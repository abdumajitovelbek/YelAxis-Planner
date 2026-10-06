/**
 * Test-only in-memory Unit of Work with transactional copy-on-write semantics. It mirrors the SQLite
 * adapter contract closely enough for application tests: revisions increment by one, creates
 * collide, stale revisions throw, and a thrown callback discards every staged write.
 */
import {
  entityRefKey,
  type CommandId,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type {
  ApplicationDependencies,
  CanonicalRecordState,
  CommandReceipt,
  DomainEventRecord,
  OutboxMutationGroup,
  PlanningUnitOfWork,
  ProjectionInvalidation,
  UndoDescriptorRecord,
  UnitOfWorkPort,
} from '../index';

export interface InMemoryState {
  readonly records: Map<string, CanonicalRecordState>;
  readonly events: DomainEventRecord[];
  readonly undo: (UndoDescriptorRecord & { applied: boolean })[];
  readonly outbox: OutboxMutationGroup[];
  readonly receipts: Map<string, CommandReceipt>;
}

const clone = (state: InMemoryState): InMemoryState => ({
  records: new Map(state.records),
  events: [...state.events],
  undo: state.undo.map((record) => ({ ...record })),
  outbox: [...state.outbox],
  receipts: new Map(state.receipts),
});

export class InMemoryUnitOfWork implements UnitOfWorkPort {
  state: InMemoryState = {
    records: new Map(),
    events: [],
    undo: [],
    outbox: [],
    receipts: new Map(),
  };

  /** Seed a canonical record directly (fixtures only). */
  seed(record: CanonicalRecordState): void {
    this.state.records.set(entityRefKey(record.ref), record);
  }

  get(key: string): CanonicalRecordState | undefined {
    return this.state.records.get(key);
  }

  async runInTransaction<T>(work: (unitOfWork: PlanningUnitOfWork) => Promise<T>): Promise<T> {
    const draft = clone(this.state);
    let active = true;
    const assertActive = (): void => {
      if (!active) throw new Error('Transaction capability used outside its callback');
    };
    try {
      const result = await work({
        records: {
          read: (ref) => {
            assertActive();
            return Promise.resolve(draft.records.get(entityRefKey(ref)) ?? null);
          },
          apply: (mutation) => {
            assertActive();
            const key = entityRefKey(mutation.ref);
            const current = draft.records.get(key);
            if (mutation.operation === 'create') {
              if (current !== undefined) throw new Error('In-memory create collision');
            } else if (
              current === undefined ||
              current.localRevision !== mutation.expectedRevision
            ) {
              throw new Error('In-memory revision conflict');
            }
            const localRevision = (current?.localRevision ?? 0) + 1;
            if (mutation.operation === 'delete') {
              draft.records.delete(key);
            } else {
              draft.records.set(key, {
                ref: mutation.ref,
                localRevision,
                serverRevision: mutation.baseServerRevision,
                baseSnapshotHash: mutation.baseSnapshotHash,
                document: mutation.document,
              });
            }
            return Promise.resolve({
              ref: mutation.ref,
              operation: mutation.operation,
              localRevision,
            });
          },
        },
        events: {
          append: (records) => {
            assertActive();
            draft.events.push(...records);
            return Promise.resolve();
          },
        },
        undo: {
          append: (record) => {
            assertActive();
            draft.undo.push({ ...record, applied: false });
            return Promise.resolve();
          },
          find: (ownerId, undoId) => {
            assertActive();
            const record = draft.undo.find(
              (candidate) =>
                candidate.ownerId === ownerId && candidate.undoId === undoId && !candidate.applied,
            );
            return Promise.resolve(
              record === undefined
                ? null
                : { ...record, state: 'available' as const, localRevision: 1 },
            );
          },
          markApplied: (ownerId, undoId) => {
            assertActive();
            const record = draft.undo.find(
              (candidate) => candidate.ownerId === ownerId && candidate.undoId === undoId,
            );
            if (record === undefined || record.applied) throw new Error('In-memory undo missing');
            record.applied = true;
            return Promise.resolve();
          },
        },
        outbox: {
          append: (group) => {
            assertActive();
            draft.outbox.push(group);
            return Promise.resolve();
          },
        },
        receipts: {
          find: (ownerId: OwnerId, commandId: CommandId) =>
            Promise.resolve(draft.receipts.get(`${ownerId}:${commandId}`) ?? null),
          append: (receipt) => {
            assertActive();
            draft.receipts.set(`${receipt.ownerId}:${receipt.commandId}`, receipt);
            return Promise.resolve();
          },
        },
      });
      this.state = draft;
      return result;
    } finally {
      active = false;
    }
  }
}

export interface InMemoryHarness {
  readonly unitOfWork: InMemoryUnitOfWork;
  readonly dependencies: ApplicationDependencies;
  readonly notifications: ProjectionInvalidation[];
  setNow(value: Instant): void;
}

/** Deterministic dependencies: fixed owner, controllable clock, sequential UUIDs. */
export function createInMemoryHarness(
  ownerId: OwnerId,
  now: Instant,
  idPrefix = '00000000-0000-4000-8000-',
): InMemoryHarness {
  const unitOfWork = new InMemoryUnitOfWork();
  const notifications: ProjectionInvalidation[] = [];
  let current = now;
  let sequence = 1;
  return {
    unitOfWork,
    notifications,
    setNow(value) {
      current = value;
    },
    dependencies: {
      unitOfWork,
      identityContext: {
        getActiveIdentity: () => Promise.resolve({ ownerId, syncEnabled: false }),
      },
      projections: {
        notifyCommitted(invalidation) {
          notifications.push(invalidation);
        },
      },
      clock: { now: () => current },
      ids: {
        next() {
          const suffix = String(sequence).padStart(12, '0');
          sequence += 1;
          return `${idPrefix}${suffix}` as UUID;
        },
      },
    },
  };
}
