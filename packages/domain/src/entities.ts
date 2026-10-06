import { isAvailabilityWindowOrdered } from './capacity.js';
import {
  err,
  ok,
  parseUUID,
  type DomainResult,
  type EntityId,
  type EntityRef,
  type Instant,
  type OwnerId,
  type ProfileId,
} from './contracts.js';
import type {
  GeneratedOccurrencePeriod,
  RecurrenceRuleV1,
  RoutineOccurrenceKey,
} from './recurrence.js';
import { parseRecurrenceRuleV1 } from './recurrence.js';
import type {
  ActionState,
  AxisState,
  CommitmentState,
  ContextState,
  MilestoneState,
  NoteState,
  OutcomeState,
  ProjectState,
  ReminderState,
  ReviewState,
  RoutineOccurrenceState,
  RoutineState,
  TemplateState,
  TimeBlockState,
} from './states.js';
import type {
  CalendarDate,
  DstGapPolicy,
  DstOverlapPolicy,
  DueValue,
  FixedInterval,
  HorizonPeriod,
  IanaTimeZone,
  MonthKey,
  TargetWindow,
  WallTime,
  WeekPeriod,
  Weekday,
  YearKey,
} from './time.js';
import { createFixedInterval, parseIanaTimeZone, parseInstant } from './time.js';

export interface SyncableEntityMetadata {
  readonly id: EntityId;
  readonly ownerId: OwnerId;
  readonly localRevision: number;
  readonly serverRevision?: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly archivedAt?: Instant;
}

export type TimeFormat = '12_hour' | '24_hour';
export type Priority = 'low' | 'normal' | 'high';
export const energyLabels = ['low', 'medium', 'high', 'focused'] as const;
export type EnergyLabel = (typeof energyLabels)[number];
export type ConstraintStrength = 'hard' | 'soft' | 'unknown';
export type CommitmentStrength = 'hard' | 'soft';
export type CaptureOrigin =
  | 'global_capture'
  | 'onboarding'
  | 'today'
  | 'plan'
  | 'axis'
  | 'review'
  | 'inbox'
  | 'project'
  | 'import'
  | 'other';

export interface Profile extends SyncableEntityMetadata {
  readonly preferredName?: string;
  readonly planningTimeZone: IanaTimeZone;
  readonly weekStart: Weekday;
  readonly timeFormat: TimeFormat;
  readonly localeOverride?: string;
  readonly defaultsConfirmedAt?: Instant;
}

export interface Axis extends SyncableEntityMetadata {
  readonly title: string;
  readonly purpose?: string;
  readonly color?: string;
  readonly icon?: string;
  readonly orderKey: string;
  readonly state: AxisState;
  readonly stateBeforeArchive?: Exclude<AxisState, 'archived'>;
}

export type OutcomeProgress =
  | { readonly mode: 'none' }
  | { readonly mode: 'manual'; readonly percentage: number }
  | { readonly mode: 'milestone_derived' };

export interface Outcome extends SyncableEntityMetadata {
  readonly title: string;
  readonly successDefinition: string;
  readonly targetWindow?: TargetWindow;
  readonly progress: OutcomeProgress;
  readonly axisId?: EntityId;
  readonly orderKey: string;
  readonly state: OutcomeState;
  readonly stateBeforeArchive?: Exclude<OutcomeState, 'archived'>;
}

export interface Milestone extends SyncableEntityMetadata {
  readonly title: string;
  readonly measurableCheckpoint: string;
  readonly outcomeId: EntityId;
  readonly targetWindow?: TargetWindow;
  readonly orderKey: string;
  readonly state: MilestoneState;
  readonly stateBeforeArchive?: Exclude<MilestoneState, 'archived'>;
}

export interface Project extends SyncableEntityMetadata {
  readonly title: string;
  readonly description?: string;
  readonly desiredResult?: string;
  readonly notes?: string;
  readonly targetWindow?: TargetWindow;
  readonly axisId?: EntityId;
  readonly primaryOutcomeId?: EntityId;
  readonly orderKey: string;
  readonly state: ProjectState;
  readonly stateBeforeArchive?: Exclude<ProjectState, 'archived'>;
}

export interface Action extends SyncableEntityMetadata {
  readonly title: string;
  readonly captureOrigin: CaptureOrigin;
  readonly note?: string;
  readonly axisId?: EntityId;
  readonly projectId?: EntityId;
  readonly due?: DueValue;
  readonly estimateMinutes?: number;
  readonly energy?: EnergyLabel;
  readonly priority?: Priority;
  readonly orderKey: string;
  readonly state: ActionState;
  readonly stateBeforeArchive?: Exclude<ActionState, 'archived'>;
  readonly completedAt?: Instant;
  readonly convertedTo?: { readonly type: 'note' | 'project'; readonly id: EntityId };
}

export interface Note extends SyncableEntityMetadata {
  readonly title?: string;
  readonly body?: string;
  readonly axisId?: EntityId;
  readonly projectId?: EntityId;
  readonly orderKey: string;
  readonly state: NoteState;
  readonly stateBeforeArchive?: Exclude<NoteState, 'archived'>;
}

export interface Commitment extends SyncableEntityMetadata {
  readonly title: string;
  readonly strength: CommitmentStrength;
  readonly currentTimeBlockId?: EntityId;
  readonly state: CommitmentState;
  readonly stateBeforeArchive?: Exclude<CommitmentState, 'archived'>;
}

export type TimeBlockTarget =
  | { readonly kind: 'action'; readonly actionId: EntityId }
  | { readonly kind: 'routine_occurrence'; readonly routineOccurrenceId: EntityId }
  | { readonly kind: 'commitment'; readonly commitmentId: EntityId }
  | { readonly kind: 'custom'; readonly title: string };

export interface TimeBlock extends SyncableEntityMetadata {
  readonly interval: FixedInterval;
  readonly target: TimeBlockTarget;
  readonly state: TimeBlockState;
  readonly supersededById?: EntityId;
  readonly overlapAcknowledged?: boolean;
}

export type RoutineZonePolicy =
  | { readonly kind: 'follow_profile' }
  | { readonly kind: 'fixed_zone'; readonly timeZone: IanaTimeZone };

export type RoutineSchedulingMode =
  | { readonly kind: 'day_flexible' }
  | {
      readonly kind: 'time_specific';
      readonly wallTime: WallTime;
      readonly durationMinutes: number;
      readonly zonePolicy: RoutineZonePolicy;
      readonly gapPolicy: DstGapPolicy;
      readonly overlapPolicy: DstOverlapPolicy;
    };

export interface Routine extends SyncableEntityMetadata {
  readonly title: string;
  readonly description?: string;
  readonly axisId?: EntityId;
  readonly generation: number;
  readonly rule: RecurrenceRuleV1;
  readonly schedulingMode: RoutineSchedulingMode;
  readonly orderKey: string;
  readonly state: RoutineState;
  readonly stateBeforeArchive?: Exclude<RoutineState, 'archived'>;
  readonly pauseEffectiveOn?: CalendarDate;
  readonly resumeEffectiveOn?: CalendarDate;
}

export interface RoutineActionDefaults extends SyncableEntityMetadata {
  readonly routineId: EntityId;
  readonly generation: number;
  readonly projectId?: EntityId;
  readonly note?: string;
  readonly estimateMinutes?: number;
  readonly energy?: EnergyLabel;
  readonly priority?: Priority;
}

export interface RoutineOccurrence extends SyncableEntityMetadata {
  readonly routineId: EntityId;
  readonly generation: number;
  readonly logicalKey: RoutineOccurrenceKey;
  readonly period: GeneratedOccurrencePeriod;
  readonly state: RoutineOccurrenceState;
  readonly targetCount?: number;
  readonly completedCount?: number;
  readonly completionInstants?: readonly Instant[];
  readonly extraCompletionsConfirmed?: boolean;
}

export type TemplateItemKind =
  'axis' | 'outcome' | 'milestone' | 'project' | 'action' | 'note' | 'routine' | 'commitment';

export interface TemplateBlueprintItemV1 {
  readonly templateKey: string;
  readonly kind: TemplateItemKind;
  readonly parentTemplateKey?: string;
  readonly title: string;
  readonly note?: string;
  readonly estimateMinutes?: number;
  readonly energy?: EnergyLabel;
  readonly priority?: Priority;
}

export interface TemplateBlueprintV1 {
  readonly version: 1;
  readonly items: readonly TemplateBlueprintItemV1[];
}

/** Version 2 adds optional anchor-relative planning; items without an offset stay unscheduled. */
export interface TemplateBlueprintItemV2 extends TemplateBlueprintItemV1 {
  readonly relativeDayOffset?: number;
  readonly localStartTime?: WallTime;
  readonly durationMinutes?: number;
}

export interface TemplateBlueprintV2 {
  readonly version: 2;
  readonly items: readonly TemplateBlueprintItemV2[];
}

export type TemplateBlueprint = TemplateBlueprintV1 | TemplateBlueprintV2;

export interface Template extends SyncableEntityMetadata {
  readonly title: string;
  readonly description?: string;
  readonly blueprint: TemplateBlueprint;
  readonly state: TemplateState;
  readonly stateBeforeArchive?: Exclude<TemplateState, 'archived'>;
}

export type ReviewType = 'daily' | 'weekly' | 'monthly' | 'yearly';
/** Every decision a Review item can record (Review,; stored in `review_items.decision`). */
export const reviewDecisionKinds = [
  'complete',
  'carry',
  'move',
  'pause',
  'cancel',
  'skip',
  'continue',
  'archive',
  'focus',
  'commit',
  'note',
] as const;
export type ReviewDecisionKind = (typeof reviewDecisionKinds)[number];

export interface ReviewDecision {
  readonly target: EntityRef;
  readonly decision: ReviewDecisionKind;
  readonly note?: string;
  readonly orderKey: string;
}

export interface Review extends SyncableEntityMetadata {
  readonly profileId: ProfileId;
  readonly reviewType: ReviewType;
  readonly period: HorizonPeriod;
  readonly notes?: string;
  readonly energy?: EnergyLabel;
  readonly decisions: readonly ReviewDecision[];
  readonly state: ReviewState;
  readonly stateBeforeArchive?: Exclude<ReviewState, 'archived'>;
}

export type ReminderTarget =
  | { readonly kind: 'action'; readonly actionId: EntityId }
  | { readonly kind: 'time_block'; readonly timeBlockId: EntityId }
  | { readonly kind: 'routine'; readonly routineId: EntityId }
  | { readonly kind: 'review'; readonly reviewId: EntityId };

export type ReminderSchedule =
  | {
      readonly kind: 'at';
      readonly remindAt: Instant;
      readonly timeZone: IanaTimeZone;
    }
  | {
      readonly kind: 'relative';
      readonly remindAt: Instant;
      readonly offsetMinutes: number;
      readonly timeZone: IanaTimeZone;
    };

export interface Reminder extends SyncableEntityMetadata {
  readonly target: ReminderTarget;
  readonly schedule: ReminderSchedule;
  readonly state: ReminderState;
}

export type ContextCategory =
  | 'identity_locale'
  | 'roles_axes'
  | 'availability'
  | 'commitments'
  | 'preferences'
  | 'goals'
  | 'boundaries'
  | 'sensitive_notes';
export type ContextSensitivity = 'normal' | 'sensitive';
export type ContextSource = 'user' | 'device' | 'import';

export interface UserContext extends SyncableEntityMetadata {
  readonly category: ContextCategory;
  readonly contextKey: string;
  readonly value: string;
  readonly source: ContextSource;
  readonly sensitivity: ContextSensitivity;
  readonly strength: ConstraintStrength;
  /** Context data remains private; this compatibility field always records `not_shared`. */
  readonly futureSharing: 'not_shared';
  readonly state: ContextState;
  readonly stateBeforeArchive?: Exclude<ContextState, 'archived'>;
}

export type ConstraintKind = 'availability' | 'protected_interval' | 'capacity' | 'other';

export type ConstraintValueV1 =
  | {
      readonly kind: 'availability';
      readonly windows: readonly {
        readonly weekday: Weekday;
        readonly start: WallTime;
        readonly end: WallTime;
      }[];
    }
  | { readonly kind: 'protected_interval'; readonly interval: FixedInterval }
  | { readonly kind: 'capacity'; readonly period: 'day' | 'week'; readonly minutes: number }
  | { readonly kind: 'other'; readonly description: string };

export interface Constraint extends SyncableEntityMetadata {
  readonly contextId?: EntityId;
  readonly constraintKind: ConstraintKind;
  readonly strength: ConstraintStrength;
  readonly valueSchemaVersion: 1;
  readonly value: ConstraintValueV1;
  readonly state: ContextState;
  readonly stateBeforeArchive?: Exclude<ContextState, 'archived'>;
}

export type PlacementTargetType = 'outcome' | 'project' | 'milestone' | 'action';
export type PlacementTarget = EntityRef<PlacementTargetType>;

export interface PlanningPlacement extends SyncableEntityMetadata {
  readonly target: PlacementTarget;
  readonly period: HorizonPeriod;
  readonly orderKey: string;
}

export type FocusSelectionKind = 'day_focus' | 'week_commitment';

export interface FocusSelection extends SyncableEntityMetadata {
  readonly profileId: ProfileId;
  readonly kind: FocusSelectionKind;
  readonly target: EntityRef<'action' | 'routine_occurrence' | 'project' | 'milestone'>;
  readonly period: HorizonPeriod;
  readonly orderKey: string;
}

export interface Theme extends SyncableEntityMetadata {
  readonly profileId: ProfileId;
  readonly month: MonthKey;
  readonly text: string;
}

export interface Direction extends SyncableEntityMetadata {
  readonly profileId: ProfileId;
  readonly year: YearKey;
  readonly text: string;
}

export const validateThemeSnapshot = (theme: Theme): DomainResult<Theme> => {
  if (theme.text.trim().length === 0 || theme.text.length > 2000) {
    return invalidEntity('theme_required_text');
  }
  return ok(theme);
};

export const validateDirectionSnapshot = (direction: Direction): DomainResult<Direction> => {
  if (direction.text.trim().length === 0 || direction.text.length > 2000) {
    return invalidEntity('direction_required_text');
  }
  return ok(direction);
};

const invalidEntity = (reason: string): DomainResult<never> =>
  err({
    code: 'invalid_value',
    message: 'The entity snapshot violates a domain invariant.',
    details: { reason },
  });

export interface ActionSnapshotCounts {
  readonly activePlacementCount: number;
  readonly currentPlannedBlockCount: number;
}

export const validateActionSnapshot = (
  action: Action,
  counts: ActionSnapshotCounts,
): DomainResult<Action> => {
  if (
    action.title.trim().length === 0 ||
    action.title.length > 200 ||
    (action.note !== undefined && action.note.length > 10_000) ||
    action.captureOrigin.trim().length === 0 ||
    action.orderKey.trim().length === 0
  ) {
    return invalidEntity('action_required_text');
  }
  if (
    !Number.isInteger(counts.activePlacementCount) ||
    counts.activePlacementCount < 0 ||
    counts.activePlacementCount > 1 ||
    !Number.isInteger(counts.currentPlannedBlockCount) ||
    counts.currentPlannedBlockCount < 0 ||
    counts.currentPlannedBlockCount > 1
  ) {
    return invalidEntity('action_cardinality');
  }
  if (
    action.state === 'inbox' &&
    (counts.activePlacementCount !== 0 || counts.currentPlannedBlockCount !== 0)
  ) {
    return invalidEntity('inbox_action');
  }
  if (action.state === 'scheduled' && counts.currentPlannedBlockCount !== 1) {
    return invalidEntity('scheduled_action');
  }
  if (
    action.estimateMinutes !== undefined &&
    (!Number.isInteger(action.estimateMinutes) ||
      action.estimateMinutes <= 0 ||
      action.estimateMinutes > 10_080)
  ) {
    return invalidEntity('estimate_minutes');
  }
  if (action.energy !== undefined && !energyLabels.includes(action.energy)) {
    return invalidEntity('energy');
  }
  const isArchived = action.state === 'archived';
  if (
    isArchived !== (action.archivedAt !== undefined) ||
    isArchived !== (action.stateBeforeArchive !== undefined) ||
    (action.convertedTo !== undefined && !isArchived)
  ) {
    return invalidEntity('action_archive_metadata');
  }
  const preservesCompletion =
    action.state === 'completed' ||
    (action.state === 'archived' && action.stateBeforeArchive === 'completed');
  if (preservesCompletion !== (action.completedAt !== undefined)) {
    return invalidEntity('action_completion_metadata');
  }
  return ok(action);
};

export const validateCommitmentSnapshot = (
  commitment: Commitment,
  currentPlannedBlockCount: number,
): DomainResult<Commitment> => {
  if (
    commitment.title.trim().length === 0 ||
    !Number.isInteger(currentPlannedBlockCount) ||
    currentPlannedBlockCount < 0 ||
    currentPlannedBlockCount > 1 ||
    (commitment.state === 'planned' && currentPlannedBlockCount !== 1)
  ) {
    return invalidEntity('commitment');
  }
  return ok(commitment);
};

export const validateTimeBlockSnapshot = (block: TimeBlock): DomainResult<TimeBlock> => {
  if (
    !createFixedInterval(block.interval.startsAt, block.interval.endsAt, block.interval.timeZone)
      .ok ||
    !validateTimeBlockTarget(block.target).ok ||
    (block.supersededById !== undefined && block.state !== 'canceled')
  ) {
    return invalidEntity('time_block');
  }
  return ok(block);
};

export const validateRoutineSnapshot = (routine: Routine): DomainResult<Routine> => {
  if (
    routine.title.trim().length === 0 ||
    routine.orderKey.trim().length === 0 ||
    !Number.isInteger(routine.generation) ||
    routine.generation < 1 ||
    !parseRecurrenceRuleV1(routine.rule).ok ||
    (routine.schedulingMode.kind === 'time_specific' &&
      (!Number.isInteger(routine.schedulingMode.durationMinutes) ||
        routine.schedulingMode.durationMinutes <= 0)) ||
    (routine.state === 'paused' && routine.pauseEffectiveOn === undefined)
  ) {
    return invalidEntity('routine');
  }
  return ok(routine);
};

export const validateOutcomeSnapshot = (outcome: Outcome): DomainResult<Outcome> => {
  if (
    outcome.title.trim().length === 0 ||
    outcome.successDefinition.trim().length === 0 ||
    outcome.orderKey.trim().length === 0
  ) {
    return invalidEntity('outcome_required_text');
  }
  if (
    outcome.progress.mode === 'manual' &&
    (!Number.isInteger(outcome.progress.percentage) ||
      outcome.progress.percentage < 0 ||
      outcome.progress.percentage > 100)
  ) {
    return invalidEntity('outcome_progress');
  }
  return ok(outcome);
};

export const validateProjectSnapshot = (project: Project): DomainResult<Project> => {
  if (project.title.trim().length === 0 || project.orderKey.trim().length === 0) {
    return invalidEntity('project_required_text');
  }
  const preservesIdea =
    project.state === 'idea' ||
    (project.state === 'archived' && project.stateBeforeArchive === 'idea');
  if (
    (project.desiredResult !== undefined && project.desiredResult.trim().length === 0) ||
    (!preservesIdea && project.desiredResult === undefined)
  ) {
    return invalidEntity('project_desired_result');
  }
  return ok(project);
};

export const validateNoteSnapshot = (note: Note): DomainResult<Note> => {
  if ((note.title?.trim().length ?? 0) === 0 && (note.body?.trim().length ?? 0) === 0) {
    return invalidEntity('note_content');
  }
  if (note.orderKey.trim().length === 0) return invalidEntity('order_key');
  return ok(note);
};

export const validateTemplateSnapshot = (template: Template): DomainResult<Template> => {
  if (
    template.title.trim().length === 0 ||
    template.title.length > 200 ||
    (template.blueprint.version !== 1 && template.blueprint.version !== 2)
  ) {
    return invalidEntity('template');
  }
  const keys = template.blueprint.items.map((item) => item.templateKey);
  if (
    keys.some((key) => key.trim().length === 0) ||
    new Set(keys).size !== keys.length ||
    template.blueprint.items.some(
      (item) =>
        item.title.trim().length === 0 ||
        (item.parentTemplateKey !== undefined && !keys.includes(item.parentTemplateKey)),
    )
  ) {
    return invalidEntity('template_blueprint');
  }
  return ok(template);
};

export const validateConstraintSnapshot = (constraint: Constraint): DomainResult<Constraint> => {
  if (constraint.valueSchemaVersion !== 1 || constraint.constraintKind !== constraint.value.kind) {
    return invalidEntity('constraint_schema');
  }
  switch (constraint.value.kind) {
    case 'availability':
      if (
        constraint.value.windows.some(
          (window) => !isAvailabilityWindowOrdered(window.start, window.end),
        )
      ) {
        return invalidEntity('availability_window');
      }
      break;
    case 'protected_interval':
      break;
    case 'capacity':
      if (!Number.isInteger(constraint.value.minutes) || constraint.value.minutes < 0) {
        return invalidEntity('capacity');
      }
      break;
    case 'other':
      if (constraint.value.description.trim().length === 0) {
        return invalidEntity('constraint_description');
      }
      break;
  }
  return ok(constraint);
};

const validEntityId = (value: unknown): value is EntityId =>
  typeof value === 'string' && parseUUID(value).ok;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const validateTimeBlockTarget = (value: unknown): DomainResult<TimeBlockTarget> => {
  if (!isRecord(value) || typeof value['kind'] !== 'string')
    return invalidEntity('time_block_target');
  switch (value['kind']) {
    case 'action':
      return validEntityId(value['actionId'])
        ? ok({ kind: 'action', actionId: value['actionId'] })
        : invalidEntity('time_block_target');
    case 'routine_occurrence':
      return validEntityId(value['routineOccurrenceId'])
        ? ok({ kind: 'routine_occurrence', routineOccurrenceId: value['routineOccurrenceId'] })
        : invalidEntity('time_block_target');
    case 'commitment':
      return validEntityId(value['commitmentId'])
        ? ok({ kind: 'commitment', commitmentId: value['commitmentId'] })
        : invalidEntity('time_block_target');
    case 'custom':
      return typeof value['title'] === 'string' && value['title'].trim().length > 0
        ? ok({ kind: 'custom', title: value['title'].trim() })
        : invalidEntity('time_block_target');
    default:
      return invalidEntity('time_block_target');
  }
};

export const validateReminderTarget = (value: unknown): DomainResult<ReminderTarget> => {
  if (!isRecord(value) || typeof value['kind'] !== 'string')
    return invalidEntity('reminder_target');
  switch (value['kind']) {
    case 'action':
      return validEntityId(value['actionId'])
        ? ok({ kind: 'action', actionId: value['actionId'] })
        : invalidEntity('reminder_target');
    case 'time_block':
      return validEntityId(value['timeBlockId'])
        ? ok({ kind: 'time_block', timeBlockId: value['timeBlockId'] })
        : invalidEntity('reminder_target');
    case 'routine':
      return validEntityId(value['routineId'])
        ? ok({ kind: 'routine', routineId: value['routineId'] })
        : invalidEntity('reminder_target');
    case 'review':
      return validEntityId(value['reviewId'])
        ? ok({ kind: 'review', reviewId: value['reviewId'] })
        : invalidEntity('reminder_target');
    default:
      return invalidEntity('reminder_target');
  }
};

export const validateReminderSchedule = (value: unknown): DomainResult<ReminderSchedule> => {
  if (
    !isRecord(value) ||
    (value['kind'] !== 'at' && value['kind'] !== 'relative') ||
    typeof value['remindAt'] !== 'string' ||
    !parseInstant(value['remindAt']).ok ||
    typeof value['timeZone'] !== 'string' ||
    !parseIanaTimeZone(value['timeZone']).ok
  ) {
    return invalidEntity('reminder_schedule');
  }
  const remindAt = parseInstant(value['remindAt']);
  const timeZone = parseIanaTimeZone(value['timeZone']);
  if (!remindAt.ok || !timeZone.ok) return invalidEntity('reminder_schedule');
  if (value['kind'] === 'at') {
    return value['offsetMinutes'] === undefined
      ? ok({ kind: 'at', remindAt: remindAt.value, timeZone: timeZone.value })
      : invalidEntity('reminder_schedule');
  }
  return typeof value['offsetMinutes'] === 'number' &&
    Number.isInteger(value['offsetMinutes']) &&
    Math.abs(value['offsetMinutes']) <= 10_080
    ? ok({
        kind: 'relative',
        remindAt: remindAt.value,
        offsetMinutes: value['offsetMinutes'],
        timeZone: timeZone.value,
      })
    : invalidEntity('reminder_schedule');
};

export interface RoutineActionDefaultsContext {
  readonly routineOwnerId: OwnerId;
  readonly projectOwnerId?: OwnerId;
}

export const validateRoutineActionDefaults = (
  defaults: RoutineActionDefaults,
  context: RoutineActionDefaultsContext,
): DomainResult<RoutineActionDefaults> => {
  if (defaults.ownerId !== context.routineOwnerId) {
    return err({
      code: 'owner_mismatch',
      message: 'Routine defaults and Routine must share an owner.',
    });
  }
  if (
    defaults.projectId !== undefined &&
    (context.projectOwnerId === undefined || defaults.ownerId !== context.projectOwnerId)
  ) {
    return err({
      code: 'owner_mismatch',
      message: 'Routine defaults and Project must share an owner.',
    });
  }
  if (!Number.isInteger(defaults.generation) || defaults.generation < 1) {
    return invalidEntity('routine_defaults_generation');
  }
  if (
    defaults.estimateMinutes !== undefined &&
    (!Number.isInteger(defaults.estimateMinutes) || defaults.estimateMinutes <= 0)
  ) {
    return invalidEntity('routine_defaults_estimate');
  }
  return ok(defaults);
};

export const validateRoutineOccurrenceSnapshot = (
  occurrence: RoutineOccurrence,
): DomainResult<RoutineOccurrence> => {
  if (!Number.isInteger(occurrence.generation) || occurrence.generation < 1) {
    return invalidEntity('occurrence_generation');
  }

  if (occurrence.period.kind === 'date') {
    if (occurrence.targetCount !== undefined || occurrence.completedCount !== undefined) {
      return invalidEntity('date_occurrence_counter');
    }
    return ok(occurrence);
  }

  const target = occurrence.targetCount;
  const completed = occurrence.completedCount;
  if (
    target === undefined ||
    completed === undefined ||
    target !== occurrence.period.targetCount ||
    !Number.isInteger(target) ||
    target < 1 ||
    !Number.isInteger(completed) ||
    completed < 0
  ) {
    return invalidEntity('weekly_count_counter');
  }
  if (completed > target && occurrence.extraCompletionsConfirmed !== true) {
    return invalidEntity('extra_completion_confirmation');
  }
  if (occurrence.state === 'completed' ? completed < target : completed >= target) {
    return invalidEntity('weekly_count_state');
  }
  return ok(occurrence);
};

export const isWeekPeriod = (period: HorizonPeriod): period is WeekPeriod => period.kind === 'week';
