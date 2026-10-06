import type {
  ActionSummary,
  BlockRow,
  Bounded,
  CanonicalRecordState,
  ConstraintRow,
  DateRangeInput,
  DayFocusRow,
  FocusActionRow,
  PlacementRow,
  PlacementTargetDocument,
  PlanProfile,
  RoutineRow,
  TodayQueryPort,
} from '@yelaxis/application';
import {
  dayBlockLookbackHours,
  parseCalendarDate,
  parseInstant,
  type CalendarDate,
  type Instant,
  type MaterializedOccurrenceSnapshot,
  type OwnerId,
  type RoutineState,
  type UUID,
} from '@yelaxis/domain';

import type { SqliteDriver, SqliteParameter } from '../sqlite/driver';
import { completePages } from './complete-pages';
import {
  actionColumns,
  actionSummary,
  blockRow,
  blockSelectColumns,
  blockTargetJoins,
  integer,
  listLimit,
  materializedOccurrence,
  noPlannedActionBlock,
  oneOf,
  optionalText,
  periodFrom,
  placementColumns,
  planningQuerySql,
  SqlitePlanningQueries,
  text,
  type Values,
} from './planning-queries';

/** Historical compatibility constant. Current overlap reads use indexed end/start bounds and
 * preserve long valid imported intervals without imposing a lookback duration.
 */
export const blockLookbackMs = dayBlockLookbackHours * 3_600_000;

/** A day holds at most three active focus rows (trg_focus_max_three_*); read a little more. */
const dayFocusRowLimit = 10;

const routineStates: readonly RoutineState[] = ['active', 'paused', 'archived'];

/** One active Action placement row (`p`) with its Action (`a`), shaped for `PlacementRow`. */
const actionPlacementColumns = `
  p.id, p.local_revision, p.horizon AS placement_horizon, p.period_key AS placement_period_key,
  p.period_start_date AS placement_start, p.period_end_date AS placement_end,
  p.week_start AS placement_week_start, p.sort_key, p.action_id, ${actionColumns}`;

/** The one active placement of Action `a`, through `uq_active_placement_action`. */
const activeActionPlacement = `
  LEFT JOIN planning_placements pl ON pl.owner_id = a.owner_id AND pl.action_id = a.id
    AND pl.archived_at IS NULL AND pl.deleted_at IS NULL`;

/** Active Week placements whose explicit stored interval contains the date. */
const weekPlacementFilter = `
  FROM planning_placements p INDEXED BY idx_placements_overlap_end
  JOIN actions a ON a.owner_id = p.owner_id AND a.id = p.action_id AND a.deleted_at IS NULL
  WHERE p.owner_id = ? AND p.horizon = 'week' AND p.period_start_date <= ? AND p.period_end_date >= ? AND p.action_id IS NOT NULL
    AND p.archived_at IS NULL AND p.deleted_at IS NULL AND a.state IN ('planned', 'in_progress')
    AND ${noPlannedActionBlock}`;

/** Active Week commitments whose explicit stored interval contains the date. */
const weekCommitmentSource = `
  FROM week_selections w INDEXED BY idx_week_selections_overlap_end
  JOIN actions a ON a.owner_id = w.owner_id AND a.id = w.action_id AND a.deleted_at IS NULL`;
const weekCommitmentWhere = `
  WHERE w.owner_id = ? AND w.period_start_date <= ?
    AND w.period_end_date >= ? AND w.action_id IS NOT NULL AND w.archived_at IS NULL
    AND w.deleted_at IS NULL AND a.state IN ('inbox', 'planned', 'scheduled', 'in_progress')`;

/** `routine_occurrences` columns the planning occurrence decoder reads, selected as `ro_<name>`. */
const occurrenceColumnNames = [
  'id',
  'routine_id',
  'generation',
  'logical_period_key',
  'occurrence_kind',
  'state',
  'target_count',
  'completed_count',
  'extra_completions_confirmed',
  'override_schema_version',
  'override_payload_json',
  'completed_at',
  'ordinal',
  'local_revision',
] as const;

const focusOccurrenceColumns = occurrenceColumnNames
  .map((name) => `ro.${name} AS ro_${name}`)
  .join(', ');

/**
 * Prepared, owner-scoped Today statements, exported so index use can be verified with
 * EXPLAIN. Each is bounded by a day, a week, or the three-item focus limit and searches a named
 * index; none scans history.
 */
export const todayQuerySql = Object.freeze({
  /** All blocks intersecting the day, including long imported intervals. Owner, end, start. */
  dayBlocks: planningQuerySql.listBlocks,
  /**
   * Active Day placements of non-archived Actions (any other state) on exactly one date.
   * Parameters: owner, date, date.
   */
  dayActionPlacements: `
    SELECT ${actionPlacementColumns}
    FROM planning_placements p INDEXED BY idx_placements_period
    JOIN actions a ON a.owner_id = p.owner_id AND a.id = p.action_id AND a.deleted_at IS NULL
    WHERE p.owner_id = ? AND p.horizon = 'day' AND p.period_start_date = ?
      AND p.period_end_date = ? AND p.action_id IS NOT NULL AND p.archived_at IS NULL
      AND p.deleted_at IS NULL AND a.state <> 'archived'
    ORDER BY p.sort_key ASC, p.id ASC
    LIMIT 1000;`,
  /** Parameters: owner, date, date, limit. */
  weekActionPlacements: `
    SELECT ${actionPlacementColumns} ${weekPlacementFilter}
    ORDER BY p.period_start_date ASC, p.period_end_date ASC, p.sort_key ASC, p.id ASC
    LIMIT ?;`,
  /** Parameters: owner, date, date. */
  countWeekActionPlacements: `SELECT COUNT(*) AS count ${weekPlacementFilter};`,
  /** Parameters: owner, date, date, limit. */
  weekCommitmentActions: `
    SELECT ${actionColumns}, ${placementColumns('pl')}
    ${weekCommitmentSource} ${activeActionPlacement} ${weekCommitmentWhere}
    ORDER BY w.period_start_date ASC, w.period_end_date ASC, w.sort_key ASC, w.id ASC
    LIMIT ?;`,
  /** Parameters: owner, date, date. */
  countWeekCommitmentActions: `
    SELECT COUNT(*) AS count ${weekCommitmentSource} ${weekCommitmentWhere};`,
  /**
   * Active focus rows of one profile and date with their Action (and its placement) or Routine
   * Occurrence and Routine. Rows whose target no longer exists are left out. Parameters: owner,
   * profile, date.
   */
  dayFocus: `
    SELECT f.id, f.local_revision, f.sort_key, f.local_date, f.action_id,
           f.routine_occurrence_id, ${actionColumns}, ${placementColumns('pl')},
           ${focusOccurrenceColumns}, r.title AS routine_title, r.state AS routine_state
    FROM focus_selections f INDEXED BY idx_focus_day_order
    LEFT JOIN actions a ON a.owner_id = f.owner_id AND a.id = f.action_id AND a.deleted_at IS NULL
    ${activeActionPlacement}
    LEFT JOIN routine_occurrences ro ON ro.owner_id = f.owner_id
      AND ro.id = f.routine_occurrence_id AND ro.deleted_at IS NULL
    LEFT JOIN routines r ON r.owner_id = ro.owner_id AND r.id = ro.routine_id
      AND r.deleted_at IS NULL
    WHERE f.owner_id = ? AND f.profile_id = ? AND f.local_date = ? AND f.archived_at IS NULL
      AND f.deleted_at IS NULL AND (a.id IS NOT NULL OR r.id IS NOT NULL)
    ORDER BY f.sort_key ASC, f.id ASC
    LIMIT ${String(dayFocusRowLimit)};`,
  /** One Action for Focus mode with its note and placement. Parameters: owner, Action. */
  focusAction: `
    SELECT ${actionColumns}, a.note_text AS action_note, ${placementColumns('pl')}
    FROM actions a ${activeActionPlacement}
    WHERE a.owner_id = ? AND a.id = ? AND a.deleted_at IS NULL;`,
  /** The Action's one current planned block, on any date. Parameters: owner, Action. */
  focusActionBlock: `
    SELECT ${blockSelectColumns}
    FROM time_blocks b INDEXED BY uq_time_blocks_one_planned_action ${blockTargetJoins}
    WHERE b.owner_id = ? AND b.action_id = ? AND b.state = 'planned' AND b.deleted_at IS NULL
      AND b.superseded_by_id IS NULL
    ORDER BY b.id ASC
    LIMIT 1;`,
});

/* ───────────────────────── Parameters and mappers ───────────────────────── */

function canonicalInstant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new RangeError('Today block bounds must be canonical UTC instants.');
  return parsed.value;
}

function calendarDate(value: string): CalendarDate {
  const parsed = parseCalendarDate(value);
  if (!parsed.ok) throw new RangeError('Choose a valid date.');
  return parsed.value;
}

/** Stored intervals can be longer than seven days after a valid import. */
function weekParameters(ownerId: OwnerId, date: CalendarDate): SqliteParameter[] {
  return [ownerId, date, date];
}

function placementRow(row: Values): PlacementRow {
  return {
    id: text(row, 'id') as UUID,
    localRevision: integer(row, 'local_revision'),
    period: periodFrom(row, 'placement'),
    orderKey: text(row, 'sort_key'),
    target: {
      kind: 'action',
      action: actionSummary(
        { ...row, placement_id: row['id'], placement_revision: row['local_revision'] },
        true,
      ),
    },
  };
}

/** The occurrence columns of a focus row, renamed back for the planning occurrence decoder. */
function focusOccurrence(row: Values): MaterializedOccurrenceSnapshot {
  return materializedOccurrence(
    Object.fromEntries(occurrenceColumnNames.map((name) => [name, row[`ro_${name}`]])),
  );
}

function dayFocusRow(row: Values): DayFocusRow {
  const base = {
    id: text(row, 'id') as UUID,
    localRevision: integer(row, 'local_revision'),
    orderKey: text(row, 'sort_key'),
    date: text(row, 'local_date') as CalendarDate,
  };
  if (optionalText(row, 'action_id') !== undefined)
    return { ...base, target: { kind: 'action', action: actionSummary(row, true) } };
  const occurrence = focusOccurrence(row);
  return {
    ...base,
    target: {
      kind: 'routine_occurrence',
      occurrenceId: occurrence.id,
      routineId: occurrence.routineId,
      routineTitle: text(row, 'routine_title'),
      routineState: oneOf(row, 'routine_state', routineStates),
      generation: occurrence.generation,
      period: occurrence.period,
      occurrenceRevision: occurrence.localRevision,
      state: occurrence.state,
    },
  };
}

function total(row: Values | undefined): number {
  return row === undefined ? 0 : integer(row, 'count');
}

/* ───────────────────────── Adapter ───────────────────────── */

/**
 * SQLite Today read model. Reads shared with Plan delegate to the planning statements;
 * Today's own statements are bounded by a day, a week, or the focus limit, so Today never walks
 * history . Nothing here writes or caches planning
 * content outside SQLite.
 */
export class SqliteTodayQueries implements TodayQueryPort {
  readonly #planning: SqlitePlanningQueries;

  constructor(private readonly driver: SqliteDriver) {
    this.#planning = new SqlitePlanningQueries(driver);
  }

  getPlanProfile(ownerId: OwnerId): Promise<PlanProfile> {
    return this.#planning.getPlanProfile(ownerId);
  }

  readRecord(
    ownerId: OwnerId,
    ref: CanonicalRecordState['ref'],
  ): Promise<CanonicalRecordState | null> {
    return this.#planning.readRecord(ownerId, ref);
  }

  listRoutines(
    ownerId: OwnerId,
    options: { readonly includeArchived: boolean },
  ): Promise<readonly RoutineRow[]> {
    return this.#planning.listRoutines(ownerId, options);
  }

  listMaterializedOccurrences(
    ownerId: OwnerId,
    range: DateRangeInput,
    routineId?: UUID,
  ): Promise<readonly MaterializedOccurrenceSnapshot[]> {
    return this.#planning.listMaterializedOccurrences(ownerId, range, routineId);
  }

  listCapacityConstraints(ownerId: OwnerId): Promise<readonly ConstraintRow[]> {
    return this.#planning.listCapacityConstraints(ownerId);
  }

  getActivePlacement(
    ownerId: OwnerId,
    kind: PlacementTargetDocument['kind'],
    targetId: UUID,
  ): Promise<CanonicalRecordState | null> {
    return this.#planning.getActivePlacement(ownerId, kind, targetId);
  }

  getPlannedActionBlock(ownerId: OwnerId, actionId: UUID): Promise<CanonicalRecordState | null> {
    return this.#planning.getPlannedActionBlock(ownerId, actionId);
  }

  async listDayBlocks(
    ownerId: OwnerId,
    bounds: { readonly startsAt: Instant; readonly endsAt: Instant },
  ): Promise<readonly BlockRow[]> {
    const startsAt = canonicalInstant(bounds.startsAt);
    const endsAt = canonicalInstant(bounds.endsAt);
    const rows = await completePages<Values>(
      this.driver,
      todayQuerySql.dayBlocks,
      [ownerId, endsAt, startsAt],
      [
        { column: 'b.starts_at_utc', result: 'starts_at_utc' },
        { column: 'b.ends_at_utc', result: 'ends_at_utc' },
        { column: 'b.id', result: 'id' },
      ],
    );
    return rows.map(blockRow);
  }

  async listDayActionPlacements(
    ownerId: OwnerId,
    date: CalendarDate,
  ): Promise<readonly PlacementRow[]> {
    const day = calendarDate(date);
    const rows = await completePages<Values>(
      this.driver,
      todayQuerySql.dayActionPlacements,
      [ownerId, day, day],
      [
        { column: 'p.sort_key', result: 'sort_key' },
        { column: 'p.id', result: 'id' },
      ],
    );
    return rows.map(placementRow);
  }

  async listWeekActionPlacements(
    ownerId: OwnerId,
    date: CalendarDate,
    limit: number,
  ): Promise<Bounded<PlacementRow>> {
    const parameters = weekParameters(ownerId, calendarDate(date));
    const rows = await this.driver.all<Values>(todayQuerySql.weekActionPlacements, [
      ...parameters,
      listLimit(limit),
    ]);
    const count = await this.driver.get<Values>(
      todayQuerySql.countWeekActionPlacements,
      parameters,
    );
    return { items: rows.map(placementRow), total: total(count) };
  }

  async listWeekCommitmentActions(
    ownerId: OwnerId,
    date: CalendarDate,
    limit: number,
  ): Promise<Bounded<ActionSummary>> {
    const parameters = weekParameters(ownerId, calendarDate(date));
    const rows = await this.driver.all<Values>(todayQuerySql.weekCommitmentActions, [
      ...parameters,
      listLimit(limit),
    ]);
    const count = await this.driver.get<Values>(
      todayQuerySql.countWeekCommitmentActions,
      parameters,
    );
    return { items: rows.map((row) => actionSummary(row, true)), total: total(count) };
  }

  async listDayFocus(
    ownerId: OwnerId,
    profileId: UUID,
    date: CalendarDate,
  ): Promise<readonly DayFocusRow[]> {
    const rows = await this.driver.all<Values>(todayQuerySql.dayFocus, [
      ownerId,
      profileId,
      calendarDate(date),
    ]);
    return rows.map(dayFocusRow);
  }

  async getFocusAction(ownerId: OwnerId, actionId: UUID): Promise<FocusActionRow | null> {
    const row = await this.driver.get<Values>(todayQuerySql.focusAction, [ownerId, actionId]);
    if (row === undefined) return null;
    const block = await this.driver.get<Values>(todayQuerySql.focusActionBlock, [
      ownerId,
      actionId,
    ]);
    const note = optionalText(row, 'action_note');
    return {
      ...actionSummary(row, true),
      ...(note === undefined ? {} : { note }),
      ...(block === undefined ? {} : { plannedBlock: blockRow(block) }),
    };
  }
}
