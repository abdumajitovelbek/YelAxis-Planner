/**
 * planning Horizons and Scheduling application contracts.
 *
 * Canonical document shapes (persisted by data codecs), read-model views assembled from the
 * planning query port, and the manual planning facade used by the web composition root. Every
 * write goes through `executeCommand`; React never owns a planning store.
 */
import type {
  CalendarDate,
  CapacityRules,
  CommandId,
  ConstraintStrength,
  DayCapacity,
  EnergyLabel,
  GeneratedOccurrencePeriod,
  HorizonPeriod,
  IanaTimeZone,
  Instant,
  MaterializedOccurrenceSnapshot,
  MonthKey,
  OccurrenceOverrideV1,
  OutcomeState,
  Priority,
  ProjectState,
  RecurrenceRuleV1,
  RoutineOccurrenceKey,
  RoutineOccurrenceState,
  RoutineSchedulingMode,
  RoutineState,
  TemplateBlueprint,
  TemplatePreview,
  TimeFormat,
  UUID,
  WallTime,
  WeekCapacity,
  WeekPeriod,
  Weekday,
  YearKey,
  ActionState,
  CommitmentState,
  CommitmentStrength,
  MilestoneState,
  DueValue,
  OwnerId,
  ConstraintValueV1,
  ConstraintKind,
  PlanningZoneChangePreviewModel,
  ReminderSchedule,
  ReminderState,
} from '@yelaxis/domain';

import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';

/* ───────────────────────── Canonical documents ───────────────────────── */

export type PlacementTargetDocument =
  | { readonly kind: 'outcome'; readonly outcomeId: UUID }
  | { readonly kind: 'project'; readonly projectId: UUID }
  | { readonly kind: 'milestone'; readonly milestoneId: UUID }
  | { readonly kind: 'action'; readonly actionId: UUID };

/** `planning_placement`: one active direct placement per target. */
export type PlanningPlacementDocument = Readonly<{
  target: PlacementTargetDocument;
  period: HorizonPeriod;
  orderKey: string;
  archivedAt?: Instant;
}>;

export type TimeBlockTargetDocument =
  | { readonly kind: 'action'; readonly actionId: UUID }
  | { readonly kind: 'routine_occurrence'; readonly routineOccurrenceId: UUID }
  | { readonly kind: 'commitment'; readonly commitmentId: UUID }
  | { readonly kind: 'custom'; readonly title: string };

/** `time_block`: exact UTC interval plus authoring IANA zone. Rescheduling supersedes. */
export type TimeBlockDocument = Readonly<{
  target: TimeBlockTargetDocument;
  startsAt: Instant;
  endsAt: Instant;
  timeZone: IanaTimeZone;
  state: 'planned' | 'completed' | 'skipped' | 'canceled';
  supersededById?: UUID;
  overlapAcknowledged: boolean;
}>;

/** `commitment`: a fixed obligation; while `planned` it has exactly one planned Time Block. */
export type CommitmentDocument = Readonly<{
  title: string;
  strength: CommitmentStrength;
  state: CommitmentState;
  stateBeforeArchive?: Exclude<CommitmentState, 'archived'>;
  archivedAt?: Instant;
}>;

export type RoutineGenerationDocument = Readonly<{
  generation: number;
  rule: RecurrenceRuleV1;
  schedulingMode: RoutineSchedulingMode;
}>;

/**
 * `routine`: one series with every recurrence generation. Generations are stored in
 * `routine_generations` with the derived id `deriveNameBasedUuid(namespace, "routine-generation:<routineId>:<n>")`.
 * Earlier generations may only gain an `endsOn`; they are never deleted or rewritten otherwise.
 */
export type RoutineDocument = Readonly<{
  title: string;
  description?: string;
  axisId?: UUID;
  orderKey: string;
  state: RoutineState;
  stateBeforeArchive?: Exclude<RoutineState, 'archived'>;
  pauseEffectiveOn?: CalendarDate;
  archivedAt?: Instant;
  generations: readonly RoutineGenerationDocument[];
}>;

/**
 * `routine_occurrence`: materialized only when completed, skipped, edited, or acknowledged. The id
 * is always `routineOccurrenceId(logicalKey)`. `periodKey` is `occurrencePeriodKey(period)`.
 */
export type RoutineOccurrenceDocument = Readonly<{
  routineId: UUID;
  generation: number;
  periodKey: string;
  period: GeneratedOccurrencePeriod;
  state: RoutineOccurrenceState;
  targetCount?: number;
  completedCount?: number;
  extraCompletionsConfirmed?: boolean;
  override?: OccurrenceOverrideV1;
  completedAt?: Instant;
}>;

/** `routine_action_defaults`: one per Routine generation. */
export type RoutineActionDefaultsDocument = Readonly<{
  routineId: UUID;
  generation: number;
  projectId?: UUID;
  note?: string;
  estimateMinutes?: number;
  energy?: EnergyLabel;
  priority?: Priority;
}>;

/** `template`: user-owned blueprint. Built-in catalog entries are application code, never rows. */
export type TemplateDocument = Readonly<{
  title: string;
  blueprint: TemplateBlueprint;
  state: 'active' | 'archived';
  stateBeforeArchive?: 'active';
  archivedAt?: Instant;
}>;

/** `constraint`: availability windows or a day/week capacity cap. */
export type ConstraintDocument = Readonly<{
  contextId?: UUID;
  constraintKind: ConstraintKind;
  strength: ConstraintStrength;
  value: ConstraintValueV1;
  state: 'active' | 'archived';
  stateBeforeArchive?: 'active';
  archivedAt?: Instant;
}>;

/** `theme`: optional plain-text Month theme; no progress or completion. */
export type MonthThemeDocument = Readonly<{
  profileId: UUID;
  month: MonthKey;
  text: string;
  archivedAt?: Instant;
}>;

/** `direction`: optional plain-text Year direction; no progress or completion. */
export type YearDirectionDocument = Readonly<{
  profileId: UUID;
  year: YearKey;
  text: string;
  archivedAt?: Instant;
}>;

/**
 * `focus_selection` with kind `week_commitment` (week_selections table) or `day_focus`
 * (focus_selections table). Selecting never changes the target.
 */
export type FocusSelectionDocument = Readonly<{
  kind: 'day_focus' | 'week_commitment';
  profileId: UUID;
  target:
    | { readonly kind: 'action'; readonly actionId: UUID }
    | { readonly kind: 'project'; readonly projectId: UUID }
    | { readonly kind: 'milestone'; readonly milestoneId: UUID }
    | { readonly kind: 'routine_occurrence'; readonly routineOccurrenceId: UUID };
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  weekStart?: Weekday;
  orderKey: string;
  archivedAt?: Instant;
}>;

/** `axis` (planning creates Axes only from templates; Axis management shares this document). */
export type AxisDocument = Readonly<{
  title: string;
  purpose?: string;
  color?: string;
  icon?: string;
  orderKey: string;
  state: 'active' | 'archived';
  stateBeforeArchive?: 'active';
  archivedAt?: Instant;
}>;

export type OutcomeProgressDocument =
  | { readonly mode: 'none' }
  | { readonly mode: 'manual'; readonly percentage: number }
  | { readonly mode: 'milestone_derived' };

/** `outcome`: progress is read-only in planning. */
export type OutcomeDocument = Readonly<{
  title: string;
  successDefinition: string;
  axisId?: UUID;
  progress: OutcomeProgressDocument;
  targetStart?: CalendarDate;
  targetEnd?: CalendarDate;
  orderKey: string;
  state: OutcomeState;
  stateBeforeArchive?: Exclude<OutcomeState, 'archived'>;
  archivedAt?: Instant;
}>;

/** `milestone`: always owned by exactly one Outcome. */
export type MilestoneDocument = Readonly<{
  title: string;
  measurableCheckpoint: string;
  outcomeId: UUID;
  targetStart?: CalendarDate;
  targetEnd?: CalendarDate;
  orderKey: string;
  state: MilestoneState;
  stateBeforeArchive?: Exclude<MilestoneState, 'archived'>;
  archivedAt?: Instant;
}>;

/** `project` (shape shared with the Action codec; alignment adds the optional target window). */
export type ProjectDocument = Readonly<{
  title: string;
  description?: string;
  desiredResult?: string;
  notes?: string;
  axisId?: UUID;
  primaryOutcomeId?: UUID;
  targetStart?: CalendarDate;
  targetEnd?: CalendarDate;
  orderKey: string;
  state: ProjectState;
  stateBeforeArchive?: Exclude<ProjectState, 'archived'>;
  archivedAt?: Instant;
}>;

/** `note` (shape shared with the Action codec). */
export type NoteDocument = Readonly<{
  title?: string;
  body?: string;
  axisId?: UUID;
  projectId?: UUID;
  orderKey: string;
  state: 'active' | 'archived';
  stateBeforeArchive?: 'active';
  archivedAt?: Instant;
}>;

/**
 * `profile` as written by planning commands: only the planning preferences. Onboarding fields stay
 * owned by the onboarding persistence and are never read or written through this document.
 */
export type ProfilePlanningDocument = Readonly<{
  planningTimeZone: IanaTimeZone;
  weekStart: Weekday;
  timeFormat: TimeFormat;
}>;

/**
 * `reminder`: a definition for exactly one target, named by one id field. Action
 * reminders keep `actionId`; Review adds Time Block, Routine, and review targets. Nothing is
 * scheduled or delivered here; the notification application handles delivery.
 */
export type PlanningReminderDocument =
  | Readonly<{ actionId: UUID; schedule: ReminderSchedule; state: ReminderState }>
  | Readonly<{ timeBlockId: UUID; schedule: ReminderSchedule; state: ReminderState }>
  | Readonly<{ routineId: UUID; schedule: ReminderSchedule; state: ReminderState }>
  | Readonly<{ reviewId: UUID; schedule: ReminderSchedule; state: ReminderState }>;

/** A Time Block or Routine whose reminder a planning read looks up. */
export type PlanningReminderTarget =
  | { readonly kind: 'time_block'; readonly id: UUID }
  | { readonly kind: 'routine'; readonly id: UUID };

/* ───────────────────────── Read-model rows (query port) ───────────────────────── */

export interface PlanProfile {
  readonly profileId: UUID;
  readonly planningTimeZone: IanaTimeZone;
  readonly weekStart: Weekday;
  readonly timeFormat: TimeFormat;
  /** Profile row revision, used as the expected revision of a planning-zone change. */
  readonly localRevision?: number;
  /** When the Profile was created; reviews never offer a period that ended before it (Review). */
  readonly createdAt?: Instant;
}

export interface ActionSummary {
  readonly id: UUID;
  readonly title: string;
  readonly state: ActionState;
  readonly localRevision: number;
  readonly orderKey: string;
  readonly estimateMinutes?: number;
  readonly energy?: EnergyLabel;
  readonly priority?: Priority;
  readonly due?: DueValue;
  readonly axisTitle?: string;
  readonly projectTitle?: string;
  readonly placement?: {
    readonly id: UUID;
    readonly localRevision: number;
    readonly period: HorizonPeriod;
  };
}

export type BlockTargetView =
  | {
      readonly kind: 'action';
      readonly actionId: UUID;
      readonly title: string;
      readonly actionState: ActionState;
      readonly actionRevision: number;
    }
  | {
      readonly kind: 'commitment';
      readonly commitmentId: UUID;
      readonly title: string;
      readonly strength: CommitmentStrength;
      readonly commitmentState: CommitmentState;
      readonly commitmentRevision: number;
    }
  | {
      readonly kind: 'routine_occurrence';
      readonly routineOccurrenceId: UUID;
      readonly title: string;
    }
  | { readonly kind: 'custom'; readonly title: string };

/** A non-superseded, non-canceled Time Block intersecting a queried window. */
export interface BlockRow {
  readonly id: UUID;
  readonly localRevision: number;
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly timeZone: IanaTimeZone;
  readonly state: 'planned' | 'completed' | 'skipped';
  readonly overlapAcknowledged: boolean;
  readonly target: BlockTargetView;
}

export type PlacedTargetView =
  | { readonly kind: 'action'; readonly action: ActionSummary }
  | {
      readonly kind: 'project';
      readonly id: UUID;
      readonly title: string;
      readonly state: ProjectState;
      readonly localRevision: number;
    }
  | {
      readonly kind: 'milestone';
      readonly id: UUID;
      readonly title: string;
      readonly state: MilestoneState;
      readonly localRevision: number;
      readonly outcomeId: UUID;
      readonly outcomeTitle: string;
    }
  | {
      readonly kind: 'outcome';
      readonly id: UUID;
      readonly title: string;
      readonly state: OutcomeState;
      readonly localRevision: number;
    };

/** An active placement whose period overlaps the queried date range. */
export interface PlacementRow {
  readonly id: UUID;
  readonly localRevision: number;
  readonly period: HorizonPeriod;
  readonly orderKey: string;
  readonly target: PlacedTargetView;
}

export interface WeekSelectionRow {
  readonly id: UUID;
  readonly localRevision: number;
  readonly period: WeekPeriod;
  readonly orderKey: string;
  readonly target:
    | {
        readonly kind: 'action';
        readonly id: UUID;
        readonly title: string;
        readonly state: ActionState;
      }
    | {
        readonly kind: 'project';
        readonly id: UUID;
        readonly title: string;
        readonly state: ProjectState;
      }
    | {
        readonly kind: 'milestone';
        readonly id: UUID;
        readonly title: string;
        readonly state: MilestoneState;
      };
}

export interface RoutineRow {
  readonly id: UUID;
  readonly localRevision: number;
  readonly document: RoutineDocument;
  readonly axisTitle?: string;
  readonly defaults?: RoutineActionDefaultsDocument & {
    readonly id: UUID;
    readonly localRevision: number;
    readonly projectTitle?: string;
  };
}

export interface ConstraintRow {
  readonly id: UUID;
  readonly localRevision: number;
  readonly document: ConstraintDocument;
  /** Private user label from the linked Context, when present. */
  readonly contextLabel?: string;
}

export interface ThemeRow {
  readonly id: UUID;
  readonly localRevision: number;
  readonly month: MonthKey;
  readonly text: string;
}

export interface DirectionRow {
  readonly id: UUID;
  readonly localRevision: number;
  readonly year: YearKey;
  readonly text: string;
}

/**
 * Visible Outcome progress. Milestone-derived progress is a count, never a percentage: `completed`
 * Milestones out of `total` counted ones. From alignment `total` counts active plus
 * completed Milestones and `canceled` reports canceled ones separately; archived ones never count.
 */
export type OutcomeProgressView =
  | { readonly mode: 'none' }
  | { readonly mode: 'manual'; readonly percentage: number }
  | {
      readonly mode: 'milestone_derived';
      readonly completed: number;
      readonly total: number;
      readonly canceled?: number;
    };

export interface OutcomeRow {
  readonly id: UUID;
  readonly title: string;
  readonly successDefinition: string;
  readonly state: OutcomeState;
  readonly localRevision: number;
  readonly axisTitle?: string;
  readonly targetStart?: CalendarDate;
  readonly targetEnd?: CalendarDate;
  readonly progress: OutcomeProgressView;
  readonly placement?: { readonly id: UUID; readonly period: HorizonPeriod };
}

export interface MilestoneRow {
  readonly id: UUID;
  readonly title: string;
  readonly measurableCheckpoint: string;
  readonly state: MilestoneState;
  readonly localRevision: number;
  readonly outcomeId: UUID;
  readonly outcomeTitle: string;
  readonly targetStart?: CalendarDate;
  readonly targetEnd?: CalendarDate;
  readonly placement?: { readonly id: UUID; readonly period: HorizonPeriod };
}

export interface ProjectTargetRow {
  readonly id: UUID;
  readonly title: string;
  readonly state: ProjectState;
  readonly localRevision: number;
  readonly axisTitle?: string;
  readonly targetStart?: CalendarDate;
  readonly targetEnd?: CalendarDate;
  readonly placement?: { readonly id: UUID; readonly period: HorizonPeriod };
}

export interface MilestoneChain {
  readonly milestone: MilestoneRow;
  readonly outcome: OutcomeRow;
  readonly axis?: { readonly id: UUID; readonly title: string };
  readonly projects: readonly {
    readonly id: UUID;
    readonly title: string;
    readonly state: ProjectState;
  }[];
  readonly actions: readonly {
    readonly id: UUID;
    readonly title: string;
    readonly state: ActionState;
  }[];
}

export interface TemplateRow {
  readonly id: UUID;
  readonly localRevision: number;
  readonly document: TemplateDocument;
}

export interface ChoiceRow {
  readonly id: UUID;
  readonly title: string;
  readonly localRevision: number;
}

export interface DateRangeInput {
  readonly start: CalendarDate;
  readonly end: CalendarDate;
}

/**
 * Owner-scoped, prepared, indexed read queries. Implementations never write and never cache
 * planning content outside SQLite. Limits are hard caps; totals report the full count.
 */
/** One item a timed template item would overlap: planned work, or another selected template item. */
export interface TemplateOverlapView {
  /** `block:<id>`, `occurrence:<id>`, or `template:<templateKey>`. */
  readonly key: string;
  readonly title: string;
}

export interface TemplateItemOverlaps {
  readonly templateKey: string;
  readonly overlaps: readonly TemplateOverlapView[];
}

/** A template preview plus, per selected timed item, what its exact time would overlap. */
export interface TemplateApplicationPreview extends TemplatePreview {
  readonly overlaps: readonly TemplateItemOverlaps[];
}

export interface PlanningQueryPort {
  getPlanProfile(ownerId: OwnerId): Promise<PlanProfile>;
  /** Blocks with state planned/completed/skipped, not superseded, intersecting `[startsAt, endsAt)`. */
  listBlocks(ownerId: OwnerId, startsAt: Instant, endsAt: Instant): Promise<readonly BlockRow[]>;
  /** Active (non-archived) placements of every target type whose period overlaps the range. */
  listPlacements(ownerId: OwnerId, range: DateRangeInput): Promise<readonly PlacementRow[]>;
  /** Unfinished Actions (planned/in_progress) with no active placement and no planned block. */
  listBacklog(
    ownerId: OwnerId,
    limit: number,
  ): Promise<{ readonly items: readonly ActionSummary[]; readonly total: number }>;
  /** Unfinished Actions whose active Day/Week placement ended before `before`. */
  listCarryForward(
    ownerId: OwnerId,
    before: CalendarDate,
    limit: number,
  ): Promise<{ readonly items: readonly ActionSummary[]; readonly total: number }>;
  listWeekSelections(ownerId: OwnerId, range: DateRangeInput): Promise<readonly WeekSelectionRow[]>;
  listRoutines(
    ownerId: OwnerId,
    options: { readonly includeArchived: boolean },
  ): Promise<readonly RoutineRow[]>;
  getRoutine(ownerId: OwnerId, routineId: UUID): Promise<RoutineRow | null>;
  /**
   * Materialized occurrences whose logical date, override date, or weekly period intersects the
   * range, optionally limited to one Routine.
   */
  listMaterializedOccurrences(
    ownerId: OwnerId,
    range: DateRangeInput,
    routineId?: UUID,
  ): Promise<readonly MaterializedOccurrenceSnapshot[]>;
  /** Most recent materialized occurrences for one Routine (history), newest first. */
  listOccurrenceHistory(
    ownerId: OwnerId,
    routineId: UUID,
    limit: number,
  ): Promise<readonly MaterializedOccurrenceSnapshot[]>;
  /** Active availability and capacity constraints. */
  listCapacityConstraints(ownerId: OwnerId): Promise<readonly ConstraintRow[]>;
  listMonthThemes(ownerId: OwnerId, year: YearKey): Promise<readonly ThemeRow[]>;
  getYearDirection(ownerId: OwnerId, year: YearKey): Promise<DirectionRow | null>;
  /** Active/paused Outcomes placed in, or with a target window overlapping, the range. */
  listOutcomes(ownerId: OwnerId, range: DateRangeInput): Promise<readonly OutcomeRow[]>;
  /** Non-archived Milestones placed in, or with a target window overlapping, the range. */
  listMilestones(ownerId: OwnerId, range: DateRangeInput): Promise<readonly MilestoneRow[]>;
  /** Non-archived Projects placed in, or with a target window overlapping, the range. */
  listProjectTargets(ownerId: OwnerId, range: DateRangeInput): Promise<readonly ProjectTargetRow[]>;
  getMilestoneChain(ownerId: OwnerId, milestoneId: UUID): Promise<MilestoneChain | null>;
  listTemplates(
    ownerId: OwnerId,
    options: { readonly includeArchived: boolean },
  ): Promise<readonly TemplateRow[]>;
  getTemplate(ownerId: OwnerId, templateId: UUID): Promise<TemplateRow | null>;
  listAxes(ownerId: OwnerId): Promise<readonly ChoiceRow[]>;
  listProjects(ownerId: OwnerId): Promise<readonly ChoiceRow[]>;
  getAction(ownerId: OwnerId, actionId: UUID): Promise<ActionSummary | null>;
  /** Canonical record lookups used before opening a command transaction. */
  readRecord(
    ownerId: OwnerId,
    ref: CanonicalRecordState['ref'],
  ): Promise<CanonicalRecordState | null>;
  /**
   * The one active (not archived, not deleted) placement record of a target, if any. Looked up by
   * target id so it never depends on a bounded period list.
   */
  getActivePlacement(
    ownerId: OwnerId,
    kind: PlacementTargetDocument['kind'],
    targetId: UUID,
  ): Promise<CanonicalRecordState | null>;
  /** The Action's planned block, if any. */
  getPlannedActionBlock(ownerId: OwnerId, actionId: UUID): Promise<CanonicalRecordState | null>;
  /** The Commitment's planned block, if any. */
  getPlannedCommitmentBlock(
    ownerId: OwnerId,
    commitmentId: UUID,
  ): Promise<CanonicalRecordState | null>;
  /**
   * The reminder of one Time Block or Routine: its scheduled one, else its most
   * recently changed one, or null. A reminder that was turned off is set again rather than
   * duplicated, so a target normally has at most one reminder record.
   */
  getTargetReminder(
    ownerId: OwnerId,
    target: PlanningReminderTarget,
  ): Promise<CanonicalRecordState | null>;
}

/* ───────────────────────── Projections returned to the UI ───────────────────────── */

export interface OccurrenceRef {
  readonly routineId: UUID;
  readonly routineTitle: string;
  readonly occurrenceId: UUID;
  readonly logicalKey: RoutineOccurrenceKey;
  readonly generation: number;
  readonly period: GeneratedOccurrencePeriod;
  readonly materialized: boolean;
  readonly localRevision?: number;
}

export interface OccurrenceEntry {
  readonly ref: OccurrenceRef;
  readonly state: RoutineOccurrenceState;
  readonly date?: CalendarDate;
  readonly moved: boolean;
  readonly timing:
    | { readonly kind: 'flexible' }
    | { readonly kind: 'weekly_count' }
    | { readonly kind: 'timed'; readonly startsAt: Instant; readonly endsAt: Instant }
    | { readonly kind: 'dst_skipped'; readonly wallTime: WallTime };
  readonly targetCount?: number;
  readonly completedCount?: number;
}

export type TimedEntryKind =
  'action_block' | 'commitment_block' | 'custom_block' | 'occurrence_block' | 'routine_occurrence';

/** One item on a Day/Week timeline. Keys are `block:<id>` or `occurrence:<occurrenceId>`. */
export interface TimedEntry {
  readonly key: string;
  readonly kind: TimedEntryKind;
  readonly title: string;
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly timeZone: IanaTimeZone;
  /** Local (planning zone) start date/time and end date/time. */
  readonly localDate: CalendarDate;
  readonly localStart: WallTime;
  readonly localEndDate: CalendarDate;
  readonly localEnd: WallTime;
  readonly durationMinutes: number;
  readonly state: 'planned' | 'completed' | 'skipped';
  readonly overlapAcknowledged: boolean;
  /** Keys of planned items this entry overlaps. */
  readonly conflictsWith: readonly string[];
  readonly block?: BlockRow;
  readonly occurrence?: OccurrenceEntry;
}

export interface ConflictView {
  readonly firstKey: string;
  readonly secondKey: string;
  readonly overlapStartsAt: Instant;
  readonly overlapEndsAt: Instant;
  readonly kept: boolean;
  readonly first: TimedEntry;
  readonly second: TimedEntry;
}

export interface AvailabilityWindowView {
  readonly start: WallTime;
  readonly end: WallTime;
}

export interface DayColumn {
  readonly date: CalendarDate;
  readonly weekday: Weekday;
  readonly capacity: DayCapacity;
  readonly availability: readonly AvailabilityWindowView[];
  /** Timed items intersecting this local date, ordered by start. */
  readonly timed: readonly TimedEntry[];
  /** Actions placed on this Day with no planned block, in persisted order. */
  readonly flexibleActions: readonly ActionSummary[];
  /** Day-flexible Routine Occurrences and DST-skipped timed occurrences on this date. */
  readonly flexibleOccurrences: readonly OccurrenceEntry[];
}

export interface DayPlan {
  readonly profile: PlanProfile;
  readonly today: CalendarDate;
  readonly day: DayColumn;
  readonly week: WeekPeriod;
  readonly conflicts: readonly ConflictView[];
  readonly weeklyCounts: readonly OccurrenceEntry[];
  readonly backlog: { readonly items: readonly ActionSummary[]; readonly total: number };
}

export interface WeekPlan {
  readonly profile: PlanProfile;
  readonly today: CalendarDate;
  readonly week: WeekPeriod;
  readonly capacity: WeekCapacity;
  readonly days: readonly DayColumn[];
  /** Commitment blocks in the week, ordered by start: the week begins with reality. */
  readonly fixed: readonly TimedEntry[];
  readonly conflicts: readonly ConflictView[];
  readonly carryForward: { readonly items: readonly ActionSummary[]; readonly total: number };
  /** Actions placed on the Week horizon (no specific day yet). */
  readonly weekActions: readonly ActionSummary[];
  /** Projects and Milestones placed on this Week. */
  readonly weekObjects: readonly PlacementRow[];
  readonly weekCommitments: readonly WeekSelectionRow[];
  readonly weeklyCounts: readonly OccurrenceEntry[];
  readonly backlog: { readonly items: readonly ActionSummary[]; readonly total: number };
}

export interface WeekDensity {
  readonly week: WeekPeriod;
  readonly plannedMinutes: number;
  readonly commitmentCount: number;
  readonly milestoneCount: number;
  /** Neutral accessible text, e.g. "12 hours 30 minutes planned, 3 commitments, 2 milestones". */
  readonly summary: string;
}

export interface MonthPlan {
  readonly profile: PlanProfile;
  readonly today: CalendarDate;
  readonly month: MonthKey;
  readonly range: DateRangeInput;
  readonly theme?: ThemeRow;
  readonly weeks: readonly WeekDensity[];
  readonly milestones: readonly MilestoneRow[];
  readonly commitments: readonly TimedEntry[];
  readonly projectTargets: readonly ProjectTargetRow[];
  readonly outcomes: readonly OutcomeRow[];
  /** Actions placed on the Month horizon. */
  readonly monthActions: readonly ActionSummary[];
}

export interface YearMonthSummary {
  readonly month: MonthKey;
  readonly theme?: ThemeRow;
  readonly milestoneCount: number;
  readonly outcomeCount: number;
}

export interface ImportantDate {
  readonly date: CalendarDate;
  readonly kind: 'outcome_target' | 'milestone_target' | 'project_target';
  readonly id: UUID;
  readonly title: string;
}

export interface YearPlan {
  readonly profile: PlanProfile;
  readonly today: CalendarDate;
  readonly year: YearKey;
  readonly direction?: DirectionRow;
  readonly months: readonly YearMonthSummary[];
  readonly outcomes: readonly OutcomeRow[];
  readonly milestones: readonly MilestoneRow[];
  readonly importantDates: readonly ImportantDate[];
}

export interface RoutineSummary {
  readonly id: UUID;
  readonly localRevision: number;
  readonly title: string;
  readonly description?: string;
  readonly axisId?: UUID;
  readonly axisTitle?: string;
  readonly state: RoutineState;
  readonly pauseEffectiveOn?: CalendarDate;
  readonly generations: readonly RoutineGenerationDocument[];
  readonly current: RoutineGenerationDocument;
  readonly defaults?: RoutineRow['defaults'];
}

/**
 * A scheduled reminder definition as a dialog shows it. It is saved on this device
 * only; notification permission and delivery belong to the notification application.
 */
export interface ReminderView {
  readonly reminderId: UUID;
  /** Pass as `reminderRevision` to replace or turn off this reminder. */
  readonly localRevision: number;
  /** `at` a chosen date and time, or `relative`: minutes before the block or occurrence start. */
  readonly kind: 'at' | 'relative';
  /** The resolved instant: for a Routine, the next occurrence's reminder. */
  readonly remindAt: Instant;
  readonly timeZone: IanaTimeZone;
  /** `remindAt` read in `timeZone`. */
  readonly date: CalendarDate;
  readonly time: WallTime;
  /** `relative` only. */
  readonly minutesBefore?: number;
}

export interface RoutineDetail {
  readonly routine: RoutineSummary;
  readonly profile: PlanProfile;
  readonly today: CalendarDate;
  /** Next occurrences from today (bounded window), including materialized overrides. */
  readonly upcoming: readonly OccurrenceEntry[];
  /** Recent materialized occurrences, newest first. */
  readonly history: readonly OccurrenceEntry[];
  /** The Routine's scheduled reminder (minutes before each occurrence); absent when it is off. */
  readonly reminder?: ReminderView;
}

export interface RoutinePreviewEntry {
  readonly date?: CalendarDate;
  readonly period: GeneratedOccurrencePeriod;
  readonly timing: OccurrenceEntry['timing'];
  /** Local start in the occurrence zone and a DST note when a policy applied. */
  readonly localStart?: WallTime;
  readonly dstNote?: 'gap_shifted' | 'gap_skipped' | 'repeated_earlier' | 'repeated_later';
}

export interface TemplateListItem {
  readonly id: UUID;
  readonly source: 'built_in' | 'user';
  readonly title: string;
  readonly description?: string;
  readonly itemCount: number;
  readonly blueprintVersion: 1 | 2;
  readonly state: 'active' | 'archived';
  readonly localRevision?: number;
  readonly catalogVersion?: number;
}

export interface TemplateDetail extends TemplateListItem {
  readonly blueprint: TemplateBlueprint;
}

export interface CapacitySettings {
  readonly profile: PlanProfile;
  readonly availability: readonly {
    readonly id: UUID;
    readonly localRevision: number;
    readonly strength: ConstraintStrength;
    readonly windows: readonly {
      readonly weekday: Weekday;
      readonly start: WallTime;
      readonly end: WallTime;
    }[];
    readonly label?: string;
  }[];
  readonly dayCap?: { readonly id: UUID; readonly localRevision: number; readonly minutes: number };
  readonly weekCap?: {
    readonly id: UUID;
    readonly localRevision: number;
    readonly minutes: number;
  };
  readonly rules: CapacityRules;
}

export interface LocalTimeResolution {
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly localStart: WallTime;
  readonly localEnd: WallTime;
  readonly localEndDate: CalendarDate;
  readonly utcOffset: string;
  /** `dst_repeated_later` only when a Routine occurrence uses its later-offset policy. */
  readonly adjustment?: 'dst_gap_shifted' | 'dst_repeated_earlier' | 'dst_repeated_later';
  /**
   * Zone of the local fields when it is not the planning zone's own reading: a Routine
   * occurrence reports the zone its Routine resolves in.
   */
  readonly timeZone?: IanaTimeZone;
  /** Planned items this interval would overlap (keys + titles). */
  readonly overlaps: readonly { readonly key: string; readonly title: string }[];
}

/**
 * What changing the planning zone would do to upcoming Routine Occurrences. Nothing is written:
 * fixed Time Blocks keep their instants, and Day placements, target windows, and completed history
 * are date-only or history and never move.
 */
export interface PlanningZoneChangePreview extends PlanningZoneChangePreviewModel {
  /** Expected revision to pass to `changePlanningZone`. */
  readonly profileRevision: number;
}

/* ───────────────────────── Command inputs ───────────────────────── */

/** A local interval in the planning zone. Duration is always explicit; nothing is invented. */
export interface LocalIntervalInput {
  readonly date: string;
  readonly startTime: string;
  readonly durationMinutes: number;
}

/**
 * Preview of a This-occurrence edit, resolved exactly as `editOccurrence` would store it: omitted
 * time fields keep the occurrence's current values (for a time-specific Routine).
 */
export interface OccurrenceIntervalInput {
  readonly occurrence: OccurrenceTargetInput;
  readonly date: string;
  readonly startTime?: string;
  readonly durationMinutes?: number;
}

/** Identifies a projected (possibly unmaterialized) Routine Occurrence. */
export interface OccurrenceTargetInput {
  readonly routineId: string;
  readonly generation: number;
  readonly period: GeneratedOccurrencePeriod;
  /** Local revision when already materialized; omitted to materialize. */
  readonly revision?: number;
}

export type TimedItemRef =
  | { readonly kind: 'block'; readonly blockId: string; readonly revision: number }
  | { readonly kind: 'occurrence'; readonly occurrence: OccurrenceTargetInput };

export interface RoutineDefaultsInput {
  readonly projectId?: string;
  readonly note?: string;
  readonly estimateMinutes?: number;
  readonly energy?: string;
  readonly priority?: string;
}

export interface RoutineInput {
  readonly title: string;
  readonly description?: string;
  readonly axisId?: string;
  /** Normalized RecurrenceRuleV1 candidate (validated by the domain). */
  readonly rule: unknown;
  /** RoutineSchedulingMode candidate (validated by the domain). */
  readonly schedulingMode: unknown;
  readonly defaults?: RoutineDefaultsInput;
  /**
   * Review: a reminder before each occurrence, created with the Routine in the same command. Only a
   * Routine at a set time accepts one; omitted creates none.
   */
  readonly reminder?: RoutineReminderInput;
}

/** A Time Block reminder: at a chosen date and time (planning zone), or minutes before the start. */
export type TimeBlockReminderInput =
  | { readonly kind: 'at'; readonly date: string; readonly time: string }
  | { readonly kind: 'relative'; readonly minutesBefore: number };

/** A timed Routine reminder: 0 to 10,080 minutes before each occurrence's start. */
export interface RoutineReminderInput {
  readonly minutesBefore: number;
}

export type PlacementPeriodInput = {
  readonly kind: HorizonPeriod['kind'];
  /** Any date inside the requested period, `YYYY-MM-DD`. */
  readonly date: string;
};

export type PlaceableTargetInput =
  | { readonly kind: 'action'; readonly id: string; readonly revision: number }
  | { readonly kind: 'project'; readonly id: string; readonly revision: number }
  | { readonly kind: 'milestone'; readonly id: string; readonly revision: number }
  | { readonly kind: 'outcome'; readonly id: string; readonly revision: number };

export interface AvailabilityInput {
  readonly strength: ConstraintStrength;
  readonly windows: readonly {
    readonly weekday: Weekday;
    readonly start: string;
    readonly end: string;
  }[];
}

export type PlanningResult = Promise<ApplicationResult<CommandReceipt>>;

/* ───────────────────────── Facade ───────────────────────── */

export interface PlanningApplication {
  /* Queries (read-only; never write) */
  getDayPlan(date: string): Promise<DayPlan>;
  getWeekPlan(date: string): Promise<WeekPlan>;
  getMonthPlan(month: string): Promise<MonthPlan>;
  getYearPlan(year: string): Promise<YearPlan>;
  getMilestoneChain(milestoneId: string): Promise<MilestoneChain | null>;
  /**
   * Resolve a local interval in the planning zone and list planned items it would overlap. With
   * `occurrence`, the interval is a This-occurrence edit preview: the start is read in the
   * Routine's zone (fixed zone, else planning zone) with its clock-change policies, exactly as
   * `editOccurrence` would store it, and the occurrence itself is never listed as an overlap.
   */
  resolveLocalInterval(
    input: LocalIntervalInput | OccurrenceIntervalInput,
    exclude?: readonly string[],
  ): Promise<ApplicationResult<LocalTimeResolution>>;
  listRoutines(options?: {
    readonly includeArchived?: boolean;
  }): Promise<readonly RoutineSummary[]>;
  getRoutine(routineId: string): Promise<RoutineDetail | null>;
  previewRoutine(
    input: Pick<RoutineInput, 'rule' | 'schedulingMode'>,
    count?: number,
  ): Promise<ApplicationResult<readonly RoutinePreviewEntry[]>>;
  listTemplates(options?: {
    readonly includeArchived?: boolean;
  }): Promise<readonly TemplateListItem[]>;
  getTemplate(templateId: string): Promise<TemplateDetail | null>;
  previewTemplate(input: {
    readonly templateId: string;
    readonly anchorDate: string;
    readonly timeZone: string;
    readonly selectedKeys?: readonly string[];
  }): Promise<ApplicationResult<TemplateApplicationPreview>>;
  getCapacitySettings(): Promise<CapacitySettings>;
  listAxes(): Promise<readonly ChoiceRow[]>;
  listProjects(): Promise<readonly ChoiceRow[]>;

  /* Time blocks and commitments */
  createCustomBlock(
    input: LocalIntervalInput & { readonly title: string; readonly overlapAcknowledged: boolean },
    commandId?: CommandId,
  ): PlanningResult;
  /** Schedule or reschedule an Action: planned block + Day placement; Action becomes `scheduled`. */
  scheduleAction(
    input: LocalIntervalInput & {
      readonly actionId: string;
      readonly revision: number;
      readonly overlapAcknowledged: boolean;
    },
    commandId?: CommandId,
  ): PlanningResult;
  /** Move/reschedule a planned block (supersedes it). Action blocks also move their Day placement. */
  moveBlock(
    input: LocalIntervalInput & {
      readonly blockId: string;
      readonly revision: number;
      readonly overlapAcknowledged: boolean;
    },
    commandId?: CommandId,
  ): PlanningResult;
  /** Shorten a planned block to a new, strictly shorter duration keeping its start (supersedes). */
  shortenBlock(
    input: {
      readonly blockId: string;
      readonly revision: number;
      readonly durationMinutes: number;
    },
    commandId?: CommandId,
  ): PlanningResult;
  /**
   * Complete/skip/cancel a planned block, or reopen a resolved one. Action blocks never complete the
   * Action unless `alsoCompleteAction` is explicitly true; a `scheduled` Action returns to `planned`
   * when its block leaves `planned`. Canceling a Commitment block cancels the Commitment.
   */
  setBlockState(
    input: {
      readonly blockId: string;
      readonly revision: number;
      readonly to: 'planned' | 'completed' | 'skipped' | 'canceled';
      readonly alsoCompleteAction?: boolean;
    },
    commandId?: CommandId,
  ): PlanningResult;
  /** Explicit Keep-overlap acknowledgement on both conflicting items; audited, undoable. */
  keepOverlap(
    input: { readonly first: TimedItemRef; readonly second: TimedItemRef },
    commandId?: CommandId,
  ): PlanningResult;
  createCommitment(
    input: LocalIntervalInput & {
      readonly title: string;
      readonly strength: CommitmentStrength;
      readonly overlapAcknowledged: boolean;
    },
    commandId?: CommandId,
  ): PlanningResult;

  /* Placements and week commitments */
  place(
    input: { readonly target: PlaceableTargetInput; readonly period: PlacementPeriodInput },
    commandId?: CommandId,
  ): PlanningResult;
  /** Remove a placement; an unscheduled unfinished Action stays `planned` in Backlog. */
  unplace(input: { readonly target: PlaceableTargetInput }, commandId?: CommandId): PlanningResult;
  /** Move several unfinished Actions to one period atomically (carry forward). */
  carryForward(
    input: {
      readonly actions: readonly { readonly id: string; readonly revision: number }[];
      readonly period: PlacementPeriodInput;
    },
    commandId?: CommandId,
  ): PlanningResult;
  reorderPlacement(
    input: {
      readonly placementId: string;
      readonly revision: number;
      readonly direction: 'up' | 'down';
      readonly scope: PlacementPeriodInput;
    },
    commandId?: CommandId,
  ): PlanningResult;
  addWeekCommitment(
    input: {
      readonly weekDate: string;
      readonly target: { readonly kind: 'action' | 'project' | 'milestone'; readonly id: string };
    },
    commandId?: CommandId,
  ): PlanningResult;
  removeWeekCommitment(
    input: { readonly selectionId: string; readonly revision: number },
    commandId?: CommandId,
  ): PlanningResult;

  /* Routines */
  createRoutine(input: RoutineInput, commandId?: CommandId): PlanningResult;
  /** Add repeat behavior to an existing Action: the Action stays a one-off; the Routine starts after it. */
  repeatAfterAction(
    input: RoutineInput & { readonly actionId: string },
    commandId?: CommandId,
  ): PlanningResult;
  editRoutineDetails(
    input: {
      readonly routineId: string;
      readonly revision: number;
      readonly title: string;
      readonly description?: string;
      readonly axisId?: string;
    },
    commandId?: CommandId,
  ): PlanningResult;
  editRoutineThisAndFuture(
    input: {
      readonly routineId: string;
      readonly revision: number;
      readonly selectedOn: string;
      readonly rule: unknown;
      readonly schedulingMode: unknown;
      readonly defaults?: RoutineDefaultsInput;
    },
    commandId?: CommandId,
  ): PlanningResult;
  pauseRoutine(
    input: { readonly routineId: string; readonly revision: number; readonly pauseOn: string },
    commandId?: CommandId,
  ): PlanningResult;
  resumeRoutine(
    input: { readonly routineId: string; readonly revision: number; readonly resumeOn: string },
    commandId?: CommandId,
  ): PlanningResult;
  /**
   * Archive a Routine. Its scheduled reminder is turned off in the same command, the stated
   * sub-operation of the archive policy (the receipt names the reminder record); restoring the
   * Routine does not turn the reminder back on.
   */
  archiveRoutine(
    input: { readonly routineId: string; readonly revision: number },
    commandId?: CommandId,
  ): PlanningResult;
  restoreRoutine(
    input: { readonly routineId: string; readonly revision: number },
    commandId?: CommandId,
  ): PlanningResult;
  completeOccurrence(
    input: { readonly occurrence: OccurrenceTargetInput; readonly confirmExtra?: boolean },
    commandId?: CommandId,
  ): PlanningResult;
  skipOccurrence(
    input: { readonly occurrence: OccurrenceTargetInput },
    commandId?: CommandId,
  ): PlanningResult;
  reopenOccurrence(
    input: { readonly occurrence: OccurrenceTargetInput },
    commandId?: CommandId,
  ): PlanningResult;
  /**
   * This-occurrence edit: move date and/or set time and duration. The rule is unchanged. Times are
   * wall times in the Routine's zone (its fixed zone, else the planning zone). For a time-specific
   * Routine an omitted start or duration keeps the occurrence's current value; for a day-flexible
   * Routine a start and a duration come together, and omitting both removes the time.
   */
  editOccurrence(
    input: {
      readonly occurrence: OccurrenceTargetInput;
      readonly date: string;
      readonly startTime?: string;
      readonly durationMinutes?: number;
      readonly overlapAcknowledged: boolean;
    },
    commandId?: CommandId,
  ): PlanningResult;

  /* Templates */
  applyTemplate(
    input: {
      readonly templateId: string;
      readonly anchorDate: string;
      readonly timeZone: string;
      readonly selectedKeys: readonly string[];
      /**
       * The user's explicit Keep-overlap choice. Required when any timed item overlaps planned work
       * or another selected timed item; the overlapped items are acknowledged in the same command.
       */
      readonly overlapAcknowledged: boolean;
    },
    commandId?: CommandId,
  ): PlanningResult;
  /** Copy a built-in or user template into a new user-owned template. */
  duplicateTemplate(
    input: { readonly templateId: string; readonly title: string },
    commandId?: CommandId,
  ): PlanningResult;
  saveTemplate(
    input: {
      readonly templateId?: string;
      readonly revision?: number;
      readonly title: string;
      readonly blueprint: unknown;
    },
    commandId?: CommandId,
  ): PlanningResult;
  archiveTemplate(
    input: { readonly templateId: string; readonly revision: number },
    commandId?: CommandId,
  ): PlanningResult;
  restoreTemplate(
    input: { readonly templateId: string; readonly revision: number },
    commandId?: CommandId,
  ): PlanningResult;
  /** Copy this week's placed/scheduled Action structure (no completion or history) into a template. */
  saveWeekAsTemplate(
    input: { readonly weekDate: string; readonly title: string },
    commandId?: CommandId,
  ): PlanningResult;

  /* Capacity, themes */
  addAvailability(input: AvailabilityInput, commandId?: CommandId): PlanningResult;
  editAvailability(
    input: AvailabilityInput & { readonly constraintId: string; readonly revision: number },
    commandId?: CommandId,
  ): PlanningResult;
  archiveConstraint(
    input: { readonly constraintId: string; readonly revision: number },
    commandId?: CommandId,
  ): PlanningResult;
  /** Set (create/replace) or clear (`minutes: null`) the day or week cap. */
  setCapacityCap(
    input: { readonly period: 'day' | 'week'; readonly minutes: number | null },
    commandId?: CommandId,
  ): PlanningResult;
  setMonthTheme(
    input: { readonly month: string; readonly text: string },
    commandId?: CommandId,
  ): PlanningResult;
  clearMonthTheme(input: { readonly month: string }, commandId?: CommandId): PlanningResult;
  setYearDirection(
    input: { readonly year: string; readonly text: string },
    commandId?: CommandId,
  ): PlanningResult;
  clearYearDirection(input: { readonly year: string }, commandId?: CommandId): PlanningResult;

  /* Planning zone */
  /** Preview a planning-zone change without writing. An invalid IANA zone is `domain_rejected`. */
  previewPlanningZoneChange(zone: string): Promise<ApplicationResult<PlanningZoneChangePreview>>;
  /**
   * Change only the Profile planning zone (never silently: the user chooses it after a preview).
   * Undo restores the prior zone.
   */
  changePlanningZone(
    input: { readonly zone: string; readonly revision: number },
    commandId?: CommandId,
  ): PlanningResult;

  /* Reminder commands save definitions; delivery belongs to the notification application. */
  /** The block's scheduled reminder, or null (also for an invalid id). */
  getTimeBlockReminder(blockId: string): Promise<ReminderView | null>;
  /**
   * Set or replace a planned block's reminder: at a chosen time, or minutes before its start.
   * `revision` is the block's; `reminderRevision` is the shown reminder's and is omitted when the
   * block showed none. One command with a `reminder.set` event and a grouped undo.
   */
  setTimeBlockReminder(
    input: {
      readonly blockId: string;
      readonly revision: number;
      readonly reminderRevision?: number;
      readonly reminder: TimeBlockReminderInput;
    },
    commandId?: CommandId,
  ): PlanningResult;
  /** Turn a block's scheduled reminder off (`reminder.canceled`); allowed in any block state. */
  turnOffTimeBlockReminder(
    input: { readonly blockId: string; readonly reminderRevision: number },
    commandId?: CommandId,
  ): PlanningResult;
  /**
   * Set or replace an active, time-specific Routine's reminder, minutes before each occurrence. It
   * stores the next occurrence's reminder instant with its offset (`RoutineDetail.reminder`).
   */
  setRoutineReminder(
    input: {
      readonly routineId: string;
      readonly revision: number;
      readonly reminderRevision?: number;
      readonly reminder: RoutineReminderInput;
    },
    commandId?: CommandId,
  ): PlanningResult;
  /** Turn a Routine's scheduled reminder off; archiving the Routine also does this. */
  turnOffRoutineReminder(
    input: { readonly routineId: string; readonly reminderRevision: number },
    commandId?: CommandId,
  ): PlanningResult;

  /** Apply a `planning.restore_v1` undo descriptor. */
  undo(undoId: UUID, commandId?: CommandId): PlanningResult;
}
