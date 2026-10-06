import { describe, expect, it } from 'vitest';

import {
  createFixedInterval,
  createTargetWindow,
  createWeekPeriod,
  currentPlanningDate,
  fixedIntervalDurationMinutes,
  formatInstantInZone,
  isActionOverdue,
  parseCalendarDate,
  parseIanaTimeZone,
  parseInstant,
  parseWallTime,
  resolveFloatingDateTime,
  type CalendarDate,
  type Clock,
  type DomainResult,
  type IanaTimeZone,
  type Instant,
  type WallTime,
} from './index.js';

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const date = (value: string): CalendarDate => expectValue(parseCalendarDate(value));
const instant = (value: string): Instant => expectValue(parseInstant(value));
const zone = (value: string): IanaTimeZone => expectValue(parseIanaTimeZone(value));
const wallTime = (value: string): WallTime => expectValue(parseWallTime(value));

describe('validated time values', () => {
  it('keeps canonical UTC instants distinct from dates and wall times', () => {
    expect(parseInstant('2026-07-23T10:15:00Z')).toEqual({
      ok: true,
      value: '2026-07-23T10:15:00.000Z',
    });
    expect(parseInstant('2026-07-23T11:15:00+01:00').ok).toBe(false);
    expect(parseCalendarDate('2024-02-29').ok).toBe(true);
    expect(parseCalendarDate('2023-02-29').ok).toBe(false);
    expect(parseWallTime('09:05').ok).toBe(true);
    expect(parseWallTime('24:00').ok).toBe(false);
    expect(parseIanaTimeZone('+05:00').ok).toBe(false);
    expect(parseIanaTimeZone('Mars/Olympus_Mons').ok).toBe(false);
    expect(parseIanaTimeZone('Asia/Tashkent').ok).toBe(true);
  });

  it('requires increasing fixed intervals and valid inclusive target windows', () => {
    const startsAt = instant('2026-07-23T10:00:00Z');
    const endsAt = instant('2026-07-23T11:00:00Z');
    const timeZone = zone('Asia/Tashkent');

    expect(createFixedInterval(startsAt, endsAt, timeZone).ok).toBe(true);
    expect(createFixedInterval(endsAt, startsAt, timeZone).ok).toBe(false);
    expect(createFixedInterval(startsAt, startsAt, timeZone).ok).toBe(false);
    expect(createTargetWindow({ start: date('2026-07-01'), end: date('2026-07-31') }).ok).toBe(
      true,
    );
    expect(createTargetWindow({ start: date('2026-08-01'), end: date('2026-07-31') }).ok).toBe(
      false,
    );
    expect(createTargetWindow({ start: date('2026-08-01') }).ok).toBe(true);
  });
});

describe('planning time and due projection', () => {
  it('derives today only from an injected clock and the confirmed planning zone', () => {
    const clock: Clock = { now: () => instant('2026-07-23T19:30:00Z') };
    expect(currentPlanningDate(clock, zone('UTC'))).toBe('2026-07-23');
    expect(currentPlanningDate(clock, zone('Asia/Tashkent'))).toBe('2026-07-24');
  });

  it('treats date-only due values as due through the end of the planning date', () => {
    const due = { kind: 'date' as const, date: date('2026-07-23') };
    const beforeMidnight: Clock = { now: () => instant('2026-07-23T18:59:59Z') };
    const afterMidnight: Clock = { now: () => instant('2026-07-23T19:00:01Z') };
    const planningZone = zone('Asia/Tashkent');

    expect(isActionOverdue('planned', due, beforeMidnight, planningZone)).toBe(false);
    expect(isActionOverdue('planned', due, afterMidnight, planningZone)).toBe(true);
    expect(isActionOverdue('completed', due, afterMidnight, planningZone)).toBe(false);
    expect(isActionOverdue('canceled', due, afterMidnight, planningZone)).toBe(false);
    expect(isActionOverdue('archived', due, afterMidnight, planningZone)).toBe(false);
  });

  it('compares exact due instants and preserves fixed instants while viewing another zone', () => {
    const due = {
      kind: 'instant' as const,
      instant: instant('2026-07-23T10:00:00Z'),
      authoredTimeZone: zone('Asia/Tashkent'),
    };
    expect(
      isActionOverdue(
        'in_progress',
        due,
        { now: () => instant('2026-07-23T10:00:00Z') },
        zone('UTC'),
      ),
    ).toBe(false);
    expect(
      isActionOverdue(
        'in_progress',
        due,
        { now: () => instant('2026-07-23T10:00:00.001Z') },
        zone('UTC'),
      ),
    ).toBe(true);
    expect(formatInstantInZone(due.instant, zone('America/New_York'))).toEqual({
      date: '2026-07-23',
      time: '06:00',
      offset: '-04:00',
    });
  });

  it('preserves fixed instants and absolute duration across travel and spring-forward', () => {
    const interval = expectValue(
      createFixedInterval(
        instant('2024-03-10T06:30:00Z'),
        instant('2024-03-10T07:30:00Z'),
        zone('America/New_York'),
      ),
    );
    expect(fixedIntervalDurationMinutes(interval)).toBe(60);
    expect(formatInstantInZone(interval.startsAt, zone('America/New_York'))).toEqual({
      date: '2024-03-10',
      time: '01:30',
      offset: '-05:00',
    });
    expect(formatInstantInZone(interval.endsAt, zone('America/New_York'))).toEqual({
      date: '2024-03-10',
      time: '03:30',
      offset: '-04:00',
    });
    expect(formatInstantInZone(interval.startsAt, zone('Asia/Tashkent'))).toEqual({
      date: '2024-03-10',
      time: '11:30',
      offset: '+05:00',
    });
    expect(interval.timeZone).toBe('America/New_York');
  });

  it('preserves both fixed instants through a repeated fall-back wall time', () => {
    const interval = expectValue(
      createFixedInterval(
        instant('2024-11-03T05:30:00Z'),
        instant('2024-11-03T06:30:00Z'),
        zone('America/New_York'),
      ),
    );
    expect(fixedIntervalDurationMinutes(interval)).toBe(60);
    expect(formatInstantInZone(interval.startsAt, interval.timeZone)).toMatchObject({
      time: '01:30',
      offset: '-04:00',
    });
    expect(formatInstantInZone(interval.endsAt, interval.timeZone)).toMatchObject({
      time: '01:30',
      offset: '-05:00',
    });
  });
});

describe('horizon and daylight-saving rules', () => {
  it('snapshots an exact seven-day week and its first-weekday setting', () => {
    expect(createWeekPeriod(date('2026-07-23'), 'monday')).toEqual({
      kind: 'week',
      start: '2026-07-20',
      end: '2026-07-26',
      weekStart: 'monday',
    });
    expect(createWeekPeriod(date('2026-07-23'), 'sunday')).toEqual({
      kind: 'week',
      start: '2026-07-19',
      end: '2026-07-25',
      weekStart: 'sunday',
    });
  });

  it('applies explicit DST gap policies', () => {
    const input = {
      date: date('2024-03-10'),
      wallTime: wallTime('02:30'),
      timeZone: zone('America/New_York'),
      overlapPolicy: 'earlier_offset' as const,
    };
    expect(resolveFloatingDateTime({ ...input, gapPolicy: 'shift_forward' })).toEqual({
      ok: true,
      value: '2024-03-10T07:30:00.000Z',
    });
    expect(resolveFloatingDateTime({ ...input, gapPolicy: 'skip' })).toEqual({
      ok: true,
      value: null,
    });
  });

  it('applies explicit repeated-hour policies', () => {
    const input = {
      date: date('2024-11-03'),
      wallTime: wallTime('01:30'),
      timeZone: zone('America/New_York'),
      gapPolicy: 'shift_forward' as const,
    };
    expect(resolveFloatingDateTime({ ...input, overlapPolicy: 'earlier_offset' })).toEqual({
      ok: true,
      value: '2024-11-03T05:30:00.000Z',
    });
    expect(resolveFloatingDateTime({ ...input, overlapPolicy: 'later_offset' })).toEqual({
      ok: true,
      value: '2024-11-03T06:30:00.000Z',
    });
  });
});
