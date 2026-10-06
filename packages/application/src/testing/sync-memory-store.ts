/**
 * Test-only in-memory sync store. It mirrors the SQLite adapter's contract closely enough for
 * application tests: copy-on-write transactions that a thrown callback discards, optimistic record
 * revisions, a deletion path that refuses records with queued operations or an open conflict, a
 * deletion ledger that refuses re-creation, outbox rows in insertion order, and references checked
 * through `…Id` fields of live documents.
 */
import {
  createEntityRef,
  type CommandActor,
  type EntityRef,
  type EntityType,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type {
  AppliedCanonicalChange,
  CanonicalMutation,
  CanonicalRecordState,
  CommandReceipt,
  DomainEventRecord,
} from '../contracts';
import type { SyncDocument, SyncOutboxState } from '../sync-contracts';
import type {
  SyncBaseSnapshot,
  SyncConflictPayload,
  SyncDanglingReference,
  SyncIdentity,
  SyncStoredConflict,
  SyncStoredOperation,
  SyncStorePort,
  SyncTransactionStore,
  SyncUnitOfWork,
} from '../sync-ports';

interface StoredRecord {
  readonly ref: EntityRef;
  readonly localRevision: number;
  readonly serverRevision: number;
  readonly baseSnapshotHash: string | null;
  readonly document: SyncDocument;
}

interface MemoryState {
  identity: SyncIdentity | null;
  records: Map<string, StoredRecord>;
  ledger: Map<string, { serverRevision: number; localRevision: number }>;
  snapshots: Map<string, SyncBaseSnapshot>;
  outbox: SyncStoredOperation[];
  conflicts: Map<string, SyncStoredConflict>;
  checkpoint: { cursor: string | null; lastSuccessAt: Instant | null };
  events: DomainEventRecord[];
  receipts: CommandReceipt[];
  nextPosition: number;
}

const key = (type: string, id: string): string => `${type}:${id}`;
const clone = <T>(value: T): T => structuredClone(value);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function copy(state: MemoryState): MemoryState {
  return {
    identity: state.identity,
    records: new Map(state.records),
    ledger: new Map(state.ledger),
    snapshots: new Map(state.snapshots),
    outbox: [...state.outbox],
    conflicts: new Map(state.conflicts),
    checkpoint: { ...state.checkpoint },
    events: [...state.events],
    receipts: [...state.receipts],
    nextPosition: state.nextPosition,
  };
}

export class MemoryFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class MemorySyncStore implements SyncStorePort {
  state: MemoryState;
  /** Documents this predicate refuses fail like a record codec's validation. */
  validate: (entityType: EntityType, document: SyncDocument) => boolean = (_type, document) =>
    typeof document['title'] !== 'string' || document['title'].trim().length > 0;
  /**
   * Writes this predicate refuses fail like a database constraint: the codecs accept them, so
   * `validateDocument` cannot foresee the refusal.
   */
  constrain: (entityType: EntityType, document: SyncDocument) => boolean = () => false;
  /** Throw from inside a transaction (fault injection): called before every capability call. */
  fault: ((operation: string) => void) | null = null;
  transactions = 0;

  constructor(identity: SyncIdentity | null) {
    this.state = {
      identity,
      records: new Map(),
      ledger: new Map(),
      snapshots: new Map(),
      outbox: [],
      conflicts: new Map(),
      checkpoint: { cursor: null, lastSuccessAt: null },
      events: [],
      receipts: [],
      nextPosition: 1,
    };
  }

  /* ───────────────────────── Fixtures ───────────────────────── */

  seed(record: Omit<StoredRecord, 'localRevision'> & { localRevision?: number }): void {
    this.state.records.set(key(record.ref.type, record.ref.id), {
      localRevision: record.localRevision ?? 1,
      ...record,
    });
  }

  record(type: EntityType, id: string): StoredRecord | undefined {
    return this.state.records.get(key(type, id));
  }

  /** Queue a group like a command would (pending, attempt 0). */
  queue(
    groupId: UUID,
    operations: readonly {
      readonly operationId: UUID;
      readonly ref: EntityRef;
      readonly kind: 'create' | 'update' | 'delete';
      readonly document: SyncDocument | null;
      readonly baseServerRevision?: number;
      readonly baseSnapshotHash?: string | null;
    }[],
    actor: CommandActor = 'user',
  ): void {
    for (const [sequence, operation] of operations.entries()) {
      this.state.outbox.push({
        position: this.state.nextPosition,
        operationId: operation.operationId,
        mutationGroupId: groupId,
        commandId: groupId,
        actor,
        sequence,
        entityType: operation.ref.type,
        entityId: operation.ref.id,
        kind: operation.kind,
        expectedRevision: operation.kind === 'create' ? null : 1,
        state: 'pending',
        attemptCount: 0,
        nextAttemptAt: null,
        baseServerRevision: operation.baseServerRevision ?? 0,
        baseSnapshotHash: operation.baseSnapshotHash ?? null,
        document: operation.document,
      });
      this.state.nextPosition += 1;
    }
  }

  operations(): readonly SyncStoredOperation[] {
    return this.state.outbox;
  }

  /* ───────────────────────── Port ───────────────────────── */

  async runInTransaction<T>(work: (unitOfWork: SyncUnitOfWork) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const draft = copy(this.state);
    let active = true;
    const guard = (operation: string): void => {
      if (!active) throw new Error('Transaction capability used outside its callback');
      this.fault?.(operation);
    };
    const unitOfWork = this.#unitOfWork(draft, guard);
    try {
      const result = await work(unitOfWork);
      const dangling = referencesOf(draft);
      if (dangling.length > 0) throw new MemoryFailure('foreign_key');
      this.state = draft;
      return result;
    } finally {
      active = false;
    }
  }

  #unitOfWork(draft: MemoryState, guard: (operation: string) => void): SyncUnitOfWork {
    const records = {
      read: (ref: EntityRef): Promise<CanonicalRecordState | null> => {
        guard('records.read');
        const record = draft.records.get(key(ref.type, ref.id));
        return Promise.resolve(record === undefined ? null : clone({ ...record, ref }));
      },
      apply: (mutation: CanonicalMutation): Promise<AppliedCanonicalChange> => {
        guard(`records.apply.${mutation.operation}`);
        const k = key(mutation.ref.type, mutation.ref.id);
        const current = draft.records.get(k);
        if (mutation.operation === 'create') {
          if (current !== undefined || draft.ledger.has(k))
            throw new MemoryFailure('write_conflict');
          if (mutation.ref.type === 'profile') throw new MemoryFailure('write_conflict');
          if (!this.validate(mutation.ref.type, mutation.document)) {
            throw new MemoryFailure('invalid_canonical_document');
          }
          if (this.constrain(mutation.ref.type, mutation.document)) {
            throw new MemoryFailure('constraint_failed');
          }
          draft.records.set(k, {
            ref: mutation.ref,
            localRevision: 1,
            serverRevision: 0,
            baseSnapshotHash: null,
            document: clone(mutation.document),
          });
          return Promise.resolve({ ref: mutation.ref, operation: 'create', localRevision: 1 });
        }
        if (
          current === undefined ||
          current.localRevision !== mutation.expectedRevision ||
          current.serverRevision !== mutation.baseServerRevision ||
          current.baseSnapshotHash !== mutation.baseSnapshotHash
        ) {
          throw new MemoryFailure('write_conflict');
        }
        if (mutation.operation === 'update') {
          if (!this.validate(mutation.ref.type, mutation.document)) {
            throw new MemoryFailure('invalid_canonical_document');
          }
          if (this.constrain(mutation.ref.type, mutation.document)) {
            throw new MemoryFailure('constraint_failed');
          }
          draft.records.set(k, {
            ...current,
            localRevision: current.localRevision + 1,
            document: clone(mutation.document),
          });
          return Promise.resolve({
            ref: mutation.ref,
            operation: 'update',
            localRevision: current.localRevision + 1,
          });
        }
        // The shared deletion path: refused while anything still holds the record.
        const held =
          draft.outbox.some(
            (operation) =>
              operation.entityType === mutation.ref.type &&
              operation.entityId === mutation.ref.id &&
              operation.state !== 'acknowledged',
          ) ||
          [...draft.conflicts.values()].some(
            (conflict) =>
              conflict.entityType === mutation.ref.type &&
              conflict.entityId === mutation.ref.id &&
              conflict.state === 'open',
          );
        if (held) throw new MemoryFailure('write_conflict');
        draft.records.delete(k);
        draft.snapshots.delete(k);
        for (const [id, conflict] of draft.conflicts) {
          if (
            conflict.entityType === mutation.ref.type &&
            conflict.entityId === mutation.ref.id &&
            conflict.state !== 'open'
          ) {
            draft.conflicts.delete(id);
          }
        }
        draft.ledger.set(k, {
          serverRevision: mutation.baseServerRevision,
          localRevision: mutation.tombstone.revision,
        });
        return Promise.resolve({
          ref: mutation.ref,
          operation: 'delete',
          localRevision: mutation.tombstone.revision,
        });
      },
    };
    const sync = this.#syncStore(draft, guard);
    return {
      records,
      events: {
        append: (events) => {
          guard('events.append');
          draft.events.push(...events);
          return Promise.resolve();
        },
      },
      undo: {
        append: () => Promise.resolve(),
        find: () => Promise.resolve(null),
        markApplied: () => Promise.resolve(),
      },
      outbox: {
        append: (group) => {
          guard('outbox.append');
          for (const operation of group.operations) {
            const mutation = operation.mutation;
            draft.outbox.push({
              position: draft.nextPosition,
              operationId: operation.operationId,
              mutationGroupId: group.mutationGroupId,
              commandId: group.commandId,
              actor: group.actor,
              sequence: operation.sequence,
              entityType: mutation.ref.type,
              entityId: mutation.ref.id,
              kind: mutation.operation,
              expectedRevision: mutation.expectedRevision,
              state: 'pending',
              attemptCount: 0,
              nextAttemptAt: operation.nextAttemptAt,
              baseServerRevision: mutation.baseServerRevision,
              baseSnapshotHash: mutation.baseSnapshotHash,
              document: mutation.operation === 'delete' ? null : clone(mutation.document),
            });
            draft.nextPosition += 1;
          }
          return Promise.resolve();
        },
      },
      receipts: {
        find: () => Promise.resolve(null),
        append: (receipt) => {
          draft.receipts.push(receipt);
          return Promise.resolve();
        },
      },
      sync,
    };
  }

  #syncStore(draft: MemoryState, guard: (operation: string) => void): SyncTransactionStore {
    const live = (operation: SyncStoredOperation) => operation.state !== 'acknowledged';
    const updateOperations = (
      match: (operation: SyncStoredOperation) => boolean,
      change: (operation: SyncStoredOperation) => SyncStoredOperation,
    ): number => {
      let changed = 0;
      draft.outbox = draft.outbox.map((operation) => {
        if (!match(operation)) return operation;
        changed += 1;
        return change(operation);
      });
      return changed;
    };
    const validate = (entityType: EntityType, document: SyncDocument): boolean =>
      this.validate(entityType, document);
    return {
      identity() {
        guard('identity');
        return Promise.resolve(draft.identity);
      },
      outboxCounts() {
        guard('outboxCounts');
        const byState: Partial<Record<SyncOutboxState, number>> = {};
        let unconfirmed = 0;
        let nextAttemptAt: Instant | null = null;
        for (const operation of draft.outbox) {
          byState[operation.state] = (byState[operation.state] ?? 0) + 1;
          if (
            operation.attemptCount > 0 &&
            (operation.state === 'pending' ||
              operation.state === 'sending' ||
              operation.state === 'retry_wait')
          ) {
            unconfirmed += 1;
          }
          if (
            operation.state === 'retry_wait' &&
            operation.nextAttemptAt !== null &&
            (nextAttemptAt === null || operation.nextAttemptAt < nextAttemptAt)
          ) {
            nextAttemptAt = operation.nextAttemptAt;
          }
        }
        return Promise.resolve({ byState, unconfirmed, nextAttemptAt });
      },
      uploadProgress() {
        guard('uploadProgress');
        const all = [...draft.records.values()];
        return Promise.resolve({
          total: all.length,
          uploaded: all.filter((record) => record.serverRevision > 0).length,
        });
      },
      scanOutbox(_owner, fromPosition, limit) {
        guard('scanOutbox');
        return Promise.resolve(
          clone(
            draft.outbox
              .filter((operation) => live(operation) && operation.position >= fromPosition)
              .sort((left, right) => left.position - right.position)
              .slice(0, limit),
          ),
        );
      },
      operationsForEntity(_owner, ref) {
        guard('operationsForEntity');
        return Promise.resolve(
          clone(
            draft.outbox.filter(
              (operation) =>
                live(operation) &&
                operation.entityType === ref.type &&
                operation.entityId === ref.id,
            ),
          ),
        );
      },
      readGroup(_owner, groupId) {
        guard('readGroup');
        return Promise.resolve(
          clone(
            draft.outbox
              .filter((operation) => operation.mutationGroupId === groupId)
              .sort((left, right) => left.sequence - right.sequence),
          ),
        );
      },
      setGroupState(_owner, groupId, update) {
        guard('setGroupState');
        return Promise.resolve(
          updateOperations(
            (operation) =>
              operation.mutationGroupId === groupId && update.from.includes(operation.state),
            (operation) => ({
              ...operation,
              state: update.state,
              ...(update.attemptCount === undefined ? {} : { attemptCount: update.attemptCount }),
              ...(update.nextAttemptAt === undefined
                ? {}
                : { nextAttemptAt: update.nextAttemptAt }),
            }),
          ),
        );
      },
      setStateWhere(_owner, update) {
        guard('setStateWhere');
        return Promise.resolve(
          updateOperations(
            (operation) => operation.state === update.from,
            (operation) => ({
              ...operation,
              state: update.state,
              nextAttemptAt: update.nextAttemptAt,
              ...(update.resetAttempts === true ? { attemptCount: 0 } : {}),
            }),
          ),
        );
      },
      rewriteOperation(_owner, operationId, update) {
        guard('rewriteOperation');
        const changed = updateOperations(
          (operation) => operation.operationId === operationId && live(operation),
          (operation) => ({
            ...operation,
            ...(update.document === undefined ? {} : { document: clone(update.document) }),
            ...(update.baseServerRevision === undefined
              ? {}
              : { baseServerRevision: update.baseServerRevision }),
            ...(update.baseSnapshotHash === undefined
              ? {}
              : { baseSnapshotHash: update.baseSnapshotHash }),
          }),
        );
        if (changed !== 1) throw new MemoryFailure('write_conflict');
        return Promise.resolve();
      },
      rebaseQueuedOperations(_owner, bases) {
        guard('rebaseQueuedOperations');
        let changed = 0;
        for (const base of bases) {
          changed += updateOperations(
            (operation) =>
              live(operation) &&
              operation.kind !== 'create' &&
              operation.entityType === base.entityType &&
              operation.entityId === base.entityId,
            (operation) => ({
              ...operation,
              baseServerRevision: base.serverRevision,
              baseSnapshotHash: base.hash,
            }),
          );
        }
        return Promise.resolve(changed);
      },
      dropOperations(_owner, operationIds) {
        guard('dropOperations');
        const ids = new Set<string>(operationIds);
        draft.outbox = draft.outbox.filter((operation) => !ids.has(operation.operationId));
        return Promise.resolve();
      },
      acknowledgeOperations(_owner, operationIds) {
        guard('acknowledgeOperations');
        const ids = new Set<string>(operationIds);
        draft.outbox = draft.outbox.filter((operation) => !ids.has(operation.operationId));
        return Promise.resolve();
      },
      setRecordSyncBase(ref, serverRevision, hash) {
        guard('setRecordSyncBase');
        const k = key(ref.type, ref.id);
        const record = draft.records.get(k);
        if (record === undefined) throw new MemoryFailure('write_conflict');
        draft.records.set(k, { ...record, serverRevision, baseSnapshotHash: hash });
        return Promise.resolve();
      },
      readBaseSnapshot(ref) {
        guard('readBaseSnapshot');
        const snapshot = draft.snapshots.get(key(ref.type, ref.id));
        return Promise.resolve(snapshot === undefined ? null : clone(snapshot));
      },
      writeBaseSnapshot(ref, snapshot) {
        guard('writeBaseSnapshot');
        draft.snapshots.set(key(ref.type, ref.id), clone(snapshot));
        return Promise.resolve();
      },
      deleteBaseSnapshot(ref) {
        guard('deleteBaseSnapshot');
        draft.snapshots.delete(key(ref.type, ref.id));
        return Promise.resolve();
      },
      readDeletion(ref) {
        guard('readDeletion');
        const entry = draft.ledger.get(key(ref.type, ref.id));
        return Promise.resolve(entry === undefined ? null : { ...entry });
      },
      setDeletionServerRevision(ref, serverRevision) {
        guard('setDeletionServerRevision');
        const k = key(ref.type, ref.id);
        const entry = draft.ledger.get(k);
        if (entry === undefined) throw new MemoryFailure('write_conflict');
        draft.ledger.set(k, { ...entry, serverRevision });
        return Promise.resolve();
      },
      recordRemoteDeletion(ref, serverRevision) {
        guard('recordRemoteDeletion');
        const k = key(ref.type, ref.id);
        const entry = draft.ledger.get(k);
        draft.ledger.set(k, {
          localRevision: entry?.localRevision ?? 1,
          serverRevision: Math.max(entry?.serverRevision ?? 0, serverRevision),
        });
        return Promise.resolve();
      },
      clearDeletion(ref) {
        guard('clearDeletion');
        draft.ledger.delete(key(ref.type, ref.id));
        return Promise.resolve();
      },
      createProfileFromRemote(ref, document) {
        guard('createProfileFromRemote');
        if ([...draft.records.values()].some((record) => record.ref.type === 'profile')) {
          throw new MemoryFailure('write_conflict');
        }
        draft.records.set(key(ref.type, ref.id), {
          ref,
          localRevision: 1,
          serverRevision: 0,
          baseSnapshotHash: null,
          document: clone(document),
        });
        return Promise.resolve();
      },
      validateDocument(entityType, document) {
        guard('validateDocument');
        return validate(entityType, document);
      },
      isRecordRefusal(error) {
        return error instanceof MemoryFailure;
      },
      danglingReferences() {
        guard('danglingReferences');
        return Promise.resolve(referencesOf(draft));
      },
      openConflicts() {
        guard('openConflicts');
        return Promise.resolve(
          clone([...draft.conflicts.values()].filter((conflict) => conflict.state === 'open')),
        );
      },
      readConflict(_owner, conflictId) {
        guard('readConflict');
        const conflict = draft.conflicts.get(conflictId);
        return Promise.resolve(conflict === undefined ? null : clone(conflict));
      },
      conflictsAwaitingClosure() {
        guard('conflictsAwaitingClosure');
        return Promise.resolve(
          clone(
            [...draft.conflicts.values()].filter(
              (conflict) => conflict.state === 'resolved' && conflict.payload.closure === 'pending',
            ),
          ),
        );
      },
      conflictsForServerId(_owner, serverConflictId) {
        guard('conflictsForServerId');
        return Promise.resolve(
          clone(
            [...draft.conflicts.values()].filter((conflict) =>
              conflict.payload.serverConflictIds.includes(serverConflictId),
            ),
          ),
        );
      },
      insertConflict(_owner, conflict) {
        guard('insertConflict');
        if (draft.conflicts.has(conflict.conflictId)) throw new MemoryFailure('write_conflict');
        draft.conflicts.set(conflict.conflictId, clone(conflict));
        return Promise.resolve();
      },
      updateConflict(_owner, conflictId, update) {
        guard('updateConflict');
        const conflict = draft.conflicts.get(conflictId);
        if (conflict === undefined) throw new MemoryFailure('write_conflict');
        draft.conflicts.set(conflictId, {
          ...conflict,
          ...(update.state === undefined ? {} : { state: update.state }),
          ...(update.payload === undefined ? {} : { payload: clone(update.payload) }),
          ...(update.resolutionStrategy === undefined
            ? {}
            : { resolutionStrategy: update.resolutionStrategy }),
          ...(update.resolvedAt === undefined ? {} : { resolvedAt: update.resolvedAt }),
        });
        return Promise.resolve();
      },
      readCheckpoint() {
        guard('readCheckpoint');
        return Promise.resolve({ ...draft.checkpoint });
      },
      writeCheckpoint(_owner, _replica, update) {
        guard('writeCheckpoint');
        draft.checkpoint = {
          cursor: update.cursor,
          lastSuccessAt: update.lastSuccessAt ?? draft.checkpoint.lastSuccessAt,
        };
        return Promise.resolve();
      },
    };
  }
}

/** `…Id` fields of live documents must name a live record (when the target type is known). */
function referencesOf(state: MemoryState): SyncDanglingReference[] {
  const byId = new Map<string, StoredRecord>();
  for (const record of state.records.values()) byId.set(record.ref.id, record);
  const dangling: SyncDanglingReference[] = [];
  for (const record of state.records.values()) {
    for (const [field, value] of Object.entries(record.document)) {
      if (!field.endsWith('Id') || field === 'profileId' || typeof value !== 'string') continue;
      if (!uuidPattern.test(value) || byId.has(value)) continue;
      const parentType = field.slice(0, -2) as EntityType;
      dangling.push({
        child: { entityType: record.ref.type, entityId: record.ref.id },
        parent: { entityType: parentType, entityId: value as UUID },
      });
    }
  }
  return dangling;
}

export function memoryRef(type: EntityType, id: string, ownerId: OwnerId): EntityRef {
  return createEntityRef(type, id as UUID, ownerId);
}

export type { SyncConflictPayload };
