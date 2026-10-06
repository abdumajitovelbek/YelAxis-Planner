/**
 * Private helpers shared by the planning scheduling, placement, capacity, and theme commands. Nothing
 * here chooses for the user: overlap scans only report, and acknowledgements are written only when
 * the command carries the user's explicit Keep-overlap choice.
 */
import {
  createEntityRef,
  entityRefKey,
  err,
  fixedIntervalDurationMinutes,
  localDateOf,
  ok,
  parseCalendarDate,
  parseWallTime,
  resolveLocalInterval,
  transitionLifecycle,
  validateTimeBlockInterval,
  type ActionState,
  type CalendarDate,
  type CommandContext,
  type CommandId,
  type DomainError,
  type DomainResult,
  type EntityRef,
  type HorizonPeriod,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type TimeBlock,
  type UUID,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from './actions';
import type {
  ApplicationResult,
  CanonicalMutation,
  CanonicalRecordState,
  CommandReceipt,
  ExpectedRevision,
} from './contracts';
import { executeCommand } from './execute-command';
import type {
  LocalIntervalInput,
  OccurrenceTargetInput,
  PlacementTargetDocument,
  PlanProfile,
  PlanningPlacementDocument,
  PlanningQueryPort,
  RoutineOccurrenceDocument,
  TimeBlockDocument,
  TimeBlockTargetDocument,
} from './planning-contracts';
import {
  createMutation,
  planningChange,
  updateFrom,
  without,
  type CreatedRecord,
} from './planning-kit';
import { collectPlannedTimedItems, loadOccurrence, overlapsFor } from './planning-timed-items';
import type { ApplicationDependencies, PlanningRecordReader } from './ports';

/* ───────────────────────── Session and command runner ───────────────────────── */

export interface SchedulingSession {
  readonly ownerId: OwnerId;
  readonly profile: PlanProfile;
}

export interface CommandPlan {
  readonly mutations: readonly CanonicalMutation[];
  readonly created?: readonly CreatedRecord[];
}

export type CommandPlanner = (request: {
  readonly records: PlanningRecordReader;
  readonly context: CommandContext;
}) => DomainResult<CommandPlan> | Promise<DomainResult<CommandPlan>>;

export interface SchedulingKit {
  readonly dependencies: ApplicationDependencies;
  readonly queries: PlanningQueryPort;
  ownerId(): Promise<OwnerId>;
  session(): Promise<SchedulingSession>;
  readonly nextId: () => UUID;
  run(
    ownerId: OwnerId,
    commandId: CommandId | undefined,
    eventType: string,
    expected: readonly ExpectedRevision[],
    planner: CommandPlanner,
  ): Promise<ApplicationResult<CommandReceipt>>;
}

export function createSchedulingKit(
  dependencies: ApplicationDependencies,
  queries: PlanningQueryPort,
): SchedulingKit {
  const ownerId = async (): Promise<OwnerId> => {
    const active = await dependencies.identityContext.getActiveIdentity();
    if (active === null) throw new Error('No active identity');
    return active.ownerId;
  };
  return {
    dependencies,
    queries,
    ownerId,
    async session() {
      const owner = await ownerId();
      return { ownerId: owner, profile: await queries.getPlanProfile(owner) };
    },
    nextId: () => dependencies.ids.next(),
    run(owner, commandId, eventType, expected, planner) {
      return executeCommand(
        dependencies,
        {
          commandId: commandId ?? dependencies.ids.next(),
          ownerId: owner,
          actor: 'user',
          expectedRevisions: uniqueExpected(expected),
          input: null,
        },
        async ({ records, context }) => {
          const planned = await planner({ records, context });
          if (!planned.ok) return planned;
          if (planned.value.mutations.length === 0) return invalid('no_change');
          // Every updated record is captured before any write so grouped undo restores it exactly.
          const prior: CanonicalRecordState[] = [];
          for (const mutation of planned.value.mutations) {
            if (mutation.operation === 'create') continue;
            const current = await records.read(mutation.ref);
            if (current === null) return changed('record_missing');
            prior.push(current);
          }
          return ok(
            planningChange(planned.value.mutations, context, eventType, {
              prior,
              created: planned.value.created ?? [],
            }),
          );
        },
      );
    },
  };
}

function uniqueExpected(expected: readonly ExpectedRevision[]): readonly ExpectedRevision[] {
  const seen = new Set<string>();
  const output: ExpectedRevision[] = [];
  for (const item of expected) {
    const key = entityRefKey(item.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

export const expectedOf = (record: CanonicalRecordState | null): readonly ExpectedRevision[] =>
  record === null ? [] : [{ ref: record.ref, revision: record.localRevision }];

/* ───────────────────────── Errors ───────────────────────── */

export function invalid(reason: string, message = 'The planning request is invalid.') {
  return err({ code: 'invalid_value', message, details: { reason } });
}

export function changed(reason: string) {
  return err({
    code: 'invalid_value',
    message: 'This plan changed. Review it and try again.',
    details: { reason },
  });
}

export function notAllowed(reason: string, message: string) {
  return err({ code: 'invalid_transition', message, details: { reason } });
}

export function overlapRejection(keys: readonly string[]) {
  return err({
    code: 'invalid_value',
    message: 'This time overlaps other planned work. Keep the overlap or choose another time.',
    details: { reason: 'overlap_requires_acknowledgement', overlaps: [...keys] },
  });
}

export function rejected(error: DomainError): ApplicationResult<never> {
  return { ok: false, error: { code: 'domain_rejected', domainError: error } };
}

export function rejectInvalid(reason: string): ApplicationResult<never> {
  return rejected({
    code: 'invalid_value',
    message: 'The planning request is invalid.',
    details: { reason },
  });
}

export function missing(ref: EntityRef): ApplicationResult<never> {
  return { ok: false, error: { code: 'entity_not_found', ref } };
}

/* ───────────────────────── Text ───────────────────────── */

export function trimmedText(value: unknown, max: number, reason: string): DomainResult<string> {
  if (typeof value !== 'string') return invalid(reason);
  const text = value.trim();
  if (text.length < 1 || text.length > max) return invalid(reason);
  return ok(text);
}

/* ───────────────────────── Intervals ───────────────────────── */

export interface BlockInterval {
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly timeZone: IanaTimeZone;
  /** Local start date in the planning zone. */
  readonly localDate: CalendarDate;
}

export const isBlockDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 1440;

/** Resolve a local date, start time, and explicit duration in the planning zone. */
export function resolveBlockInterval(
  input: LocalIntervalInput,
  timeZone: IanaTimeZone,
): DomainResult<BlockInterval> {
  const date = parseCalendarDate(typeof input.date === 'string' ? input.date : '');
  if (!date.ok) return date;
  const time = parseWallTime(typeof input.startTime === 'string' ? input.startTime : '');
  if (!time.ok) return time;
  if (!isBlockDuration(input.durationMinutes)) return invalid('duration');
  const resolved = resolveLocalInterval(date.value, time.value, input.durationMinutes, timeZone);
  const interval = validateTimeBlockInterval(resolved.startsAt, resolved.endsAt, timeZone);
  if (!interval.ok) return interval;
  return ok({
    startsAt: interval.value.startsAt,
    endsAt: interval.value.endsAt,
    timeZone,
    localDate: localDateOf(interval.value.startsAt, timeZone),
  });
}

export const blockDurationMinutes = (document: TimeBlockDocument): number =>
  fixedIntervalDurationMinutes({
    startsAt: document.startsAt,
    endsAt: document.endsAt,
    timeZone: document.timeZone,
  });

export function plannedBlockDocument(
  target: TimeBlockTargetDocument,
  interval: {
    readonly startsAt: Instant;
    readonly endsAt: Instant;
    readonly timeZone: IanaTimeZone;
  },
  overlapAcknowledged: boolean,
): TimeBlockDocument {
  return {
    target,
    startsAt: interval.startsAt,
    endsAt: interval.endsAt,
    timeZone: interval.timeZone,
    state: 'planned',
    overlapAcknowledged,
  };
}

export const isCurrentPlanned = (document: TimeBlockDocument): boolean =>
  document.state === 'planned' && document.supersededById === undefined;

/**
 * Supersede a planned block: it becomes `canceled` with `supersededById`. The caller must emit this
 * update before creating the replacement so the one-planned-block indexes never collide.
 */
export async function supersede(
  records: PlanningRecordReader,
  ref: EntityRef,
  replacementId: UUID,
): Promise<
  DomainResult<{ readonly record: CanonicalRecordState; readonly mutation: CanonicalMutation }>
> {
  const record = await records.read(ref);
  if (record === null) return changed('block_missing');
  const document = record.document as TimeBlockDocument;
  if (!isCurrentPlanned(document))
    return notAllowed('block_not_planned', 'Only a current planned block can be changed.');
  return ok({
    record,
    mutation: updateFrom(record, { ...document, state: 'canceled', supersededById: replacementId }),
  });
}

/** Minimal domain snapshot of a stored block for transition validation. */
export function timeBlockSnapshot(record: CanonicalRecordState, now: Instant): TimeBlock {
  const document = record.document as TimeBlockDocument;
  return {
    id: record.ref.id,
    ownerId: record.ref.ownerId,
    localRevision: record.localRevision,
    createdAt: now,
    updatedAt: now,
    interval: { startsAt: document.startsAt, endsAt: document.endsAt, timeZone: document.timeZone },
    target: document.target,
    state: document.state,
    overlapAcknowledged: document.overlapAcknowledged,
    ...(document.supersededById === undefined ? {} : { supersededById: document.supersededById }),
  };
}

/* ───────────────────────── Overlaps ───────────────────────── */

export type AcknowledgementTarget =
  | { readonly kind: 'block'; readonly ref: EntityRef }
  | { readonly kind: 'occurrence'; readonly target: OccurrenceTargetInput };

export interface OverlapScan {
  /** Keys of every planned item the interval overlaps. */
  readonly keys: readonly string[];
  /** The same overlapped items with their titles, for showing the user what overlaps. */
  readonly items: readonly { readonly key: string; readonly title: string }[];
  /** Overlapped items that still need an acknowledgement if the user keeps the overlap. */
  readonly targets: readonly AcknowledgementTarget[];
  readonly expected: readonly ExpectedRevision[];
}

export async function scanOverlaps(
  queries: PlanningQueryPort,
  ownerId: OwnerId,
  timeZone: IanaTimeZone,
  interval: { readonly startsAt: Instant; readonly endsAt: Instant },
  exclude: readonly string[] = [],
): Promise<OverlapScan> {
  const candidates = await collectPlannedTimedItems(
    queries,
    ownerId,
    timeZone,
    interval.startsAt,
    interval.endsAt,
  );
  const overlaps = overlapsFor(candidates, interval, exclude);
  const targets: AcknowledgementTarget[] = [];
  const expected: ExpectedRevision[] = [];
  for (const candidate of overlaps) {
    if (candidate.overlapAcknowledged) continue;
    if (candidate.block !== undefined) {
      const ref = createEntityRef('time_block', candidate.block.id, ownerId);
      targets.push({ kind: 'block', ref });
      expected.push({ ref, revision: candidate.block.localRevision });
    } else if (candidate.occurrence !== undefined) {
      const projected = candidate.occurrence.projected;
      const materialized = projected.materialized && projected.localRevision !== undefined;
      targets.push({
        kind: 'occurrence',
        target: {
          routineId: projected.routineId,
          generation: projected.generation,
          period: projected.period,
          ...(materialized ? { revision: projected.localRevision } : {}),
        },
      });
      if (materialized && projected.localRevision !== undefined)
        expected.push({
          ref: createEntityRef('routine_occurrence', projected.id, ownerId),
          revision: projected.localRevision,
        });
    }
  }
  return {
    keys: overlaps.map(({ key }) => key),
    items: overlaps.map(({ key, title }) => ({ key, title })),
    targets,
    expected,
  };
}

/**
 * Mark each item with the user's explicit Keep-overlap acknowledgement. Unmaterialized occurrences
 * are materialized with their deterministic id and an override carrying only the acknowledgement.
 */
export async function acknowledgeOverlaps(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  targets: readonly AcknowledgementTarget[],
): Promise<DomainResult<Required<CommandPlan>>> {
  const mutations: CanonicalMutation[] = [];
  const created: CreatedRecord[] = [];
  for (const target of targets) {
    if (target.kind === 'block') {
      const record = await records.read(target.ref);
      if (record === null) return changed('overlap_changed');
      const document = record.document as TimeBlockDocument;
      if (!isCurrentPlanned(document)) return changed('overlap_changed');
      if (document.overlapAcknowledged) continue;
      mutations.push(updateFrom(record, { ...document, overlapAcknowledged: true }));
      continue;
    }
    const loaded = await loadOccurrence(records, ownerId, target.target);
    if (!loaded.ok) return loaded;
    const document: RoutineOccurrenceDocument = loaded.value.document;
    if (document.state !== 'planned') return changed('overlap_changed');
    if (document.override?.overlapAcknowledged === true) continue;
    const next: RoutineOccurrenceDocument = {
      ...document,
      override: { ...(document.override ?? {}), overlapAcknowledged: true as const },
    };
    if (loaded.value.record === null) {
      mutations.push(createMutation(loaded.value.ref, next));
      created.push({ ref: loaded.value.ref, kind: 'routine_occurrence' });
    } else {
      mutations.push(updateFrom(loaded.value.record, next));
    }
  }
  return ok({ mutations, created });
}

/* ───────────────────────── Actions ───────────────────────── */

export const finishedActionStates: readonly ActionState[] = ['completed', 'canceled', 'archived'];

/** Apply a lifecycle transition to an Action document (completion stamps `completedAt`). */
export function actionWithState(
  document: ActionCanonicalDocument,
  to: ActionState,
  now: Instant,
): DomainResult<ActionCanonicalDocument> {
  const transitioned = transitionLifecycle({
    entityType: 'action',
    current: {
      state: document.state,
      ...(document.stateBeforeArchive === undefined
        ? {}
        : { stateBeforeArchive: document.stateBeforeArchive }),
    },
    to,
  });
  if (!transitioned.ok) return transitioned;
  const base = without(document, 'completedAt');
  return ok({ ...base, state: to, ...(to === 'completed' ? { completedAt: now } : {}) });
}

/* ───────────────────────── Placements ───────────────────────── */

export const defaultPlacementOrderKey = '500000000000000';

export type PlaceableKind = PlacementTargetDocument['kind'];

export const placeableKinds: readonly PlaceableKind[] = [
  'action',
  'project',
  'milestone',
  'outcome',
];

export function placementTarget(kind: PlaceableKind, id: UUID): PlacementTargetDocument {
  switch (kind) {
    case 'action':
      return { kind, actionId: id };
    case 'project':
      return { kind, projectId: id };
    case 'milestone':
      return { kind, milestoneId: id };
    case 'outcome':
      return { kind, outcomeId: id };
  }
}

export function placementTargetId(target: PlacementTargetDocument): UUID {
  switch (target.kind) {
    case 'action':
      return target.actionId;
    case 'project':
      return target.projectId;
    case 'milestone':
      return target.milestoneId;
    case 'outcome':
      return target.outcomeId;
  }
}

export function samePeriod(left: HorizonPeriod, right: HorizonPeriod): boolean {
  switch (left.kind) {
    case 'day':
      return right.kind === 'day' && right.date === left.date;
    case 'week':
      return right.kind === 'week' && right.start === left.start && right.end === left.end;
    case 'month':
      return right.kind === 'month' && right.month === left.month;
    case 'year':
      return right.kind === 'year' && right.year === left.year;
  }
}

/** The active placement record of one target, read before a command opens. */
export async function findActivePlacement(
  queries: PlanningQueryPort,
  ownerId: OwnerId,
  kind: PlaceableKind,
  id: UUID,
): Promise<CanonicalRecordState | null> {
  const record = await queries.getActivePlacement(ownerId, kind, id);
  if (record === null) return null;
  const document = record.document as PlanningPlacementDocument;
  return document.archivedAt === undefined && placementTargetId(document.target) === id
    ? record
    : null;
}

/**
 * Create the target's placement in `period`, or move its existing active placement there (same id).
 * Returns no mutation when the target is already placed in that period.
 */
export async function upsertPlacement(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  existing: CanonicalRecordState | null,
  target: PlacementTargetDocument,
  period: HorizonPeriod,
  nextId: () => UUID,
): Promise<
  DomainResult<{ readonly mutation: CanonicalMutation | null; readonly created?: CreatedRecord }>
> {
  if (existing !== null) {
    const current = await records.read(existing.ref);
    if (current === null) return changed('placement_changed');
    const document = current.document as PlanningPlacementDocument;
    if (
      document.archivedAt !== undefined ||
      placementTargetId(document.target) !== placementTargetId(target)
    )
      return changed('placement_changed');
    if (samePeriod(document.period, period)) return ok({ mutation: null });
    return ok({ mutation: updateFrom(current, { ...without(document, 'archivedAt'), period }) });
  }
  const ref = createEntityRef('planning_placement', nextId(), ownerId);
  const document: PlanningPlacementDocument = {
    target,
    period,
    orderKey: defaultPlacementOrderKey,
  };
  return ok({
    mutation: createMutation(ref, document),
    created: { ref, kind: 'planning_placement' },
  });
}

export function isArchivedDocument(document: Readonly<Record<string, unknown>>): boolean {
  return document['state'] === 'archived' || document['archivedAt'] !== undefined;
}
