/**
 * Today and Focus rules. Pure: the planning date always comes from the caller (the
 * injected clock read in the Profile planning zone). Nothing here ranks, suggests, or changes a plan
 * by itself; every change is the person's explicit command.
 */
import { err, ok, type Brand, type DomainResult, type EntityId } from './contracts.js';
import { addDays } from './horizons.js';
import {
  appendOrderKey,
  compareOrder,
  spacedOrderKey,
  type OrderKeyChange,
  type OrderedItem,
} from './ordering.js';
import type { GeneratedOccurrencePeriod } from './recurrence.js';
import type { OccurrenceOverrideV1 } from './routines.js';
import type { ActionState, RoutineOccurrenceState } from './states.js';
import type { CalendarDate, HorizonPeriod } from './time.js';

const todayError = (reason: string, message: string): DomainResult<never> =>
  err({ code: 'invalid_value', message, details: { reason } });

/* ───────────────────────── The planning day ───────────────────────── */

/** A date seen from the live planning today. */
export type DayRelation = 'past' | 'today' | 'future';

export const dayRelation = (date: CalendarDate, today: CalendarDate): DayRelation =>
  date < today ? 'past' : date === today ? 'today' : 'future';

/**
 * The date End Day carries open work to: today for an earlier day, and the next day for today. A
 * later day has nothing to end yet.
 */
export const endDayCarryDate = (
  date: CalendarDate,
  today: CalendarDate,
): DomainResult<CalendarDate> => {
  if (date > today)
    return todayError('end_day_future', 'End day is available for today or earlier days.');
  return ok(date < today ? today : addDays(date, 1));
};

/**
 * How far before a day's start a block that still reaches into the day can begin. planning caps new
 * blocks at 24 hours, but onboarding commitments and Action schedules accept any same-date window (up to
 * about 25 hours on a clock-change day), so Today's bounded block reads look back 48 hours.
 */
export const dayBlockLookbackHours = 48;

/* ───────────────────────── Day focus ───────────────────────── */

/** A day's focus holds at most three items (the focus_selections trigger is the backstop). */
export const dayFocusLimit = 3;

/** Focus is chosen for today or a later day; an earlier day's focus is read-only history. */
export const validateFocusDate = (
  date: CalendarDate,
  today: CalendarDate,
): DomainResult<CalendarDate> =>
  date >= today
    ? ok(date)
    : todayError('focus_date_past', 'Focus can be chosen for today or a later day.');

export const focusableActionStates: readonly ActionState[] = [
  'inbox',
  'planned',
  'scheduled',
  'in_progress',
];

/** Only unfinished Actions can be chosen as focus. */
export const isFocusableActionState = (state: ActionState): boolean =>
  focusableActionStates.includes(state);

export type FocusTargetState =
  | { readonly kind: 'action'; readonly state: ActionState }
  | { readonly kind: 'routine_occurrence'; readonly state: RoutineOccurrenceState };

/** A new focus target must be unfinished: an unfinished Action or a planned Routine Occurrence. */
export const validateFocusTarget = (target: FocusTargetState): DomainResult<true> => {
  const unfinished =
    target.kind === 'action' ? isFocusableActionState(target.state) : target.state === 'planned';
  return unfinished
    ? ok(true)
    : todayError('focus_target_finished', 'Only unfinished work can be chosen as focus.');
};

/**
 * Whether a Routine Occurrence falls on a date: a dated occurrence on its effective date (the
 * override date when moved, else its logical date), a weekly count on any day of its week.
 */
export const isOccurrenceOnDate = (
  occurrence: {
    readonly period: GeneratedOccurrencePeriod;
    readonly override?: Pick<OccurrenceOverrideV1, 'date'>;
  },
  date: CalendarDate,
): boolean =>
  occurrence.period.kind === 'week'
    ? occurrence.period.start <= date && date <= occurrence.period.end
    : (occurrence.override?.date ?? occurrence.period.date) === date;

/** What one day focus selection targets: an Action or a Routine Occurrence. */
export type DayFocusTarget =
  | { readonly kind: 'action'; readonly actionId: EntityId }
  | { readonly kind: 'routine_occurrence'; readonly occurrenceId: EntityId };

/** Stable identity of a focus target within one day (targets are unique per day). */
export type FocusTargetKey = Brand<string, 'FocusTargetKey'>;

export const focusTargetKey = (target: DayFocusTarget): FocusTargetKey =>
  (target.kind === 'action'
    ? `action:${target.actionId}`
    : `routine_occurrence:${target.occurrenceId}`) as FocusTargetKey;

/** One active focus selection of a day, ordered by (order key, id). */
export interface DayFocusItem extends OrderedItem {
  readonly targetKey: FocusTargetKey;
}

/** The changes that turn a day's focus into the chosen one. Apply archive, reorder, then create. */
export interface DayFocusPlan {
  /** Selections to archive, in their current order. Archived first, so a day never holds four. */
  readonly archive: readonly string[];
  /** Kept selections whose order key changes. */
  readonly reorder: readonly OrderKeyChange[];
  /** New selections in the chosen order, each with its order key. */
  readonly create: readonly { readonly targetKey: FocusTargetKey; readonly orderKey: string }[];
}

const focusLimitError = (): DomainResult<never> =>
  err({
    code: 'selection_limit',
    message: "A day's focus holds up to three items. Remove one to choose another.",
  });

/** Keys for new rows appended after `rows` (spaced keys), or null when the rows need normalizing. */
function appendedKeys(
  rows: readonly OrderedItem[],
  keys: readonly FocusTargetKey[],
): DayFocusPlan['create'] | null {
  const items: OrderedItem[] = [...rows];
  const create: { targetKey: FocusTargetKey; orderKey: string }[] = [];
  for (const [index, targetKey] of keys.entries()) {
    const appended = appendOrderKey(items);
    if (!appended.ok || appended.value.changes.length > 0) return null;
    items.push({ id: `\u0000new:${String(index)}`, orderKey: appended.value.orderKey });
    create.push({ targetKey, orderKey: appended.value.orderKey });
  }
  return create;
}

/**
 * Plan a day's focus as the person chose it: `desired` is the complete ordered list (at most three,
 * each target once). Selections that are no longer chosen are archived, kept ones keep their row,
 * and new ones are created. Choosing the same list again changes nothing. When only new items are
 * appended, kept rows keep their keys; any other change gives every chosen item the spaced key of
 * its position, which also normalizes older keys such as `onboarding-01`.
 */
export const planDayFocus = (
  existing: readonly DayFocusItem[],
  desired: readonly FocusTargetKey[],
): DomainResult<DayFocusPlan> => {
  if (desired.length > dayFocusLimit) return focusLimitError();
  if (new Set(desired).size !== desired.length)
    return todayError('focus_duplicate', 'Each item can be chosen once for a day.');
  const current = [...existing].sort(compareOrder);
  const kept = new Map<FocusTargetKey, DayFocusItem>();
  const archive: string[] = [];
  for (const row of current) {
    if (desired.includes(row.targetKey) && !kept.has(row.targetKey)) kept.set(row.targetKey, row);
    else archive.push(row.id);
  }
  const keptInChosenOrder = desired.flatMap((key) => {
    const row = kept.get(key);
    return row === undefined ? [] : [row];
  });
  const keptInCurrentOrder = current.filter((row) => kept.get(row.targetKey)?.id === row.id);
  const sameOrder = keptInChosenOrder.every(
    (row, index) => keptInCurrentOrder[index]?.id === row.id,
  );
  const added = desired.filter((key) => !kept.has(key));
  if (sameOrder && added.length === 0) return ok({ archive, reorder: [], create: [] });
  const appendedOnly = desired.slice(0, keptInChosenOrder.length).every((key) => kept.has(key));
  if (sameOrder && appendedOnly) {
    const create = appendedKeys(keptInChosenOrder, added);
    if (create !== null) return ok({ archive, reorder: [], create });
  }
  const reorder: OrderKeyChange[] = [];
  const create: { targetKey: FocusTargetKey; orderKey: string }[] = [];
  for (const [index, targetKey] of desired.entries()) {
    const orderKey = spacedOrderKey(index);
    const row = kept.get(targetKey);
    if (row === undefined) create.push({ targetKey, orderKey });
    else if (row.orderKey !== orderKey) reorder.push({ id: row.id, orderKey });
  }
  return ok({ archive, reorder, create });
};

/**
 * The chosen focus after adding one target at the end: the day's current order plus `key`. A
 * target already in focus, or a day that already holds three, is refused.
 */
export const appendDayFocus = (
  existing: readonly DayFocusItem[],
  key: FocusTargetKey,
): DomainResult<readonly FocusTargetKey[]> => {
  const current = [...existing].sort(compareOrder);
  if (current.some((row) => row.targetKey === key))
    return todayError('already_in_focus', "This is already in the day's focus.");
  if (current.length >= dayFocusLimit) return focusLimitError();
  return ok([...current.map((row) => row.targetKey), key]);
};

/* ───────────────────────── End Day ───────────────────────── */

/** Hard caps for one End Day command. */
export const endDayLimits = Object.freeze({ actions: 200, occurrences: 100 });

/** An explicit End Day choice for an open Action. "Decide later" is no choice and no change. */
export type EndDayDecisionKind = 'carry' | 'move' | 'complete' | 'cancel';

export const endDayDecisionKinds: readonly EndDayDecisionKind[] = [
  'carry',
  'move',
  'complete',
  'cancel',
];

export interface EndDayActionFacts {
  readonly state: ActionState;
  /** Where the Action's current planned block is: none, intersecting the ended day, or elsewhere. */
  readonly plannedBlock: 'none' | 'on_day' | 'elsewhere';
}

/** What one End Day choice changes. Absent fields stay as they are. */
export interface EndDayActionOutcome {
  /** The Action's next state. */
  readonly actionState?: ActionState;
  /** The next state of the planned block on the ended day. */
  readonly blockState?: 'completed' | 'skipped' | 'canceled';
  /** Whether the Action's placement moves to the carry date or the chosen period. */
  readonly movesPlacement: boolean;
}

const finishedActionStates: readonly ActionState[] = ['completed', 'canceled', 'archived'];

/**
 * One open Action's End Day outcome. Carry or move skips a planned block on the
 * ended day and moves the placement; complete or cancel resolves the Action and that block together,
 * as the choice states beforehand. An Inbox Action becomes planned when it is placed; a
 * `scheduled` Action becomes planned once it has no planned block, as planning block changes do; an
 * in-progress Action stays in progress. A planned time on another day and a finished Action are
 * never changed here.
 */
export const planEndDayAction = (
  facts: EndDayActionFacts,
  decision: EndDayDecisionKind,
): DomainResult<EndDayActionOutcome> => {
  if (!endDayDecisionKinds.includes(decision))
    return todayError('end_day_decision', 'Choose what happens to this Action.');
  if (finishedActionStates.includes(facts.state))
    return todayError('already_finished', 'This Action is already finished.');
  if (facts.plannedBlock === 'elsewhere')
    return todayError(
      'scheduled_elsewhere',
      'This Action has a planned time on another day. Change it from that day.',
    );
  const onDay = facts.plannedBlock === 'on_day';
  if (decision === 'complete')
    return ok({
      actionState: 'completed',
      ...(onDay ? { blockState: 'completed' as const } : {}),
      movesPlacement: false,
    });
  if (decision === 'cancel')
    return ok({
      actionState: 'canceled',
      ...(onDay ? { blockState: 'canceled' as const } : {}),
      movesPlacement: false,
    });
  const planned = facts.state === 'inbox' || facts.state === 'scheduled';
  return ok({
    ...(planned ? { actionState: 'planned' as const } : {}),
    ...(onDay ? { blockState: 'skipped' as const } : {}),
    movesPlacement: true,
  });
};

/**
 * A period an open Action can move to from End Day: a day from today on, a week that ends today or
 * later, or this month or a later one. Actions cannot be placed on a Year.
 */
export const validateEndDayPeriod = (
  period: HorizonPeriod,
  today: CalendarDate,
): DomainResult<HorizonPeriod> => {
  const past = (): DomainResult<never> =>
    todayError('move_period_past', 'Choose today or a later day.');
  switch (period.kind) {
    case 'day':
      return period.date >= today ? ok(period) : past();
    case 'week':
      return period.end >= today ? ok(period) : past();
    case 'month':
      return period.month >= today.slice(0, 7) ? ok(period) : past();
    case 'year':
      return err({
        code: 'placement_not_allowed',
        message: 'An Action can move to a day, week, or month.',
        details: { reason: 'placement_not_allowed' },
      });
  }
};
