import { message as uiMessage } from '../messages';
/**
 * Review words (Review): periods, status, due, decisions, energy, and the questions shown as
 * note prompts. Calm and factual: nothing here scores, grades, ranks, or pressures, and every state
 * is said in words, never by color alone.
 */
import type {
  PlacementPeriodInput,
  PlanProfile,
  ReviewCheckpoint,
  ReviewItemTargetView,
} from '@yelaxis/application';
import {
  addDays,
  type CalendarDate,
  type EnergyLabel,
  type Instant,
  type ReviewDecisionKind,
  type ReviewDirectionChoice,
  type ReviewDue,
  type ReviewPeriod,
  type ReviewStatus,
  type ReviewType,
  type Weekday,
} from '@yelaxis/domain';

import { formatDate, formatInstantTime, formatMonth } from '../plan/format';
import { dateInZone, weekDatesFor } from '../plan/timeline';

/* ───────────────────────── Dates and periods ───────────────────────── */

const utcNoon = (date: string): Date => new Date(`${date}T12:00:00Z`);

const monthDayFormat = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});
const monthDayYearFormat = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const weekdayMonthDayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: 'UTC' });

/**
 * Whether this locale writes "September 21" (month first) or "21 September" (day first) with a
 * plain space between; null for any other shape, which then keeps both dates whole.
 */
function simpleMonthDayOrder(): 'month-first' | 'day-first' | null {
  const parts = monthDayFormat.formatToParts(utcNoon('2026-09-21'));
  if (parts.length !== 3 || parts[1]?.type !== 'literal' || parts[1].value !== ' ') return null;
  if (parts[0]?.type === 'month' && parts[2]?.type === 'day') return 'month-first';
  if (parts[0]?.type === 'day' && parts[2]?.type === 'month') return 'day-first';
  return null;
}

const monthDayOrder = simpleMonthDayOrder();

/** "Tuesday, September 29": a day by its weekday and date. */
export function dayWords(date: string): string {
  return weekdayMonthDayFormat.format(utcNoon(date));
}

/**
 * The seven days of a week in words: "September 21–27", "September 28 – October 4", and the year
 * when the week is not in this year: "December 29, 2025 – January 4, 2026".
 */
export function weekRangeWords(start: string, end: string, today: string): string {
  const year = end.slice(0, 4);
  const crossesYear = start.slice(0, 4) !== year;
  const withYear = crossesYear || year !== today.slice(0, 4);
  if (start.slice(0, 7) === end.slice(0, 7) && monthDayOrder !== null) {
    const month = monthFormat.format(utcNoon(start));
    const days = `${dayFormat.format(utcNoon(start))}–${dayFormat.format(utcNoon(end))}`;
    if (monthDayOrder === 'month-first')
      return withYear ? `${month} ${days}, ${year}` : `${month} ${days}`;
    return withYear ? `${days} ${month} ${year}` : `${days} ${month}`;
  }
  const first = (crossesYear ? monthDayYearFormat : monthDayFormat).format(utcNoon(start));
  const last = (withYear ? monthDayYearFormat : monthDayFormat).format(utcNoon(end));
  return `${first} – ${last}`;
}

/**
 * A review period as a title: "Today, Wednesday, September 30", "Week of September 21–27",
 * "September 2026", or "2026".
 */
export function periodTitle(period: ReviewPeriod, today: string): string {
  switch (period.type) {
    case 'daily':
      if (period.start === today) return `Today, ${dayWords(period.start)}`;
      if (period.start === addDays(today as CalendarDate, -1))
        return `Yesterday, ${dayWords(period.start)}`;
      return formatDate(period.start, 'long');
    case 'weekly':
      return uiMessage('plan.plan-month.1314', {
        value0: weekRangeWords(period.start, period.end, today),
      });
    case 'monthly':
      return formatMonth(period.key);
    case 'yearly':
      return period.key;
  }
}

/** A review period inside a sentence: "the week of September 21–27", "September 2026", "2026". */
export function periodPhrase(period: ReviewPeriod, today: string): string {
  return period.type === 'weekly'
    ? uiMessage('review.review-text.2309', {
        value0: weekRangeWords(period.start, period.end, today),
      })
    : periodRange(period, today);
}

/** A review period by its dates alone: "September 21–27", "September 2026", "2026". */
export function periodRange(period: ReviewPeriod, today: string): string {
  switch (period.type) {
    case 'daily':
      return formatDate(period.start, 'long');
    case 'weekly':
      return weekRangeWords(period.start, period.end, today);
    case 'monthly':
      return formatMonth(period.key);
    case 'yearly':
      return period.key;
  }
}

const weekdayNames: Readonly<Record<Weekday, string>> = {
  monday: uiMessage('onboarding-ui.1024'),
  tuesday: uiMessage('onboarding-ui.1025'),
  wednesday: uiMessage('onboarding-ui.1026'),
  thursday: uiMessage('onboarding-ui.1027'),
  friday: uiMessage('onboarding-ui.1028'),
  saturday: uiMessage('onboarding-ui.1029'),
  sunday: uiMessage('onboarding-ui.1030'),
};

/** "Monday". */
export const weekdayWord = (weekday: Weekday): string => weekdayNames[weekday];

/** "Finished Sunday, September 27, 2026 at 18:30", in the planning zone. */
export function finishedText(completedAt: Instant, profile: PlanProfile): string {
  const zone = profile.planningTimeZone;
  return uiMessage('review.review-text.2310', {
    value0: formatDate(dateInZone(completedAt, zone), 'long'),
    value1: formatInstantTime(completedAt, zone, profile.timeFormat),
  });
}

/* ───────────────────────── Types, status, and due ───────────────────────── */

const typeLabels: Readonly<Record<ReviewType, string>> = {
  daily: uiMessage('review.review-overview.1966'),
  weekly: uiMessage('review.review-overview.1967'),
  monthly: uiMessage('review.review-overview.1968'),
  yearly: uiMessage('review.review-overview.1969'),
};

/** "Weekly". */
export const reviewTypeLabel = (type: ReviewType): string => typeLabels[type];

/** "Weekly review". */
export const reviewTitle = (type: ReviewType): string =>
  uiMessage('review.review-text.2311', { value0: typeLabels[type] });

const statusLabels: Readonly<Record<ReviewStatus, string>> = {
  not_started: uiMessage('review.review-text.2312'),
  draft: uiMessage('review.review-text.2313'),
  skipped: uiMessage('plan.plan-month.1325'),
  completed: uiMessage('today.end-day.2184'),
};

/** "Not started", "Saved for later", "Skipped", or "Done". Never a score or a grade. */
export const reviewStatusLabel = (status: ReviewStatus): string => statusLabels[status];

/**
 * Calm due text: "Due today" on the period's last day, "Ready when you are" after it, and "Due
 * Sunday, October 4" before it. It is only information; nothing is ever blocked.
 */
export function dueText(period: ReviewPeriod, due: ReviewDue): string {
  switch (due) {
    case 'due':
      return uiMessage('review.review-text.2314');
    case 'ended':
      return uiMessage('review.review-text.2315');
    case 'not_due':
      return uiMessage('actions-ui.354', { value0: dayWords(period.end) });
  }
}

/** The one link a checkpoint offers. */
export function checkpointLinkLabel(checkpoint: Pick<ReviewCheckpoint, 'status' | 'due'>): string {
  switch (checkpoint.status) {
    case 'not_started':
      return checkpoint.due === 'not_due'
        ? uiMessage('review.review-text.2316')
        : uiMessage('review.review-text.2317');
    case 'draft':
      return uiMessage('review.saved-review.2006');
    case 'skipped':
    case 'completed':
      return uiMessage('review.review-text.2318');
  }
}

/** "weekly", "weekly and monthly", "weekly, monthly, and yearly". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  if (words.length === 2)
    return uiMessage('alignment.lifecycle-dialogs.477', {
      value0: words[0] ?? '',
      value1: words[1] ?? '',
    });
  return uiMessage('plan.routine-form.1433', {
    value0: words.slice(0, -1).join(', '),
    value1: words[words.length - 1] ?? '',
  });
}

/**
 * Today's one quiet line: "Your weekly review is ready." or "Your weekly and monthly reviews are
 * ready."; null when nothing is ready.
 */
export function reviewNoticeText(due: readonly Pick<ReviewCheckpoint, 'period'>[]): string | null {
  const order: readonly ReviewType[] = ['daily', 'weekly', 'monthly', 'yearly'];
  const types = order.filter((type) => due.some((checkpoint) => checkpoint.period.type === type));
  if (types.length === 0) return null;
  const words = listWords(types);
  return types.length === 1
    ? uiMessage('review.review-text.2319', { value0: words })
    : uiMessage('review.review-text.2320', { value0: words });
}

/* ───────────────────────── Energy and prompts ───────────────────────── */

const energyLabels: Readonly<Record<EnergyLabel, string>> = {
  low: uiMessage('actions-ui.339'),
  medium: uiMessage('actions-ui.340'),
  high: uiMessage('actions-ui.341'),
  focused: uiMessage('actions-ui.342'),
};

/** "Low", "Medium", "High", or "Focused": a label, never a measure. */
export const energyWord = (energy: EnergyLabel): string => energyLabels[energy];

/** The product questions shown as prompts for a review's notes; never scored. */
export const reviewQuestions: Readonly<Record<Exclude<ReviewType, 'daily'>, readonly string[]>> = {
  weekly: [
    uiMessage('review.review-text.2321'),
    uiMessage('review.review-text.2322'),
    uiMessage('review.review-text.2323'),
  ],
  monthly: [
    uiMessage('review.review-text.2324'),
    uiMessage('review.review-text.2325'),
    uiMessage('review.review-text.2326'),
  ],
  yearly: [
    uiMessage('review.review-text.2327'),
    uiMessage('review.review-text.2328'),
    uiMessage('review.review-text.2329'),
  ],
};

/* ───────────────────────── Decisions ───────────────────────── */

export type ReviewObjectKind = 'outcome' | 'milestone' | 'project';

/** The words on each decision a review form offers, in the order they are offered. */
export const objectDecisionWords: Readonly<
  Record<ReviewObjectKind, readonly (readonly [ReviewDecisionKind, string])[]>
> = {
  outcome: [
    ['continue', uiMessage('account.onboarding-sign-in.206')],
    ['pause', uiMessage('alignment.outcome-detail.707')],
    ['complete', uiMessage('plan.theme-editor.1861')],
    ['cancel', uiMessage('alignment.outcome-detail.711')],
    ['archive', uiMessage('actions-ui.258')],
  ],
  milestone: [
    ['continue', uiMessage('account.onboarding-sign-in.206')],
    ['complete', uiMessage('actions-ui.257')],
    ['cancel', uiMessage('account.account-dialogs.20')],
    ['archive', uiMessage('actions-ui.258')],
  ],
  project: [
    ['continue', uiMessage('account.onboarding-sign-in.206')],
    ['pause', uiMessage('alignment.outcome-detail.707')],
    ['complete', uiMessage('actions-ui.257')],
    ['archive', uiMessage('actions-ui.258')],
  ],
};

const directionWords: Readonly<Record<ReviewDirectionChoice, string>> = {
  continue: uiMessage('review.review-text.2330'),
  new: uiMessage('review.review-text.2331'),
  outdated: uiMessage('review.review-text.2332'),
};

/** The direction choice in words. */
export const directionChoiceWord = (choice: ReviewDirectionChoice): string =>
  directionWords[choice];

/** What a saved review item names; "Deleted object" once it was permanently deleted. */
export function targetTitle(target: ReviewItemTargetView): string {
  if (target.kind === 'deleted') return uiMessage('review.review-text.2333');
  return target.kind === 'routine_occurrence' ? target.routineTitle : target.title;
}

/** Where a Move goes: "Tuesday, October 6, 2026", "the week of October 5–11", "October 2026". */
export function movePeriodWords(
  period: PlacementPeriodInput,
  weekStart: Weekday,
  today: string,
): string {
  switch (period.kind) {
    case 'day':
      return formatDate(period.date, 'long');
    case 'week': {
      const days = weekDatesFor(period.date, weekStart);
      const start = days[0] ?? period.date;
      const end = days[6] ?? period.date;
      return uiMessage('review.review-text.2309', { value0: weekRangeWords(start, end, today) });
    }
    case 'month':
      return formatMonth(period.date.slice(0, 7));
    case 'year':
      return period.date.slice(0, 4);
  }
}

const appliedWords: Readonly<Partial<Record<ReviewDecisionKind, string>>> = {
  continue: uiMessage('review.review-text.2334'),
  pause: uiMessage('plan.routines.1533'),
  complete: uiMessage('plan.plan-month.1324'),
  cancel: uiMessage('plan.theme-editor.1863'),
  archive: uiMessage('alignment.alignment-page.405'),
  carry: uiMessage('review.review-text.2335'),
  skip: uiMessage('plan.plan-month.1325'),
};

const chosenWords: Readonly<Partial<Record<ReviewDecisionKind, string>>> = {
  continue: uiMessage('account.onboarding-sign-in.206'),
  pause: uiMessage('alignment.outcome-detail.707'),
  complete: uiMessage('actions-ui.257'),
  cancel: uiMessage('account.account-dialogs.20'),
  archive: uiMessage('actions-ui.258'),
  carry: uiMessage('review.review-text.2336'),
  skip: uiMessage('plan.occurrence-controls.1243'),
};

/**
 * A state decision in words. `applied` is true for a finished review ("Paused", "Achieved", "Moved
 * to October 2026"); otherwise the choice is named as it was chosen ("Pause", "Move to …").
 */
export function decisionWords(
  targetKind: ReviewItemTargetView['kind'],
  decision: ReviewDecisionKind,
  applied: boolean,
  move?: string,
): string {
  if (targetKind === 'outcome' && decision === 'complete')
    return uiMessage('plan.theme-editor.1861');
  if (targetKind === 'outcome' && decision === 'cancel')
    return applied
      ? uiMessage('plan.theme-editor.1862')
      : uiMessage('alignment.outcome-detail.711');
  if (decision === 'move')
    return uiMessage('review.review-text.2337', {
      value0: applied ? 'Moved' : 'Move',
      value1: move ?? 'another period',
    });
  const words = (applied ? appliedWords : chosenWords)[decision];
  return (
    words ?? (applied ? uiMessage('review.review-text.2338') : uiMessage('review.review-text.2339'))
  );
}

/** "3 decisions", "1 decision". */
export const decisionCountText = (count: number): string =>
  `${String(count)} ${count === 1 ? 'decision' : 'decisions'}`;

/** Character count help for a text field with a limit: "12 of 10,000 characters". */
export function characterCountText(length: number, limit: number): string {
  return uiMessage('alignment.project-detail.772', {
    value0: length.toLocaleString('en-US'),
    value1: limit.toLocaleString('en-US'),
  });
}

/** Refusal for text over its limit; the text is kept exactly as written (never truncated). */
export function tooLongText(label: string, length: number, limit: number): string {
  return uiMessage('review.review-text.2340', {
    value0: label,
    value1: (length - limit).toLocaleString('en-US'),
    value2: limit.toLocaleString('en-US'),
  });
}
