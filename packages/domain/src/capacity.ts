import { Temporal } from '@js-temporal/polyfill';

import type { Instant } from './contracts.js';
import {
  datesInRange,
  localDayBounds,
  overlapMinutes,
  weekdayOf,
  type DateRange,
} from './horizons.js';
import type { CalendarDate, IanaTimeZone, WallTime, Weekday } from './time.js';

/** One user-defined weekly availability window in local wall time. */
export interface AvailabilityWindow {
  readonly weekday: Weekday;
  readonly start: WallTime;
  readonly end: WallTime;
}

/** A user-defined upper limit for one day or one week. */
export interface CapacityCap {
  readonly period: 'day' | 'week';
  readonly minutes: number;
}

export interface CapacityRules {
  readonly windows: readonly AvailabilityWindow[];
  readonly caps: readonly CapacityCap[];
}

/** Scheduled work that counts toward planned load. Canceled and skipped work is excluded. */
export interface PlannedWork {
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly state: 'planned' | 'completed' | 'skipped' | 'canceled';
}

export type AvailabilityBasis = 'windows' | 'cap' | 'windows_capped';

export type DayAvailability =
  | { readonly status: 'known'; readonly minutes: number; readonly basis: AvailabilityBasis }
  | { readonly status: 'unknown' };

export type WeekAvailability =
  | { readonly status: 'known'; readonly minutes: number; readonly basis: AvailabilityBasis }
  | {
      readonly status: 'partial';
      readonly knownMinutes: number;
      readonly knownDays: number;
      readonly totalDays: number;
      readonly capMinutes?: number;
    }
  | { readonly status: 'unknown' };

export interface DayCapacity {
  readonly date: CalendarDate;
  readonly plannedMinutes: number;
  readonly availability: DayAvailability;
  /** Present only when availability is known and planned work exceeds it. */
  readonly overByMinutes?: number;
}

export interface WeekCapacity {
  readonly range: DateRange;
  readonly plannedMinutes: number;
  readonly availability: WeekAvailability;
  readonly days: readonly DayCapacity[];
  readonly overByMinutes?: number;
}

interface WallInterval {
  readonly start: number;
  readonly end: number;
}

const endOfDayMinutes = 24 * 60;

const minutesOfDay = (value: WallTime): number => {
  const time = Temporal.PlainTime.from(value);
  return time.hour * 60 + time.minute;
};

const isMidnight = (value: WallTime): boolean =>
  Temporal.PlainTime.compare(Temporal.PlainTime.from(value), new Temporal.PlainTime()) === 0;

/**
 * Local minutes after midnight covered by one window. A wall time cannot say 24:00, so an end of
 * 00:00 after a later start means "until the end of that day" (1440).
 */
const windowInterval = (window: Pick<AvailabilityWindow, 'start' | 'end'>): WallInterval => {
  const start = minutesOfDay(window.start);
  const end =
    isMidnight(window.end) && !isMidnight(window.start)
      ? endOfDayMinutes
      : minutesOfDay(window.end);
  return { start, end };
};

/** A window must end after it starts; an end of 00:00 is the end of the day unless it starts then. */
export const isAvailabilityWindowOrdered = (start: WallTime, end: WallTime): boolean => {
  if (isMidnight(end)) return !isMidnight(start);
  return (
    Temporal.PlainTime.compare(Temporal.PlainTime.from(start), Temporal.PlainTime.from(end)) < 0
  );
};

/** Merge overlapping or touching local windows so shared time is never counted twice. */
export const mergeAvailabilityWindows = (
  windows: readonly Pick<AvailabilityWindow, 'start' | 'end'>[],
): readonly WallInterval[] => {
  const intervals = windows
    .map(windowInterval)
    .filter((window) => window.start < window.end)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: WallInterval[] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last !== undefined && interval.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, interval.end) };
    } else {
      merged.push(interval);
    }
  }
  return merged;
};

/**
 * Elapsed minutes of the merged local windows on one date. Wall times are resolved in the planning
 * zone with the default DST policy so a window across a transition reflects real elapsed time.
 */
const windowMinutesOnDate = (
  date: CalendarDate,
  windows: readonly WallInterval[],
  timeZone: IanaTimeZone,
): number => {
  const plainDate = Temporal.PlainDate.from(date);
  let total = 0;
  for (const window of windows) {
    const start = plainDate
      .toPlainDateTime({ hour: Math.floor(window.start / 60), minute: window.start % 60 })
      .toZonedDateTime(timeZone, { disambiguation: 'compatible' });
    const endDateTime =
      window.end === endOfDayMinutes
        ? plainDate.add({ days: 1 }).toPlainDateTime({ hour: 0 })
        : plainDate.toPlainDateTime({ hour: Math.floor(window.end / 60), minute: window.end % 60 });
    const end = endDateTime.toZonedDateTime(timeZone, { disambiguation: 'compatible' });
    const minutes = Number((end.epochNanoseconds - start.epochNanoseconds) / 60_000_000_000n);
    total += Math.max(0, minutes);
  }
  return total;
};

const lowestCap = (
  caps: readonly CapacityCap[],
  period: CapacityCap['period'],
): number | undefined => {
  const values = caps
    .filter((cap) => cap.period === period && Number.isInteger(cap.minutes) && cap.minutes >= 0)
    .map((cap) => cap.minutes);
  return values.length === 0 ? undefined : Math.min(...values);
};

/**
 * Day availability is the union of that weekday's windows. A day cap limits it; a cap alone is the
 * explicit limit. A day without windows or cap is unknown and is never treated as free.
 */
export const dayAvailability = (
  date: CalendarDate,
  rules: CapacityRules,
  timeZone: IanaTimeZone,
): DayAvailability => {
  const weekday = weekdayOf(date);
  const windows = mergeAvailabilityWindows(
    rules.windows.filter((window) => window.weekday === weekday),
  );
  const cap = lowestCap(rules.caps, 'day');
  if (windows.length === 0) {
    return cap === undefined
      ? { status: 'unknown' }
      : { status: 'known', minutes: cap, basis: 'cap' };
  }
  const windowMinutes = windowMinutesOnDate(date, windows, timeZone);
  if (cap !== undefined && cap < windowMinutes) {
    return { status: 'known', minutes: cap, basis: 'windows_capped' };
  }
  return { status: 'known', minutes: windowMinutes, basis: 'windows' };
};

/** Planned load for one local date: planned and completed work, clipped to that date. */
export const plannedMinutesOnDate = (
  date: CalendarDate,
  work: readonly PlannedWork[],
  timeZone: IanaTimeZone,
): number => {
  const bounds = localDayBounds(date, timeZone);
  return work
    .filter((item) => item.state === 'planned' || item.state === 'completed')
    .reduce((total, item) => total + overlapMinutes(item, bounds), 0);
};

export const calculateDayCapacity = (
  date: CalendarDate,
  work: readonly PlannedWork[],
  rules: CapacityRules,
  timeZone: IanaTimeZone,
): DayCapacity => {
  const plannedMinutes = plannedMinutesOnDate(date, work, timeZone);
  const availability = dayAvailability(date, rules, timeZone);
  return {
    date,
    plannedMinutes,
    availability,
    ...(availability.status === 'known' && plannedMinutes > availability.minutes
      ? { overByMinutes: plannedMinutes - availability.minutes }
      : {}),
  };
};

/**
 * Week availability sums its seven derived days. A week cap limits a fully known week, is the
 * explicit limit when no day is known, and is reported beside partially specified days.
 */
export const calculateWeekCapacity = (
  range: DateRange,
  work: readonly PlannedWork[],
  rules: CapacityRules,
  timeZone: IanaTimeZone,
): WeekCapacity => {
  const days = datesInRange(range).map((date) => calculateDayCapacity(date, work, rules, timeZone));
  const plannedMinutes = days.reduce((total, day) => total + day.plannedMinutes, 0);
  const known = days.filter(
    (day): day is DayCapacity & { availability: { status: 'known'; minutes: number } } =>
      day.availability.status === 'known',
  );
  const knownMinutes = known.reduce((total, day) => total + day.availability.minutes, 0);
  const weekCap = lowestCap(rules.caps, 'week');
  let availability: WeekAvailability;
  if (known.length === days.length) {
    availability =
      weekCap !== undefined && weekCap < knownMinutes
        ? { status: 'known', minutes: weekCap, basis: 'windows_capped' }
        : {
            status: 'known',
            minutes: knownMinutes,
            basis: known.every((day) => day.availability.basis === 'cap') ? 'cap' : 'windows',
          };
  } else if (known.length === 0) {
    availability =
      weekCap === undefined
        ? { status: 'unknown' }
        : { status: 'known', minutes: weekCap, basis: 'cap' };
  } else if (weekCap !== undefined && knownMinutes >= weekCap) {
    availability = { status: 'known', minutes: weekCap, basis: 'windows_capped' };
  } else {
    availability = {
      status: 'partial',
      knownMinutes,
      knownDays: known.length,
      totalDays: days.length,
      ...(weekCap === undefined ? {} : { capMinutes: weekCap }),
    };
  }
  return {
    range,
    plannedMinutes,
    availability,
    days,
    ...(availability.status === 'known' && plannedMinutes > availability.minutes
      ? { overByMinutes: plannedMinutes - availability.minutes }
      : {}),
  };
};
