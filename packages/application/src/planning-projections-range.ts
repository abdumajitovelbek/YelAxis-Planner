/**
 * Shared read-model builder for Day, Week, and Month projections. It only reads through the
 * planning query port and applies pure domain rules; it never writes and never chooses anything.
 */
import {
  addDays,
  calculateDayCapacity,
  findScheduleConflicts,
  fixedIntervalDurationMinutes,
  intervalsIntersect,
  localDateOf,
  localDayBounds,
  localRangeBounds,
  localWallTimeOf,
  mergeAvailabilityWindows,
  projectRoutineOccurrences,
  rangesOverlap,
  weekdayOf,
  type ActionState,
  type AvailabilityWindow,
  type CalendarDate,
  type CapacityCap,
  type CapacityRules,
  type DateRange,
  type Instant,
  type OwnerId,
  type PlannedWork,
  type ProjectedOccurrence,
  type WallTime,
} from '@yelaxis/domain';

import type {
  ActionSummary,
  AvailabilityWindowView,
  BlockRow,
  ConflictView,
  ConstraintRow,
  DayColumn,
  OccurrenceEntry,
  PlacementRow,
  PlanProfile,
  PlanningQueryPort,
  RoutineRow,
  TimedEntry,
  TimedEntryKind,
} from './planning-contracts';
import { blockKey, occurrenceKey, routineSnapshot } from './planning-timed-items';

export const compareInstants = (left: Instant, right: Instant): number =>
  Date.parse(left) - Date.parse(right);

/** Code-point order for persisted order keys, with the id as a stable tie-breaker. */
export const compareOrder = (
  left: { readonly orderKey: string; readonly id: string },
  right: { readonly orderKey: string; readonly id: string },
): number => {
  if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
};

/** Build capacity rules from active availability windows and day/week caps. */
export function capacityRules(constraints: readonly ConstraintRow[]): CapacityRules {
  const windows: AvailabilityWindow[] = [];
  const caps: CapacityCap[] = [];
  for (const row of constraints) {
    if (row.document.state !== 'active') continue;
    const value = row.document.value;
    if (value.kind === 'availability') windows.push(...value.windows);
    else if (value.kind === 'capacity') caps.push({ period: value.period, minutes: value.minutes });
  }
  return { windows, caps };
}

const wallTimeFromMinutes = (minutes: number): WallTime =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(
    2,
    '0',
  )}` as WallTime;

export function availabilityFor(
  date: CalendarDate,
  rules: CapacityRules,
): readonly AvailabilityWindowView[] {
  const weekday = weekdayOf(date);
  return mergeAvailabilityWindows(rules.windows.filter((window) => window.weekday === weekday)).map(
    (window) => ({
      start: wallTimeFromMinutes(window.start),
      // End of day is stored and shown as 00:00 (never the invalid wall time 24:00).
      end: wallTimeFromMinutes(window.end >= 1440 ? 0 : window.end),
    }),
  );
}

export function occurrenceTimingView(
  timing: ProjectedOccurrence['timing'],
): OccurrenceEntry['timing'] {
  switch (timing.kind) {
    case 'flexible':
      return { kind: 'flexible' };
    case 'weekly_count':
      return { kind: 'weekly_count' };
    case 'timed':
      return { kind: 'timed', startsAt: timing.startsAt, endsAt: timing.endsAt };
    case 'dst_skipped':
      return { kind: 'dst_skipped', wallTime: timing.wallTime };
  }
}

export function occurrenceEntry(
  routine: Pick<RoutineRow, 'document'>,
  occurrence: ProjectedOccurrence,
): OccurrenceEntry {
  return {
    ref: {
      routineId: occurrence.routineId,
      routineTitle: routine.document.title,
      occurrenceId: occurrence.id,
      logicalKey: occurrence.logicalKey,
      generation: occurrence.generation,
      period: occurrence.period,
      materialized: occurrence.materialized,
      ...(occurrence.localRevision === undefined
        ? {}
        : { localRevision: occurrence.localRevision }),
    },
    state: occurrence.state,
    ...(occurrence.date === undefined ? {} : { date: occurrence.date }),
    moved: occurrence.moved,
    timing: occurrenceTimingView(occurrence.timing),
    ...(occurrence.targetCount === undefined ? {} : { targetCount: occurrence.targetCount }),
    ...(occurrence.completedCount === undefined
      ? {}
      : { completedCount: occurrence.completedCount }),
  };
}

const blockKind = (block: BlockRow): TimedEntryKind => {
  switch (block.target.kind) {
    case 'action':
      return 'action_block';
    case 'commitment':
      return 'commitment_block';
    case 'custom':
      return 'custom_block';
    case 'routine_occurrence':
      return 'occurrence_block';
  }
};

type EntryDraft = Omit<TimedEntry, 'conflictsWith'>;

function localFields(
  startsAt: Instant,
  endsAt: Instant,
  timeZone: TimedEntry['timeZone'],
  planningTimeZone: TimedEntry['timeZone'],
): Pick<TimedEntry, 'localDate' | 'localStart' | 'localEndDate' | 'localEnd' | 'durationMinutes'> {
  return {
    localDate: localDateOf(startsAt, planningTimeZone),
    localStart: localWallTimeOf(startsAt, planningTimeZone),
    localEndDate: localDateOf(endsAt, planningTimeZone),
    localEnd: localWallTimeOf(endsAt, planningTimeZone),
    durationMinutes: fixedIntervalDurationMinutes({ startsAt, endsAt, timeZone }),
  };
}

export interface ProjectedRoutineOccurrence {
  readonly routine: RoutineRow;
  readonly projected: ProjectedOccurrence;
  readonly entry: OccurrenceEntry;
}

export interface RangeSnapshot {
  readonly range: DateRange;
  readonly profile: PlanProfile;
  /** Timed items intersecting the range (blocks and timed occurrences), ordered by start. */
  readonly entries: readonly TimedEntry[];
  /** Every overlapping pair among planned timed items, listed once. */
  readonly conflicts: readonly ConflictView[];
  /** Dated occurrences without an exact interval (flexible or DST-skipped) inside the range. */
  readonly untimed: readonly ProjectedRoutineOccurrence[];
  /** Weekly-count occurrences whose week overlaps the range. */
  readonly weekly: readonly ProjectedRoutineOccurrence[];
  readonly placements: readonly PlacementRow[];
  readonly rules: CapacityRules;
  readonly work: readonly PlannedWork[];
}

/**
 * The reads a range snapshot needs. Today passes its own bounded day statements through this
 * shape (`listBlocks` and `listPlacements` for exactly one day).
 */
export type RangeSnapshotQueries = Pick<
  PlanningQueryPort,
  | 'listBlocks'
  | 'listPlacements'
  | 'listRoutines'
  | 'listMaterializedOccurrences'
  | 'listCapacityConstraints'
>;

/**
 * Assemble every timed item, occurrence, placement, and capacity rule for a local date range.
 * Queries run one at a time because the browser owns a single SQLite worker connection.
 */
export async function buildRangeSnapshot(
  queries: RangeSnapshotQueries,
  ownerId: OwnerId,
  profile: PlanProfile,
  range: DateRange,
): Promise<RangeSnapshot> {
  const zone = profile.planningTimeZone;
  const bounds = localRangeBounds(range, zone);
  const blocks = await queries.listBlocks(ownerId, bounds.startsAt, bounds.endsAt);
  const placements = await queries.listPlacements(ownerId, range);
  const routines = await queries.listRoutines(ownerId, { includeArchived: false });
  // Occurrence dates are local; widen by a day so a cross-midnight occurrence is not hidden.
  const widened = { start: addDays(range.start, -1), end: addDays(range.end, 1) };
  const materialized =
    routines.length === 0 ? [] : await queries.listMaterializedOccurrences(ownerId, widened);
  const constraints = await queries.listCapacityConstraints(ownerId);
  const rules = capacityRules(constraints);

  const drafts: EntryDraft[] = blocks
    .filter((block) => intervalsIntersect(block, bounds))
    .map((block) => ({
      key: blockKey(block.id),
      kind: blockKind(block),
      title: block.target.title,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      timeZone: block.timeZone,
      ...localFields(block.startsAt, block.endsAt, block.timeZone, zone),
      state: block.state,
      overlapAcknowledged: block.overlapAcknowledged,
      block,
    }));
  const untimed: ProjectedRoutineOccurrence[] = [];
  const weekly: ProjectedRoutineOccurrence[] = [];
  for (const routine of routines) {
    const projected = projectRoutineOccurrences({
      series: routineSnapshot(routine),
      materialized: materialized.filter((row) => row.routineId === routine.id),
      window: widened,
      planningTimeZone: zone,
    });
    if (!projected.ok) continue;
    for (const occurrence of projected.value) {
      const entry = occurrenceEntry(routine, occurrence);
      const timing = occurrence.timing;
      if (timing.kind === 'timed') {
        if (!intervalsIntersect(timing, bounds)) continue;
        drafts.push({
          key: occurrenceKey(occurrence.id),
          kind: 'routine_occurrence',
          title: routine.document.title,
          startsAt: timing.startsAt,
          endsAt: timing.endsAt,
          timeZone: timing.timeZone,
          ...localFields(timing.startsAt, timing.endsAt, timing.timeZone, zone),
          state: occurrence.state,
          overlapAcknowledged: occurrence.overlapAcknowledged,
          occurrence: entry,
        });
      } else if (timing.kind === 'weekly_count') {
        if (occurrence.period.kind === 'week' && rangesOverlap(occurrence.period, range))
          weekly.push({ routine, projected: occurrence, entry });
      } else if (
        occurrence.date !== undefined &&
        occurrence.date >= range.start &&
        occurrence.date <= range.end
      ) {
        untimed.push({ routine, projected: occurrence, entry });
      }
    }
  }
  drafts.sort(
    (left, right) =>
      compareInstants(left.startsAt, right.startsAt) ||
      compareInstants(left.endsAt, right.endsAt) ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );

  const found = findScheduleConflicts(
    drafts
      .filter((draft) => draft.state === 'planned')
      .map(({ key, startsAt, endsAt, overlapAcknowledged }) => ({
        key,
        startsAt,
        endsAt,
        overlapAcknowledged,
      })),
  );
  const conflictKeys = new Map<string, string[]>();
  for (const conflict of found) {
    conflictKeys.set(conflict.firstKey, [
      ...(conflictKeys.get(conflict.firstKey) ?? []),
      conflict.secondKey,
    ]);
    conflictKeys.set(conflict.secondKey, [
      ...(conflictKeys.get(conflict.secondKey) ?? []),
      conflict.firstKey,
    ]);
  }
  const entries: TimedEntry[] = drafts.map((draft) => ({
    ...draft,
    conflictsWith: conflictKeys.get(draft.key) ?? [],
  }));
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const conflicts: ConflictView[] = found.flatMap((conflict) => {
    const first = byKey.get(conflict.firstKey);
    const second = byKey.get(conflict.secondKey);
    return first === undefined || second === undefined ? [] : [{ ...conflict, first, second }];
  });
  const work: PlannedWork[] = entries.map(({ startsAt, endsAt, state }) => ({
    startsAt,
    endsAt,
    state,
  }));
  return { range, profile, entries, conflicts, untimed, weekly, placements, rules, work };
}

export type ActionPlacementRow = PlacementRow & {
  readonly target: Extract<PlacementRow['target'], { readonly kind: 'action' }>;
};

const hiddenFromDay = new Set<ActionState>(['scheduled', 'canceled', 'archived']);

/** An Action summary carrying the placement it was listed through. */
export function placedAction(row: ActionPlacementRow): ActionSummary {
  const action = row.target.action;
  return action.placement === undefined
    ? { ...action, placement: { id: row.id, localRevision: row.localRevision, period: row.period } }
    : action;
}

export const isActionPlacement = (row: PlacementRow): row is ActionPlacementRow =>
  row.target.kind === 'action';

/** One local day: timed items intersecting it, flexible work placed on it, and its capacity. */
export function dayColumn(snapshot: RangeSnapshot, date: CalendarDate): DayColumn {
  const zone = snapshot.profile.planningTimeZone;
  const bounds = localDayBounds(date, zone);
  return {
    date,
    weekday: weekdayOf(date),
    capacity: calculateDayCapacity(date, snapshot.work, snapshot.rules, zone),
    availability: availabilityFor(date, snapshot.rules),
    timed: snapshot.entries.filter((entry) => intervalsIntersect(entry, bounds)),
    flexibleActions: snapshot.placements
      .filter(isActionPlacement)
      .filter(
        (row) =>
          row.period.kind === 'day' &&
          row.period.date === date &&
          !hiddenFromDay.has(row.target.action.state),
      )
      .sort(compareOrder)
      .map(placedAction),
    flexibleOccurrences: snapshot.untimed
      .filter((item) => item.projected.date === date)
      .map((item) => item.entry),
  };
}

/** Conflicts whose overlapping interval touches the given local date range. */
export function conflictsWithin(
  conflicts: readonly ConflictView[],
  range: DateRange,
  zone: PlanProfile['planningTimeZone'],
): readonly ConflictView[] {
  const bounds = localRangeBounds(range, zone);
  return conflicts.filter((conflict) =>
    intervalsIntersect(
      { startsAt: conflict.overlapStartsAt, endsAt: conflict.overlapEndsAt },
      bounds,
    ),
  );
}
