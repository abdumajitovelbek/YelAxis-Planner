import { describe, expect, it } from 'vitest';

import {
  findScheduleConflicts,
  localDayBounds,
  monthRange,
  overlapMinutes,
  parseMonthKey,
  parseYearKey,
  periodContaining,
  quarterOfMonth,
  resolveLocalInterval,
  weeksOfMonth,
  type CalendarDate,
  type IanaTimeZone,
  type Instant,
  type MonthKey,
  type TimedPlanItem,
  type WallTime,
} from './index.js';

const item = (
  key: string,
  startsAt: string,
  endsAt: string,
  overlapAcknowledged = false,
): TimedPlanItem => ({
  key,
  startsAt: startsAt as Instant,
  endsAt: endsAt as Instant,
  overlapAcknowledged,
});

describe('horizon periods', () => {
  it('lists every week touching a month using the profile first weekday', () => {
    const weeks = weeksOfMonth('2026-08' as MonthKey, 'monday');
    expect(weeks.map((week) => `${week.start}/${week.end}`)).toEqual([
      '2026-07-27/2026-08-02',
      '2026-08-03/2026-08-09',
      '2026-08-10/2026-08-16',
      '2026-08-17/2026-08-23',
      '2026-08-24/2026-08-30',
      '2026-08-31/2026-09-06',
    ]);
    expect(weeksOfMonth('2026-08' as MonthKey, 'sunday')[0]?.start).toBe('2026-07-26');
  });

  it('handles leap day, month ends, and quarters', () => {
    expect(monthRange('2028-02' as MonthKey)).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthRange('2026-02' as MonthKey)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(quarterOfMonth('2026-03' as MonthKey)).toBe(1);
    expect(quarterOfMonth('2026-10' as MonthKey)).toBe(4);
    expect(parseMonthKey('2026-13').ok).toBe(false);
    expect(parseYearKey('0000').ok).toBe(false);
    expect(periodContaining('week', '2026-12-31', 'monday')).toEqual({
      ok: true,
      value: { kind: 'week', start: '2026-12-28', end: '2027-01-03', weekStart: 'monday' },
    });
  });

  it('computes local day bounds including DST transition days', () => {
    const zone = 'America/New_York' as IanaTimeZone;
    expect(localDayBounds('2026-03-08' as CalendarDate, zone)).toEqual({
      date: '2026-03-08',
      startsAt: '2026-03-08T05:00:00.000Z',
      endsAt: '2026-03-09T04:00:00.000Z',
    });
    expect(
      overlapMinutes(
        {
          startsAt: '2026-03-08T04:00:00.000Z' as Instant,
          endsAt: '2026-03-08T06:00:00.000Z' as Instant,
        },
        localDayBounds('2026-03-08' as CalendarDate, zone),
      ),
    ).toBe(60);
  });

  it('keeps the absolute duration of fixed intervals that span a DST transition', () => {
    const zone = 'America/New_York' as IanaTimeZone;
    // Spring forward: 01:30 EST plus 60 minutes ends at 03:30 EDT.
    expect(
      resolveLocalInterval('2026-03-08' as CalendarDate, '01:30' as WallTime, 60, zone),
    ).toMatchObject({
      startsAt: '2026-03-08T06:30:00.000Z',
      endsAt: '2026-03-08T07:30:00.000Z',
      localStart: '01:30',
      localEnd: '03:30',
      utcOffset: '-05:00',
    });
    // Fall back: 00:30 EDT plus 120 minutes ends at 01:30 EST (the second 01:30).
    expect(
      resolveLocalInterval('2026-11-01' as CalendarDate, '00:30' as WallTime, 120, zone),
    ).toMatchObject({
      startsAt: '2026-11-01T04:30:00.000Z',
      endsAt: '2026-11-01T06:30:00.000Z',
      localStart: '00:30',
      localEnd: '01:30',
      utcOffset: '-04:00',
    });
  });
});

describe('schedule conflicts', () => {
  it('lists every overlapping pair once, deterministically, and ignores touching intervals', () => {
    const conflicts = findScheduleConflicts([
      item('c', '2026-08-10T10:30:00.000Z', '2026-08-10T11:30:00.000Z'),
      item('a', '2026-08-10T09:00:00.000Z', '2026-08-10T10:00:00.000Z'),
      item('b', '2026-08-10T09:30:00.000Z', '2026-08-10T11:00:00.000Z'),
      item('d', '2026-08-10T11:30:00.000Z', '2026-08-10T12:00:00.000Z'),
    ]);
    expect(conflicts).toEqual([
      {
        firstKey: 'a',
        secondKey: 'b',
        overlapStartsAt: '2026-08-10T09:30:00.000Z',
        overlapEndsAt: '2026-08-10T10:00:00.000Z',
        kept: false,
      },
      {
        firstKey: 'b',
        secondKey: 'c',
        overlapStartsAt: '2026-08-10T10:30:00.000Z',
        overlapEndsAt: '2026-08-10T11:00:00.000Z',
        kept: false,
      },
    ]);
  });

  it('marks a pair kept only when both items carry an explicit acknowledgement', () => {
    expect(
      findScheduleConflicts([
        item('a', '2026-08-10T09:00:00.000Z', '2026-08-10T10:00:00.000Z', true),
        item('b', '2026-08-10T09:30:00.000Z', '2026-08-10T10:30:00.000Z', true),
        item('c', '2026-08-10T09:45:00.000Z', '2026-08-10T10:15:00.000Z'),
      ]).map((conflict) => [conflict.firstKey, conflict.secondKey, conflict.kept]),
    ).toEqual([
      ['a', 'b', true],
      ['a', 'c', false],
      ['b', 'c', false],
    ]);
  });
});
