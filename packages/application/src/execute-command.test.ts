import {
  createDeletionTombstone,
  entityRefKey,
  type CommandId,
  type DomainChange,
  type EntityRef,
  type EntityRefKey,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import { executeCommand, type CommandHandler } from './execute-command';
import type {
  ApplicationDependencies,
  CanonicalMutation,
  CanonicalRecordRepository,
  CanonicalRecordState,
  CommandEnvelope,
  CommandReceipt,
  CommandReceiptStore,
  DomainEventRecord,
  DomainEventStore,
  IdentityContextPort,
  OutboxMutationGroup,
  OutboxStore,
  PlanningRecordReader,
  PlanningUnitOfWork,
  ProjectionInvalidation,
  ProjectionInvalidationPort,
  UndoDescriptorRecord,
  UndoDescriptorStore,
  UnitOfWorkPort,
} from './index';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const otherOwnerId = '10000000-0000-4000-8000-000000000002' as OwnerId;
const entityId = '20000000-0000-4000-8000-000000000001' as EntityRef['id'];
const now = '2026-07-23T09:00:00.000Z' as Instant;

const entity: EntityRef = {
  type: 'action',
  id: entityId,
  ownerId,
};

interface CompleteInput {
  readonly ref: EntityRef;
  readonly expectedRevision: number;
  readonly includeUndo: boolean;
}

interface FakeState {
  readonly records: Map<EntityRefKey, CanonicalRecordState>;
  readonly events: DomainEventRecord[];
  readonly undo: UndoDescriptorRecord[];
  readonly outbox: OutboxMutationGroup[];
  readonly receipts: Map<string, CommandReceipt>;
}

type FaultPoint = 'records' | 'events' | 'undo' | 'outbox' | 'receipts';

class FakeUnitOfWork implements UnitOfWorkPort {
  state: FakeState;
  applyCalls = 0;
  readCalls = 0;

  constructor(
    initialRecord: CanonicalRecordState,
    private readonly faultAt?: FaultPoint,
  ) {
    this.state = {
      records: new Map([[entityRefKey(initialRecord.ref), initialRecord]]),
      events: [],
      undo: [],
      outbox: [],
      receipts: new Map(),
    };
  }

  async runInTransaction<T>(work: (unitOfWork: PlanningUnitOfWork) => Promise<T>): Promise<T> {
    const draft = cloneState(this.state);
    let active = true;

    try {
      const result = await work(this.createCapabilities(draft, () => active));
      this.state = draft;
      return result;
    } finally {
      active = false;
    }
  }

  private createCapabilities(state: FakeState, isActive: () => boolean): PlanningUnitOfWork {
    const assertActive = (): void => {
      if (!isActive()) {
        throw new Error('Transaction capability used outside its callback');
      }
    };
    const failAt = (point: FaultPoint): void => {
      assertActive();
      if (this.faultAt === point) {
        throw new Error(`Injected ${point} failure`);
      }
    };

    const records: CanonicalRecordRepository = {
      read: (ref) => {
        assertActive();
        this.readCalls += 1;
        return Promise.resolve(state.records.get(entityRefKey(ref)) ?? null);
      },
      apply: (mutation) => {
        this.applyCalls += 1;
        failAt('records');
        const key = entityRefKey(mutation.ref);
        const current = state.records.get(key);

        if (mutation.operation === 'create') {
          if (current !== undefined) {
            throw new Error('Fake create collision');
          }
        } else if (current === undefined || current.localRevision !== mutation.expectedRevision) {
          throw new Error('Fake revision conflict');
        }

        const nextRevision = (current?.localRevision ?? 0) + 1;
        if (mutation.operation === 'delete') {
          state.records.delete(key);
          return Promise.resolve({
            ref: mutation.ref,
            operation: mutation.operation,
            localRevision: nextRevision,
          });
        }

        const next: CanonicalRecordState = {
          ref: mutation.ref,
          localRevision: nextRevision,
          serverRevision: mutation.baseServerRevision,
          baseSnapshotHash: mutation.baseSnapshotHash,
          document: mutation.document,
        };
        state.records.set(key, next);
        return Promise.resolve({
          ref: next.ref,
          operation: mutation.operation,
          localRevision: next.localRevision,
        });
      },
    };

    const events: DomainEventStore = {
      append: (recordsToAppend) => {
        failAt('events');
        state.events.push(...recordsToAppend);
        return Promise.resolve();
      },
    };

    const undo: UndoDescriptorStore = {
      append: (record) => {
        failAt('undo');
        state.undo.push(record);
        return Promise.resolve();
      },
      find: (undoOwnerId, undoId) => {
        const record = state.undo.find(
          (candidate) => candidate.ownerId === undoOwnerId && candidate.undoId === undoId,
        );
        return Promise.resolve(
          record === undefined
            ? null
            : { ...record, state: 'available' as const, localRevision: 1 },
        );
      },
      markApplied: (undoOwnerId, undoId) => {
        const index = state.undo.findIndex(
          (candidate) => candidate.ownerId === undoOwnerId && candidate.undoId === undoId,
        );
        if (index < 0) throw new Error('Fake undo missing');
        state.undo.splice(index, 1);
        return Promise.resolve();
      },
    };

    const outbox: OutboxStore = {
      append: (group) => {
        failAt('outbox');
        state.outbox.push(group);
        return Promise.resolve();
      },
    };

    const receipts: CommandReceiptStore = {
      find: (receiptOwnerId, commandId) =>
        Promise.resolve(state.receipts.get(receiptKey(receiptOwnerId, commandId)) ?? null),
      append: (receipt) => {
        failAt('receipts');
        state.receipts.set(receiptKey(receipt.ownerId, receipt.commandId), receipt);
        return Promise.resolve();
      },
    };

    return { records, events, undo, outbox, receipts };
  }
}

class FakeProjectionInvalidation implements ProjectionInvalidationPort {
  readonly notifications: ProjectionInvalidation[] = [];
  readonly committedReceiptObserved: boolean[] = [];

  constructor(private readonly readState: () => FakeState) {}

  notifyCommitted(invalidation: ProjectionInvalidation): void {
    this.notifications.push(invalidation);
    this.committedReceiptObserved.push(
      this.readState().receipts.has(receiptKey(invalidation.ownerId, invalidation.commandId)),
    );
  }
}

function cloneState(state: FakeState): FakeState {
  return {
    records: new Map(
      [...state.records].map(([key, record]) => [
        key,
        { ...record, document: { ...record.document } },
      ]),
    ),
    events: [...state.events],
    undo: [...state.undo],
    outbox: [...state.outbox],
    receipts: new Map(state.receipts),
  };
}

function receiptKey(receiptOwnerId: OwnerId, commandId: CommandId): string {
  return `${receiptOwnerId}:${commandId}`;
}

function makeEnvelope(
  commandId: CommandId,
  commandOwnerId: OwnerId = ownerId,
): CommandEnvelope<CompleteInput> {
  return {
    commandId,
    ownerId: commandOwnerId,
    actor: 'user',
    expectedRevisions: [{ ref: entity, revision: 1 }],
    input: { ref: entity, expectedRevision: 1, includeUndo: true },
  };
}

function makeIdProvider(): ApplicationDependencies['ids'] {
  let sequence = 1;
  return {
    next() {
      const suffix = String(sequence).padStart(12, '0');
      sequence += 1;
      return `00000000-0000-4000-8000-${suffix}` as UUID;
    },
  };
}

function makeHarness(
  syncEnabled: boolean,
  faultAt?: FaultPoint,
): {
  readonly dependencies: ApplicationDependencies;
  readonly transaction: FakeUnitOfWork;
  readonly projections: FakeProjectionInvalidation;
} {
  const initialRecord: CanonicalRecordState = {
    ref: entity,
    localRevision: 1,
    serverRevision: 4,
    baseSnapshotHash: 'base-v4',
    document: { status: 'planned' },
  };
  const transaction = new FakeUnitOfWork(initialRecord, faultAt);
  const projections = new FakeProjectionInvalidation(() => transaction.state);
  const identityContext: IdentityContextPort = {
    getActiveIdentity: () => Promise.resolve({ ownerId, syncEnabled }),
  };

  return {
    transaction,
    projections,
    dependencies: {
      unitOfWork: transaction,
      identityContext,
      projections,
      clock: { now: () => now },
      ids: makeIdProvider(),
    },
  };
}

function makeCompleteHandler(onCall?: () => void): CommandHandler<CompleteInput> {
  return async ({ context, input, records }) => {
    onCall?.();
    const current = await records.read(input.ref);

    if (current === null) {
      return {
        ok: false,
        error: { code: 'invalid_value', message: 'The planning record does not exist.' },
      };
    }

    const mutation: CanonicalMutation = {
      ref: input.ref,
      operation: 'update',
      expectedRevision: input.expectedRevision,
      baseServerRevision: current.serverRevision,
      baseSnapshotHash: current.baseSnapshotHash,
      document: { status: 'completed' },
    };
    const change: DomainChange<readonly CanonicalMutation[]> = {
      value: [mutation],
      events: [
        {
          aggregate: input.ref,
          eventType: 'planning_status_changed',
          version: 1,
          actor: context.actor,
          commandId: context.commandId,
          occurredAt: context.now,
          payload: { changedFields: ['status'] },
        },
      ],
      touched: [input.ref],
      ...(input.includeUndo
        ? {
            undo: {
              commandType: 'restore_planning_status',
              version: 1,
              payload: { status: 'planned' },
              expectedRevisions: {
                [entityRefKey(input.ref)]: current.localRevision + 1,
              },
            },
          }
        : {}),
    };

    return { ok: true, value: change };
  };
}

function makeDeleteHandler(
  options: {
    readonly includeUndo?: boolean;
    readonly invalidRevision?: boolean;
    readonly privateMarker?: string;
  } = {},
): CommandHandler<CompleteInput> {
  return async ({ context, input, records }) => {
    const current = await records.read(input.ref);
    if (current === null) {
      return {
        ok: false,
        error: { code: 'invalid_value', message: 'The planning record does not exist.' },
      };
    }

    const nextRevision = current.localRevision + 1;
    const minimalTombstone = createDeletionTombstone(
      input.ref,
      options.invalidRevision === true ? nextRevision + 1 : nextRevision,
      context.now,
    );
    const tombstone =
      options.privateMarker === undefined
        ? minimalTombstone
        : { ...minimalTombstone, privateTitle: options.privateMarker };
    return {
      ok: true,
      value: {
        value: [
          {
            ref: input.ref,
            operation: 'delete',
            expectedRevision: current.localRevision,
            baseServerRevision: current.serverRevision,
            baseSnapshotHash: current.baseSnapshotHash,
            tombstone,
          },
        ],
        events: [
          {
            aggregate: input.ref,
            eventType: 'planning_record_permanently_deleted',
            version: 1,
            actor: context.actor,
            commandId: context.commandId,
            occurredAt: context.now,
            payload: { changedFields: ['deleted_at'] },
          },
        ],
        touched: [input.ref],
        ...(options.includeUndo === true
          ? {
              undo: {
                commandType: 'restore_deleted_record',
                version: 1 as const,
                payload: {},
                expectedRevisions: { [entityRefKey(input.ref)]: nextRevision },
              },
            }
          : {}),
      },
    };
  };
}

describe('executeCommand', () => {
  it('atomically commits canonical state, audit, undo, one outbox group, receipt, then notifies', async () => {
    const harness = makeHarness(true);
    const result = await executeCommand(
      harness.dependencies,
      makeEnvelope('30000000-0000-4000-8000-000000000001' as CommandId),
      makeCompleteHandler(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected an accepted command');
    }

    const committed = harness.transaction.state.records.get(entityRefKey(entity));
    expect(committed).toMatchObject({ localRevision: 2, document: { status: 'completed' } });
    expect(harness.transaction.state.events).toHaveLength(1);
    expect(harness.transaction.state.undo).toHaveLength(1);
    expect(harness.transaction.state.outbox).toHaveLength(1);
    expect(harness.transaction.state.receipts).toHaveLength(1);
    expect(harness.projections.notifications).toHaveLength(1);
    expect(harness.projections.committedReceiptObserved).toEqual([true]);
    expect(result.value.canonical).toEqual([{ ref: entity, localRevision: 2 }]);
    expect(result.value.undo).toMatchObject({ available: true });
    expect(result.value.sync).toMatchObject({ queued: true });

    const [group] = harness.transaction.state.outbox;
    expect(group?.operations).toHaveLength(1);
    expect(group?.operations.map((operation) => operation.sequence)).toEqual([0]);
    expect(group?.operations[0]).toMatchObject({
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      mutation: { document: { status: 'completed' } },
    });
  });

  it('returns a typed domain validation failure without opening a write path', async () => {
    const harness = makeHarness(true);
    const result = await executeCommand(
      harness.dependencies,
      makeEnvelope('30000000-0000-4000-8000-000000000002' as CommandId),
      () => ({
        ok: false,
        error: { code: 'invalid_transition', message: 'The transition is not allowed.' },
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: { code: 'invalid_transition', message: 'The transition is not allowed.' },
      },
    });
    expect(harness.transaction.state.records.get(entityRefKey(entity))?.localRevision).toBe(1);
    expect(harness.transaction.state.events).toEqual([]);
    expect(harness.transaction.state.receipts).toHaveLength(0);
    expect(harness.projections.notifications).toEqual([]);
  });

  it('rejects a multi-record change when any mutated entity lacks an audit event', async () => {
    const harness = makeHarness(true);
    const secondEntity: EntityRef = {
      ...entity,
      id: '20000000-0000-4000-8000-000000000002' as EntityRef['id'],
    };
    const baseHandler = makeCompleteHandler();
    const result = await executeCommand(
      harness.dependencies,
      makeEnvelope('30000000-0000-4000-8000-000000000014' as CommandId),
      async (request) => {
        const base = await baseHandler(request);
        if (!base.ok) return base;
        return {
          ok: true,
          value: {
            ...base.value,
            value: [
              ...base.value.value,
              {
                ref: secondEntity,
                operation: 'create' as const,
                expectedRevision: null,
                baseServerRevision: 0,
                baseSnapshotHash: null,
                document: { status: 'planned' },
              },
            ],
            touched: [...base.value.touched, secondEntity],
          },
        };
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_command_plan', reason: 'missing_entity_audit_event' },
    });
    expect(harness.transaction.applyCalls).toBe(0);
  });

  it('rejects a stale expected revision before invoking the domain handler', async () => {
    const harness = makeHarness(true);
    let handlerCalls = 0;
    const envelope = makeEnvelope('30000000-0000-4000-8000-000000000003' as CommandId);
    const staleEnvelope: CommandEnvelope<CompleteInput> = {
      ...envelope,
      expectedRevisions: [{ ref: entity, revision: 0 }],
    };

    const result = await executeCommand(
      harness.dependencies,
      staleEnvelope,
      makeCompleteHandler(() => {
        handlerCalls += 1;
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'revision_conflict', expectedRevision: 0, actualRevision: 1 },
    });
    expect(handlerCalls).toBe(0);
    expect(harness.transaction.applyCalls).toBe(0);
    expect(harness.transaction.state.receipts).toHaveLength(0);
    expect(harness.projections.notifications).toEqual([]);
  });

  it('rejects an envelope for a different active owner', async () => {
    const harness = makeHarness(true);
    let handlerCalls = 0;
    const result = await executeCommand(
      harness.dependencies,
      makeEnvelope('30000000-0000-4000-8000-000000000004' as CommandId, otherOwnerId),
      makeCompleteHandler(() => {
        handlerCalls += 1;
      }),
    );

    expect(result).toEqual({ ok: false, error: { code: 'owner_mismatch' } });
    expect(handlerCalls).toBe(0);
    expect(harness.transaction.applyCalls).toBe(0);
    expect(harness.projections.notifications).toEqual([]);
  });

  it('does not expose a foreign-owner record through the handler read capability', async () => {
    const harness = makeHarness(true);
    const foreignRef: EntityRef = { ...entity, ownerId: otherOwnerId };
    const envelope = makeEnvelope('30000000-0000-4000-8000-000000000013' as CommandId);
    const readsBeforeHandler = harness.transaction.readCalls;
    let observed: CanonicalRecordState | null | undefined;

    const result = await executeCommand(harness.dependencies, envelope, async ({ records }) => {
      observed = await records.read(foreignRef);
      return {
        ok: false,
        error: { code: 'invalid_value', message: 'Synthetic result must be ignored.' },
      };
    });

    expect(result).toEqual({ ok: false, error: { code: 'owner_mismatch' } });
    expect(observed).toBeNull();
    // The own-owner envelope preflight reads once; the foreign ref never reaches the adapter.
    expect(harness.transaction.readCalls - readsBeforeHandler).toBe(1);
    expect(harness.transaction.applyCalls).toBe(0);
  });

  it('returns the original receipt for a repeated command ID without duplicate effects', async () => {
    const harness = makeHarness(true);
    let handlerCalls = 0;
    const envelope = makeEnvelope('30000000-0000-4000-8000-000000000005' as CommandId);
    const handler = makeCompleteHandler(() => {
      handlerCalls += 1;
    });

    const first = await executeCommand(harness.dependencies, envelope, handler);
    const replay = await executeCommand(harness.dependencies, envelope, handler);

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(handlerCalls).toBe(1);
    expect(harness.transaction.applyCalls).toBe(1);
    expect(harness.transaction.state.events).toHaveLength(1);
    expect(harness.transaction.state.outbox).toHaveLength(1);
    expect(harness.projections.notifications).toHaveLength(1);
  });

  it.each([
    { syncEnabled: false, expectedGroups: 0, expectedQueued: false },
    { syncEnabled: true, expectedGroups: 1, expectedQueued: true },
  ])(
    'keeps local commit independent when sync enabled is $syncEnabled',
    async ({ syncEnabled, expectedGroups, expectedQueued }) => {
      const harness = makeHarness(syncEnabled);
      const result = await executeCommand(
        harness.dependencies,
        makeEnvelope('30000000-0000-4000-8000-000000000006' as CommandId),
        makeCompleteHandler(),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('Expected an accepted local command');
      }
      expect(harness.transaction.state.records.get(entityRefKey(entity))?.localRevision).toBe(2);
      expect(harness.transaction.state.outbox).toHaveLength(expectedGroups);
      expect(result.value.sync.queued).toBe(expectedQueued);
    },
  );

  it.each(['records', 'events', 'undo', 'outbox', 'receipts'] as const)(
    'rolls back every staged write and does not notify after an injected %s fault',
    async (faultAt) => {
      const harness = makeHarness(true, faultAt);
      const result = await executeCommand(
        harness.dependencies,
        makeEnvelope('30000000-0000-4000-8000-000000000007' as CommandId),
        makeCompleteHandler(),
      );

      expect(result).toEqual({ ok: false, error: { code: 'transaction_failed' } });
      expect(harness.transaction.state.records.get(entityRefKey(entity))).toMatchObject({
        localRevision: 1,
        document: { status: 'planned' },
      });
      expect(harness.transaction.state.events).toEqual([]);
      expect(harness.transaction.state.undo).toEqual([]);
      expect(harness.transaction.state.outbox).toEqual([]);
      expect(harness.transaction.state.receipts).toHaveLength(0);
      expect(harness.projections.notifications).toEqual([]);
    },
  );

  it('describes undo availability explicitly when a command has no safe inverse', async () => {
    const harness = makeHarness(false);
    const envelope = makeEnvelope('30000000-0000-4000-8000-000000000008' as CommandId);
    const result = await executeCommand(
      harness.dependencies,
      { ...envelope, input: { ...envelope.input, includeUndo: false } },
      makeCompleteHandler(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected an accepted command');
    }
    expect(result.value.undo).toEqual({ available: false });
    expect(harness.transaction.state.undo).toEqual([]);
  });

  it('accepts only a minimal permanent-delete tombstone and never queues deleted content', async () => {
    const harness = makeHarness(true);
    const envelope = makeEnvelope('30000000-0000-4000-8000-000000000010' as CommandId);
    const result = await executeCommand(
      harness.dependencies,
      { ...envelope, input: { ...envelope.input, includeUndo: false } },
      makeDeleteHandler(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected permanent deletion to be accepted');
    expect(harness.transaction.state.records.has(entityRefKey(entity))).toBe(false);
    expect(result.value.undo).toEqual({ available: false });
    const queued = harness.transaction.state.outbox[0]?.operations[0]?.mutation;
    expect(queued).toEqual({
      ref: entity,
      operation: 'delete',
      expectedRevision: 1,
      baseServerRevision: 4,
      baseSnapshotHash: 'base-v4',
      tombstone: {
        ownerId,
        entityType: 'action',
        entityId,
        revision: 2,
        deletedAt: now,
      },
    });
    expect(queued).not.toHaveProperty('document');
    expect(JSON.stringify(queued)).not.toContain('planned');
  });

  it('rejects malformed or undoable permanent-delete plans before applying them', async () => {
    const malformedHarness = makeHarness(true);
    const malformedEnvelope = makeEnvelope('30000000-0000-4000-8000-000000000011' as CommandId);
    const malformed = await executeCommand(
      malformedHarness.dependencies,
      { ...malformedEnvelope, input: { ...malformedEnvelope.input, includeUndo: false } },
      makeDeleteHandler({ invalidRevision: true }),
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: 'invalid_command_plan', reason: 'invalid_delete_tombstone' },
    });
    expect(malformedHarness.transaction.applyCalls).toBe(0);

    const undoHarness = makeHarness(true);
    const undoEnvelope = makeEnvelope('30000000-0000-4000-8000-000000000012' as CommandId);
    const undoable = await executeCommand(
      undoHarness.dependencies,
      { ...undoEnvelope, input: { ...undoEnvelope.input, includeUndo: false } },
      makeDeleteHandler({ includeUndo: true }),
    );
    expect(undoable).toMatchObject({
      ok: false,
      error: { code: 'invalid_command_plan', reason: 'permanent_delete_not_undoable' },
    });
    expect(undoHarness.transaction.applyCalls).toBe(0);
  });

  it('rejects a permanent-delete tombstone with an extra private field before apply', async () => {
    const harness = makeHarness(true);
    const envelope = makeEnvelope('30000000-0000-4000-8000-000000000013' as CommandId);
    const privateMarker = 'private deleted planning title';

    const result = await executeCommand(
      harness.dependencies,
      { ...envelope, input: { ...envelope.input, includeUndo: false } },
      makeDeleteHandler({ privateMarker }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_command_plan', reason: 'invalid_delete_tombstone' },
    });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(harness.transaction.applyCalls).toBe(0);
    expect(harness.transaction.state.records.has(entityRefKey(entity))).toBe(true);
    expect(harness.transaction.state.events).toEqual([]);
    expect(harness.transaction.state.outbox).toEqual([]);
    expect(harness.transaction.state.receipts).toHaveLength(0);
  });

  it('does not leave a usable transaction capability after the callback settles', async () => {
    const harness = makeHarness(false);
    let capturedReader: PlanningRecordReader | undefined;
    const delegate = makeCompleteHandler();
    const handler: CommandHandler<CompleteInput> = (request) => {
      expect('apply' in request.records).toBe(false);
      capturedReader = request.records;
      return delegate(request);
    };

    const result = await executeCommand(
      harness.dependencies,
      makeEnvelope('30000000-0000-4000-8000-000000000009' as CommandId),
      handler,
    );

    expect(result.ok).toBe(true);
    const reader = capturedReader;
    if (reader === undefined) {
      throw new Error('Expected the decision handler to receive a scoped reader');
    }
    expect(() => reader.read(entity)).toThrow('outside its callback');
  });
});
