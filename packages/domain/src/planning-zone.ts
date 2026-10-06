/**
 * Planning-zone change preview (time-horizon-recurrence "Planning time zone").
 *
 * A device-zone change never changes the Profile silently. Before the user chooses to change the
 * planning zone, this pure projection shows what would move: `follow_profile` time-specific
 * Routines keep their wall time in the new zone, so their instants move; `fixed_zone` Routines keep
 * their instants, so their local time in the new zone may differ. Day-flexible and weekly-count
 * Routines keep their dates. Completed or skipped occurrences are history and are never listed.
 */
import { ok, type DomainResult, type EntityId, type Instant } from './contracts.js';
import type { RoutineZonePolicy } from './entities.js';
import type { DateRange } from './horizons.js';
import {
  currentGeneration,
  projectRoutineOccurrences,
  type MaterializedOccurrenceSnapshot,
  type ProjectedOccurrence,
  type RoutineSeriesSnapshot,
} from './routines.js';
import {
  formatInstantInZone,
  type CalendarDate,
  type IanaTimeZone,
  type WallTime,
} from './time.js';

export interface PlanningZoneChangeRoutineInput {
  readonly title: string;
  readonly series: RoutineSeriesSnapshot;
}

export interface PlanningZoneChangeInput {
  readonly routines: readonly PlanningZoneChangeRoutineInput[];
  readonly materialized: readonly MaterializedOccurrenceSnapshot[];
  readonly from: IanaTimeZone;
  readonly to: IanaTimeZone;
  /** Upcoming local dates to examine (inclusive). */
  readonly window: DateRange;
  /** Upcoming timed occurrences listed per Routine; defaults to 3. */
  readonly occurrencesPerRoutine?: number;
  /** Occurrences that started before this instant (in the current zone) are not upcoming. */
  readonly notBefore?: Instant;
}

/** One occurrence time read in the new planning zone. */
export type PlanningZoneOccurrenceTime =
  | {
      readonly kind: 'timed';
      readonly startsAt: Instant;
      /** Wall time and zone the Routine itself resolves in. */
      readonly wallTime: WallTime;
      readonly timeZone: IanaTimeZone;
      /** Local date and start time of `startsAt` in the new planning zone. */
      readonly localDate: CalendarDate;
      readonly localTime: WallTime;
    }
  | { readonly kind: 'dst_skipped'; readonly wallTime: WallTime; readonly timeZone: IanaTimeZone };

export interface PlanningZoneChangeOccurrence {
  /** Effective local date of the occurrence. */
  readonly date: CalendarDate;
  readonly before: PlanningZoneOccurrenceTime;
  readonly after: PlanningZoneOccurrenceTime;
  /** True when the exact instant differs between the current and the new planning zone. */
  readonly instantChanges: boolean;
}

export interface PlanningZoneChangeRoutine {
  readonly routineId: EntityId;
  readonly title: string;
  /**
   * The current generation's zone policy. A day-flexible Routine listed only because one
   * occurrence was given a time reads that time in the planning zone (`follow_profile`).
   */
  readonly policy: RoutineZonePolicy;
  readonly occurrences: readonly PlanningZoneChangeOccurrence[];
}

export interface PlanningZoneChangePreviewModel {
  readonly from: IanaTimeZone;
  readonly to: IanaTimeZone;
  readonly window: DateRange;
  /** Routines with at least one upcoming planned timed occurrence in the window. */
  readonly routines: readonly PlanningZoneChangeRoutine[];
  /** Non-archived Routines not listed above: their occurrences keep their dates. */
  readonly dateOnlyRoutineCount: number;
}

const readTime = (
  occurrence: ProjectedOccurrence,
  to: IanaTimeZone,
): PlanningZoneOccurrenceTime | null => {
  const { timing } = occurrence;
  if (timing.kind === 'dst_skipped')
    return { kind: 'dst_skipped', wallTime: timing.wallTime, timeZone: timing.timeZone };
  if (timing.kind !== 'timed') return null;
  const local = formatInstantInZone(timing.startsAt, to);
  return {
    kind: 'timed',
    startsAt: timing.startsAt,
    wallTime: timing.wallTime,
    timeZone: timing.timeZone,
    localDate: local.date,
    localTime: local.time,
  };
};

const sameInstant = (
  left: PlanningZoneOccurrenceTime,
  right: PlanningZoneOccurrenceTime,
): boolean =>
  left.kind === 'timed' && right.kind === 'timed'
    ? left.startsAt === right.startsAt
    : left.kind === right.kind;

/**
 * Preview a planning-zone change for upcoming Routine Occurrences. Pure: it projects each Routine
 * in the current and the new zone and compares the results; nothing is written or chosen.
 */
export const previewPlanningZoneChange = (
  input: PlanningZoneChangeInput,
): DomainResult<PlanningZoneChangePreviewModel> => {
  const limit = Math.max(1, input.occurrencesPerRoutine ?? 3);
  const routines: PlanningZoneChangeRoutine[] = [];
  let dateOnlyRoutineCount = 0;
  for (const routine of input.routines) {
    if (routine.series.state === 'archived') continue;
    const project = (planningTimeZone: IanaTimeZone) =>
      projectRoutineOccurrences({
        series: routine.series,
        materialized: input.materialized,
        window: input.window,
        planningTimeZone,
      });
    const before = project(input.from);
    if (!before.ok) return before;
    const after = project(input.to);
    if (!after.ok) return after;
    const afterByKey = new Map(after.value.map((item) => [item.logicalKey, item]));
    const occurrences: PlanningZoneChangeOccurrence[] = [];
    for (const occurrence of before.value) {
      if (occurrences.length >= limit) break;
      // Completed and skipped occurrences are history; they never change.
      if (occurrence.state !== 'planned' || occurrence.date === undefined) continue;
      const counterpart = afterByKey.get(occurrence.logicalKey);
      if (counterpart === undefined) continue;
      const beforeTime = readTime(occurrence, input.to);
      const afterTime = readTime(counterpart, input.to);
      if (beforeTime === null || afterTime === null) continue;
      if (
        input.notBefore !== undefined &&
        beforeTime.kind === 'timed' &&
        beforeTime.startsAt < input.notBefore
      )
        continue;
      occurrences.push({
        date: occurrence.date,
        before: beforeTime,
        after: afterTime,
        instantChanges: !sameInstant(beforeTime, afterTime),
      });
    }
    if (occurrences.length === 0) {
      dateOnlyRoutineCount += 1;
      continue;
    }
    const mode = currentGeneration(routine.series).schedulingMode;
    routines.push({
      routineId: routine.series.id,
      title: routine.title,
      policy: mode.kind === 'time_specific' ? mode.zonePolicy : { kind: 'follow_profile' },
      occurrences,
    });
  }
  return ok({
    from: input.from,
    to: input.to,
    window: input.window,
    routines,
    dateOnlyRoutineCount,
  });
};
