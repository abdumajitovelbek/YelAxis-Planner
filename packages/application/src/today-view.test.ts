import {
  entityRefKey,
  localDayBounds,
  type CalendarDate,
  type CommandId,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type RecurrenceRuleV1,
  type RoutineSchedulingMode,
  type UUID,
  type WallTime,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import { createPlanningApplication } from './planning';
import type { PlanProfile, PlanningPlacementDocument } from './planning-contracts';
import { createTestPlanningQueries } from './planning-routines-test-queries';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';
import {
  createTodaySeeder,
  createTodayTestQueries,
  type TodaySeeder,
  type TodayTestQueries,
} from './testing/today-test-queries';
import type { TodayQueryPort, TodayViewMethods } from './today-contracts';
import { createTodayKit } from './today-kit';
import { createTodayView, flexibleReorderEventType } from './today-view';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const zone = 'America/New_York' as IanaTimeZone;
// Monday 2026-09-28, 09:00 in New York.
const now = '2026-09-28T13:00:00.000Z' as Instant;
const d = (value: string) => value as CalendarDate;
const day = d('2026-09-28');
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: zone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
const onDay = (date = '2026-09-28') => ({ kind: 'day' as const, date: d(date) });
const daily: RecurrenceRuleV1 = {
  version: 1,
  kind: 'daily',
  intervalDays: 1,
  startsOn: d('2026-09-01'),
};
const weeklyCount: RecurrenceRuleV1 = {
  version: 1,
  kind: 'weekly_count',
  targetCount: 3,
  weekStart: 'monday',
  startsOn: d('2026-09-01'),
};
const morning: RoutineSchedulingMode = {
  kind: 'time_specific',
  wallTime: '07:00' as WallTime,
  durationMinutes: 30,
  zonePolicy: { kind: 'follow_profile' },
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
};

let harness: InMemoryHarness;
let queries: TodayTestQueries;
let view: TodayViewMethods;
let seed: TodaySeeder;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  queries = createTodayTestQueries(harness.unitOfWork, profile);
  view = createTodayView(createTodayKit(harness.dependencies, queries));
  seed = createTodaySeeder(harness.unitOfWork, ownerId, profile);
});

const accepted = (result: ApplicationResult<CommandReceipt>): CommandReceipt => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const rejection = (result: ApplicationResult<CommandReceipt>): unknown => {
  if (result.ok) throw new Error('Expected a rejection.');
  if (result.error.code !== 'domain_rejected') return result.error.code;
  return result.error.domainError.details?.['reason'] ?? result.error.domainError.code;
};

const current = (record: CanonicalRecordState) => harness.unitOfWork.get(entityRefKey(record.ref));
const orderKeyOf = (record: CanonicalRecordState): string =>
  (current(record)?.document as PlanningPlacementDocument).orderKey;

const undo = (receipt: CommandReceipt) => {
  if (!receipt.undo.available) throw new Error('No undo.');
  return createPlanningApplication(
    harness.dependencies,
    createTestPlanningQueries(harness.unitOfWork, profile),
  ).undo(receipt.undo.undoId);
};

/** Flexible, timed, finished, hidden, and Routine items on the day under test. */
function seedDay() {
  const open = seed.action({ title: 'Open flexible' });
  const openPlacement = seed.placement(open.ref.id, onDay());
  const started = seed.action({ title: 'Started flexible', state: 'in_progress' });
  seed.placement(started.ref.id, onDay());
  const done = seed.action({ title: 'Done flexible', state: 'completed' });
  seed.placement(done.ref.id, onDay());
  const scheduled = seed.action({ title: 'Scheduled', state: 'scheduled' });
  seed.placement(scheduled.ref.id, onDay());
  seed.block(
    { kind: 'action', actionId: scheduled.ref.id },
    '2026-09-28T18:00:00.000Z',
    '2026-09-28T19:00:00.000Z',
  );
  const timedDone = seed.action({ title: 'Done with block', state: 'completed' });
  seed.placement(timedDone.ref.id, onDay());
  seed.block(
    { kind: 'action', actionId: timedDone.ref.id },
    '2026-09-28T15:00:00.000Z',
    '2026-09-28T16:00:00.000Z',
    { state: 'completed' },
  );
  const canceled = seed.action({ title: 'Canceled', state: 'canceled' });
  seed.placement(canceled.ref.id, onDay());
  const archived = seed.action({ title: 'Archived', state: 'archived' });
  seed.placement(archived.ref.id, onDay());
  const tomorrow = seed.action({ title: 'Tomorrow' });
  seed.placement(tomorrow.ref.id, onDay('2026-09-29'));
  const walk = seed.routine(daily, { title: 'Walk' });
  const stretch = seed.routine(daily, { title: 'Stretch', schedulingMode: morning });
  const gym = seed.routine(weeklyCount, { title: 'Gym' });
  return { open, openPlacement, started, done, scheduled, walk, stretch, gym };
}

describe('getToday', () => {
  it('throws for an invalid date, like the Plan day view', async () => {
    for (const value of ['2026-02-30', '', 'today'])
      await expect(view.getToday(value)).rejects.toThrow(new RangeError('Choose a valid date.'));
    expect(queries.calls).toEqual([]);
  });

  it('lists open and done flexible Actions apart from timed, canceled, and archived ones', async () => {
    const items = seedDay();
    const today = await view.getToday('2026-09-28');
    expect(today.flexible.open.map((action) => action.title)).toEqual([
      'Open flexible',
      'Started flexible',
    ]);
    expect(today.flexible.done.map((action) => action.title)).toEqual(['Done flexible']);
    // Each flexible Action carries the placement a reorder names.
    expect(today.flexible.open[0]?.placement).toMatchObject({
      id: items.openPlacement.ref.id,
      localRevision: 1,
      period: onDay(),
    });
    expect(today.timeline.entries.map((entry) => entry.title)).toEqual([
      'Stretch',
      'Done with block',
      'Scheduled',
    ]);
    const listed = [
      ...today.flexible.open,
      ...today.flexible.done,
      ...today.timeline.entries.map((entry) => ({ title: entry.title })),
    ].map((item) => item.title);
    for (const hidden of ['Canceled', 'Archived', 'Tomorrow']) expect(listed).not.toContain(hidden);
    // A timed Action is never listed twice.
    expect(listed.filter((title) => title === 'Done with block')).toHaveLength(1);
  });

  it('lists untimed occurrences as the day’s Routines and weekly counts for its week', async () => {
    const items = seedDay();
    const today = await view.getToday('2026-09-28');
    expect(today.routines.day.map((entry) => entry.ref.routineTitle)).toEqual(['Walk']);
    expect(today.routines.day.every((entry) => entry.timing.kind !== 'timed')).toBe(true);
    expect(today.routines.week.map((entry) => entry.ref.routineId)).toEqual([items.gym.ref.id]);
    expect(
      today.timeline.entries.filter((entry) => entry.occurrence !== undefined).map((e) => e.title),
    ).toEqual(['Stretch']);
  });

  it('describes the date from the planning today of the injected clock', async () => {
    const past = await view.getToday('2026-09-27');
    expect(past).toMatchObject({
      date: '2026-09-27',
      today: '2026-09-28',
      relation: 'past',
      focusEditable: false,
      endDayAvailable: true,
      week: { start: '2026-09-21', end: '2026-09-27', weekStart: 'monday' },
      profile,
    });
    expect(await view.getToday('2026-09-28')).toMatchObject({
      relation: 'today',
      focusEditable: true,
      endDayAvailable: true,
      week: { start: '2026-09-28', end: '2026-10-04' },
    });
    expect(await view.getToday('2026-09-29')).toMatchObject({
      relation: 'future',
      focusEditable: true,
      endDayAvailable: false,
    });
    // 23:30 on Monday in New York is already Tuesday in UTC: the Profile zone decides.
    harness.setNow('2026-09-29T03:30:00.000Z' as Instant);
    expect(await view.getToday('2026-09-28')).toMatchObject({ today: '2026-09-28' });
  });

  it('shows focus in the person’s order with each item’s timing, including stale ones', async () => {
    const items = seedDay();
    const archivedRoutine = seed.routine(daily, { title: 'Old routine', state: 'archived' });
    const occurrence = seed.occurrence(archivedRoutine.ref.id, { kind: 'date', date: day });
    seed.focus({ kind: 'action', actionId: items.scheduled.ref.id }, '2026-09-28');
    seed.focus({ kind: 'action', actionId: items.open.ref.id }, '2026-09-28');
    seed.focus(
      { kind: 'routine_occurrence', routineOccurrenceId: occurrence.ref.id },
      '2026-09-28',
    );
    const today = await view.getToday('2026-09-28');
    expect(
      today.focus.map((item) =>
        item.kind === 'action'
          ? [item.position, item.action.title, item.timing.kind]
          : [item.position, item.routineTitle, item.occurrence],
      ),
    ).toEqual([
      [1, 'Scheduled', 'scheduled'],
      [2, 'Open flexible', 'flexible'],
      [3, 'Old routine', null],
    ]);
  });

  it('reports the day’s overlaps, capacity, and availability', async () => {
    const first = seed.action({ title: 'First', state: 'scheduled' });
    const second = seed.action({ title: 'Second', state: 'scheduled' });
    seed.block(
      { kind: 'action', actionId: first.ref.id },
      '2026-09-28T14:00:00.000Z',
      '2026-09-28T15:00:00.000Z',
    );
    seed.block(
      { kind: 'action', actionId: second.ref.id },
      '2026-09-28T14:30:00.000Z',
      '2026-09-28T15:30:00.000Z',
    );
    const today = await view.getToday('2026-09-28');
    expect(today.timeline.conflicts).toHaveLength(1);
    expect(today.timeline.capacity).toMatchObject({
      date: '2026-09-28',
      plannedMinutes: 120,
      availability: { status: 'unknown' },
    });
    expect(today.timeline.availability).toEqual([]);
  });

  it('reads only the day through bounded statements and writes nothing', async () => {
    seedDay();
    await view.getToday('2026-09-28');
    const bounds = localDayBounds(day, zone);
    const allowed: readonly (keyof TodayQueryPort)[] = [
      'getPlanProfile',
      'listDayBlocks',
      'listDayActionPlacements',
      'listRoutines',
      'listMaterializedOccurrences',
      'listCapacityConstraints',
      'listDayFocus',
    ];
    expect(new Set(queries.calls.map((call) => call.method))).toEqual(new Set(allowed));
    expect(queries.calls.find((call) => call.method === 'listDayBlocks')?.args).toEqual([
      ownerId,
      { startsAt: bounds.startsAt, endsAt: bounds.endsAt },
    ]);
    expect(queries.calls.find((call) => call.method === 'listDayActionPlacements')?.args).toEqual([
      ownerId,
      day,
    ]);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('shows an intentionally empty day as empty lists', async () => {
    const today = await view.getToday('2026-09-30');
    expect(today).toMatchObject({
      focus: [],
      flexible: { open: [], done: [] },
      routines: { day: [], week: [] },
      timeline: { entries: [], conflicts: [] },
    });
  });
});

describe('reorderFlexible', () => {
  /** Three open flexible Actions around hidden rows that share the day's placement container. */
  function seedList() {
    const first = seed.action({ title: 'First' });
    const firstPlacement = seed.placement(first.ref.id, onDay(), { orderKey: '000000001000000' });
    const scheduled = seed.action({ title: 'Scheduled', state: 'scheduled' });
    const scheduledPlacement = seed.placement(scheduled.ref.id, onDay(), {
      orderKey: '000000002000000',
    });
    seed.block(
      { kind: 'action', actionId: scheduled.ref.id },
      '2026-09-28T18:00:00.000Z',
      '2026-09-28T19:00:00.000Z',
    );
    const second = seed.action({ title: 'Second', state: 'in_progress' });
    const secondPlacement = seed.placement(second.ref.id, onDay(), {
      orderKey: '000000003000000',
    });
    const done = seed.action({ title: 'Done', state: 'completed' });
    const donePlacement = seed.placement(done.ref.id, onDay(), { orderKey: '000000004000000' });
    const third = seed.action({ title: 'Third' });
    const thirdPlacement = seed.placement(third.ref.id, onDay(), { orderKey: '000000005000000' });
    return { firstPlacement, scheduledPlacement, secondPlacement, donePlacement, thirdPlacement };
  }

  const move = (
    placement: CanonicalRecordState,
    direction: 'up' | 'down',
    options: {
      readonly revision?: number;
      readonly date?: string;
      readonly commandId?: string;
    } = {},
  ) =>
    view.reorderFlexible(
      {
        date: options.date ?? '2026-09-28',
        placementId: placement.ref.id,
        revision: options.revision ?? placement.localRevision,
        direction,
      },
      options.commandId as CommandId | undefined,
    );

  const openTitles = async () =>
    (await view.getToday('2026-09-28')).flexible.open.map((action) => action.title);

  it('swaps a row with its open neighbor and leaves hidden rows where they are', async () => {
    const rows = seedList();
    const receipt = accepted(await move(rows.secondPlacement, 'up'));
    expect(await openTitles()).toEqual(['Second', 'First', 'Third']);
    expect(orderKeyOf(rows.secondPlacement)).toBe('000000001000000');
    expect(orderKeyOf(rows.firstPlacement)).toBe('000000003000000');
    expect(orderKeyOf(rows.scheduledPlacement)).toBe('000000002000000');
    expect(orderKeyOf(rows.donePlacement)).toBe('000000004000000');
    expect(receipt.canonical.map(({ ref }) => ref.id).sort()).toEqual(
      [rows.firstPlacement.ref.id, rows.secondPlacement.ref.id].sort(),
    );
    expect(
      harness.unitOfWork.state.events.map(({ event }) => [event.eventType, event.payload]),
    ).toEqual([
      [flexibleReorderEventType, { operation: 'update' }],
      [flexibleReorderEventType, { operation: 'update' }],
    ]);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Second');
  });

  it('moves down, and one undo restores both keys', async () => {
    const rows = seedList();
    const receipt = accepted(await move(rows.firstPlacement, 'down'));
    expect(await openTitles()).toEqual(['Second', 'First', 'Third']);
    accepted(await undo(receipt));
    expect(await openTitles()).toEqual(['First', 'Second', 'Third']);
    expect(orderKeyOf(rows.firstPlacement)).toBe('000000001000000');
    expect(orderKeyOf(rows.secondPlacement)).toBe('000000003000000');
  });

  it('keeps non-spaced keys near their rows (in place) when it must normalize', async () => {
    const onboarding = seed.action({ title: 'Onboarding' });
    const onboardingPlacement = seed.placement(onboarding.ref.id, onDay(), {
      orderKey: 'onboarding-01',
    });
    const later = seed.action({ title: 'Later' });
    const laterPlacement = seed.placement(later.ref.id, onDay(), { orderKey: '000000007000000' });
    // Numeric keys sort before `onboarding-01`: Later is first.
    expect(await openTitles()).toEqual(['Later', 'Onboarding']);
    accepted(await move(onboardingPlacement, 'up'));
    expect(await openTitles()).toEqual(['Onboarding', 'Later']);
    expect(orderKeyOf(onboardingPlacement)).toBe('000000007000000');
    expect(orderKeyOf(laterPlacement)).toBe('000000007000001');
  });

  it('refuses rows that are not in the open flexible list, without writing', async () => {
    const rows = seedList();
    const other = seed.action({ title: 'Other day' });
    const otherPlacement = seed.placement(other.ref.id, onDay('2026-09-29'));
    for (const placement of [rows.scheduledPlacement, rows.donePlacement, otherPlacement])
      expect(rejection(await move(placement, 'up'))).toBe('not_in_list');
    expect(
      rejection(
        await view.reorderFlexible({
          date: '2026-09-28',
          placementId: '10000000-0000-4000-8000-00000000ffff',
          revision: 1,
          direction: 'up',
        }),
      ),
    ).toBe('not_in_list');
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('refuses a move past either end of the list', async () => {
    const rows = seedList();
    expect(rejection(await move(rows.firstPlacement, 'up'))).toBe('order_edge');
    expect(rejection(await move(rows.thirdPlacement, 'down'))).toBe('order_edge');
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('refuses a stale revision as a conflict and changes nothing', async () => {
    const rows = seedList();
    expect(rejection(await move(rows.secondPlacement, 'up', { revision: 2 }))).toBe(
      'revision_conflict',
    );
    expect(orderKeyOf(rows.secondPlacement)).toBe('000000003000000');
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('validates its input before reading anything', async () => {
    const rows = seedList();
    const valid = {
      date: '2026-09-28',
      placementId: rows.secondPlacement.ref.id,
      revision: 1,
      direction: 'up' as const,
    };
    const invalidInputs = [
      { ...valid, date: '2026-02-30' },
      { ...valid, placementId: 'not-an-id' },
      { ...valid, direction: 'left' as unknown as 'up' },
      { ...valid, revision: 0 },
      { ...valid, revision: 1.5 },
    ];
    for (const input of invalidInputs) {
      const result = await view.reorderFlexible(input);
      expect(result.ok ? '' : result.error.code).toBe('domain_rejected');
    }
    expect(queries.calls).toEqual([]);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('returns the original receipt for a retry with the same command id', async () => {
    const rows = seedList();
    const commandId = '10000000-0000-4000-8000-00000000c0de';
    const first = accepted(await move(rows.thirdPlacement, 'up', { commandId }));
    const events = harness.unitOfWork.state.events.length;
    const retry = accepted(await move(rows.thirdPlacement, 'up', { commandId, revision: 2 }));
    expect(retry).toEqual(first);
    expect(harness.unitOfWork.state.events).toHaveLength(events);
    expect(await openTitles()).toEqual(['First', 'Third', 'Second']);
  });
});
