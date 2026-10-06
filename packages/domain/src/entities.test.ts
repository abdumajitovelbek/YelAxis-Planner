import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createFixedInterval,
  parseCalendarDate,
  parseIanaTimeZone,
  parseInstant,
  parseRecurrenceRuleV1,
  parseUUID,
  routineOccurrenceKey,
  validateActionSnapshot,
  validateCommitmentSnapshot,
  validateConstraintSnapshot,
  validateNoteSnapshot,
  validateOutcomeSnapshot,
  validateProjectSnapshot,
  validateReminderTarget,
  validateReminderSchedule,
  validateRoutineActionDefaults,
  validateRoutineSnapshot,
  validateRoutineOccurrenceSnapshot,
  validateTimeBlockTarget,
  validateTimeBlockSnapshot,
  validateTemplateSnapshot,
  type Action,
  type Axis,
  type Commitment,
  type Constraint,
  type Direction,
  type DomainResult,
  type FocusSelection,
  type Milestone,
  type Note,
  type Outcome,
  type PlanningPlacement,
  type Profile,
  type Project,
  type Reminder,
  type Review,
  type Routine,
  type RoutineActionDefaults,
  type RoutineOccurrence,
  type Template,
  type Theme,
  type TimeBlock,
  type UserContext,
} from './index.js';

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const id = (suffix: string) =>
  expectValue(parseUUID(`0190c2b1-7d9a-7cc1-8be5-b88620c57f5${suffix}`));
const createdAt = expectValue(parseInstant('2026-07-23T10:00:00Z'));
const ownerId = id('5');
const profileId = id('6');

const metadata = {
  id: id('7'),
  ownerId,
  profileId,
  localRevision: 1,
  createdAt,
  updatedAt: createdAt,
  orderKey: 'a0',
} as const;

describe('immutable entity contracts', () => {
  it('exports the complete canonical entity vocabulary', () => {
    expectTypeOf<Profile>().toHaveProperty('planningTimeZone');
    expectTypeOf<Axis>().toHaveProperty('state');
    expectTypeOf<Outcome>().toHaveProperty('progress');
    expectTypeOf<Milestone>().toHaveProperty('outcomeId');
    expectTypeOf<Project>().toHaveProperty('state');
    expectTypeOf<Action>().toHaveProperty('due');
    expectTypeOf<Action>().toHaveProperty('completedAt');
    expectTypeOf<Action>().toHaveProperty('convertedTo');
    expectTypeOf<Note>().toHaveProperty('body');
    expectTypeOf<Commitment>().toHaveProperty('strength');
    expectTypeOf<Constraint>().toHaveProperty('constraintKind');
    expectTypeOf<TimeBlock>().toHaveProperty('target');
    expectTypeOf<Routine>().toHaveProperty('rule');
    expectTypeOf<RoutineOccurrence>().toHaveProperty('logicalKey');
    expectTypeOf<RoutineActionDefaults>().toHaveProperty('generation');
    expectTypeOf<Template>().toHaveProperty('state');
    expectTypeOf<Template>().toHaveProperty('blueprint');
    expectTypeOf<Review>().toHaveProperty('period');
    expectTypeOf<Reminder>().toHaveProperty('target');
    expectTypeOf<UserContext>().toHaveProperty('sensitivity');
    expectTypeOf<UserContext>().toHaveProperty('contextKey');
    expectTypeOf<PlanningPlacement>().toHaveProperty('period');
    expectTypeOf<FocusSelection>().toHaveProperty('orderKey');
    expectTypeOf<Theme>().toHaveProperty('month');
    expectTypeOf<Direction>().toHaveProperty('year');
  });

  it('enforces Action placement and current-block state invariants', () => {
    const base: Action = {
      ...metadata,
      title: 'Prepare brief',
      captureOrigin: 'global_capture',
      state: 'planned',
    };
    expect(
      validateActionSnapshot(base, { activePlacementCount: 1, currentPlannedBlockCount: 0 }).ok,
    ).toBe(true);
    expect(
      validateActionSnapshot(
        { ...base, state: 'inbox' },
        {
          activePlacementCount: 1,
          currentPlannedBlockCount: 0,
        },
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_value' } });
    expect(
      validateActionSnapshot(
        { ...base, state: 'scheduled' },
        {
          activePlacementCount: 1,
          currentPlannedBlockCount: 0,
        },
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_value' } });
    expect(
      validateActionSnapshot(
        { ...base, state: 'scheduled' },
        {
          activePlacementCount: 1,
          currentPlannedBlockCount: 1,
        },
      ).ok,
    ).toBe(true);
    expect(
      validateActionSnapshot(
        { ...base, state: 'in_progress' },
        {
          activePlacementCount: 1,
          currentPlannedBlockCount: 1,
        },
      ).ok,
    ).toBe(true);
    expect(
      validateActionSnapshot(
        { ...base, state: 'completed', completedAt: createdAt },
        {
          activePlacementCount: 1,
          currentPlannedBlockCount: 1,
        },
      ).ok,
    ).toBe(true);
    expect(
      validateActionSnapshot(base, { activePlacementCount: 2, currentPlannedBlockCount: 0 }).ok,
    ).toBe(false);
    expect(
      validateActionSnapshot(
        { ...base, orderKey: ' ' },
        {
          activePlacementCount: 1,
          currentPlannedBlockCount: 0,
        },
      ).ok,
    ).toBe(false);
  });

  it('keeps Action completion, archive, and conversion metadata lifecycle-consistent', () => {
    const base: Action = {
      ...metadata,
      title: 'Prepare brief',
      captureOrigin: 'global_capture',
      state: 'planned',
    };
    const counts = { activePlacementCount: 1, currentPlannedBlockCount: 0 } as const;

    expect(validateActionSnapshot({ ...base, state: 'completed' }, counts).ok).toBe(false);
    expect(validateActionSnapshot({ ...base, completedAt: createdAt }, counts).ok).toBe(false);
    expect(
      validateActionSnapshot({ ...base, state: 'archived', archivedAt: createdAt }, counts).ok,
    ).toBe(false);
    expect(
      validateActionSnapshot(
        {
          ...base,
          state: 'archived',
          stateBeforeArchive: 'planned',
          archivedAt: createdAt,
        },
        counts,
      ).ok,
    ).toBe(true);
    expect(
      validateActionSnapshot({ ...base, convertedTo: { type: 'note', id: id('d') } }, counts).ok,
    ).toBe(false);
    expect(
      validateActionSnapshot(
        {
          ...base,
          state: 'archived',
          stateBeforeArchive: 'planned',
          archivedAt: createdAt,
          convertedTo: { type: 'project', id: id('e') },
        },
        counts,
      ).ok,
    ).toBe(true);
  });

  it('validates progress, retained-note, Template, and Constraint payload invariants', () => {
    const outcome: Outcome = {
      ...metadata,
      title: 'Publish',
      successDefinition: 'Public release is available',
      progress: { mode: 'manual', percentage: 50 },
      state: 'active',
    };
    expect(validateOutcomeSnapshot(outcome).ok).toBe(true);
    expect(
      validateOutcomeSnapshot({ ...outcome, progress: { mode: 'manual', percentage: 101 } }).ok,
    ).toBe(false);

    const projectIdea: Project = { ...metadata, title: 'Possible project', state: 'idea' };
    expect(validateProjectSnapshot(projectIdea).ok).toBe(true);
    expect(validateProjectSnapshot({ ...projectIdea, desiredResult: ' ' }).ok).toBe(false);
    expect(
      validateProjectSnapshot({
        ...projectIdea,
        state: 'archived',
        stateBeforeArchive: 'idea',
      }).ok,
    ).toBe(true);
    expect(validateProjectSnapshot({ ...projectIdea, state: 'active' }).ok).toBe(false);
    expect(
      validateProjectSnapshot({ ...projectIdea, state: 'active', desiredResult: 'Released result' })
        .ok,
    ).toBe(true);

    const note: Note = { ...metadata, title: 'Reference', state: 'active' };
    expect(validateNoteSnapshot(note).ok).toBe(true);
    expect(validateNoteSnapshot({ ...note, title: ' ', body: '' }).ok).toBe(false);

    const template: Template = {
      ...metadata,
      title: 'Weekly Reset',
      blueprint: {
        version: 1,
        items: [
          { templateKey: 'project', kind: 'project', title: 'Plan the week' },
          {
            templateKey: 'action',
            parentTemplateKey: 'project',
            kind: 'action',
            title: 'Review commitments',
          },
        ],
      },
      state: 'active',
    };
    expect(validateTemplateSnapshot(template).ok).toBe(true);
    expect(
      validateTemplateSnapshot({
        ...template,
        blueprint: {
          version: 1,
          items: [
            { templateKey: 'action', parentTemplateKey: 'missing', kind: 'action', title: 'A' },
          ],
        },
      }).ok,
    ).toBe(false);

    const constraint: Constraint = {
      ...metadata,
      constraintKind: 'capacity',
      strength: 'soft',
      valueSchemaVersion: 1,
      value: { kind: 'capacity', period: 'week', minutes: 600 },
      state: 'active',
    };
    expect(validateConstraintSnapshot(constraint).ok).toBe(true);
    expect(
      validateConstraintSnapshot({
        ...constraint,
        value: { kind: 'capacity', period: 'week', minutes: -1 },
      }).ok,
    ).toBe(false);
  });

  it('validates checked Time Block target unions', () => {
    const timeBlockTargets = [
      { kind: 'action', actionId: id('8') },
      { kind: 'routine_occurrence', routineOccurrenceId: id('9') },
      { kind: 'commitment', commitmentId: id('a') },
      { kind: 'custom', title: 'Travel' },
    ] as const;
    for (const target of timeBlockTargets) {
      expect(validateTimeBlockTarget(target).ok).toBe(true);
    }
    expect(validateTimeBlockTarget({ kind: 'custom', title: '  ' }).ok).toBe(false);
    const reminderTargets = [
      { kind: 'action', actionId: id('8') },
      { kind: 'time_block', timeBlockId: id('9') },
      { kind: 'routine', routineId: id('a') },
      { kind: 'review', reviewId: id('b') },
    ] as const;
    for (const target of reminderTargets) {
      expect(validateReminderTarget(target).ok).toBe(true);
    }
    expect(validateReminderTarget({ kind: 'project', projectId: id('8') }).ok).toBe(false);
    expect(
      validateReminderSchedule({
        kind: 'relative',
        remindAt: '2026-07-23T09:30:00Z',
        offsetMinutes: -30,
        timeZone: 'Asia/Tashkent',
      }).ok,
    ).toBe(true);
    expect(
      validateReminderSchedule({
        kind: 'relative',
        remindAt: '2026-07-23T09:30:00Z',
        timeZone: 'Asia/Tashkent',
      }).ok,
    ).toBe(false);
  });

  it('validates Commitment, Time Block history, and Routine scheduling snapshots', () => {
    const commitment: Commitment = {
      ...metadata,
      title: 'Appointment',
      strength: 'hard',
      state: 'planned',
    };
    expect(validateCommitmentSnapshot(commitment, 1).ok).toBe(true);
    expect(validateCommitmentSnapshot(commitment, 0).ok).toBe(false);
    expect(validateCommitmentSnapshot({ ...commitment, state: 'completed' }, 1).ok).toBe(true);

    const interval = expectValue(
      createFixedInterval(
        expectValue(parseInstant('2026-07-23T10:00:00Z')),
        expectValue(parseInstant('2026-07-23T11:00:00Z')),
        expectValue(parseIanaTimeZone('Asia/Tashkent')),
      ),
    );
    const block: TimeBlock = {
      ...metadata,
      interval,
      target: { kind: 'commitment', commitmentId: commitment.id },
      state: 'planned',
    };
    expect(validateTimeBlockSnapshot(block).ok).toBe(true);
    expect(validateTimeBlockSnapshot({ ...block, supersededById: id('c') }).ok).toBe(false);
    expect(
      validateTimeBlockSnapshot({ ...block, state: 'canceled', supersededById: id('c') }).ok,
    ).toBe(true);

    const rule = expectValue(
      parseRecurrenceRuleV1({
        version: 1,
        kind: 'daily',
        intervalDays: 1,
        startsOn: '2026-07-23',
      }),
    );
    const routine: Routine = {
      ...metadata,
      title: 'Plan tomorrow',
      generation: 1,
      rule,
      schedulingMode: { kind: 'day_flexible' },
      state: 'active',
    };
    expect(validateRoutineSnapshot(routine).ok).toBe(true);
    expect(validateRoutineSnapshot({ ...routine, state: 'paused' }).ok).toBe(false);
    expect(
      validateRoutineSnapshot({
        ...routine,
        state: 'paused',
        pauseEffectiveOn: expectValue(parseCalendarDate('2026-07-24')),
      }).ok,
    ).toBe(true);
  });

  it('requires versioned, owner-safe Routine action defaults', () => {
    const defaults: RoutineActionDefaults = {
      ...metadata,
      routineId: id('a'),
      generation: 2,
      projectId: id('b'),
      note: 'Bring draft',
      estimateMinutes: 25,
      energy: 'focused',
      priority: 'high',
    };
    expect(
      validateRoutineActionDefaults(defaults, { routineOwnerId: ownerId, projectOwnerId: ownerId })
        .ok,
    ).toBe(true);
    expect(
      validateRoutineActionDefaults(defaults, {
        routineOwnerId: ownerId,
        projectOwnerId: id('c'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'owner_mismatch' } });
    expect(
      validateRoutineActionDefaults({ ...defaults, generation: 0 }, { routineOwnerId: ownerId }).ok,
    ).toBe(false);
  });

  it('keeps weekly-count counters coherent without automatic completion', () => {
    const occurrence: RoutineOccurrence = {
      ...metadata,
      routineId: id('d'),
      generation: 1,
      logicalKey: routineOccurrenceKey(id('d'), 1, 'week', '2026-07-20/2026-07-26/monday'),
      period: {
        kind: 'week',
        start: expectValue(parseCalendarDate('2026-07-20')),
        end: expectValue(parseCalendarDate('2026-07-26')),
        weekStart: 'monday',
        targetCount: 3,
      },
      state: 'planned',
      targetCount: 3,
      completedCount: 3,
    };
    expect(validateRoutineOccurrenceSnapshot(occurrence).ok).toBe(false);
    expect(validateRoutineOccurrenceSnapshot({ ...occurrence, state: 'completed' }).ok).toBe(true);
    expect(validateRoutineOccurrenceSnapshot({ ...occurrence, completedCount: 4 }).ok).toBe(false);
    expect(
      validateRoutineOccurrenceSnapshot({
        ...occurrence,
        state: 'completed',
        completedCount: 4,
        extraCompletionsConfirmed: true,
      }).ok,
    ).toBe(true);
  });

  it('uses validated profile defaults rather than an ambient machine zone', () => {
    const profile: Profile = {
      ...metadata,
      planningTimeZone: expectValue(parseIanaTimeZone('Asia/Tashkent')),
      weekStart: 'monday',
      timeFormat: '24_hour',
    };
    expect(profile.planningTimeZone).toBe('Asia/Tashkent');

    const context: UserContext = {
      ...metadata,
      category: 'availability',
      contextKey: 'normal_week',
      value: 'Weekdays',
      source: 'device',
      sensitivity: 'normal',
      strength: 'unknown',
      futureSharing: 'not_shared',
      state: 'active',
    };
    expect(context.futureSharing).toBe('not_shared');
  });
});
