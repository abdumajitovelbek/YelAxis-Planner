/**
 * Reviews application contracts: canonical documents, read models, command inputs,
 * the manual Review facade, and its owner-scoped, bounded query port.
 *
 * A Review looks back on one exact period (`ReviewPeriod`) and plans the period that follows. Its
 * decisions are review items: drafts until Finish applies them, in one `executeCommand`
 * transaction, through the same planners the normal commands use (End Day, focus, Week
 * commitments, Outcome/Milestone/Project transitions and archive, month themes, year directions).
 * Every command writes expected revisions, minimized `{ operation }` events with per-record types,
 * a receipt, and a grouped `planning.restore_v1` undo applied with `PlanningApplication.undo`.
 * Due is derived, never stored, and an overdue review never blocks anything.
 */
import type {
  CalendarDate,
  CommandId,
  EnergyLabel,
  GeneratedOccurrencePeriod,
  Instant,
  MonthKey,
  OwnerId,
  ReviewDecisionKind,
  ReviewDirectionChoice,
  ReviewDirectionDecision,
  ReviewDue,
  ReviewPeriod,
  ReviewStatus,
  ReviewTargetKind,
  ReviewType,
  UUID,
  WeekPeriod,
  Weekday,
  YearKey,
} from '@yelaxis/domain';

import type { Bounded } from './alignment-contracts';
import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import type {
  ActionSummary,
  OccurrenceTargetInput,
  PlacementPeriodInput,
  PlanProfile,
  PlanningQueryPort,
  ReminderView,
  WeekSelectionRow,
} from './planning-contracts';
import type {
  EndDayInput,
  EndDayView,
  FocusChoices,
  FocusTargetInput,
  TodayQueryPort,
} from './today-contracts';

/* ───────────────────────── Canonical documents ───────────────────────── */

/**
 * An ordered list a review chooses for the period it plans: End Day's next-day focus (daily), and
 * the planning Week's commitments and first-day focus (weekly).
 */
export type ReviewListKey = 'next_focus' | 'commitments' | 'first_day_focus';

/** `review_checkpoints` row document (entity type `review`). */
export interface ReviewDocument {
  readonly profileId: UUID;
  readonly reviewType: ReviewType;
  readonly periodKey: string;
  readonly periodStart: CalendarDate;
  readonly periodEnd: CalendarDate;
  /** Weekly only: the first weekday the period was created with. */
  readonly weekStart?: Weekday;
  /** At most `reviewLimits.notes` characters; blank is absent. */
  readonly notes?: string;
  /** Daily only. */
  readonly energy?: EnergyLabel;
  /** Monthly only: the planning month's theme chosen in this review. */
  readonly themeText?: string;
  /** Yearly only. */
  readonly directionChoice?: ReviewDirectionChoice;
  /** Yearly `new` only. */
  readonly directionText?: string;
  /**
   * The lists the person emptied on purpose in the last Save or Finish (the input named the list
   * as `[]`), so a resumed draft starts them from no items instead of the plan's current list.
   * Daily may hold only `next_focus`; weekly only `commitments` and `first_day_focus`. Unique,
   * sorted, and non-empty when present; absent when no list was cleared.
   */
  readonly clearedLists?: readonly ReviewListKey[];
  readonly state: 'draft' | 'skipped' | 'completed' | 'archived';
  readonly stateBeforeArchive?: 'draft' | 'skipped' | 'completed';
  readonly completedAt?: Instant;
  readonly archivedAt?: Instant;
}

/** What a review item is about, as stored. */
export type ReviewItemTargetDocument =
  | { readonly kind: 'axis'; readonly axisId: UUID }
  | { readonly kind: 'outcome'; readonly outcomeId: UUID }
  | { readonly kind: 'milestone'; readonly milestoneId: UUID }
  | { readonly kind: 'project'; readonly projectId: UUID }
  | { readonly kind: 'action'; readonly actionId: UUID }
  /** Stored with its Routine plus the occurrence's generation and logical period. */
  | {
      readonly kind: 'routine_occurrence';
      readonly routineId: UUID;
      readonly generation: number;
      readonly period: GeneratedOccurrencePeriod;
    }
  /** Legacy kinds the schema allows; Review never writes them. */
  | { readonly kind: 'routine'; readonly routineId: UUID }
  | { readonly kind: 'commitment'; readonly commitmentId: UUID }
  /**
   * The target was permanently deleted (placement contract, permanent delete rule 6): the decision
   * and its note stay; the reference is cleared and history shows "Deleted object".
   */
  | {
      readonly kind: 'deleted';
      readonly deletedKind: ReviewTargetKind | 'routine' | 'commitment';
      readonly deletedAt: Instant;
    };

/** `review_items` row document (entity type `review_item`). */
export interface ReviewItemDocument {
  readonly reviewId: UUID;
  readonly target: ReviewItemTargetDocument;
  readonly decision: ReviewDecisionKind;
  /** `move` only: the chosen Day, Week, or Month. */
  readonly period?: PlacementPeriodInput;
  /** `note` decisions (what supported an Axis); at most `reviewLimits.itemNote` characters. */
  readonly note?: string;
  /** Order within the review; focus and commitment items keep the person's order. */
  readonly orderKey: string;
  /** Set when the choice is removed from a draft; an archived item is never applied or listed. */
  readonly archivedAt?: Instant;
}

/* ───────────────────────── Read models ───────────────────────── */

/** One review in lists: the overview, in-progress drafts, and history. Never a score or grade. */
export interface ReviewSummary {
  readonly reviewId: UUID;
  readonly localRevision: number;
  readonly period: ReviewPeriod;
  readonly state: 'draft' | 'skipped' | 'completed';
  readonly energy?: EnergyLabel;
  /** The first 200 characters of the notes. */
  readonly notesExcerpt?: string;
  /** Active (non-archived) items. */
  readonly decisionCount: number;
  readonly updatedAt: Instant;
  /**
   * When the review was first saved (row `created_at`). Adapters should report it; it is optional
   * only so an adapter written before it keeps compiling, and `SavedReview.createdAt` then falls
   * back to `updatedAt`.
   */
  readonly createdAt?: Instant;
  readonly completedAt?: Instant;
}

/** The one checkpoint offered for a review type (`currentReviewCheckpoint`). */
export interface ReviewCheckpoint {
  readonly period: ReviewPeriod;
  readonly due: ReviewDue;
  readonly status: ReviewStatus;
  readonly review?: ReviewSummary;
}

export interface ReviewOverview {
  readonly profile: PlanProfile;
  readonly today: CalendarDate;
  /** Daily, weekly, monthly, and yearly, in that order. */
  readonly checkpoints: readonly ReviewCheckpoint[];
  /**
   * Drafts of other periods (an earlier period, or one from before a planning-zone or first-weekday
   * change), newest period first; at most 20, with the full count.
   */
  readonly inProgress: Bounded<ReviewSummary>;
}

export interface ReviewHistoryPage {
  /** Draft, skipped, and completed reviews, newest period first; at most 20. */
  readonly items: readonly ReviewSummary[];
  /** Pass back to read the next page; absent on the last page. */
  readonly nextCursor?: string;
}

/** For the Today header: only weekly, monthly, and yearly checkpoints. */
export interface ReviewNotice {
  /** Checkpoints on or after their last day that are not completed or skipped. */
  readonly due: readonly ReviewCheckpoint[];
}

/** What a saved item names, for display. */
export type ReviewItemTargetView =
  | {
      readonly kind: 'axis' | 'outcome' | 'milestone' | 'project' | 'action';
      readonly id: UUID;
      readonly title: string;
      /** The object's current state (text only; never a score). */
      readonly state: string;
    }
  | {
      readonly kind: 'routine_occurrence';
      readonly routineId: UUID;
      readonly routineTitle: string;
      /** Names the occurrence in a command; `revision` is never stored. */
      readonly occurrence: OccurrenceTargetInput;
    }
  | { readonly kind: 'routine'; readonly id: UUID; readonly title: string }
  | { readonly kind: 'commitment'; readonly id: UUID; readonly title: string }
  /** "Deleted object". */
  | { readonly kind: 'deleted' };

export interface SavedReviewItem {
  readonly itemId: UUID;
  readonly localRevision: number;
  readonly target: ReviewItemTargetView;
  readonly decision: ReviewDecisionKind;
  readonly period?: PlacementPeriodInput;
  readonly note?: string;
  /** 1-based position among the review's active items with the same decision slot. */
  readonly position: number;
}

export interface SavedReview {
  readonly reviewId: UUID;
  readonly localRevision: number;
  readonly state: 'draft' | 'skipped' | 'completed';
  readonly notes?: string;
  readonly energy?: EnergyLabel;
  readonly themeText?: string;
  readonly direction?: ReviewDirectionDecision;
  /**
   * The lists this review cleared on purpose (`ReviewDocument.clearedLists`). A resumed draft starts
   * each list from its saved items if any, else from no items when the list is named here, else
   * from the plan's current list.
   */
  readonly clearedLists?: readonly ReviewListKey[];
  /** Active items in (order key, id) order. */
  readonly items: readonly SavedReviewItem[];
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly completedAt?: Instant;
  /**
   * Review: the scheduled "Remind me to finish" reminder at a chosen time; absent when
   * it is off. Saved on this device only; the notification application handles delivery. Finishing the review
   * leaves it as it is, so a completed review may still show one the person can turn off.
   */
  readonly reminder?: ReminderView;
}

/** An Outcome, Milestone, or Project offered for a decision. */
export interface ReviewObjectRow {
  readonly kind: 'outcome' | 'milestone' | 'project';
  readonly id: UUID;
  readonly localRevision: number;
  readonly title: string;
  readonly state: string;
  /** The Axis title (Outcome, Project) or the parent Outcome title (Milestone). */
  readonly context?: string;
  readonly targetStart?: CalendarDate;
  readonly targetEnd?: CalendarDate;
}

/** An active or blocked Project in the weekly review, with its next Action. */
export interface ReviewProjectRow extends ReviewObjectRow {
  readonly kind: 'project';
  readonly nextAction?: { readonly id: UUID; readonly title: string };
}

export interface ReviewAxisRow {
  readonly id: UUID;
  readonly title: string;
  readonly color?: string;
  readonly icon?: string;
}

/** Something that can become one of the planning Week's (at most three) commitments. */
export interface ReviewCommitmentCandidate {
  readonly kind: 'action' | 'project' | 'milestone';
  readonly id: UUID;
  readonly title: string;
  readonly state: string;
  /** Already one of the planning Week's commitments. Never preselected otherwise. */
  readonly selected: boolean;
}

export interface DailyReviewContext {
  /** End Day for the reviewed date (its carry date is the planning day). */
  readonly endDay: EndDayView;
}

export interface WeeklyReviewContext {
  /**
   * The reviewed week, plan-scoped like End Day: Actions placed on the Week or one of its days, or
   * with a block in it; `done` completed, `open` unfinished; each at most 50 with the full count.
   */
  readonly done: Bounded<ActionSummary>;
  readonly open: Bounded<ActionSummary>;
  /** Materialized dated Routine Occurrences of the reviewed week by state. */
  readonly routines: { readonly completed: number; readonly skipped: number };
  /** Inbox Actions now. */
  readonly inboxCount: number;
  /** Active and blocked Projects, at most 50. */
  readonly projects: Bounded<ReviewProjectRow>;
  /** Active Axes in order, for "What supported each Axis?". */
  readonly axes: Bounded<ReviewAxisRow>;
  /** The planning Week (`reviewPlanningPeriod`). */
  readonly planningWeek: WeekPeriod;
  /** Its current commitments, in order. */
  readonly commitments: readonly WeekSelectionRow[];
  /**
   * Unfinished Actions placed on the planning Week or its days (plan order), then active and
   * blocked Projects, then active Milestones; at most 100. Never ranked or preselected.
   */
  readonly commitmentCandidates: Bounded<ReviewCommitmentCandidate>;
  /** Focus choices for the planning Week's first day, or today when that day has passed. */
  readonly firstDayFocus: FocusChoices;
}

export interface MonthlyReviewContext {
  /** Active and paused Outcomes, at most 100. */
  readonly outcomes: Bounded<ReviewObjectRow>;
  /** Active Milestones, at most 100. */
  readonly milestones: Bounded<ReviewObjectRow>;
  /** Active, blocked, and paused Projects, at most 100. */
  readonly projects: Bounded<ReviewObjectRow>;
  readonly planningMonth: MonthKey;
  /** The planning month's current theme. */
  readonly theme?: string;
}

export interface YearlyReviewContext {
  /** Active and paused Outcomes, at most 100. */
  readonly outcomes: Bounded<ReviewObjectRow>;
  /** The reviewed year's direction. */
  readonly reviewedDirection?: string;
  readonly planningYear: YearKey;
  /** The planning year's current direction. */
  readonly planningDirection?: string;
}

interface ReviewViewBase {
  readonly profile: PlanProfile;
  readonly today: CalendarDate;
  readonly period: ReviewPeriod;
  readonly due: ReviewDue;
  /** The period has started (`isReviewablePeriod`). */
  readonly reviewable: boolean;
  /** The period starts on the Profile's current first weekday (always true except weekly). */
  readonly aligned: boolean;
  /** This type's current checkpoint, the clear path when it differs from `period`. */
  readonly currentCheckpoint: ReviewPeriod;
  /** The period the review plans for; absent when the period is not reviewable. */
  readonly planning?: ReviewPeriod;
  readonly saved: SavedReview | null;
  /**
   * The review can be saved, skipped, or finished: reviewable, not completed, and aligned or
   * already saved. The context below is loaded only then.
   */
  readonly editable: boolean;
}

export type ReviewView =
  | (ReviewViewBase & { readonly type: 'daily'; readonly context: DailyReviewContext | null })
  | (ReviewViewBase & { readonly type: 'weekly'; readonly context: WeeklyReviewContext | null })
  | (ReviewViewBase & { readonly type: 'monthly'; readonly context: MonthlyReviewContext | null })
  | (ReviewViewBase & { readonly type: 'yearly'; readonly context: YearlyReviewContext | null });

/** The most recent note written for an Axis in a completed review. */
export interface AxisReviewNote {
  readonly text: string;
  readonly reviewId: UUID;
  readonly reviewType: ReviewType;
  readonly period: ReviewPeriod;
  readonly completedAt: Instant;
}

/* ───────────────────────── Command inputs ───────────────────────── */

interface ReviewInputBase {
  readonly periodKey: string;
  /** The saved review's local revision; omitted when the period has no review yet. */
  readonly revision?: number;
  readonly notes?: string;
}

/** An Outcome, Milestone, or Project decision; `revision` is expected when Finish applies it. */
export interface ReviewObjectDecisionInput {
  readonly id: string;
  readonly revision: number;
  readonly decision: ReviewDecisionKind;
}

export interface DailyReviewInput extends ReviewInputBase {
  readonly type: 'daily';
  readonly energy?: string;
  /**
   * End Day choices ("Decide later" is simply not listed). Finish requires `carryTo`, exactly as
   * `applyEndDay` does; Save ignores it. `nextFocus: []` clears the next day's focus on Finish, and
   * the saved review remembers the cleared list (`clearedLists`); omitted leaves it unchanged.
   */
  readonly endDay: Omit<EndDayInput, 'date' | 'carryTo'> & { readonly carryTo?: string };
}

export interface WeeklyReviewInput extends ReviewInputBase {
  readonly type: 'weekly';
  /** `continue` or `pause`. */
  readonly projects: readonly ReviewObjectDecisionInput[];
  /** What supported each Axis; blank notes are dropped. */
  readonly axisNotes: readonly { readonly axisId: string; readonly note: string }[];
  /**
   * The planning Week's commitments, ordered, at most three. Omitted leaves them unchanged; `[]`
   * clears them on Finish, and the saved review remembers the cleared list (`clearedLists`).
   */
  readonly commitments?: readonly {
    readonly kind: 'action' | 'project' | 'milestone';
    readonly id: string;
  }[];
  /**
   * The first day's focus, ordered, at most three. Omitted leaves it unchanged; `[]` clears it on
   * Finish, and the saved review remembers the cleared list.
   */
  readonly firstDayFocus?: readonly FocusTargetInput[];
}

export interface MonthlyReviewInput extends ReviewInputBase {
  readonly type: 'monthly';
  readonly outcomes: readonly ReviewObjectDecisionInput[];
  readonly milestones: readonly ReviewObjectDecisionInput[];
  readonly projects: readonly ReviewObjectDecisionInput[];
  /** The planning month's theme; omitted or blank leaves it unchanged. */
  readonly theme?: string;
}

export interface YearlyReviewInput extends ReviewInputBase {
  readonly type: 'yearly';
  readonly outcomes: readonly ReviewObjectDecisionInput[];
  /** Omitted records no direction decision. */
  readonly direction?: ReviewDirectionDecision;
}

export type ReviewInput =
  DailyReviewInput | WeeklyReviewInput | MonthlyReviewInput | YearlyReviewInput;

/** A "Remind me to finish" time: a date and wall time in the planning zone. */
export interface ReviewReminderInput {
  readonly date: string;
  readonly time: string;
}

/* ───────────────────────── Facade ───────────────────────── */

export type ReviewResult = Promise<ApplicationResult<CommandReceipt>>;

export interface ReviewApplication {
  /* Queries (read-only; never write). */
  getOverview(): Promise<ReviewOverview>;
  /** `cursor` comes from a previous page. An invalid type or cursor reads the first page of all. */
  listHistory(options?: {
    readonly type?: ReviewType;
    readonly cursor?: string;
  }): Promise<ReviewHistoryPage>;
  /** Null for an invalid type or period key. */
  getReview(type: string, periodKey: string): Promise<ReviewView | null>;
  getNotice(): Promise<ReviewNotice>;

  /* Commands: one executeCommand each; the grouped undo is applied with PlanningApplication.undo. */
  /** Save a draft (first save creates it; a skipped review is resumed). Nothing is applied. */
  saveReview(input: ReviewInput, commandId?: CommandId): ReviewResult;
  /** Skip: nothing is applied; saved choices are kept. */
  skipReview(
    input: { readonly type: ReviewType; readonly periodKey: string; readonly revision?: number },
    commandId?: CommandId,
  ): ReviewResult;
  /** Save the final choices, apply every decision, and complete the review, in one command. */
  finishReview(input: ReviewInput, commandId?: CommandId): ReviewResult;
  /**
   * Set or replace the "Remind me to finish" reminder of a saved draft or skipped review
   * `revision` is the saved review's; `reminderRevision` is the shown reminder's and
   * is omitted when the review showed none. One command with a `reminder.set` event and a grouped
   * undo; nothing is scheduled or delivered.
   */
  setReviewReminder(
    input: {
      readonly reviewId: string;
      readonly revision: number;
      readonly reminderRevision?: number;
      readonly reminder: ReviewReminderInput;
    },
    commandId?: CommandId,
  ): ReviewResult;
  /** Turn the review's scheduled reminder off (`reminder.canceled`), in any review state. */
  turnOffReviewReminder(
    input: { readonly reviewId: string; readonly reminderRevision: number },
    commandId?: CommandId,
  ): ReviewResult;
}

/* ───────────────────────── Query port ───────────────────────── */

/** A review item with what it names, for display and for draft updates. */
export interface ReviewItemRow {
  readonly record: CanonicalRecordState;
  readonly target: ReviewItemTargetView;
}

/**
 * Owner-scoped, prepared, bounded read queries for Reviews. Every statement uses a named index.
 * Implementations never write and never cache planning content.
 */
export interface ReviewQueryPort
  extends
    TodayQueryPort,
    Pick<
      PlanningQueryPort,
      | 'listPlacements'
      | 'listBlocks'
      | 'listWeekSelections'
      | 'listMonthThemes'
      | 'getYearDirection'
    > {
  /** The one non-archived review of this profile, type, and exact period, or null. */
  getReviewRecord(
    ownerId: OwnerId,
    profileId: UUID,
    period: Pick<ReviewPeriod, 'type' | 'start' | 'end'>,
  ): Promise<CanonicalRecordState | null>;
  /** A review's active items in (order key, id) order; at most `reviewLimits.items` + 1. */
  listReviewItems(ownerId: OwnerId, reviewId: UUID): Promise<readonly ReviewItemRow[]>;
  /**
   * The reminder of one review: its scheduled one, else its most recently changed
   * one, or null.
   */
  getReviewReminder(ownerId: OwnerId, reviewId: UUID): Promise<CanonicalRecordState | null>;
  /**
   * Non-archived reviews of a profile in the given states, newest period first ((period start,
   * id) descending), strictly before `before` when given; at most `limit`.
   */
  listReviews(
    ownerId: OwnerId,
    profileId: UUID,
    options: {
      readonly type?: ReviewType;
      readonly states: readonly ('draft' | 'skipped' | 'completed')[];
      readonly before?: { readonly periodStart: CalendarDate; readonly id: UUID };
      readonly limit: number;
    },
  ): Promise<readonly ReviewSummary[]>;
  /** Actions in the Inbox now. */
  countInboxActions(ownerId: OwnerId): Promise<number>;
  /** Active and blocked Projects in Axis order, then unassigned, with their next Action. */
  listReviewProjects(ownerId: OwnerId, limit: number): Promise<Bounded<ReviewProjectRow>>;
  /** Active Axes in order. */
  listReviewAxes(ownerId: OwnerId, limit: number): Promise<Bounded<ReviewAxisRow>>;
  /** Non-archived Outcomes, Milestones, or Projects in the given states, in their own order. */
  listReviewObjects(
    ownerId: OwnerId,
    kind: 'outcome' | 'milestone' | 'project',
    states: readonly string[],
    limit: number,
  ): Promise<Bounded<ReviewObjectRow>>;
}
