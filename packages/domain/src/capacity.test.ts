import { describe, expect, it } from 'vitest';

import {
  calculateDayCapacity,
  calculateWeekCapacity,
  dayAvailability,
  isAvailabilityWindowOrdered,
  mergeAvailabilityWindows,
  plannedMinutesOnDate,
  type AvailabilityWindow,
  type CalendarDate,
  type CapacityRules,
  type IanaTimeZone,
  type Instant,
  type PlannedWork,
  type WallTime,
  type Weekday,
} from './index.js';

const zone = 'America/New_York' as IanaTimeZone;
const date = (value: string) => value as CalendarDate;
const window = (weekday: Weekday, start: string, end: string): AvailabilityWindow => ({
  weekday,
  start: start as WallTime,
  end: end as WallTime,
});
const work = (
  startsAt: string,
  endsAt: string,
  state: PlannedWork['state'] = 'planned',
): PlannedWork => ({ startsAt: startsAt as Instant, endsAt: endsAt as Instant, state });
const rules = (partial: Partial<CapacityRules>): CapacityRules => ({
  windows: [],
  caps: [],
  ...partial,
});

describe('availability windows', () => {
  it('merges overlapping and touching windows before summing', () => {
    expect(
      mergeAvailabilityWindows([
        { start: '13:00' as WallTime, end: '17:00' as WallTime },
        { start: '09:00' as WallTime, end: '12:00' as WallTime },
        { start: '11:00' as WallTime, end: '13:00' as WallTime },
        { start: '19:00' as WallTime, end: '20:00' as WallTime },
      ]),
    ).toEqual([
      { start: 540, end: 1020 },
      { start: 1140, end: 1200 },
    ]);
  });

  it('uses the union of windows for the date weekday', () => {
    const value = dayAvailability(
      date('2026-08-10'),
      rules({
        windows: [
          window('monday', '09:00', '12:00'),
          window('monday', '10:00', '13:00'),
          window('tuesday', '09:00', '17:00'),
        ],
      }),
      zone,
    );
    expect(value).toEqual({ status: 'known', minutes: 240, basis: 'windows' });
  });

  it('never treats a day without availability as free', () => {
    expect(
      dayAvailability(
        date('2026-08-15'),
        rules({ windows: [window('monday', '09:00', '17:00')] }),
        zone,
      ),
    ).toEqual({ status: 'unknown' });
  });

  it('applies the lower of windows and a day cap, and a cap alone is the explicit limit', () => {
    const monday = date('2026-08-10');
    expect(
      dayAvailability(
        monday,
        rules({
          windows: [window('monday', '09:00', '17:00')],
          caps: [{ period: 'day', minutes: 300 }],
        }),
        zone,
      ),
    ).toEqual({ status: 'known', minutes: 300, basis: 'windows_capped' });
    expect(
      dayAvailability(
        monday,
        rules({
          windows: [window('monday', '09:00', '10:00')],
          caps: [{ period: 'day', minutes: 300 }],
        }),
        zone,
      ),
    ).toEqual({ status: 'known', minutes: 60, basis: 'windows' });
    expect(
      dayAvailability(monday, rules({ caps: [{ period: 'day', minutes: 240 }] }), zone),
    ).toEqual({
      status: 'known',
      minutes: 240,
      basis: 'cap',
    });
  });

  it('measures elapsed window time across DST transitions', () => {
    const springForward = date('2026-03-08');
    const fallBack = date('2026-11-01');
    expect(
      dayAvailability(
        springForward,
        rules({ windows: [window('sunday', '01:00', '04:00')] }),
        zone,
      ),
    ).toEqual({ status: 'known', minutes: 120, basis: 'windows' });
    expect(
      dayAvailability(fallBack, rules({ windows: [window('sunday', '00:00', '03:00')] }), zone),
    ).toEqual({ status: 'known', minutes: 240, basis: 'windows' });
  });
});

describe('availability windows that end at midnight', () => {
  it('treats an end of 00:00 as the end of the day when the window starts later', () => {
    expect(
      mergeAvailabilityWindows([
        { start: '18:00' as WallTime, end: '00:00' as WallTime },
        { start: '09:00' as WallTime, end: '12:00' as WallTime },
      ]),
    ).toEqual([
      { start: 540, end: 720 },
      { start: 1080, end: 1440 },
    ]);
    expect(
      dayAvailability(
        date('2026-08-10'),
        rules({ windows: [window('monday', '18:00', '00:00')] }),
        zone,
      ),
    ).toEqual({ status: 'known', minutes: 360, basis: 'windows' });
  });

  it('accepts midnight only as an end after a later start', () => {
    const at = (value: string) => value as WallTime;
    expect(isAvailabilityWindowOrdered(at('18:00'), at('00:00'))).toBe(true);
    expect(isAvailabilityWindowOrdered(at('00:01'), at('00:00'))).toBe(true);
    expect(isAvailabilityWindowOrdered(at('00:00'), at('00:00'))).toBe(false);
    expect(isAvailabilityWindowOrdered(at('09:00'), at('17:00'))).toBe(true);
    expect(isAvailabilityWindowOrdered(at('17:00'), at('09:00'))).toBe(false);
    expect(isAvailabilityWindowOrdered(at('09:00'), at('09:00'))).toBe(false);
  });

  it('lets a whole day of availability hold a whole day of work, including DST days', () => {
    const fullDay = [window('sunday', '00:00', '12:00'), window('sunday', '12:00', '00:00')];
    const springForward = calculateDayCapacity(
      date('2026-03-08'),
      [work('2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z')],
      rules({ windows: fullDay }),
      zone,
    );
    expect(springForward.plannedMinutes).toBe(1380);
    expect(springForward.availability).toEqual({
      status: 'known',
      minutes: 1380,
      basis: 'windows',
    });
    expect(springForward.overByMinutes).toBeUndefined();
    const fallBack = calculateDayCapacity(
      date('2026-11-01'),
      [work('2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z')],
      rules({ windows: [window('sunday', '20:00', '00:00'), ...fullDay] }),
      zone,
    );
    expect(fallBack.plannedMinutes).toBe(1500);
    expect(fallBack.availability).toEqual({ status: 'known', minutes: 1500, basis: 'windows' });
    expect(fallBack.overByMinutes).toBeUndefined();
  });
});

describe('planned load', () => {
  it('counts planned and completed work fully, including overlaps, and excludes canceled/skipped', () => {
    const items = [
      work('2026-08-10T13:00:00.000Z', '2026-08-10T14:00:00.000Z'),
      work('2026-08-10T13:30:00.000Z', '2026-08-10T14:30:00.000Z'),
      work('2026-08-10T15:00:00.000Z', '2026-08-10T15:45:00.000Z', 'completed'),
      work('2026-08-10T16:00:00.000Z', '2026-08-10T17:00:00.000Z', 'canceled'),
      work('2026-08-10T18:00:00.000Z', '2026-08-10T19:00:00.000Z', 'skipped'),
    ];
    expect(plannedMinutesOnDate(date('2026-08-10'), items, zone)).toBe(165);
  });

  it('clips cross-midnight work to each local date', () => {
    const late = [work('2026-08-11T02:00:00.000Z', '2026-08-11T06:00:00.000Z')];
    expect(plannedMinutesOnDate(date('2026-08-10'), late, zone)).toBe(120);
    expect(plannedMinutesOnDate(date('2026-08-11'), late, zone)).toBe(120);
  });

  it('reports over-capacity only when availability is known', () => {
    const items = [work('2026-08-10T13:00:00.000Z', '2026-08-10T17:00:00.000Z')];
    expect(
      calculateDayCapacity(
        date('2026-08-10'),
        items,
        rules({ caps: [{ period: 'day', minutes: 180 }] }),
        zone,
      ),
    ).toEqual({
      date: '2026-08-10',
      plannedMinutes: 240,
      availability: { status: 'known', minutes: 180, basis: 'cap' },
      overByMinutes: 60,
    });
    expect(calculateDayCapacity(date('2026-08-10'), items, rules({}), zone)).toEqual({
      date: '2026-08-10',
      plannedMinutes: 240,
      availability: { status: 'unknown' },
    });
  });
});

describe('week capacity', () => {
  const week = { start: date('2026-08-10'), end: date('2026-08-16') };
  const weekdaysOnly = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((day) =>
    window(day as Weekday, '09:00', '17:00'),
  );
  const allDays = [
    ...weekdaysOnly,
    window('saturday', '10:00', '12:00'),
    window('sunday', '10:00', '12:00'),
  ];

  it('sums seven derived days when every day is known', () => {
    const value = calculateWeekCapacity(week, [], rules({ windows: allDays }), zone);
    expect(value.availability).toEqual({
      status: 'known',
      minutes: 5 * 480 + 240,
      basis: 'windows',
    });
    expect(value.days).toHaveLength(7);
  });

  it('labels partially specified weeks instead of treating missing days as free', () => {
    const value = calculateWeekCapacity(week, [], rules({ windows: weekdaysOnly }), zone);
    expect(value.availability).toEqual({
      status: 'partial',
      knownMinutes: 2400,
      knownDays: 5,
      totalDays: 7,
    });
    expect(value.overByMinutes).toBeUndefined();
  });

  it('applies a week cap as the lower value, or as the explicit limit when no day is known', () => {
    expect(
      calculateWeekCapacity(
        week,
        [],
        rules({ windows: allDays, caps: [{ period: 'week', minutes: 1200 }] }),
        zone,
      ).availability,
    ).toEqual({ status: 'known', minutes: 1200, basis: 'windows_capped' });
    expect(
      calculateWeekCapacity(week, [], rules({ caps: [{ period: 'week', minutes: 900 }] }), zone)
        .availability,
    ).toEqual({ status: 'known', minutes: 900, basis: 'cap' });
    expect(
      calculateWeekCapacity(
        week,
        [],
        rules({ windows: weekdaysOnly, caps: [{ period: 'week', minutes: 3000 }] }),
        zone,
      ).availability,
    ).toEqual({
      status: 'partial',
      knownMinutes: 2400,
      knownDays: 5,
      totalDays: 7,
      capMinutes: 3000,
    });
    expect(
      calculateWeekCapacity(
        week,
        [],
        rules({ windows: weekdaysOnly, caps: [{ period: 'week', minutes: 1000 }] }),
        zone,
      ).availability,
    ).toEqual({ status: 'known', minutes: 1000, basis: 'windows_capped' });
  });

  it('reports unknown availability when nothing is defined', () => {
    const value = calculateWeekCapacity(
      week,
      [work('2026-08-12T13:00:00.000Z', '2026-08-12T14:00:00.000Z')],
      rules({}),
      zone,
    );
    expect(value).toMatchObject({ plannedMinutes: 60, availability: { status: 'unknown' } });
    expect(value.overByMinutes).toBeUndefined();
  });

  it('flags a known week whose planned work exceeds availability', () => {
    const value = calculateWeekCapacity(
      week,
      [work('2026-08-10T13:00:00.000Z', '2026-08-10T23:00:00.000Z')],
      rules({ caps: [{ period: 'week', minutes: 480 }] }),
      zone,
    );
    expect(value.overByMinutes).toBe(120);
  });
});
