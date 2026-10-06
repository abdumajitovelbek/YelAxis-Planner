import { Temporal } from '@js-temporal/polyfill';

import { err, ok, type DomainResult, type Instant } from './contracts.js';
import {
  createWeekPeriod,
  parseCalendarDate,
  type CalendarDate,
  type HorizonPeriod,
  type IanaTimeZone,
  type MonthKey,
  type WallTime,
  type WeekPeriod,
  type Weekday,
  type YearKey,
} from './time.js';

export const weekdays: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export interface DateRange {
  readonly start: CalendarDate;
  readonly end: CalendarDate;
}

/** Half-open instant bounds of one local calendar date in a planning zone. */
export interface LocalDayBounds {
  readonly date: CalendarDate;
  readonly startsAt: Instant;
  readonly endsAt: Instant;
}

const instantString = (value: Temporal.Instant): Instant =>
  value.toString({ smallestUnit: 'millisecond' }) as Instant;

export const parseMonthKey = (value: string): DomainResult<MonthKey> => {
  if (!/^\d{4}-\d{2}$/u.test(value)) {
    return err({ code: 'invalid_time', message: 'Value must be a valid month.' });
  }
  try {
    if (Temporal.PlainYearMonth.from(value).toString() !== value) throw new RangeError('month');
    return ok(value as MonthKey);
  } catch {
    return err({ code: 'invalid_time', message: 'Value must be a valid month.' });
  }
};

export const parseYearKey = (value: string): DomainResult<YearKey> =>
  /^\d{4}$/u.test(value) && Number(value) >= 1
    ? ok(value as YearKey)
    : err({ code: 'invalid_time', message: 'Value must be a valid year.' });

export const addDays = (date: CalendarDate, days: number): CalendarDate =>
  Temporal.PlainDate.from(date).add({ days }).toString() as CalendarDate;

export const daysBetween = (from: CalendarDate, to: CalendarDate): number =>
  Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: 'day' }).days;

export const weekdayOf = (date: CalendarDate): Weekday => {
  const weekday = weekdays[Temporal.PlainDate.from(date).dayOfWeek - 1];
  if (weekday === undefined) throw new RangeError('Invalid weekday.');
  return weekday;
};

export const datesInRange = (range: DateRange): readonly CalendarDate[] => {
  const output: CalendarDate[] = [];
  let cursor = range.start;
  while (cursor <= range.end) {
    output.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return output;
};

export const monthRange = (month: MonthKey): DateRange => {
  const value = Temporal.PlainYearMonth.from(month);
  return {
    start: value.toPlainDate({ day: 1 }).toString() as CalendarDate,
    end: value.toPlainDate({ day: value.daysInMonth }).toString() as CalendarDate,
  };
};

export const yearRange = (year: YearKey): DateRange => ({
  start: `${year}-01-01` as CalendarDate,
  end: `${year}-12-31` as CalendarDate,
});

export const periodRange = (period: HorizonPeriod): DateRange => {
  switch (period.kind) {
    case 'day':
      return { start: period.date, end: period.date };
    case 'week':
      return { start: period.start, end: period.end };
    case 'month':
      return monthRange(period.month);
    case 'year':
      return yearRange(period.year);
  }
};

export const rangesOverlap = (left: DateRange, right: DateRange): boolean =>
  left.start <= right.end && right.start <= left.end;

/** Every planning Week that contains at least one day of the Month, in calendar order. */
export const weeksOfMonth = (month: MonthKey, weekStart: Weekday): readonly WeekPeriod[] => {
  const range = monthRange(month);
  const weeks: WeekPeriod[] = [];
  let week = createWeekPeriod(range.start, weekStart);
  while (week.start <= range.end) {
    weeks.push(week);
    week = createWeekPeriod(addDays(week.end, 1), weekStart);
  }
  return weeks;
};

export const monthsOfYear = (year: YearKey): readonly MonthKey[] =>
  Array.from(
    { length: 12 },
    (_, index) => `${year}-${String(index + 1).padStart(2, '0')}` as MonthKey,
  );

export const quarterOfMonth = (month: MonthKey): 1 | 2 | 3 | 4 =>
  (Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4;

export const localDayBounds = (date: CalendarDate, timeZone: IanaTimeZone): LocalDayBounds => {
  const plain = Temporal.PlainDate.from(date);
  return {
    date,
    startsAt: instantString(plain.toZonedDateTime({ timeZone }).toInstant()),
    endsAt: instantString(plain.add({ days: 1 }).toZonedDateTime({ timeZone }).toInstant()),
  };
};

/** Instant bounds covering every local day of a date range in the planning zone. */
export const localRangeBounds = (
  range: DateRange,
  timeZone: IanaTimeZone,
): { readonly startsAt: Instant; readonly endsAt: Instant } => ({
  startsAt: localDayBounds(range.start, timeZone).startsAt,
  endsAt: localDayBounds(range.end, timeZone).endsAt,
});

export const localDateOf = (value: Instant, timeZone: IanaTimeZone): CalendarDate =>
  Temporal.Instant.from(value)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString() as CalendarDate;

export const localWallTimeOf = (value: Instant, timeZone: IanaTimeZone): WallTime =>
  Temporal.Instant.from(value)
    .toZonedDateTimeISO(timeZone)
    .toPlainTime()
    .toString({ smallestUnit: 'minute' }) as WallTime;

/** Minutes of `[startsAt, endsAt)` that fall inside `[boundsStart, boundsEnd)`. */
export const overlapMinutes = (
  interval: { readonly startsAt: Instant; readonly endsAt: Instant },
  bounds: { readonly startsAt: Instant; readonly endsAt: Instant },
): number => {
  const start = maxInstant(interval.startsAt, bounds.startsAt);
  const end = minInstant(interval.endsAt, bounds.endsAt);
  if (Temporal.Instant.compare(start, end) >= 0) return 0;
  return Number(
    (Temporal.Instant.from(end).epochNanoseconds - Temporal.Instant.from(start).epochNanoseconds) /
      60_000_000_000n,
  );
};

export const intervalsIntersect = (
  left: { readonly startsAt: Instant; readonly endsAt: Instant },
  right: { readonly startsAt: Instant; readonly endsAt: Instant },
): boolean =>
  Temporal.Instant.compare(left.startsAt, right.endsAt) < 0 &&
  Temporal.Instant.compare(right.startsAt, left.endsAt) < 0;

export const addMinutes = (value: Instant, minutes: number): Instant =>
  instantString(Temporal.Instant.from(value).add({ minutes }));

const maxInstant = (left: Instant, right: Instant): Instant =>
  Temporal.Instant.compare(left, right) >= 0 ? left : right;
const minInstant = (left: Instant, right: Instant): Instant =>
  Temporal.Instant.compare(left, right) <= 0 ? left : right;

/** Parse a user-provided date string and return the containing Horizon period. */
export const periodContaining = (
  kind: HorizonPeriod['kind'],
  value: string,
  weekStart: Weekday,
): DomainResult<HorizonPeriod> => {
  const date = parseCalendarDate(value);
  if (!date.ok) return date;
  switch (kind) {
    case 'day':
      return ok({ kind: 'day', date: date.value });
    case 'week':
      return ok(createWeekPeriod(date.value, weekStart));
    case 'month':
      return ok({ kind: 'month', month: date.value.slice(0, 7) as MonthKey });
    case 'year':
      return ok({ kind: 'year', year: date.value.slice(0, 4) as YearKey });
  }
};

export interface ResolvedLocalInterval {
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly localStart: WallTime;
  readonly localEnd: WallTime;
  readonly localEndDate: CalendarDate;
  readonly utcOffset: string;
  /** Present when a default DST policy applied: gap shifts forward, repeated time uses the earlier offset. */
  readonly adjustment?: 'dst_gap_shifted' | 'dst_repeated_earlier';
}

/**
 * Resolve a user-entered local start plus an explicit duration in a zone. Fixed intervals keep
 * their absolute duration; the DST gap/repeated-time defaults are reported so the UI can preview them.
 */
export const resolveLocalInterval = (
  date: CalendarDate,
  wallTime: WallTime,
  durationMinutes: number,
  timeZone: IanaTimeZone,
): ResolvedLocalInterval => {
  const requested = Temporal.PlainDate.from(date).toPlainDateTime(
    Temporal.PlainTime.from(wallTime),
  );
  const earlier = requested.toZonedDateTime(timeZone, { disambiguation: 'earlier' });
  const later = requested.toZonedDateTime(timeZone, { disambiguation: 'later' });
  const gap = !earlier.toPlainDateTime().equals(requested);
  const repeated = !gap && !earlier.equals(later);
  const start = gap
    ? requested.toZonedDateTime(timeZone, { disambiguation: 'compatible' })
    : earlier;
  const end = start.toInstant().add({ minutes: durationMinutes }).toZonedDateTimeISO(timeZone);
  return {
    startsAt: instantString(start.toInstant()),
    endsAt: instantString(end.toInstant()),
    localStart: start.toPlainTime().toString({ smallestUnit: 'minute' }) as WallTime,
    localEnd: end.toPlainTime().toString({ smallestUnit: 'minute' }) as WallTime,
    localEndDate: end.toPlainDate().toString() as CalendarDate,
    utcOffset: start.offset,
    ...(gap ? { adjustment: 'dst_gap_shifted' as const } : {}),
    ...(repeated ? { adjustment: 'dst_repeated_earlier' as const } : {}),
  };
};
