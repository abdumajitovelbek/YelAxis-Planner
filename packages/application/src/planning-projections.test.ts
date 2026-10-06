import {
  periodRange,
  rangesOverlap,
  type ActionState,
  type CalendarDate,
  type DateRange,
  type HorizonPeriod,
  type IanaTimeZone,
  type Instant,
  type MaterializedOccurrenceSnapshot,
  type OwnerId,
  type RecurrenceRuleV1,
  type RoutineSchedulingMode,
  type TemplateBlueprint,
  type UUID,
  type WallTime,
} from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import type {
  ActionSummary,
  BlockRow,
  ConstraintRow,
  MilestoneRow,
  OutcomeRow,
  PlacementRow,
  PlanningQueryPort,
  ProjectTargetRow,
  RoutineRow,
  TemplateRow,
  ThemeRow,
} from './planning-contracts';
import { createPlanningProjections, densitySummary } from './planning-projections';
import { availabilityFor } from './planning-projections-range';
import { builtInTemplates } from './template-catalog';
import { createInMemoryHarness } from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const zone = 'America/New_York' as IanaTimeZone;
const now = '2026-09-27T16:00:00.000Z' as Instant;
const d = (value: string) => value as CalendarDate;
const t = (value: string) => value as Instant;
const w = (value: string) => value as WallTime;
const uuid = (suffix: number) =>
  `20000000-0000-4000-8000-${String(suffix).padStart(12, '0')}` as UUID;

interface Fixture {
  blocks: BlockRow[];
  placements: PlacementRow[];
  routines: RoutineRow[];
  materialized: MaterializedOccurrenceSnapshot[];
  constraints: ConstraintRow[];
  themes: ThemeRow[];
  outcomes: OutcomeRow[];
  milestones: MilestoneRow[];
  projects: ProjectTargetRow[];
  templates: TemplateRow[];
  backlog: ActionSummary[];
}

const emptyFixture = (): Fixture => ({
  blocks: [],
  placements: [],
  routines: [],
  materialized: [],
  constraints: [],
  themes: [],
  outcomes: [],
  milestones: [],
  projects: [],
  templates: [],
  backlog: [],
});

const windowOverlaps = (
  row: {
    readonly targetStart?: CalendarDate;
    readonly targetEnd?: CalendarDate;
    readonly placement?: { readonly period: HorizonPeriod };
  },
  range: DateRange,
): boolean => {
  if (row.placement !== undefined && rangesOverlap(periodRange(row.placement.period), range))
    return true;
  const start = row.targetStart ?? row.targetEnd;
  const end = row.targetEnd ?? row.targetStart;
  return start !== undefined && end !== undefined && rangesOverlap({ start, end }, range);
};

/** Fixture-backed query port that fails if two reads overlap (one SQLite worker connection). */
function fakeQueries(fixture: Fixture): { port: PlanningQueryPort; calls: string[] } {
  const calls: string[] = [];
  let inFlight = false;
  const read = async <T>(name: string, value: () => T): Promise<T> => {
    if (inFlight) throw new Error(`Overlapping read: ${name}`);
    inFlight = true;
    calls.push(name);
    await Promise.resolve();
    inFlight = false;
    return value();
  };
  const unused = (name: string) => () => Promise.reject(new Error(`Unexpected ${name}`));
  const port: PlanningQueryPort = {
    getPlanProfile: () =>
      read('getPlanProfile', () => ({
        profileId: uuid(999),
        planningTimeZone: zone,
        weekStart: 'monday' as const,
        timeFormat: '24_hour' as const,
      })),
    listBlocks: (_owner, startsAt, endsAt) =>
      read('listBlocks', () =>
        fixture.blocks.filter(
          (block) =>
            Date.parse(block.startsAt) < Date.parse(endsAt) &&
            Date.parse(startsAt) < Date.parse(block.endsAt),
        ),
      ),
    listPlacements: (_owner, range) =>
      read('listPlacements', () =>
        fixture.placements.filter((row) => rangesOverlap(periodRange(row.period), range)),
      ),
    listBacklog: (_owner, limit) =>
      read('listBacklog', () => ({
        items: fixture.backlog.slice(0, limit),
        total: fixture.backlog.length,
      })),
    listCarryForward: () => read('listCarryForward', () => ({ items: [], total: 0 })),
    listWeekSelections: () => read('listWeekSelections', () => []),
    listRoutines: (_owner, options) =>
      read('listRoutines', () =>
        fixture.routines.filter(
          (row) => options.includeArchived || row.document.state !== 'archived',
        ),
      ),
    getRoutine: (_owner, id) =>
      read('getRoutine', () => fixture.routines.find((row) => row.id === id) ?? null),
    listMaterializedOccurrences: (_owner, range, routineId) =>
      read('listMaterializedOccurrences', () =>
        fixture.materialized.filter((row) => {
          if (routineId !== undefined && row.routineId !== routineId) return false;
          if (row.period.kind === 'week') return rangesOverlap(row.period, range);
          const date = row.override?.date ?? row.period.date;
          return date >= range.start && date <= range.end;
        }),
      ),
    listOccurrenceHistory: (_owner, routineId, limit) =>
      read('listOccurrenceHistory', () =>
        fixture.materialized.filter((row) => row.routineId === routineId).slice(0, limit),
      ),
    listCapacityConstraints: () => read('listCapacityConstraints', () => fixture.constraints),
    listMonthThemes: (_owner, year) =>
      read('listMonthThemes', () => fixture.themes.filter((row) => row.month.startsWith(year))),
    getYearDirection: (_owner, year) =>
      read('getYearDirection', () =>
        year === '2026'
          ? { id: uuid(900), localRevision: 1, year, text: 'Steady foundations' }
          : null,
      ),
    listOutcomes: (_owner, range) =>
      read('listOutcomes', () => fixture.outcomes.filter((row) => windowOverlaps(row, range))),
    listMilestones: (_owner, range) =>
      read('listMilestones', () => fixture.milestones.filter((row) => windowOverlaps(row, range))),
    listProjectTargets: (_owner, range) =>
      read('listProjectTargets', () =>
        fixture.projects.filter((row) => windowOverlaps(row, range)),
      ),
    getMilestoneChain: () => read('getMilestoneChain', () => null),
    listTemplates: (_owner, options) =>
      read('listTemplates', () =>
        fixture.templates.filter(
          (row) => options.includeArchived || row.document.state === 'active',
        ),
      ),
    getTemplate: (_owner, id) =>
      read('getTemplate', () => fixture.templates.find((row) => row.id === id) ?? null),
    listAxes: () => read('listAxes', () => [{ id: uuid(800), title: 'Health', localRevision: 1 }]),
    listProjects: () => read('listProjects', () => []),
    getAction: unused('getAction'),
    readRecord: unused('readRecord'),
    getActivePlacement: unused('getActivePlacement'),
    getPlannedActionBlock: unused('getPlannedActionBlock'),
    getPlannedCommitmentBlock: unused('getPlannedCommitmentBlock'),
    getTargetReminder: unused('getTargetReminder'),
  };
  return { port, calls };
}

function setup(fixture: Fixture) {
  const harness = createInMemoryHarness(ownerId, now);
  const { port, calls } = fakeQueries(fixture);
  return {
    harness,
    calls,
    projections: createPlanningProjections(harness.dependencies, port),
  };
}

const action = (
  suffix: number,
  title: string,
  state: ActionState,
  orderKey = `a${suffix}`,
): ActionSummary => ({ id: uuid(suffix), title, state, localRevision: 1, orderKey });

const block = (
  suffix: number,
  target: BlockRow['target'],
  startsAt: string,
  endsAt: string,
  options: Partial<Pick<BlockRow, 'state' | 'overlapAcknowledged'>> = {},
): BlockRow => ({
  id: uuid(suffix),
  localRevision: 1,
  startsAt: t(startsAt),
  endsAt: t(endsAt),
  timeZone: zone,
  state: options.state ?? 'planned',
  overlapAcknowledged: options.overlapAcknowledged ?? false,
  target,
});

const commitmentTarget = (suffix: number, title: string): BlockRow['target'] => ({
  kind: 'commitment',
  commitmentId: uuid(suffix),
  title,
  strength: 'hard',
  commitmentState: 'planned',
  commitmentRevision: 1,
});

const actionTarget = (suffix: number, title: string): BlockRow['target'] => ({
  kind: 'action',
  actionId: uuid(suffix),
  title,
  actionState: 'scheduled',
  actionRevision: 2,
});

const routine = (
  suffix: number,
  title: string,
  rule: Record<string, unknown>,
  schedulingMode: RoutineSchedulingMode,
): RoutineRow => ({
  id: uuid(suffix),
  localRevision: 1,
  document: {
    title,
    orderKey: `r${suffix}`,
    state: 'active',
    generations: [{ generation: 1, rule: rule as unknown as RecurrenceRuleV1, schedulingMode }],
  },
});

const timeSpecific = (wallTime: string, durationMinutes: number): RoutineSchedulingMode => ({
  kind: 'time_specific',
  wallTime: w(wallTime),
  durationMinutes,
  zonePolicy: { kind: 'follow_profile' },
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
});

const availability = (
  suffix: number,
  windows: { weekday: 'monday' | 'tuesday'; start: string; end: string }[],
  contextLabel?: string,
): ConstraintRow => ({
  id: uuid(suffix),
  localRevision: 1,
  document: {
    constraintKind: 'availability',
    strength: 'soft',
    state: 'active',
    value: {
      kind: 'availability',
      windows: windows.map((window) => ({ ...window, start: w(window.start), end: w(window.end) })),
    },
  },
  ...(contextLabel === undefined ? {} : { contextLabel }),
});

const cap = (
  suffix: number,
  period: 'day' | 'week',
  minutes: number,
  state: 'active' | 'archived' = 'active',
): ConstraintRow => ({
  id: uuid(suffix),
  localRevision: 1,
  document: {
    constraintKind: 'capacity',
    strength: 'soft',
    state,
    value: { kind: 'capacity', period, minutes },
  },
});

/** Week of Monday 2026-09-28 in New York (EDT, UTC-4). */
function weekFixture(): Fixture {
  const fixture = emptyFixture();
  fixture.blocks = [
    // Monday 09:00-10:00 commitment, 10:30-11:30 action, 11:00-12:00 custom (overlap).
    block(
      1,
      commitmentTarget(101, 'Dentist'),
      '2026-09-28T13:00:00.000Z',
      '2026-09-28T14:00:00.000Z',
    ),
    block(
      2,
      actionTarget(102, 'Draft report'),
      '2026-09-28T14:30:00.000Z',
      '2026-09-28T15:30:00.000Z',
      {
        overlapAcknowledged: true,
      },
    ),
    block(
      3,
      { kind: 'custom', title: 'Workshop' },
      '2026-09-28T15:00:00.000Z',
      '2026-09-28T16:00:00.000Z',
    ),
    // Tuesday 23:00 to Wednesday 01:00.
    block(
      4,
      { kind: 'custom', title: 'Night shift' },
      '2026-09-30T03:00:00.000Z',
      '2026-09-30T05:00:00.000Z',
    ),
  ];
  fixture.routines = [
    routine(
      10,
      'Stretch',
      { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-09-01' },
      timeSpecific('07:00', 30),
    ),
    routine(
      11,
      'Water plants',
      {
        version: 1,
        kind: 'weekly_days',
        intervalWeeks: 1,
        weekdays: ['wednesday'],
        startsOn: '2026-09-01',
      },
      { kind: 'day_flexible' },
    ),
    routine(
      12,
      'Run',
      {
        version: 1,
        kind: 'weekly_count',
        targetCount: 3,
        weekStart: 'monday',
        startsOn: '2026-09-07',
      },
      { kind: 'day_flexible' },
    ),
  ];
  const monday: HorizonPeriod = { kind: 'day', date: d('2026-09-28') };
  const week: HorizonPeriod = {
    kind: 'week',
    start: d('2026-09-28'),
    end: d('2026-10-04'),
    weekStart: 'monday',
  };
  fixture.placements = [
    {
      id: uuid(201),
      localRevision: 1,
      period: monday,
      orderKey: 'b',
      target: { kind: 'action', action: action(301, 'Call bank', 'planned') },
    },
    {
      id: uuid(202),
      localRevision: 1,
      period: monday,
      orderKey: 'a',
      target: { kind: 'action', action: action(302, 'Pay rent', 'completed') },
    },
    {
      id: uuid(203),
      localRevision: 1,
      period: monday,
      orderKey: 'c',
      target: { kind: 'action', action: action(102, 'Draft report', 'scheduled') },
    },
    {
      id: uuid(204),
      localRevision: 1,
      period: week,
      orderKey: 'a',
      target: { kind: 'action', action: action(303, 'Plan trip', 'planned') },
    },
    {
      id: uuid(205),
      localRevision: 1,
      period: week,
      orderKey: 'b',
      target: {
        kind: 'project',
        id: uuid(401),
        title: 'Garden',
        state: 'active',
        localRevision: 1,
      },
    },
  ];
  fixture.constraints = [
    availability(501, [
      { weekday: 'monday', start: '09:00', end: '12:00' },
      { weekday: 'monday', start: '11:00', end: '13:00' },
      { weekday: 'tuesday', start: '09:00', end: '17:00' },
    ]),
  ];
  fixture.backlog = [action(601, 'Sort photos', 'planned')];
  return fixture;
}

describe('week and day projections', () => {
  it('assembles the week with fixed commitments, conflicts, capacity, and routines', async () => {
    const { projections, harness } = setup(weekFixture());
    const plan = await projections.getWeekPlan('2026-09-30');

    expect(plan.today).toBe('2026-09-27');
    expect(plan.week).toEqual({
      kind: 'week',
      start: '2026-09-28',
      end: '2026-10-04',
      weekStart: 'monday',
    });
    expect(plan.days.map((day) => day.date)).toHaveLength(7);
    expect(plan.fixed.map((entry) => entry.title)).toEqual(['Dentist']);
    expect(plan.fixed[0]).toMatchObject({
      kind: 'commitment_block',
      localDate: '2026-09-28',
      localStart: '09:00',
      localEnd: '10:00',
      durationMinutes: 60,
    });

    // The overlap is listed once and is not kept: only one side acknowledged it.
    expect(plan.conflicts).toHaveLength(1);
    const [conflict] = plan.conflicts;
    expect(conflict).toMatchObject({
      firstKey: `block:${uuid(2)}`,
      secondKey: `block:${uuid(3)}`,
      overlapStartsAt: '2026-09-28T15:00:00.000Z',
      overlapEndsAt: '2026-09-28T15:30:00.000Z',
      kept: false,
    });
    expect(conflict?.first.title).toBe('Draft report');
    expect(conflict?.second.kind).toBe('custom_block');

    const monday = plan.days[0];
    expect(monday?.timed.map((entry) => entry.title)).toEqual([
      'Stretch',
      'Dentist',
      'Draft report',
      'Workshop',
    ]);
    expect(monday?.timed.find((entry) => entry.kind === 'action_block')?.conflictsWith).toEqual([
      `block:${uuid(3)}`,
    ]);
    expect(monday?.timed.find((entry) => entry.title === 'Stretch')).toMatchObject({
      kind: 'routine_occurrence',
      localStart: '07:00',
      conflictsWith: [],
      occurrence: { ref: { routineTitle: 'Stretch', materialized: false }, state: 'planned' },
    });
    // 60 + 60 + 60 block minutes plus the 30-minute time-specific occurrence.
    expect(monday?.capacity.plannedMinutes).toBe(210);
    expect(monday?.capacity.availability).toEqual({
      status: 'known',
      minutes: 240,
      basis: 'windows',
    });
    expect(monday?.availability).toEqual([{ start: '09:00', end: '13:00' }]);

    // Cross-midnight work appears on both local days and is clipped per day.
    const tuesday = plan.days[1];
    const wednesday = plan.days[2];
    expect(tuesday?.timed.map((entry) => entry.title)).toContain('Night shift');
    expect(wednesday?.timed.map((entry) => entry.title)).toContain('Night shift');
    expect(tuesday?.timed.find((entry) => entry.title === 'Night shift')).toMatchObject({
      localDate: '2026-09-29',
      localStart: '23:00',
      localEndDate: '2026-09-30',
      localEnd: '01:00',
      durationMinutes: 120,
    });
    expect(tuesday?.capacity.plannedMinutes).toBe(90);
    expect(wednesday?.capacity.plannedMinutes).toBe(90);

    // Wednesday has no windows and no cap: unknown, never free.
    expect(wednesday?.capacity.availability).toEqual({ status: 'unknown' });
    expect(wednesday?.availability).toEqual([]);
    expect(plan.capacity.availability).toEqual({
      status: 'partial',
      knownMinutes: 240 + 480,
      knownDays: 2,
      totalDays: 7,
    });
    expect(plan.capacity.plannedMinutes).toBe(210 + 90 + 90 + 4 * 30);

    expect(wednesday?.flexibleOccurrences.map((item) => item.ref.routineTitle)).toEqual([
      'Water plants',
    ]);
    expect(wednesday?.flexibleOccurrences[0]?.timing).toEqual({ kind: 'flexible' });
    expect(plan.weeklyCounts).toHaveLength(1);
    expect(plan.weeklyCounts[0]).toMatchObject({
      ref: { routineTitle: 'Run' },
      timing: { kind: 'weekly_count' },
      targetCount: 3,
      completedCount: 0,
    });

    // Scheduled Actions leave the flexible list; completed ones stay visible, in persisted order.
    expect(monday?.flexibleActions.map((item) => item.title)).toEqual(['Pay rent', 'Call bank']);
    expect(monday?.flexibleActions[0]?.placement).toEqual({
      id: uuid(202),
      localRevision: 1,
      period: { kind: 'day', date: '2026-09-28' },
    });
    expect(plan.weekActions.map((item) => item.title)).toEqual(['Plan trip']);
    expect(plan.weekObjects.map((row) => row.target.kind)).toEqual(['project']);
    expect(plan.backlog.total).toBe(1);
    expect(harness.unitOfWork.state.records.size).toBe(0);
    expect(harness.unitOfWork.state.events).toHaveLength(0);
  });

  it('keeps a conflict only when both items acknowledged the overlap', async () => {
    const fixture = weekFixture();
    fixture.blocks = fixture.blocks.map((row) =>
      row.id === uuid(3) ? { ...row, overlapAcknowledged: true } : row,
    );
    const { projections } = setup(fixture);
    const plan = await projections.getWeekPlan('2026-09-28');
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.kept).toBe(true);
  });

  it('ignores resolved blocks when listing conflicts but still counts completed work', async () => {
    const fixture = weekFixture();
    fixture.blocks = fixture.blocks.map((row) =>
      row.id === uuid(3) ? { ...row, state: 'completed' } : row,
    );
    const { projections } = setup(fixture);
    const plan = await projections.getDayPlan('2026-09-28');
    expect(plan.conflicts).toEqual([]);
    expect(plan.day.capacity.plannedMinutes).toBe(210);
    const skipped = weekFixture();
    skipped.blocks = skipped.blocks.map((row) =>
      row.id === uuid(3) ? { ...row, state: 'skipped' } : row,
    );
    const skippedPlan = await setup(skipped).projections.getDayPlan('2026-09-28');
    expect(skippedPlan.day.capacity.plannedMinutes).toBe(150);
  });

  it('builds a day plan with its week, conflicts for that day, weekly counts, and backlog', async () => {
    const { projections, calls } = setup(weekFixture());
    const plan = await projections.getDayPlan('2026-09-30');
    expect(plan.day.date).toBe('2026-09-30');
    expect(plan.day.weekday).toBe('wednesday');
    expect(plan.week.start).toBe('2026-09-28');
    expect(plan.conflicts).toEqual([]);
    expect(plan.day.timed.map((entry) => entry.title)).toEqual(['Night shift', 'Stretch']);
    expect(plan.day.flexibleOccurrences).toHaveLength(1);
    expect(plan.weeklyCounts).toHaveLength(1);
    expect(plan.backlog.items.map((item) => item.title)).toEqual(['Sort photos']);
    expect(calls).toContain('listBacklog');

    const monday = await projections.getDayPlan('2026-09-28');
    expect(monday.conflicts).toHaveLength(1);
  });

  it('reports known availability from a cap and unknown availability without rules', async () => {
    const capped = weekFixture();
    capped.constraints = [
      cap(700, 'week', 600),
      cap(701, 'week', 900),
      cap(702, 'day', 30, 'archived'),
    ];
    const cappedPlan = await setup(capped).projections.getWeekPlan('2026-09-28');
    expect(cappedPlan.capacity.availability).toEqual({
      status: 'known',
      minutes: 600,
      basis: 'cap',
    });
    expect(cappedPlan.days[0]?.capacity.availability).toEqual({ status: 'unknown' });

    const none = weekFixture();
    none.constraints = [];
    const nonePlan = await setup(none).projections.getWeekPlan('2026-09-28');
    expect(nonePlan.capacity.availability).toEqual({ status: 'unknown' });
    expect(nonePlan.capacity.overByMinutes).toBeUndefined();

    const tight = weekFixture();
    tight.constraints = [cap(703, 'day', 60)];
    const tightPlan = await setup(tight).projections.getDayPlan('2026-09-28');
    expect(tightPlan.day.capacity).toMatchObject({
      plannedMinutes: 210,
      availability: { status: 'known', minutes: 60, basis: 'cap' },
      overByMinutes: 150,
    });
  });

  it('shows a moved, completed time-specific occurrence on its new date', async () => {
    const fixture = weekFixture();
    const stretch = fixture.routines[0];
    if (stretch === undefined) throw new Error('fixture');
    fixture.materialized = [
      {
        id: uuid(950),
        routineId: stretch.id,
        generation: 1,
        logicalKey:
          `${stretch.id}:g1:date:2026-09-28:o0` as MaterializedOccurrenceSnapshot['logicalKey'],
        period: { kind: 'date', date: d('2026-09-28') },
        state: 'completed',
        localRevision: 3,
        override: { date: d('2026-09-29'), wallTime: w('18:00') },
      },
    ];
    const plan = await setup(fixture).projections.getWeekPlan('2026-09-28');
    const tuesdayStretch = plan.days[1]?.timed.filter((entry) => entry.title === 'Stretch');
    expect(tuesdayStretch?.map((entry) => [entry.localStart, entry.state])).toEqual([
      ['07:00', 'planned'],
      ['18:00', 'completed'],
    ]);
    expect(plan.days[0]?.timed.filter((entry) => entry.title === 'Stretch')).toHaveLength(0);
    expect(tuesdayStretch?.[1]?.occurrence).toMatchObject({
      moved: true,
      ref: { materialized: true, localRevision: 3 },
    });
  });

  it('rejects invalid dates and missing identity', async () => {
    const { projections } = setup(weekFixture());
    await expect(projections.getDayPlan('2026-02-30')).rejects.toBeInstanceOf(RangeError);
    await expect(projections.getWeekPlan('next week')).rejects.toBeInstanceOf(RangeError);
    await expect(projections.getMonthPlan('2026-13')).rejects.toBeInstanceOf(RangeError);
    await expect(projections.getYearPlan('26')).rejects.toBeInstanceOf(RangeError);

    const harness = createInMemoryHarness(ownerId, now);
    const projectionsWithoutIdentity = createPlanningProjections(
      {
        ...harness.dependencies,
        identityContext: { getActiveIdentity: () => Promise.resolve(null) },
      },
      fakeQueries(weekFixture()).port,
    );
    await expect(projectionsWithoutIdentity.getDayPlan('2026-09-28')).rejects.toThrow(
      'No active identity',
    );
  });
});

describe('month and year projections', () => {
  function monthFixture(): Fixture {
    const fixture = emptyFixture();
    fixture.blocks = [
      // Week of 2026-09-07: 2h + 1h30 + 9h = 12h30, two commitments; the skipped block is excluded.
      block(
        1,
        commitmentTarget(101, 'Review'),
        '2026-09-08T13:00:00.000Z',
        '2026-09-08T15:00:00.000Z',
      ),
      block(
        2,
        commitmentTarget(102, 'Class'),
        '2026-09-09T13:00:00.000Z',
        '2026-09-09T14:30:00.000Z',
        {
          state: 'completed',
        },
      ),
      block(
        3,
        { kind: 'custom', title: 'Errands' },
        '2026-09-10T13:00:00.000Z',
        '2026-09-10T15:00:00.000Z',
        {
          state: 'skipped',
        },
      ),
      block(
        4,
        actionTarget(103, 'Deep work'),
        '2026-09-11T13:00:00.000Z',
        '2026-09-11T22:00:00.000Z',
      ),
      // Week of 2026-09-14: one hour, one commitment.
      block(
        5,
        commitmentTarget(104, 'Checkup'),
        '2026-09-15T13:00:00.000Z',
        '2026-09-15T14:00:00.000Z',
      ),
      // Week of 2026-09-28 in the previous/next month overlap still counts for that full week.
      block(
        6,
        commitmentTarget(105, 'Trip'),
        '2026-10-02T13:00:00.000Z',
        '2026-10-02T13:45:00.000Z',
      ),
    ];
    const outcome = { outcomeId: uuid(400), outcomeTitle: 'Healthy routine' };
    fixture.milestones = [
      {
        id: uuid(401),
        title: 'Plan meals',
        measurableCheckpoint: 'Seven meals planned',
        state: 'active',
        localRevision: 1,
        ...outcome,
        placement: {
          id: uuid(451),
          period: {
            kind: 'week',
            start: d('2026-09-07'),
            end: d('2026-09-13'),
            weekStart: 'monday',
          },
        },
      },
      {
        id: uuid(402),
        title: 'First run',
        measurableCheckpoint: 'Run once',
        state: 'active',
        localRevision: 1,
        ...outcome,
        targetEnd: d('2026-09-12'),
      },
      {
        id: uuid(403),
        title: 'Month marker',
        measurableCheckpoint: 'Any',
        state: 'active',
        localRevision: 1,
        ...outcome,
        placement: { id: uuid(453), period: { kind: 'month', month: '2026-09' as never } },
      },
      {
        id: uuid(404),
        title: 'Checkup booked',
        measurableCheckpoint: 'Booked',
        state: 'active',
        localRevision: 1,
        ...outcome,
        targetEnd: d('2026-09-16'),
      },
    ];
    fixture.themes = [
      { id: uuid(801), localRevision: 1, month: '2026-09' as never, text: 'Settle in' },
    ];
    fixture.placements = [
      {
        id: uuid(501),
        localRevision: 1,
        period: { kind: 'month', month: '2026-09' as never },
        orderKey: 'a',
        target: { kind: 'action', action: action(601, 'Renew passport', 'planned') },
      },
      {
        id: uuid(502),
        localRevision: 1,
        period: { kind: 'month', month: '2026-09' as never },
        orderKey: 'b',
        target: { kind: 'action', action: action(602, 'Old idea', 'canceled') },
      },
      {
        id: uuid(503),
        localRevision: 1,
        period: { kind: 'day', date: d('2026-09-08') },
        orderKey: 'c',
        target: { kind: 'action', action: action(603, 'Day task', 'planned') },
      },
    ];
    return fixture;
  }

  it('reports neutral weekly density for every week touching the month', async () => {
    const { projections } = setup(monthFixture());
    const plan = await projections.getMonthPlan('2026-09');
    expect(plan.range).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(plan.theme?.text).toBe('Settle in');
    expect(plan.weeks.map((week) => week.week.start)).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
    expect(plan.weeks.map((week) => week.summary)).toEqual([
      '0 minutes planned, 0 commitments, 0 milestones',
      '12 hours 30 minutes planned, 2 commitments, 2 milestones',
      '1 hour planned, 1 commitment, 1 milestone',
      '0 minutes planned, 0 commitments, 0 milestones',
      '45 minutes planned, 1 commitment, 0 milestones',
    ]);
    expect(plan.weeks[1]).toMatchObject({
      plannedMinutes: 750,
      commitmentCount: 2,
      milestoneCount: 2,
    });
    expect(plan.commitments.map((entry) => entry.title)).toEqual(['Review', 'Class', 'Checkup']);
    expect(plan.milestones).toHaveLength(4);
    expect(plan.monthActions.map((item) => item.title)).toEqual(['Renew passport']);
  });

  it('formats density text with singular and plural forms', () => {
    expect(densitySummary(0, 0, 0)).toBe('0 minutes planned, 0 commitments, 0 milestones');
    expect(densitySummary(61, 1, 1)).toBe('1 hour 1 minute planned, 1 commitment, 1 milestone');
    expect(densitySummary(120, 3, 2)).toBe('2 hours planned, 3 commitments, 2 milestones');
  });

  it('lists year direction, outcomes, milestones, and ordered important dates without Actions', async () => {
    const fixture = monthFixture();
    fixture.outcomes = [
      {
        id: uuid(410),
        title: 'Run a 10k',
        successDefinition: 'Finish a 10k race',
        state: 'active',
        localRevision: 1,
        targetEnd: d('2026-06-30'),
        progress: { mode: 'none' },
      },
      {
        id: uuid(411),
        title: 'Done already',
        successDefinition: 'Done',
        state: 'achieved',
        localRevision: 1,
        targetEnd: d('2026-02-01'),
        progress: { mode: 'none' },
      },
      {
        id: uuid(412),
        title: 'Learn piano',
        successDefinition: 'Play one piece',
        state: 'paused',
        localRevision: 1,
        placement: { id: uuid(460), period: { kind: 'month', month: '2026-03' as never } },
        progress: { mode: 'none' },
      },
    ];
    fixture.milestones = [
      {
        id: uuid(420),
        title: 'Beta',
        measurableCheckpoint: 'Beta shipped',
        state: 'active',
        localRevision: 1,
        outcomeId: uuid(410),
        outcomeTitle: 'Run a 10k',
        targetEnd: d('2026-03-15'),
      },
    ];
    fixture.projects = [
      {
        id: uuid(430),
        title: 'Alpha',
        state: 'active',
        localRevision: 1,
        targetEnd: d('2026-03-15'),
      },
      {
        id: uuid(431),
        title: 'Next year',
        state: 'active',
        localRevision: 1,
        targetStart: d('2026-12-01'),
        targetEnd: d('2027-01-15'),
      },
    ];
    const { projections, calls } = setup(fixture);
    const plan = await projections.getYearPlan('2026');
    expect(plan.direction?.text).toBe('Steady foundations');
    expect(plan.outcomes.map((row) => row.title)).toEqual(['Run a 10k', 'Learn piano']);
    expect(plan.importantDates.map((item) => [item.date, item.kind, item.title])).toEqual([
      ['2026-03-15', 'project_target', 'Alpha'],
      ['2026-03-15', 'milestone_target', 'Beta'],
      ['2026-06-30', 'outcome_target', 'Run a 10k'],
    ]);
    expect(plan.months).toHaveLength(12);
    expect(plan.months[2]).toMatchObject({ month: '2026-03', milestoneCount: 1, outcomeCount: 1 });
    expect(plan.months[5]).toMatchObject({ month: '2026-06', milestoneCount: 0, outcomeCount: 1 });
    expect(plan.months[8]?.theme?.text).toBe('Settle in');
    expect(JSON.stringify(plan)).not.toContain('Renew passport');
    expect(calls).not.toContain('listPlacements');
    expect(calls).not.toContain('listBlocks');
    expect(calls).not.toContain('listBacklog');
  });
});

describe('local interval resolution', () => {
  it('reports a DST gap shift and a repeated wall time', async () => {
    const { projections } = setup(emptyFixture());
    const gap = await projections.resolveLocalInterval({
      date: '2026-03-08',
      startTime: '02:30',
      durationMinutes: 60,
    });
    expect(gap).toEqual({
      ok: true,
      value: {
        startsAt: '2026-03-08T07:30:00.000Z',
        endsAt: '2026-03-08T08:30:00.000Z',
        localStart: '03:30',
        localEnd: '04:30',
        localEndDate: '2026-03-08',
        utcOffset: '-04:00',
        adjustment: 'dst_gap_shifted',
        overlaps: [],
      },
    });
    const repeated = await projections.resolveLocalInterval({
      date: '2026-11-01',
      startTime: '01:30',
      durationMinutes: 60,
    });
    expect(repeated.ok && repeated.value).toMatchObject({
      startsAt: '2026-11-01T05:30:00.000Z',
      localStart: '01:30',
      localEnd: '01:30',
      utcOffset: '-04:00',
      adjustment: 'dst_repeated_earlier',
    });
  });

  it('lists planned overlaps by key and title, honoring exclusions and touching edges', async () => {
    const { projections } = setup(weekFixture());
    const overlapping = await projections.resolveLocalInterval({
      date: '2026-09-28',
      startTime: '09:30',
      durationMinutes: 90,
    });
    expect(overlapping.ok && overlapping.value.overlaps).toEqual([
      { key: `block:${uuid(1)}`, title: 'Dentist' },
      { key: `block:${uuid(2)}`, title: 'Draft report' },
    ]);
    const excluded = await projections.resolveLocalInterval(
      { date: '2026-09-28', startTime: '09:30', durationMinutes: 90 },
      [`block:${uuid(2)}`],
    );
    expect(excluded.ok && excluded.value.overlaps).toEqual([
      { key: `block:${uuid(1)}`, title: 'Dentist' },
    ]);
    const touching = await projections.resolveLocalInterval({
      date: '2026-09-28',
      startTime: '12:00',
      durationMinutes: 30,
    });
    expect(touching.ok && touching.value.overlaps).toEqual([]);
    const routineOverlap = await projections.resolveLocalInterval({
      date: '2026-09-30',
      startTime: '07:15',
      durationMinutes: 15,
    });
    expect(routineOverlap.ok && routineOverlap.value.overlaps.map((item) => item.title)).toEqual([
      'Stretch',
    ]);
  });

  it('rejects invalid local interval input', async () => {
    const { projections } = setup(emptyFixture());
    const cases: [Parameters<typeof projections.resolveLocalInterval>[0], string][] = [
      [{ date: '2026-02-30', startTime: '09:00', durationMinutes: 30 }, 'date'],
      [{ date: '2026-09-28', startTime: '9:00', durationMinutes: 30 }, 'start_time'],
      [{ date: '2026-09-28', startTime: '09:00:00', durationMinutes: 30 }, 'start_time'],
      [{ date: '2026-09-28', startTime: '24:00', durationMinutes: 30 }, 'start_time'],
      [{ date: '2026-09-28', startTime: '09:00', durationMinutes: 4 }, 'duration_minutes'],
      [{ date: '2026-09-28', startTime: '09:00', durationMinutes: 1441 }, 'duration_minutes'],
      [{ date: '2026-09-28', startTime: '09:00', durationMinutes: 30.5 }, 'duration_minutes'],
    ];
    for (const [input, reason] of cases) {
      const result = await projections.resolveLocalInterval(input);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'domain_rejected',
          domainError: { code: 'invalid_value', details: { reason } },
        },
      });
    }
  });
});

describe('routine projections', () => {
  const daily = (startsOn: string) => ({ version: 1, kind: 'daily', intervalDays: 1, startsOn });
  const mode = (
    wallTime: string,
    gapPolicy: 'shift_forward' | 'skip',
    overlapPolicy: 'earlier_offset' | 'later_offset',
  ) => ({
    kind: 'time_specific',
    wallTime,
    durationMinutes: 30,
    zonePolicy: { kind: 'follow_profile' },
    gapPolicy,
    overlapPolicy,
  });

  it('previews DST gap and repeated-time notes', async () => {
    const { projections } = setup(emptyFixture());
    const shifted = await projections.previewRoutine(
      {
        rule: daily('2027-03-13'),
        schedulingMode: mode('02:30', 'shift_forward', 'earlier_offset'),
      },
      3,
    );
    expect(
      shifted.ok && shifted.value.map((entry) => [entry.date, entry.localStart, entry.dstNote]),
    ).toEqual([
      ['2027-03-13', '02:30', undefined],
      ['2027-03-14', '03:30', 'gap_shifted'],
      ['2027-03-15', '02:30', undefined],
    ]);
    const skipped = await projections.previewRoutine(
      { rule: daily('2027-03-14'), schedulingMode: mode('02:30', 'skip', 'earlier_offset') },
      1,
    );
    expect(skipped.ok && skipped.value[0]).toEqual({
      date: '2027-03-14',
      period: { kind: 'date', date: '2027-03-14' },
      timing: { kind: 'dst_skipped', wallTime: '02:30' },
      dstNote: 'gap_skipped',
    });
    const earlier = await projections.previewRoutine(
      {
        rule: daily('2026-11-01'),
        schedulingMode: mode('01:30', 'shift_forward', 'earlier_offset'),
      },
      1,
    );
    expect(earlier.ok && earlier.value[0]).toMatchObject({
      localStart: '01:30',
      dstNote: 'repeated_earlier',
      timing: { kind: 'timed', startsAt: '2026-11-01T05:30:00.000Z' },
    });
    const later = await projections.previewRoutine(
      { rule: daily('2026-11-01'), schedulingMode: mode('01:30', 'shift_forward', 'later_offset') },
      1,
    );
    expect(later.ok && later.value[0]).toMatchObject({
      localStart: '01:30',
      dstNote: 'repeated_later',
      timing: { kind: 'timed', startsAt: '2026-11-01T06:30:00.000Z' },
    });
  });

  it('previews from today for past start dates and returns the requested count', async () => {
    const { projections } = setup(emptyFixture());
    const result = await projections.previewRoutine({
      rule: {
        version: 1,
        kind: 'weekly_count',
        targetCount: 2,
        weekStart: 'monday',
        startsOn: '2026-01-05',
      },
      schedulingMode: { kind: 'day_flexible' },
    });
    expect(result.ok && result.value).toHaveLength(10);
    expect(result.ok && result.value[0]?.period).toEqual({
      kind: 'week',
      start: '2026-09-21',
      end: '2026-09-27',
      weekStart: 'monday',
      targetCount: 2,
    });
    const dailyFlexible = await projections.previewRoutine(
      { rule: daily('2020-01-01'), schedulingMode: { kind: 'day_flexible' } },
      2,
    );
    expect(dailyFlexible.ok && dailyFlexible.value.map((entry) => entry.date)).toEqual([
      '2026-09-27',
      '2026-09-28',
    ]);
  });

  it('rejects invalid routine previews', async () => {
    const { projections } = setup(emptyFixture());
    const badRule = await projections.previewRoutine({
      rule: { version: 1, kind: 'hourly' },
      schedulingMode: { kind: 'day_flexible' },
    });
    expect(badRule).toMatchObject({ ok: false, error: { code: 'domain_rejected' } });
    const badMode = await projections.previewRoutine({
      rule: daily('2026-10-01'),
      schedulingMode: { kind: 'time_specific', wallTime: '25:00' },
    });
    expect(badMode).toMatchObject({ ok: false, error: { code: 'domain_rejected' } });
    const badCount = await projections.previewRoutine(
      { rule: daily('2026-10-01'), schedulingMode: { kind: 'day_flexible' } },
      0,
    );
    expect(badCount).toMatchObject({
      ok: false,
      error: { code: 'domain_rejected', domainError: { details: { reason: 'count' } } },
    });
  });

  it('lists routines with their current generation and shows upcoming and history', async () => {
    const fixture = weekFixture();
    const stretch = fixture.routines[0];
    if (stretch === undefined) throw new Error('fixture');
    fixture.materialized = [
      {
        id: uuid(960),
        routineId: stretch.id,
        generation: 1,
        logicalKey:
          `${stretch.id}:g1:date:2026-09-20:o0` as MaterializedOccurrenceSnapshot['logicalKey'],
        period: { kind: 'date', date: d('2026-09-20') },
        state: 'completed',
        localRevision: 2,
        completedAt: t('2026-09-20T12:00:00.000Z'),
      },
    ];
    const { projections } = setup(fixture);
    const routines = await projections.listRoutines();
    expect(routines.map((item) => [item.title, item.current.generation])).toEqual([
      ['Stretch', 1],
      ['Water plants', 1],
      ['Run', 1],
    ]);
    const detail = await projections.getRoutine(stretch.id);
    expect(detail?.upcoming).toHaveLength(28);
    expect(detail?.upcoming[0]).toMatchObject({ date: '2026-09-27', state: 'planned' });
    expect(detail?.history).toEqual([
      {
        ref: {
          routineId: stretch.id,
          routineTitle: 'Stretch',
          occurrenceId: uuid(960),
          logicalKey: `${stretch.id}:g1:date:2026-09-20:o0`,
          generation: 1,
          period: { kind: 'date', date: '2026-09-20' },
          materialized: true,
          localRevision: 2,
        },
        state: 'completed',
        date: '2026-09-20',
        moved: false,
        timing: {
          kind: 'timed',
          startsAt: '2026-09-20T11:00:00.000Z',
          endsAt: '2026-09-20T11:30:00.000Z',
        },
      },
    ]);
    expect(await projections.getRoutine('not-a-uuid')).toBeNull();
    expect(await projections.getRoutine(uuid(12345))).toBeNull();
  });
});

describe('template projections', () => {
  const userBlueprint: TemplateBlueprint = {
    version: 2,
    items: [
      { templateKey: 'goal', kind: 'outcome', title: 'Launch', note: 'Launched' },
      {
        templateKey: 'beta',
        kind: 'milestone',
        title: 'Beta',
        parentTemplateKey: 'goal',
        note: 'Beta shipped',
        relativeDayOffset: 3,
      },
      {
        templateKey: 'kickoff',
        kind: 'action',
        title: 'Kickoff',
        relativeDayOffset: 0,
        localStartTime: w('09:00'),
        durationMinutes: 30,
      },
    ],
  };

  function templateFixture(): Fixture {
    const fixture = emptyFixture();
    fixture.templates = [
      {
        id: uuid(710),
        localRevision: 2,
        document: { title: 'My launch', blueprint: userBlueprint, state: 'active' },
      },
      {
        id: uuid(711),
        localRevision: 4,
        document: {
          title: 'Old plan',
          blueprint: userBlueprint,
          state: 'archived',
          stateBeforeArchive: 'active',
        },
      },
    ];
    return fixture;
  }

  it('lists the five built-ins first, then user templates', async () => {
    const { projections } = setup(templateFixture());
    const active = await projections.listTemplates();
    expect(builtInTemplates).toHaveLength(5);
    expect(
      active.slice(0, 5).map((item) => [item.source, item.catalogVersion, item.state]),
    ).toEqual(builtInTemplates.map(() => ['built_in', 1, 'active']));
    expect(active.slice(0, 5).map((item) => item.id)).toEqual(
      builtInTemplates.map((item) => item.id),
    );
    expect(active.slice(5)).toEqual([
      {
        id: uuid(710),
        source: 'user',
        title: 'My launch',
        itemCount: 3,
        blueprintVersion: 2,
        state: 'active',
        localRevision: 2,
      },
    ]);
    const all = await projections.listTemplates({ includeArchived: true });
    expect(all.slice(5).map((item) => [item.title, item.state])).toEqual([
      ['My launch', 'active'],
      ['Old plan', 'archived'],
    ]);
  });

  it('returns template details for built-in and user templates', async () => {
    const { projections } = setup(templateFixture());
    const builtIn = builtInTemplates[0];
    if (builtIn === undefined) throw new Error('catalog');
    expect(await projections.getTemplate(builtIn.id)).toMatchObject({
      source: 'built_in',
      title: builtIn.title,
      blueprint: builtIn.blueprint,
    });
    expect(await projections.getTemplate(uuid(710))).toMatchObject({
      source: 'user',
      blueprint: userBlueprint,
    });
    expect(await projections.getTemplate(uuid(799))).toBeNull();
    expect(await projections.getTemplate('nope')).toBeNull();
  });

  it('previews selection issues and resolved schedules without writing', async () => {
    const { projections, harness } = setup(templateFixture());
    const all = await projections.previewTemplate({
      templateId: uuid(710),
      anchorDate: '2026-10-05',
      timeZone: 'America/New_York',
    });
    expect(all.ok && all.value.issues).toEqual([]);
    expect(
      all.ok && all.value.items.find((item) => item.templateKey === 'kickoff')?.schedule,
    ).toMatchObject({
      kind: 'timed',
      startsAt: '2026-10-05T13:00:00.000Z',
    });
    const deselected = await projections.previewTemplate({
      templateId: uuid(710),
      anchorDate: '2026-10-05',
      timeZone: 'America/New_York',
      selectedKeys: ['beta', 'kickoff'],
    });
    expect(deselected.ok && deselected.value.issues).toEqual([
      { code: 'parent_deselected', templateKey: 'beta', parentTemplateKey: 'goal' },
    ]);
    const none = await projections.previewTemplate({
      templateId: uuid(710),
      anchorDate: '2026-10-05',
      timeZone: 'America/New_York',
      selectedKeys: [],
    });
    expect(none.ok && none.value.issues[0]).toEqual({ code: 'nothing_selected' });
    const builtIn = builtInTemplates[0];
    if (builtIn === undefined) throw new Error('catalog');
    const builtInPreview = await projections.previewTemplate({
      templateId: builtIn.id,
      anchorDate: '2026-10-05',
      timeZone: 'Europe/Berlin',
    });
    expect(builtInPreview.ok && builtInPreview.value.selectedCount).toBe(
      builtIn.blueprint.items.length,
    );
    expect(harness.unitOfWork.state.records.size).toBe(0);
  });

  it('rejects invalid template previews', async () => {
    const fixture = templateFixture();
    fixture.templates.push({
      id: uuid(712),
      localRevision: 1,
      document: {
        title: 'Broken',
        blueprint: { version: 3, items: [] } as unknown as TemplateBlueprint,
        state: 'active',
      },
    });
    const { projections } = setup(fixture);
    const request = { anchorDate: '2026-10-05', timeZone: 'America/New_York' };
    expect(
      await projections.previewTemplate({
        ...request,
        templateId: uuid(710),
        anchorDate: '2026-02-30',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'domain_rejected', domainError: { code: 'invalid_time' } },
    });
    expect(
      await projections.previewTemplate({ ...request, templateId: uuid(710), timeZone: '+02:00' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'domain_rejected', domainError: { code: 'invalid_time_zone' } },
    });
    expect(await projections.previewTemplate({ ...request, templateId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'domain_rejected', domainError: { details: { reason: 'template_id' } } },
    });
    expect(await projections.previewTemplate({ ...request, templateId: uuid(799) })).toMatchObject({
      ok: false,
      error: { code: 'entity_not_found' },
    });
    expect(await projections.previewTemplate({ ...request, templateId: uuid(712) })).toMatchObject({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: { details: { reason: 'unsupported_version' } },
      },
    });
  });
});

describe('capacity settings and choices', () => {
  it('lists availability, the lowest active caps, and derived rules', async () => {
    const fixture = emptyFixture();
    fixture.constraints = [
      availability(501, [{ weekday: 'monday', start: '09:00', end: '12:00' }], 'Work'),
      cap(502, 'day', 300),
      cap(503, 'day', 240),
      cap(504, 'day', 60, 'archived'),
      cap(505, 'week', 1200),
    ];
    const { projections } = setup(fixture);
    const settings = await projections.getCapacitySettings();
    expect(settings.availability).toEqual([
      {
        id: uuid(501),
        localRevision: 1,
        strength: 'soft',
        windows: [{ weekday: 'monday', start: '09:00', end: '12:00' }],
        label: 'Work',
      },
    ]);
    expect(settings.dayCap).toEqual({ id: uuid(503), localRevision: 1, minutes: 240 });
    expect(settings.weekCap).toEqual({ id: uuid(505), localRevision: 1, minutes: 1200 });
    expect(settings.rules.caps).toEqual([
      { period: 'day', minutes: 300 },
      { period: 'day', minutes: 240 },
      { period: 'week', minutes: 1200 },
    ]);
    expect(settings.rules.windows).toHaveLength(1);

    const empty = await setup(emptyFixture()).projections.getCapacitySettings();
    expect(empty.dayCap).toBeUndefined();
    expect(empty.weekCap).toBeUndefined();
    expect(empty.availability).toEqual([]);
  });

  it('passes Axis and Project choices through and returns null for invalid chain ids', async () => {
    const { projections } = setup(emptyFixture());
    expect(await projections.listAxes()).toEqual([
      { id: uuid(800), title: 'Health', localRevision: 1 },
    ]);
    expect(await projections.listProjects()).toEqual([]);
    expect(await projections.getMilestoneChain('bad')).toBeNull();
    expect(await projections.getMilestoneChain(uuid(401))).toBeNull();
  });
});

describe('availability windows in the read model', () => {
  it('reports an end of day as 00:00, never as the invalid wall time 24:00', () => {
    expect(
      availabilityFor('2026-09-28' as CalendarDate, {
        windows: [
          { weekday: 'monday', start: '09:00' as WallTime, end: '12:00' as WallTime },
          { weekday: 'monday', start: '18:00' as WallTime, end: '00:00' as WallTime },
        ],
        caps: [],
      }),
    ).toEqual([
      { start: '09:00', end: '12:00' },
      { start: '18:00', end: '00:00' },
    ]);
  });
});
