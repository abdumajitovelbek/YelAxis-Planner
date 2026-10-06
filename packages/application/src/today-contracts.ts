/**
 * Today and Focus application contracts: read models for Today, choosing focus,
 * Focus mode, and End Day; command inputs; the manual Today facade; and its owner-scoped, bounded
 * query port.
 *
 * Every command is one `executeCommand` transaction with expected revisions, minimized audit events
 * (`{ operation }` only, with per-record event types), a receipt, and a grouped
 * `planning.restore_v1` undo applied through `PlanningApplication.undo`. Nothing here ranks,
 * preselects, schedules, or completes anything for the person.
 */
import type {
  CalendarDate,
  CommandId,
  DayCapacity,
  DayRelation,
  FocusTargetKey,
  GeneratedOccurrencePeriod,
  Instant,
  OwnerId,
  RoutineOccurrenceState,
  RoutineState,
  UUID,
  WeekPeriod,
} from '@yelaxis/domain';

import type { Bounded } from './alignment-contracts';
import type { ApplicationResult, CommandReceipt } from './contracts';
import type {
  ActionSummary,
  AvailabilityWindowView,
  BlockRow,
  ConflictView,
  OccurrenceEntry,
  OccurrenceTargetInput,
  PlacementPeriodInput,
  PlacementRow,
  PlanProfile,
  PlanningQueryPort,
  TimedEntry,
} from './planning-contracts';

export type { DayRelation } from '@yelaxis/domain';

/* ───────────────────────── Focus read models ───────────────────────── */

/**
 * The identity of a focus target within a day (`focusTargetKey`) and the input that names it in a
 * command. A kept item keeps its row whatever its state, so `target` also names finished items and
 * Routine Occurrences that no longer project on the date.
 */
interface FocusTargetFields {
  readonly key: FocusTargetKey;
  readonly target: FocusTargetInput;
}

interface FocusItemBase extends FocusTargetFields {
  readonly selectionId: UUID;
  readonly localRevision: number;
  readonly orderKey: string;
  /** 1-based position in the person's own order: (order key, id). */
  readonly position: number;
}

/** How a focus Action sits on the focus date. */
export type FocusActionTiming =
  /** A planned block intersecting the date. */
  | { readonly kind: 'scheduled'; readonly block: BlockRow }
  /** A Day placement on the date and no planned block on it. */
  | { readonly kind: 'flexible' }
  /** Anything else: a Week item, another day, or a finished Action (its state says which). */
  | { readonly kind: 'elsewhere' };

/** One of a day's (at most three) focus items. Finished targets stay until the person removes them. */
export type FocusItemView =
  | (FocusItemBase & {
      readonly kind: 'action';
      readonly action: ActionSummary;
      readonly timing: FocusActionTiming;
    })
  | (FocusItemBase & {
      readonly kind: 'routine_occurrence';
      readonly occurrenceId: UUID;
      readonly routineId: UUID;
      readonly routineTitle: string;
      readonly routineState: RoutineState;
      /**
       * The occurrence as the Routine projects it on the date; null when the Routine no longer has
       * this occurrence there (a later series edit or an archived Routine). Only Remove is offered.
       */
      readonly occurrence: OccurrenceEntry | null;
    });

/** Something that can be chosen as focus for a date. Listed in plan order, never ranked. */
export type FocusCandidate =
  | (FocusTargetFields & {
      readonly kind: 'action';
      readonly source: 'scheduled' | 'flexible' | 'week';
      readonly action: ActionSummary;
      /** The planned block on the date (`scheduled` only). */
      readonly block?: BlockRow;
      /** Already in the date's focus. Never preselected otherwise. */
      readonly selected: boolean;
    })
  | (FocusTargetFields & {
      readonly kind: 'routine_occurrence';
      readonly source: 'routine';
      readonly occurrence: OccurrenceEntry;
      readonly selected: boolean;
    });

export interface FocusChoices {
  readonly profile: PlanProfile;
  readonly date: CalendarDate;
  /** The date is today or later (earlier days' focus is read-only history). */
  readonly editable: boolean;
  readonly current: readonly FocusItemView[];
  /**
   * Plan order: scheduled (by start), flexible (placement order), Routines (dated occurrences, then
   * this week's counts), then this week's Week-placed and Week-commitment Actions (at most 50).
   * Unfinished items only, each Action once. Never ranked.
   */
  readonly candidates: readonly FocusCandidate[];
  /** Size of the week group before its limit of 50. */
  readonly weekTotal: number;
}

/* ───────────────────────── Today ───────────────────────── */

export interface TodayView {
  readonly profile: PlanProfile;
  readonly date: CalendarDate;
  /** Planning today at read time; the web re-derives the live date from its own clock. */
  readonly today: CalendarDate;
  readonly relation: DayRelation;
  readonly week: WeekPeriod;
  readonly focus: readonly FocusItemView[];
  /** `date >= today`. */
  readonly focusEditable: boolean;
  readonly timeline: {
    /** Timed items intersecting the date, ordered by start. */
    readonly entries: readonly TimedEntry[];
    /** Overlaps touching the date. Nothing is resolved for the person. */
    readonly conflicts: readonly ConflictView[];
    readonly capacity: DayCapacity;
    readonly availability: readonly AvailabilityWindowView[];
  };
  /**
   * Day-placed Actions with no block on the date: `open` are planned or in progress,
   * `done` are completed; both in placement order.
   */
  readonly flexible: {
    readonly open: readonly ActionSummary[];
    readonly done: readonly ActionSummary[];
  };
  readonly routines: {
    /** Dated occurrences on the date without an exact time (flexible or clock-change skipped). */
    readonly day: readonly OccurrenceEntry[];
    /** Weekly counts whose week contains the date. */
    readonly week: readonly OccurrenceEntry[];
  };
  /** `date <= today`. */
  readonly endDayAvailable: boolean;
}

/* ───────────────────────── Focus mode ───────────────────────── */

export interface FocusSessionView {
  readonly profile: PlanProfile;
  readonly today: CalendarDate;
  readonly action: ActionSummary & { readonly note?: string };
  /** Derived with the injected clock (`isActionOverdue`); shown as neutral text only. */
  readonly overdue: boolean;
  /** The Action's current planned block, on any date. */
  readonly plannedBlock?: BlockRow;
  /** Present when the Action is in today's focus. */
  readonly todayFocus?: {
    readonly selectionId: UUID;
    readonly position: number;
    /** The next unfinished focus Action in the person's own order, if any. */
    readonly next?: { readonly actionId: UUID; readonly title: string };
  };
}

/* ───────────────────────── End Day ───────────────────────── */

export type EndDayItemView =
  | {
      readonly kind: 'action';
      readonly action: ActionSummary;
      /** How the Action is on the day: its Day placement, a planned block, or only its focus. */
      readonly source: 'flexible' | 'scheduled' | 'focus';
      readonly block?: BlockRow;
    }
  | { readonly kind: 'routine_occurrence'; readonly occurrence: OccurrenceEntry };

export interface EndDayView {
  readonly profile: PlanProfile;
  readonly date: CalendarDate;
  readonly today: CalendarDate;
  /** `date <= today`. */
  readonly available: boolean;
  /** `endDayCarryDate(date, today)`. Meaningful only when `available`. */
  readonly carryTo: CalendarDate;
  readonly completed: readonly EndDayItemView[];
  /** Open items, at most 200 (`endDayLimits.actions`), with the full count. */
  readonly open: Bounded<EndDayItemView>;
  /** Focus choices for `carryTo`. */
  readonly nextFocus: FocusChoices;
}

/* ───────────────────────── Command inputs ───────────────────────── */

export type FocusTargetInput =
  | { readonly kind: 'action'; readonly actionId: string }
  | { readonly kind: 'routine_occurrence'; readonly occurrence: OccurrenceTargetInput };

export type EndDayActionDecision =
  | { readonly kind: 'carry' }
  /** Day, Week, or Month only; never into the past. */
  | { readonly kind: 'move'; readonly period: PlacementPeriodInput }
  | { readonly kind: 'complete' }
  | { readonly kind: 'cancel' };

export type EndDayOccurrenceDecision = { readonly kind: 'complete' } | { readonly kind: 'skip' };

/** Items without a decision ("Decide later") are simply not listed: nothing changes for them. */
export interface EndDayInput {
  readonly date: string;
  /** Must still equal `endDayCarryDate(date, today)`; otherwise the day changed. */
  readonly carryTo: string;
  readonly actions: readonly {
    readonly actionId: string;
    readonly revision: number;
    readonly decision: EndDayActionDecision;
  }[];
  readonly occurrences: readonly {
    readonly occurrence: OccurrenceTargetInput;
    readonly decision: EndDayOccurrenceDecision;
  }[];
  /** The carry date's focus, ordered, at most three. Omitted leaves that focus unchanged. */
  readonly nextFocus?: readonly FocusTargetInput[];
}

/* ───────────────────────── Facade ───────────────────────── */

export type TodayResult = Promise<ApplicationResult<CommandReceipt>>;

export interface TodayApplication {
  /* Queries (read-only). An invalid date throws RangeError('Choose a valid date.'), like
     getDayPlan; a malformed or unknown id returns null. */
  getToday(date: string): Promise<TodayView>;
  getFocusChoices(date: string): Promise<FocusChoices>;
  getFocusSession(actionId: string): Promise<FocusSessionView | null>;
  getEndDay(date: string): Promise<EndDayView>;

  /* Commands: one executeCommand each; the grouped undo is applied with PlanningApplication.undo. */
  addFocus(
    input: { readonly date: string; readonly target: FocusTargetInput },
    commandId?: CommandId,
  ): TodayResult;
  removeFocus(
    input: { readonly selectionId: string; readonly revision: number },
    commandId?: CommandId,
  ): TodayResult;
  reorderFocus(
    input: {
      readonly selectionId: string;
      readonly revision: number;
      readonly direction: 'up' | 'down';
    },
    commandId?: CommandId,
  ): TodayResult;
  /** Replace a date's focus with the chosen ordered list (at most three) in one command. */
  setDayFocus(
    input: { readonly date: string; readonly items: readonly FocusTargetInput[] },
    commandId?: CommandId,
  ): TodayResult;
  /** Move one open flexible Action up or down within the date's open flexible list. */
  reorderFlexible(
    input: {
      readonly date: string;
      readonly placementId: string;
      readonly revision: number;
      readonly direction: 'up' | 'down';
    },
    commandId?: CommandId,
  ): TodayResult;
  /** Apply every End Day choice, and optionally the carry date's focus, in one command. */
  applyEndDay(input: EndDayInput, commandId?: CommandId): TodayResult;
}

/** Part 1 (Today view). */
export type TodayViewMethods = Pick<TodayApplication, 'getToday' | 'reorderFlexible'>;
/** Part 2 (focus and Focus mode). */
export type TodayFocusMethods = Pick<
  TodayApplication,
  | 'getFocusChoices'
  | 'getFocusSession'
  | 'addFocus'
  | 'removeFocus'
  | 'reorderFocus'
  | 'setDayFocus'
>;
/** Part 3 (End Day). */
export type TodayEndDayMethods = Pick<TodayApplication, 'getEndDay' | 'applyEndDay'>;

/* ───────────────────────── Query port ───────────────────────── */

/** One active day focus selection with what it targets. */
export interface DayFocusRow {
  readonly id: UUID;
  readonly localRevision: number;
  readonly orderKey: string;
  readonly date: CalendarDate;
  readonly target:
    | { readonly kind: 'action'; readonly action: ActionSummary }
    | {
        readonly kind: 'routine_occurrence';
        readonly occurrenceId: UUID;
        readonly routineId: UUID;
        readonly routineTitle: string;
        readonly routineState: RoutineState;
        /** The materialized occurrence row (a focus selection always references one). */
        readonly generation: number;
        readonly period: GeneratedOccurrencePeriod;
        readonly occurrenceRevision: number;
        readonly state: RoutineOccurrenceState;
      };
}

/** An Action for Focus mode: its summary, note, and current planned block (any date). */
export type FocusActionRow = ActionSummary & {
  readonly note?: string;
  readonly plannedBlock?: BlockRow;
};

/**
 * Owner-scoped, prepared, bounded read queries for Today. Every statement uses a named index; none
 * scans history. Implementations never write and never cache planning content.
 */
export interface TodayQueryPort extends Pick<
  PlanningQueryPort,
  | 'getPlanProfile'
  | 'readRecord'
  | 'listRoutines'
  | 'listMaterializedOccurrences'
  | 'listCapacityConstraints'
  | 'getActivePlacement'
  | 'getPlannedActionBlock'
> {
  /**
   * Non-superseded planned, completed, and skipped blocks intersecting `[startsAt, endsAt)` whose
   * start is at most `dayBlockLookbackHours` (48 h) before `startsAt`, ordered by start, end, id.
   */
  listDayBlocks(
    ownerId: OwnerId,
    bounds: { readonly startsAt: Instant; readonly endsAt: Instant },
  ): Promise<readonly BlockRow[]>;
  /** Active Day placements of non-archived Actions on exactly `date`, in (order key, id) order. */
  listDayActionPlacements(ownerId: OwnerId, date: CalendarDate): Promise<readonly PlacementRow[]>;
  /**
   * Active Week placements whose week contains `date`, of planned or in-progress Actions without a
   * planned block; in (week start, order key, id) order.
   */
  listWeekActionPlacements(
    ownerId: OwnerId,
    date: CalendarDate,
    limit: number,
  ): Promise<Bounded<PlacementRow>>;
  /**
   * Unfinished Actions (inbox, planned, scheduled, in progress) with an active Week-commitment
   * selection whose week contains `date`; in (week start, order key, id) order of the selection.
   */
  listWeekCommitmentActions(
    ownerId: OwnerId,
    date: CalendarDate,
    limit: number,
  ): Promise<Bounded<ActionSummary>>;
  /** Active day focus rows of one profile and date in (order key, id) order; at most three. */
  listDayFocus(
    ownerId: OwnerId,
    profileId: UUID,
    date: CalendarDate,
  ): Promise<readonly DayFocusRow[]>;
  /** One Action for Focus mode, or null when it does not exist for this owner. */
  getFocusAction(ownerId: OwnerId, actionId: UUID): Promise<FocusActionRow | null>;
}
