/**
 * Reviews: the pure rules of daily, weekly, monthly, and yearly review checkpoints.
 *
 * A Review looks back on one exact period and may plan the period that follows. Its state is
 * `draft` (partially saved), `skipped`, `completed`, or `archived`; "due" is derived here from the
 * period and the planning today and is never stored. Review decisions are drafts until Finish
 * applies them through the normal application planners in one command. Nothing here ranks,
 * grades, or scores the person, and an overdue review never blocks anything.
 */
import { err, ok, type DomainResult } from './contracts.js';
import {
  energyLabels,
  reviewDecisionKinds,
  type EnergyLabel,
  type ReviewDecisionKind,
  type ReviewType,
} from './entities.js';
import {
  addDays,
  monthRange,
  parseMonthKey,
  parseYearKey,
  weekdayOf,
  yearRange,
} from './horizons.js';
import type { ReviewState } from './states.js';
import {
  createWeekPeriod,
  parseCalendarDate,
  type CalendarDate,
  type HorizonPeriod,
  type MonthKey,
  type Weekday,
  type YearKey,
} from './time.js';
import { endDayCarryDate } from './today.js';

const reviewError = (reason: string, message: string): DomainResult<never> =>
  err({ code: 'invalid_value', message, details: { reason } });

export const reviewTypes: readonly ReviewType[] = ['daily', 'weekly', 'monthly', 'yearly'];

export const isReviewType = (value: unknown): value is ReviewType =>
  typeof value === 'string' && (reviewTypes as readonly string[]).includes(value);

/* ───────────────────────── Periods ───────────────────────── */

/**
 * The exact period a Review looks back on. `key` is the start date for daily and weekly reviews,
 * `YYYY-MM` for monthly, and `YYYY` for yearly. A weekly period keeps the first weekday it was
 * created with, so a later first-weekday change never rewrites it.
 */
export interface ReviewPeriod {
  readonly type: ReviewType;
  readonly key: string;
  readonly start: CalendarDate;
  readonly end: CalendarDate;
  /** Weekly only. */
  readonly weekStart?: Weekday;
}

const dailyPeriod = (date: CalendarDate): ReviewPeriod => ({
  type: 'daily',
  key: date,
  start: date,
  end: date,
});

const weeklyPeriod = (date: CalendarDate, weekStart: Weekday): ReviewPeriod => {
  const week = createWeekPeriod(date, weekStart);
  return { type: 'weekly', key: week.start, start: week.start, end: week.end, weekStart };
};

const monthlyPeriod = (month: MonthKey): ReviewPeriod => {
  const range = monthRange(month);
  return { type: 'monthly', key: month, start: range.start, end: range.end };
};

const yearlyPeriod = (year: YearKey): ReviewPeriod => {
  const range = yearRange(year);
  return { type: 'yearly', key: year, start: range.start, end: range.end };
};

/** The review period of `type` that contains `date`, using the Profile's current first weekday. */
export const reviewPeriodContaining = (
  type: ReviewType,
  date: CalendarDate,
  weekStart: Weekday,
): ReviewPeriod => {
  switch (type) {
    case 'daily':
      return dailyPeriod(date);
    case 'weekly':
      return weeklyPeriod(date, weekStart);
    case 'monthly':
      return monthlyPeriod(date.slice(0, 7) as MonthKey);
    case 'yearly':
      return yearlyPeriod(date.slice(0, 4) as YearKey);
  }
};

/**
 * Parse a period key. A weekly key is the week's first date, and the week starts on that date's own
 * weekday: the key alone identifies the exact seven days, whatever the Profile's first weekday is
 * now. Whether such a week is still offered is the application's decision.
 */
export const parseReviewPeriodKey = (type: unknown, key: unknown): DomainResult<ReviewPeriod> => {
  if (!isReviewType(type))
    return reviewError('review_type', 'Choose a daily, weekly, monthly, or yearly review.');
  const invalid = (): DomainResult<never> =>
    reviewError('review_period', 'Choose a valid review period.');
  if (typeof key !== 'string') return invalid();
  switch (type) {
    case 'daily':
    case 'weekly': {
      const date = parseCalendarDate(key);
      if (!date.ok) return invalid();
      return ok(
        type === 'daily'
          ? dailyPeriod(date.value)
          : weeklyPeriod(date.value, weekdayOf(date.value)),
      );
    }
    case 'monthly': {
      const month = parseMonthKey(key);
      return month.ok ? ok(monthlyPeriod(month.value)) : invalid();
    }
    case 'yearly': {
      const year = parseYearKey(key);
      return year.ok && key.length === 4 ? ok(yearlyPeriod(year.value)) : invalid();
    }
  }
};

/** The period of the same type just before `period` (the same first weekday for weekly). */
export const previousReviewPeriod = (period: ReviewPeriod): ReviewPeriod =>
  period.type === 'weekly'
    ? weeklyPeriod(addDays(period.start, -1), period.weekStart ?? weekdayOf(period.start))
    : reviewPeriodContaining(period.type, addDays(period.start, -1), 'monday');

/** The period of the same type just after `period` (the same first weekday for weekly). */
export const nextReviewPeriod = (period: ReviewPeriod): ReviewPeriod =>
  period.type === 'weekly'
    ? weeklyPeriod(addDays(period.end, 1), period.weekStart ?? weekdayOf(period.start))
    : reviewPeriodContaining(period.type, addDays(period.end, 1), 'monday');

export const sameReviewPeriod = (left: ReviewPeriod, right: ReviewPeriod): boolean =>
  left.type === right.type && left.start === right.start && left.end === right.end;

/** A weekly period is aligned when it starts on the Profile's current first weekday. */
export const isAlignedReviewPeriod = (period: ReviewPeriod, weekStart: Weekday): boolean =>
  period.type !== 'weekly' || weekdayOf(period.start) === weekStart;

/** The Horizon period with the same dates, for reading the plan of a review period. */
export const reviewHorizonPeriod = (period: ReviewPeriod): HorizonPeriod => {
  switch (period.type) {
    case 'daily':
      return { kind: 'day', date: period.start };
    case 'weekly':
      return {
        kind: 'week',
        start: period.start,
        end: period.end,
        weekStart: period.weekStart ?? weekdayOf(period.start),
      };
    case 'monthly':
      return { kind: 'month', month: period.key as MonthKey };
    case 'yearly':
      return { kind: 'year', year: period.key as YearKey };
  }
};

/* ───────────────────────── Due and the current checkpoint ───────────────────────── */

/**
 * Derived, never stored: a period is `not_due` before its last day, `due` on its last
 * day, and `ended` after it. `ended` is shown as calm, optional text; nothing is ever blocked.
 */
export type ReviewDue = 'not_due' | 'due' | 'ended';

export const reviewDue = (period: ReviewPeriod, today: CalendarDate): ReviewDue =>
  today < period.end ? 'not_due' : today === period.end ? 'due' : 'ended';

/** A period can be reviewed once it has started; a later period has nothing to look back on. */
export const isReviewablePeriod = (period: ReviewPeriod, today: CalendarDate): boolean =>
  period.start <= today;

/**
 * The one checkpoint offered for a type. On a period's last day it is that period.
 * Otherwise it is the previous period until that one is completed or skipped, and then the current
 * period, which can be started early. Earlier missed periods, and a previous period that ended
 * before the Profile existed, are never offered as due; drafts of any period stay listed as in
 * progress.
 */
export const currentReviewCheckpoint = (input: {
  readonly type: ReviewType;
  readonly today: CalendarDate;
  readonly weekStart: Weekday;
  /** Whether the previous period (see `previousReviewPeriod`) is completed or skipped. */
  readonly previousSettled: boolean;
  /**
   * The Profile's first planning date (its creation date in the planning zone). A period that
   * ended before it holds nothing the person planned here, so it is never offered.
   */
  readonly startedOn?: CalendarDate;
}): ReviewPeriod => {
  const current = reviewPeriodContaining(input.type, input.today, input.weekStart);
  if (input.today === current.end || input.previousSettled) return current;
  const previous = previousReviewPeriod(current);
  return input.startedOn !== undefined && previous.end < input.startedOn ? current : previous;
};

/**
 * The period a review plans for: the day End Day carries to for a daily review, and
 * otherwise the period after the reviewed one, or the current period when that one has passed.
 */
export const reviewPlanningPeriod = (
  period: ReviewPeriod,
  today: CalendarDate,
  weekStart: Weekday,
): DomainResult<ReviewPeriod> => {
  if (!isReviewablePeriod(period, today))
    return reviewError('review_future', 'This period has not started yet.');
  if (period.type === 'daily') {
    const carry = endDayCarryDate(period.start, today);
    return carry.ok ? ok(dailyPeriod(carry.value)) : carry;
  }
  const next =
    period.type === 'weekly'
      ? weeklyPeriod(addDays(period.end, 1), weekStart)
      : nextReviewPeriod(period);
  const current = reviewPeriodContaining(period.type, today, weekStart);
  return ok(next.start >= current.start ? next : current);
};

/* ───────────────────────── Review state ───────────────────────── */

/** A period's review status: no row yet, or the state of its one non-archived row. */
export type ReviewStatus = 'not_started' | Exclude<ReviewState, 'archived'>;

const reviewFinished = (): DomainResult<never> =>
  reviewError('review_finished', 'This review is finished. Its decisions are kept in history.');

/** Save a draft: a first save creates it; a skipped review is resumed. */
export const planReviewSave = (status: ReviewStatus): DomainResult<'draft'> =>
  status === 'completed' ? reviewFinished() : ok('draft');

/** Skip: a new or draft review becomes skipped; decisions are kept and nothing is applied. */
export const planReviewSkip = (status: ReviewStatus): DomainResult<'skipped'> => {
  if (status === 'completed') return reviewFinished();
  if (status === 'skipped') return reviewError('no_change', 'This review is already skipped.');
  return ok('skipped');
};

/** Finish: a new, draft, or skipped review becomes completed and its decisions apply. */
export const planReviewFinish = (status: ReviewStatus): DomainResult<'completed'> =>
  status === 'completed' ? reviewFinished() : ok('completed');

/* ───────────────────────── Decisions ───────────────────────── */

/** What a review item is about. A Routine Occurrence is stored with its Routine. */
export type ReviewTargetKind =
  'axis' | 'outcome' | 'milestone' | 'project' | 'action' | 'routine_occurrence';

export const isReviewDecisionKind = (value: unknown): value is ReviewDecisionKind =>
  typeof value === 'string' && (reviewDecisionKinds as readonly string[]).includes(value);

/**
 * Each target holds at most one decision per slot: its `state` decision, a `focus` choice, a Week
 * `commit`ment, and a `note`. End Day, for example, may carry an Action and also choose it as the
 * next day's focus.
 */
export type ReviewDecisionSlot = 'state' | 'focus' | 'commit' | 'note';

export const reviewDecisionSlot = (decision: ReviewDecisionKind): ReviewDecisionSlot =>
  decision === 'focus' || decision === 'commit' || decision === 'note' ? decision : 'state';

/** The decisions each review offers, per target kind. */
export const reviewDecisionMatrix: Readonly<
  Record<ReviewType, Readonly<Partial<Record<ReviewTargetKind, readonly ReviewDecisionKind[]>>>>
> = Object.freeze({
  daily: Object.freeze({
    action: Object.freeze(['complete', 'carry', 'move', 'cancel', 'focus'] as const),
    routine_occurrence: Object.freeze(['complete', 'skip', 'focus'] as const),
  }),
  weekly: Object.freeze({
    project: Object.freeze(['continue', 'pause', 'commit'] as const),
    axis: Object.freeze(['note'] as const),
    action: Object.freeze(['commit', 'focus'] as const),
    milestone: Object.freeze(['commit'] as const),
    routine_occurrence: Object.freeze(['focus'] as const),
  }),
  monthly: Object.freeze({
    outcome: Object.freeze(['continue', 'pause', 'complete', 'cancel', 'archive'] as const),
    milestone: Object.freeze(['continue', 'complete', 'cancel', 'archive'] as const),
    project: Object.freeze(['continue', 'pause', 'complete', 'archive'] as const),
  }),
  yearly: Object.freeze({
    outcome: Object.freeze(['continue', 'pause', 'complete', 'cancel', 'archive'] as const),
  }),
});

export const isAllowedReviewDecision = (
  type: ReviewType,
  target: ReviewTargetKind,
  decision: ReviewDecisionKind,
): boolean => reviewDecisionMatrix[type][target]?.includes(decision) ?? false;

/**
 * The state an Outcome, Milestone, or Project decision asks for; `null` changes nothing
 * (`continue`). Archive uses the normal archive rule; the others use the normal transition rule.
 */
export const reviewObjectState = (
  kind: 'outcome' | 'milestone' | 'project',
  decision: ReviewDecisionKind,
): DomainResult<string | null> => {
  if (decision === 'continue') return ok(null);
  if (decision === 'archive') return ok('archived');
  const states: Readonly<Record<typeof kind, Partial<Record<ReviewDecisionKind, string>>>> = {
    outcome: { pause: 'paused', complete: 'achieved', cancel: 'abandoned' },
    milestone: { complete: 'completed', cancel: 'canceled' },
    project: { pause: 'paused', complete: 'completed' },
  };
  const state = states[kind][decision];
  return state === undefined
    ? reviewError('review_decision', 'This decision is not available here.')
    : ok(state);
};

/* ───────────────────────── Text and limits ───────────────────────── */

export const reviewLimits = Object.freeze({
  /** Review notes, including a yearly retrospective. */
  notes: 10_000,
  /** One item's note, such as what supported an Axis. */
  itemNote: 2_000,
  /** Theme and direction text, as planning allows. */
  themeText: 2_000,
  directionText: 2_000,
  /** Items saved in one review (End Day's 200 Actions and 100 occurrences, plus choices). */
  items: 400,
  /** The next day's or first day's focus, and the next Week's commitments. */
  focus: 3,
  commitments: 3,
});

/** Optional prose: blank becomes absent; longer than `limit` is refused, never truncated. */
export const normalizeReviewText = (
  value: unknown,
  limit: number,
  field: string,
): DomainResult<string | undefined> => {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== 'string') return reviewError(`${field}_invalid`, 'Enter text.');
  if (value.length > limit)
    return reviewError(
      `${field}_too_long`,
      `Keep this to ${limit.toLocaleString('en-US')} characters or fewer.`,
    );
  return value.trim().length === 0 ? ok(undefined) : ok(value);
};

export const parseReviewEnergy = (value: unknown): DomainResult<EnergyLabel | undefined> => {
  if (value === undefined || value === null) return ok(undefined);
  return typeof value === 'string' && (energyLabels as readonly string[]).includes(value)
    ? ok(value as EnergyLabel)
    : reviewError('review_energy', 'Choose low, medium, high, or focused energy.');
};

/** A yearly review's decision about direction. */
export type ReviewDirectionChoice = 'continue' | 'new' | 'outdated';

export interface ReviewDirectionDecision {
  readonly choice: ReviewDirectionChoice;
  /** Required for `new`, absent otherwise. */
  readonly text?: string;
}

export const parseReviewDirection = (
  value: unknown,
): DomainResult<ReviewDirectionDecision | undefined> => {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== 'object' || Array.isArray(value))
    return reviewError('review_direction', 'Choose what happens to your direction.');
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== 'choice' && key !== 'text'))
    return reviewError('review_direction', 'Choose what happens to your direction.');
  const choice = record['choice'];
  if (choice !== 'continue' && choice !== 'new' && choice !== 'outdated')
    return reviewError('review_direction', 'Choose what happens to your direction.');
  if (choice !== 'new')
    return record['text'] === undefined
      ? ok({ choice })
      : reviewError('review_direction', 'Only a new direction has text.');
  const text = normalizeReviewText(record['text'], reviewLimits.directionText, 'direction');
  if (!text.ok) return text;
  return text.value === undefined
    ? reviewError('direction_required', 'Write the new direction, or choose another option.')
    : ok({ choice, text: text.value });
};
