import { Temporal } from '@js-temporal/polyfill';

import { resolveActionReminder, type ActionReminderInput } from './actions.js';
import { err, ok, type DomainResult, type EntityId, type Instant } from './contracts.js';
import type { ReminderSchedule, RoutineSchedulingMode } from './entities.js';
import type { OccurrenceTiming } from './routines.js';
import {
  transitionLifecycle,
  type ReminderState,
  type ReviewState,
  type RoutineState,
  type TimeBlockState,
} from './states.js';
import {
  parseCalendarDate,
  parseInstant,
  parseWallTime,
  type CalendarDate,
  type IanaTimeZone,
  type WallTime,
} from './time.js';

/**
 * Review reminder definitions for Time Blocks, timed Routines, and saved reviews.
 * Everything here is pure resolution and validation: nothing asks for notification permission,
 * schedules anything, or delivers a notification. Stored schedules follow the Action
 * convention: `at` keeps a resolved instant with its IANA zone, and `relative` keeps the resolved
 * instant plus a signed offset where a negative value means before the anchor.
 */

export const reminderLimits = Object.freeze({
  /** A reminder may be at most seven days before its anchor, like the Action reminder. */
  minutesBefore: 10_080,
});

/** A Time Block reminder as the person chose it: a date and wall time, or minutes before the start. */
export type TimeBlockReminderRequest =
  | { readonly kind: 'at'; readonly date: CalendarDate; readonly time: WallTime }
  | { readonly kind: 'relative'; readonly minutesBefore: number };

/** A timed Routine reminder as the person chose it: minutes before each occurrence's start. */
export interface RoutineReminderRequest {
  readonly minutesBefore: number;
}

/** A review's "Remind me to finish" reminder: a date and wall time in the planning zone. */
export interface ReviewReminderRequest {
  readonly date: CalendarDate;
  readonly time: WallTime;
}

/* ───────────────────────── Errors ───────────────────────── */

export type ReminderInvalidReason =
  | 'reminder_shape'
  | 'reminder_fields'
  | 'reminder_kind'
  | 'reminder_date'
  | 'reminder_time'
  | 'reminder_offset'
  | 'reminder_time_skipped';

const malformedMessage = 'This reminder is not valid. Refresh and try again.';

const invalidMessages: Readonly<Record<ReminderInvalidReason, string>> = Object.freeze({
  reminder_shape: malformedMessage,
  reminder_fields: malformedMessage,
  reminder_kind: malformedMessage,
  reminder_date: 'Choose a valid date for the reminder.',
  reminder_time: 'Enter a valid time for the reminder, such as 07:30.',
  reminder_offset: 'Choose from 0 to 10,080 minutes before.',
  reminder_time_skipped:
    'That time does not exist on that day because of a clock change. Choose another time.',
});

const isInvalidReason = (value: unknown): value is ReminderInvalidReason =>
  typeof value === 'string' && Object.hasOwn(invalidMessages, value);

const invalid = (reason: ReminderInvalidReason): DomainResult<never> =>
  err({ code: 'invalid_value', message: invalidMessages[reason], details: { reason } });

const notAccepted = (reason: string, message: string): DomainResult<never> =>
  err({ code: 'invalid_transition', message, details: { reason } });

/** Keep the shared resolver's reason, but say it about the reminder rather than an Action. */
const asReminderResult = (
  result: DomainResult<ReminderSchedule>,
): DomainResult<ReminderSchedule> => {
  if (result.ok) {
    const schedule = result.value;
    // A date whose instant falls outside the years 0000-9999 in UTC has no canonical instant to
    // store, so it is refused here rather than failing the write.
    if (!parseInstant(schedule.remindAt).ok) return invalid('reminder_date');
    // `-0` (zero minutes before) is stored as 0, so equal documents compare equal.
    return schedule.kind === 'relative' && schedule.offsetMinutes === 0
      ? ok({ ...schedule, offsetMinutes: 0 })
      : result;
  }
  const reason = result.error.details?.['reason'];
  return isInvalidReason(reason) ? invalid(reason) : invalid('reminder_shape');
};

/* ───────────────────────── Untrusted input ───────────────────────── */

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Exactly these own keys: no missing field and no unexpected one. */
const hasExactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const isMinutesBefore = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= reminderLimits.minutesBefore;

/** A calendar date and a wall time, each a canonical string. */
const parseDateAndTime = (
  date: unknown,
  time: unknown,
): DomainResult<{ readonly date: CalendarDate; readonly time: WallTime }> => {
  const parsedDate = typeof date === 'string' ? parseCalendarDate(date) : null;
  if (parsedDate === null || !parsedDate.ok) return invalid('reminder_date');
  const parsedTime = typeof time === 'string' ? parseWallTime(time) : null;
  if (parsedTime === null || !parsedTime.ok) return invalid('reminder_time');
  return ok({ date: parsedDate.value, time: parsedTime.value });
};

/**
 * Validate an untrusted Time Block reminder request: `{ kind: 'at', date, time }` with a calendar
 * date and a wall time, or `{ kind: 'relative', minutesBefore }` with 0 to 10,080 minutes. Any other
 * shape, value, or extra field is refused.
 */
export const parseTimeBlockReminderRequest = (
  value: unknown,
): DomainResult<TimeBlockReminderRequest> => {
  if (!isPlainRecord(value)) return invalid('reminder_shape');
  if (value['kind'] === 'at') {
    if (!hasExactKeys(value, ['kind', 'date', 'time'])) return invalid('reminder_fields');
    const parsed = parseDateAndTime(value['date'], value['time']);
    return parsed.ok ? ok({ kind: 'at', ...parsed.value }) : parsed;
  }
  if (value['kind'] === 'relative') {
    if (!hasExactKeys(value, ['kind', 'minutesBefore'])) return invalid('reminder_fields');
    const minutesBefore = value['minutesBefore'];
    if (!isMinutesBefore(minutesBefore)) return invalid('reminder_offset');
    return ok({ kind: 'relative', minutesBefore });
  }
  return invalid('reminder_kind');
};

/** Validate an untrusted timed Routine reminder request: exactly `{ minutesBefore }`, 0 to 10,080. */
export const parseRoutineReminderRequest = (
  value: unknown,
): DomainResult<RoutineReminderRequest> => {
  if (!isPlainRecord(value)) return invalid('reminder_shape');
  if (!hasExactKeys(value, ['minutesBefore'])) return invalid('reminder_fields');
  const minutesBefore = value['minutesBefore'];
  if (!isMinutesBefore(minutesBefore)) return invalid('reminder_offset');
  return ok({ minutesBefore });
};

/** Validate an untrusted review reminder request: exactly `{ date, time }`. */
export const parseReviewReminderRequest = (value: unknown): DomainResult<ReviewReminderRequest> => {
  if (!isPlainRecord(value)) return invalid('reminder_shape');
  if (!hasExactKeys(value, ['date', 'time'])) return invalid('reminder_fields');
  return parseDateAndTime(value['date'], value['time']);
};

/* ───────────────────────── Resolution ───────────────────────── */

/**
 * A date and wall time read in `timeZone` exactly like the Action reminder: a time skipped by a
 * clock change moves forward to the next valid time, and a repeated time uses its earlier
 * occurrence.
 */
const resolveAt = (
  date: CalendarDate,
  time: WallTime,
  timeZone: IanaTimeZone,
): DomainResult<ReminderSchedule> =>
  asReminderResult(
    resolveActionReminder({
      kind: 'at',
      date,
      wallTime: time,
      timeZone,
      gapPolicy: 'shift_forward',
      overlapPolicy: 'earlier_offset',
    }),
  );

/** `minutesBefore` before `anchor`, stored with a negative offset. */
const resolveBefore = (
  anchor: Instant,
  minutesBefore: number,
  timeZone: IanaTimeZone,
): DomainResult<ReminderSchedule> => {
  const input: ActionReminderInput = {
    kind: 'relative',
    anchor,
    offsetMinutes: minutesBefore,
    timeZone,
  };
  return asReminderResult(resolveActionReminder(input));
};

/**
 * Resolve a Time Block reminder. `at` reads the date and wall time in `timeZone` (the planning zone
 * the person chose it in); `relative` is the block start minus the minutes.
 */
export const resolveTimeBlockReminder = (
  request: TimeBlockReminderRequest,
  context: { readonly blockStart: Instant; readonly timeZone: IanaTimeZone },
): DomainResult<ReminderSchedule> =>
  request.kind === 'at'
    ? resolveAt(request.date, request.time, context.timeZone)
    : resolveBefore(context.blockStart, request.minutesBefore, context.timeZone);

/** Resolve a review reminder: a date and wall time read in the planning zone. */
export const resolveReviewReminder = (
  request: ReviewReminderRequest,
  context: { readonly timeZone: IanaTimeZone },
): DomainResult<ReminderSchedule> => resolveAt(request.date, request.time, context.timeZone);

/**
 * Resolve a timed Routine reminder from one occurrence's start: `minutesBefore` before it, stored as
 * a relative schedule whose offset the notification application resolves for each later occurrence.
 */
export const resolveRoutineReminder = (input: {
  readonly occurrenceStart: Instant;
  readonly minutesBefore: number;
  readonly timeZone: IanaTimeZone;
}): DomainResult<ReminderSchedule> =>
  resolveBefore(input.occurrenceStart, input.minutesBefore, input.timeZone);

const instantMillis = (value: Instant): number => Temporal.Instant.from(value).epochMilliseconds;

/** An occurrence as the reminder sees it: its state and its timing. */
export interface ReminderOccurrence {
  readonly state: string;
  readonly timing: OccurrenceTiming;
}

/**
 * The occurrence a Routine reminder is resolved from: the earliest planned occurrence with a set time
 * whose reminder (`start - minutesBefore`) is not before `now`. Flexible, weekly-count, and
 * clock-change-skipped occurrences have no start, so they never anchor a reminder. `null` when no
 * such occurrence is among `occurrences`.
 */
export const nextReminderOccurrence = (
  occurrences: readonly ReminderOccurrence[],
  now: Instant,
  minutesBefore: number,
): { readonly startsAt: Instant; readonly timeZone: IanaTimeZone } | null => {
  const earliest = instantMillis(now) + minutesBefore * 60_000;
  let best: { readonly startsAt: Instant; readonly timeZone: IanaTimeZone } | null = null;
  let bestStart = Number.POSITIVE_INFINITY;
  for (const occurrence of occurrences) {
    const timing = occurrence.timing;
    if (occurrence.state !== 'planned' || timing.kind !== 'timed') continue;
    const start = instantMillis(timing.startsAt);
    if (start < earliest || start >= bestStart) continue;
    best = { startsAt: timing.startsAt, timeZone: timing.timeZone };
    bestStart = start;
  }
  return best;
};

/**
 * Resolve a timed Routine reminder from its projected occurrences: `minutesBefore` before the next
 * occurrence whose reminder is still ahead (`nextReminderOccurrence`), in that occurrence's zone.
 */
export const resolveNextRoutineReminder = (input: {
  readonly occurrences: readonly ReminderOccurrence[];
  readonly now: Instant;
  readonly minutesBefore: number;
}): DomainResult<ReminderSchedule> => {
  if (!isMinutesBefore(input.minutesBefore)) return invalid('reminder_offset');
  const next = nextReminderOccurrence(input.occurrences, input.now, input.minutesBefore);
  if (next === null)
    return notAccepted(
      'reminder_no_upcoming_occurrence',
      'This routine has no upcoming occurrence at a set time, so its reminder has nothing to come before.',
    );
  return resolveRoutineReminder({
    occurrenceStart: next.startsAt,
    minutesBefore: input.minutesBefore,
    timeZone: next.timeZone,
  });
};

/**
 * The schedule a Time Block reminder keeps when its block is replaced by a superseding block (move or
 * shorten): a relative reminder is resolved again from the new start with the same offset, and a
 * reminder at a chosen time stays exactly where it was.
 */
export const followTimeBlockStart = (
  schedule: ReminderSchedule,
  blockStart: Instant,
): ReminderSchedule => {
  if (schedule.kind === 'at') return schedule;
  const remindAt = Temporal.Instant.from(blockStart)
    .add({ minutes: schedule.offsetMinutes })
    .toString({ smallestUnit: 'millisecond' }) as Instant;
  return { ...schedule, remindAt };
};

/** Minutes before the anchor of a stored relative schedule (its offset is negative when before). */
export const reminderMinutesBefore = (schedule: ReminderSchedule): number | undefined =>
  schedule.kind === 'relative' ? Math.max(0, -schedule.offsetMinutes) : undefined;

/* ───────────────────────── Which targets accept a reminder ───────────────────────── */

/** Only a current planned block accepts a new reminder; completed, skipped, and canceled do not. */
export const checkTimeBlockAcceptsReminder = (block: {
  readonly state: TimeBlockState;
  readonly supersededById?: EntityId;
}): DomainResult<void> =>
  block.state === 'planned' && block.supersededById === undefined
    ? ok(undefined)
    : notAccepted('reminder_block_not_planned', 'Only a planned time block can get a reminder.');

/** Only an active Routine whose current pattern happens at a set time accepts a new reminder. */
export const checkRoutineAcceptsReminder = (routine: {
  readonly state: RoutineState;
  readonly schedulingMode: RoutineSchedulingMode;
}): DomainResult<void> => {
  if (routine.state !== 'active')
    return notAccepted('reminder_routine_not_active', 'Only an active routine can get a reminder.');
  if (routine.schedulingMode.kind !== 'time_specific')
    return notAccepted(
      'reminder_routine_not_timed',
      'Only a routine at a set time can have a reminder.',
    );
  return ok(undefined);
};

/** Only a saved draft or a skipped review accepts a new "Remind me to finish" reminder. */
export const checkReviewAcceptsReminder = (review: {
  readonly state: ReviewState;
}): DomainResult<void> =>
  review.state === 'draft' || review.state === 'skipped'
    ? ok(undefined)
    : notAccepted(
        'reminder_review_not_open',
        'Only a saved draft or a skipped review can get a reminder.',
      );

/* ───────────────────────── Reminder state ───────────────────────── */

/**
 * The state a reminder has once the person sets it: a new or scheduled reminder is scheduled (with
 * its new time), and one that was turned off or delivered is scheduled again by this explicit choice
 * (the Reminder state machine's `canceled | delivered -> scheduled` reschedule).
 */
export const scheduleReminderState = (current?: ReminderState): DomainResult<'scheduled'> => {
  if (current === undefined || current === 'scheduled') return ok('scheduled');
  const transitioned = transitionLifecycle({
    entityType: 'reminder',
    current: { state: current },
    to: 'scheduled',
    intent: 'reschedule',
  });
  return transitioned.ok
    ? ok('scheduled')
    : notAccepted('reminder_not_reschedulable', 'This reminder cannot be set again.');
};

/** Turning a reminder off is the `scheduled -> canceled` change of the Reminder state machine. */
export const turnOffReminderState = (state: ReminderState): DomainResult<'canceled'> => {
  const transitioned = transitionLifecycle({
    entityType: 'reminder',
    current: { state },
    to: 'canceled',
  });
  return transitioned.ok
    ? ok('canceled')
    : notAccepted('reminder_not_scheduled', 'This reminder is already off.');
};
