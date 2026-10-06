import { describe, expect, it } from 'vitest';

import {
  occurrenceLogicalKey,
  parseUUID,
  previewPlanningZoneChange,
  routineOccurrenceId,
  type CalendarDate,
  type DomainResult,
  type IanaTimeZone,
  type Instant,
  type MaterializedOccurrenceSnapshot,
  type RecurrenceRuleV1,
  type RoutineSchedulingMode,
  type RoutineSeriesSnapshot,
  type WallTime,
} from './index.js';

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.details)}`);
  return result.value;
};
const id = (value: string) => expectValue(parseUUID(value));
const date = (value: string) => value as CalendarDate;
const london = 'Europe/London' as IanaTimeZone;
const newYork = 'America/New_York' as IanaTimeZone;
const window = { start: date('2026-10-05'), end: date('2026-10-11') };

const daily: RecurrenceRuleV1 = {
  version: 1,
  kind: 'daily',
  intervalDays: 1,
  startsOn: date('2026-10-01'),
};
const timed = (
  wallTime: string,
  zonePolicy: Extract<RoutineSchedulingMode, { kind: 'time_specific' }>['zonePolicy'],
): RoutineSchedulingMode => ({
  kind: 'time_specific',
  wallTime: wallTime as WallTime,
  durationMinutes: 30,
  zonePolicy,
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
});

const followId = id('0190c2b1-7d9a-7cc1-8be5-b88620c57f01');
const fixedId = id('0190c2b1-7d9a-7cc1-8be5-b88620c57f02');
const flexibleId = id('0190c2b1-7d9a-7cc1-8be5-b88620c57f03');
const archivedId = id('0190c2b1-7d9a-7cc1-8be5-b88620c57f04');

const series = (
  routineId: RoutineSeriesSnapshot['id'],
  mode: RoutineSchedulingMode,
  state: RoutineSeriesSnapshot['state'] = 'active',
): RoutineSeriesSnapshot => ({
  id: routineId,
  state,
  generations: [{ generation: 1, rule: daily, schedulingMode: mode }],
});

const routines = [
  { title: 'Morning run', series: series(followId, timed('07:00', { kind: 'follow_profile' })) },
  {
    title: 'Team call',
    series: series(fixedId, timed('09:00', { kind: 'fixed_zone', timeZone: london })),
  },
  { title: 'Stretch', series: series(flexibleId, { kind: 'day_flexible' }) },
  {
    title: 'Old habit',
    series: series(archivedId, timed('06:00', { kind: 'follow_profile' }), 'archived'),
  },
];

const completedFirstRun = (): MaterializedOccurrenceSnapshot => {
  const period = { kind: 'date', date: date('2026-10-05') } as const;
  const logicalKey = occurrenceLogicalKey(followId, 1, period);
  return {
    id: routineOccurrenceId(logicalKey),
    routineId: followId,
    generation: 1,
    logicalKey,
    period,
    state: 'completed',
    localRevision: 2,
    completedAt: '2026-10-05T06:30:00.000Z' as Instant,
  };
};

describe('previewPlanningZoneChange', () => {
  it('moves follow-profile instants, keeps fixed-zone instants, and keeps dates otherwise', () => {
    const preview = expectValue(
      previewPlanningZoneChange({
        routines,
        materialized: [],
        from: london,
        to: newYork,
        window,
      }),
    );
    expect(preview.dateOnlyRoutineCount).toBe(1);
    expect(preview.routines.map((routine) => routine.title)).toEqual(['Morning run', 'Team call']);

    const [follow, fixed] = preview.routines;
    expect(follow?.policy).toEqual({ kind: 'follow_profile' });
    expect(follow?.occurrences).toHaveLength(3);
    expect(follow?.occurrences[0]).toEqual({
      date: '2026-10-05',
      before: {
        kind: 'timed',
        startsAt: '2026-10-05T06:00:00.000Z',
        wallTime: '07:00',
        timeZone: london,
        localDate: '2026-10-05',
        localTime: '02:00',
      },
      after: {
        kind: 'timed',
        startsAt: '2026-10-05T11:00:00.000Z',
        wallTime: '07:00',
        timeZone: newYork,
        localDate: '2026-10-05',
        localTime: '07:00',
      },
      instantChanges: true,
    });

    expect(fixed?.policy).toEqual({ kind: 'fixed_zone', timeZone: london });
    for (const occurrence of fixed?.occurrences ?? []) {
      expect(occurrence.instantChanges).toBe(false);
      expect(occurrence.after).toMatchObject({ wallTime: '09:00', timeZone: london });
      expect(occurrence.after).toMatchObject({ localTime: '04:00' });
    }
  });

  it('never lists completed or skipped history as changing', () => {
    const preview = expectValue(
      previewPlanningZoneChange({
        routines: routines.slice(0, 1),
        materialized: [completedFirstRun()],
        from: london,
        to: newYork,
        window,
        occurrencesPerRoutine: 10,
      }),
    );
    const dates = preview.routines[0]?.occurrences.map((occurrence) => occurrence.date);
    expect(dates).not.toContain('2026-10-05');
    expect(dates?.[0]).toBe('2026-10-06');
    expect(dates).toHaveLength(6);
  });

  it('skips occurrences that already started', () => {
    const preview = expectValue(
      previewPlanningZoneChange({
        routines: routines.slice(0, 1),
        materialized: [],
        from: london,
        to: newYork,
        window,
        notBefore: '2026-10-05T07:00:00.000Z' as Instant,
      }),
    );
    expect(preview.routines[0]?.occurrences[0]?.date).toBe('2026-10-06');
  });

  it('reports no instant change when the zone keeps the same offsets', () => {
    const preview = expectValue(
      previewPlanningZoneChange({
        routines: routines.slice(0, 1),
        materialized: [],
        from: london,
        to: london,
        window,
      }),
    );
    expect(preview.routines[0]?.occurrences.every((item) => !item.instantChanges)).toBe(true);
  });

  it('lists nothing for day-flexible and archived Routines', () => {
    const preview = expectValue(
      previewPlanningZoneChange({
        routines: routines.slice(2),
        materialized: [],
        from: london,
        to: newYork,
        window,
      }),
    );
    expect(preview.routines).toEqual([]);
    expect(preview.dateOnlyRoutineCount).toBe(1);
  });
});
