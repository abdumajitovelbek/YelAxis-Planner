import { describe, expect, it } from 'vitest';

import {
  checkReviewAcceptsReminder,
  checkRoutineAcceptsReminder,
  checkTimeBlockAcceptsReminder,
  followTimeBlockStart,
  nextReminderOccurrence,
  parseReviewReminderRequest,
  parseRoutineReminderRequest,
  parseTimeBlockReminderRequest,
  reminderLimits,
  reminderMinutesBefore,
  resolveNextRoutineReminder,
  resolveReviewReminder,
  resolveRoutineReminder,
  resolveTimeBlockReminder,
  scheduleReminderState,
  turnOffReminderState,
  type CalendarDate,
  type DomainResult,
  type EntityId,
  type IanaTimeZone,
  type Instant,
  type OccurrenceTiming,
  type ReminderOccurrence,
  type ReminderSchedule,
  type RoutineSchedulingMode,
  type WallTime,
} from './index';

const instant = (value: string): Instant => value as Instant;
const zone = (value: string): IanaTimeZone => value as IanaTimeZone;
const date = (value: string): CalendarDate => value as CalendarDate;
const wall = (value: string): WallTime => value as WallTime;

const reasonOf = (result: DomainResult<unknown>): unknown =>
  result.ok ? 'ok' : result.error.details?.['reason'];

const nullPrototype = (fields: Readonly<Record<string, unknown>>): object =>
  Object.assign(Object.create(null) as object, fields);

describe('reminder requests', () => {
  it.each([
    [{ kind: 'at', date: '2026-10-01', time: '07:30' }, 'ok'],
    [{ kind: 'at', date: '2026-10-01', time: '07:30:15' }, 'ok'],
    [nullPrototype({ kind: 'at', date: '2026-10-01', time: '07:30' }), 'ok'],
    [{ kind: 'relative', minutesBefore: 0 }, 'ok'],
    [{ kind: 'relative', minutesBefore: 15 }, 'ok'],
    [{ kind: 'relative', minutesBefore: reminderLimits.minutesBefore }, 'ok'],
    [null, 'reminder_shape'],
    [undefined, 'reminder_shape'],
    ['07:30', 'reminder_shape'],
    [15, 'reminder_shape'],
    [[{ kind: 'relative', minutesBefore: 15 }], 'reminder_shape'],
    [new Date('2026-10-01T07:30:00Z'), 'reminder_shape'],
    [{}, 'reminder_kind'],
    [{ kind: 'before', minutesBefore: 15 }, 'reminder_kind'],
    [{ kind: 'AT', date: '2026-10-01', time: '07:30' }, 'reminder_kind'],
    [{ kind: 'at', date: '2026-10-01' }, 'reminder_fields'],
    [{ kind: 'at', date: '2026-10-01', time: '07:30', timeZone: 'UTC' }, 'reminder_fields'],
    [{ kind: 'at', date: '2026-10-01', time: '07:30', minutesBefore: 5 }, 'reminder_fields'],
    [{ kind: 'relative' }, 'reminder_fields'],
    [{ kind: 'relative', minutesBefore: 15, date: '2026-10-01' }, 'reminder_fields'],
    [{ kind: 'at', date: '2026-02-30', time: '07:30' }, 'reminder_date'],
    [{ kind: 'at', date: '2026-10-1', time: '07:30' }, 'reminder_date'],
    [{ kind: 'at', date: '2026-10-01T07:30', time: '07:30' }, 'reminder_date'],
    [{ kind: 'at', date: 20261001, time: '07:30' }, 'reminder_date'],
    [{ kind: 'at', date: '2026-10-01', time: '24:00' }, 'reminder_time'],
    [{ kind: 'at', date: '2026-10-01', time: '7:30' }, 'reminder_time'],
    [{ kind: 'at', date: '2026-10-01', time: '07:60' }, 'reminder_time'],
    [{ kind: 'at', date: '2026-10-01', time: 730 }, 'reminder_time'],
    [{ kind: 'relative', minutesBefore: -1 }, 'reminder_offset'],
    [{ kind: 'relative', minutesBefore: reminderLimits.minutesBefore + 1 }, 'reminder_offset'],
    [{ kind: 'relative', minutesBefore: 1.5 }, 'reminder_offset'],
    [{ kind: 'relative', minutesBefore: '15' }, 'reminder_offset'],
    [{ kind: 'relative', minutesBefore: Number.NaN }, 'reminder_offset'],
    [{ kind: 'relative', minutesBefore: Number.POSITIVE_INFINITY }, 'reminder_offset'],
    [{ kind: 'relative', minutesBefore: null }, 'reminder_offset'],
  ])('Time Block %j → %s', (value, expected) => {
    expect(reasonOf(parseTimeBlockReminderRequest(value))).toBe(expected);
  });

  it('returns the parsed Time Block request without extra fields', () => {
    expect(
      parseTimeBlockReminderRequest({ kind: 'at', date: '2026-10-01', time: '07:30' }),
    ).toEqual({ ok: true, value: { kind: 'at', date: '2026-10-01', time: '07:30' } });
    expect(parseTimeBlockReminderRequest({ kind: 'relative', minutesBefore: 15 })).toEqual({
      ok: true,
      value: { kind: 'relative', minutesBefore: 15 },
    });
  });

  it.each([
    [{ minutesBefore: 0 }, 'ok'],
    [{ minutesBefore: 30 }, 'ok'],
    [{ minutesBefore: reminderLimits.minutesBefore }, 'ok'],
    [null, 'reminder_shape'],
    [[30], 'reminder_shape'],
    [30, 'reminder_shape'],
    [{}, 'reminder_fields'],
    [{ minutesBefore: 30, kind: 'relative' }, 'reminder_fields'],
    [{ minutes: 30 }, 'reminder_fields'],
    [{ minutesBefore: -5 }, 'reminder_offset'],
    [{ minutesBefore: 10_081 }, 'reminder_offset'],
    [{ minutesBefore: 2.5 }, 'reminder_offset'],
    [{ minutesBefore: '30' }, 'reminder_offset'],
  ])('Routine %j → %s', (value, expected) => {
    expect(reasonOf(parseRoutineReminderRequest(value))).toBe(expected);
  });

  it.each([
    [{ date: '2026-10-02', time: '18:00' }, 'ok'],
    [nullPrototype({ date: '2026-10-02', time: '18:00' }), 'ok'],
    [null, 'reminder_shape'],
    ['2026-10-02T18:00', 'reminder_shape'],
    [{ date: '2026-10-02' }, 'reminder_fields'],
    [{ kind: 'at', date: '2026-10-02', time: '18:00' }, 'reminder_fields'],
    [{ date: '2026-10-02', time: '18:00', timeZone: 'UTC' }, 'reminder_fields'],
    [{ date: '2026-13-02', time: '18:00' }, 'reminder_date'],
    [{ date: '2026-10-02', time: '6 pm' }, 'reminder_time'],
  ])('review %j → %s', (value, expected) => {
    expect(reasonOf(parseReviewReminderRequest(value))).toBe(expected);
  });

  it('explains a malformed reminder calmly and points at the field that is wrong', () => {
    const malformed = parseTimeBlockReminderRequest({ kind: 'at', date: '2026-10-01', x: 1 });
    expect(malformed).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_value',
        message: 'This reminder is not valid. Refresh and try again.',
      },
    });
    expect(parseRoutineReminderRequest({ minutesBefore: 10_081 })).toMatchObject({
      ok: false,
      error: { message: 'Choose from 0 to 10,080 minutes before.' },
    });
    expect(parseReviewReminderRequest({ date: '2026-10-02', time: '25:00' })).toMatchObject({
      ok: false,
      error: { message: 'Enter a valid time for the reminder, such as 07:30.' },
    });
  });
});

const schedule = (result: DomainResult<ReminderSchedule>): ReminderSchedule => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe('Time Block reminder resolution', () => {
  const blockStart = instant('2026-10-01T09:00:00.000Z');
  it.each([
    [
      'minutes before the start',
      { kind: 'relative', minutesBefore: 15 },
      'UTC',
      { kind: 'relative', remindAt: '2026-10-01T08:45:00.000Z', offsetMinutes: -15 },
    ],
    [
      'at the start',
      { kind: 'relative', minutesBefore: 0 },
      'UTC',
      { kind: 'relative', remindAt: '2026-10-01T09:00:00.000Z', offsetMinutes: 0 },
    ],
    [
      'seven days before',
      { kind: 'relative', minutesBefore: 10_080 },
      'Asia/Tashkent',
      { kind: 'relative', remindAt: '2026-09-24T09:00:00.000Z', offsetMinutes: -10_080 },
    ],
    [
      'a chosen time in the planning zone',
      { kind: 'at', date: date('2026-10-01'), time: wall('07:30') },
      'Asia/Tashkent',
      { kind: 'at', remindAt: '2026-10-01T02:30:00.000Z' },
    ],
    [
      'a chosen time skipped by a clock change moves forward',
      { kind: 'at', date: date('2026-03-08'), time: wall('02:30') },
      'America/New_York',
      { kind: 'at', remindAt: '2026-03-08T07:30:00.000Z' },
    ],
    [
      'a repeated time uses its earlier occurrence',
      { kind: 'at', date: date('2026-11-01'), time: wall('01:30') },
      'America/New_York',
      { kind: 'at', remindAt: '2026-11-01T05:30:00.000Z' },
    ],
    [
      'a chosen time after the block is kept as chosen',
      { kind: 'at', date: date('2026-10-02'), time: wall('18:00') },
      'UTC',
      { kind: 'at', remindAt: '2026-10-02T18:00:00.000Z' },
    ],
  ] as const)('resolves %s', (_name, request, timeZone, expected) => {
    expect(
      schedule(resolveTimeBlockReminder(request, { blockStart, timeZone: zone(timeZone) })),
    ).toEqual({ ...expected, timeZone });
  });

  it('stores zero minutes before as offset 0, never -0', () => {
    const resolved = schedule(
      resolveTimeBlockReminder(
        { kind: 'relative', minutesBefore: 0 },
        { blockStart, timeZone: zone('UTC') },
      ),
    );
    expect(resolved.kind === 'relative' && Object.is(resolved.offsetMinutes, 0)).toBe(true);
    expect(reminderMinutesBefore(resolved)).toBe(0);
  });

  it.each([
    // 23:59 on the last day of 9999 in New York is already the year 10000 in UTC.
    ['9999-12-31', '23:59', 'America/New_York', 'reminder_date'],
    // Midnight on the first day of the year 0000 in Tashkent is still the year before in UTC.
    ['0000-01-01', '00:00', 'Asia/Tashkent', 'reminder_date'],
    // The same late date east of UTC stays within the year 9999.
    ['9999-12-31', '23:59', 'Asia/Tashkent', 'ok'],
  ])('a chosen %s %s in %s whose instant cannot be stored → %s', (day, time, timeZone, reason) => {
    const context = { blockStart, timeZone: zone(timeZone) };
    const request = { date: date(day), time: wall(time) };
    expect(reasonOf(resolveTimeBlockReminder({ kind: 'at', ...request }, context))).toBe(reason);
    expect(reasonOf(resolveReviewReminder(request, context))).toBe(reason);
  });

  it.each([
    ['relative', { kind: 'relative', minutesBefore: 10_081 }, 'reminder_offset'],
    ['negative', { kind: 'relative', minutesBefore: -1 }, 'reminder_offset'],
  ] as const)('refuses a %s offset that skipped parsing', (_name, request, reason) => {
    expect(reasonOf(resolveTimeBlockReminder(request, { blockStart, timeZone: zone('UTC') }))).toBe(
      reason,
    );
  });

  it('follows a superseding block: relative from the new start, a chosen time stays', () => {
    const relative: ReminderSchedule = {
      kind: 'relative',
      remindAt: instant('2026-10-01T08:45:00.000Z'),
      offsetMinutes: -15,
      timeZone: zone('Asia/Tashkent'),
    };
    const fixed: ReminderSchedule = {
      kind: 'at',
      remindAt: instant('2026-10-01T07:00:00.000Z'),
      timeZone: zone('Asia/Tashkent'),
    };
    const moved = instant('2026-10-02T13:30:00.000Z');
    expect(followTimeBlockStart(relative, moved)).toEqual({
      ...relative,
      remindAt: '2026-10-02T13:15:00.000Z',
    });
    expect(followTimeBlockStart(relative, instant('2026-10-01T09:00:00.000Z'))).toEqual(relative);
    expect(followTimeBlockStart(fixed, moved)).toBe(fixed);
    expect(reminderMinutesBefore(relative)).toBe(15);
    expect(reminderMinutesBefore(fixed)).toBeUndefined();
  });
});

describe('review reminder resolution', () => {
  it.each([
    ['2026-10-02', '18:00', 'America/New_York', '2026-10-02T22:00:00.000Z'],
    ['2026-03-08', '02:15', 'America/New_York', '2026-03-08T07:15:00.000Z'],
    ['2026-11-01', '01:45', 'America/New_York', '2026-11-01T05:45:00.000Z'],
    ['2026-12-31', '23:59', 'Asia/Tashkent', '2026-12-31T18:59:00.000Z'],
  ])('reads %s %s in %s as %s', (day, time, timeZone, remindAt) => {
    expect(
      schedule(
        resolveReviewReminder({ date: date(day), time: wall(time) }, { timeZone: zone(timeZone) }),
      ),
    ).toEqual({ kind: 'at', remindAt, timeZone });
  });
});

const timed = (
  startsAt: string,
  timeZone = 'America/New_York',
): Extract<OccurrenceTiming, { kind: 'timed' }> => ({
  kind: 'timed',
  startsAt: instant(startsAt),
  endsAt: instant(new Date(Date.parse(startsAt) + 30 * 60_000).toISOString()),
  timeZone: zone(timeZone),
  wallTime: wall('07:00'),
  durationMinutes: 30,
});

describe('timed Routine reminder resolution', () => {
  const now = instant('2026-10-01T10:50:00.000Z');
  const occurrences: readonly ReminderOccurrence[] = [
    { state: 'completed', timing: timed('2026-10-01T11:30:00.000Z') },
    { state: 'planned', timing: { kind: 'flexible' } },
    { state: 'planned', timing: { kind: 'weekly_count' } },
    {
      state: 'planned',
      timing: { kind: 'dst_skipped', wallTime: wall('02:30'), timeZone: zone('America/New_York') },
    },
    // Starts in 10 minutes: a 15-minute reminder for it would already be past.
    { state: 'planned', timing: timed('2026-10-01T11:00:00.000Z') },
    { state: 'planned', timing: timed('2026-10-03T11:00:00.000Z') },
    { state: 'planned', timing: timed('2026-10-02T03:00:00.000Z', 'Asia/Tashkent') },
    { state: 'skipped', timing: timed('2026-10-01T23:00:00.000Z') },
  ];

  it.each([
    [0, '2026-10-01T11:00:00.000Z', 'America/New_York'],
    [10, '2026-10-01T11:00:00.000Z', 'America/New_York'],
    [15, '2026-10-02T03:00:00.000Z', 'Asia/Tashkent'],
    [60 * 24, '2026-10-03T11:00:00.000Z', 'America/New_York'],
  ])('%i minutes before anchors on %s', (minutesBefore, startsAt, timeZone) => {
    expect(nextReminderOccurrence(occurrences, now, minutesBefore)).toEqual({
      startsAt,
      timeZone,
    });
  });

  it('stores the next occurrence instant with its offset in that occurrence zone', () => {
    expect(resolveNextRoutineReminder({ occurrences, now, minutesBefore: 15 })).toEqual({
      ok: true,
      value: {
        kind: 'relative',
        remindAt: '2026-10-02T02:45:00.000Z',
        offsetMinutes: -15,
        timeZone: 'Asia/Tashkent',
      },
    });
    expect(
      resolveRoutineReminder({
        occurrenceStart: instant('2026-10-03T11:00:00.000Z'),
        minutesBefore: 90,
        timeZone: zone('America/New_York'),
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: 'relative',
        remindAt: '2026-10-03T09:30:00.000Z',
        offsetMinutes: -90,
        timeZone: 'America/New_York',
      },
    });
  });

  it('allows a reminder that is due exactly now and refuses when nothing is ahead', () => {
    expect(
      nextReminderOccurrence(
        [{ state: 'planned', timing: timed('2026-10-01T11:00:00.000Z') }],
        now,
        10,
      ),
    ).toMatchObject({ startsAt: '2026-10-01T11:00:00.000Z' });
    expect(
      reasonOf(resolveNextRoutineReminder({ occurrences, now, minutesBefore: 7 * 1440 })),
    ).toBe('reminder_no_upcoming_occurrence');
    expect(reasonOf(resolveNextRoutineReminder({ occurrences: [], now, minutesBefore: 0 }))).toBe(
      'reminder_no_upcoming_occurrence',
    );
    expect(reasonOf(resolveNextRoutineReminder({ occurrences, now, minutesBefore: -1 }))).toBe(
      'reminder_offset',
    );
  });
});

const timedMode: RoutineSchedulingMode = {
  kind: 'time_specific',
  wallTime: wall('07:00'),
  durationMinutes: 30,
  zonePolicy: { kind: 'follow_profile' },
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
};

describe('which targets accept a new reminder', () => {
  it.each([
    ['planned', undefined, 'ok'],
    ['planned', 'b0000000-0000-4000-8000-000000000001', 'reminder_block_not_planned'],
    ['completed', undefined, 'reminder_block_not_planned'],
    ['skipped', undefined, 'reminder_block_not_planned'],
    ['canceled', undefined, 'reminder_block_not_planned'],
  ] as const)('a %s block (superseded by %s) → %s', (state, supersededById, expected) => {
    expect(
      reasonOf(
        checkTimeBlockAcceptsReminder({
          state: state,
          ...(supersededById === undefined ? {} : { supersededById: supersededById as EntityId }),
        }),
      ),
    ).toBe(expected);
  });

  it.each([
    ['active', timedMode, 'ok'],
    ['active', { kind: 'day_flexible' }, 'reminder_routine_not_timed'],
    ['paused', timedMode, 'reminder_routine_not_active'],
    ['archived', timedMode, 'reminder_routine_not_active'],
  ] as const)('an %s Routine (%j) → %s', (state, schedulingMode, expected) => {
    expect(
      reasonOf(
        checkRoutineAcceptsReminder({
          state: state,
          schedulingMode: schedulingMode,
        }),
      ),
    ).toBe(expected);
  });

  it.each([
    ['draft', 'ok'],
    ['skipped', 'ok'],
    ['completed', 'reminder_review_not_open'],
    ['archived', 'reminder_review_not_open'],
  ] as const)('a %s review → %s', (state, expected) => {
    expect(reasonOf(checkReviewAcceptsReminder({ state: state }))).toBe(expected);
  });
});

describe('reminder state', () => {
  it.each([
    [undefined, 'ok'],
    ['scheduled', 'ok'],
    ['canceled', 'ok'],
    ['delivered', 'ok'],
  ] as const)('setting a reminder from %s → %s', (current, expected) => {
    expect(reasonOf(scheduleReminderState(current))).toBe(expected);
  });

  it.each([
    ['scheduled', 'ok'],
    ['canceled', 'reminder_not_scheduled'],
    ['delivered', 'reminder_not_scheduled'],
  ] as const)('turning off a %s reminder → %s', (state, expected) => {
    const result = turnOffReminderState(state);
    expect(reasonOf(result)).toBe(expected);
    if (result.ok) expect(result.value).toBe('canceled');
    else expect(result.error.message).toBe('This reminder is already off.');
  });
});
