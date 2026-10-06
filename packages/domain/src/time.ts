import { Temporal } from '@js-temporal/polyfill';

import { err, ok, type Brand, type Clock, type DomainResult, type Instant } from './contracts.js';
import type { ActionState } from './states.js';

export type CalendarDate = Brand<string, 'CalendarDate'>;
export type WallTime = Brand<string, 'WallTime'>;
export type IanaTimeZone = Brand<string, 'IanaTimeZone'>;
export type MonthKey = Brand<string, 'MonthKey'>;
export type YearKey = Brand<string, 'YearKey'>;

export type Weekday =
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface FixedInterval {
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly timeZone: IanaTimeZone;
}

export interface TargetWindow {
  readonly start?: CalendarDate;
  readonly end?: CalendarDate;
}

export type DueValue =
  | { readonly kind: 'date'; readonly date: CalendarDate }
  | {
      readonly kind: 'instant';
      readonly instant: Instant;
      readonly authoredTimeZone: IanaTimeZone;
    };

export interface DayPeriod {
  readonly kind: 'day';
  readonly date: CalendarDate;
}

export interface WeekPeriod {
  readonly kind: 'week';
  readonly start: CalendarDate;
  readonly end: CalendarDate;
  readonly weekStart: Weekday;
}

export interface MonthPeriod {
  readonly kind: 'month';
  readonly month: MonthKey;
}

export interface YearPeriod {
  readonly kind: 'year';
  readonly year: YearKey;
}

export type HorizonPeriod = DayPeriod | WeekPeriod | MonthPeriod | YearPeriod;
export type DstGapPolicy = 'shift_forward' | 'skip';
export type DstOverlapPolicy = 'earlier_offset' | 'later_offset';

export interface FloatingDateTimeInput {
  readonly date: CalendarDate;
  readonly wallTime: WallTime;
  readonly timeZone: IanaTimeZone;
  readonly gapPolicy: DstGapPolicy;
  readonly overlapPolicy: DstOverlapPolicy;
}

const instantError = (): DomainResult<never> =>
  err({ code: 'invalid_time', message: 'Value must be a canonical RFC 3339 UTC instant.' });

const instantString = (value: Temporal.Instant): Instant =>
  value.toString({ smallestUnit: 'millisecond' }) as Instant;

export const parseInstant = (value: string): DomainResult<Instant> => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) {
    return instantError();
  }

  try {
    return ok(instantString(Temporal.Instant.from(value)));
  } catch {
    return instantError();
  }
};

export const parseCalendarDate = (value: string): DomainResult<CalendarDate> => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return err({ code: 'invalid_time', message: 'Value must be a valid calendar date.' });
  }

  try {
    const parsed = Temporal.PlainDate.from(value, { overflow: 'reject' });
    if (parsed.toString() !== value) throw new RangeError('Non-canonical date');
    return ok(value as CalendarDate);
  } catch {
    return err({ code: 'invalid_time', message: 'Value must be a valid calendar date.' });
  }
};

export const parseWallTime = (value: string): DomainResult<WallTime> => {
  if (!/^\d{2}:\d{2}(?::\d{2})?$/u.test(value)) {
    return err({ code: 'invalid_time', message: 'Value must be a valid wall time.' });
  }

  try {
    const parsed = Temporal.PlainTime.from(value, { overflow: 'reject' });
    const canonical = parsed.toString({ smallestUnit: value.length === 5 ? 'minute' : 'second' });
    if (canonical !== value) throw new RangeError('Non-canonical time');
    return ok(value as WallTime);
  } catch {
    return err({ code: 'invalid_time', message: 'Value must be a valid wall time.' });
  }
};

export const parseIanaTimeZone = (value: string): DomainResult<IanaTimeZone> => {
  if (/^[+-]\d{2}:\d{2}$/u.test(value)) {
    return err({ code: 'invalid_time_zone', message: 'Value must be a valid IANA time zone.' });
  }

  try {
    const sample = Temporal.ZonedDateTime.from({
      timeZone: value,
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
    });
    return ok(sample.timeZoneId as IanaTimeZone);
  } catch {
    return err({ code: 'invalid_time_zone', message: 'Value must be a valid IANA time zone.' });
  }
};

export const createFixedInterval = (
  startsAt: Instant,
  endsAt: Instant,
  timeZone: IanaTimeZone,
): DomainResult<FixedInterval> => {
  if (Temporal.Instant.compare(startsAt, endsAt) >= 0) {
    return err({
      code: 'invalid_interval',
      message: 'A fixed interval must end after it starts.',
    });
  }

  return ok({ startsAt, endsAt, timeZone });
};

export const fixedIntervalDurationMinutes = (interval: FixedInterval): number =>
  Number(
    (Temporal.Instant.from(interval.endsAt).epochNanoseconds -
      Temporal.Instant.from(interval.startsAt).epochNanoseconds) /
      60_000_000_000n,
  );

export const createTargetWindow = (window: TargetWindow): DomainResult<TargetWindow> => {
  if (window.start === undefined && window.end === undefined) {
    return err({
      code: 'invalid_target_window',
      message: 'A target window requires at least one boundary.',
    });
  }

  if (window.start !== undefined && window.end !== undefined && window.start > window.end) {
    return err({
      code: 'invalid_target_window',
      message: 'A target window cannot end before it starts.',
    });
  }

  return ok(window);
};

export const currentPlanningDate = (clock: Clock, planningTimeZone: IanaTimeZone): CalendarDate =>
  Temporal.Instant.from(clock.now())
    .toZonedDateTimeISO(planningTimeZone)
    .toPlainDate()
    .toString() as CalendarDate;

export const isActionOverdue = (
  state: ActionState,
  due: DueValue | undefined,
  clock: Clock,
  planningTimeZone: IanaTimeZone,
): boolean => {
  if (due === undefined || state === 'completed' || state === 'canceled' || state === 'archived') {
    return false;
  }

  if (due.kind === 'date') {
    return currentPlanningDate(clock, planningTimeZone) > due.date;
  }

  return Temporal.Instant.compare(clock.now(), due.instant) > 0;
};

export interface ZonedDisplayValue {
  readonly date: CalendarDate;
  readonly time: WallTime;
  readonly offset: string;
}

export const formatInstantInZone = (value: Instant, timeZone: IanaTimeZone): ZonedDisplayValue => {
  const zoned = Temporal.Instant.from(value).toZonedDateTimeISO(timeZone);
  return {
    date: zoned.toPlainDate().toString() as CalendarDate,
    time: zoned.toPlainTime().toString({ smallestUnit: 'minute' }) as WallTime,
    offset: zoned.offset,
  };
};

const weekdays: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export const createDayPeriod = (date: CalendarDate): DayPeriod => ({ kind: 'day', date });

export const createWeekPeriod = (date: CalendarDate, weekStart: Weekday): WeekPeriod => {
  const plainDate = Temporal.PlainDate.from(date);
  const startIndex = weekdays.indexOf(weekStart) + 1;
  const daysSinceStart = (plainDate.dayOfWeek - startIndex + 7) % 7;
  const start = plainDate.subtract({ days: daysSinceStart });
  return {
    kind: 'week',
    start: start.toString() as CalendarDate,
    end: start.add({ days: 6 }).toString() as CalendarDate,
    weekStart,
  };
};

export const createMonthPeriod = (date: CalendarDate): MonthPeriod => ({
  kind: 'month',
  month: date.slice(0, 7) as MonthKey,
});

export const createYearPeriod = (date: CalendarDate): YearPeriod => ({
  kind: 'year',
  year: date.slice(0, 4) as YearKey,
});

const toFloatingFields = (input: FloatingDateTimeInput) => {
  const date = Temporal.PlainDate.from(input.date);
  const time = Temporal.PlainTime.from(input.wallTime);
  return {
    timeZone: input.timeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
    millisecond: time.millisecond,
    microsecond: time.microsecond,
    nanosecond: time.nanosecond,
  };
};

export const resolveFloatingDateTime = (
  input: FloatingDateTimeInput,
): DomainResult<Instant | null> => {
  const fields = toFloatingFields(input);

  try {
    const unique = Temporal.ZonedDateTime.from(fields, { disambiguation: 'reject' });
    return ok(instantString(unique.toInstant()));
  } catch {
    const requested = Temporal.PlainDateTime.from({
      year: fields.year,
      month: fields.month,
      day: fields.day,
      hour: fields.hour,
      minute: fields.minute,
      second: fields.second,
      millisecond: fields.millisecond,
      microsecond: fields.microsecond,
      nanosecond: fields.nanosecond,
    });
    const earlier = Temporal.ZonedDateTime.from(fields, { disambiguation: 'earlier' });
    const later = Temporal.ZonedDateTime.from(fields, { disambiguation: 'later' });
    const isOverlap =
      earlier.toPlainDateTime().equals(requested) && later.toPlainDateTime().equals(requested);

    if (!isOverlap && input.gapPolicy === 'skip') {
      return ok(null);
    }

    if (isOverlap) {
      return ok(
        instantString((input.overlapPolicy === 'earlier_offset' ? earlier : later).toInstant()),
      );
    }

    const shifted = Temporal.ZonedDateTime.from(fields, { disambiguation: 'compatible' });
    return ok(instantString(shifted.toInstant()));
  }
};
