import {
  createWeekPeriod,
  focusTargetKey,
  localDayBounds,
  occurrenceLogicalKey,
  routineOccurrenceId,
  type CalendarDate,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type RecurrenceRuleV1,
  type RoutineSchedulingMode,
  type UUID,
  type WallTime,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PlanProfile } from './planning-contracts';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';
import {
  createTodaySeeder,
  createTodayTestQueries,
  type TodaySeeder,
  type TodayTestQueries,
} from './testing/today-test-queries';
import type { TodayQueryPort } from './today-contracts';
import { focusWeekCandidateLimit, loadDay, loadFocusChoices } from './today-day';
import { createTodayKit, type TodayKit } from './today-kit';

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

const daily = (startsOn: string, endsOn?: string): RecurrenceRuleV1 => ({
  version: 1,
  kind: 'daily',
  intervalDays: 1,
  startsOn: d(startsOn),
  ...(endsOn === undefined ? {} : { endsOn: d(endsOn) }),
});
const weeklyCount = (startsOn: string, targetCount = 3): RecurrenceRuleV1 => ({
  version: 1,
  kind: 'weekly_count',
  targetCount,
  weekStart: 'monday',
  startsOn: d(startsOn),
});
const morning: RoutineSchedulingMode = {
  kind: 'time_specific',
  wallTime: '07:00' as WallTime,
  durationMinutes: 30,
  zonePolicy: { kind: 'follow_profile' },
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
};
const dated = (date: string) => ({ kind: 'date' as const, date: d(date) });
const onDay = (date = '2026-09-28') => ({ kind: 'day' as const, date: d(date) });

let harness: InMemoryHarness;
let queries: TodayTestQueries;
let kit: TodayKit;
let seed: TodaySeeder;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  queries = createTodayTestQueries(harness.unitOfWork, profile);
  kit = createTodayKit(harness.dependencies, queries);
  seed = createTodaySeeder(harness.unitOfWork, ownerId, profile);
});

const load = async (date = day) => loadDay(kit, await kit.session(), date);

/** A small but complete day: flexible, timed, finished, hidden, and Routine items. */
function seedDay() {
  const open = seed.action({ title: 'Open flexible' });
  seed.placement(open.ref.id, onDay());
  const started = seed.action({ title: 'Started flexible', state: 'in_progress' });
  seed.placement(started.ref.id, onDay());
  const done = seed.action({ title: 'Done flexible', state: 'completed' });
  seed.placement(done.ref.id, onDay());
  const scheduled = seed.action({ title: 'Scheduled', state: 'scheduled' });
  seed.placement(scheduled.ref.id, onDay());
  const block = seed.block(
    { kind: 'action', actionId: scheduled.ref.id },
    '2026-09-28T18:00:00.000Z',
    '2026-09-28T19:00:00.000Z',
  );
  const skippedTimed = seed.action({ title: 'Skipped block' });
  seed.placement(skippedTimed.ref.id, onDay());
  seed.block(
    { kind: 'action', actionId: skippedTimed.ref.id },
    '2026-09-28T14:00:00.000Z',
    '2026-09-28T15:00:00.000Z',
    { state: 'skipped' },
  );
  const doneTimed = seed.action({ title: 'Done with block', state: 'completed' });
  seed.placement(doneTimed.ref.id, onDay());
  seed.block(
    { kind: 'action', actionId: doneTimed.ref.id },
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
  const walk = seed.routine(daily('2026-09-01'), { title: 'Walk' });
  const stretch = seed.routine(daily('2026-09-01'), { title: 'Stretch', schedulingMode: morning });
  const gym = seed.routine(weeklyCount('2026-09-01'), { title: 'Gym' });
  return {
    open,
    started,
    done,
    scheduled,
    block,
    skippedTimed,
    doneTimed,
    canceled,
    tomorrow,
    walk,
    stretch,
    gym,
  };
}

const occurrenceId = (routineId: UUID, period: Parameters<typeof occurrenceLogicalKey>[2]) =>
  routineOccurrenceId(occurrenceLogicalKey(routineId, 1, period));

describe('loadDay', () => {
  it('lists open and done flexible Actions without timed, canceled, or archived ones', async () => {
    const items = seedDay();
    const loaded = await load();
    expect(loaded.openFlexible.map((row) => row.target.action.title)).toEqual([
      'Open flexible',
      'Started flexible',
    ]);
    expect(loaded.doneFlexible.map((row) => row.target.action.title)).toEqual(['Done flexible']);
    expect([...loaded.timedActionIds].sort()).toEqual(
      [items.scheduled.ref.id, items.skippedTimed.ref.id, items.doneTimed.ref.id].sort(),
    );
    expect([...loaded.plannedActionBlocks.keys()]).toEqual([items.scheduled.ref.id]);
    expect(loaded.plannedActionBlocks.get(items.scheduled.ref.id)?.id).toBe(items.block.ref.id);
    expect(loaded.column.timed.map((entry) => entry.title)).toEqual([
      'Stretch',
      'Skipped block',
      'Done with block',
      'Scheduled',
    ]);
  });

  it('orders flexible Actions by placement order, not by title or state', async () => {
    const second = seed.action({ title: 'B second' });
    const first = seed.action({ title: 'Z first' });
    seed.placement(second.ref.id, onDay(), { orderKey: '000000002000000' });
    seed.placement(first.ref.id, onDay(), { orderKey: '000000001000000' });
    const loaded = await load();
    expect(loaded.openFlexible.map((row) => row.target.action.title)).toEqual([
      'Z first',
      'B second',
    ]);
  });

  it('lists dated occurrences (untimed first) and the weekly counts of the week', async () => {
    const items = seedDay();
    const loaded = await load();
    expect(loaded.dayOccurrences.map((entry) => entry.ref.routineTitle)).toEqual([
      'Walk',
      'Stretch',
    ]);
    expect(loaded.dayOccurrences.map((entry) => entry.timing.kind)).toEqual(['flexible', 'timed']);
    expect(loaded.weekOccurrences.map((entry) => entry.ref.routineId)).toEqual([items.gym.ref.id]);
    expect(loaded.column.flexibleOccurrences.map((entry) => entry.ref.routineTitle)).toEqual([
      'Walk',
    ]);
  });

  it('shows focus in the person’s order with each Action’s timing', async () => {
    const items = seedDay();
    const weekly = seed.action({ title: 'This week' });
    seed.placement(weekly.ref.id, createWeekPeriod(day, 'monday'));
    const walkOccurrence = seed.occurrence(items.walk.ref.id, dated('2026-09-28'));
    seed.focus({ kind: 'action', actionId: items.scheduled.ref.id }, '2026-09-28', {
      orderKey: '000000003000000',
    });
    seed.focus({ kind: 'action', actionId: items.open.ref.id }, '2026-09-28', {
      orderKey: 'onboarding-01',
    });
    seed.focus(
      { kind: 'routine_occurrence', routineOccurrenceId: walkOccurrence.ref.id },
      '2026-09-28',
      { orderKey: '000000002000000' },
    );
    const loaded = await load();
    // Numeric keys sort before `onboarding-01`: the order is (order key, id), never a ranking.
    expect(
      loaded.focus.map((item) => [item.position, item.kind === 'action' ? item.action.title : '']),
    ).toEqual([
      [1, ''],
      [2, 'Scheduled'],
      [3, 'Open flexible'],
    ]);
    const [occurrence, scheduled, flexible] = loaded.focus;
    expect(occurrence).toMatchObject({
      kind: 'routine_occurrence',
      occurrenceId: walkOccurrence.ref.id,
      routineId: items.walk.ref.id,
      routineTitle: 'Walk',
      routineState: 'active',
      key: focusTargetKey({ kind: 'routine_occurrence', occurrenceId: walkOccurrence.ref.id }),
      target: {
        kind: 'routine_occurrence',
        occurrence: {
          routineId: items.walk.ref.id,
          generation: 1,
          period: dated('2026-09-28'),
          revision: 1,
        },
      },
    });
    expect(occurrence?.kind === 'routine_occurrence' ? occurrence.occurrence?.state : '').toBe(
      'planned',
    );
    expect(scheduled?.kind === 'action' ? scheduled.timing : null).toMatchObject({
      kind: 'scheduled',
      block: { id: items.block.ref.id },
    });
    expect(scheduled?.key).toBe(
      focusTargetKey({ kind: 'action', actionId: items.scheduled.ref.id }),
    );
    expect(scheduled?.target).toEqual({ kind: 'action', actionId: items.scheduled.ref.id });
    expect(flexible?.kind === 'action' ? flexible.timing : null).toEqual({ kind: 'flexible' });
  });

  it('marks week, other-day, and finished focus Actions as elsewhere', async () => {
    const items = seedDay();
    const weekly = seed.action({ title: 'This week' });
    seed.placement(weekly.ref.id, createWeekPeriod(day, 'monday'));
    for (const action of [weekly, items.tomorrow, items.done])
      seed.focus({ kind: 'action', actionId: action.ref.id }, '2026-09-28');
    const loaded = await load();
    expect(
      loaded.focus.map((item) =>
        item.kind === 'action' ? [item.action.title, item.timing.kind] : [],
      ),
    ).toEqual([
      ['This week', 'elsewhere'],
      ['Tomorrow', 'elsewhere'],
      ['Done flexible', 'elsewhere'],
    ]);
  });

  it('keeps a changed or archived Routine’s focus item with no occurrence', async () => {
    const ended = seed.routine(daily('2026-09-01', '2026-09-27'), { title: 'Ended' });
    // A pristine row materialized for focus, left outside its generation by a series edit.
    const stale = seed.occurrence(ended.ref.id, dated('2026-09-28'));
    const archived = seed.routine(daily('2026-09-01'), { title: 'Archived', state: 'archived' });
    const archivedOccurrence = seed.occurrence(archived.ref.id, dated('2026-09-28'));
    const moved = seed.routine(daily('2026-09-01'), { title: 'Moved' });
    const movedOccurrence = seed.occurrence(moved.ref.id, dated('2026-09-28'), {
      override: { date: d('2026-09-30') },
    });
    for (const occurrence of [stale, archivedOccurrence, movedOccurrence])
      seed.focus(
        { kind: 'routine_occurrence', routineOccurrenceId: occurrence.ref.id },
        '2026-09-28',
      );
    const loaded = await load();
    expect(
      loaded.focus.map((item) =>
        item.kind === 'routine_occurrence'
          ? [item.routineTitle, item.routineState, item.occurrence]
          : [],
      ),
    ).toEqual([
      ['Ended', 'active', null],
      ['Archived', 'archived', null],
      ['Moved', 'active', null],
    ]);
    expect(loaded.focus[0]?.target).toEqual({
      kind: 'routine_occurrence',
      occurrence: {
        routineId: ended.ref.id,
        generation: 1,
        period: dated('2026-09-28'),
        revision: 1,
      },
    });
  });

  it('reads only the day through bounded statements', async () => {
    seedDay();
    await load();
    const bounds = localDayBounds(day, zone);
    const methods = queries.calls.map((call) => call.method);
    const bounded: readonly (keyof TodayQueryPort)[] = [
      'getPlanProfile',
      'listDayBlocks',
      'listDayActionPlacements',
      'listRoutines',
      'listMaterializedOccurrences',
      'listCapacityConstraints',
      'listDayFocus',
    ];
    expect(new Set(methods)).toEqual(new Set(bounded));
    expect(queries.calls.find((call) => call.method === 'listDayBlocks')?.args).toEqual([
      ownerId,
      { startsAt: bounds.startsAt, endsAt: bounds.endsAt },
    ]);
    expect(bounds).toEqual({
      date: day,
      startsAt: '2026-09-28T04:00:00.000Z',
      endsAt: '2026-09-29T04:00:00.000Z',
    });
    expect(queries.calls.find((call) => call.method === 'listDayActionPlacements')?.args).toEqual([
      ownerId,
      day,
    ]);
    expect(
      queries.calls.find((call) => call.method === 'listMaterializedOccurrences')?.args,
    ).toEqual([ownerId, { start: d('2026-09-27'), end: d('2026-09-29') }, undefined]);
    expect(queries.calls.find((call) => call.method === 'listDayFocus')?.args).toEqual([
      ownerId,
      profile.profileId,
      day,
    ]);
  });

  it('reports overlaps that touch the day, and the day’s capacity', async () => {
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
    const loaded = await load();
    expect(loaded.conflicts).toHaveLength(1);
    expect(loaded.conflicts[0]?.first.title).toBe('First');
    expect(loaded.column.capacity.plannedMinutes).toBe(120);
  });
});

describe('loadFocusChoices', () => {
  const choices = async (date = day) => {
    const session = await kit.session();
    return loadFocusChoices(kit, session, await loadDay(kit, session, date));
  };

  it('lists candidates in plan order, each Action once, none finished, nothing preselected', async () => {
    const items = seedDay();
    const weekPlaced = seed.action({ title: 'Week placed' });
    seed.placement(weekPlaced.ref.id, createWeekPeriod(day, 'monday'));
    const committed = seed.action({ title: 'Committed', state: 'inbox' });
    seed.weekCommitment(committed.ref.id, createWeekPeriod(day, 'monday'));
    seed.weekCommitment(items.open.ref.id, createWeekPeriod(day, 'monday'));
    const finished = seed.action({ title: 'Finished commitment', state: 'completed' });
    seed.weekCommitment(finished.ref.id, createWeekPeriod(day, 'monday'));
    const result = await choices();
    expect(
      result.candidates.map((candidate) =>
        candidate.kind === 'action'
          ? `${candidate.source}:${candidate.action.title}`
          : `${candidate.source}:${candidate.occurrence.ref.routineTitle}`,
      ),
    ).toEqual([
      'scheduled:Scheduled',
      'flexible:Open flexible',
      'flexible:Started flexible',
      'routine:Walk',
      'routine:Stretch',
      'routine:Gym',
      'week:Week placed',
      'week:Committed',
    ]);
    expect(result.candidates.every((candidate) => !candidate.selected)).toBe(true);
    expect(result.candidates[0]).toMatchObject({
      kind: 'action',
      block: { id: items.block.ref.id },
      key: focusTargetKey({ kind: 'action', actionId: items.scheduled.ref.id }),
      target: { kind: 'action', actionId: items.scheduled.ref.id },
    });
    expect(result).toMatchObject({ date: day, editable: true, current: [], weekTotal: 2 });
  });

  it('marks only current focus items as selected and gives occurrences their command input', async () => {
    const items = seedDay();
    const walkOccurrence = occurrenceId(items.walk.ref.id, dated('2026-09-28'));
    seed.occurrence(items.walk.ref.id, dated('2026-09-28'));
    seed.focus({ kind: 'routine_occurrence', routineOccurrenceId: walkOccurrence }, '2026-09-28');
    seed.focus({ kind: 'action', actionId: items.open.ref.id }, '2026-09-28');
    const result = await choices();
    expect(
      result.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.key),
    ).toEqual([
      focusTargetKey({ kind: 'action', actionId: items.open.ref.id }),
      focusTargetKey({ kind: 'routine_occurrence', occurrenceId: walkOccurrence }),
    ]);
    const stretch = result.candidates.find(
      (candidate) =>
        candidate.kind === 'routine_occurrence' &&
        candidate.occurrence.ref.routineTitle === 'Stretch',
    );
    expect(stretch?.target).toEqual({
      kind: 'routine_occurrence',
      occurrence: { routineId: items.stretch.ref.id, generation: 1, period: dated('2026-09-28') },
    });
    const walk = result.candidates.find(
      (candidate) =>
        candidate.kind === 'routine_occurrence' && candidate.occurrence.ref.routineTitle === 'Walk',
    );
    expect(walk?.target).toMatchObject({ occurrence: { revision: 1 } });
    expect(result.current.map((item) => item.key)).toHaveLength(2);
  });

  it('leaves out completed and skipped occurrences', async () => {
    const items = seedDay();
    seed.occurrence(items.walk.ref.id, dated('2026-09-28'), {
      state: 'completed',
      completedAt: now,
    });
    seed.occurrence(items.stretch.ref.id, dated('2026-09-28'), { state: 'skipped' });
    const result = await choices();
    expect(
      result.candidates
        .filter((candidate) => candidate.kind === 'routine_occurrence')
        .map((candidate) =>
          candidate.kind === 'routine_occurrence' ? candidate.occurrence.ref.routineTitle : '',
        ),
    ).toEqual(['Gym']);
  });

  it('reads the Action of a block that began the day before', async () => {
    const late = seed.action({ title: 'Late shift', state: 'scheduled' });
    seed.placement(late.ref.id, onDay('2026-09-27'));
    seed.block(
      { kind: 'action', actionId: late.ref.id },
      '2026-09-28T02:00:00.000Z',
      '2026-09-28T06:00:00.000Z',
    );
    const result = await choices();
    expect(
      result.candidates.map((candidate) => candidate.kind === 'action' && candidate.action.title),
    ).toEqual(['Late shift']);
    expect(queries.calls.filter((call) => call.method === 'getFocusAction')).toHaveLength(1);
  });

  it('offers at most fifty week Actions and reports the full week total', async () => {
    const week = createWeekPeriod(day, 'monday');
    for (let index = 0; index < focusWeekCandidateLimit + 2; index += 1) {
      const action = seed.action({ title: `Week ${String(index)}` });
      seed.weekCommitment(action.ref.id, week);
    }
    const result = await choices();
    expect(result.candidates).toHaveLength(focusWeekCandidateLimit);
    expect(result.weekTotal).toBe(focusWeekCandidateLimit + 2);
    expect(
      queries.calls
        .filter((call) => call.method === 'listWeekCommitmentActions')
        .map((call) => call.args[2]),
    ).toEqual([focusWeekCandidateLimit]);
  });

  it('is read-only for an earlier day', async () => {
    const result = await choices(d('2026-09-27'));
    expect(result.editable).toBe(false);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });
});
