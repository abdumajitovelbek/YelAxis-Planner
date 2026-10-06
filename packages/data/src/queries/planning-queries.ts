import type {
  ActionSummary,
  BlockRow,
  BlockTargetView,
  CanonicalRecordState,
  ChoiceRow,
  ConstraintDocument,
  ConstraintRow,
  DateRangeInput,
  DirectionRow,
  MilestoneChain,
  MilestoneRow,
  OutcomeRow,
  PlacedTargetView,
  PlacementRow,
  PlacementTargetDocument,
  PlanProfile,
  PlanningQueryPort,
  PlanningReminderTarget,
  ProjectTargetRow,
  RoutineActionDefaultsDocument,
  RoutineDocument,
  RoutineRow,
  TemplateDocument,
  TemplateRow,
  ThemeRow,
  WeekSelectionRow,
} from '@yelaxis/application';
import {
  occurrenceLogicalKey,
  parseIanaTimeZone,
  parseInstant,
  type ActionState,
  type CalendarDate,
  type CommitmentState,
  type CommitmentStrength,
  type DueValue,
  type EnergyLabel,
  type GeneratedOccurrencePeriod,
  type HorizonPeriod,
  type IanaTimeZone,
  type Instant,
  type MaterializedOccurrenceSnapshot,
  type MilestoneState,
  type MonthKey,
  type OutcomeState,
  type OwnerId,
  type Priority,
  type ProjectState,
  type UUID,
  type WeekPeriod,
  type Weekday,
  type YearKey,
} from '@yelaxis/domain';

import { createDefaultCanonicalCodecRegistry } from '../application/canonical-codecs';
import { DataAdapterError } from '../application/errors';
import { constraintDocumentSchema, decodeConstraintRow } from '../application/horizon-codecs';
import {
  decodePeriodColumns,
  horizonPeriodSchema,
  reminderCanonicalCodec,
  templateCanonicalCodec,
} from '../application/planning-codecs';
import {
  decodeDefaultsRow,
  decodeOccurrenceRow,
  routineActionDefaultsDocumentSchema,
  routineCanonicalCodec,
  routineOccurrenceDocumentSchema,
} from '../application/routine-codecs';
import type { SqliteDriver, SqliteParameter } from '../sqlite/driver';
import { completePages } from './complete-pages';

/** Hard cap for unbounded lists. */
export const maximumList = 200;
/** Worker page size; complete period reads exhaust every page without truncating the plan. */
export const maximumPeriodRows = 1_000;

export type Values = Readonly<Record<string, unknown>>;

/* ───────────────────────── Column readers ───────────────────────── */

export function invalidRow(): never {
  throw new DataAdapterError('invalid_persisted_record');
}

export function text(row: Values, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : invalidRow();
}

export function optionalText(row: Values, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return typeof value === 'string' ? value : invalidRow();
}

export function integer(row: Values, key: string): number {
  const value = row[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : invalidRow();
}

export function optionalInteger(row: Values, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : invalidRow();
}

export function oneOf<Value extends string>(
  row: Values,
  key: string,
  allowed: readonly Value[],
): Value {
  const value = row[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as Value)
    : invalidRow();
}

export function spread<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

export const actionStates: readonly ActionState[] = [
  'inbox',
  'planned',
  'scheduled',
  'in_progress',
  'completed',
  'canceled',
  'archived',
];
export const projectStates: readonly ProjectState[] = [
  'idea',
  'active',
  'blocked',
  'paused',
  'completed',
  'archived',
];
export const milestoneStates: readonly MilestoneState[] = [
  'active',
  'completed',
  'canceled',
  'archived',
];
export const outcomeStates: readonly OutcomeState[] = [
  'active',
  'paused',
  'achieved',
  'abandoned',
  'archived',
];
export const commitmentStates: readonly CommitmentState[] = [
  'planned',
  'completed',
  'canceled',
  'archived',
];
export const weekdayValues: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export function periodFrom(row: Values, prefix: string): HorizonPeriod {
  const parsed = horizonPeriodSchema.safeParse(
    decodePeriodColumns({
      horizon: row[`${prefix}_horizon`],
      periodKey: row[`${prefix}_period_key`],
      start: row[`${prefix}_start`],
      end: row[`${prefix}_end`],
      weekStart: row[`${prefix}_week_start`],
    }),
  );
  return parsed.success ? (parsed.data as HorizonPeriod) : invalidRow();
}

function placementRef(
  row: Values,
): { readonly id: UUID; readonly period: HorizonPeriod } | undefined {
  const id = optionalText(row, 'placement_id');
  return id === undefined ? undefined : { id: id as UUID, period: periodFrom(row, 'placement') };
}

/* ───────────────────────── SQL fragments ───────────────────────── */

export const placementColumns = (alias: string) => `
  ${alias}.id AS placement_id, ${alias}.local_revision AS placement_revision,
  ${alias}.horizon AS placement_horizon, ${alias}.period_key AS placement_period_key,
  ${alias}.period_start_date AS placement_start, ${alias}.period_end_date AS placement_end,
  ${alias}.week_start AS placement_week_start`;

export const actionColumns = `
  a.id AS action_id_value, a.title AS action_title, a.state AS action_state,
  a.local_revision AS action_revision, a.sort_key AS action_sort_key,
  a.estimate_minutes AS action_estimate, a.energy AS action_energy,
  a.priority AS action_priority, a.due_date AS action_due_date, a.due_at_utc AS action_due_at,
  a.due_time_zone AS action_due_zone,
  (SELECT ax.title FROM axes ax
   WHERE ax.owner_id = a.owner_id AND ax.id = a.axis_id AND ax.deleted_at IS NULL) AS action_axis_title,
  (SELECT ap.title FROM projects ap
   WHERE ap.owner_id = a.owner_id AND ap.id = a.project_id AND ap.deleted_at IS NULL)
    AS action_project_title`;

/** Columns of one Time Block row with its target's title and state (see `blockRow`). */
export const blockSelectColumns = `
  b.id, b.local_revision, b.starts_at_utc, b.ends_at_utc, b.time_zone, b.state,
  b.overlap_confirmed, b.action_id, b.routine_occurrence_id, b.commitment_id,
  b.custom_title, a.title AS action_title, a.state AS action_state,
  a.local_revision AS action_revision, c.title AS commitment_title,
  c.strength AS commitment_strength, c.state AS commitment_state,
  c.local_revision AS commitment_revision, r.title AS routine_title`;

/** The joins `blockSelectColumns` reads from, for `time_blocks b`. */
export const blockTargetJoins = `
  LEFT JOIN actions a ON a.owner_id = b.owner_id AND a.id = b.action_id
  LEFT JOIN commitments c ON c.owner_id = b.owner_id AND c.id = b.commitment_id
  LEFT JOIN routine_occurrences ro ON ro.owner_id = b.owner_id AND ro.id = b.routine_occurrence_id
  LEFT JOIN routines r ON r.owner_id = ro.owner_id AND r.id = ro.routine_id`;

export const noPlannedActionBlock = `NOT EXISTS (
  SELECT 1 FROM time_blocks nb
  WHERE nb.owner_id = a.owner_id AND nb.action_id = a.id AND nb.state = 'planned'
    AND nb.deleted_at IS NULL)`;

const activeHorizons = `('year', 'month', 'week', 'day')`;

/**
 * Ids of `table` rows that are placed in a period overlapping [start, end] or whose target window
 * overlaps it. A window with one bound is that single date. Parameters: owner, end, start, owner,
 * start, end, owner, start, end.
 */
const placedOrTargeted = (table: string, placementColumn: string, targetIndex: string) => `
  SELECT pp.${placementColumn} FROM planning_placements pp INDEXED BY idx_placements_period
  WHERE pp.owner_id = ? AND pp.horizon IN ${activeHorizons} AND pp.archived_at IS NULL
    AND pp.deleted_at IS NULL AND pp.${placementColumn} IS NOT NULL
    AND pp.period_start_date <= ? AND pp.period_end_date >= ?
  UNION
  SELECT tw.id FROM ${table} tw INDEXED BY ${targetIndex}
  WHERE tw.owner_id = ? AND tw.deleted_at IS NULL AND tw.target_end_date >= ?
    AND coalesce(tw.target_start_date, tw.target_end_date) <= ?
  UNION
  SELECT tw.id FROM ${table} tw INDEXED BY ${targetIndex}
  WHERE tw.owner_id = ? AND tw.deleted_at IS NULL AND tw.target_end_date IS NULL
    AND tw.target_start_date >= ? AND tw.target_start_date <= ?`;

function placedOrTargetedParameters(ownerId: OwnerId, range: DateRangeInput): SqliteParameter[] {
  return [
    ownerId,
    range.end,
    range.start,
    ownerId,
    range.start,
    range.end,
    ownerId,
    range.start,
    range.end,
  ];
}

/**
 * Milestone-derived progress: completed out of active plus completed Milestones;
 * canceled ones are reported separately and archived ones never count. Shared with alignment.
 */
const outcomeSelect = `
  SELECT o.id, o.sort_key, o.title, o.success_definition, o.state, o.local_revision, o.axis_id,
         o.progress_mode, o.progress_percent, o.target_start_date, o.target_end_date,
         x.title AS axis_title, ${placementColumns('pl')},
         (SELECT COUNT(*) FROM milestones mt INDEXED BY idx_milestones_outcome
          WHERE mt.owner_id = o.owner_id AND mt.outcome_id = o.id
            AND mt.state IN ('active', 'completed') AND mt.deleted_at IS NULL) AS milestone_total,
         (SELECT COUNT(*) FROM milestones mc INDEXED BY idx_milestones_outcome
          WHERE mc.owner_id = o.owner_id AND mc.outcome_id = o.id AND mc.state = 'completed'
            AND mc.deleted_at IS NULL) AS milestone_completed,
         (SELECT COUNT(*) FROM milestones mx INDEXED BY idx_milestones_outcome
          WHERE mx.owner_id = o.owner_id AND mx.outcome_id = o.id AND mx.state = 'canceled'
            AND mx.deleted_at IS NULL) AS milestone_canceled
  FROM outcomes o
  LEFT JOIN axes x ON x.owner_id = o.owner_id AND x.id = o.axis_id AND x.deleted_at IS NULL
  LEFT JOIN planning_placements pl ON pl.owner_id = o.owner_id AND pl.outcome_id = o.id
    AND pl.archived_at IS NULL AND pl.deleted_at IS NULL`;

const milestoneSelect = `
  SELECT m.id, m.sort_key, m.title, m.measurable_checkpoint, m.state, m.local_revision, m.outcome_id,
         mo.title AS outcome_title, m.target_start_date, m.target_end_date,
         ${placementColumns('pl')}
  FROM milestones m
  JOIN outcomes mo ON mo.owner_id = m.owner_id AND mo.id = m.outcome_id
  LEFT JOIN planning_placements pl ON pl.owner_id = m.owner_id AND pl.milestone_id = m.id
    AND pl.archived_at IS NULL AND pl.deleted_at IS NULL`;

const projectSelect = `
  SELECT p.id, p.sort_key, p.title, p.state, p.local_revision, p.target_start_date, p.target_end_date,
         x.title AS axis_title, ${placementColumns('pl')}
  FROM projects p
  LEFT JOIN axes x ON x.owner_id = p.owner_id AND x.id = p.axis_id AND x.deleted_at IS NULL
  LEFT JOIN planning_placements pl ON pl.owner_id = p.owner_id AND pl.project_id = p.id
    AND pl.archived_at IS NULL AND pl.deleted_at IS NULL`;

const routineSelect = `
  SELECT r.*, x.title AS axis_title
  FROM routines r
  LEFT JOIN axes x ON x.owner_id = r.owner_id AND x.id = r.axis_id AND x.deleted_at IS NULL`;

/**
 * Materialized occurrences whose logical period key or override date falls in a window. Each
 * branch has its own index; `routineFilter` optionally narrows both to one Routine. Parameters:
 * owner, key low, key high, [routine], owner, date low, date high, [routine].
 */
const occurrenceWindow = (routineFilter: string) => `
  SELECT o.* FROM routine_occurrences o INDEXED BY idx_routine_occurrences_overlap_end
  WHERE o.owner_id = ? AND o.deleted_at IS NULL
    AND CASE WHEN o.occurrence_kind = 'weekly_count' THEN substr(o.logical_period_key, 12, 10)
      ELSE substr(o.logical_period_key, 1, 10) END >= ? AND o.logical_period_key <= ?${routineFilter}
  UNION
  SELECT o.* FROM routine_occurrences o INDEXED BY idx_routine_occurrences_override_date
  WHERE o.owner_id = ? AND o.deleted_at IS NULL
    AND json_extract(o.override_payload_json, '$.date') >= ?
    AND json_extract(o.override_payload_json, '$.date') <= ?${routineFilter}
  ORDER BY logical_period_key ASC, id ASC
  LIMIT ${String(maximumPeriodRows)};`;

/**
 * The active placement of one target. `column` is only ever one of the fixed target columns below;
 * each has its own partial unique index on active placements.
 */
function activePlacementSql(
  column: 'action_id' | 'project_id' | 'milestone_id' | 'outcome_id',
): string {
  return `
    SELECT id FROM planning_placements
    WHERE owner_id = ? AND ${column} = ? AND archived_at IS NULL AND deleted_at IS NULL
    LIMIT 1;`;
}

const activePlacementStatements: Readonly<
  Record<
    PlacementTargetDocument['kind'],
    | 'activeActionPlacement'
    | 'activeProjectPlacement'
    | 'activeMilestonePlacement'
    | 'activeOutcomePlacement'
  >
> = Object.freeze({
  action: 'activeActionPlacement',
  project: 'activeProjectPlacement',
  milestone: 'activeMilestonePlacement',
  outcome: 'activeOutcomePlacement',
});

/**
 * One target's reminder: its scheduled one, else delivered, else the most recently
 * changed one. Bounded by the target (a target normally holds one reminder record) and searched
 * through the target's lookup index. Parameters: owner, target id.
 */
export function targetReminderSql(
  column: 'time_block_id' | 'routine_id' | 'review_id',
  index: 'idx_reminders_time_block' | 'idx_reminders_routine' | 'idx_reminders_review',
): string {
  return `
    SELECT * FROM reminders INDEXED BY ${index}
    WHERE owner_id = ? AND ${column} = ? AND deleted_at IS NULL
    ORDER BY CASE state WHEN 'scheduled' THEN 0 WHEN 'delivered' THEN 1 ELSE 2 END ASC,
             updated_at DESC, id DESC
    LIMIT 1;`;
}

/** Prepared, owner-scoped statements. Exported so index use can be verified with EXPLAIN. */
export const planningQuerySql = Object.freeze({
  profile: `SELECT id, planning_time_zone, week_start, time_format, local_revision, created_at
            FROM profiles WHERE owner_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1;`,
  listBlocks: `
    SELECT ${blockSelectColumns}
    FROM time_blocks b INDEXED BY idx_time_blocks_overlap_end ${blockTargetJoins}
    WHERE b.owner_id = ? AND b.deleted_at IS NULL AND b.starts_at_utc < ? AND b.ends_at_utc > ?
      AND b.state IN ('planned', 'completed', 'skipped') AND b.superseded_by_id IS NULL
    ORDER BY b.starts_at_utc ASC, b.ends_at_utc ASC, b.id ASC
    LIMIT ${String(maximumPeriodRows)};`,
  listPlacements: `
    SELECT p.id, p.local_revision, p.horizon AS placement_horizon,
           p.period_key AS placement_period_key, p.period_start_date AS placement_start,
           p.period_end_date AS placement_end, p.week_start AS placement_week_start,
           p.sort_key, p.action_id, p.project_id, p.milestone_id, p.outcome_id,
           ${actionColumns},
           pr.title AS project_title, pr.state AS project_state,
           pr.local_revision AS project_revision,
           m.title AS milestone_title, m.state AS milestone_state,
           m.local_revision AS milestone_revision, m.outcome_id AS milestone_outcome_id,
           mo.title AS milestone_outcome_title,
           o.title AS outcome_title, o.state AS outcome_state, o.local_revision AS outcome_revision
    FROM planning_placements p INDEXED BY idx_placements_overlap_end
    LEFT JOIN actions a ON a.owner_id = p.owner_id AND a.id = p.action_id AND a.deleted_at IS NULL
    LEFT JOIN projects pr ON pr.owner_id = p.owner_id AND pr.id = p.project_id
      AND pr.deleted_at IS NULL
    LEFT JOIN milestones m ON m.owner_id = p.owner_id AND m.id = p.milestone_id
      AND m.deleted_at IS NULL
    LEFT JOIN outcomes mo ON mo.owner_id = m.owner_id AND mo.id = m.outcome_id
    LEFT JOIN outcomes o ON o.owner_id = p.owner_id AND o.id = p.outcome_id
      AND o.deleted_at IS NULL
    WHERE p.owner_id = ? AND p.horizon IN ${activeHorizons} AND p.archived_at IS NULL
      AND p.deleted_at IS NULL AND p.period_start_date <= ? AND p.period_end_date >= ?
      AND ((p.action_id IS NOT NULL AND a.state <> 'archived')
        OR (p.project_id IS NOT NULL AND pr.state <> 'archived')
        OR (p.milestone_id IS NOT NULL AND m.state <> 'archived')
        OR (p.outcome_id IS NOT NULL AND o.state <> 'archived'))
    ORDER BY p.period_start_date ASC, p.period_end_date ASC, p.sort_key ASC, p.id ASC
    LIMIT ${String(maximumPeriodRows)};`,
  listBacklog: `
    SELECT ${actionColumns}
    FROM actions a INDEXED BY idx_actions_planning_state
    WHERE a.owner_id = ? AND a.state IN ('planned', 'in_progress') AND a.archived_at IS NULL
      AND a.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM planning_placements np
        WHERE np.owner_id = a.owner_id AND np.action_id = a.id AND np.archived_at IS NULL
          AND np.deleted_at IS NULL)
      AND ${noPlannedActionBlock}
    ORDER BY a.sort_key ASC, a.id ASC
    LIMIT ?;`,
  countBacklog: `
    SELECT COUNT(*) AS count
    FROM actions a INDEXED BY idx_actions_planning_state
    WHERE a.owner_id = ? AND a.state IN ('planned', 'in_progress') AND a.archived_at IS NULL
      AND a.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM planning_placements np
        WHERE np.owner_id = a.owner_id AND np.action_id = a.id AND np.archived_at IS NULL
          AND np.deleted_at IS NULL)
      AND ${noPlannedActionBlock};`,
  listCarryForward: `
    SELECT ${actionColumns}, ${placementColumns('p')}
    FROM planning_placements p INDEXED BY idx_placements_period
    JOIN actions a ON a.owner_id = p.owner_id AND a.id = p.action_id
    WHERE p.owner_id = ? AND p.horizon IN ('day', 'week') AND p.archived_at IS NULL
      AND p.deleted_at IS NULL AND p.action_id IS NOT NULL
      AND p.period_start_date < ? AND p.period_end_date < ?
      AND a.state IN ('planned', 'in_progress') AND a.archived_at IS NULL
      AND a.deleted_at IS NULL AND ${noPlannedActionBlock}
    ORDER BY p.period_start_date ASC, p.sort_key ASC, a.id ASC
    LIMIT ?;`,
  countCarryForward: `
    SELECT COUNT(*) AS count
    FROM planning_placements p INDEXED BY idx_placements_period
    JOIN actions a ON a.owner_id = p.owner_id AND a.id = p.action_id
    WHERE p.owner_id = ? AND p.horizon IN ('day', 'week') AND p.archived_at IS NULL
      AND p.deleted_at IS NULL AND p.action_id IS NOT NULL
      AND p.period_start_date < ? AND p.period_end_date < ?
      AND a.state IN ('planned', 'in_progress') AND a.archived_at IS NULL
      AND a.deleted_at IS NULL AND ${noPlannedActionBlock};`,
  listWeekSelections: `
    SELECT w.id, w.local_revision, w.period_start_date, w.period_end_date, w.week_start,
           w.sort_key, w.action_id, w.project_id, w.milestone_id,
           a.title AS action_title, a.state AS action_state,
           pr.title AS project_title, pr.state AS project_state,
           m.title AS milestone_title, m.state AS milestone_state
    FROM week_selections w INDEXED BY idx_week_selections_overlap_end
    LEFT JOIN actions a ON a.owner_id = w.owner_id AND a.id = w.action_id AND a.deleted_at IS NULL
    LEFT JOIN projects pr ON pr.owner_id = w.owner_id AND pr.id = w.project_id
      AND pr.deleted_at IS NULL
    LEFT JOIN milestones m ON m.owner_id = w.owner_id AND m.id = w.milestone_id
      AND m.deleted_at IS NULL
    WHERE w.owner_id = ? AND w.archived_at IS NULL AND w.deleted_at IS NULL
      AND w.period_start_date <= ? AND w.period_end_date >= ?
      AND ((w.action_id IS NOT NULL AND a.state <> 'archived')
        OR (w.project_id IS NOT NULL AND pr.state <> 'archived')
        OR (w.milestone_id IS NOT NULL AND m.state <> 'archived'))
    ORDER BY w.period_start_date ASC, w.sort_key ASC, w.id ASC
    LIMIT ${String(maximumPeriodRows)};`,
  listRoutines: `${routineSelect}
    WHERE r.owner_id = ? AND r.deleted_at IS NULL AND r.state <> 'archived'
    ORDER BY r.sort_key ASC, r.id ASC LIMIT ${String(maximumList)};`,
  listAllRoutines: `${routineSelect}
    WHERE r.owner_id = ? AND r.deleted_at IS NULL
    ORDER BY r.sort_key ASC, r.id ASC LIMIT ${String(maximumList)};`,
  getRoutine: `${routineSelect}
    WHERE r.owner_id = ? AND r.id = ? AND r.deleted_at IS NULL;`,
  routineGenerations: `
    SELECT * FROM routine_generations
    WHERE owner_id = ? AND deleted_at IS NULL AND routine_id IN (SELECT value FROM json_each(?))
    ORDER BY routine_id ASC, generation ASC LIMIT 1000;`,
  routineDefaults: `
    SELECT d.*, p.title AS project_title
    FROM routine_action_defaults d
    LEFT JOIN projects p ON p.owner_id = d.owner_id AND p.id = d.project_id
      AND p.deleted_at IS NULL
    WHERE d.owner_id = ? AND d.deleted_at IS NULL
      AND d.routine_id IN (SELECT value FROM json_each(?))
    ORDER BY d.routine_id ASC, d.generation ASC LIMIT 1000;`,
  listOccurrences: occurrenceWindow(''),
  listRoutineOccurrences: occurrenceWindow(' AND o.routine_id = ?'),
  occurrenceHistory: `
    SELECT * FROM routine_occurrences INDEXED BY idx_routine_occurrences_history
    WHERE owner_id = ? AND routine_id = ? AND deleted_at IS NULL
    ORDER BY updated_at DESC, id DESC
    LIMIT ?;`,
  capacityConstraints: `
    SELECT c.*, ctx.value_text AS context_label
    FROM constraints c INDEXED BY idx_constraints_kind
    LEFT JOIN contexts ctx ON ctx.owner_id = c.owner_id AND ctx.id = c.context_id
      AND ctx.deleted_at IS NULL
    WHERE c.owner_id = ? AND c.constraint_kind IN ('availability', 'capacity')
      AND c.state = 'active' AND c.deleted_at IS NULL
    ORDER BY c.constraint_kind ASC, c.created_at ASC, c.id ASC
    LIMIT ${String(maximumList)};`,
  monthThemes: `
    SELECT id, local_revision, period_key, theme_text FROM month_themes
    WHERE owner_id = ? AND archived_at IS NULL AND deleted_at IS NULL
      AND period_key >= ? AND period_key <= ?
    ORDER BY period_key ASC, id ASC LIMIT ${String(maximumList)};`,
  yearDirection: `
    SELECT id, local_revision, period_key, direction_text FROM year_directions
    WHERE owner_id = ? AND archived_at IS NULL AND deleted_at IS NULL AND period_key = ?
    ORDER BY updated_at DESC, id ASC LIMIT 1;`,
  listOutcomes: `${outcomeSelect}
    WHERE o.owner_id = ? AND o.deleted_at IS NULL AND o.state IN ('active', 'paused')
      AND o.id IN (${placedOrTargeted('outcomes', 'outcome_id', 'idx_outcomes_target_end')})
    ORDER BY o.sort_key ASC, o.id ASC LIMIT ${String(maximumList)};`,
  getOutcome: `${outcomeSelect}
    WHERE o.owner_id = ? AND o.id = ? AND o.deleted_at IS NULL;`,
  listMilestones: `${milestoneSelect}
    WHERE m.owner_id = ? AND m.deleted_at IS NULL AND m.state <> 'archived'
      AND m.id IN (${placedOrTargeted('milestones', 'milestone_id', 'idx_milestones_target_end')})
    ORDER BY m.sort_key ASC, m.id ASC LIMIT ${String(maximumList)};`,
  getMilestone: `${milestoneSelect}
    WHERE m.owner_id = ? AND m.id = ? AND m.deleted_at IS NULL;`,
  listProjectTargets: `${projectSelect}
    WHERE p.owner_id = ? AND p.deleted_at IS NULL AND p.state <> 'archived'
      AND p.id IN (${placedOrTargeted('projects', 'project_id', 'idx_projects_target_end')})
    ORDER BY p.sort_key ASC, p.id ASC LIMIT ${String(maximumList)};`,
  milestoneProjects: `
    SELECT p.id, p.sort_key, p.title, p.state FROM milestone_projects mp
    JOIN projects p ON p.owner_id = mp.owner_id AND p.id = mp.project_id
    WHERE mp.owner_id = ? AND mp.milestone_id = ? AND mp.deleted_at IS NULL
      AND p.deleted_at IS NULL AND p.state <> 'archived'
    ORDER BY p.sort_key ASC, p.id ASC LIMIT ${String(maximumList)};`,
  milestoneActions: `
    SELECT a.id, a.sort_key, a.title, a.state FROM milestone_actions ma
    JOIN actions a ON a.owner_id = ma.owner_id AND a.id = ma.action_id
    WHERE ma.owner_id = ? AND ma.milestone_id = ? AND ma.deleted_at IS NULL
      AND a.deleted_at IS NULL AND a.state <> 'archived'
    ORDER BY a.sort_key ASC, a.id ASC LIMIT ${String(maximumList)};`,
  axis: `SELECT id, title FROM axes WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
  listActiveTemplates: `
    SELECT * FROM templates INDEXED BY idx_templates_title
    WHERE owner_id = ? AND state = 'active' AND deleted_at IS NULL
    ORDER BY title ASC, id ASC LIMIT ${String(maximumList)};`,
  listAllTemplates: `
    SELECT * FROM templates INDEXED BY idx_templates_title
    WHERE owner_id = ? AND deleted_at IS NULL
    ORDER BY title ASC, id ASC LIMIT ${String(maximumList)};`,
  getTemplate: `SELECT * FROM templates WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
  listAxes: `
    SELECT id, sort_key, title, local_revision FROM axes
    WHERE owner_id = ? AND state = 'active' AND archived_at IS NULL AND deleted_at IS NULL
    ORDER BY sort_key ASC, id ASC LIMIT ${String(maximumList)};`,
  listProjects: `
    SELECT id, sort_key, title, local_revision FROM projects
    WHERE owner_id = ? AND state IN ('idea', 'active', 'blocked', 'paused')
      AND archived_at IS NULL AND deleted_at IS NULL
    ORDER BY sort_key ASC, id ASC LIMIT ${String(maximumList)};`,
  getAction: `
    SELECT ${actionColumns}, ${placementColumns('pl')}
    FROM actions a
    LEFT JOIN planning_placements pl ON pl.owner_id = a.owner_id AND pl.action_id = a.id
      AND pl.archived_at IS NULL AND pl.deleted_at IS NULL
    WHERE a.owner_id = ? AND a.id = ? AND a.deleted_at IS NULL;`,
  activeActionPlacement: activePlacementSql('action_id'),
  activeProjectPlacement: activePlacementSql('project_id'),
  activeMilestonePlacement: activePlacementSql('milestone_id'),
  activeOutcomePlacement: activePlacementSql('outcome_id'),
  plannedActionBlock: `
    SELECT id FROM time_blocks
    WHERE owner_id = ? AND action_id = ? AND state = 'planned' AND deleted_at IS NULL
    ORDER BY id ASC LIMIT 1;`,
  plannedCommitmentBlock: `
    SELECT id FROM time_blocks
    WHERE owner_id = ? AND commitment_id = ? AND state = 'planned' AND deleted_at IS NULL
    ORDER BY id ASC LIMIT 1;`,
  /** One Time Block's reminder. Parameters: owner, block. */
  timeBlockReminder: targetReminderSql('time_block_id', 'idx_reminders_time_block'),
  /** One Routine's reminder. Parameters: owner, Routine. */
  routineReminder: targetReminderSql('routine_id', 'idx_reminders_routine'),
});

export function listLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('A list limit must be a non-negative integer.');
  }
  return Math.min(limit, maximumList);
}

/* ───────────────────────── Row mappers ───────────────────────── */

export function actionSummary(row: Values, withPlacement: boolean): ActionSummary {
  const dueDate = optionalText(row, 'action_due_date');
  const dueAt = optionalText(row, 'action_due_at');
  const dueZone = optionalText(row, 'action_due_zone');
  const due: DueValue | undefined =
    dueDate !== undefined
      ? { kind: 'date', date: dueDate as CalendarDate }
      : dueAt !== undefined && dueZone !== undefined
        ? { kind: 'instant', instant: dueAt as Instant, authoredTimeZone: dueZone as IanaTimeZone }
        : undefined;
  const placementId = withPlacement ? optionalText(row, 'placement_id') : undefined;
  return {
    id: text(row, 'action_id_value') as UUID,
    title: text(row, 'action_title'),
    state: oneOf(row, 'action_state', actionStates),
    localRevision: integer(row, 'action_revision'),
    orderKey: text(row, 'action_sort_key'),
    ...spread('estimateMinutes', optionalInteger(row, 'action_estimate')),
    ...spread('energy', optionalText(row, 'action_energy') as EnergyLabel | undefined),
    ...spread('priority', optionalText(row, 'action_priority') as Priority | undefined),
    ...spread('due', due),
    ...spread('axisTitle', optionalText(row, 'action_axis_title')),
    ...spread('projectTitle', optionalText(row, 'action_project_title')),
    ...(placementId === undefined
      ? {}
      : {
          placement: {
            id: placementId as UUID,
            localRevision: integer(row, 'placement_revision'),
            period: periodFrom(row, 'placement'),
          },
        }),
  };
}

/** One row of `blockSelectColumns`. */
export function blockRow(row: Values): BlockRow {
  return {
    id: text(row, 'id') as UUID,
    localRevision: integer(row, 'local_revision'),
    startsAt: text(row, 'starts_at_utc') as Instant,
    endsAt: text(row, 'ends_at_utc') as Instant,
    timeZone: text(row, 'time_zone') as IanaTimeZone,
    state: oneOf(row, 'state', ['planned', 'completed', 'skipped'] as const),
    overlapAcknowledged: integer(row, 'overlap_confirmed') === 1,
    target: blockTarget(row),
  };
}

export function blockTarget(row: Values): BlockTargetView {
  const actionId = optionalText(row, 'action_id');
  if (actionId !== undefined) {
    return {
      kind: 'action',
      actionId: actionId as UUID,
      title: text(row, 'action_title'),
      actionState: oneOf(row, 'action_state', actionStates),
      actionRevision: integer(row, 'action_revision'),
    };
  }
  const commitmentId = optionalText(row, 'commitment_id');
  if (commitmentId !== undefined) {
    return {
      kind: 'commitment',
      commitmentId: commitmentId as UUID,
      title: text(row, 'commitment_title'),
      strength: oneOf<CommitmentStrength>(row, 'commitment_strength', ['hard', 'soft']),
      commitmentState: oneOf(row, 'commitment_state', commitmentStates),
      commitmentRevision: integer(row, 'commitment_revision'),
    };
  }
  const occurrenceId = optionalText(row, 'routine_occurrence_id');
  if (occurrenceId !== undefined) {
    return {
      kind: 'routine_occurrence',
      routineOccurrenceId: occurrenceId as UUID,
      title: text(row, 'routine_title'),
    };
  }
  return { kind: 'custom', title: text(row, 'custom_title') };
}

export function placedTarget(row: Values): PlacedTargetView {
  if (optionalText(row, 'action_id') !== undefined) {
    return { kind: 'action', action: actionSummary(row, true) };
  }
  const projectId = optionalText(row, 'project_id');
  if (projectId !== undefined) {
    return {
      kind: 'project',
      id: projectId as UUID,
      title: text(row, 'project_title'),
      state: oneOf(row, 'project_state', projectStates),
      localRevision: integer(row, 'project_revision'),
    };
  }
  const milestoneId = optionalText(row, 'milestone_id');
  if (milestoneId !== undefined) {
    return {
      kind: 'milestone',
      id: milestoneId as UUID,
      title: text(row, 'milestone_title'),
      state: oneOf(row, 'milestone_state', milestoneStates),
      localRevision: integer(row, 'milestone_revision'),
      outcomeId: text(row, 'milestone_outcome_id') as UUID,
      outcomeTitle: text(row, 'milestone_outcome_title'),
    };
  }
  return {
    kind: 'outcome',
    id: text(row, 'outcome_id') as UUID,
    title: text(row, 'outcome_title'),
    state: oneOf(row, 'outcome_state', outcomeStates),
    localRevision: integer(row, 'outcome_revision'),
  };
}

function outcomeRow(row: Values): OutcomeRow {
  const mode = oneOf(row, 'progress_mode', ['none', 'manual', 'milestone_derived'] as const);
  const placement = placementRef(row);
  return {
    id: text(row, 'id') as UUID,
    title: text(row, 'title'),
    successDefinition: text(row, 'success_definition'),
    state: oneOf(row, 'state', outcomeStates),
    localRevision: integer(row, 'local_revision'),
    ...spread('axisTitle', optionalText(row, 'axis_title')),
    ...spread('targetStart', optionalText(row, 'target_start_date') as CalendarDate | undefined),
    ...spread('targetEnd', optionalText(row, 'target_end_date') as CalendarDate | undefined),
    progress:
      mode === 'manual'
        ? { mode, percentage: integer(row, 'progress_percent') }
        : mode === 'milestone_derived'
          ? {
              mode,
              completed: integer(row, 'milestone_completed'),
              total: integer(row, 'milestone_total'),
              canceled: integer(row, 'milestone_canceled'),
            }
          : { mode },
    ...spread('placement', placement),
  };
}

function milestoneRow(row: Values): MilestoneRow {
  return {
    id: text(row, 'id') as UUID,
    title: text(row, 'title'),
    measurableCheckpoint: text(row, 'measurable_checkpoint'),
    state: oneOf(row, 'state', milestoneStates),
    localRevision: integer(row, 'local_revision'),
    outcomeId: text(row, 'outcome_id') as UUID,
    outcomeTitle: text(row, 'outcome_title'),
    ...spread('targetStart', optionalText(row, 'target_start_date') as CalendarDate | undefined),
    ...spread('targetEnd', optionalText(row, 'target_end_date') as CalendarDate | undefined),
    ...spread('placement', placementRef(row)),
  };
}

function projectTargetRow(row: Values): ProjectTargetRow {
  return {
    id: text(row, 'id') as UUID,
    title: text(row, 'title'),
    state: oneOf(row, 'state', projectStates),
    localRevision: integer(row, 'local_revision'),
    ...spread('axisTitle', optionalText(row, 'axis_title')),
    ...spread('targetStart', optionalText(row, 'target_start_date') as CalendarDate | undefined),
    ...spread('targetEnd', optionalText(row, 'target_end_date') as CalendarDate | undefined),
    ...spread('placement', placementRef(row)),
  };
}

export function materializedOccurrence(row: Values): MaterializedOccurrenceSnapshot {
  const parsed = routineOccurrenceDocumentSchema.safeParse(decodeOccurrenceRow(row));
  if (!parsed.success) invalidRow();
  const document = parsed.data;
  const period = document.period as GeneratedOccurrencePeriod;
  const routineId = document.routineId as UUID;
  return {
    id: text(row, 'id') as UUID,
    routineId,
    generation: document.generation,
    logicalKey: occurrenceLogicalKey(routineId, document.generation, period),
    period,
    state: document.state,
    localRevision: integer(row, 'local_revision'),
    ...spread('targetCount', document.targetCount),
    ...spread('completedCount', document.completedCount),
    ...spread('extraCompletionsConfirmed', document.extraCompletionsConfirmed),
    ...spread('override', document.override),
    ...spread('completedAt', document.completedAt as Instant | undefined),
  };
}

/** Exact overlap of one materialized occurrence with the queried local date range. */
function occurrenceInRange(snapshot: MaterializedOccurrenceSnapshot, range: DateRangeInput) {
  const overrideDate = snapshot.override?.date;
  if (overrideDate !== undefined && overrideDate >= range.start && overrideDate <= range.end) {
    return true;
  }
  return snapshot.period.kind === 'date'
    ? snapshot.period.date >= range.start && snapshot.period.date <= range.end
    : snapshot.period.start <= range.end && snapshot.period.end >= range.start;
}

/* ───────────────────────── Adapter ───────────────────────── */

/**
 * SQLite planning read model. Every statement is owner-scoped, prepared, ordered with an id
 * tie-break, and bounded. Nothing here writes or caches planning content outside SQLite.
 */
export class SqlitePlanningQueries implements PlanningQueryPort {
  readonly #codecs = createDefaultCanonicalCodecRegistry();

  constructor(private readonly driver: SqliteDriver) {}

  async getPlanProfile(ownerId: OwnerId): Promise<PlanProfile> {
    const row = await this.driver.get<Values>(planningQuerySql.profile, [ownerId]);
    if (row === undefined) throw new DataAdapterError('invalid_identity_record');
    const zone = optionalText(row, 'planning_time_zone');
    const weekStart = optionalText(row, 'week_start');
    const timeFormat = optionalText(row, 'time_format');
    if (
      zone === undefined ||
      !parseIanaTimeZone(zone).ok ||
      weekStart === undefined ||
      !weekdayValues.includes(weekStart as Weekday) ||
      (timeFormat !== '12_hour' && timeFormat !== '24_hour')
    ) {
      throw new DataAdapterError('invalid_identity_record');
    }
    const createdAt = parseInstant(optionalText(row, 'created_at') ?? '');
    return {
      profileId: text(row, 'id') as UUID,
      planningTimeZone: zone as IanaTimeZone,
      weekStart: weekStart as Weekday,
      timeFormat,
      localRevision: integer(row, 'local_revision'),
      ...(createdAt.ok ? { createdAt: createdAt.value } : {}),
    };
  }

  async listBlocks(ownerId: OwnerId, startsAt: Instant, endsAt: Instant): Promise<BlockRow[]> {
    const rows = await completePages<Values>(
      this.driver,
      planningQuerySql.listBlocks,
      [ownerId, endsAt, startsAt],
      [
        { column: 'b.starts_at_utc', result: 'starts_at_utc' },
        { column: 'b.ends_at_utc', result: 'ends_at_utc' },
        { column: 'b.id', result: 'id' },
      ],
    );
    return rows.map(blockRow);
  }

  async listPlacements(ownerId: OwnerId, range: DateRangeInput): Promise<PlacementRow[]> {
    const rows = await completePages<Values>(
      this.driver,
      planningQuerySql.listPlacements,
      [ownerId, range.end, range.start],
      [
        { column: 'p.period_start_date', result: 'placement_start' },
        { column: 'p.period_end_date', result: 'placement_end' },
        { column: 'p.sort_key', result: 'sort_key' },
        { column: 'p.id', result: 'id' },
      ],
    );
    return rows.map((row) => ({
      id: text(row, 'id') as UUID,
      localRevision: integer(row, 'local_revision'),
      period: periodFrom(row, 'placement'),
      orderKey: text(row, 'sort_key'),
      target: placedTarget({
        ...row,
        placement_id: row['id'],
        placement_revision: row['local_revision'],
      }),
    }));
  }

  async listBacklog(ownerId: OwnerId, limit: number) {
    const rows = await this.driver.all<Values>(planningQuerySql.listBacklog, [
      ownerId,
      listLimit(limit),
    ]);
    const count = await this.driver.get<Values>(planningQuerySql.countBacklog, [ownerId]);
    return {
      items: rows.map((row) => actionSummary(row, false)),
      total: count === undefined ? 0 : integer(count, 'count'),
    };
  }

  async listCarryForward(ownerId: OwnerId, before: CalendarDate, limit: number) {
    const rows = await this.driver.all<Values>(planningQuerySql.listCarryForward, [
      ownerId,
      before,
      before,
      listLimit(limit),
    ]);
    const count = await this.driver.get<Values>(planningQuerySql.countCarryForward, [
      ownerId,
      before,
      before,
    ]);
    return {
      items: rows.map((row) => actionSummary(row, true)),
      total: count === undefined ? 0 : integer(count, 'count'),
    };
  }

  async listWeekSelections(ownerId: OwnerId, range: DateRangeInput): Promise<WeekSelectionRow[]> {
    const rows = await completePages<Values>(
      this.driver,
      planningQuerySql.listWeekSelections,
      [ownerId, range.end, range.start],
      [
        { column: 'w.period_start_date', result: 'period_start_date' },
        { column: 'w.sort_key', result: 'sort_key' },
        { column: 'w.id', result: 'id' },
      ],
    );
    return rows.map((row) => {
      const period: WeekPeriod = {
        kind: 'week',
        start: text(row, 'period_start_date') as CalendarDate,
        end: text(row, 'period_end_date') as CalendarDate,
        weekStart: oneOf(row, 'week_start', weekdayValues),
      };
      const actionId = optionalText(row, 'action_id');
      const projectId = optionalText(row, 'project_id');
      const target: WeekSelectionRow['target'] =
        actionId !== undefined
          ? {
              kind: 'action',
              id: actionId as UUID,
              title: text(row, 'action_title'),
              state: oneOf(row, 'action_state', actionStates),
            }
          : projectId !== undefined
            ? {
                kind: 'project',
                id: projectId as UUID,
                title: text(row, 'project_title'),
                state: oneOf(row, 'project_state', projectStates),
              }
            : {
                kind: 'milestone',
                id: text(row, 'milestone_id') as UUID,
                title: text(row, 'milestone_title'),
                state: oneOf(row, 'milestone_state', milestoneStates),
              };
      return {
        id: text(row, 'id') as UUID,
        localRevision: integer(row, 'local_revision'),
        period,
        orderKey: text(row, 'sort_key'),
        target,
      };
    });
  }

  async listRoutines(
    ownerId: OwnerId,
    options: { readonly includeArchived: boolean },
  ): Promise<RoutineRow[]> {
    const rows = await completePages<Values>(
      this.driver,
      options.includeArchived ? planningQuerySql.listAllRoutines : planningQuerySql.listRoutines,
      [ownerId],
      [
        { column: 'r.sort_key', result: 'sort_key' },
        { column: 'r.id', result: 'id' },
      ],
    );
    return this.#routineRows(ownerId, rows);
  }

  async getRoutine(ownerId: OwnerId, routineId: UUID): Promise<RoutineRow | null> {
    const row = await this.driver.get<Values>(planningQuerySql.getRoutine, [ownerId, routineId]);
    if (row === undefined) return null;
    const [routine] = await this.#routineRows(ownerId, [row]);
    return routine ?? null;
  }

  async listMaterializedOccurrences(
    ownerId: OwnerId,
    range: DateRangeInput,
    routineId?: UUID,
  ): Promise<MaterializedOccurrenceSnapshot[]> {
    // The stored interval end, not a presumed duration, determines overlap. `/~` includes
    // every weekly key starting on the final queried date.
    const byKey: SqliteParameter[] = [ownerId, range.start, `${range.end}/~`];
    const byOverride: SqliteParameter[] = [ownerId, range.start, range.end];
    const rows =
      routineId === undefined
        ? await completePages<Values>(
            this.driver,
            planningQuerySql.listOccurrences,
            [...byKey, ...byOverride],
            [
              { column: 'logical_period_key', result: 'logical_period_key' },
              { column: 'id', result: 'id' },
            ],
            true,
          )
        : await completePages<Values>(
            this.driver,
            planningQuerySql.listRoutineOccurrences,
            [...byKey, routineId, ...byOverride, routineId],
            [
              { column: 'logical_period_key', result: 'logical_period_key' },
              { column: 'id', result: 'id' },
            ],
            true,
          );
    return rows
      .map(materializedOccurrence)
      .filter((snapshot) => occurrenceInRange(snapshot, range));
  }

  async listOccurrenceHistory(
    ownerId: OwnerId,
    routineId: UUID,
    limit: number,
  ): Promise<MaterializedOccurrenceSnapshot[]> {
    const rows = await this.driver.all<Values>(planningQuerySql.occurrenceHistory, [
      ownerId,
      routineId,
      listLimit(limit),
    ]);
    return rows.map(materializedOccurrence);
  }

  async listCapacityConstraints(ownerId: OwnerId): Promise<ConstraintRow[]> {
    const rows = await completePages<Values>(
      this.driver,
      planningQuerySql.capacityConstraints,
      [ownerId],
      [
        { column: 'c.constraint_kind', result: 'constraint_kind' },
        { column: 'c.created_at', result: 'created_at' },
        { column: 'c.id', result: 'id' },
      ],
    );
    return rows.map((row) => {
      const parsed = constraintDocumentSchema.safeParse(decodeConstraintRow(row));
      if (!parsed.success) invalidRow();
      return {
        id: text(row, 'id') as UUID,
        localRevision: integer(row, 'local_revision'),
        document: parsed.data as ConstraintDocument,
        ...spread('contextLabel', optionalText(row, 'context_label')),
      };
    });
  }

  async listMonthThemes(ownerId: OwnerId, year: YearKey): Promise<ThemeRow[]> {
    const rows = await this.driver.all<Values>(planningQuerySql.monthThemes, [
      ownerId,
      `${year}-01`,
      `${year}-12`,
    ]);
    return rows.map((row) => ({
      id: text(row, 'id') as UUID,
      localRevision: integer(row, 'local_revision'),
      month: text(row, 'period_key') as MonthKey,
      text: text(row, 'theme_text'),
    }));
  }

  async getYearDirection(ownerId: OwnerId, year: YearKey): Promise<DirectionRow | null> {
    const row = await this.driver.get<Values>(planningQuerySql.yearDirection, [ownerId, year]);
    if (row === undefined) return null;
    return {
      id: text(row, 'id') as UUID,
      localRevision: integer(row, 'local_revision'),
      year: text(row, 'period_key') as YearKey,
      text: text(row, 'direction_text'),
    };
  }

  async listOutcomes(ownerId: OwnerId, range: DateRangeInput): Promise<OutcomeRow[]> {
    const rows = await completePages<Values>(
      this.driver,
      planningQuerySql.listOutcomes,
      [ownerId, ...placedOrTargetedParameters(ownerId, range)],
      [
        { column: 'o.sort_key', result: 'sort_key' },
        { column: 'o.id', result: 'id' },
      ],
    );
    return rows.map(outcomeRow);
  }

  async listMilestones(ownerId: OwnerId, range: DateRangeInput): Promise<MilestoneRow[]> {
    const rows = await completePages<Values>(
      this.driver,
      planningQuerySql.listMilestones,
      [ownerId, ...placedOrTargetedParameters(ownerId, range)],
      [
        { column: 'm.sort_key', result: 'sort_key' },
        { column: 'm.id', result: 'id' },
      ],
    );
    return rows.map(milestoneRow);
  }

  async listProjectTargets(ownerId: OwnerId, range: DateRangeInput): Promise<ProjectTargetRow[]> {
    const rows = await completePages<Values>(
      this.driver,
      planningQuerySql.listProjectTargets,
      [ownerId, ...placedOrTargetedParameters(ownerId, range)],
      [
        { column: 'p.sort_key', result: 'sort_key' },
        { column: 'p.id', result: 'id' },
      ],
    );
    return rows.map(projectTargetRow);
  }

  async getMilestoneChain(ownerId: OwnerId, milestoneId: UUID): Promise<MilestoneChain | null> {
    const milestone = await this.driver.get<Values>(planningQuerySql.getMilestone, [
      ownerId,
      milestoneId,
    ]);
    if (milestone === undefined) return null;
    const outcome = await this.driver.get<Values>(planningQuerySql.getOutcome, [
      ownerId,
      text(milestone, 'outcome_id'),
    ]);
    if (outcome === undefined) invalidRow();
    const axisId = optionalText(outcome, 'axis_id');
    const axis =
      axisId === undefined
        ? undefined
        : await this.driver.get<Values>(planningQuerySql.axis, [ownerId, axisId]);
    const projects = await completePages<Values>(
      this.driver,
      planningQuerySql.milestoneProjects,
      [ownerId, milestoneId],
      [
        { column: 'p.sort_key', result: 'sort_key' },
        { column: 'p.id', result: 'id' },
      ],
    );
    const actions = await completePages<Values>(
      this.driver,
      planningQuerySql.milestoneActions,
      [ownerId, milestoneId],
      [
        { column: 'a.sort_key', result: 'sort_key' },
        { column: 'a.id', result: 'id' },
      ],
    );
    return {
      milestone: milestoneRow(milestone),
      outcome: outcomeRow(outcome),
      ...(axis === undefined
        ? {}
        : { axis: { id: text(axis, 'id') as UUID, title: text(axis, 'title') } }),
      projects: projects.map((row) => ({
        id: text(row, 'id') as UUID,
        title: text(row, 'title'),
        state: oneOf(row, 'state', projectStates),
      })),
      actions: actions.map((row) => ({
        id: text(row, 'id') as UUID,
        title: text(row, 'title'),
        state: oneOf(row, 'state', actionStates),
      })),
    };
  }

  async listTemplates(
    ownerId: OwnerId,
    options: { readonly includeArchived: boolean },
  ): Promise<TemplateRow[]> {
    const rows = await completePages<Values>(
      this.driver,
      options.includeArchived
        ? planningQuerySql.listAllTemplates
        : planningQuerySql.listActiveTemplates,
      [ownerId],
      [
        { column: 'title', result: 'title' },
        { column: 'id', result: 'id' },
      ],
    );
    return rows.map((row) => this.#templateRow(row));
  }

  async getTemplate(ownerId: OwnerId, templateId: UUID): Promise<TemplateRow | null> {
    const row = await this.driver.get<Values>(planningQuerySql.getTemplate, [ownerId, templateId]);
    return row === undefined ? null : this.#templateRow(row);
  }

  listAxes(ownerId: OwnerId): Promise<ChoiceRow[]> {
    return this.#choices(planningQuerySql.listAxes, ownerId);
  }

  listProjects(ownerId: OwnerId): Promise<ChoiceRow[]> {
    return this.#choices(planningQuerySql.listProjects, ownerId);
  }

  async getAction(ownerId: OwnerId, actionId: UUID): Promise<ActionSummary | null> {
    const row = await this.driver.get<Values>(planningQuerySql.getAction, [ownerId, actionId]);
    return row === undefined ? null : actionSummary(row, true);
  }

  async readRecord(
    ownerId: OwnerId,
    ref: CanonicalRecordState['ref'],
  ): Promise<CanonicalRecordState | null> {
    if (ref.ownerId !== ownerId) return null;
    return this.#codecs.resolve(ref.type).read(this.driver, ref);
  }

  async getActivePlacement(
    ownerId: OwnerId,
    kind: PlacementTargetDocument['kind'],
    targetId: UUID,
  ): Promise<CanonicalRecordState | null> {
    const statement = activePlacementStatements[kind];
    const row = await this.driver.get<Values>(planningQuerySql[statement], [ownerId, targetId]);
    if (row === undefined) return null;
    return this.#codecs
      .resolve('planning_placement')
      .read(this.driver, { type: 'planning_placement', id: text(row, 'id') as UUID, ownerId });
  }

  async getPlannedActionBlock(
    ownerId: OwnerId,
    actionId: UUID,
  ): Promise<CanonicalRecordState | null> {
    const row = await this.driver.get<Values>(planningQuerySql.plannedActionBlock, [
      ownerId,
      actionId,
    ]);
    return row === undefined ? null : this.#readBlock(ownerId, text(row, 'id'));
  }

  async getPlannedCommitmentBlock(
    ownerId: OwnerId,
    commitmentId: UUID,
  ): Promise<CanonicalRecordState | null> {
    const row = await this.driver.get<Values>(planningQuerySql.plannedCommitmentBlock, [
      ownerId,
      commitmentId,
    ]);
    return row === undefined ? null : this.#readBlock(ownerId, text(row, 'id'));
  }

  async getTargetReminder(
    ownerId: OwnerId,
    target: PlanningReminderTarget,
  ): Promise<CanonicalRecordState | null> {
    const row = await this.driver.get<Values>(
      target.kind === 'time_block'
        ? planningQuerySql.timeBlockReminder
        : planningQuerySql.routineReminder,
      [ownerId, target.id],
    );
    return row === undefined
      ? null
      : reminderCanonicalCodec.recordFromRow(
          { type: 'reminder', id: text(row, 'id') as UUID, ownerId },
          row,
        );
  }

  #readBlock(ownerId: OwnerId, id: string): Promise<CanonicalRecordState | null> {
    return this.#codecs
      .resolve('time_block')
      .read(this.driver, { type: 'time_block', id: id as UUID, ownerId });
  }

  async #routineRows(ownerId: OwnerId, rows: readonly Values[]): Promise<RoutineRow[]> {
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map((row) => text(row, 'id')));
    const generationRows = await completePages<Values>(
      this.driver,
      planningQuerySql.routineGenerations,
      [ownerId, ids],
      [
        { column: 'routine_id', result: 'routine_id' },
        { column: 'generation', result: 'generation' },
      ],
    );
    const defaultRows = await completePages<Values>(
      this.driver,
      planningQuerySql.routineDefaults,
      [ownerId, ids],
      [
        { column: 'd.routine_id', result: 'routine_id' },
        { column: 'd.generation', result: 'generation' },
      ],
    );
    return rows.map((row) => {
      const id = text(row, 'id');
      const document = routineCanonicalCodec.decodeWithGenerations(
        row,
        generationRows.filter((generation) => generation['routine_id'] === id),
      ) as unknown as RoutineDocument;
      const current = document.generations.at(-1)?.generation;
      const defaults = defaultRows.find(
        (candidate) => candidate['routine_id'] === id && candidate['generation'] === current,
      );
      return {
        id: id as UUID,
        localRevision: integer(row, 'local_revision'),
        document,
        ...spread('axisTitle', optionalText(row, 'axis_title')),
        ...(defaults === undefined ? {} : { defaults: this.#defaults(defaults) }),
      };
    });
  }

  #defaults(row: Values): NonNullable<RoutineRow['defaults']> {
    const parsed = routineActionDefaultsDocumentSchema.safeParse(decodeDefaultsRow(row));
    if (!parsed.success) invalidRow();
    return {
      ...(parsed.data as RoutineActionDefaultsDocument),
      id: text(row, 'id') as UUID,
      localRevision: integer(row, 'local_revision'),
      ...spread('projectTitle', optionalText(row, 'project_title')),
    };
  }

  #templateRow(row: Values): TemplateRow {
    return {
      id: text(row, 'id') as UUID,
      localRevision: integer(row, 'local_revision'),
      document: templateCanonicalCodec.decode(
        row as Parameters<typeof templateCanonicalCodec.decode>[0],
      ) as TemplateDocument,
    };
  }

  async #choices(sql: string, ownerId: OwnerId): Promise<ChoiceRow[]> {
    const rows = await completePages<Values>(
      this.driver,
      sql,
      [ownerId],
      [
        { column: 'sort_key', result: 'sort_key' },
        { column: 'id', result: 'id' },
      ],
    );
    return rows.map((row) => ({
      id: text(row, 'id') as UUID,
      title: text(row, 'title'),
      localRevision: integer(row, 'local_revision'),
    }));
  }
}
