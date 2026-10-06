import {
  createDeletionTombstone,
  createEntityRef,
  entityRefKey,
  err,
  isAlignmentRelationship,
  ok,
  parseUUID,
  type AlignmentRelationship,
  type CommandContext,
  type DomainChange,
  type DomainError,
  type DomainEventDraft,
  type DomainResult,
  type EntityRef,
  type EntityType,
  type Instant,
  type UUID,
} from '@yelaxis/domain';

import type { ApplicationResult, CanonicalMutation, CanonicalRecordState } from './contracts';
import type { PlanningRecordReader } from './ports';

export const planningUndoCommandType = 'planning.restore_v1';

export function createMutation(
  ref: EntityRef,
  document: Readonly<Record<string, unknown>>,
): CanonicalMutation {
  return {
    operation: 'create',
    ref,
    expectedRevision: null,
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document,
  };
}

export function updateFrom(
  record: CanonicalRecordState,
  document: Readonly<Record<string, unknown>>,
): CanonicalMutation {
  return {
    operation: 'update',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    document,
  };
}

/**
 * Permanently remove one record, leaving only its content-free tombstone (owner, type, id,
 * revision, deletion time). A command containing a delete is never undoable.
 */
export function deleteFrom(record: CanonicalRecordState, now: Instant): CanonicalMutation {
  return {
    operation: 'delete',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    tombstone: createDeletionTombstone(record.ref, record.localRevision + 1, now),
  };
}

/** Kinds of records a planning command may create, with the inverse its undo applies. */
export type CreatedKind =
  | 'planning_placement'
  | 'time_block'
  | 'commitment'
  | 'routine'
  | 'routine_occurrence'
  | 'routine_action_defaults'
  | 'template'
  | 'constraint'
  | 'theme'
  | 'direction'
  | 'focus_selection'
  | 'action'
  | 'project'
  | 'note'
  | 'axis'
  | 'outcome'
  | 'milestone'
  /** alignment join records; undo marks them unlinked (`unlinkedAt`), never deletes them. */
  | 'project_secondary_outcome'
  | 'milestone_project'
  | 'milestone_action'
  /** Review: undo archives a created review, so its period can be reviewed again. */
  | 'review'
  /** Review: undo archives a created review item (`archivedAt`). */
  | 'review_item'
  /** Review: undo turns a created reminder definition off (`scheduled -> canceled`). */
  | 'reminder';

export interface CreatedRecord {
  readonly ref: EntityRef;
  readonly kind: CreatedKind;
}

/**
 * Minimized relationship details for an audit event: a relationship name and record ids only,
 * never titles, notes, or other planning text. `previousId` is the parent a link replaced or an
 * unlink removed; `nextId` is the parent a link or reparent set.
 */
export interface PlanningEventDetails {
  readonly relationship?: AlignmentRelationship;
  readonly previousId?: UUID;
  readonly nextId?: UUID;
}

/** Details for every event of the command, or per changed record (`undefined` adds none). */
export type PlanningEventPayload =
  PlanningEventDetails | ((mutation: CanonicalMutation) => PlanningEventDetails | undefined);

export interface PlanningChangeOptions {
  /** Records updated by the command, captured before the update, for grouped undo. */
  readonly prior?: readonly CanonicalRecordState[];
  /** Records created by the command, for grouped undo. */
  readonly created?: readonly CreatedRecord[];
  /** Omit undo entirely (e.g. for the undo command itself). */
  readonly undoable?: boolean;
  /** Extra minimized event fields after `operation`; validated, and only these keys are kept. */
  readonly eventPayload?: PlanningEventPayload;
}

/**
 * Copy only the known detail keys, and only valid values, so no planning text can reach an event
 * payload through structural typing. An invalid value is a programming error: it throws inside the
 * command transaction, which then rolls back as `transaction_failed`.
 */
function minimizedEventDetails(
  details: PlanningEventDetails | undefined,
): Readonly<Record<string, string>> {
  if (details === undefined) return {};
  const output: Record<string, string> = {};
  if (details.relationship !== undefined) {
    if (!isAlignmentRelationship(details.relationship)) {
      throw new Error('Event details must name a known relationship.');
    }
    output['relationship'] = details.relationship;
  }
  for (const key of ['previousId', 'nextId'] as const) {
    const value: unknown = details[key];
    if (value === undefined) continue;
    const parsed = typeof value === 'string' ? parseUUID(value) : null;
    if (parsed === null || !parsed.ok || parsed.value !== value) {
      throw new Error('Event details carry record ids only.');
    }
    output[key] = parsed.value;
  }
  return output;
}

/**
 * Build a validated change: one minimized audit event per touched aggregate (operation only, never
 * titles, notes, or other planning text) plus an optional grouped `planning.restore_v1` undo.
 */
export function planningChange(
  mutations: readonly CanonicalMutation[],
  context: CommandContext,
  eventType: string,
  options: PlanningChangeOptions = {},
): DomainChange<readonly CanonicalMutation[]> {
  const touched = mutations.map(({ ref }) => ref);
  const eventPayload = options.eventPayload;
  const events: DomainEventDraft[] = mutations.map((mutation) => ({
    aggregate: mutation.ref,
    eventType,
    version: 1,
    actor: context.actor,
    commandId: context.commandId,
    occurredAt: context.now,
    payload: {
      operation: mutation.operation,
      ...minimizedEventDetails(
        typeof eventPayload === 'function' ? eventPayload(mutation) : eventPayload,
      ),
    },
  }));
  const undoable =
    options.undoable !== false && mutations.every((mutation) => mutation.operation !== 'delete');
  return {
    value: mutations,
    touched,
    events,
    ...(undoable
      ? {
          undo: {
            commandType: planningUndoCommandType,
            version: 1 as const,
            payload: {
              prior: (options.prior ?? []).map((record) => ({
                ref: record.ref,
                document: record.document,
              })),
              created: options.created ?? [],
            },
            expectedRevisions: Object.fromEntries(
              mutations.map((mutation) => [
                entityRefKey(mutation.ref),
                mutation.operation === 'create' ? 1 : mutation.expectedRevision + 1,
              ]),
            ),
          },
        }
      : {}),
  };
}

/**
 * Apply per-record event types to a planned change; every other field stays as planned. A changed
 * record whose `eventTypeFor` result is `undefined` keeps the command's own event type (for example
 * `axis.reordered` for siblings whose keys a create normalizes, so their history never reads as
 * created).
 */
export function applyEventTypes(
  change: DomainChange<readonly CanonicalMutation[]>,
  mutations: readonly CanonicalMutation[],
  eventTypeFor: ((mutation: CanonicalMutation) => string | undefined) | undefined,
): DomainChange<readonly CanonicalMutation[]> {
  if (eventTypeFor === undefined) return change;
  const types = new Map(
    mutations.map((mutation) => [entityRefKey(mutation.ref), eventTypeFor(mutation)] as const),
  );
  return {
    ...change,
    events: change.events.map((event) => {
      const type = types.get(entityRefKey(event.aggregate));
      return type === undefined ? event : { ...event, eventType: type };
    }),
  };
}

export function without<T extends Readonly<Record<string, unknown>>, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  Reflect.deleteProperty(copy, key);
  return copy;
}

export function invalid(
  reason: string,
  message = 'The planning request is invalid.',
): {
  readonly ok: false;
  readonly error: DomainError;
} {
  return { ok: false, error: { code: 'invalid_value', message, details: { reason } } };
}

export function domainFailure(result: {
  readonly ok: false;
  readonly error: DomainError;
}): ApplicationResult<never> {
  return { ok: false, error: { code: 'domain_rejected', domainError: result.error } };
}

export function notFound(ref: EntityRef): ApplicationResult<never> {
  return { ok: false, error: { code: 'entity_not_found', ref } };
}

export function parseId(value: string | undefined): DomainResult<UUID | undefined> {
  if (value === undefined || value === '') return ok(undefined);
  return parseUUID(value);
}

const undoEntityTypes = new Set<string>([
  // A planning-zone change restores the prior Profile document; a Profile is never created,
  // archived, or deleted by a planning command.
  'profile',
  'axis',
  'outcome',
  'milestone',
  'project',
  'action',
  'note',
  'commitment',
  'time_block',
  'routine',
  'routine_occurrence',
  'routine_action_defaults',
  'template',
  'constraint',
  'planning_placement',
  'focus_selection',
  'theme',
  'direction',
  'project_secondary_outcome',
  'milestone_project',
  'milestone_action',
  'review',
  'review_item',
  'reminder',
]);

const createdKinds = new Set<CreatedKind>([
  'planning_placement',
  'time_block',
  'commitment',
  'routine',
  'routine_occurrence',
  'routine_action_defaults',
  'template',
  'constraint',
  'theme',
  'direction',
  'focus_selection',
  'action',
  'project',
  'note',
  'axis',
  'outcome',
  'milestone',
  'project_secondary_outcome',
  'milestone_project',
  'milestone_action',
  'review',
  'review_item',
  'reminder',
]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseRef(value: unknown): EntityRef | null {
  if (!isRecord(value)) return null;
  const { type, id, ownerId } = value;
  if (typeof type !== 'string' || !undoEntityTypes.has(type)) return null;
  if (typeof id !== 'string' || typeof ownerId !== 'string') return null;
  const parsedId = parseUUID(id);
  const parsedOwner = parseUUID(ownerId);
  if (!parsedId.ok || !parsedOwner.ok) return null;
  return createEntityRef(type as EntityType, parsedId.value, parsedOwner.value);
}

/**
 * Inverse document for a record the undone command created. Created objects are archived/canceled
 * and created links are unlinked, never deleted.
 */
function inverseOfCreated(
  kind: CreatedKind,
  document: Readonly<Record<string, unknown>>,
  now: Instant,
): Readonly<Record<string, unknown>> | null {
  switch (kind) {
    case 'planning_placement':
    case 'theme':
    case 'direction':
    case 'focus_selection':
      return { ...document, archivedAt: now };
    case 'time_block':
      return document['state'] === 'planned' ? { ...document, state: 'canceled' } : null;
    case 'commitment':
      return document['state'] === 'planned' ? { ...document, state: 'canceled' } : null;
    case 'routine_action_defaults':
      return null;
    case 'project_secondary_outcome':
    case 'milestone_project':
    case 'milestone_action':
      // A created (or revived) link becomes inactive again; both endpoints stay untouched.
      return document['unlinkedAt'] === undefined ? { ...document, unlinkedAt: now } : null;
    case 'review_item':
      // A created review choice is removed again; an item that is already removed stays as it is.
      return document['archivedAt'] === undefined ? { ...document, archivedAt: now } : null;
    case 'reminder':
      // A created reminder definition is turned off; one that is already off stays as it is.
      return document['state'] === 'scheduled' ? { ...document, state: 'canceled' } : null;
    case 'routine_occurrence': {
      const period = document['period'];
      const weekly = isRecord(period) && period['kind'] === 'week';
      const base = without(
        without(without(without(document, 'override'), 'completedAt'), 'extraCompletionsConfirmed'),
        'completedCount',
      );
      return weekly
        ? { ...base, state: 'planned', completedCount: 0 }
        : { ...base, state: 'planned' };
    }
    case 'routine':
    case 'template':
    case 'constraint':
    case 'action':
    case 'project':
    case 'note':
    case 'axis':
    case 'outcome':
    case 'milestone':
    case 'review': {
      // A created review is archived with the state it had, so its period can be reviewed again.
      const state = document['state'];
      if (state === 'archived' || typeof state !== 'string') return null;
      return { ...document, state: 'archived', stateBeforeArchive: state, archivedAt: now };
    }
  }
}

/**
 * Plan the inverse of a `planning.restore_v1` descriptor: archive or cancel each created record, then
 * restore each prior document. The undo command itself is not undoable.
 */
export async function planPlanningUndo(
  payload: Readonly<Record<string, unknown>> | undefined,
  records: PlanningRecordReader,
  context: CommandContext,
): Promise<DomainResult<DomainChange<readonly CanonicalMutation[]>>> {
  if (payload === undefined) return err({ code: 'invalid_value', message: 'Undo is unavailable.' });
  const rawPrior = payload['prior'];
  const rawCreated = payload['created'];
  if (!Array.isArray(rawPrior) || !Array.isArray(rawCreated))
    return err({ code: 'invalid_value', message: 'Undo data is invalid.' });
  // Created records are archived/canceled first so restoring a prior planned block never collides
  // with the one-planned-block-per-target indexes while its replacement is still planned.
  const mutations: CanonicalMutation[] = [];
  for (const raw of rawCreated as unknown[]) {
    if (!isRecord(raw)) return err({ code: 'invalid_value', message: 'Undo data is invalid.' });
    const ref = parseRef(raw['ref']);
    const kind = raw['kind'];
    if (ref === null || typeof kind !== 'string' || !createdKinds.has(kind as CreatedKind))
      return err({ code: 'invalid_value', message: 'Undo data is invalid.' });
    const current = await records.read(ref);
    if (current === null)
      return err({ code: 'invalid_value', message: 'Undo target no longer exists.' });
    const inverse = inverseOfCreated(kind as CreatedKind, current.document, context.now);
    if (inverse !== null) mutations.push(updateFrom(current, inverse));
  }
  for (const raw of rawPrior as unknown[]) {
    if (!isRecord(raw) || !isRecord(raw['document']))
      return err({ code: 'invalid_value', message: 'Undo data is invalid.' });
    const ref = parseRef(raw['ref']);
    if (ref === null) return err({ code: 'invalid_value', message: 'Undo data is invalid.' });
    const current = await records.read(ref);
    if (current === null)
      return err({ code: 'invalid_value', message: 'Undo target no longer exists.' });
    mutations.push(updateFrom(current, raw['document']));
  }
  if (mutations.length === 0)
    return err({ code: 'invalid_value', message: 'There is nothing left to undo.' });
  return ok(planningChange(mutations, context, 'planning.undo_applied', { undoable: false }));
}

/**
 * Serialize every call on an object whose methods return promises. The browser owns one SQLite
 * worker connection that rejects overlapping operations, so UI reads and commands queue in order.
 */
export function serializeMethods<T extends object>(target: T, queue: SerialQueue): T {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(target) as (keyof T & string)[]) {
    const value = target[key];
    output[key] =
      typeof value === 'function'
        ? (...args: unknown[]) =>
            queue.run(() =>
              (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args),
            )
        : value;
  }
  return output as T;
}

export interface SerialQueue {
  run<Result>(operation: () => Promise<Result>): Promise<Result>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<Result>(operation: () => Promise<Result>): Promise<Result> {
      const result = tail.then(operation, operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
