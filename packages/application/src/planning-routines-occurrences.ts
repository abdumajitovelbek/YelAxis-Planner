import {
  createEntityRef,
  err,
  generateRoutineOccurrences,
  occurrenceLogicalKey,
  ok,
  parseCalendarDate,
  parseOccurrenceOverride,
  parseUUID,
  parseWallTime,
  planOccurrenceEdit,
  routineOccurrenceId,
  validateRoutineOccurrenceSnapshot,
  type CalendarDate,
  type CommandContext,
  type DomainChange,
  type DomainResult,
  type EntityRef,
  type IanaTimeZone,
  type Instant,
  type OccurrenceOverrideV1,
  type OccurrenceProgress,
  type OwnerId,
  type RoutineSchedulingMode,
  type WallTime,
} from '@yelaxis/domain';

import type { ApplicationResult, CanonicalMutation, CanonicalRecordState } from './contracts';
import type {
  LocalTimeResolution,
  OccurrenceTargetInput,
  PlanningQueryPort,
  RoutineDocument,
  RoutineOccurrenceDocument,
} from './planning-contracts';
import {
  createMutation,
  domainFailure,
  notFound,
  planningChange,
  updateFrom,
  without,
  type CreatedRecord,
} from './planning-kit';
import { rejected, snapshotMetadata, transitionError } from './planning-routines-support';
import {
  collectPlannedTimedItems,
  loadOccurrence,
  occurrenceKey,
  overlapsFor,
  type OccurrenceWorkspace,
} from './planning-timed-items';
import type { PlanningRecordReader } from './ports';

export interface OpenedOccurrence extends OccurrenceWorkspace {
  readonly routine: CanonicalRecordState;
  readonly progress: OccurrenceProgress;
}

/** Deterministic occurrence ref, computed before the command so a revision can be expected. */
export function occurrenceRefFor(
  ownerId: OwnerId,
  target: OccurrenceTargetInput,
): DomainResult<EntityRef<'routine_occurrence'>> {
  const routineId = parseUUID(target.routineId);
  if (!routineId.ok) return routineId;
  if (!Number.isInteger(target.generation) || target.generation < 1)
    return err({ code: 'invalid_value', message: 'The Routine generation does not exist.' });
  const key = occurrenceLogicalKey(routineId.value, target.generation, target.period);
  return ok(createEntityRef('routine_occurrence', routineOccurrenceId(key), ownerId));
}

const occurrenceStart = (period: OccurrenceTargetInput['period']): string =>
  period.kind === 'date' ? period.date : period.start;

/**
 * A not-yet-materialized target must be an occurrence the Routine actually generates (and not one
 * hidden by a pause), so forged periods never become rows.
 */
function isGeneratedOccurrence(
  routineId: OccurrenceWorkspace['document']['routineId'],
  routine: RoutineDocument,
  target: OccurrenceTargetInput,
): boolean {
  const spec = routine.generations.find((item) => item.generation === target.generation);
  if (spec === undefined) return false;
  const period = target.period;
  const generated = generateRoutineOccurrences({
    routineId,
    generation: spec.generation,
    rule: spec.rule,
    windowStart: period.kind === 'date' ? period.date : period.start,
    windowEnd: period.kind === 'date' ? period.date : period.end,
  });
  if (!generated.ok) return false;
  const key = occurrenceLogicalKey(routineId, target.generation, period);
  const match = generated.value.find((item) => item.logicalKey === key);
  if (match === undefined) return false;
  if (
    period.kind === 'week' &&
    (match.period.kind !== 'week' || match.period.targetCount !== period.targetCount)
  )
    return false;
  if (
    routine.state === 'paused' &&
    routine.pauseEffectiveOn !== undefined &&
    occurrenceStart(period) >= routine.pauseEffectiveOn
  )
    return false;
  return true;
}

/** Load an occurrence target inside a command transaction and check it may change. */
export async function openOccurrence(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  target: OccurrenceTargetInput,
): Promise<DomainResult<OpenedOccurrence>> {
  const loaded = await loadOccurrence(records, ownerId, target);
  if (!loaded.ok) return loaded;
  const workspace = loaded.value;
  const routine = workspace.routine.document as RoutineDocument;
  if (routine.state === 'archived')
    return transitionError('routine_archived', 'Restore the Routine before changing it.');
  if (workspace.record !== null && target.revision === undefined)
    return err({
      code: 'invalid_value',
      message: 'This occurrence changed. Review it and try again.',
    });
  if (
    workspace.record === null &&
    !isGeneratedOccurrence(workspace.document.routineId, routine, target)
  )
    return err({
      code: 'invalid_value',
      message: 'This date is not part of the Routine schedule.',
      details: { reason: 'occurrence_not_generated' },
    });
  const document = workspace.document;
  return ok({
    ...workspace,
    progress: {
      state: document.state,
      period: document.period,
      ...(document.targetCount === undefined ? {} : { targetCount: document.targetCount }),
      ...(document.completedCount === undefined ? {} : { completedCount: document.completedCount }),
      ...(document.extraCompletionsConfirmed === undefined
        ? {}
        : { extraCompletionsConfirmed: document.extraCompletionsConfirmed }),
    },
  });
}

/**
 * Apply explicit progress to an occurrence document. `completedAt` is set when the occurrence
 * reaches completed (kept for extra weekly completions) and cleared when it leaves completed.
 */
export function withProgress(
  document: RoutineOccurrenceDocument,
  progress: OccurrenceProgress,
  now: Instant,
): RoutineOccurrenceDocument {
  const base = without(
    without(
      without(without(document, 'targetCount'), 'completedCount'),
      'extraCompletionsConfirmed',
    ),
    'completedAt',
  );
  const completedAt =
    progress.state !== 'completed'
      ? undefined
      : document.state === 'completed' && document.completedAt !== undefined
        ? document.completedAt
        : now;
  return {
    ...base,
    state: progress.state,
    ...(progress.targetCount === undefined ? {} : { targetCount: progress.targetCount }),
    ...(progress.completedCount === undefined ? {} : { completedCount: progress.completedCount }),
    ...(progress.extraCompletionsConfirmed === true ? { extraCompletionsConfirmed: true } : {}),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

export function validateOccurrenceDocument(
  ref: EntityRef<'routine_occurrence'>,
  document: RoutineOccurrenceDocument,
  now: Instant,
): DomainResult<RoutineOccurrenceDocument> {
  if (document.override !== undefined) {
    const override = parseOccurrenceOverride(document.override);
    if (!override.ok) return override;
  }
  const checked = validateRoutineOccurrenceSnapshot({
    ...snapshotMetadata(ref.id, ref.ownerId, now),
    routineId: document.routineId,
    generation: document.generation,
    logicalKey: occurrenceLogicalKey(document.routineId, document.generation, document.period),
    period: document.period,
    state: document.state,
    ...(document.targetCount === undefined ? {} : { targetCount: document.targetCount }),
    ...(document.completedCount === undefined ? {} : { completedCount: document.completedCount }),
    ...(document.extraCompletionsConfirmed === undefined
      ? {}
      : { extraCompletionsConfirmed: document.extraCompletionsConfirmed }),
  });
  return checked.ok ? ok(document) : checked;
}

/**
 * One grouped, undoable change: materialize (create) or update each occurrence, plus any other
 * updated records (for example overlapped blocks marked as acknowledged).
 */
export function occurrenceChange(
  occurrences: readonly {
    readonly opened: OccurrenceWorkspace;
    readonly document: RoutineOccurrenceDocument;
  }[],
  others: readonly {
    readonly mutation: CanonicalMutation;
    readonly prior: CanonicalRecordState | null;
  }[],
  context: CommandContext,
  eventType: string,
): DomainChange<readonly CanonicalMutation[]> {
  const mutations: CanonicalMutation[] = [];
  const prior: CanonicalRecordState[] = [];
  const created: CreatedRecord[] = [];
  for (const { opened, document } of occurrences) {
    if (opened.record === null) {
      mutations.push(createMutation(opened.ref, document));
      created.push({ ref: opened.ref, kind: 'routine_occurrence' });
    } else {
      mutations.push(updateFrom(opened.record, document));
      prior.push(opened.record);
    }
  }
  for (const other of others) {
    mutations.push(other.mutation);
    if (other.prior !== null) prior.push(other.prior);
  }
  return planningChange(mutations, context, eventType, { prior, created });
}

/** A This-occurrence edit request as the UI sends it (times are in the Routine's zone). */
export interface OccurrenceEditRequest {
  readonly occurrence: OccurrenceTargetInput;
  readonly date: string;
  readonly startTime?: string;
  readonly durationMinutes?: number;
}

export interface PreparedOccurrenceEdit {
  readonly ref: EntityRef<'routine_occurrence'>;
  readonly mode: RoutineSchedulingMode;
  readonly logicalDate: CalendarDate;
  readonly date: CalendarDate;
  readonly wallTime?: WallTime;
  readonly durationMinutes?: number;
  readonly planningTimeZone: IanaTimeZone;
  readonly plan: Extract<ReturnType<typeof planOccurrenceEdit>, { ok: true }>['value'];
}

/**
 * Validate and resolve a This-occurrence edit outside the transaction. The save command and its
 * live preview both use this, so the preview always shows the time the save would store.
 */
export async function prepareOccurrenceEdit(
  queries: PlanningQueryPort,
  ownerId: OwnerId,
  planningTimeZone: IanaTimeZone,
  input: OccurrenceEditRequest,
): Promise<ApplicationResult<PreparedOccurrenceEdit>> {
  const target = input.occurrence;
  const ref = occurrenceRefFor(ownerId, target);
  if (!ref.ok) return domainFailure(ref);
  const routineId = parseUUID(target.routineId);
  if (!routineId.ok) return domainFailure(routineId);
  const row = await queries.getRoutine(ownerId, routineId.value);
  if (row === null) return notFound(createEntityRef('routine', routineId.value, ownerId));
  if (row.document.state === 'archived')
    return rejected('routine_archived', {}, 'Restore the Routine before changing it.');
  const spec = row.document.generations.find((item) => item.generation === target.generation);
  if (spec === undefined) return rejected('generation_unavailable');
  if (target.period.kind !== 'date')
    return rejected('weekly_occurrence_has_no_date', {}, 'A weekly count has no single date.');
  const date = parseCalendarDate(input.date);
  if (!date.ok) return domainFailure(date);
  let wallTime: WallTime | undefined;
  if (input.startTime !== undefined && input.startTime !== '') {
    const parsed = parseWallTime(input.startTime);
    if (!parsed.ok) return domainFailure(parsed);
    wallTime = parsed.value;
  }
  const existing = await queries.readRecord(ownerId, ref.value);
  const request = {
    mode: spec.schedulingMode,
    logicalDate: target.period.date,
    date: date.value,
    ...(wallTime === undefined ? {} : { wallTime }),
    ...(input.durationMinutes === undefined ? {} : { durationMinutes: input.durationMinutes }),
    planningTimeZone,
  };
  const plan = planOccurrenceEdit({
    ...request,
    ...(existing === null ? {} : overrideOf(existing.document as RoutineOccurrenceDocument)),
  });
  if (!plan.ok) return domainFailure(plan);
  return { ok: true, value: { ref: ref.value, ...request, plan: plan.value } };
}

const overrideOf = (
  document: RoutineOccurrenceDocument,
): { readonly existing?: OccurrenceOverrideV1 } =>
  document.override === undefined ? {} : { existing: document.override };

/**
 * Re-plan a prepared edit against the occurrence as read inside the transaction. The result must
 * match what was checked for overlaps; otherwise the occurrence changed and is not overwritten.
 */
export function confirmOccurrenceEdit(
  prepared: PreparedOccurrenceEdit,
  current: RoutineOccurrenceDocument,
): DomainResult<PreparedOccurrenceEdit['plan']['override']> {
  const plan = planOccurrenceEdit({
    mode: prepared.mode,
    logicalDate: prepared.logicalDate,
    date: prepared.date,
    ...(prepared.wallTime === undefined ? {} : { wallTime: prepared.wallTime }),
    ...(prepared.durationMinutes === undefined
      ? {}
      : { durationMinutes: prepared.durationMinutes }),
    planningTimeZone: prepared.planningTimeZone,
    ...overrideOf(current),
  });
  if (!plan.ok) return plan;
  const before = prepared.plan.override;
  const after = plan.value.override;
  if (
    before.date !== after.date ||
    before.wallTime !== after.wallTime ||
    before.durationMinutes !== after.durationMinutes
  )
    return err({
      code: 'invalid_value',
      message: 'This occurrence changed. Review it and try again.',
    });
  return ok(after);
}

/**
 * Live preview of a This-occurrence edit: the interval `editOccurrence` would store, read in the
 * Routine's zone with its clock-change policies, and the planned items it would overlap.
 */
export async function previewOccurrenceEdit(
  queries: PlanningQueryPort,
  ownerId: OwnerId,
  planningTimeZone: IanaTimeZone,
  input: OccurrenceEditRequest,
  exclude: readonly string[],
): Promise<ApplicationResult<LocalTimeResolution>> {
  const prepared = await prepareOccurrenceEdit(queries, ownerId, planningTimeZone, input);
  if (!prepared.ok) return prepared;
  const time = prepared.value.plan.time;
  if (time.kind === 'dst_skipped')
    return rejected(
      'occurrence_time_skipped',
      {},
      'This time does not exist on this date because of a clock change, so this occurrence is skipped that day.',
    );
  if (time.kind !== 'timed')
    return rejected(
      'time_requires_duration',
      {},
      'A time for this occurrence needs both a start and a duration.',
    );
  const candidates = await collectPlannedTimedItems(
    queries,
    ownerId,
    planningTimeZone,
    time.startsAt,
    time.endsAt,
  );
  const overlaps = overlapsFor(candidates, time, [
    occurrenceKey(prepared.value.ref.id),
    ...exclude,
  ]).map(({ key, title }) => ({ key, title }));
  return {
    ok: true,
    value: {
      startsAt: time.startsAt,
      endsAt: time.endsAt,
      localStart: time.localStart,
      localEnd: time.localEnd,
      localEndDate: time.localEndDate,
      utcOffset: time.utcOffset,
      ...(time.adjustment === undefined ? {} : { adjustment: time.adjustment }),
      timeZone: time.timeZone,
      overlaps,
    },
  };
}
