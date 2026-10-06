import { countMessage, message as uiMessage, uiLocale } from '../messages';
import type { ApplicationError, PlanProfile } from '@yelaxis/application';
import type {
  CalendarDate,
  DayCapacity,
  HorizonPeriod,
  Instant,
  MonthKey,
  WallTime,
  WeekCapacity,
  WeekPeriod,
} from '@yelaxis/domain';

// Document locale is immutable. Retain only a bounded set of native formatter configurations,
// never dates, instants, wall times, planning content or formatted output.
const formatterLimit = 32;
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([uiLocale, options]);
  const existing = dateTimeFormatters.get(key);
  if (existing !== undefined) {
    dateTimeFormatters.delete(key);
    dateTimeFormatters.set(key, existing);
    return existing;
  }
  const formatter = new Intl.DateTimeFormat(uiLocale, options);
  if (dateTimeFormatters.size === formatterLimit) {
    const oldest = dateTimeFormatters.keys().next().value;
    if (oldest !== undefined) dateTimeFormatters.delete(oldest);
  }
  dateTimeFormatters.set(key, formatter);
  return formatter;
}

/** Neutral duration text, e.g. "12 hours 30 minutes". Never a score. */
export function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  const minuteWords = countMessage(rest, 'duration.minute.one', 'duration.minute.other');
  const hourWords = countMessage(hours, 'duration.hour.one', 'duration.hour.other');
  if (hours === 0) return minuteWords;
  if (rest === 0) return hourWords;
  return uiMessage('duration.both', { hours: hourWords, minutes: minuteWords });
}

/** Compact duration for dense layouts, e.g. "1 h 30 min". */
export function formatShortDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours === 0) return uiMessage('actions-ui.355', { value0: String(rest) });
  return rest === 0
    ? uiMessage('plan.format.2299', { value0: String(hours) })
    : uiMessage('plan.format.2300', { value0: String(hours), value1: String(rest) });
}

export function formatWallTime(
  value: WallTime | string,
  format: PlanProfile['timeFormat'],
): string {
  const [hourText = '0', minuteText = '00'] = value.split(':');
  const hour = Number(hourText);
  if (format === '24_hour') return `${hourText.padStart(2, '0')}:${minuteText}`;
  // A neutral UTC date is used only to format a wall time. It never changes a fixed instant.
  return dateTimeFormatter({
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(Date.UTC(2000, 0, 1, hour, Number(minuteText))));
}

/**
 * The end of an availability window. A wall time cannot say 24:00, so an end of 00:00 after a later
 * start means midnight at the end of that day.
 */
export function formatWindowEnd(
  value: WallTime | string,
  format: PlanProfile['timeFormat'],
): string {
  if (value === '00:00' || value === '00:00:00')
    return format === '24_hour' ? '24:00' : uiMessage('time.midnight');
  return formatWallTime(value, format);
}

const utcNoon = (date: string): Date => new Date(`${date}T12:00:00Z`);

export function formatDate(
  date: CalendarDate | string,
  style: 'long' | 'medium' | 'short' | 'weekday' = 'medium',
): string {
  const options: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
      : style === 'weekday'
        ? { weekday: 'short', month: 'short', day: 'numeric' }
        : style === 'short'
          ? { month: 'short', day: 'numeric' }
          : { month: 'short', day: 'numeric', year: 'numeric' };
  return dateTimeFormatter({ ...options, timeZone: 'UTC' }).format(utcNoon(date));
}

export function formatWeekday(date: CalendarDate | string): string {
  return dateTimeFormatter({ weekday: 'long', timeZone: 'UTC' }).format(utcNoon(date));
}

export function formatWeekRange(week: Pick<WeekPeriod, 'start' | 'end'>): string {
  return `${formatDate(week.start, 'short')} – ${formatDate(week.end, 'medium')}`;
}

export function formatMonth(month: MonthKey | string): string {
  return dateTimeFormatter({
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(utcNoon(`${month}-01`));
}

export function formatMonthShort(month: MonthKey | string): string {
  return dateTimeFormatter({ month: 'short', timeZone: 'UTC' }).format(utcNoon(`${month}-01`));
}

export function formatPeriod(period: HorizonPeriod): string {
  switch (period.kind) {
    case 'day':
      return formatDate(period.date, 'weekday');
    case 'week':
      return uiMessage('plan.plan-month.1314', { value0: formatWeekRange(period) });
    case 'month':
      return formatMonth(period.month);
    case 'year':
      return period.year;
  }
}

/** Local time of an instant in the planning zone for display. */
export function formatInstantTime(
  value: Instant,
  timeZone: string,
  format: PlanProfile['timeFormat'],
): string {
  return dateTimeFormatter({
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: format === '12_hour',
  }).format(new Date(value));
}

type AnyCapacity = Pick<DayCapacity, 'plannedMinutes' | 'overByMinutes'> & {
  readonly availability: DayCapacity['availability'] | WeekCapacity['availability'];
};

/**
 * Calm, factual capacity guidance. Unknown availability is never described as free time, and no
 * percentage, grade, or score is produced.
 */
export function capacitySummary(capacity: AnyCapacity): string {
  const planned = uiMessage('plan.capacity-summary.1208', {
    value0: formatDuration(capacity.plannedMinutes),
  });
  const availability = capacity.availability;
  if (availability.status === 'unknown') return uiMessage('plan.format.2301', { value0: planned });
  if (availability.status === 'partial') {
    const cap =
      availability.capMinutes === undefined
        ? ''
        : uiMessage('plan.format.2302', { value0: formatDuration(availability.capMinutes) });
    return uiMessage('plan.format.2303', {
      value0: planned,
      value1: String(availability.knownDays),
      value2: String(availability.totalDays),
      value3: formatDuration(availability.knownMinutes),
      value4: cap,
    });
  }
  const basis =
    availability.basis === 'cap'
      ? uiMessage('plan.format.2304')
      : availability.basis === 'windows_capped'
        ? uiMessage('plan.format.2305')
        : 'available';
  const over =
    capacity.overByMinutes === undefined
      ? ''
      : uiMessage('plan.format.2306', { value0: formatDuration(capacity.overByMinutes) });
  return uiMessage('plan.format.2307', {
    value0: planned,
    value1: formatDuration(availability.minutes),
    value2: basis,
    value3: over,
  });
}

export function applicationErrorMessage(error: ApplicationError): string {
  switch (error.code) {
    case 'domain_rejected':
      return error.domainError.message;
    case 'revision_conflict':
      return uiMessage('plan.format.2308');
    case 'undo_unavailable':
      return uiMessage('actions-ui.361');
    case 'entity_not_found':
      return uiMessage('alignment.link-dialogs.551');
    case 'transaction_failed':
      return uiMessage('actions-ui.363');
    case 'entity_already_exists':
    case 'identity_unavailable':
    case 'invalid_command_plan':
    case 'no_active_identity':
    case 'owner_mismatch':
      return uiMessage('actions-ui.364');
  }
}

/** Local calendar date string for the browser (used only to seed date inputs). */
export function browserToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
