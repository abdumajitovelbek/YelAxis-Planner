/**
 * Shared Today and Focus day reads: one day's snapshot through Today's bounded statements, its flexible
 * membership, its focus items, and the focus candidates in plan order. Read only:
 * nothing here writes, ranks, or preselects.
 */
import {
  compareOrder,
  focusTargetKey,
  isFocusableActionState,
  isOccurrenceOnDate,
  type ActionState,
  type CalendarDate,
  type FocusTargetKey,
  type UUID,
} from '@yelaxis/domain';

import type {
  ActionSummary,
  BlockRow,
  ConflictView,
  DayColumn,
  OccurrenceEntry,
} from './planning-contracts';
import {
  buildRangeSnapshot,
  conflictsWithin,
  dayColumn,
  isActionPlacement,
  placedAction,
  type ActionPlacementRow,
  type RangeSnapshot,
  type RangeSnapshotQueries,
} from './planning-projections-range';
import type {
  DayFocusRow,
  FocusActionRow,
  FocusActionTiming,
  FocusCandidate,
  FocusChoices,
  FocusItemView,
  TodayQueryPort,
} from './today-contracts';
import type { TodayKit, TodaySession } from './today-kit';

/** At most this many Week-placed and Week-commitment Actions are offered as focus candidates. */
export const focusWeekCandidateLimit = 50;

const openFlexibleStates: readonly ActionState[] = ['planned', 'in_progress'];

/** Everything Today and End Day read about one planning date. */
export interface LoadedDay {
  readonly date: CalendarDate;
  readonly snapshot: RangeSnapshot;
  /** The planning day column: timed entries, capacity, and availability for the date. */
  readonly column: DayColumn;
  /** Overlaps whose overlapping interval touches the date. */
  readonly conflicts: readonly ConflictView[];
  /** Planned Action blocks intersecting the date, by Action id. */
  readonly plannedActionBlocks: ReadonlyMap<UUID, BlockRow>;
  /** Actions with a planned, completed, or skipped current block intersecting the date. */
  readonly timedActionIds: ReadonlySet<UUID>;
  /** Day-placed planned or in-progress Actions with no block on the date, in placement order. */
  readonly openFlexible: readonly ActionPlacementRow[];
  /** Day-placed completed Actions with no block on the date, in placement order. */
  readonly doneFlexible: readonly ActionPlacementRow[];
  /**
   * Every dated Routine Occurrence on the date (timed and untimed, any state), in projection order:
   * untimed first, then timed by start.
   */
  readonly dayOccurrences: readonly OccurrenceEntry[];
  /** Weekly-count occurrences whose week contains the date. */
  readonly weekOccurrences: readonly OccurrenceEntry[];
  /** The date's active focus rows in (order key, id) order. */
  readonly focusRows: readonly DayFocusRow[];
  readonly focus: readonly FocusItemView[];
}

/**
 * The range-snapshot reads mapped onto Today's bounded statements. It serves exactly one date:
 * blocks through `listDayBlocks` (48-hour lookback) and placements through
 * `listDayActionPlacements`.
 */
function daySnapshotQueries(queries: TodayQueryPort, date: CalendarDate): RangeSnapshotQueries {
  return {
    listBlocks: (ownerId, startsAt, endsAt) => queries.listDayBlocks(ownerId, { startsAt, endsAt }),
    listPlacements: (ownerId, range) => {
      if (range.start !== date || range.end !== date)
        return Promise.reject(new RangeError('Today reads exactly one day.'));
      return queries.listDayActionPlacements(ownerId, date);
    },
    listRoutines: (ownerId, options) => queries.listRoutines(ownerId, options),
    listMaterializedOccurrences: (ownerId, range, routineId) =>
      routineId === undefined
        ? queries.listMaterializedOccurrences(ownerId, range)
        : queries.listMaterializedOccurrences(ownerId, range, routineId),
    listCapacityConstraints: (ownerId) => queries.listCapacityConstraints(ownerId),
  };
}

const timingStart = (entry: OccurrenceEntry): string =>
  entry.timing.kind === 'timed' ? entry.timing.startsAt : '';

/** The domain's projection order: timing start (untimed first), then logical key. */
const compareOccurrences = (left: OccurrenceEntry, right: OccurrenceEntry): number =>
  timingStart(left).localeCompare(timingStart(right)) ||
  left.ref.logicalKey.localeCompare(right.ref.logicalKey);

/** The focus target key of a stored focus row. */
export function focusRowKey(row: DayFocusRow): FocusTargetKey {
  return row.target.kind === 'action'
    ? focusTargetKey({ kind: 'action', actionId: row.target.action.id })
    : focusTargetKey({ kind: 'routine_occurrence', occurrenceId: row.target.occurrenceId });
}

type TargetFields = Pick<FocusItemView, 'key' | 'target'>;

/** Key and command input of an Action focus target. */
export function actionFocusTarget(actionId: UUID): TargetFields {
  return {
    key: focusTargetKey({ kind: 'action', actionId }),
    target: { kind: 'action', actionId },
  };
}

/** Key and command input of a projected Routine Occurrence (its revision once materialized). */
export function occurrenceFocusTarget(entry: OccurrenceEntry): TargetFields {
  const ref = entry.ref;
  return {
    key: focusTargetKey({ kind: 'routine_occurrence', occurrenceId: ref.occurrenceId }),
    target: {
      kind: 'routine_occurrence',
      occurrence: {
        routineId: ref.routineId,
        generation: ref.generation,
        period: ref.period,
        ...(ref.materialized && ref.localRevision !== undefined
          ? { revision: ref.localRevision }
          : {}),
      },
    },
  };
}

/** Key and command input of a stored focus row, whatever its target's state now. */
export function focusRowTarget(row: DayFocusRow): TargetFields {
  if (row.target.kind === 'action') return actionFocusTarget(row.target.action.id);
  return {
    key: focusRowKey(row),
    target: {
      kind: 'routine_occurrence',
      occurrence: {
        routineId: row.target.routineId,
        generation: row.target.generation,
        period: row.target.period,
        revision: row.target.occurrenceRevision,
      },
    },
  };
}

function actionTiming(
  action: ActionSummary,
  plannedActionBlocks: ReadonlyMap<UUID, BlockRow>,
  dayPlacedActionIds: ReadonlySet<UUID>,
): FocusActionTiming {
  if (!isFocusableActionState(action.state)) return { kind: 'elsewhere' };
  const block = plannedActionBlocks.get(action.id);
  if (block !== undefined) return { kind: 'scheduled', block };
  return dayPlacedActionIds.has(action.id) ? { kind: 'flexible' } : { kind: 'elsewhere' };
}

/**
 * Read one date through Today's bounded statements: timeline, flexible membership, Routine
 * Occurrences, and focus. Queries run one at a time (one SQLite worker connection).
 */
export async function loadDay(
  kit: TodayKit,
  session: TodaySession,
  date: CalendarDate,
): Promise<LoadedDay> {
  const { ownerId, profile } = session;
  const snapshot = await buildRangeSnapshot(
    daySnapshotQueries(kit.queries, date),
    ownerId,
    profile,
    { start: date, end: date },
  );
  const focusRows = [...(await kit.queries.listDayFocus(ownerId, profile.profileId, date))].sort(
    compareOrder,
  );
  const column = dayColumn(snapshot, date);

  const plannedActionBlocks = new Map<UUID, BlockRow>();
  const timedActionIds = new Set<UUID>();
  for (const entry of snapshot.entries) {
    const block = entry.block;
    if (block?.target.kind !== 'action') continue;
    timedActionIds.add(block.target.actionId);
    if (block.state === 'planned') plannedActionBlocks.set(block.target.actionId, block);
  }

  const dayPlaced = snapshot.placements
    .filter(isActionPlacement)
    .filter((row) => row.period.kind === 'day' && row.period.date === date)
    .sort(compareOrder);
  const flexible = dayPlaced.filter((row) => !timedActionIds.has(row.target.action.id));
  const dayPlacedActionIds = new Set(dayPlaced.map((row) => row.target.action.id));

  const dayOccurrences = [
    ...snapshot.untimed.filter((item) => item.projected.date === date).map((item) => item.entry),
    ...snapshot.entries.flatMap((entry) =>
      entry.occurrence !== undefined && entry.occurrence.date === date ? [entry.occurrence] : [],
    ),
  ].sort(compareOccurrences);
  const weekOccurrences = snapshot.weekly
    .filter((item) => isOccurrenceOnDate(item.projected, date))
    .map((item) => item.entry);
  const occurrencesById = new Map(
    [...dayOccurrences, ...weekOccurrences].map((entry) => [entry.ref.occurrenceId, entry]),
  );

  const focus = focusRows.map((row, index): FocusItemView => {
    const base = {
      ...focusRowTarget(row),
      selectionId: row.id,
      localRevision: row.localRevision,
      orderKey: row.orderKey,
      position: index + 1,
    };
    if (row.target.kind === 'action')
      return {
        ...base,
        kind: 'action',
        action: row.target.action,
        timing: actionTiming(row.target.action, plannedActionBlocks, dayPlacedActionIds),
      };
    return {
      ...base,
      kind: 'routine_occurrence',
      occurrenceId: row.target.occurrenceId,
      routineId: row.target.routineId,
      routineTitle: row.target.routineTitle,
      routineState: row.target.routineState,
      occurrence:
        row.target.routineState === 'archived'
          ? null
          : (occurrencesById.get(row.target.occurrenceId) ?? null),
    };
  });

  return {
    date,
    snapshot,
    column,
    conflicts: conflictsWithin(
      snapshot.conflicts,
      { start: date, end: date },
      profile.planningTimeZone,
    ),
    plannedActionBlocks,
    timedActionIds,
    openFlexible: flexible.filter((row) => openFlexibleStates.includes(row.target.action.state)),
    doneFlexible: flexible.filter((row) => row.target.action.state === 'completed'),
    dayOccurrences,
    weekOccurrences,
    focusRows,
    focus,
  };
}

/**
 * Focus candidates for a loaded day, in plan order and never ranked: the day's
 * scheduled Actions (by start), its open flexible Actions (placement order), its planned Routine
 * Occurrences and this week's counts, then this week's Week-placed and Week-commitment Actions (at
 * most 50). Each Action appears once, finished items are left out, and only items already in the
 * day's focus are marked selected.
 */
export async function loadFocusChoices(
  kit: TodayKit,
  session: TodaySession,
  day: LoadedDay,
): Promise<FocusChoices> {
  const { ownerId, profile, today } = session;
  const selected = new Set<string>(day.focusRows.map(focusRowKey));
  const seen = new Set<UUID>();
  const candidates: FocusCandidate[] = [];
  const addAction = (
    source: 'scheduled' | 'flexible' | 'week',
    action: ActionSummary,
    block?: BlockRow,
  ): void => {
    if (seen.has(action.id) || !isFocusableActionState(action.state)) return;
    seen.add(action.id);
    const target = actionFocusTarget(action.id);
    candidates.push({
      ...target,
      kind: 'action',
      source,
      action,
      ...(block === undefined ? {} : { block }),
      selected: selected.has(target.key),
    });
  };

  const dayPlacedActions = new Map(
    day.snapshot.placements
      .filter(isActionPlacement)
      .map((row) => [row.target.action.id, placedAction(row)] as const),
  );
  for (const entry of day.column.timed) {
    const block = entry.block;
    if (block?.target.kind !== 'action' || block.state !== 'planned') continue;
    if (seen.has(block.target.actionId)) continue;
    // A block that began the day before has its Day placement on that day: read the Action.
    const placed = dayPlacedActions.get(block.target.actionId);
    const row =
      placed === undefined
        ? await kit.queries.getFocusAction(ownerId, block.target.actionId)
        : null;
    const action = placed ?? (row === null ? undefined : summaryOf(row));
    if (action !== undefined) addAction('scheduled', action, block);
  }
  for (const row of day.openFlexible) addAction('flexible', placedAction(row));
  for (const occurrence of [...day.dayOccurrences, ...day.weekOccurrences]) {
    if (occurrence.state !== 'planned') continue;
    const target = occurrenceFocusTarget(occurrence);
    candidates.push({
      ...target,
      kind: 'routine_occurrence',
      source: 'routine',
      occurrence,
      selected: selected.has(target.key),
    });
  }

  const weekPlaced = await kit.queries.listWeekActionPlacements(
    ownerId,
    day.date,
    focusWeekCandidateLimit,
  );
  const weekCommitted = await kit.queries.listWeekCommitmentActions(
    ownerId,
    day.date,
    focusWeekCandidateLimit,
  );
  const unseen =
    weekPlaced.total - weekPlaced.items.length + (weekCommitted.total - weekCommitted.items.length);
  const weekActions = [
    ...weekPlaced.items.filter(isActionPlacement).map(placedAction),
    ...weekCommitted.items,
  ];
  let weekCount = 0;
  for (const action of weekActions) {
    if (seen.has(action.id) || !isFocusableActionState(action.state)) continue;
    weekCount += 1;
    if (weekCount <= focusWeekCandidateLimit) addAction('week', action);
    else seen.add(action.id);
  }

  return {
    profile,
    date: day.date,
    editable: day.date >= today,
    current: day.focus,
    candidates,
    weekTotal: weekCount + unseen,
  };
}

/** The plain Action summary of a Focus mode row (a candidate never carries the note). */
export function summaryOf(row: FocusActionRow): ActionSummary {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    localRevision: row.localRevision,
    orderKey: row.orderKey,
    ...(row.estimateMinutes === undefined ? {} : { estimateMinutes: row.estimateMinutes }),
    ...(row.energy === undefined ? {} : { energy: row.energy }),
    ...(row.priority === undefined ? {} : { priority: row.priority }),
    ...(row.due === undefined ? {} : { due: row.due }),
    ...(row.axisTitle === undefined ? {} : { axisTitle: row.axisTitle }),
    ...(row.projectTitle === undefined ? {} : { projectTitle: row.projectTitle }),
    ...(row.placement === undefined ? {} : { placement: row.placement }),
  };
}
