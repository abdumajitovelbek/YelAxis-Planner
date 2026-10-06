import {
  createEntityRef,
  entityRefKey,
  occurrenceLogicalKey,
  periodRange,
  rangesOverlap,
  routineOccurrenceId,
  type EntityType,
  type IanaTimeZone,
  type Instant,
  type MaterializedOccurrenceSnapshot,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import type {
  ActionSummary,
  BlockRow,
  ConstraintDocument,
  FocusSelectionDocument,
  PlacedTargetView,
  PlanProfile,
  PlanningPlacementDocument,
  PlanningQueryPort,
  RoutineDocument,
  RoutineOccurrenceDocument,
  TimeBlockDocument,
  WeekSelectionRow,
} from './planning-contracts';
import { createSchedulingCommands } from './planning-scheduling';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const profileId = '10000000-0000-4000-8000-0000000000aa' as UUID;
const now = '2026-08-10T06:00:00.000Z' as Instant;
const zone = 'Europe/Berlin' as IanaTimeZone;
const profile: PlanProfile = {
  profileId,
  planningTimeZone: zone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
const id = (value: number): UUID =>
  `20000000-0000-4000-8000-${String(value).padStart(12, '0')}` as UUID;

type Doc = Readonly<Record<string, unknown>>;

const records = (harness: InMemoryHarness): CanonicalRecordState[] => [
  ...harness.unitOfWork.state.records.values(),
];
const ofType = (harness: InMemoryHarness, type: EntityType): CanonicalRecordState[] =>
  records(harness).filter((record) => record.ref.type === type);

/** Test-only query port reading the in-memory canonical records. */
function createFakeQueries(harness: InMemoryHarness): PlanningQueryPort {
  const unused = (): Promise<never> => Promise.reject(new Error('Not used by scheduling tests.'));
  const find = (type: EntityType, recordId: UUID): CanonicalRecordState | null =>
    harness.unitOfWork.get(entityRefKey(createEntityRef(type, recordId, ownerId))) ?? null;
  const activePlacementFor = (targetId: UUID): CanonicalRecordState | undefined =>
    ofType(harness, 'planning_placement').find((record) => {
      const document = record.document as PlanningPlacementDocument;
      const target = document.target as Readonly<Record<string, unknown>>;
      return document.archivedAt === undefined && Object.values(target).includes(targetId);
    });
  const summary = (record: CanonicalRecordState): ActionSummary => {
    const document = record.document;
    const placement = activePlacementFor(record.ref.id);
    return {
      id: record.ref.id,
      title: document['title'] as string,
      state: document['state'] as ActionSummary['state'],
      localRevision: record.localRevision,
      orderKey: document['orderKey'] as string,
      ...(placement === undefined
        ? {}
        : {
            placement: {
              id: placement.ref.id,
              localRevision: placement.localRevision,
              period: (placement.document as PlanningPlacementDocument).period,
            },
          }),
    };
  };
  const plannedBlock = (key: 'actionId' | 'commitmentId', targetId: UUID) =>
    ofType(harness, 'time_block').find((record) => {
      const document = record.document as TimeBlockDocument;
      return (
        document.state === 'planned' &&
        document.supersededById === undefined &&
        (document.target as Readonly<Record<string, unknown>>)[key] === targetId
      );
    }) ?? null;
  return {
    getPlanProfile: () => Promise.resolve(profile),
    listBlocks: (_owner, startsAt, endsAt) =>
      Promise.resolve(
        ofType(harness, 'time_block')
          .filter((record) => {
            const document = record.document as TimeBlockDocument;
            return (
              document.state !== 'canceled' &&
              document.supersededById === undefined &&
              document.startsAt < endsAt &&
              startsAt < document.endsAt
            );
          })
          .map((record): BlockRow => {
            const document = record.document as TimeBlockDocument;
            return {
              id: record.ref.id,
              localRevision: record.localRevision,
              startsAt: document.startsAt,
              endsAt: document.endsAt,
              timeZone: document.timeZone,
              state: document.state as BlockRow['state'],
              overlapAcknowledged: document.overlapAcknowledged,
              target: { kind: 'custom', title: 'Item' },
            };
          }),
      ),
    listPlacements: (_owner, range) =>
      Promise.resolve(
        ofType(harness, 'planning_placement')
          .filter((record) => {
            const document = record.document as PlanningPlacementDocument;
            return (
              document.archivedAt === undefined &&
              rangesOverlap(periodRange(document.period), range)
            );
          })
          .map((record) => {
            const document = record.document as PlanningPlacementDocument;
            const target = document.target;
            let view: PlacedTargetView;
            if (target.kind === 'action') {
              const action = find('action', target.actionId);
              if (action === null) throw new Error('Missing Action fixture');
              view = { kind: 'action', action: summary(action) };
            } else {
              const targetId =
                target.kind === 'project'
                  ? target.projectId
                  : target.kind === 'milestone'
                    ? target.milestoneId
                    : target.outcomeId;
              view = {
                kind: target.kind,
                id: targetId,
                title: 'Item',
                state: 'active',
                localRevision: 1,
              } as PlacedTargetView;
            }
            return {
              id: record.ref.id,
              localRevision: record.localRevision,
              period: document.period,
              orderKey: document.orderKey,
              target: view,
            };
          }),
      ),
    listBacklog: unused,
    listCarryForward: unused,
    listWeekSelections: (_owner, range) =>
      Promise.resolve(
        ofType(harness, 'focus_selection')
          .filter((record) => {
            const document = record.document as FocusSelectionDocument;
            return (
              document.kind === 'week_commitment' &&
              document.archivedAt === undefined &&
              rangesOverlap({ start: document.periodStart, end: document.periodEnd }, range)
            );
          })
          .map((record): WeekSelectionRow => {
            const document = record.document as FocusSelectionDocument;
            const target = document.target as Readonly<Record<string, unknown>>;
            return {
              id: record.ref.id,
              localRevision: record.localRevision,
              period: {
                kind: 'week',
                start: document.periodStart,
                end: document.periodEnd,
                weekStart: document.weekStart ?? 'monday',
              },
              orderKey: document.orderKey,
              target: {
                kind: document.target.kind,
                id: (target['actionId'] ?? target['projectId'] ?? target['milestoneId']) as UUID,
                title: 'Item',
                state: 'planned',
              } as WeekSelectionRow['target'],
            };
          }),
      ),
    listRoutines: () =>
      Promise.resolve(
        ofType(harness, 'routine').map((record) => ({
          id: record.ref.id,
          localRevision: record.localRevision,
          document: record.document as RoutineDocument,
        })),
      ),
    getRoutine: unused,
    listMaterializedOccurrences: () =>
      Promise.resolve(
        ofType(harness, 'routine_occurrence').map((record): MaterializedOccurrenceSnapshot => {
          const document = record.document as RoutineOccurrenceDocument;
          return {
            id: record.ref.id,
            routineId: document.routineId,
            generation: document.generation,
            logicalKey: occurrenceLogicalKey(
              document.routineId,
              document.generation,
              document.period,
            ),
            period: document.period,
            state: document.state,
            localRevision: record.localRevision,
            ...(document.override === undefined ? {} : { override: document.override }),
          };
        }),
      ),
    listOccurrenceHistory: unused,
    listCapacityConstraints: () =>
      Promise.resolve(
        ofType(harness, 'constraint')
          .filter((record) => (record.document as ConstraintDocument).state === 'active')
          .map((record) => ({
            id: record.ref.id,
            localRevision: record.localRevision,
            document: record.document as ConstraintDocument,
          })),
      ),
    listMonthThemes: (_owner, year) =>
      Promise.resolve(
        ofType(harness, 'theme')
          .filter((record) => {
            const document = record.document;
            return (
              document['archivedAt'] === undefined &&
              (document['month'] as string).startsWith(`${year}-`)
            );
          })
          .map((record) => ({
            id: record.ref.id,
            localRevision: record.localRevision,
            month: record.document['month'] as never,
            text: record.document['text'] as string,
          })),
      ),
    getYearDirection: (_owner, year) => {
      const record = ofType(harness, 'direction').find((candidate) => {
        const document = candidate.document;
        return document['archivedAt'] === undefined && document['year'] === year;
      });
      return Promise.resolve(
        record === undefined
          ? null
          : {
              id: record.ref.id,
              localRevision: record.localRevision,
              year,
              text: record.document['text'] as string,
            },
      );
    },
    listOutcomes: unused,
    listMilestones: unused,
    listProjectTargets: unused,
    getMilestoneChain: unused,
    listTemplates: unused,
    getTemplate: unused,
    listAxes: unused,
    listProjects: unused,
    getAction: (_owner, actionId) => {
      const record = find('action', actionId);
      return Promise.resolve(record === null ? null : summary(record));
    },
    readRecord: (_owner, ref) => Promise.resolve(harness.unitOfWork.get(entityRefKey(ref)) ?? null),
    getActivePlacement: (_owner, _kind, targetId) =>
      Promise.resolve(activePlacementFor(targetId) ?? null),
    getPlannedActionBlock: (_owner, actionId) =>
      Promise.resolve(plannedBlock('actionId', actionId)),
    getPlannedCommitmentBlock: (_owner, commitmentId) =>
      Promise.resolve(plannedBlock('commitmentId', commitmentId)),
    getTargetReminder: (_owner, target) => {
      const key = target.kind === 'time_block' ? 'timeBlockId' : 'routineId';
      const reminders = ofType(harness, 'reminder').filter(
        (record) => record.document[key] === target.id,
      );
      return Promise.resolve(
        reminders.find((record) => record.document['state'] === 'scheduled') ??
          reminders.at(-1) ??
          null,
      );
    },
  };
}

function setup() {
  const harness = createInMemoryHarness(ownerId, now);
  const commands = createSchedulingCommands(harness.dependencies, createFakeQueries(harness));
  const seed = (type: EntityType, recordId: UUID, document: Doc, localRevision = 1): void =>
    harness.unitOfWork.seed({
      ref: createEntityRef(type, recordId, ownerId),
      localRevision,
      serverRevision: 0,
      baseSnapshotHash: null,
      document,
    });
  const read = (type: EntityType, recordId: UUID): CanonicalRecordState => {
    const record = harness.unitOfWork.get(entityRefKey(createEntityRef(type, recordId, ownerId)));
    if (record === undefined) throw new Error(`Missing ${type} ${recordId}`);
    return record;
  };
  const doc = <T = Doc>(type: EntityType, recordId: UUID): T => read(type, recordId).document as T;
  return { harness, commands, seed, read, doc };
}

function receiptOf(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function reasonOf(result: ApplicationResult<CommandReceipt>): unknown {
  if (result.ok) throw new Error('Expected a rejection');
  if (result.error.code !== 'domain_rejected') return result.error.code;
  return result.error.domainError.details?.['reason'] ?? result.error.domainError.code;
}

const action = (title: string, state = 'planned'): Doc => ({
  title,
  captureOrigin: 'plan',
  orderKey: '000000000000001',
  state,
});
const block = (target: Doc, startsAt: string, endsAt: string, extra: Doc = {}): Doc => ({
  target,
  startsAt,
  endsAt,
  timeZone: zone,
  state: 'planned',
  overlapAcknowledged: false,
  ...extra,
});
const dayPlacement = (targetId: UUID, date: string, orderKey = '500000000000000'): Doc => ({
  target: { kind: 'action', actionId: targetId },
  period: { kind: 'day', date },
  orderKey,
});

/** Berlin is UTC+2 in August: local 09:00 is 07:00Z. */
const at = (time: string): string => `2026-08-12T${time}:00.000Z`;

describe('createCustomBlock and overlap acknowledgement', () => {
  it('creates a planned custom block from local date, time, and duration', async () => {
    const { harness, commands } = setup();
    const receipt = receiptOf(
      await commands.createCustomBlock({
        title: '  Deep work  ',
        date: '2026-08-12',
        startTime: '09:00',
        durationMinutes: 90,
        overlapAcknowledged: false,
      }),
    );
    const [created] = ofType(harness, 'time_block');
    expect(created?.document).toEqual({
      target: { kind: 'custom', title: 'Deep work' },
      startsAt: at('07:00'),
      endsAt: at('08:30'),
      timeZone: zone,
      state: 'planned',
      overlapAcknowledged: false,
    });
    expect(receipt.canonical.map(({ ref }) => ref)).toEqual([created?.ref]);
    expect(receipt.undo.available).toBe(true);
    expect(harness.unitOfWork.state.events.map(({ event }) => event.payload)).toEqual([
      { operation: 'create' },
    ]);
  });

  it('rejects blank titles and out-of-range or fractional durations', async () => {
    const { harness, commands } = setup();
    const base = { date: '2026-08-12', startTime: '09:00', overlapAcknowledged: false };
    expect(
      reasonOf(await commands.createCustomBlock({ ...base, title: '  ', durationMinutes: 30 })),
    ).toBe('title');
    expect(
      reasonOf(
        await commands.createCustomBlock({ ...base, title: 'x'.repeat(201), durationMinutes: 30 }),
      ),
    ).toBe('title');
    for (const durationMinutes of [4, 1441, 30.5])
      expect(
        reasonOf(await commands.createCustomBlock({ ...base, title: 'Work', durationMinutes })),
      ).toBe('duration');
    expect(
      reasonOf(
        await commands.createCustomBlock({
          ...base,
          date: '2026-13-01',
          title: 'Work',
          durationMinutes: 30,
        }),
      ),
    ).toBe('invalid_time');
    expect(records(harness)).toHaveLength(0);
  });

  it('rejects an overlap without acknowledgement and writes nothing', async () => {
    const { harness, commands, seed } = setup();
    seed(
      'time_block',
      id(1),
      block({ kind: 'custom', title: 'Existing' }, at('07:00'), at('08:00')),
    );
    const before = new Map(harness.unitOfWork.state.records);
    const result = await commands.createCustomBlock({
      title: 'Conflicting',
      date: '2026-08-12',
      startTime: '09:30',
      durationMinutes: 60,
      overlapAcknowledged: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== 'domain_rejected') throw new Error('Expected rejection');
    expect(result.error.domainError.code).toBe('invalid_value');
    expect(result.error.domainError.details).toEqual({
      reason: 'overlap_requires_acknowledgement',
      overlaps: [`block:${id(1)}`],
    });
    expect(harness.unitOfWork.state.records).toEqual(before);
    expect(harness.unitOfWork.state.events).toHaveLength(0);
    expect(harness.unitOfWork.state.receipts.size).toBe(0);
  });

  it('treats touching intervals as free of conflict', async () => {
    const { commands, seed } = setup();
    seed(
      'time_block',
      id(1),
      block({ kind: 'custom', title: 'Existing' }, at('07:00'), at('08:00')),
    );
    receiptOf(
      await commands.createCustomBlock({
        title: 'Next',
        date: '2026-08-12',
        startTime: '10:00',
        durationMinutes: 30,
        overlapAcknowledged: false,
      }),
    );
  });

  it('marks the new block and every overlapped item when the overlap is kept', async () => {
    const { harness, commands, seed, doc } = setup();
    seed(
      'time_block',
      id(1),
      block({ kind: 'custom', title: 'Existing' }, at('07:00'), at('08:00')),
    );
    const receipt = receiptOf(
      await commands.createCustomBlock({
        title: 'Conflicting',
        date: '2026-08-12',
        startTime: '09:30',
        durationMinutes: 60,
        overlapAcknowledged: true,
      }),
    );
    expect(doc<TimeBlockDocument>('time_block', id(1)).overlapAcknowledged).toBe(true);
    const created = ofType(harness, 'time_block').find((record) => record.ref.id !== id(1));
    expect((created?.document as TimeBlockDocument).overlapAcknowledged).toBe(true);
    expect(receipt.canonical).toHaveLength(2);
    expect(harness.unitOfWork.state.events).toHaveLength(2);
  });

  it('returns the original receipt for an idempotent retry with the same command id', async () => {
    const { harness, commands } = setup();
    const commandId = '30000000-0000-4000-8000-000000000001' as UUID;
    const input = {
      title: 'Deep work',
      date: '2026-08-12',
      startTime: '09:00',
      durationMinutes: 60,
      overlapAcknowledged: false,
    };
    const first = receiptOf(await commands.createCustomBlock(input, commandId));
    const second = receiptOf(await commands.createCustomBlock(input, commandId));
    expect(second).toEqual(first);
    expect(ofType(harness, 'time_block')).toHaveLength(1);
    expect(harness.unitOfWork.state.events).toHaveLength(1);
  });
});

describe('scheduleAction', () => {
  it('creates a block and Day placement and moves an inbox Action to scheduled', async () => {
    const { harness, commands, seed, doc } = setup();
    seed('action', id(1), action('Write report', 'inbox'));
    const receipt = receiptOf(
      await commands.scheduleAction({
        actionId: id(1),
        revision: 1,
        date: '2026-08-12',
        startTime: '09:00',
        durationMinutes: 60,
        overlapAcknowledged: false,
      }),
    );
    expect(doc('action', id(1))['state']).toBe('scheduled');
    const [newBlock] = ofType(harness, 'time_block');
    expect(newBlock?.document).toMatchObject({
      target: { kind: 'action', actionId: id(1) },
      startsAt: at('07:00'),
      state: 'planned',
    });
    const [placement] = ofType(harness, 'planning_placement');
    expect(placement?.document).toEqual({
      target: { kind: 'action', actionId: id(1) },
      period: { kind: 'day', date: '2026-08-12' },
      orderKey: '500000000000000',
    });
    expect(receipt.canonical).toHaveLength(3);
    const text = JSON.stringify(harness.unitOfWork.state.events);
    expect(text).not.toContain('Write report');
    for (const { event } of harness.unitOfWork.state.events)
      expect(Object.keys(event.payload)).toEqual(['operation']);
  });

  it('reschedules by supersession, moving the placement, and undo restores exactly', async () => {
    const { harness, commands, seed, read, doc } = setup();
    seed('action', id(1), { ...action('Write report', 'scheduled') }, 3);
    seed(
      'time_block',
      id(2),
      block({ kind: 'action', actionId: id(1) }, at('07:00'), at('08:00')),
      2,
    );
    seed('planning_placement', id(3), dayPlacement(id(1), '2026-08-12'), 4);
    const before = new Map(harness.unitOfWork.state.records);
    const receipt = receiptOf(
      await commands.scheduleAction({
        actionId: id(1),
        revision: 3,
        date: '2026-08-13',
        startTime: '14:00',
        durationMinutes: 45,
        overlapAcknowledged: false,
      }),
    );
    const old = doc<TimeBlockDocument>('time_block', id(2));
    const replacement = ofType(harness, 'time_block').find((record) => record.ref.id !== id(2));
    if (replacement === undefined) throw new Error('Missing replacement');
    expect(old.state).toBe('canceled');
    expect(old.supersededById).toBe(replacement.ref.id);
    expect(replacement.document).toMatchObject({
      target: { kind: 'action', actionId: id(1) },
      startsAt: '2026-08-13T12:00:00.000Z',
      endsAt: '2026-08-13T12:45:00.000Z',
      state: 'planned',
    });
    expect(doc('planning_placement', id(3))['period']).toEqual({ kind: 'day', date: '2026-08-13' });
    expect(doc('action', id(1))['state']).toBe('scheduled');
    // The old block is canceled before the replacement is created (one-planned-block index).
    expect(receipt.canonical.map(({ ref }) => ref.id)).toEqual([id(2), replacement.ref.id, id(3)]);
    if (!receipt.undo.available) throw new Error('Expected undo');

    const undo = receiptOf(await commands.undo(receipt.undo.undoId));
    // Created records are inverted first so the restored block never collides with its replacement.
    expect(undo.canonical.map(({ ref }) => ref.id)).toEqual([replacement.ref.id, id(2), id(3)]);
    expect(undo.undo.available).toBe(false);
    expect(read('time_block', replacement.ref.id).document).toMatchObject({ state: 'canceled' });
    for (const key of before.keys())
      expect(harness.unitOfWork.state.records.get(key)?.document).toEqual(
        before.get(key)?.document,
      );
    const retry = await commands.undo(receipt.undo.undoId);
    expect(retry.ok ? 'ok' : retry.error.code).toBe('undo_unavailable');
  });

  it('rejects finished Actions and missing Actions', async () => {
    const { commands, seed } = setup();
    seed('action', id(1), action('Done', 'completed'));
    const input = {
      date: '2026-08-12',
      startTime: '09:00',
      durationMinutes: 30,
      overlapAcknowledged: false,
    };
    expect(
      reasonOf(await commands.scheduleAction({ ...input, actionId: id(1), revision: 1 })),
    ).toBe('action_not_schedulable');
    expect(
      reasonOf(await commands.scheduleAction({ ...input, actionId: id(9), revision: 1 })),
    ).toBe('entity_not_found');
  });

  it('requires acknowledgement when the schedule overlaps, excluding its own current block', async () => {
    const { commands, seed } = setup();
    seed('action', id(1), action('Write', 'scheduled'));
    seed('time_block', id(2), block({ kind: 'action', actionId: id(1) }, at('07:00'), at('08:00')));
    seed('time_block', id(3), block({ kind: 'custom', title: 'Call' }, at('09:00'), at('10:00')));
    const input = { actionId: id(1), revision: 1, date: '2026-08-12', durationMinutes: 60 };
    // Moving within its own old interval does not conflict with itself.
    receiptOf(
      await commands.scheduleAction({ ...input, startTime: '09:30', overlapAcknowledged: false }),
    );
    // The Action was already scheduled, so its own revision is unchanged by the reschedule.
    const result = await commands.scheduleAction({
      ...input,
      startTime: '11:30',
      overlapAcknowledged: false,
    });
    expect(reasonOf(result)).toBe('overlap_requires_acknowledgement');
  });
});

describe('moveBlock and shortenBlock', () => {
  it('moves an Action block and its Day placement', async () => {
    const { harness, commands, seed, doc } = setup();
    seed('action', id(1), action('Write', 'scheduled'));
    seed('time_block', id(2), block({ kind: 'action', actionId: id(1) }, at('07:00'), at('08:00')));
    seed('planning_placement', id(3), dayPlacement(id(1), '2026-08-12'));
    const receipt = receiptOf(
      await commands.moveBlock({
        blockId: id(2),
        revision: 1,
        date: '2026-08-14',
        startTime: '08:00',
        durationMinutes: 60,
        overlapAcknowledged: false,
      }),
    );
    expect(doc('planning_placement', id(3))['period']).toEqual({ kind: 'day', date: '2026-08-14' });
    expect(doc('action', id(1))['state']).toBe('scheduled');
    expect(receipt.canonical[0]?.ref.id).toBe(id(2));
    expect(receipt.canonical[1]?.ref.type).toBe('time_block');
    expect(
      ofType(harness, 'time_block').filter(
        (record) => (record.document as TimeBlockDocument).state === 'planned',
      ),
    ).toHaveLength(1);
  });

  it('moves a Commitment block and keeps the Commitment planned', async () => {
    const { harness, commands, seed, doc } = setup();
    seed('commitment', id(1), { title: 'Dentist', strength: 'hard', state: 'planned' });
    seed(
      'time_block',
      id(2),
      block({ kind: 'commitment', commitmentId: id(1) }, at('07:00'), at('08:00')),
    );
    const receipt = receiptOf(
      await commands.moveBlock({
        blockId: id(2),
        revision: 1,
        date: '2026-08-12',
        startTime: '15:00',
        durationMinutes: 60,
        overlapAcknowledged: false,
      }),
    );
    expect(doc('commitment', id(1))['state']).toBe('planned');
    expect(receipt.canonical).toHaveLength(2);
    const planned = ofType(harness, 'time_block').find(
      (record) => (record.document as TimeBlockDocument).state === 'planned',
    );
    expect(planned?.document).toMatchObject({
      target: { kind: 'commitment', commitmentId: id(1) },
    });
  });

  it('moves a custom block and refuses to move a superseded block', async () => {
    const { commands, seed, doc } = setup();
    seed('time_block', id(2), block({ kind: 'custom', title: 'Focus' }, at('07:00'), at('08:00')));
    const input = {
      date: '2026-08-12',
      startTime: '12:00',
      durationMinutes: 30,
      overlapAcknowledged: false,
    };
    receiptOf(await commands.moveBlock({ ...input, blockId: id(2), revision: 1 }));
    expect(doc<TimeBlockDocument>('time_block', id(2)).supersededById).toBeDefined();
    expect(reasonOf(await commands.moveBlock({ ...input, blockId: id(2), revision: 2 }))).toBe(
      'block_not_planned',
    );
  });

  it('shortens a block to a strictly shorter duration with the same start', async () => {
    const { harness, commands, seed, doc } = setup();
    seed('time_block', id(2), block({ kind: 'custom', title: 'Focus' }, at('07:00'), at('08:00')));
    expect(
      reasonOf(await commands.shortenBlock({ blockId: id(2), revision: 1, durationMinutes: 60 })),
    ).toBe('not_shorter');
    expect(
      reasonOf(await commands.shortenBlock({ blockId: id(2), revision: 1, durationMinutes: 4 })),
    ).toBe('duration');
    receiptOf(await commands.shortenBlock({ blockId: id(2), revision: 1, durationMinutes: 25 }));
    expect(doc<TimeBlockDocument>('time_block', id(2)).state).toBe('canceled');
    const replacement = ofType(harness, 'time_block').find((record) => record.ref.id !== id(2));
    expect(replacement?.document).toMatchObject({
      startsAt: at('07:00'),
      endsAt: at('07:25'),
      state: 'planned',
      target: { kind: 'custom', title: 'Focus' },
    });
  });
});

describe('setBlockState', () => {
  const scheduled = () => {
    const context = setup();
    context.seed('action', id(1), action('Write', 'scheduled'));
    context.seed(
      'time_block',
      id(2),
      block({ kind: 'action', actionId: id(1) }, at('07:00'), at('08:00')),
    );
    context.seed('planning_placement', id(3), dayPlacement(id(1), '2026-08-12'));
    return context;
  };

  it('completing the block returns a scheduled Action to planned and keeps its placement', async () => {
    const { commands, doc } = scheduled();
    receiptOf(await commands.setBlockState({ blockId: id(2), revision: 1, to: 'completed' }));
    expect(doc('time_block', id(2))['state']).toBe('completed');
    expect(doc('action', id(1))['state']).toBe('planned');
    expect(doc('planning_placement', id(3))['archivedAt']).toBeUndefined();
  });

  it('completes the Action only when explicitly asked', async () => {
    const { commands, doc } = scheduled();
    receiptOf(
      await commands.setBlockState({
        blockId: id(2),
        revision: 1,
        to: 'completed',
        alsoCompleteAction: true,
      }),
    );
    expect(doc('action', id(1))).toMatchObject({ state: 'completed', completedAt: now });
    const other = scheduled();
    expect(
      reasonOf(
        await other.commands.setBlockState({
          blockId: id(2),
          revision: 1,
          to: 'skipped',
          alsoCompleteAction: true,
        }),
      ),
    ).toBe('also_complete_requires_completed_action_block');
  });

  it('reopens a resolved block with explicit intent and schedules its planned Action again', async () => {
    const { commands, doc } = scheduled();
    receiptOf(await commands.setBlockState({ blockId: id(2), revision: 1, to: 'skipped' }));
    expect(doc('action', id(1))['state']).toBe('planned');
    receiptOf(await commands.setBlockState({ blockId: id(2), revision: 2, to: 'planned' }));
    expect(doc('time_block', id(2))['state']).toBe('planned');
    expect(doc('action', id(1))['state']).toBe('scheduled');
  });

  it('reopening moves a Day placement that changed while the Action was planned back to the block date', async () => {
    const { harness, commands, doc } = scheduled();
    receiptOf(await commands.setBlockState({ blockId: id(2), revision: 1, to: 'skipped' }));
    receiptOf(
      await commands.place({
        target: { kind: 'action', id: id(1), revision: 2 },
        period: { kind: 'day', date: '2026-08-14' },
      }),
    );
    expect(doc('planning_placement', id(3))['period']).toEqual({ kind: 'day', date: '2026-08-14' });
    const receipt = receiptOf(
      await commands.setBlockState({ blockId: id(2), revision: 2, to: 'planned' }),
    );
    expect(doc('action', id(1))['state']).toBe('scheduled');
    expect(ofType(harness, 'planning_placement')).toHaveLength(1);
    expect(doc('planning_placement', id(3))['period']).toEqual({ kind: 'day', date: '2026-08-12' });
    expect(receipt.canonical.map(({ ref }) => ref.id)).toContain(id(3));
  });

  it('reopening restores a Day placement removed while the Action was planned', async () => {
    const { harness, commands, doc } = scheduled();
    receiptOf(await commands.setBlockState({ blockId: id(2), revision: 1, to: 'skipped' }));
    receiptOf(await commands.unplace({ target: { kind: 'action', id: id(1), revision: 2 } }));
    receiptOf(await commands.setBlockState({ blockId: id(2), revision: 2, to: 'planned' }));
    expect(doc('action', id(1))['state']).toBe('scheduled');
    const active = ofType(harness, 'planning_placement').filter(
      (record) => (record.document as PlanningPlacementDocument).archivedAt === undefined,
    );
    expect(active.map((record) => record.document)).toEqual([dayPlacement(id(1), '2026-08-12')]);
  });

  it('rejects invalid transitions, superseded reopen, and missing blocks', async () => {
    const { commands, seed } = scheduled();
    receiptOf(await commands.setBlockState({ blockId: id(2), revision: 1, to: 'completed' }));
    expect(
      reasonOf(await commands.setBlockState({ blockId: id(2), revision: 2, to: 'skipped' })),
    ).toBe('invalid_transition');
    seed(
      'time_block',
      id(4),
      block({ kind: 'custom', title: 'Old' }, at('07:00'), at('08:00'), {
        state: 'canceled',
        supersededById: id(5),
      }),
    );
    expect(
      reasonOf(await commands.setBlockState({ blockId: id(4), revision: 1, to: 'planned' })),
    ).toBe('invalid_transition');
    expect(
      reasonOf(await commands.setBlockState({ blockId: id(9), revision: 1, to: 'completed' })),
    ).toBe('entity_not_found');
  });

  it('refuses to reopen when the Action already has another planned block', async () => {
    const { commands, seed } = scheduled();
    seed(
      'time_block',
      id(4),
      block({ kind: 'action', actionId: id(1) }, at('05:00'), at('06:00'), { state: 'skipped' }),
    );
    expect(
      reasonOf(await commands.setBlockState({ blockId: id(4), revision: 1, to: 'planned' })),
    ).toBe('another_block_planned');
  });
});

describe('Commitments', () => {
  it('creates a Commitment with one planned block, cancels and reopens it', async () => {
    const { harness, commands, doc } = setup();
    receiptOf(
      await commands.createCommitment({
        title: 'Dentist',
        strength: 'hard',
        date: '2026-08-12',
        startTime: '11:00',
        durationMinutes: 45,
        overlapAcknowledged: false,
      }),
    );
    const [commitment] = ofType(harness, 'commitment');
    const [commitmentBlock] = ofType(harness, 'time_block');
    if (commitment === undefined || commitmentBlock === undefined) throw new Error('Missing rows');
    expect(commitment.document).toEqual({ title: 'Dentist', strength: 'hard', state: 'planned' });
    expect(commitmentBlock.document).toMatchObject({
      target: { kind: 'commitment', commitmentId: commitment.ref.id },
      startsAt: at('09:00'),
      endsAt: at('09:45'),
    });
    expect(
      reasonOf(
        await commands.setBlockState({
          blockId: commitmentBlock.ref.id,
          revision: 1,
          to: 'skipped',
        }),
      ),
    ).toBe('commitment_block_skip');
    receiptOf(
      await commands.setBlockState({
        blockId: commitmentBlock.ref.id,
        revision: 1,
        to: 'canceled',
      }),
    );
    expect(doc('commitment', commitment.ref.id)['state']).toBe('canceled');
    receiptOf(
      await commands.setBlockState({ blockId: commitmentBlock.ref.id, revision: 2, to: 'planned' }),
    );
    expect(doc('commitment', commitment.ref.id)['state']).toBe('planned');
    receiptOf(
      await commands.setBlockState({
        blockId: commitmentBlock.ref.id,
        revision: 3,
        to: 'completed',
      }),
    );
    expect(doc('commitment', commitment.ref.id)['state']).toBe('completed');
  });

  it('validates title and strength', async () => {
    const { commands } = setup();
    const base = {
      date: '2026-08-12',
      startTime: '11:00',
      durationMinutes: 45,
      overlapAcknowledged: false,
    };
    expect(
      reasonOf(await commands.createCommitment({ ...base, title: '', strength: 'hard' })),
    ).toBe('title');
    expect(
      reasonOf(await commands.createCommitment({ ...base, title: 'X', strength: 'firm' as never })),
    ).toBe('strength');
  });
});

describe('keepOverlap', () => {
  const routineId = id(50);
  const occurrenceTarget = {
    routineId,
    generation: 1,
    period: { kind: 'date' as const, date: '2026-08-12' as never },
  };
  const withRoutine = () => {
    const context = setup();
    context.seed('routine', routineId, {
      title: 'Morning run',
      orderKey: '000000000000001',
      state: 'active',
      generations: [
        {
          generation: 1,
          rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-08-01' },
          schedulingMode: {
            kind: 'time_specific',
            wallTime: '09:00',
            durationMinutes: 60,
            zonePolicy: { kind: 'follow_profile' },
            gapPolicy: 'shift_forward',
            overlapPolicy: 'earlier_offset',
          },
        },
      ],
    });
    context.seed(
      'time_block',
      id(2),
      block({ kind: 'custom', title: 'Call' }, at('07:30'), at('08:30')),
    );
    return context;
  };
  const occurrenceId = routineOccurrenceId(
    occurrenceLogicalKey(routineId, 1, { kind: 'date', date: '2026-08-12' as never }),
  );

  it('acknowledges a block and materializes the occurrence with a deterministic id', async () => {
    const { commands, doc } = withRoutine();
    const receipt = receiptOf(
      await commands.keepOverlap({
        first: { kind: 'block', blockId: id(2), revision: 1 },
        second: { kind: 'occurrence', occurrence: occurrenceTarget },
      }),
    );
    expect(doc<TimeBlockDocument>('time_block', id(2)).overlapAcknowledged).toBe(true);
    expect(doc<RoutineOccurrenceDocument>('routine_occurrence', occurrenceId)).toEqual({
      routineId,
      generation: 1,
      periodKey: '2026-08-12',
      period: { kind: 'date', date: '2026-08-12' },
      state: 'planned',
      override: { overlapAcknowledged: true },
    });
    expect(receipt.canonical.map(({ ref }) => ref.id)).toEqual([id(2), occurrenceId]);
    expect(
      reasonOf(
        await commands.keepOverlap({
          first: { kind: 'block', blockId: id(2), revision: 2 },
          second: { kind: 'occurrence', occurrence: { ...occurrenceTarget, revision: 1 } },
        }),
      ),
    ).toBe('already_kept');
  });

  it('includes timed occurrences when creating overlapping work', async () => {
    const { commands } = withRoutine();
    const result = await commands.createCustomBlock({
      title: 'Standup',
      date: '2026-08-12',
      startTime: '08:30',
      durationMinutes: 45,
      overlapAcknowledged: false,
    });
    if (result.ok || result.error.code !== 'domain_rejected') throw new Error('Expected rejection');
    expect(result.error.domainError.details?.['overlaps']).toEqual([`occurrence:${occurrenceId}`]);
  });

  it('keeps an overlap with a fixed-zone occurrence whose instant falls on another planning date', async () => {
    const context = setup();
    const fixedRoutine = id(51);
    context.seed('routine', fixedRoutine, {
      title: 'Island call',
      orderKey: '000000000000002',
      state: 'active',
      generations: [
        {
          generation: 1,
          rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-08-01' },
          schedulingMode: {
            kind: 'time_specific',
            wallTime: '08:00',
            durationMinutes: 30,
            zonePolicy: { kind: 'fixed_zone', timeZone: 'Pacific/Kiritimati' },
            gapPolicy: 'shift_forward',
            overlapPolicy: 'earlier_offset',
          },
        },
      ],
    });
    // 08:00 on 2026-08-12 in Kiritimati (UTC+14) is 18:00Z on 08-11: 20:00 on 08-11 in Berlin.
    context.seed(
      'time_block',
      id(3),
      block(
        { kind: 'custom', title: 'Evening' },
        '2026-08-11T18:00:00.000Z',
        '2026-08-11T19:00:00.000Z',
      ),
    );
    const period = { kind: 'date' as const, date: '2026-08-12' as never };
    const fixedOccurrence = routineOccurrenceId(occurrenceLogicalKey(fixedRoutine, 1, period));
    receiptOf(
      await context.commands.keepOverlap({
        first: { kind: 'block', blockId: id(3), revision: 1 },
        second: {
          kind: 'occurrence',
          occurrence: { routineId: fixedRoutine, generation: 1, period },
        },
      }),
    );
    expect(context.doc<TimeBlockDocument>('time_block', id(3)).overlapAcknowledged).toBe(true);
    expect(
      context.doc<RoutineOccurrenceDocument>('routine_occurrence', fixedOccurrence).override,
    ).toEqual({ overlapAcknowledged: true });
  });

  it('rejects items that do not overlap', async () => {
    const { commands, seed } = withRoutine();
    seed('time_block', id(3), block({ kind: 'custom', title: 'Late' }, at('15:00'), at('16:00')));
    expect(
      reasonOf(
        await commands.keepOverlap({
          first: { kind: 'block', blockId: id(2), revision: 1 },
          second: { kind: 'block', blockId: id(3), revision: 1 },
        }),
      ),
    ).toBe('no_overlap');
  });
});

describe('placements', () => {
  it('places an inbox Action, making it planned, and moves an existing placement in place', async () => {
    const { harness, commands, seed, doc } = setup();
    seed('action', id(1), action('Plan trip', 'inbox'));
    receiptOf(
      await commands.place({
        target: { kind: 'action', id: id(1), revision: 1 },
        period: { kind: 'week', date: '2026-08-12' },
      }),
    );
    expect(doc('action', id(1))['state']).toBe('planned');
    const [placement] = ofType(harness, 'planning_placement');
    expect(placement?.document).toMatchObject({
      period: { kind: 'week', start: '2026-08-10', end: '2026-08-16', weekStart: 'monday' },
      orderKey: '500000000000000',
    });
    receiptOf(
      await commands.place({
        target: { kind: 'action', id: id(1), revision: 2 },
        period: { kind: 'day', date: '2026-08-13' },
      }),
    );
    expect(ofType(harness, 'planning_placement')).toHaveLength(1);
    expect(doc('planning_placement', placement?.ref.id as UUID)['period']).toEqual({
      kind: 'day',
      date: '2026-08-13',
    });
  });

  it('enforces horizon rules, archived targets, and scheduled Actions', async () => {
    const { commands, seed } = setup();
    seed('outcome', id(1), {
      title: 'Health',
      successDefinition: 'x',
      progress: { mode: 'none' },
      orderKey: '1',
      state: 'active',
    });
    seed('project', id(2), {
      title: 'Old',
      orderKey: '1',
      state: 'archived',
      stateBeforeArchive: 'idea',
      archivedAt: now,
    });
    seed('action', id(3), action('Write', 'scheduled'));
    expect(
      reasonOf(
        await commands.place({
          target: { kind: 'outcome', id: id(1), revision: 1 },
          period: { kind: 'day', date: '2026-08-12' },
        }),
      ),
    ).toBe('placement_not_allowed');
    receiptOf(
      await commands.place({
        target: { kind: 'outcome', id: id(1), revision: 1 },
        period: { kind: 'month', date: '2026-08-12' },
      }),
    );
    expect(
      reasonOf(
        await commands.place({
          target: { kind: 'project', id: id(2), revision: 1 },
          period: { kind: 'week', date: '2026-08-12' },
        }),
      ),
    ).toBe('archived_target');
    expect(
      reasonOf(
        await commands.place({
          target: { kind: 'action', id: id(3), revision: 1 },
          period: { kind: 'day', date: '2026-08-12' },
        }),
      ),
    ).toBe('scheduled_action_use_move');
    expect(
      reasonOf(
        await commands.place({
          target: { kind: 'action', id: id(9), revision: 1 },
          period: { kind: 'day', date: '2026-08-12' },
        }),
      ),
    ).toBe('entity_not_found');
  });

  it('unplaces an unscheduled Action into Backlog and refuses scheduled Actions', async () => {
    const { commands, seed, doc } = setup();
    seed('action', id(1), action('Write', 'planned'));
    seed('planning_placement', id(2), dayPlacement(id(1), '2026-08-12'));
    seed('action', id(3), action('Call', 'scheduled'));
    seed('planning_placement', id(4), dayPlacement(id(3), '2026-08-12'));
    receiptOf(await commands.unplace({ target: { kind: 'action', id: id(1), revision: 1 } }));
    expect(doc('planning_placement', id(2))['archivedAt']).toBe(now);
    expect(doc('action', id(1))['state']).toBe('planned');
    expect(
      reasonOf(await commands.unplace({ target: { kind: 'action', id: id(3), revision: 1 } })),
    ).toBe('unschedule_first');
    expect(
      reasonOf(await commands.unplace({ target: { kind: 'action', id: id(1), revision: 1 } })),
    ).toBe('not_placed');
  });

  it('carries unfinished Actions forward atomically', async () => {
    const { harness, commands, seed, doc } = setup();
    seed('action', id(1), action('One', 'planned'));
    seed('planning_placement', id(2), dayPlacement(id(1), '2026-08-03'));
    seed('action', id(3), action('Two', 'in_progress'));
    seed('action', id(4), action('Three', 'scheduled'));
    const before = new Map(harness.unitOfWork.state.records);
    expect(
      reasonOf(
        await commands.carryForward({
          actions: [
            { id: id(1), revision: 1 },
            { id: id(4), revision: 1 },
          ],
          period: { kind: 'day', date: '2026-08-12' },
        }),
      ),
    ).toBe('scheduled_action_use_move');
    expect(harness.unitOfWork.state.records).toEqual(before);
    expect(
      reasonOf(
        await commands.carryForward({
          actions: [{ id: id(1), revision: 1 }],
          period: { kind: 'month', date: '2026-08-12' },
        }),
      ),
    ).toBe('carry_forward_period');
    const receipt = receiptOf(
      await commands.carryForward({
        actions: [
          { id: id(1), revision: 1 },
          { id: id(3), revision: 1 },
        ],
        period: { kind: 'day', date: '2026-08-12' },
      }),
    );
    expect(receipt.canonical).toHaveLength(2);
    expect(doc('planning_placement', id(2))['period']).toEqual({ kind: 'day', date: '2026-08-12' });
    expect(ofType(harness, 'planning_placement')).toHaveLength(2);
  });

  it('reorders within one period and target kind, rewriting equal keys first', async () => {
    const { commands, seed, doc } = setup();
    for (const [index, value] of [11, 12, 13].entries()) {
      seed('action', id(value), action(`A${index}`));
      seed(
        'planning_placement',
        id(value + 10),
        dayPlacement(id(value), '2026-08-12', '500000000000000'),
      );
    }
    receiptOf(
      await commands.reorderPlacement({
        placementId: id(22),
        revision: 1,
        direction: 'up',
        scope: { kind: 'day', date: '2026-08-12' },
      }),
    );
    expect([21, 22, 23].map((value) => doc('planning_placement', id(value))['orderKey'])).toEqual([
      '000002000000000',
      '000001000000000',
      '000003000000000',
    ]);
    const receipt = receiptOf(
      await commands.reorderPlacement({
        placementId: id(21),
        revision: 2,
        direction: 'down',
        scope: { kind: 'day', date: '2026-08-12' },
      }),
    );
    expect(receipt.canonical.map(({ ref }) => ref.id)).toEqual([id(21), id(23)]);
    expect(
      reasonOf(
        await commands.reorderPlacement({
          placementId: id(22),
          revision: 2,
          direction: 'up',
          scope: { kind: 'day', date: '2026-08-12' },
        }),
      ),
    ).toBe('order_edge');
  });
});

describe('Week commitments', () => {
  it('adds, refuses duplicates, and removes a Week commitment', async () => {
    const { harness, commands, seed, doc } = setup();
    seed('project', id(1), {
      title: 'Launch',
      desiredResult: 'Live',
      orderKey: '1',
      state: 'active',
    });
    receiptOf(
      await commands.addWeekCommitment({
        weekDate: '2026-08-13',
        target: { kind: 'project', id: id(1) },
      }),
    );
    const [selection] = ofType(harness, 'focus_selection');
    if (selection === undefined) throw new Error('Missing selection');
    expect(selection.document).toEqual({
      kind: 'week_commitment',
      profileId,
      target: { kind: 'project', projectId: id(1) },
      periodStart: '2026-08-10',
      periodEnd: '2026-08-16',
      weekStart: 'monday',
      orderKey: '000000000000001',
    });
    expect(
      reasonOf(
        await commands.addWeekCommitment({
          weekDate: '2026-08-10',
          target: { kind: 'project', id: id(1) },
        }),
      ),
    ).toBe('already_selected');
    receiptOf(await commands.removeWeekCommitment({ selectionId: selection.ref.id, revision: 1 }));
    expect(doc<FocusSelectionDocument>('focus_selection', selection.ref.id).archivedAt).toBe(now);
    expect(doc('project', id(1))['state']).toBe('active');
  });
});

describe('capacity constraints', () => {
  it('adds, edits, and archives availability windows', async () => {
    const { harness, commands, doc } = setup();
    receiptOf(
      await commands.addAvailability({
        strength: 'soft',
        windows: [{ weekday: 'monday', start: '09:00', end: '12:00' }],
      }),
    );
    const [constraint] = ofType(harness, 'constraint');
    if (constraint === undefined) throw new Error('Missing constraint');
    expect(constraint.document).toEqual({
      constraintKind: 'availability',
      strength: 'soft',
      value: {
        kind: 'availability',
        windows: [{ weekday: 'monday', start: '09:00', end: '12:00' }],
      },
      state: 'active',
    });
    receiptOf(
      await commands.editAvailability({
        constraintId: constraint.ref.id,
        revision: 1,
        strength: 'hard',
        windows: [{ weekday: 'tuesday', start: '13:00', end: '17:30' }],
      }),
    );
    expect(doc('constraint', constraint.ref.id)).toMatchObject({ strength: 'hard' });
    receiptOf(await commands.archiveConstraint({ constraintId: constraint.ref.id, revision: 2 }));
    expect(doc('constraint', constraint.ref.id)).toMatchObject({
      state: 'archived',
      stateBeforeArchive: 'active',
      archivedAt: now,
    });
  });

  it('validates availability windows', async () => {
    const { harness, commands } = setup();
    const window = { weekday: 'monday' as const, start: '09:00', end: '10:00' };
    expect(reasonOf(await commands.addAvailability({ strength: 'soft', windows: [] }))).toBe(
      'availability_windows',
    );
    expect(
      reasonOf(
        await commands.addAvailability({
          strength: 'soft',
          windows: Array.from({ length: 29 }, () => window),
        }),
      ),
    ).toBe('availability_windows');
    expect(
      reasonOf(
        await commands.addAvailability({
          strength: 'soft',
          windows: [{ ...window, start: '10:00' }],
        }),
      ),
    ).toBe('availability_order');
    expect(
      reasonOf(
        await commands.addAvailability({
          strength: 'soft',
          windows: [{ ...window, start: '00:00', end: '00:00' }],
        }),
      ),
    ).toBe('availability_order');
    expect(
      reasonOf(
        await commands.addAvailability({
          strength: 'soft',
          windows: [{ ...window, weekday: 'funday' as never }],
        }),
      ),
    ).toBe('availability_weekday');
    expect(
      reasonOf(
        await commands.addAvailability({
          strength: 'soft',
          windows: [{ ...window, end: '25:00' }],
        }),
      ),
    ).toBe('availability_time');
    expect(
      reasonOf(await commands.addAvailability({ strength: 'maybe' as never, windows: [window] })),
    ).toBe('strength');
    expect(records(harness)).toHaveLength(0);
    // A wall time cannot say 24:00, so an end of 00:00 after a later start is the end of the day.
    receiptOf(
      await commands.addAvailability({
        strength: 'soft',
        windows: [{ ...window, start: '18:00', end: '00:00' }],
      }),
    );
    expect(ofType(harness, 'constraint')).toHaveLength(1);
  });

  it('sets, replaces, and clears day and week caps', async () => {
    const { harness, commands, doc } = setup();
    receiptOf(await commands.setCapacityCap({ period: 'day', minutes: 360 }));
    const [cap] = ofType(harness, 'constraint');
    if (cap === undefined) throw new Error('Missing cap');
    expect(cap.document).toEqual({
      constraintKind: 'capacity',
      strength: 'soft',
      value: { kind: 'capacity', period: 'day', minutes: 360 },
      state: 'active',
    });
    receiptOf(await commands.setCapacityCap({ period: 'day', minutes: 300 }));
    expect(ofType(harness, 'constraint')).toHaveLength(1);
    expect(doc('constraint', cap.ref.id)['value']).toEqual({
      kind: 'capacity',
      period: 'day',
      minutes: 300,
    });
    receiptOf(await commands.setCapacityCap({ period: 'week', minutes: 10080 }));
    expect(reasonOf(await commands.setCapacityCap({ period: 'day', minutes: 1441 }))).toBe(
      'cap_minutes',
    );
    expect(reasonOf(await commands.setCapacityCap({ period: 'week', minutes: 12.5 }))).toBe(
      'cap_minutes',
    );
    receiptOf(await commands.setCapacityCap({ period: 'day', minutes: null }));
    expect(doc('constraint', cap.ref.id)['state']).toBe('archived');
    expect(reasonOf(await commands.setCapacityCap({ period: 'day', minutes: null }))).toBe(
      'nothing_to_clear',
    );
  });
});

describe('Month themes and Year direction', () => {
  it('sets, replaces, clears, and undoes a Month theme', async () => {
    const { harness, commands, doc } = setup();
    receiptOf(await commands.setMonthTheme({ month: '2026-08', text: '  Rest and repair  ' }));
    const [theme] = ofType(harness, 'theme');
    if (theme === undefined) throw new Error('Missing theme');
    expect(theme.document).toEqual({ profileId, month: '2026-08', text: 'Rest and repair' });
    const replaced = receiptOf(await commands.setMonthTheme({ month: '2026-08', text: 'Build' }));
    expect(ofType(harness, 'theme')).toHaveLength(1);
    expect(doc('theme', theme.ref.id)['text']).toBe('Build');
    if (!replaced.undo.available) throw new Error('Expected undo');
    receiptOf(await commands.undo(replaced.undo.undoId));
    expect(doc('theme', theme.ref.id)['text']).toBe('Rest and repair');
    receiptOf(await commands.clearMonthTheme({ month: '2026-08' }));
    expect(doc('theme', theme.ref.id)['archivedAt']).toBe(now);
    expect(reasonOf(await commands.clearMonthTheme({ month: '2026-08' }))).toBe('nothing_to_clear');
    expect(reasonOf(await commands.setMonthTheme({ month: '2026-13', text: 'x' }))).toBe(
      'invalid_time',
    );
    expect(
      reasonOf(await commands.setMonthTheme({ month: '2026-09', text: 'x'.repeat(2001) })),
    ).toBe('theme_text');
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Rest and repair');
  });

  it('sets, replaces, and clears a Year direction', async () => {
    const { harness, commands, doc } = setup();
    const created = receiptOf(
      await commands.setYearDirection({ year: '2026', text: 'Steady growth' }),
    );
    const [direction] = ofType(harness, 'direction');
    if (direction === undefined) throw new Error('Missing direction');
    expect(direction.document).toEqual({ profileId, year: '2026', text: 'Steady growth' });
    receiptOf(await commands.setYearDirection({ year: '2026', text: 'Depth' }));
    expect(ofType(harness, 'direction')).toHaveLength(1);
    receiptOf(await commands.clearYearDirection({ year: '2026' }));
    expect(doc('direction', direction.ref.id)['archivedAt']).toBe(now);
    expect(reasonOf(await commands.clearYearDirection({ year: '2026' }))).toBe('nothing_to_clear');
    expect(created.canonical).toHaveLength(1);
  });
});

describe('undo', () => {
  it('archives created records when undoing a creation', async () => {
    const { harness, commands } = setup();
    const receipt = receiptOf(
      await commands.createCommitment({
        title: 'Dentist',
        strength: 'soft',
        date: '2026-08-12',
        startTime: '11:00',
        durationMinutes: 30,
        overlapAcknowledged: false,
      }),
    );
    if (!receipt.undo.available) throw new Error('Expected undo');
    receiptOf(await commands.undo(receipt.undo.undoId));
    expect(ofType(harness, 'commitment')[0]?.document).toMatchObject({ state: 'canceled' });
    expect(ofType(harness, 'time_block')[0]?.document).toMatchObject({ state: 'canceled' });
  });

  it('refuses unknown undo ids', async () => {
    const { commands } = setup();
    const result = await commands.undo(id(99));
    expect(result.ok ? 'ok' : result.error.code).toBe('undo_unavailable');
  });
});
