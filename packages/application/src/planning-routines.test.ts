import {
  createEntityRef,
  deriveNameBasedUuid,
  entityRefKey,
  occurrenceLogicalKey,
  routineOccurrenceId,
  yelaxisDerivedIdNamespace,
  type CalendarDate,
  type EntityRef,
  type EntityType,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import { executeCommand } from './execute-command';
import type {
  OccurrenceTargetInput,
  PlanProfile,
  RoutineActionDefaultsDocument,
  RoutineDocument,
  RoutineOccurrenceDocument,
  TimeBlockDocument,
} from './planning-contracts';
import { planPlanningUndo } from './planning-kit';
import { createPlanningProjections } from './planning-projections';
import { createRoutineCommands } from './planning-routines';
import { createTestPlanningQueries } from './planning-routines-test-queries';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
// Monday 2026-09-28, 09:00 in New York.
const now = '2026-09-28T13:00:00.000Z' as Instant;
const zone = 'America/New_York' as IanaTimeZone;
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: zone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};

const axisId = '20000000-0000-4000-8000-000000000001' as UUID;
const archivedAxisId = '20000000-0000-4000-8000-000000000002' as UUID;
const projectId = '30000000-0000-4000-8000-000000000001' as UUID;
const archivedProjectId = '30000000-0000-4000-8000-000000000002' as UUID;
const actionId = '40000000-0000-4000-8000-000000000001' as UUID;
const blockId = '50000000-0000-4000-8000-000000000001' as UUID;

const daily = (startsOn: string) => ({ version: 1, kind: 'daily', intervalDays: 1, startsOn });
const weeklyCount = (startsOn: string, targetCount = 2) => ({
  version: 1,
  kind: 'weekly_count',
  targetCount,
  weekStart: 'monday',
  startsOn,
});
const flexible = { kind: 'day_flexible' };
const morning = {
  kind: 'time_specific',
  wallTime: '07:00',
  durationMinutes: 30,
  zonePolicy: { kind: 'follow_profile' },
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
};

let harness: InMemoryHarness;
let commands: ReturnType<typeof createRoutineCommands>;

function seed(type: EntityType, id: UUID, document: Readonly<Record<string, unknown>>): void {
  harness.unitOfWork.seed({
    ref: createEntityRef(type, id, ownerId),
    localRevision: 1,
    serverRevision: 0,
    baseSnapshotHash: null,
    document,
  });
}

function record(type: EntityType, id: string): CanonicalRecordState | undefined {
  return harness.unitOfWork.get(entityRefKey(createEntityRef(type, id as UUID, ownerId)));
}

function recordsOf(type: EntityType): CanonicalRecordState[] {
  return [...harness.unitOfWork.state.records.values()].filter((item) => item.ref.type === type);
}

function accepted(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function rejectionReason(result: ApplicationResult<CommandReceipt>): unknown {
  if (result.ok) throw new Error('Expected a rejection.');
  if (result.error.code !== 'domain_rejected') return result.error.code;
  return result.error.domainError.details?.['reason'] ?? result.error.domainError.code;
}

function createdRoutineId(receipt: CommandReceipt): UUID {
  const ref = receipt.canonical.find((item) => item.ref.type === 'routine')?.ref;
  if (ref === undefined) throw new Error('No Routine created.');
  return ref.id;
}

function occurrenceRef(
  routineId: UUID,
  generation: number,
  period: OccurrenceTargetInput['period'],
): EntityRef<'routine_occurrence'> {
  return createEntityRef(
    'routine_occurrence',
    routineOccurrenceId(occurrenceLogicalKey(routineId, generation, period)),
    ownerId,
  );
}

const dated = (date: string): OccurrenceTargetInput['period'] => ({
  kind: 'date',
  date: date as CalendarDate,
});

const week = (start: string, end: string, targetCount = 2): OccurrenceTargetInput['period'] => ({
  kind: 'week',
  start: start as CalendarDate,
  end: end as CalendarDate,
  weekStart: 'monday',
  targetCount,
});

function expectMinimizedEvents(): void {
  for (const { event } of harness.unitOfWork.state.events) {
    expect(Object.keys(event.payload)).toEqual(['operation']);
  }
}

async function undo(receipt: CommandReceipt): Promise<ApplicationResult<CommandReceipt>> {
  if (!receipt.undo.available) throw new Error('Undo unavailable.');
  return executeCommand(
    harness.dependencies,
    {
      commandId: harness.dependencies.ids.next(),
      ownerId,
      actor: 'user',
      expectedRevisions: [],
      input: undefined,
      consumesUndoId: receipt.undo.undoId,
    },
    ({ records, context, undoDescriptor }) =>
      planPlanningUndo(undoDescriptor?.descriptor.payload, records, context),
  );
}

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  commands = createRoutineCommands(
    harness.dependencies,
    createTestPlanningQueries(harness.unitOfWork, profile),
  );
  seed('axis', axisId, { title: 'Health', orderKey: '500000000000000', state: 'active' });
  seed('axis', archivedAxisId, {
    title: 'Old',
    orderKey: '500000000000001',
    state: 'archived',
    stateBeforeArchive: 'active',
    archivedAt: now,
  });
  seed('project', projectId, {
    title: 'Fitness',
    desiredResult: 'Run a 10k',
    orderKey: '500000000000000',
    state: 'active',
  });
  seed('project', archivedProjectId, {
    title: 'Past',
    desiredResult: 'Done',
    orderKey: '500000000000001',
    state: 'archived',
    stateBeforeArchive: 'active',
    archivedAt: now,
  });
});

describe('createRoutine', () => {
  it('creates an active Routine with generation 1 and no defaults row', async () => {
    const receipt = accepted(
      await commands.createRoutine({
        title: '  Stretch  ',
        rule: daily('2026-10-01'),
        schedulingMode: flexible,
      }),
    );
    const routine = record('routine', createdRoutineId(receipt));
    const document = routine?.document as RoutineDocument;
    expect(document).toEqual({
      title: 'Stretch',
      orderKey: '500000000000000',
      state: 'active',
      generations: [
        {
          generation: 1,
          rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-10-01' },
          schedulingMode: { kind: 'day_flexible' },
        },
      ],
    });
    expect(recordsOf('routine_action_defaults')).toHaveLength(0);
    expect(receipt.undo.available).toBe(true);
    expectMinimizedEvents();
  });

  it('stores defaults with the derived per-generation id', async () => {
    const receipt = accepted(
      await commands.createRoutine({
        title: 'Run',
        axisId,
        rule: daily('2026-10-01'),
        schedulingMode: morning,
        defaults: {
          projectId,
          note: ' Easy pace ',
          estimateMinutes: 30,
          energy: 'medium',
          priority: 'normal',
        },
      }),
    );
    const routineId = createdRoutineId(receipt);
    expect((record('routine', routineId)?.document as RoutineDocument).axisId).toBe(axisId);
    const defaultsId = deriveNameBasedUuid(
      yelaxisDerivedIdNamespace,
      `routine-defaults:${routineId}:1`,
    );
    const defaults = record('routine_action_defaults', defaultsId)
      ?.document as RoutineActionDefaultsDocument;
    expect(defaults).toEqual({
      routineId,
      generation: 1,
      projectId,
      note: 'Easy pace',
      estimateMinutes: 30,
      energy: 'medium',
      priority: 'normal',
    });
    expect(harness.unitOfWork.state.events).toHaveLength(2);
    expectMinimizedEvents();
  });

  it('rejects unavailable Axes and Projects and invalid defaults without writing', async () => {
    const base = { title: 'Run', rule: daily('2026-10-01'), schedulingMode: flexible };
    expect(rejectionReason(await commands.createRoutine({ ...base, axisId: archivedAxisId }))).toBe(
      'axis_unavailable',
    );
    expect(
      rejectionReason(
        await commands.createRoutine({ ...base, defaults: { projectId: archivedProjectId } }),
      ),
    ).toBe('project_unavailable');
    expect(
      rejectionReason(await commands.createRoutine({ ...base, defaults: { estimateMinutes: 0 } })),
    ).toBe('estimate_minutes');
    expect(
      rejectionReason(await commands.createRoutine({ ...base, defaults: { energy: 'wild' } })),
    ).toBe('energy');
    expect(
      rejectionReason(await commands.createRoutine({ ...base, defaults: { priority: 'urgent' } })),
    ).toBe('priority');
    expect(
      rejectionReason(
        await commands.createRoutine({ ...base, defaults: { note: 'x'.repeat(10_001) } }),
      ),
    ).toBe('note_too_long');
    expect(
      rejectionReason(
        await commands.createRoutine({
          ...base,
          rule: weeklyCount('2026-09-28'),
          schedulingMode: morning,
        }),
      ),
    ).toBe('weekly_count_is_day_flexible');
    expect(recordsOf('routine')).toHaveLength(0);
    expect(harness.unitOfWork.state.events).toHaveLength(0);
  });
});

describe('repeatAfterAction', () => {
  beforeEach(() => {
    seed('action', actionId, {
      title: 'Call the clinic',
      captureOrigin: 'inbox',
      note: 'Ask about the results',
      axisId,
      projectId,
      estimateMinutes: 15,
      energy: 'low',
      priority: 'high',
      orderKey: '500000000000000',
      state: 'planned',
    });
    seed('planning_placement', '60000000-0000-4000-8000-000000000001' as UUID, {
      target: { kind: 'action', actionId },
      period: { kind: 'day', date: '2026-10-05' },
      orderKey: '500000000000000',
    });
  });

  it('starts strictly after the Action date and leaves the Action unchanged', async () => {
    const before = record('action', actionId);
    const rejected = await commands.repeatAfterAction({
      actionId,
      title: 'Call the clinic',
      rule: daily('2026-10-05'),
      schedulingMode: flexible,
    });
    expect(rejectionReason(rejected)).toBe('routine_must_start_after_action');

    const receipt = accepted(
      await commands.repeatAfterAction({
        actionId,
        title: 'Call the clinic',
        rule: daily('2026-10-06'),
        schedulingMode: flexible,
      }),
    );
    expect(record('action', actionId)).toEqual(before);
    expect(receipt.canonical.some((item) => item.ref.type === 'action')).toBe(false);
    const routineId = createdRoutineId(receipt);
    expect((record('routine', routineId)?.document as RoutineDocument).axisId).toBe(axisId);
    const defaults = record(
      'routine_action_defaults',
      deriveNameBasedUuid(yelaxisDerivedIdNamespace, `routine-defaults:${routineId}:1`),
    )?.document;
    expect(defaults).toEqual({
      routineId,
      generation: 1,
      projectId,
      note: 'Ask about the results',
      estimateMinutes: 15,
      energy: 'low',
      priority: 'high',
    });
    expectMinimizedEvents();
  });

  it('uses the planned block date, then the date-only due date, then today', async () => {
    seed('time_block', blockId, {
      target: { kind: 'action', actionId },
      startsAt: '2026-10-08T14:00:00.000Z',
      endsAt: '2026-10-08T15:00:00.000Z',
      timeZone: zone,
      state: 'planned',
      overlapAcknowledged: false,
    });
    // Remove the Day placement so the block date is the reference.
    const placement = record('planning_placement', '60000000-0000-4000-8000-000000000001');
    if (placement !== undefined)
      harness.unitOfWork.seed({
        ...placement,
        document: { ...placement.document, archivedAt: now },
      });
    const base = { actionId, title: 'Again', schedulingMode: flexible };
    expect(
      rejectionReason(await commands.repeatAfterAction({ ...base, rule: daily('2026-10-08') })),
    ).toBe('routine_must_start_after_action');
    accepted(await commands.repeatAfterAction({ ...base, rule: daily('2026-10-09') }));

    const block = record('time_block', blockId);
    if (block !== undefined)
      harness.unitOfWork.seed({ ...block, document: { ...block.document, state: 'canceled' } });
    const action = record('action', actionId);
    if (action !== undefined)
      harness.unitOfWork.seed({
        ...action,
        document: { ...action.document, due: { kind: 'date', date: '2026-10-20' } },
      });
    expect(
      rejectionReason(await commands.repeatAfterAction({ ...base, rule: daily('2026-10-20') })),
    ).toBe('routine_must_start_after_action');
    accepted(await commands.repeatAfterAction({ ...base, rule: daily('2026-10-21') }));

    if (action !== undefined) harness.unitOfWork.seed(action);
    expect(
      rejectionReason(await commands.repeatAfterAction({ ...base, rule: daily('2026-09-28') })),
    ).toBe('routine_must_start_after_action');
    accepted(await commands.repeatAfterAction({ ...base, rule: daily('2026-09-29') }));
  });

  it('requires the Action to exist', async () => {
    const result = await commands.repeatAfterAction({
      actionId: '40000000-0000-4000-8000-000000000099',
      title: 'Missing',
      rule: daily('2026-10-06'),
      schedulingMode: flexible,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('entity_not_found');
  });
});

describe('Routine series edits', () => {
  async function createRun(): Promise<UUID> {
    return createdRoutineId(
      accepted(
        await commands.createRoutine({
          title: 'Run',
          rule: daily('2026-09-28'),
          schedulingMode: flexible,
          defaults: { note: 'Easy', estimateMinutes: 30 },
        }),
      ),
    );
  }

  it('edits details on a non-archived Routine', async () => {
    const routineId = await createRun();
    accepted(
      await commands.editRoutineDetails({
        routineId,
        revision: 1,
        title: ' Morning run ',
        description: 'Before work',
        axisId,
      }),
    );
    const document = record('routine', routineId)?.document as RoutineDocument;
    expect(document.title).toBe('Morning run');
    expect(document.description).toBe('Before work');
    expect(document.axisId).toBe(axisId);
    accepted(await commands.editRoutineDetails({ routineId, revision: 2, title: 'Run' }));
    const cleared = record('routine', routineId)?.document as RoutineDocument;
    expect(cleared.axisId).toBeUndefined();
    expect(cleared.description).toBeUndefined();
    const stale = await commands.editRoutineDetails({ routineId, revision: 1, title: 'Stale' });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('revision_conflict');
  });

  it('splits This and future into a new generation and copies defaults', async () => {
    const routineId = await createRun();
    accepted(
      await commands.editRoutineThisAndFuture({
        routineId,
        revision: 1,
        selectedOn: '2026-10-10',
        rule: { version: 1, kind: 'weekly_days', intervalWeeks: 1, weekdays: ['saturday'] },
        schedulingMode: morning,
      }),
    );
    const document = record('routine', routineId)?.document as RoutineDocument;
    expect(document.generations).toHaveLength(2);
    expect(document.generations[0]?.rule.endsOn).toBe('2026-10-09');
    expect(document.generations[1]).toMatchObject({
      generation: 2,
      rule: { kind: 'weekly_days', startsOn: '2026-10-10' },
      schedulingMode: { kind: 'time_specific', wallTime: '07:00' },
    });
    const defaults = record(
      'routine_action_defaults',
      deriveNameBasedUuid(yelaxisDerivedIdNamespace, `routine-defaults:${routineId}:2`),
    )?.document;
    expect(defaults).toEqual({ routineId, generation: 2, note: 'Easy', estimateMinutes: 30 });
    expect(
      rejectionReason(
        await commands.editRoutineThisAndFuture({
          routineId,
          revision: 2,
          selectedOn: '2026-10-05',
          rule: daily('2026-10-05'),
          schedulingMode: flexible,
        }),
      ),
    ).toBe('split_before_generation');
    expectMinimizedEvents();
  });

  it('pauses and resumes without backfilling missed dates', async () => {
    const routineId = await createRun();
    expect(
      rejectionReason(
        await commands.pauseRoutine({ routineId, revision: 1, pauseOn: '2026-09-27' }),
      ),
    ).toBe('pause_in_past');
    accepted(await commands.pauseRoutine({ routineId, revision: 1, pauseOn: '2026-09-30' }));
    const paused = record('routine', routineId)?.document as RoutineDocument;
    expect(paused.state).toBe('paused');
    expect(paused.pauseEffectiveOn).toBe('2026-09-30');

    accepted(await commands.resumeRoutine({ routineId, revision: 2, resumeOn: '2026-10-05' }));
    const resumed = record('routine', routineId)?.document as RoutineDocument;
    expect(resumed.state).toBe('active');
    expect(resumed.pauseEffectiveOn).toBeUndefined();
    expect(
      resumed.generations.map((item) => [item.generation, item.rule.startsOn, item.rule.endsOn]),
    ).toEqual([
      [1, '2026-09-28', '2026-09-29'],
      [2, '2026-10-05', undefined],
    ]);
    expect(recordsOf('routine_occurrence')).toHaveLength(0);
    const defaults = record(
      'routine_action_defaults',
      deriveNameBasedUuid(yelaxisDerivedIdNamespace, `routine-defaults:${routineId}:2`),
    )?.document;
    expect(defaults).toMatchObject({ generation: 2, note: 'Easy' });
  });

  it('archives and restores, and blocks occurrence changes while archived', async () => {
    const routineId = await createRun();
    accepted(await commands.archiveRoutine({ routineId, revision: 1 }));
    const archived = record('routine', routineId)?.document as RoutineDocument;
    expect(archived).toMatchObject({
      state: 'archived',
      stateBeforeArchive: 'active',
      archivedAt: now,
    });
    const blocked = await commands.completeOccurrence({
      occurrence: { routineId, generation: 1, period: dated('2026-09-29') },
    });
    expect(rejectionReason(blocked)).toBe('routine_archived');
    expect(
      rejectionReason(await commands.editRoutineDetails({ routineId, revision: 2, title: 'Nope' })),
    ).toBe('routine_archived');
    accepted(await commands.restoreRoutine({ routineId, revision: 2 }));
    const restored = record('routine', routineId)?.document as RoutineDocument;
    expect(restored.state).toBe('active');
    expect(restored.stateBeforeArchive).toBeUndefined();
    expect(restored.archivedAt).toBeUndefined();
  });
});

describe('Routine Occurrences', () => {
  async function createDaily(schedulingMode: unknown = flexible): Promise<UUID> {
    return createdRoutineId(
      accepted(
        await commands.createRoutine({
          title: 'Stretch',
          rule: daily('2026-09-28'),
          schedulingMode,
        }),
      ),
    );
  }

  it('completes, reopens, and skips a dated occurrence with a deterministic id', async () => {
    const routineId = await createDaily();
    const period = dated('2026-09-30');
    const ref = occurrenceRef(routineId, 1, period);
    const commandId = harness.dependencies.ids.next();
    const first = accepted(
      await commands.completeOccurrence(
        { occurrence: { routineId, generation: 1, period } },
        commandId,
      ),
    );
    const stored = harness.unitOfWork.get(entityRefKey(ref));
    expect(stored?.document).toEqual({
      routineId,
      generation: 1,
      periodKey: '2026-09-30',
      period,
      state: 'completed',
      completedAt: now,
    });
    const eventCount = harness.unitOfWork.state.events.length;
    const retry = accepted(
      await commands.completeOccurrence(
        { occurrence: { routineId, generation: 1, period } },
        commandId,
      ),
    );
    expect(retry).toEqual(first);
    expect(harness.unitOfWork.state.events).toHaveLength(eventCount);
    expect(recordsOf('routine_occurrence')).toHaveLength(1);

    const stale = await commands.completeOccurrence({
      occurrence: { routineId, generation: 1, period },
    });
    expect(stale.ok).toBe(false);

    accepted(
      await commands.reopenOccurrence({
        occurrence: { routineId, generation: 1, period, revision: 1 },
      }),
    );
    const reopened = harness.unitOfWork.get(entityRefKey(ref))
      ?.document as RoutineOccurrenceDocument;
    expect(reopened.state).toBe('planned');
    expect(reopened.completedAt).toBeUndefined();

    accepted(
      await commands.skipOccurrence({
        occurrence: { routineId, generation: 1, period, revision: 2 },
      }),
    );
    expect(
      (harness.unitOfWork.get(entityRefKey(ref))?.document as RoutineOccurrenceDocument).state,
    ).toBe('skipped');
    expectMinimizedEvents();
  });

  it('rejects periods the Routine does not generate', async () => {
    const routineId = createdRoutineId(
      accepted(
        await commands.createRoutine({
          title: 'Weekly review',
          rule: {
            version: 1,
            kind: 'weekly_days',
            intervalWeeks: 1,
            weekdays: ['friday'],
            startsOn: '2026-09-28',
          },
          schedulingMode: flexible,
        }),
      ),
    );
    expect(
      rejectionReason(
        await commands.completeOccurrence({
          occurrence: { routineId, generation: 1, period: dated('2026-09-29') },
        }),
      ),
    ).toBe('occurrence_not_generated');
    expect(recordsOf('routine_occurrence')).toHaveLength(0);
  });

  it('counts weekly completions and requires confirmation for extras', async () => {
    const routineId = createdRoutineId(
      accepted(
        await commands.createRoutine({
          title: 'Swim',
          rule: weeklyCount('2026-09-28'),
          schedulingMode: flexible,
        }),
      ),
    );
    const period = week('2026-09-28', '2026-10-04');
    const ref = occurrenceRef(routineId, 1, period);
    const read = () =>
      harness.unitOfWork.get(entityRefKey(ref))?.document as RoutineOccurrenceDocument;
    accepted(
      await commands.completeOccurrence({ occurrence: { routineId, generation: 1, period } }),
    );
    expect(read()).toMatchObject({ state: 'planned', targetCount: 2, completedCount: 1 });
    expect(read().completedAt).toBeUndefined();
    accepted(
      await commands.completeOccurrence({
        occurrence: { routineId, generation: 1, period, revision: 1 },
      }),
    );
    expect(read()).toMatchObject({ state: 'completed', completedCount: 2, completedAt: now });
    expect(
      rejectionReason(
        await commands.completeOccurrence({
          occurrence: { routineId, generation: 1, period, revision: 2 },
        }),
      ),
    ).toBe('extra_completion_confirmation');
    accepted(
      await commands.completeOccurrence({
        occurrence: { routineId, generation: 1, period, revision: 2 },
        confirmExtra: true,
      }),
    );
    expect(read()).toMatchObject({
      state: 'completed',
      completedCount: 3,
      extraCompletionsConfirmed: true,
    });
    accepted(
      await commands.reopenOccurrence({
        occurrence: { routineId, generation: 1, period, revision: 3 },
      }),
    );
    expect(read()).toMatchObject({ state: 'completed', completedCount: 2 });
    expect(read().extraCompletionsConfirmed).toBeUndefined();
    accepted(
      await commands.reopenOccurrence({
        occurrence: { routineId, generation: 1, period, revision: 4 },
      }),
    );
    expect(read()).toMatchObject({ state: 'planned', completedCount: 1 });
    expect(read().completedAt).toBeUndefined();
  });

  it('undoes a completion by returning the occurrence to planned', async () => {
    const routineId = await createDaily();
    const period = dated('2026-09-29');
    const receipt = accepted(
      await commands.completeOccurrence({ occurrence: { routineId, generation: 1, period } }),
    );
    accepted(await undo(receipt));
    const document = harness.unitOfWork.get(entityRefKey(occurrenceRef(routineId, 1, period)))
      ?.document as RoutineOccurrenceDocument;
    expect(document.state).toBe('planned');
    expect(document.completedAt).toBeUndefined();
  });

  it('moves one occurrence to another date without changing the rule', async () => {
    const routineId = await createDaily(flexible);
    const period = dated('2026-10-01');
    accepted(
      await commands.editOccurrence({
        occurrence: { routineId, generation: 1, period },
        date: '2026-10-02',
        overlapAcknowledged: false,
      }),
    );
    const document = harness.unitOfWork.get(entityRefKey(occurrenceRef(routineId, 1, period)))
      ?.document as RoutineOccurrenceDocument;
    expect(document.override).toEqual({ date: '2026-10-02' });
    expect((record('routine', routineId)?.document as RoutineDocument).generations).toHaveLength(1);

    // Moving back to its own date removes the override.
    accepted(
      await commands.editOccurrence({
        occurrence: { routineId, generation: 1, period, revision: 1 },
        date: '2026-10-01',
        overlapAcknowledged: false,
      }),
    );
    const reverted = harness.unitOfWork.get(entityRefKey(occurrenceRef(routineId, 1, period)))
      ?.document as RoutineOccurrenceDocument;
    expect(reverted.override).toBeUndefined();
  });

  it('marks a sibling occurrence when a timed move onto it is acknowledged', async () => {
    const routineId = await createDaily(morning);
    const moved = { routineId, generation: 1, period: dated('2026-10-01') };
    const sibling = occurrenceRef(routineId, 1, dated('2026-10-02'));
    expect(
      rejectionReason(
        await commands.editOccurrence({
          occurrence: moved,
          date: '2026-10-02',
          overlapAcknowledged: false,
        }),
      ),
    ).toBe('overlap_requires_acknowledgement');
    accepted(
      await commands.editOccurrence({
        occurrence: moved,
        date: '2026-10-02',
        overlapAcknowledged: true,
      }),
    );
    const own = harness.unitOfWork.get(entityRefKey(occurrenceRef(routineId, 1, moved.period)))
      ?.document as RoutineOccurrenceDocument;
    expect(own.override).toEqual({ date: '2026-10-02', overlapAcknowledged: true });
    const other = harness.unitOfWork.get(entityRefKey(sibling))
      ?.document as RoutineOccurrenceDocument;
    expect(other).toMatchObject({ state: 'planned', override: { overlapAcknowledged: true } });
  });

  it('requires a duration with a time for a day-flexible occurrence', async () => {
    const routineId = await createDaily(flexible);
    const occurrence = { routineId, generation: 1, period: dated('2026-10-01') };
    expect(
      rejectionReason(
        await commands.editOccurrence({
          occurrence,
          date: '2026-10-01',
          startTime: '10:00',
          overlapAcknowledged: false,
        }),
      ),
    ).toBe('time_requires_duration');
    accepted(
      await commands.editOccurrence({
        occurrence,
        date: '2026-10-01',
        startTime: '10:00',
        durationMinutes: 20,
        overlapAcknowledged: false,
      }),
    );
    const document = harness.unitOfWork.get(
      entityRefKey(occurrenceRef(routineId, 1, occurrence.period)),
    )?.document as RoutineOccurrenceDocument;
    expect(document.override).toEqual({ wallTime: '10:00', durationMinutes: 20 });
    expect(
      rejectionReason(
        await commands.editOccurrence({
          occurrence: { routineId, generation: 1, period: week('2026-09-28', '2026-10-04') },
          date: '2026-10-01',
          overlapAcknowledged: false,
        }),
      ),
    ).toBe('weekly_occurrence_has_no_date');
  });

  it('requires explicit acknowledgement for overlaps and marks both items', async () => {
    const routineId = await createDaily(morning);
    // 2026-10-03 07:15-08:00 in New York (EDT, UTC-4).
    seed('time_block', blockId, {
      target: { kind: 'custom', title: 'Dentist' },
      startsAt: '2026-10-03T11:15:00.000Z',
      endsAt: '2026-10-03T12:00:00.000Z',
      timeZone: zone,
      state: 'planned',
      overlapAcknowledged: false,
    });
    const occurrence = { routineId, generation: 1, period: dated('2026-10-03') };
    const rejected = await commands.editOccurrence({
      occurrence,
      date: '2026-10-03',
      durationMinutes: 45,
      overlapAcknowledged: false,
    });
    expect(rejectionReason(rejected)).toBe('overlap_requires_acknowledgement');
    if (!rejected.ok && rejected.error.code === 'domain_rejected')
      expect(rejected.error.domainError.details?.['overlaps']).toEqual([
        { key: `block:${blockId}`, title: 'Dentist' },
      ]);
    expect(recordsOf('routine_occurrence')).toHaveLength(0);

    // Moving to 06:00 for 30 minutes avoids the block entirely.
    accepted(
      await commands.editOccurrence({
        occurrence: { routineId, generation: 1, period: dated('2026-10-04') },
        date: '2026-10-03',
        startTime: '06:00',
        overlapAcknowledged: false,
      }),
    );

    const receipt = accepted(
      await commands.editOccurrence({
        occurrence,
        date: '2026-10-03',
        durationMinutes: 45,
        overlapAcknowledged: true,
      }),
    );
    const document = harness.unitOfWork.get(
      entityRefKey(occurrenceRef(routineId, 1, occurrence.period)),
    )?.document as RoutineOccurrenceDocument;
    expect(document.override).toEqual({ durationMinutes: 45, overlapAcknowledged: true });
    const block = record('time_block', blockId);
    expect(block?.localRevision).toBe(2);
    expect((block?.document as TimeBlockDocument).overlapAcknowledged).toBe(true);
    expect(receipt.canonical.map((item) => item.ref.type).sort()).toEqual([
      'routine_occurrence',
      'time_block',
    ]);
    expectMinimizedEvents();

    // Undo restores the block acknowledgement and returns the occurrence to its plain state.
    accepted(await undo(receipt));
    expect((record('time_block', blockId)?.document as TimeBlockDocument).overlapAcknowledged).toBe(
      false,
    );
  });
});

describe('This-and-future and resume never count a period twice', () => {
  const splitDaily = (routineId: UUID, revision: number, selectedOn: string) =>
    commands.editRoutineThisAndFuture({
      routineId,
      revision,
      selectedOn,
      rule: daily(selectedOn),
      schedulingMode: morning,
    });

  async function create(rule: unknown): Promise<UUID> {
    return createdRoutineId(
      accepted(await commands.createRoutine({ title: 'Run', rule, schedulingMode: flexible })),
    );
  }

  function rejectionMessage(result: ApplicationResult<CommandReceipt>): string | undefined {
    return !result.ok && result.error.code === 'domain_rejected'
      ? result.error.domainError.message
      : undefined;
  }

  it('rejects a split date in the past', async () => {
    const routineId = await create(daily('2026-09-28'));
    expect(rejectionReason(await splitDaily(routineId, 1, '2026-09-27'))).toBe('split_in_past');
  });

  it('rejects a split when this schedule already completed a later date', async () => {
    const routineId = await create(daily('2026-09-28'));
    accepted(
      await commands.completeOccurrence({
        occurrence: { routineId, generation: 1, period: dated('2026-10-12') },
      }),
    );
    const blocked = await splitDaily(routineId, 1, '2026-10-10');
    expect(rejectionReason(blocked)).toBe('materialized_occurrences_after_split');
    expect(rejectionMessage(blocked)).toBe(
      'The occurrence on 2026-10-12 was already changed or completed. Choose a date after it.',
    );
    expect((record('routine', routineId)?.document as RoutineDocument).generations).toHaveLength(1);
    accepted(await splitDaily(routineId, 1, '2026-10-13'));
    expect((record('routine', routineId)?.document as RoutineDocument).generations).toHaveLength(2);
  });

  it('does not let a reopened, unchanged occurrence block a split', async () => {
    const routineId = await create(daily('2026-09-28'));
    const occurrence = { routineId, generation: 1, period: dated('2026-10-12') } as const;
    accepted(await commands.completeOccurrence({ occurrence }));
    accepted(await commands.reopenOccurrence({ occurrence: { ...occurrence, revision: 1 } }));
    const reopened = harness.unitOfWork.get(
      entityRefKey(occurrenceRef(routineId, 1, dated('2026-10-12'))),
    )?.document as RoutineOccurrenceDocument;
    expect(reopened.state).toBe('planned');
    accepted(await splitDaily(routineId, 1, '2026-10-10'));
    expect((record('routine', routineId)?.document as RoutineDocument).generations).toHaveLength(2);
  });

  it('rejects a weekly split on a week that already has progress', async () => {
    const routineId = await create(weeklyCount('2026-09-21', 3));
    accepted(
      await commands.completeOccurrence({
        occurrence: { routineId, generation: 1, period: week('2026-09-28', '2026-10-04', 3) },
      }),
    );
    const weekly = (selectedOn: string) =>
      commands.editRoutineThisAndFuture({
        routineId,
        revision: 1,
        selectedOn,
        rule: { version: 1, kind: 'weekly_count', targetCount: 5, weekStart: 'monday' },
        schedulingMode: flexible,
      });
    expect(rejectionReason(await weekly('2026-09-28'))).toBe(
      'materialized_occurrences_after_split',
    );
    accepted(await weekly('2026-10-05'));
  });

  it('rejects a resume that would repeat a date this schedule already completed', async () => {
    const routineId = await create(daily('2026-09-28'));
    accepted(
      await commands.completeOccurrence({
        occurrence: { routineId, generation: 1, period: dated('2026-10-06') },
      }),
    );
    accepted(await commands.pauseRoutine({ routineId, revision: 1, pauseOn: '2026-09-30' }));
    expect(
      rejectionReason(
        await commands.resumeRoutine({ routineId, revision: 2, resumeOn: '2026-10-05' }),
      ),
    ).toBe('materialized_occurrences_after_split');
    accepted(await commands.resumeRoutine({ routineId, revision: 2, resumeOn: '2026-10-07' }));
    expect(
      (record('routine', routineId)?.document as RoutineDocument).generations.map(
        (item) => item.rule.startsOn,
      ),
    ).toEqual(['2026-09-28', '2026-10-07']);
  });
});

describe('This-occurrence edits in a fixed Routine zone', () => {
  const london = {
    ...morning,
    wallTime: '09:00',
    zonePolicy: { kind: 'fixed_zone', timeZone: 'Europe/London' },
  };

  async function createLondon(): Promise<UUID> {
    return createdRoutineId(
      accepted(
        await commands.createRoutine({
          title: 'Call home',
          rule: daily('2026-09-28'),
          schedulingMode: london,
        }),
      ),
    );
  }

  const readOverride = (routineId: UUID, date: string) =>
    (
      harness.unitOfWork.get(entityRefKey(occurrenceRef(routineId, 1, dated(date))))
        ?.document as RoutineOccurrenceDocument
    ).override;

  it('keeps the London time when only the duration changes', async () => {
    const routineId = await createLondon();
    accepted(
      await commands.editOccurrence({
        occurrence: { routineId, generation: 1, period: dated('2026-10-05') },
        date: '2026-10-05',
        durationMinutes: 45,
        overlapAcknowledged: false,
      }),
    );
    expect(readOverride(routineId, '2026-10-05')).toEqual({ durationMinutes: 45 });
  });

  it('keeps an earlier time change when a later edit only moves the date', async () => {
    const routineId = await createLondon();
    const period = dated('2026-10-05');
    accepted(
      await commands.editOccurrence({
        occurrence: { routineId, generation: 1, period },
        date: '2026-10-05',
        startTime: '10:30',
        overlapAcknowledged: false,
      }),
    );
    accepted(
      await commands.editOccurrence({
        occurrence: { routineId, generation: 1, period, revision: 1 },
        date: '2026-10-06',
        overlapAcknowledged: false,
      }),
    );
    expect(readOverride(routineId, '2026-10-05')).toEqual({
      date: '2026-10-06',
      wallTime: '10:30',
    });
  });

  it('previews an occurrence edit in the Routine zone with the same rules as the save', async () => {
    const routineId = await createLondon();
    const projections = createPlanningProjections(
      harness.dependencies,
      createTestPlanningQueries(harness.unitOfWork, profile),
    );
    const occurrence = { routineId, generation: 1, period: dated('2026-10-05') };
    // 09:00 in London (BST) is 04:00 in New York; a New York block at 04:15 overlaps it.
    seed('time_block', blockId, {
      target: { kind: 'custom', title: 'Early call' },
      startsAt: '2026-10-05T08:15:00.000Z',
      endsAt: '2026-10-05T08:45:00.000Z',
      timeZone: zone,
      state: 'planned',
      overlapAcknowledged: false,
    });
    const preview = await projections.resolveLocalInterval({
      occurrence,
      date: '2026-10-05',
      startTime: '09:00',
      durationMinutes: 30,
    });
    expect(preview).toEqual({
      ok: true,
      value: {
        startsAt: '2026-10-05T08:00:00.000Z',
        endsAt: '2026-10-05T08:30:00.000Z',
        localStart: '09:00',
        localEnd: '09:30',
        localEndDate: '2026-10-05',
        utcOffset: '+01:00',
        timeZone: 'Europe/London',
        overlaps: [{ key: `block:${blockId}`, title: 'Early call' }],
      },
    });
    const later = await projections.resolveLocalInterval(
      { occurrence, date: '2026-10-05', startTime: '11:00', durationMinutes: 30 },
      [`block:${blockId}`],
    );
    expect(later.ok && later.value).toMatchObject({
      startsAt: '2026-10-05T10:00:00.000Z',
      overlaps: [],
    });
  });
});
