import {
  createEntityRef,
  entityRefKey,
  type CommandId,
  type EntityId,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type TimeBlock,
  type UUID,
} from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import { createTimeBlockApplication, type TimeBlockQueryPort } from './time-blocks';
import type {
  ApplicationDependencies,
  CanonicalRecordState,
  CommandReceipt,
  DomainEventRecord,
  IdentityContextPort,
  OutboxMutationGroup,
  PlanningUnitOfWork,
  ProjectionInvalidation,
  ProjectionInvalidationPort,
  UndoDescriptorRecord,
  UnitOfWorkPort,
} from './index';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const now = '2026-08-01T12:00:00.000Z' as Instant;
const tz = 'America/New_York';

interface FakeState {
  readonly records: Map<string, CanonicalRecordState>;
  readonly events: DomainEventRecord[];
  readonly undo: UndoDescriptorRecord[];
  readonly outbox: OutboxMutationGroup[];
  readonly receipts: Map<string, CommandReceipt>;
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

class FakeUnitOfWork implements UnitOfWorkPort {
  state: FakeState = {
    records: new Map(),
    events: [],
    undo: [],
    outbox: [],
    receipts: new Map(),
  };

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
      if (!isActive()) throw new Error('Transaction capability used outside its callback');
    };
    return {
      records: {
        read: (ref) => {
          assertActive();
          return Promise.resolve(state.records.get(entityRefKey(ref)) ?? null);
        },
        apply: (mutation) => {
          assertActive();
          const key = entityRefKey(mutation.ref);
          const current = state.records.get(key);
          if (mutation.operation === 'create') {
            if (current !== undefined) throw new Error('Fake create collision');
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
      },
      events: {
        append: (records) => {
          state.events.push(...records);
          return Promise.resolve();
        },
      },
      undo: {
        append: (record) => {
          state.undo.push(record);
          return Promise.resolve();
        },
        find: (undoOwnerId, undoId) => {
          const record = state.undo.find((c) => c.ownerId === undoOwnerId && c.undoId === undoId);
          return Promise.resolve(
            record === undefined
              ? null
              : { ...record, state: 'available' as const, localRevision: 1 },
          );
        },
        markApplied: (undoOwnerId, undoId) => {
          const index = state.undo.findIndex(
            (c) => c.ownerId === undoOwnerId && c.undoId === undoId,
          );
          if (index < 0) throw new Error('Fake undo missing');
          state.undo.splice(index, 1);
          return Promise.resolve();
        },
      },
      outbox: {
        append: (group) => {
          state.outbox.push(group);
          return Promise.resolve();
        },
      },
      receipts: {
        find: (rOwnerId, commandId) =>
          Promise.resolve(state.receipts.get(receiptKey(rOwnerId, commandId)) ?? null),
        append: (receipt) => {
          state.receipts.set(receiptKey(receipt.ownerId, receipt.commandId), receipt);
          return Promise.resolve();
        },
      },
    };
  }
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

function makeHarness() {
  const unitOfWork = new FakeUnitOfWork();
  const projections: ProjectionInvalidationPort & {
    notifications: ProjectionInvalidation[];
  } = {
    notifications: [],
    notifyCommitted(invalidation) {
      this.notifications.push(invalidation);
    },
  };
  const identityContext: IdentityContextPort = {
    getActiveIdentity: () => Promise.resolve({ ownerId, syncEnabled: false }),
  };
  const dependencies: ApplicationDependencies = {
    unitOfWork,
    identityContext,
    projections,
    clock: { now: () => now },
    ids: makeIdProvider(),
  };
  const queries: TimeBlockQueryPort = {
    listBlocksInRange: () => Promise.resolve([]),
    getBlockRecord: () => Promise.resolve(null),
  };
  return { dependencies, unitOfWork, projections, queries };
}

describe('TimeBlockApplication', () => {
  describe('create', () => {
    it('creates a planned time block', async () => {
      const { dependencies, unitOfWork, queries } = makeHarness();
      const app = createTimeBlockApplication(dependencies, queries);
      const result = await app.create({
        target: { kind: 'custom', title: 'Deep work' },
        startsAt: '2026-08-01T09:00:00.000Z',
        endsAt: '2026-08-01T10:00:00.000Z',
        timeZone: tz,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected success');
      expect(result.value.canonical).toHaveLength(1);
      expect(unitOfWork.state.events).toHaveLength(1);
      expect(unitOfWork.state.events[0]!.event.eventType).toBe('timeBlock.created');
    });

    it('rejects invalid interval', async () => {
      const { dependencies, queries } = makeHarness();
      const app = createTimeBlockApplication(dependencies, queries);
      const result = await app.create({
        target: { kind: 'custom', title: 'Too short' },
        startsAt: '2026-08-01T09:00:00.000Z',
        endsAt: '2026-08-01T09:03:00.000Z', // 3 minutes < 5 min
        timeZone: tz,
      });
      expect(result.ok).toBe(false);
    });

    it('rejects overlap without acknowledgement', async () => {
      const blockId = '20000000-0000-4000-8000-000000000099' as EntityId;
      const { dependencies, queries } = makeHarness();
      const overlapping: TimeBlock = {
        id: blockId,
        ownerId,
        localRevision: 1,
        createdAt: now,
        updatedAt: now,
        target: { kind: 'custom', title: 'Existing' },
        interval: {
          startsAt: '2026-08-01T09:00:00.000Z' as Instant,
          endsAt: '2026-08-01T10:00:00.000Z' as Instant,
          timeZone: 'America/New_York' as IanaTimeZone,
        },
        state: 'planned',
      };
      queries.listBlocksInRange = () => Promise.resolve([overlapping]);

      const app = createTimeBlockApplication(dependencies, queries);
      const result = await app.create({
        target: { kind: 'custom', title: 'Conflicting' },
        startsAt: '2026-08-01T09:30:00.000Z',
        endsAt: '2026-08-01T10:30:00.000Z',
        timeZone: tz,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('domain_rejected');
      }
    });

    it('accepts overlap with acknowledgement', async () => {
      const blockId = '20000000-0000-4000-8000-000000000099' as EntityId;
      const { dependencies, queries, unitOfWork } = makeHarness();
      const overlapping: TimeBlock = {
        id: blockId,
        ownerId,
        localRevision: 1,
        createdAt: now,
        updatedAt: now,
        target: { kind: 'custom', title: 'Existing' },
        interval: {
          startsAt: '2026-08-01T09:00:00.000Z' as Instant,
          endsAt: '2026-08-01T10:00:00.000Z' as Instant,
          timeZone: 'America/New_York' as IanaTimeZone,
        },
        state: 'planned',
      };
      queries.listBlocksInRange = () => Promise.resolve([overlapping]);

      const app = createTimeBlockApplication(dependencies, queries);
      const result = await app.create({
        target: { kind: 'custom', title: 'Acknowledged overlap' },
        startsAt: '2026-08-01T09:30:00.000Z',
        endsAt: '2026-08-01T10:30:00.000Z',
        timeZone: tz,
        overlapAcknowledged: true,
      });
      expect(result.ok).toBe(true);
      // Check that overlapAcknowledged is persisted
      const records = [...unitOfWork.state.records.values()];
      const doc = records[0]?.document as { overlapAcknowledged: boolean };
      expect(doc?.overlapAcknowledged).toBe(true);
    });
  });

  describe('reschedule', () => {
    it('atomically cancels old and creates new block', async () => {
      const blockId = '20000000-0000-4000-8000-000000000001' as UUID;
      const { dependencies, unitOfWork, queries } = makeHarness();
      const existingRef = createEntityRef('time_block', blockId, ownerId);
      const existingRecord: CanonicalRecordState = {
        ref: existingRef,
        localRevision: 1,
        serverRevision: 0,
        baseSnapshotHash: null,
        document: {
          target: { kind: 'custom', title: 'Morning focus' },
          startsAt: '2026-08-01T09:00:00.000Z',
          endsAt: '2026-08-01T10:00:00.000Z',
          timeZone: 'America/New_York',
          state: 'planned',
          overlapAcknowledged: false,
        },
      };
      // Seed the record in the fake UoW
      unitOfWork.state.records.set(entityRefKey(existingRef), existingRecord);

      queries.getBlockRecord = (_o, id) =>
        id === blockId ? Promise.resolve(existingRecord) : Promise.resolve(null);

      const app = createTimeBlockApplication(dependencies, queries);
      const result = await app.reschedule({
        timeBlockId: blockId,
        revision: 1,
        newStartsAt: '2026-08-01T14:00:00.000Z',
        newEndsAt: '2026-08-01T15:00:00.000Z',
        newTimeZone: tz,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected success');
      // Should have 2 canonical changes: cancel old + create new
      expect(result.value.canonical).toHaveLength(2);
      expect(unitOfWork.state.events).toHaveLength(2);

      // Old block should be canceled and marked superseded
      const oldRecord = unitOfWork.state.records.get(entityRefKey(existingRef));
      expect(oldRecord).toBeDefined();
      const oldDoc = oldRecord!.document as { state: string; supersededById: string };
      expect(oldDoc.state).toBe('canceled');
      expect(oldDoc.supersededById).toBeDefined();

      // New block should exist as planned
      const allRecords = [...unitOfWork.state.records.values()];
      const newRecord = allRecords.find((r) => r.ref.type === 'time_block' && r.ref.id !== blockId);
      expect(newRecord).toBeDefined();
      const newDoc = newRecord!.document as { state: string; startsAt: string };
      expect(newDoc.state).toBe('planned');
      expect(newDoc.startsAt).toBe('2026-08-01T14:00:00.000Z');
    });

    it('rejects reschedule of non-planned block', async () => {
      const blockId = '20000000-0000-4000-8000-000000000001' as UUID;
      const { dependencies, queries } = makeHarness();
      const existingRef = createEntityRef('time_block', blockId, ownerId);
      const existingRecord: CanonicalRecordState = {
        ref: existingRef,
        localRevision: 1,
        serverRevision: 0,
        baseSnapshotHash: null,
        document: {
          target: { kind: 'custom', title: 'Done' },
          startsAt: '2026-08-01T09:00:00.000Z',
          endsAt: '2026-08-01T10:00:00.000Z',
          timeZone: 'America/New_York',
          state: 'completed',
          overlapAcknowledged: false,
        },
      };
      queries.getBlockRecord = () => Promise.resolve(existingRecord);

      const app = createTimeBlockApplication(dependencies, queries);
      const result = await app.reschedule({
        timeBlockId: blockId,
        revision: 1,
        newStartsAt: '2026-08-01T14:00:00.000Z',
        newEndsAt: '2026-08-01T15:00:00.000Z',
        newTimeZone: tz,
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('transition', () => {
    it('completes a planned time block', async () => {
      const blockId = '20000000-0000-4000-8000-000000000001' as UUID;
      const { dependencies, unitOfWork, queries } = makeHarness();
      const ref = createEntityRef('time_block', blockId, ownerId);
      const record: CanonicalRecordState = {
        ref,
        localRevision: 1,
        serverRevision: 0,
        baseSnapshotHash: null,
        document: {
          target: { kind: 'custom', title: 'Work' },
          startsAt: '2026-08-01T09:00:00.000Z',
          endsAt: '2026-08-01T10:00:00.000Z',
          timeZone: 'America/New_York',
          state: 'planned',
          overlapAcknowledged: false,
        },
      };
      unitOfWork.state.records.set(entityRefKey(ref), record);
      queries.getBlockRecord = () => Promise.resolve(record);

      const app = createTimeBlockApplication(dependencies, queries);
      const result = await app.transition({
        timeBlockId: blockId,
        revision: 1,
        to: 'completed',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected success');
      const updated = unitOfWork.state.records.get(entityRefKey(ref));
      expect((updated!.document as { state: string }).state).toBe('completed');
    });

    it('skips a planned time block', async () => {
      const blockId = '20000000-0000-4000-8000-000000000001' as UUID;
      const { dependencies, unitOfWork, queries } = makeHarness();
      const ref = createEntityRef('time_block', blockId, ownerId);
      const record: CanonicalRecordState = {
        ref,
        localRevision: 1,
        serverRevision: 0,
        baseSnapshotHash: null,
        document: {
          target: { kind: 'custom', title: 'Skippable' },
          startsAt: '2026-08-01T09:00:00.000Z',
          endsAt: '2026-08-01T10:00:00.000Z',
          timeZone: 'America/New_York',
          state: 'planned',
          overlapAcknowledged: false,
        },
      };
      unitOfWork.state.records.set(entityRefKey(ref), record);
      queries.getBlockRecord = () => Promise.resolve(record);

      const app = createTimeBlockApplication(dependencies, queries);
      const result = await app.transition({
        timeBlockId: blockId,
        revision: 1,
        to: 'skipped',
      });

      expect(result.ok).toBe(true);
      const updated = unitOfWork.state.records.get(entityRefKey(ref));
      expect((updated!.document as { state: string }).state).toBe('skipped');
    });

    it('rejects invalid transition', async () => {
      const blockId = '20000000-0000-4000-8000-000000000001' as UUID;
      const { dependencies, unitOfWork, queries } = makeHarness();
      const ref = createEntityRef('time_block', blockId, ownerId);
      const record: CanonicalRecordState = {
        ref,
        localRevision: 1,
        serverRevision: 0,
        baseSnapshotHash: null,
        document: {
          target: { kind: 'custom', title: 'Done' },
          startsAt: '2026-08-01T09:00:00.000Z',
          endsAt: '2026-08-01T10:00:00.000Z',
          timeZone: 'America/New_York',
          state: 'completed',
          overlapAcknowledged: false,
        },
      };
      unitOfWork.state.records.set(entityRefKey(ref), record);
      queries.getBlockRecord = () => Promise.resolve(record);

      const app = createTimeBlockApplication(dependencies, queries);
      // completed → skipped is not allowed (must go through planned first)
      const result = await app.transition({
        timeBlockId: blockId,
        revision: 1,
        to: 'skipped',
      });
      expect(result.ok).toBe(false);
    });

    it('returns entity_not_found for missing block', async () => {
      const { dependencies, queries } = makeHarness();
      const app = createTimeBlockApplication(dependencies, queries);
      const result = await app.transition({
        timeBlockId: '20000000-0000-4000-8000-000000000099',
        revision: 1,
        to: 'completed',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('entity_not_found');
    });
  });
});
