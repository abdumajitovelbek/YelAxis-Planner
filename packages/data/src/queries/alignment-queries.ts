import type {
  AlignmentContainerRow,
  AlignmentEdge,
  AlignmentNeighborhood,
  AlignmentNode,
  AlignmentQueryPort,
  AxisDetail,
  AxisReviewNote,
  AxisSummary,
  Bounded,
  CanonicalRecordState,
  DeleteImpactRecords,
  DeleteReferrerRelationship,
  HistoryEntry,
  LinkedItem,
  MilestoneDetail,
  MilestoneItem,
  NodeRef,
  OutcomeDetail,
  OutcomeItem,
  ProjectDetail,
  ProjectItem,
  ReorderScope,
  UnassignedView,
} from '@yelaxis/application';
import {
  alignmentLiveStates,
  alignmentRelationshipsAbove,
  alignmentRelationshipsBelow,
  currentOutcomeStates,
  currentProjectStates,
  currentRoutineStates,
  maxOrderedItems,
  nextActionStates,
  outcomeProgress,
  type ActionState,
  type AlignmentJoinRelationship,
  type AlignmentNodeKind,
  type AlignmentRelationship,
  type AlignmentRelationshipRule,
  type AxisState,
  type CalendarDate,
  type EntityRef,
  type EntityType,
  type HorizonPeriod,
  type Instant,
  type MilestoneState,
  type NoteState,
  type OutcomeState,
  type OwnerId,
  type ProjectState,
  type RoutineState,
  type UUID,
} from '@yelaxis/domain';

import { createDefaultCanonicalCodecRegistry } from '../application/canonical-codecs';
import { DataAdapterError } from '../application/errors';
import { decodePeriodColumns, horizonPeriodSchema } from '../application/planning-codecs';
import { alignmentLinkTables } from '../application/relationship-codecs';
import { reviewItemCanonicalCodec } from '../application/review-codecs';
import type { SqliteDriver, SqliteParameter } from '../sqlite/driver';
import { reviewPeriodFromRow } from './review-period-row';

/*
 * alignment read model over the canonical SQLite tables. Every statement is
 * prepared, owner-scoped, and indexed; lists are ordered by (order key, id) and bounded by a
 * requested limit with a hard cap of 200 plus a full COUNT. Nothing here writes, ranks, or caches
 * planning content outside SQLite, and history reads never touch event payloads.
 */

/** Hard cap for every bounded list. */
const maxLimit = 200;

const clampLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), maxLimit)) : maxLimit;

type Values = Readonly<Record<string, unknown>>;

/* ───────────────────────── Column readers ───────────────────────── */

function invalidRow(): never {
  throw new DataAdapterError('invalid_persisted_record');
}

function text(row: Values, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : invalidRow();
}

function optionalText(row: Values, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return typeof value === 'string' ? value : invalidRow();
}

function integer(row: Values, key: string): number {
  const value = row[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : invalidRow();
}

function oneOf<Value extends string>(row: Values, key: string, allowed: readonly Value[]): Value {
  const value = row[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as Value)
    : invalidRow();
}

function spread<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

/* ───────────────────────── Vocabulary ───────────────────────── */

const axisStates: readonly AxisState[] = ['active', 'archived'];
const outcomeStates: readonly OutcomeState[] = [
  'active',
  'paused',
  'achieved',
  'abandoned',
  'archived',
];
const projectStates: readonly ProjectState[] = [
  'idea',
  'active',
  'blocked',
  'paused',
  'completed',
  'archived',
];
const milestoneStates: readonly MilestoneState[] = ['active', 'completed', 'canceled', 'archived'];
const actionStates: readonly ActionState[] = [
  'inbox',
  'planned',
  'scheduled',
  'in_progress',
  'completed',
  'canceled',
  'archived',
];
const routineStates: readonly RoutineState[] = ['active', 'paused', 'archived'];
const noteStates: readonly NoteState[] = ['active', 'archived'];

const statesByKind: Readonly<Record<AlignmentNodeKind, readonly string[]>> = {
  axis: axisStates,
  outcome: outcomeStates,
  project: projectStates,
  milestone: milestoneStates,
  action: actionStates,
  routine: routineStates,
  note: noteStates,
};

/** A SQL `IN` list of fixed domain state literals (never user input). */
function stateList(values: readonly string[]): string {
  for (const value of values) {
    if (!/^[a-z_]+$/u.test(value)) throw new Error('Unexpected state literal.');
  }
  return values.map((value) => `'${value}'`).join(', ');
}

const currentOutcomeList = stateList(currentOutcomeStates);
const liveOutcomeList = stateList(alignmentLiveStates.outcome);
const currentProjectList = stateList(currentProjectStates);
const liveProjectList = stateList(alignmentLiveStates.project);
const currentRoutineList = stateList(currentRoutineStates);
const nextActionList = stateList(nextActionStates);

type ForeignKeyRelationship = Exclude<AlignmentRelationship, AlignmentJoinRelationship>;

const foreignKeyColumns = {
  axisId: 'axis_id',
  outcomeId: 'outcome_id',
  primaryOutcomeId: 'primary_outcome_id',
  projectId: 'project_id',
} as const;

const tableByKind: Readonly<Record<AlignmentNodeKind, string>> = {
  axis: 'axes',
  outcome: 'outcomes',
  project: 'projects',
  milestone: 'milestones',
  action: 'actions',
  routine: 'routines',
  note: 'notes',
};

/** Note records may have only a body; like the rest of the app, the body stands in for a title. */
const titleOf = (kind: AlignmentNodeKind, alias: string): string =>
  kind === 'note' ? `coalesce(${alias}.title, ${alias}.body, '')` : `${alias}.title`;

/* ───────────────────────── SQL ───────────────────────── */

interface ListStatement {
  /** Parameters: the filter parameters, then the limit. */
  readonly items: string;
  /** Parameters: the filter parameters. */
  readonly count: string;
}

function listStatement(input: {
  readonly columns: string;
  readonly from: string;
  readonly countFrom?: string;
  readonly where: string;
  readonly order: string;
}): ListStatement {
  return Object.freeze({
    items: `SELECT ${input.columns} FROM ${input.from} WHERE ${input.where}
      ORDER BY ${input.order} LIMIT ?;`,
    count: `SELECT COUNT(*) AS count FROM ${input.countFrom ?? input.from} WHERE ${input.where};`,
  });
}

const placementColumns = (alias: string) => `
  ${alias}.id AS placement_id, ${alias}.horizon AS placement_horizon,
  ${alias}.period_key AS placement_period_key, ${alias}.period_start_date AS placement_start,
  ${alias}.period_end_date AS placement_end, ${alias}.week_start AS placement_week_start`;

const activePlacementJoin = (alias: string, column: string, target: string) => `
  LEFT JOIN planning_placements ${alias} ON ${alias}.owner_id = ${target}.owner_id
    AND ${alias}.${column} = ${target}.id AND ${alias}.archived_at IS NULL
    AND ${alias}.deleted_at IS NULL`;

const milestoneCount = (alias: string, states: string) => `
  (SELECT COUNT(*) FROM milestones ${alias} INDEXED BY idx_milestones_outcome
   WHERE ${alias}.owner_id = o.owner_id AND ${alias}.outcome_id = o.id
     AND ${alias}.state IN (${states}) AND ${alias}.deleted_at IS NULL)`;

const axisColumns = `
  x.id, x.title, x.purpose, x.color_token, x.icon_name, x.state, x.sort_key, x.local_revision,
  x.archived_at,
  (SELECT COUNT(*) FROM outcomes o INDEXED BY idx_outcomes_axis
   WHERE o.owner_id = x.owner_id AND o.axis_id = x.id AND o.state IN (${currentOutcomeList})
     AND o.deleted_at IS NULL) AS outcome_count,
  (SELECT COUNT(*) FROM projects p INDEXED BY idx_projects_axis
   WHERE p.owner_id = x.owner_id AND p.axis_id = x.id AND p.state IN (${currentProjectList})
     AND p.deleted_at IS NULL) AS project_count,
  (SELECT COUNT(*) FROM routines r INDEXED BY idx_routines_axis
   WHERE r.owner_id = x.owner_id AND r.axis_id = x.id AND r.state IN (${currentRoutineList})
     AND r.deleted_at IS NULL) AS routine_count`;

// Milestone-derived progress: completed out of active plus completed Milestones;
// canceled ones are reported separately; archived ones never count.
const outcomeColumns = `
  o.id, o.title, o.success_definition, o.state, o.state_before_archive, o.local_revision,
  o.progress_mode, o.progress_percent, o.target_start_date, o.target_end_date, o.sort_key,
  o.axis_id, ox.title AS axis_title, ox.state AS axis_state, ${placementColumns('opl')},
  ${milestoneCount('mt', "'active', 'completed'")} AS milestone_total,
  ${milestoneCount('mc', "'completed'")} AS milestone_completed,
  ${milestoneCount('mx', "'canceled'")} AS milestone_canceled`;

const outcomeFrom = (index: string) => `outcomes o${index}
  LEFT JOIN axes ox ON ox.owner_id = o.owner_id AND ox.id = o.axis_id AND ox.deleted_at IS NULL
  ${activePlacementJoin('opl', 'outcome_id', 'o')}`;

const projectColumns = (extra: string) => `
  p.id, p.title, p.state, p.state_before_archive, p.local_revision, p.desired_result,
  p.target_start_date, p.target_end_date, p.sort_key${extra},
  p.axis_id, px.title AS axis_title, px.state AS axis_state,
  p.primary_outcome_id, po.title AS primary_title, po.state AS primary_state,
  ${placementColumns('ppl')},
  na.id AS next_action_id, na.title AS next_action_title, na.state AS next_action_state`;

/**
 * The id of the next action of the Project aliased `project`: its first unfinished
 * Action in (order key, id) order. A projection that never re-ranks anything; shared with the
 * weekly review's Project list.
 */
export const nextActionIdSql = (project: string) => `(
    SELECT a.id FROM actions a INDEXED BY idx_actions_project
    WHERE a.owner_id = ${project}.owner_id AND a.project_id = ${project}.id AND a.deleted_at IS NULL
      AND a.state IN (${nextActionList})
    ORDER BY a.sort_key, a.id LIMIT 1)`;

// The Alignment views compute the next action only for active Projects.
const projectFrom = (index: string) => `projects p${index}
  LEFT JOIN axes px ON px.owner_id = p.owner_id AND px.id = p.axis_id AND px.deleted_at IS NULL
  LEFT JOIN outcomes po ON po.owner_id = p.owner_id AND po.id = p.primary_outcome_id
    AND po.deleted_at IS NULL
  ${activePlacementJoin('ppl', 'project_id', 'p')}
  LEFT JOIN actions na ON na.owner_id = p.owner_id AND p.state = 'active'
    AND na.id = ${nextActionIdSql('p')}`;

const milestoneColumns = `
  m.id, m.title, m.measurable_checkpoint, m.state, m.state_before_archive, m.local_revision,
  m.target_start_date, m.target_end_date, m.sort_key,
  m.outcome_id, mo.title AS outcome_title, mo.state AS outcome_state,
  mo.axis_id AS outcome_axis_id, ${placementColumns('mpl')}`;

const milestoneFrom = (index: string) => `milestones m${index}
  LEFT JOIN outcomes mo ON mo.owner_id = m.owner_id AND mo.id = m.outcome_id
    AND mo.deleted_at IS NULL
  ${activePlacementJoin('mpl', 'milestone_id', 'm')}`;

/** One node row of any kind, with every parent column (NULL where the kind has none). */
function nodeStatement(kind: AlignmentNodeKind): string {
  const has = (column: string, kinds: readonly AlignmentNodeKind[]) =>
    kinds.includes(kind) ? column : `NULL AS ${column}`;
  return `SELECT n.id, ${titleOf(kind, 'n')} AS title, n.state, n.local_revision,
      ${has('axis_id', ['outcome', 'project', 'action', 'routine', 'note'])},
      ${has('outcome_id', ['milestone'])},
      ${has('primary_outcome_id', ['project'])},
      ${has('project_id', ['action', 'note'])},
      ${has('target_start_date', ['outcome', 'project', 'milestone'])},
      ${has('target_end_date', ['outcome', 'project', 'milestone'])}
    FROM ${tableByKind[kind]} n WHERE n.owner_id = ? AND n.id = ? AND n.deleted_at IS NULL;`;
}

const nodeColumns = (kind: AlignmentNodeKind) =>
  `n.id, ${titleOf(kind, 'n')} AS title, n.state, n.local_revision`;

/** Children that hold the focus in a foreign key, in any state (archived ones stay flagged). */
function childStatement(
  kind: AlignmentNodeKind,
  index: string,
  column: string,
  extraWhere = '',
): ListStatement {
  return listStatement({
    columns: `${nodeColumns(kind)}, n.sort_key`,
    from: `${tableByKind[kind]} n INDEXED BY ${index}`,
    where: `n.owner_id = ? AND n.${column} = ? AND n.deleted_at IS NULL${extraWhere}`,
    order: 'n.sort_key, n.id',
  });
}

const joinIndexes: Readonly<
  Record<AlignmentJoinRelationship, { readonly byParent: string; readonly byChild: string }>
> = {
  outcome_secondary_project: {
    byParent: 'idx_project_secondary_outcomes_outcome',
    byChild: 'idx_project_secondary_outcomes_project',
  },
  milestone_project: {
    byParent: 'idx_milestone_projects_milestone',
    byChild: 'idx_milestone_projects_project',
  },
  milestone_action: {
    byParent: 'idx_milestone_actions_milestone',
    byChild: 'idx_milestone_actions_action',
  },
};

const joinKinds: Readonly<
  Record<
    AlignmentJoinRelationship,
    { readonly parent: AlignmentNodeKind; readonly child: AlignmentNodeKind }
  >
> = {
  outcome_secondary_project: { parent: 'outcome', child: 'project' },
  milestone_project: { parent: 'milestone', child: 'project' },
  milestone_action: { parent: 'milestone', child: 'action' },
};

/**
 * Active links of one side with the other endpoint (any state; archived endpoints stay listed and
 * flagged). `down` starts from the parent (Outcome or Milestone), `up` from the child.
 */
function linkedStatement(
  relationship: AlignmentJoinRelationship,
  direction: 'up' | 'down',
): ListStatement {
  const link = alignmentLinkTables[relationship];
  const own = direction === 'down' ? link.parentColumn : link.childColumn;
  const other = direction === 'down' ? link.childColumn : link.parentColumn;
  const otherKind =
    direction === 'down' ? joinKinds[relationship].child : joinKinds[relationship].parent;
  const index =
    direction === 'down' ? joinIndexes[relationship].byParent : joinIndexes[relationship].byChild;
  const from = `${link.table} l INDEXED BY ${index}
    JOIN ${tableByKind[otherKind]} n ON n.owner_id = l.owner_id AND n.id = l.${other}
      AND n.deleted_at IS NULL`;
  return listStatement({
    columns: `l.id AS link_id, l.local_revision AS link_revision, ${nodeColumns(otherKind)}`,
    from,
    where: `l.owner_id = ? AND l.${own} = ? AND l.deleted_at IS NULL`,
    order: 'n.sort_key, n.id',
  });
}

const joinRelationships: readonly AlignmentJoinRelationship[] = [
  'outcome_secondary_project',
  'milestone_project',
  'milestone_action',
];

const linkedStatements = Object.freeze(
  Object.fromEntries(
    joinRelationships.map((relationship) => [
      relationship,
      Object.freeze({
        up: linkedStatement(relationship, 'up'),
        down: linkedStatement(relationship, 'down'),
      }),
    ]),
  ) as Record<
    AlignmentJoinRelationship,
    { readonly up: ListStatement; readonly down: ListStatement }
  >,
);

const childStatements: Readonly<Record<ForeignKeyRelationship, ListStatement>> = Object.freeze({
  axis_outcome: childStatement('outcome', 'idx_outcomes_axis', 'axis_id'),
  axis_project: childStatement('project', 'idx_projects_axis', 'axis_id'),
  axis_routine: childStatement('routine', 'idx_routines_axis', 'axis_id'),
  outcome_milestone: childStatement('milestone', 'idx_milestones_outcome', 'outcome_id'),
  outcome_primary_project: childStatement(
    'project',
    'idx_projects_primary_outcome',
    'primary_outcome_id',
  ),
  project_action: childStatement('action', 'idx_actions_project', 'project_id'),
  project_note: childStatement('note', 'idx_notes_project', 'project_id'),
});

const candidateIndexes: Readonly<Partial<Record<AlignmentNodeKind, string>>> = {
  axis: 'idx_axes_order',
  outcome: 'idx_outcomes_order',
  project: 'idx_projects_order',
};

const axisColumnKinds: readonly AlignmentNodeKind[] = [
  'outcome',
  'project',
  'action',
  'routine',
  'note',
];

/** Non-archived objects of one kind whose title matches a case-insensitive GLOB pattern. */
function candidateStatement(kind: AlignmentNodeKind): ListStatement {
  const index = candidateIndexes[kind];
  return listStatement({
    columns: `${nodeColumns(kind)}, ${axisColumnKinds.includes(kind) ? 'n.axis_id' : 'NULL'} AS axis_id`,
    from: `${tableByKind[kind]} n${index === undefined ? '' : ` INDEXED BY ${index}`}`,
    where: `n.owner_id = ? AND n.deleted_at IS NULL AND n.state <> 'archived'
      AND ${titleOf(kind, 'n')} GLOB ?`,
    order: 'n.sort_key, n.id',
  });
}

const nodeKinds: readonly AlignmentNodeKind[] = [
  'axis',
  'outcome',
  'project',
  'milestone',
  'action',
  'routine',
  'note',
];

const byKind = <T>(build: (kind: AlignmentNodeKind) => T): Readonly<Record<AlignmentNodeKind, T>> =>
  Object.freeze(
    Object.fromEntries(nodeKinds.map((kind) => [kind, build(kind)])) as Record<
      AlignmentNodeKind,
      T
    >,
  );

const containerColumns = 'id, sort_key, local_revision, state';
const containerLive = `state <> 'archived' AND deleted_at IS NULL`;

/** Counts of non-archived direct children (and active join links) that archive leaves in place. */
const archiveCount = (table: string, index: string, column: string) => `
  SELECT COUNT(*) AS count FROM ${table} INDEXED BY ${index}
  WHERE owner_id = ? AND ${column} = ? AND state <> 'archived' AND deleted_at IS NULL;`;

const archiveLinkCount = (relationship: AlignmentJoinRelationship) => {
  const link = alignmentLinkTables[relationship];
  const child = joinKinds[relationship].child;
  return `
    SELECT COUNT(*) AS count FROM ${link.table} l INDEXED BY ${joinIndexes[relationship].byParent}
    JOIN ${tableByKind[child]} n ON n.owner_id = l.owner_id AND n.id = l.${link.childColumn}
      AND n.deleted_at IS NULL
    WHERE l.owner_id = ? AND l.${link.parentColumn} = ? AND l.deleted_at IS NULL
      AND n.state <> 'archived';`;
};

interface ReferrerStatement {
  readonly relationship: DeleteReferrerRelationship;
  readonly type: EntityType;
  readonly sql: string;
}

const referrer = (
  relationship: DeleteReferrerRelationship,
  kind: 'outcome' | 'project' | 'routine' | 'action' | 'note',
  index: string,
  column: string,
): ReferrerStatement => ({
  relationship,
  type: kind,
  sql: `SELECT n.id, ${titleOf(kind, 'n')} AS title FROM ${tableByKind[kind]} n INDEXED BY ${index}
    WHERE n.owner_id = ? AND n.${column} = ? AND n.deleted_at IS NULL
    ORDER BY n.sort_key, n.id;`,
});

interface LinkRowsStatement {
  readonly relationship: AlignmentJoinRelationship;
  readonly sql: string;
}

/** Rows per page of a delete target's review items; pages repeat until one comes back short. */
const reviewItemPageSize = maxLimit;

/**
 * One bounded page of the review items that name a delete target, in id order after an id, through
 * the target's own index: any item or review state, soft-deleted rows included, because every row
 * holds the RESTRICT foreign key. Parameters: owner, target id, after id ('' first), limit.
 */
const reviewItemPage = (index: string, column: string) => `
  SELECT * FROM review_items INDEXED BY ${index}
  WHERE owner_id = ? AND ${column} = ? AND id > ?
  ORDER BY id LIMIT ?;`;

const linkRows = (
  relationship: AlignmentJoinRelationship,
  side: 'parent' | 'child',
): LinkRowsStatement => {
  const link = alignmentLinkTables[relationship];
  const column = side === 'parent' ? link.parentColumn : link.childColumn;
  const index =
    side === 'parent' ? joinIndexes[relationship].byParent : joinIndexes[relationship].byChild;
  // Any link state: unlinked rows still hold the foreign key and leave with the endpoint.
  return {
    relationship,
    sql: `SELECT id FROM ${link.table} INDEXED BY ${index}
      WHERE owner_id = ? AND ${column} = ? ORDER BY id;`,
  };
};

const outboxPending = `
  SELECT 1 AS pending FROM sync_outbox
  WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
    AND state IN ('pending', 'sending', 'retry_wait', 'blocked_conflict', 'dead_letter')
  LIMIT 1;`;

const conflictOpen = `
  SELECT 1 AS open FROM sync_conflicts
  WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
    AND state = 'open'
  LIMIT 1;`;

/** Prepared, owner-scoped statements. Exported so index use can be verified with EXPLAIN. */
export const alignmentQuerySql = Object.freeze({
  listAxes: listStatement({
    columns: axisColumns,
    from: 'axes x INDEXED BY idx_axes_order',
    // `active` sorts before `archived`, so index order puts archived Axes last.
    where: `x.owner_id = ? AND x.deleted_at IS NULL AND (x.state = 'active' OR ? = 1)`,
    order: 'x.state, x.sort_key, x.id',
  }),
  axis: `SELECT ${axisColumns} FROM axes x WHERE x.owner_id = ? AND x.id = ? AND x.deleted_at IS NULL;`,
  /**
   * The Axis's recent review note: its most recent active `note` item in a completed
   * review, latest completion first. Sorts only that Axis's note items.
   */
  axisReviewNote: `
    SELECT i.decision_note, r.id AS review_id, r.review_type, r.period_key, r.period_start_date,
           r.period_end_date, r.week_start, r.completed_at
    FROM review_items i INDEXED BY idx_review_items_axis
    CROSS JOIN review_checkpoints r ON r.owner_id = i.owner_id AND r.id = i.review_id
    WHERE i.owner_id = ? AND i.axis_id = ? AND i.decision = 'note'
      AND i.decision_note IS NOT NULL AND i.archived_at IS NULL AND i.deleted_at IS NULL
      AND r.state = 'completed' AND r.completed_at IS NOT NULL AND r.deleted_at IS NULL
    ORDER BY r.completed_at DESC, r.id DESC, i.id DESC
    LIMIT 1;`,
  outcome: `SELECT ${outcomeColumns} FROM ${outcomeFrom('')}
    WHERE o.owner_id = ? AND o.id = ? AND o.deleted_at IS NULL;`,
  axisOutcomes: listStatement({
    columns: outcomeColumns,
    from: outcomeFrom(' INDEXED BY idx_outcomes_axis'),
    countFrom: 'outcomes o INDEXED BY idx_outcomes_axis',
    where: `o.owner_id = ? AND o.axis_id = ? AND o.state IN (${currentOutcomeList})
      AND o.deleted_at IS NULL`,
    order: 'o.sort_key, o.id',
  }),
  axisOutcomesWithFinished: listStatement({
    columns: outcomeColumns,
    from: outcomeFrom(' INDEXED BY idx_outcomes_axis'),
    countFrom: 'outcomes o INDEXED BY idx_outcomes_axis',
    where: `o.owner_id = ? AND o.axis_id = ? AND o.state IN (${liveOutcomeList})
      AND o.deleted_at IS NULL`,
    order: 'o.sort_key, o.id',
  }),
  unassignedOutcomes: listStatement({
    columns: outcomeColumns,
    from: outcomeFrom(' INDEXED BY idx_outcomes_axis'),
    countFrom: 'outcomes o INDEXED BY idx_outcomes_axis',
    where: `o.owner_id = ? AND o.axis_id IS NULL AND o.state <> 'archived' AND o.deleted_at IS NULL`,
    order: 'o.sort_key, o.id',
  }),
  project: `SELECT ${projectColumns(', p.description, p.notes')} FROM ${projectFrom('')}
    WHERE p.owner_id = ? AND p.id = ? AND p.deleted_at IS NULL;`,
  axisProjects: listStatement({
    columns: projectColumns(''),
    from: projectFrom(' INDEXED BY idx_projects_axis'),
    countFrom: 'projects p INDEXED BY idx_projects_axis',
    where: `p.owner_id = ? AND p.axis_id = ? AND p.state IN (${currentProjectList})
      AND p.deleted_at IS NULL`,
    order: 'p.sort_key, p.id',
  }),
  axisProjectsWithFinished: listStatement({
    columns: projectColumns(''),
    from: projectFrom(' INDEXED BY idx_projects_axis'),
    countFrom: 'projects p INDEXED BY idx_projects_axis',
    where: `p.owner_id = ? AND p.axis_id = ? AND p.state IN (${liveProjectList})
      AND p.deleted_at IS NULL`,
    order: 'p.sort_key, p.id',
  }),
  unassignedProjects: listStatement({
    columns: projectColumns(''),
    from: projectFrom(' INDEXED BY idx_projects_axis'),
    countFrom: 'projects p INDEXED BY idx_projects_axis',
    where: `p.owner_id = ? AND p.axis_id IS NULL AND p.state <> 'archived' AND p.deleted_at IS NULL`,
    order: 'p.sort_key, p.id',
  }),
  primaryProjects: listStatement({
    columns: projectColumns(''),
    from: projectFrom(' INDEXED BY idx_projects_primary_outcome'),
    countFrom: 'projects p INDEXED BY idx_projects_primary_outcome',
    where: `p.owner_id = ? AND p.primary_outcome_id = ? AND p.state <> 'archived'
      AND p.deleted_at IS NULL`,
    order: 'p.sort_key, p.id',
  }),
  milestone: `SELECT ${milestoneColumns} FROM ${milestoneFrom('')}
    WHERE m.owner_id = ? AND m.id = ? AND m.deleted_at IS NULL;`,
  outcomeMilestones: listStatement({
    columns: milestoneColumns,
    from: milestoneFrom(' INDEXED BY idx_milestones_outcome'),
    countFrom: 'milestones m INDEXED BY idx_milestones_outcome',
    where: `m.owner_id = ? AND m.outcome_id = ? AND m.state <> 'archived' AND m.deleted_at IS NULL`,
    order: 'm.sort_key, m.id',
  }),
  axisRoutines: childStatement(
    'routine',
    'idx_routines_axis',
    'axis_id',
    ` AND n.state IN (${currentRoutineList})`,
  ),
  projectActions: childStatement(
    'action',
    'idx_actions_project',
    'project_id',
    ` AND n.state <> 'archived'`,
  ),
  projectNotes: childStatement(
    'note',
    'idx_notes_project',
    'project_id',
    ` AND n.state <> 'archived'`,
  ),
  node: byKind(nodeStatement),
  children: childStatements,
  linked: linkedStatements,
  candidates: byKind(candidateStatement),
  container: Object.freeze({
    axes: `SELECT ${containerColumns} FROM axes INDEXED BY idx_axes_order
      WHERE owner_id = ? AND ${containerLive} ORDER BY sort_key, id LIMIT ?;`,
    axisOutcomes: `SELECT ${containerColumns} FROM outcomes INDEXED BY idx_outcomes_axis
      WHERE owner_id = ? AND axis_id = ? AND ${containerLive} ORDER BY sort_key, id LIMIT ?;`,
    unassignedOutcomes: `SELECT ${containerColumns} FROM outcomes INDEXED BY idx_outcomes_axis
      WHERE owner_id = ? AND axis_id IS NULL AND ${containerLive} ORDER BY sort_key, id LIMIT ?;`,
    axisProjects: `SELECT ${containerColumns} FROM projects INDEXED BY idx_projects_axis
      WHERE owner_id = ? AND axis_id = ? AND ${containerLive} ORDER BY sort_key, id LIMIT ?;`,
    unassignedProjects: `SELECT ${containerColumns} FROM projects INDEXED BY idx_projects_axis
      WHERE owner_id = ? AND axis_id IS NULL AND ${containerLive} ORDER BY sort_key, id LIMIT ?;`,
    outcomeMilestones: `SELECT ${containerColumns} FROM milestones INDEXED BY idx_milestones_outcome
      WHERE owner_id = ? AND outcome_id = ? AND ${containerLive} ORDER BY sort_key, id LIMIT ?;`,
    projectActions: `SELECT ${containerColumns} FROM actions INDEXED BY idx_actions_project
      WHERE owner_id = ? AND project_id = ? AND ${containerLive} ORDER BY sort_key, id LIMIT ?;`,
  }),
  findLink: Object.freeze(
    Object.fromEntries(
      joinRelationships.map((relationship) => {
        const link = alignmentLinkTables[relationship];
        return [
          relationship,
          `SELECT id FROM ${link.table}
           WHERE owner_id = ? AND ${link.parentColumn} = ? AND ${link.childColumn} = ? LIMIT 1;`,
        ];
      }),
    ) as Record<AlignmentJoinRelationship, string>,
  ),
  archiveImpact: Object.freeze({
    axis: [
      { kind: 'outcome', sql: archiveCount('outcomes', 'idx_outcomes_axis', 'axis_id') },
      { kind: 'project', sql: archiveCount('projects', 'idx_projects_axis', 'axis_id') },
      { kind: 'routine', sql: archiveCount('routines', 'idx_routines_axis', 'axis_id') },
      { kind: 'action', sql: archiveCount('actions', 'idx_actions_axis', 'axis_id') },
      { kind: 'note', sql: archiveCount('notes', 'idx_notes_axis', 'axis_id') },
    ],
    outcome: [
      {
        kind: 'milestone',
        sql: archiveCount('milestones', 'idx_milestones_outcome', 'outcome_id'),
      },
      {
        kind: 'project',
        sql: archiveCount('projects', 'idx_projects_primary_outcome', 'primary_outcome_id'),
      },
      { kind: 'project', sql: archiveLinkCount('outcome_secondary_project') },
    ],
    project: [
      { kind: 'action', sql: archiveCount('actions', 'idx_actions_project', 'project_id') },
      { kind: 'note', sql: archiveCount('notes', 'idx_notes_project', 'project_id') },
    ],
    milestone: [
      { kind: 'project', sql: archiveLinkCount('milestone_project') },
      { kind: 'action', sql: archiveLinkCount('milestone_action') },
    ],
  } satisfies Partial<
    Record<AlignmentNodeKind, readonly { readonly kind: AlignmentNodeKind; readonly sql: string }[]>
  >),
  deleteImpact: Object.freeze({
    referrers: Object.freeze({
      axis: [
        referrer('axis_outcome', 'outcome', 'idx_outcomes_axis', 'axis_id'),
        referrer('axis_project', 'project', 'idx_projects_axis', 'axis_id'),
        referrer('axis_routine', 'routine', 'idx_routines_axis', 'axis_id'),
        referrer('axis_action', 'action', 'idx_actions_axis', 'axis_id'),
        referrer('axis_note', 'note', 'idx_notes_axis', 'axis_id'),
      ],
      outcome: [
        referrer(
          'outcome_primary_project',
          'project',
          'idx_projects_primary_outcome',
          'primary_outcome_id',
        ),
      ],
      project: [
        referrer('project_action', 'action', 'idx_actions_project', 'project_id'),
        referrer('project_note', 'note', 'idx_notes_project', 'project_id'),
      ],
    } satisfies Partial<Record<EntityType, readonly ReferrerStatement[]>>),
    links: Object.freeze({
      outcome: [linkRows('outcome_secondary_project', 'parent')],
      project: [
        linkRows('outcome_secondary_project', 'child'),
        linkRows('milestone_project', 'child'),
      ],
      milestone: [linkRows('milestone_project', 'parent'), linkRows('milestone_action', 'parent')],
      action: [linkRows('milestone_action', 'child')],
    } satisfies Partial<Record<EntityType, readonly LinkRowsStatement[]>>),
    placements: Object.freeze({
      outcome: `SELECT id FROM planning_placements INDEXED BY idx_placements_outcome_all
        WHERE owner_id = ? AND outcome_id = ? AND deleted_at IS NULL ORDER BY id;`,
      project: `SELECT id FROM planning_placements INDEXED BY idx_placements_project_all
        WHERE owner_id = ? AND project_id = ? AND deleted_at IS NULL ORDER BY id;`,
      milestone: `SELECT id FROM planning_placements INDEXED BY idx_placements_milestone_all
        WHERE owner_id = ? AND milestone_id = ? AND deleted_at IS NULL ORDER BY id;`,
      action: `SELECT id FROM planning_placements
        WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL ORDER BY id;`,
    } satisfies Partial<Record<EntityType, string>>),
    selections: Object.freeze({
      project: [
        `SELECT id FROM week_selections INDEXED BY idx_week_selections_project
         WHERE owner_id = ? AND project_id = ? AND deleted_at IS NULL ORDER BY id;`,
      ],
      milestone: [
        `SELECT id FROM week_selections INDEXED BY idx_week_selections_milestone
         WHERE owner_id = ? AND milestone_id = ? AND deleted_at IS NULL ORDER BY id;`,
      ],
      action: [
        `SELECT id FROM week_selections
         WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL ORDER BY id;`,
        `SELECT id FROM focus_selections
         WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL ORDER BY id;`,
      ],
    } satisfies Partial<Record<EntityType, readonly string[]>>),
    requiredChildren: listStatement({
      columns: 'n.id, n.title, n.state',
      from: 'milestones n INDEXED BY idx_milestones_outcome',
      where: 'n.owner_id = ? AND n.outcome_id = ? AND n.deleted_at IS NULL',
      order: 'n.sort_key, n.id',
    }),
    // Review decisions are kept with a cleared reference; see `reviewItemPage`.
    reviewItems: Object.freeze({
      axis: reviewItemPage('idx_review_items_axis', 'axis_id'),
      outcome: reviewItemPage('idx_review_items_outcome', 'outcome_id'),
      project: reviewItemPage('idx_review_items_project', 'project_id'),
      milestone: reviewItemPage('idx_review_items_milestone', 'milestone_id'),
      action: reviewItemPage('idx_review_items_action', 'action_id'),
    } satisfies Partial<Record<EntityType, string>>),
    routineDefaults: `SELECT COUNT(*) AS count FROM routine_action_defaults
      INDEXED BY idx_routine_defaults_project WHERE owner_id = ? AND project_id = ?;`,
    outboxPending,
    conflictOpen,
  }),
  history: `
    SELECT event_type, occurred_at FROM domain_events INDEXED BY idx_domain_events_entity
    WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
    ORDER BY occurred_at DESC, id DESC LIMIT ?;`,
});

/**
 * Every review item that names a permanent-delete target (Axis, Outcome, Project, Milestone, or
 * Action), owner-scoped and read in bounded pages through the target's named index. `items` are
 * the live rows the delete keeps with a cleared reference; `total` counts every row
 * that still holds the foreign key, soft-deleted ones included.
 */
export async function readReviewItemReferences(
  driver: SqliteDriver,
  ownerId: OwnerId,
  ref: EntityRef,
): Promise<{ readonly items: readonly CanonicalRecordState[]; readonly total: number }> {
  const sql = (alignmentQuerySql.deleteImpact.reviewItems as Partial<Record<EntityType, string>>)[
    ref.type
  ];
  const items: CanonicalRecordState[] = [];
  let total = 0;
  if (sql === undefined) return { items, total };
  let after = '';
  let page: readonly Values[];
  do {
    // Sequential pages: the browser owns one SQLite worker connection.
    page = await driver.all<Values>(sql, [ownerId, ref.id, after, reviewItemPageSize]);
    for (const row of page) {
      after = text(row, 'id');
      total += 1;
      if (optionalText(row, 'deleted_at') !== undefined) continue;
      items.push(
        reviewItemCanonicalCodec.recordFromRow(
          { type: 'review_item', id: after as UUID, ownerId },
          row,
        ),
      );
    }
  } while (page.length === reviewItemPageSize);
  return { items, total };
}

/* ───────────────────────── Row mappers ───────────────────────── */

function periodFrom(row: Values): HorizonPeriod {
  const parsed = horizonPeriodSchema.safeParse(
    decodePeriodColumns({
      horizon: row['placement_horizon'],
      periodKey: row['placement_period_key'],
      start: row['placement_start'],
      end: row['placement_end'],
      weekStart: row['placement_week_start'],
    }),
  );
  return parsed.success ? (parsed.data as HorizonPeriod) : invalidRow();
}

function placement(row: Values): { readonly id: UUID; readonly period: HorizonPeriod } | undefined {
  const id = optionalText(row, 'placement_id');
  return id === undefined ? undefined : { id: id as UUID, period: periodFrom(row) };
}

function alignmentNode(kind: AlignmentNodeKind, row: Values): AlignmentNode {
  const state = oneOf(row, 'state', statesByKind[kind]);
  return {
    id: text(row, 'id') as UUID,
    title: text(row, 'title'),
    state,
    archived: state === 'archived',
    kind,
    localRevision: integer(row, 'local_revision'),
  };
}

function linkedItem<K extends AlignmentNodeKind>(kind: K, row: Values): LinkedItem<K> {
  const node = alignmentNode(kind, row);
  const linkId = optionalText(row, 'link_id');
  return {
    id: node.id,
    title: node.title,
    state: node.state,
    archived: node.archived,
    kind,
    localRevision: node.localRevision,
    ...(linkId === undefined
      ? {}
      : { linkId: linkId as UUID, linkRevision: integer(row, 'link_revision') }),
  };
}

/** A joined parent (Axis or primary Outcome) as a row reference, when the row names one. */
function parentRef(
  row: Values,
  columns: { readonly id: string; readonly title: string; readonly state: string },
  states: readonly string[],
): NodeRef | undefined {
  const id = optionalText(row, columns.id);
  const title = optionalText(row, columns.title);
  if (id === undefined || title === undefined) return undefined;
  const state = oneOf(row, columns.state, states);
  return { id: id as UUID, title, state, archived: state === 'archived' };
}

const axisRefColumns = { id: 'axis_id', title: 'axis_title', state: 'axis_state' } as const;

function axisSummary(row: Values): AxisSummary {
  return {
    id: text(row, 'id') as UUID,
    localRevision: integer(row, 'local_revision'),
    title: text(row, 'title'),
    ...spread('purpose', optionalText(row, 'purpose')),
    ...spread('color', optionalText(row, 'color_token')),
    ...spread('icon', optionalText(row, 'icon_name')),
    state: oneOf(row, 'state', axisStates),
    orderKey: text(row, 'sort_key'),
    ...spread('archivedAt', optionalText(row, 'archived_at') as Instant | undefined),
    counts: {
      outcomes: integer(row, 'outcome_count'),
      projects: integer(row, 'project_count'),
      routines: integer(row, 'routine_count'),
    },
  };
}

function outcomeItem(row: Values): OutcomeItem {
  const mode = oneOf(row, 'progress_mode', ['none', 'manual', 'milestone_derived'] as const);
  const counts = {
    completed: integer(row, 'milestone_completed'),
    total: integer(row, 'milestone_total'),
    canceled: integer(row, 'milestone_canceled'),
  };
  const progress = outcomeProgress(
    mode === 'manual' ? { mode, percentage: integer(row, 'progress_percent') } : { mode },
    counts,
  );
  return {
    id: text(row, 'id') as UUID,
    localRevision: integer(row, 'local_revision'),
    title: text(row, 'title'),
    successDefinition: text(row, 'success_definition'),
    state: oneOf(row, 'state', outcomeStates),
    ...spread(
      'stateBeforeArchive',
      optionalText(row, 'state_before_archive') === undefined
        ? undefined
        : oneOf(row, 'state_before_archive', alignmentLiveStates.outcome),
    ),
    ...spread('axis', parentRef(row, axisRefColumns, axisStates)),
    ...spread('targetStart', optionalText(row, 'target_start_date') as CalendarDate | undefined),
    ...spread('targetEnd', optionalText(row, 'target_end_date') as CalendarDate | undefined),
    progress,
    canceledMilestones: counts.canceled,
    ...spread('placement', placement(row)),
    orderKey: text(row, 'sort_key'),
  };
}

function projectItem(row: Values): ProjectItem {
  const state = oneOf(row, 'state', projectStates);
  const nextId = optionalText(row, 'next_action_id');
  return {
    id: text(row, 'id') as UUID,
    localRevision: integer(row, 'local_revision'),
    title: text(row, 'title'),
    state,
    ...spread(
      'stateBeforeArchive',
      optionalText(row, 'state_before_archive') === undefined
        ? undefined
        : oneOf(row, 'state_before_archive', alignmentLiveStates.project),
    ),
    ...spread('desiredResult', optionalText(row, 'desired_result')),
    ...spread('axis', parentRef(row, axisRefColumns, axisStates)),
    ...spread(
      'primaryOutcome',
      parentRef(
        row,
        { id: 'primary_outcome_id', title: 'primary_title', state: 'primary_state' },
        outcomeStates,
      ),
    ),
    ...spread('targetStart', optionalText(row, 'target_start_date') as CalendarDate | undefined),
    ...spread('targetEnd', optionalText(row, 'target_end_date') as CalendarDate | undefined),
    ...spread('placement', placement(row)),
    orderKey: text(row, 'sort_key'),
    nextAction:
      state !== 'active'
        ? { status: 'not_applicable' }
        : nextId === undefined
          ? { status: 'missing' }
          : {
              status: 'present',
              action: {
                id: nextId as UUID,
                title: text(row, 'next_action_title'),
                state: oneOf(row, 'next_action_state', actionStates),
              },
            },
  };
}

function milestoneItem(row: Values): MilestoneItem {
  const outcomeId = text(row, 'outcome_id') as UUID;
  return {
    id: text(row, 'id') as UUID,
    localRevision: integer(row, 'local_revision'),
    title: text(row, 'title'),
    measurableCheckpoint: text(row, 'measurable_checkpoint'),
    state: oneOf(row, 'state', milestoneStates),
    ...spread(
      'stateBeforeArchive',
      optionalText(row, 'state_before_archive') === undefined
        ? undefined
        : oneOf(row, 'state_before_archive', alignmentLiveStates.milestone),
    ),
    // The parent always exists (RESTRICT foreign key); the fallback only guards a torn read.
    outcome: parentRef(
      row,
      { id: 'outcome_id', title: 'outcome_title', state: 'outcome_state' },
      outcomeStates,
    ) ?? { id: outcomeId, title: '', state: 'active', archived: false },
    ...spread('targetStart', optionalText(row, 'target_start_date') as CalendarDate | undefined),
    ...spread('targetEnd', optionalText(row, 'target_end_date') as CalendarDate | undefined),
    ...spread('placement', placement(row)),
    orderKey: text(row, 'sort_key'),
  };
}

function edge(
  rule: AlignmentRelationshipRule,
  direction: 'up' | 'down',
  row: Values,
): AlignmentEdge {
  const linkId = optionalText(row, 'link_id');
  return {
    relationship: rule.relationship,
    direction,
    required: rule.required,
    ...(linkId === undefined
      ? {}
      : { linkId: linkId as UUID, linkRevision: integer(row, 'link_revision') }),
    other: alignmentNode(direction === 'up' ? rule.parentKind : rule.childKind, row),
  };
}

/**
 * A case-insensitive substring pattern for SQLite GLOB. Each cased character becomes a
 * `[lowerUPPER]` class (Unicode-aware, unlike LIKE, which folds ASCII only); GLOB metacharacters
 * match literally.
 */
export function titleSearchPattern(search: string | undefined): string {
  const needle = [...(search?.trim() ?? '')].slice(0, 256);
  let pattern = '*';
  for (const character of needle) {
    // Every single-character case form of the character, itself included (title case too).
    const forms = [
      ...new Set([
        character,
        character.toLocaleLowerCase('en-US'),
        character.toLocaleUpperCase('en-US'),
      ]),
    ];
    if (forms.length > 1 && forms.every((form) => [...form].length === 1)) {
      pattern += `[${forms.join('')}]`;
    } else if (character === '*' || character === '?' || character === '[') {
      pattern += `[${character}]`;
    } else {
      pattern += character;
    }
  }
  return `${pattern}*`;
}

/* ───────────────────────── Adapter ───────────────────────── */

export class SqliteAlignmentQueries implements AlignmentQueryPort {
  readonly #codecs = createDefaultCanonicalCodecRegistry();

  constructor(private readonly driver: SqliteDriver) {}

  async readRecord(ownerId: OwnerId, ref: EntityRef): Promise<CanonicalRecordState | null> {
    if (ref.ownerId !== ownerId) return null;
    return this.#codecs.resolve(ref.type).read(this.driver, ref);
  }

  async listAxes(
    ownerId: OwnerId,
    options: { readonly includeArchived: boolean; readonly limit: number },
  ): Promise<Bounded<AxisSummary>> {
    return this.#list(
      alignmentQuerySql.listAxes,
      [ownerId, options.includeArchived ? 1 : 0],
      options.limit,
      axisSummary,
    );
  }

  async listUnassigned(ownerId: OwnerId, limit: number): Promise<UnassignedView> {
    return {
      outcomes: await this.#list(
        alignmentQuerySql.unassignedOutcomes,
        [ownerId],
        limit,
        outcomeItem,
      ),
      projects: await this.#list(
        alignmentQuerySql.unassignedProjects,
        [ownerId],
        limit,
        projectItem,
      ),
    };
  }

  async getAxis(
    ownerId: OwnerId,
    id: UUID,
    options: { readonly includeFinished: boolean; readonly limit: number },
  ): Promise<AxisDetail | null> {
    const row = await this.driver.get<Values>(alignmentQuerySql.axis, [ownerId, id]);
    if (row === undefined) return null;
    const axis = axisSummary(row);
    return {
      axis,
      outcomes: await this.#list(
        options.includeFinished
          ? alignmentQuerySql.axisOutcomesWithFinished
          : alignmentQuerySql.axisOutcomes,
        [ownerId, axis.id],
        options.limit,
        outcomeItem,
      ),
      projects: await this.#list(
        options.includeFinished
          ? alignmentQuerySql.axisProjectsWithFinished
          : alignmentQuerySql.axisProjects,
        [ownerId, axis.id],
        options.limit,
        projectItem,
      ),
      routines: await this.#list(
        alignmentQuerySql.axisRoutines,
        [ownerId, axis.id],
        options.limit,
        (entry) => linkedItem('routine', entry),
      ),
      reviewNote: await this.#reviewNote(ownerId, axis.id),
      history: await this.listHistory(
        ownerId,
        { type: 'axis', id: axis.id, ownerId },
        options.limit,
      ),
    };
  }

  async #reviewNote(ownerId: OwnerId, axisId: UUID): Promise<AxisReviewNote | null> {
    const row = await this.driver.get<Values>(alignmentQuerySql.axisReviewNote, [ownerId, axisId]);
    if (row === undefined) return null;
    const period = reviewPeriodFromRow(row);
    return {
      text: text(row, 'decision_note'),
      reviewId: text(row, 'review_id') as UUID,
      reviewType: period.type,
      period,
      completedAt: text(row, 'completed_at') as Instant,
    };
  }

  async getOutcome(ownerId: OwnerId, id: UUID, limit: number): Promise<OutcomeDetail | null> {
    const row = await this.driver.get<Values>(alignmentQuerySql.outcome, [ownerId, id]);
    if (row === undefined) return null;
    const outcome = outcomeItem(row);
    return {
      outcome,
      milestones: await this.#list(
        alignmentQuerySql.outcomeMilestones,
        [ownerId, outcome.id],
        limit,
        milestoneItem,
      ),
      primaryProjects: await this.#list(
        alignmentQuerySql.primaryProjects,
        [ownerId, outcome.id],
        limit,
        projectItem,
      ),
      supportingProjects: await this.#list(
        linkedStatements.outcome_secondary_project.down,
        [ownerId, outcome.id],
        limit,
        (entry) => linkedItem('project', entry),
      ),
      history: await this.listHistory(ownerId, { type: 'outcome', id: outcome.id, ownerId }, limit),
    };
  }

  async getProject(
    ownerId: OwnerId,
    id: UUID,
    options: { readonly actionLimit: number; readonly limit: number },
  ): Promise<ProjectDetail | null> {
    const row = await this.driver.get<Values>(alignmentQuerySql.project, [ownerId, id]);
    if (row === undefined) return null;
    const project = projectItem(row);
    const secondary = await this.#list(
      linkedStatements.outcome_secondary_project.up,
      [ownerId, project.id],
      maxLimit,
      (entry) => linkedItem('outcome', entry),
    );
    return {
      project: {
        ...project,
        ...spread('description', optionalText(row, 'description')),
        ...spread('notes', optionalText(row, 'notes')),
      },
      secondaryOutcomes: secondary.items,
      milestones: await this.#list(
        linkedStatements.milestone_project.up,
        [ownerId, project.id],
        options.limit,
        (entry) => linkedItem('milestone', entry),
      ),
      actions: await this.#list(
        alignmentQuerySql.projectActions,
        [ownerId, project.id],
        options.actionLimit,
        (entry) => ({ ...linkedItem('action', entry), orderKey: text(entry, 'sort_key') }),
      ),
      capturedNotes: await this.#list(
        alignmentQuerySql.projectNotes,
        [ownerId, project.id],
        options.limit,
        (entry) => linkedItem('note', entry),
      ),
      history: await this.listHistory(
        ownerId,
        { type: 'project', id: project.id, ownerId },
        options.limit,
      ),
    };
  }

  async getMilestone(ownerId: OwnerId, id: UUID, limit: number): Promise<MilestoneDetail | null> {
    const row = await this.driver.get<Values>(alignmentQuerySql.milestone, [ownerId, id]);
    if (row === undefined) return null;
    const milestone = milestoneItem(row);
    const axisId = optionalText(row, 'outcome_axis_id');
    const axis =
      axisId === undefined ? undefined : await this.#nodeRow(ownerId, 'axis', axisId as UUID);
    return {
      milestone,
      ...(axis === undefined
        ? {}
        : {
            axis: {
              id: text(axis, 'id') as UUID,
              title: text(axis, 'title'),
              state: oneOf(axis, 'state', axisStates),
              archived: axis['state'] === 'archived',
            },
          }),
      projects: await this.#list(
        linkedStatements.milestone_project.down,
        [ownerId, milestone.id],
        limit,
        (entry) => linkedItem('project', entry),
      ),
      actions: await this.#list(
        linkedStatements.milestone_action.down,
        [ownerId, milestone.id],
        limit,
        (entry) => linkedItem('action', entry),
      ),
      history: await this.listHistory(
        ownerId,
        { type: 'milestone', id: milestone.id, ownerId },
        limit,
      ),
    };
  }

  async getNeighborhood(
    ownerId: OwnerId,
    focus: { readonly kind: AlignmentNodeKind; readonly id: UUID },
    limit: number,
  ): Promise<AlignmentNeighborhood | null> {
    const row = await this.#nodeRow(ownerId, focus.kind, focus.id);
    if (row === undefined) return null;
    const node = alignmentNode(focus.kind, row);
    const outcome =
      focus.kind === 'outcome'
        ? await this.driver.get<Values>(alignmentQuerySql.outcome, [ownerId, node.id])
        : undefined;
    const above: AlignmentEdge[] = [];
    for (const rule of alignmentRelationshipsAbove(focus.kind)) {
      above.push(...(await this.#edges(ownerId, rule, 'up', row, maxLimit)).edges);
    }
    const below: AlignmentEdge[] = [];
    const totals: Partial<Record<AlignmentRelationship, number>> = {};
    for (const rule of alignmentRelationshipsBelow(focus.kind)) {
      const { edges, total } = await this.#edges(ownerId, rule, 'down', row, clampLimit(limit));
      totals[rule.relationship] = total;
      below.push(...edges);
    }
    return {
      focus: {
        ...node,
        ...(outcome === undefined ? {} : { progress: outcomeItem(outcome).progress }),
        ...spread(
          'targetStart',
          optionalText(row, 'target_start_date') as CalendarDate | undefined,
        ),
        ...spread('targetEnd', optionalText(row, 'target_end_date') as CalendarDate | undefined),
      },
      chain: await this.#chain(ownerId, focus.kind, row, 0),
      above,
      below,
      totals,
    };
  }

  async listCandidates(
    ownerId: OwnerId,
    kind: AlignmentNodeKind,
    search: string | undefined,
    limit: number,
  ): Promise<Bounded<AlignmentNode & { readonly axisId?: UUID }>> {
    return this.#list(
      alignmentQuerySql.candidates[kind],
      [ownerId, titleSearchPattern(search)],
      limit,
      (row) => ({
        ...alignmentNode(kind, row),
        ...spread('axisId', optionalText(row, 'axis_id') as UUID | undefined),
      }),
    );
  }

  async listContainer(
    ownerId: OwnerId,
    scope: ReorderScope,
  ): Promise<readonly AlignmentContainerRow[]> {
    const sql = alignmentQuerySql.container;
    const bound = maxOrderedItems + 1;
    const [type, statement, parameters]: [EntityType, string, SqliteParameter[]] = (() => {
      switch (scope.container) {
        case 'axes':
          return ['axis', sql.axes, [ownerId, bound]];
        case 'axis_outcomes':
          return scope.axisId === null
            ? ['outcome', sql.unassignedOutcomes, [ownerId, bound]]
            : ['outcome', sql.axisOutcomes, [ownerId, scope.axisId, bound]];
        case 'axis_projects':
          return scope.axisId === null
            ? ['project', sql.unassignedProjects, [ownerId, bound]]
            : ['project', sql.axisProjects, [ownerId, scope.axisId, bound]];
        case 'outcome_milestones':
          return ['milestone', sql.outcomeMilestones, [ownerId, scope.outcomeId, bound]];
        case 'project_actions':
          return ['action', sql.projectActions, [ownerId, scope.projectId, bound]];
      }
    })();
    const rows = await this.driver.all<Values>(statement, parameters);
    return rows.map((row) => ({
      ref: { type, id: text(row, 'id') as UUID, ownerId },
      orderKey: text(row, 'sort_key'),
      localRevision: integer(row, 'local_revision'),
      state: text(row, 'state'),
    }));
  }

  async findLink(
    ownerId: OwnerId,
    relationship: AlignmentJoinRelationship,
    parentId: UUID,
    childId: UUID,
  ): Promise<CanonicalRecordState | null> {
    const row = await this.driver.get<Values>(alignmentQuerySql.findLink[relationship], [
      ownerId,
      parentId,
      childId,
    ]);
    if (row === undefined) return null;
    return this.#readLink(ownerId, relationship, text(row, 'id'));
  }

  async getArchiveImpact(
    ownerId: OwnerId,
    ref: EntityRef,
  ): Promise<Readonly<Partial<Record<AlignmentNodeKind, number>>>> {
    const statements =
      (
        alignmentQuerySql.archiveImpact as Partial<
          Record<EntityType, readonly { readonly kind: AlignmentNodeKind; readonly sql: string }[]>
        >
      )[ref.type] ?? [];
    const counts: Partial<Record<AlignmentNodeKind, number>> = {};
    for (const { kind, sql } of statements) {
      const amount = await this.#count(sql, [ownerId, ref.id]);
      if (amount > 0) counts[kind] = (counts[kind] ?? 0) + amount;
    }
    return counts;
  }

  async getDeleteImpact(ownerId: OwnerId, ref: EntityRef): Promise<DeleteImpactRecords> {
    const sql = alignmentQuerySql.deleteImpact;
    const target: SqliteParameter[] = [ownerId, ref.id];

    const optionalReferrers: {
      readonly record: CanonicalRecordState;
      readonly relationship: DeleteReferrerRelationship;
      readonly title?: string;
    }[] = [];
    const referrers: readonly ReferrerStatement[] =
      (sql.referrers as Partial<Record<EntityType, readonly ReferrerStatement[]>>)[ref.type] ?? [];
    for (const statement of referrers) {
      for (const row of await this.driver.all<Values>(statement.sql, target)) {
        const record = await this.#read(ownerId, statement.type, text(row, 'id'));
        if (record !== null) {
          optionalReferrers.push({
            record,
            relationship: statement.relationship,
            title: text(row, 'title'),
          });
        }
      }
    }

    const activeLinks: CanonicalRecordState[] = [];
    const inactiveLinks: CanonicalRecordState[] = [];
    const links: readonly LinkRowsStatement[] =
      (sql.links as Partial<Record<EntityType, readonly LinkRowsStatement[]>>)[ref.type] ?? [];
    for (const statement of links) {
      for (const row of await this.driver.all<Values>(statement.sql, target)) {
        const record = await this.#readLink(ownerId, statement.relationship, text(row, 'id'));
        if (record === null) continue;
        (record.document['unlinkedAt'] === undefined ? activeLinks : inactiveLinks).push(record);
      }
    }

    const placementSql = (sql.placements as Partial<Record<EntityType, string>>)[ref.type];
    const placements =
      placementSql === undefined
        ? []
        : await this.#readAll(ownerId, 'planning_placement', placementSql, target);
    const selections: CanonicalRecordState[] = [];
    for (const statement of (sql.selections as Partial<Record<EntityType, readonly string[]>>)[
      ref.type
    ] ?? []) {
      selections.push(...(await this.#readAll(ownerId, 'focus_selection', statement, target)));
    }
    const archived = (record: CanonicalRecordState) => record.document['archivedAt'] !== undefined;

    const requiredChildren =
      ref.type === 'outcome'
        ? await this.#list(sql.requiredChildren, target, maxLimit, (row) => ({
            id: text(row, 'id') as UUID,
            title: text(row, 'title'),
            archived: oneOf(row, 'state', milestoneStates) === 'archived',
          }))
        : { items: [], total: 0 };
    const reviews = await readReviewItemReferences(this.driver, ownerId, ref);

    return {
      optionalReferrers,
      activeLinks,
      inactiveLinks,
      activePlacements: placements.filter((record) => !archived(record)),
      archivedPlacements: placements.filter(archived),
      activeSelections: selections.filter((record) => !archived(record)),
      archivedSelections: selections.filter(archived),
      requiredChildren,
      reviewItems: reviews.items,
      reviewReferences: reviews.total,
      routineDefaultReferences:
        ref.type === 'project' ? await this.#count(sql.routineDefaults, target) : 0,
      pendingMutation:
        (await this.driver.get(sql.outboxPending, [ownerId, ref.type, ref.id])) !== undefined,
      openConflict:
        (await this.driver.get(sql.conflictOpen, [ownerId, ref.type, ref.id])) !== undefined,
    };
  }

  async listHistory(
    ownerId: OwnerId,
    ref: EntityRef,
    limit: number,
  ): Promise<readonly HistoryEntry[]> {
    const rows = await this.driver.all<Values>(alignmentQuerySql.history, [
      ownerId,
      ref.type,
      ref.id,
      clampLimit(limit),
    ]);
    return rows.map((row) => ({
      eventType: text(row, 'event_type'),
      occurredAt: text(row, 'occurred_at') as Instant,
    }));
  }

  /* ───────────────────────── Private helpers ───────────────────────── */

  async #list<Item>(
    statement: ListStatement,
    parameters: readonly SqliteParameter[],
    limit: number,
    map: (row: Values) => Item,
  ): Promise<Bounded<Item>> {
    // Sequential reads: the browser owns one SQLite worker connection.
    const rows = await this.driver.all<Values>(statement.items, [...parameters, clampLimit(limit)]);
    const total = await this.#count(statement.count, parameters);
    return { items: rows.map(map), total };
  }

  async #count(sql: string, parameters: readonly SqliteParameter[]): Promise<number> {
    const row = await this.driver.get<Values>(sql, parameters);
    return row === undefined ? 0 : integer(row, 'count');
  }

  #nodeRow(ownerId: OwnerId, kind: AlignmentNodeKind, id: UUID): Promise<Values | undefined> {
    return this.driver.get<Values>(alignmentQuerySql.node[kind], [ownerId, id]);
  }

  #read(ownerId: OwnerId, type: EntityType, id: string): Promise<CanonicalRecordState | null> {
    return this.#codecs.resolve(type).read(this.driver, { type, id: id as UUID, ownerId });
  }

  #readLink(
    ownerId: OwnerId,
    relationship: AlignmentJoinRelationship,
    id: string,
  ): Promise<CanonicalRecordState | null> {
    return this.#read(ownerId, alignmentLinkTables[relationship].entityType, id);
  }

  async #readAll(
    ownerId: OwnerId,
    type: EntityType,
    sql: string,
    parameters: readonly SqliteParameter[],
  ): Promise<CanonicalRecordState[]> {
    const records: CanonicalRecordState[] = [];
    for (const row of await this.driver.all<Values>(sql, parameters)) {
      const record = await this.#read(ownerId, type, text(row, 'id'));
      if (record !== null) records.push(record);
    }
    return records;
  }

  async #edges(
    ownerId: OwnerId,
    rule: AlignmentRelationshipRule,
    direction: 'up' | 'down',
    focus: Values,
    limit: number,
  ): Promise<{ readonly edges: readonly AlignmentEdge[]; readonly total: number }> {
    const focusId = text(focus, 'id');
    if (rule.storage === 'join') {
      const statement = linkedStatements[rule.relationship as AlignmentJoinRelationship][direction];
      const { items, total } = await this.#list(statement, [ownerId, focusId], limit, (row) =>
        edge(rule, direction, row),
      );
      return { edges: items, total };
    }
    if (direction === 'up') {
      const parentId = optionalText(focus, foreignKeyColumns[rule.foreignKey]);
      const parent =
        parentId === undefined
          ? undefined
          : await this.#nodeRow(ownerId, rule.parentKind, parentId as UUID);
      return parent === undefined
        ? { edges: [], total: 0 }
        : { edges: [edge(rule, 'up', parent)], total: 1 };
    }
    const { items, total } = await this.#list(
      childStatements[rule.relationship as ForeignKeyRelationship],
      [ownerId, focusId],
      limit,
      (row) => edge(rule, 'down', row),
    );
    return { edges: items, total };
  }

  /** Ancestry along required and primary links, Axis first; the focus itself is excluded. */
  async #chain(
    ownerId: OwnerId,
    kind: AlignmentNodeKind,
    row: Values,
    depth: number,
  ): Promise<AlignmentNode[]> {
    if (depth > 4) return [];
    const up = async (
      parentKind: AlignmentNodeKind,
      column: string,
    ): Promise<AlignmentNode[] | null> => {
      const parentId = optionalText(row, column);
      if (parentId === undefined) return null;
      const parent = await this.#nodeRow(ownerId, parentKind, parentId as UUID);
      if (parent === undefined) return null;
      return [
        ...(await this.#chain(ownerId, parentKind, parent, depth + 1)),
        alignmentNode(parentKind, parent),
      ];
    };
    switch (kind) {
      case 'axis':
        return [];
      case 'outcome':
      case 'routine':
        return (await up('axis', 'axis_id')) ?? [];
      case 'milestone':
        return (await up('outcome', 'outcome_id')) ?? [];
      case 'project':
        return (await up('outcome', 'primary_outcome_id')) ?? (await up('axis', 'axis_id')) ?? [];
      case 'action':
      case 'note':
        return (await up('project', 'project_id')) ?? (await up('axis', 'axis_id')) ?? [];
    }
  }
}
