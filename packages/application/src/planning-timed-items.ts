import {
  addDays,
  createEntityRef,
  err,
  findScheduleConflicts,
  localDateOf,
  occurrenceLogicalKey,
  occurrencePeriodKey,
  ok,
  parseUUID,
  projectRoutineOccurrences,
  routineOccurrenceId,
  type DomainResult,
  type EntityRef,
  type GeneratedOccurrencePeriod,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type ProjectedOccurrence,
  type RoutineSeriesSnapshot,
  type TimedPlanItem,
} from '@yelaxis/domain';

import type { CanonicalRecordState } from './contracts';
import type {
  BlockRow,
  OccurrenceTargetInput,
  PlanningQueryPort,
  RoutineDocument,
  RoutineOccurrenceDocument,
  RoutineRow,
} from './planning-contracts';
import type { PlanningRecordReader } from './ports';

export const blockKey = (id: string): string => `block:${id}`;
export const occurrenceKey = (occurrenceId: string): string => `occurrence:${occurrenceId}`;

export const routineSnapshot = (
  row: Pick<RoutineRow, 'id' | 'document'>,
): RoutineSeriesSnapshot => ({
  id: row.id,
  state: row.document.state,
  ...(row.document.pauseEffectiveOn === undefined
    ? {}
    : { pauseEffectiveOn: row.document.pauseEffectiveOn }),
  generations: row.document.generations,
});

export interface TimedCandidate extends TimedPlanItem {
  readonly title: string;
  readonly block?: BlockRow;
  readonly occurrence?: { readonly routine: RoutineRow; readonly projected: ProjectedOccurrence };
}

/**
 * Every planned item with an exact interval intersecting `[startsAt, endsAt)`: planned blocks plus
 * timed Routine Occurrences (time-specific, or given a time by a This-occurrence edit).
 */
export async function collectPlannedTimedItems(
  queries: PlanningQueryPort,
  ownerId: OwnerId,
  planningTimeZone: IanaTimeZone,
  startsAt: Instant,
  endsAt: Instant,
): Promise<readonly TimedCandidate[]> {
  const blocks = await queries.listBlocks(ownerId, startsAt, endsAt);
  const output: TimedCandidate[] = blocks
    .filter((block) => block.state === 'planned')
    .map((block) => ({
      key: blockKey(block.id),
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      overlapAcknowledged: block.overlapAcknowledged,
      title: block.target.title,
      block,
    }));
  // Occurrence dates are local; widen by a day on each side so zone offsets cannot hide one.
  const range = {
    start: addDays(localDateOf(startsAt, planningTimeZone), -1),
    end: addDays(localDateOf(endsAt, planningTimeZone), 1),
  };
  const routines = await queries.listRoutines(ownerId, { includeArchived: false });
  if (routines.length === 0) return output;
  const materialized = await queries.listMaterializedOccurrences(ownerId, range);
  for (const routine of routines) {
    const projected = projectRoutineOccurrences({
      series: routineSnapshot(routine),
      materialized: materialized.filter((row) => row.routineId === routine.id),
      window: range,
      planningTimeZone,
    });
    if (!projected.ok) continue;
    for (const occurrence of projected.value) {
      if (occurrence.state !== 'planned' || occurrence.timing.kind !== 'timed') continue;
      if (occurrence.timing.endsAt <= startsAt || occurrence.timing.startsAt >= endsAt) continue;
      output.push({
        key: occurrenceKey(occurrence.id),
        startsAt: occurrence.timing.startsAt,
        endsAt: occurrence.timing.endsAt,
        overlapAcknowledged: occurrence.overlapAcknowledged,
        title: routine.document.title,
        occurrence: { routine, projected: occurrence },
      });
    }
  }
  return output;
}

/** Planned items that a proposed interval would overlap, excluding the given keys. */
export function overlapsFor(
  candidates: readonly TimedCandidate[],
  interval: { readonly startsAt: Instant; readonly endsAt: Instant },
  excludeKeys: readonly string[] = [],
): readonly TimedCandidate[] {
  const proposalKey = '__proposal__';
  const conflicts = findScheduleConflicts([
    ...candidates.filter((candidate) => !excludeKeys.includes(candidate.key)),
    { key: proposalKey, ...interval, overlapAcknowledged: false },
  ]);
  const keys = new Set(
    conflicts
      .filter((conflict) => conflict.firstKey === proposalKey || conflict.secondKey === proposalKey)
      .map((conflict) =>
        conflict.firstKey === proposalKey ? conflict.secondKey : conflict.firstKey,
      ),
  );
  return candidates.filter((candidate) => keys.has(candidate.key));
}

export interface OccurrenceWorkspace {
  readonly ref: EntityRef<'routine_occurrence'>;
  readonly routineRef: EntityRef<'routine'>;
  /** Present when the occurrence is already materialized. */
  readonly record: CanonicalRecordState | null;
  /** Current materialized document, or a fresh planned document for an unmaterialized occurrence. */
  readonly document: RoutineOccurrenceDocument;
}

/**
 * Resolve an occurrence target inside a command transaction. The id is always derived from the
 * logical key, so materializing twice collides instead of duplicating.
 */
export async function loadOccurrence(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  target: OccurrenceTargetInput,
): Promise<DomainResult<OccurrenceWorkspace & { readonly routine: CanonicalRecordState }>> {
  const routineId = parseUUID(target.routineId);
  if (!routineId.ok) return routineId;
  const routineRef = createEntityRef('routine', routineId.value, ownerId);
  const routine = await records.read(routineRef);
  if (routine === null)
    return err({ code: 'invalid_value', message: 'The Routine no longer exists.' });
  const document = routine.document as RoutineDocument;
  const generation = document.generations.find((item) => item.generation === target.generation);
  if (generation === undefined)
    return err({ code: 'invalid_value', message: 'The Routine generation does not exist.' });
  const period: GeneratedOccurrencePeriod = target.period;
  if ((generation.rule.kind === 'weekly_count') !== (period.kind === 'week'))
    return err({
      code: 'invalid_value',
      message: 'The occurrence period does not match its Routine.',
    });
  const logicalKey = occurrenceLogicalKey(routineId.value, target.generation, period);
  const ref = createEntityRef('routine_occurrence', routineOccurrenceId(logicalKey), ownerId);
  const record = await records.read(ref);
  if (record !== null) {
    if (target.revision !== undefined && record.localRevision !== target.revision)
      return err({
        code: 'invalid_value',
        message: 'This occurrence changed. Review it and try again.',
      });
    return ok({
      ref,
      routineRef,
      routine,
      record,
      document: record.document as RoutineOccurrenceDocument,
    });
  }
  if (target.revision !== undefined)
    return err({
      code: 'invalid_value',
      message: 'This occurrence changed. Review it and try again.',
    });
  return ok({
    ref,
    routineRef,
    routine,
    record: null,
    document: {
      routineId: routineId.value,
      generation: target.generation,
      periodKey: occurrencePeriodKey(period),
      period,
      state: 'planned',
      ...(period.kind === 'week' ? { targetCount: period.targetCount, completedCount: 0 } : {}),
    },
  });
}
