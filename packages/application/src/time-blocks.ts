import {
  createEntityRef,
  detectTimeBlockOverlaps,
  entityRefKey,
  err,
  ok,
  parseUUID,
  validateTimeBlockInterval,
  validateTimeBlockTarget,
  validateTimeBlockTransition,
  type CommandContext,
  type CommandId,
  type DomainChange,
  type DomainEventDraft,
  type EntityRef,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type TimeBlock,
  type TimeBlockState,
  type TimeBlockTarget,
  type UUID,
} from '@yelaxis/domain';

import type { ApplicationDependencies } from './ports';
import type {
  ApplicationResult,
  CanonicalMutation,
  CanonicalRecordState,
  CommandReceipt,
} from './contracts';
import { executeCommand } from './execute-command';

interface TimeBlockDocument extends Record<string, unknown> {
  target: TimeBlockTarget;
  startsAt: Instant;
  endsAt: Instant;
  timeZone: string;
  state: TimeBlockState;
  overlapAcknowledged: boolean;
  supersededById?: UUID;
}

/* ───── Query Port ───── */

export interface TimeBlockQueryPort {
  /** Returns all time blocks in the given date range for overlap detection. */
  listBlocksInRange(
    ownerId: OwnerId,
    rangeStart: Instant,
    rangeEnd: Instant,
  ): Promise<readonly TimeBlock[]>;

  /** Returns a single time block record for the given owner and ID. */
  getBlockRecord(ownerId: OwnerId, blockId: UUID): Promise<CanonicalRecordState | null>;
}

/* ───── Command Inputs ───── */

export interface CreateTimeBlockInput {
  readonly target: TimeBlockTarget;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly overlapAcknowledged?: boolean;
}

export interface RescheduleTimeBlockInput {
  readonly timeBlockId: string;
  readonly revision: number;
  readonly newStartsAt: string;
  readonly newEndsAt: string;
  readonly newTimeZone: string;
  readonly overlapAcknowledged?: boolean;
}

export interface TransitionTimeBlockInput {
  readonly timeBlockId: string;
  readonly revision: number;
  readonly to: TimeBlockState;
}

/* ───── Application Interface ───── */

export interface TimeBlockApplication {
  create(
    input: CreateTimeBlockInput,
    commandId?: CommandId,
  ): Promise<ApplicationResult<CommandReceipt>>;

  /**
   * Atomically cancels the current block (marking it superseded) and creates
   * a new planned block at the new interval. Preserves inspectable history.
   */
  reschedule(
    input: RescheduleTimeBlockInput,
    commandId?: CommandId,
  ): Promise<ApplicationResult<CommandReceipt>>;

  transition(
    input: TransitionTimeBlockInput,
    commandId?: CommandId,
  ): Promise<ApplicationResult<CommandReceipt>>;
}

/* ───── Factory ───── */

export function createTimeBlockApplication(
  dependencies: ApplicationDependencies,
  queries: TimeBlockQueryPort,
): TimeBlockApplication {
  const identity = async () => {
    const active = await dependencies.identityContext.getActiveIdentity();
    if (active === null) throw new Error('No active identity');
    return active;
  };
  const command = () => dependencies.ids.next();

  return {
    async create(input, requestedCommandId) {
      const active = await identity();

      // Validate interval
      const interval = validateTimeBlockInterval(input.startsAt, input.endsAt, input.timeZone);
      if (!interval.ok) return domainFailure(interval);

      // Validate target
      const target = validateTimeBlockTarget(input.target);
      if (!target.ok) return domainFailure(target);

      // Check overlaps
      const existingBlocks = await queries.listBlocksInRange(
        active.ownerId,
        interval.value.startsAt,
        interval.value.endsAt,
      );
      const conflicts = detectTimeBlockOverlaps(interval.value, existingBlocks);
      if (conflicts.length > 0 && !input.overlapAcknowledged) {
        return domainFailure({
          ok: false,
          error: {
            code: 'invalid_value',
            message: 'Time block overlaps with existing scheduled blocks.',
            details: { reason: 'overlap_detected', conflicts },
          },
        });
      }

      const blockId = dependencies.ids.next();
      const blockRef = createEntityRef('time_block', blockId, active.ownerId);

      return executeCommand(
        dependencies,
        {
          commandId: requestedCommandId ?? command(),
          ownerId: active.ownerId,
          actor: 'user',
          expectedRevisions: [],
          input: { blockRef, target: target.value, interval: interval.value },
        },
        ({ input: request, context }) => {
          const document: TimeBlockDocument = {
            target: request.target,
            startsAt: request.interval.startsAt,
            endsAt: request.interval.endsAt,
            timeZone: request.interval.timeZone,
            state: 'planned',
            overlapAcknowledged: input.overlapAcknowledged ?? false,
          };
          const mutation = createMutation(request.blockRef, document);
          return ok(buildChange([mutation], context, 'timeBlock.created'));
        },
      );
    },

    async reschedule(input, requestedCommandId) {
      const active = await identity();

      // Parse and validate block ID
      const parsedId = parseUUID(input.timeBlockId);
      if (!parsedId.ok) return domainFailure(parsedId);

      // Validate new interval
      const newInterval = validateTimeBlockInterval(
        input.newStartsAt,
        input.newEndsAt,
        input.newTimeZone,
      );
      if (!newInterval.ok) return domainFailure(newInterval);

      // Read existing block
      const existingRecord = await queries.getBlockRecord(active.ownerId, parsedId.value);
      if (existingRecord === null) {
        return notFound(createEntityRef('time_block', parsedId.value, active.ownerId));
      }
      const existingDoc = existingRecord.document as unknown as TimeBlockDocument;

      // Check state: only planned blocks can be rescheduled
      if (existingDoc.state !== 'planned') {
        return domainFailure({
          ok: false,
          error: {
            code: 'invalid_transition',
            message: 'Only planned time blocks can be rescheduled.',
          },
        });
      }

      // Check supersession
      if (existingDoc.supersededById !== undefined) {
        return domainFailure({
          ok: false,
          error: {
            code: 'invalid_transition',
            message: 'Cannot reschedule a superseded time block.',
          },
        });
      }

      // Check overlaps (exclude the block being rescheduled)
      const existingBlocks = await queries.listBlocksInRange(
        active.ownerId,
        newInterval.value.startsAt,
        newInterval.value.endsAt,
      );
      // Build TimeBlock objects for overlap detection, excluding the current block
      const conflicts = detectTimeBlockOverlaps(newInterval.value, existingBlocks, parsedId.value);
      if (conflicts.length > 0 && !input.overlapAcknowledged) {
        return domainFailure({
          ok: false,
          error: {
            code: 'invalid_value',
            message: 'Rescheduled time block overlaps with existing scheduled blocks.',
            details: { reason: 'overlap_detected', conflicts },
          },
        });
      }

      const newBlockId = dependencies.ids.next();
      const newBlockRef = createEntityRef('time_block', newBlockId, active.ownerId);

      return executeCommand(
        dependencies,
        {
          commandId: requestedCommandId ?? command(),
          ownerId: active.ownerId,
          actor: 'user',
          expectedRevisions: [{ ref: existingRecord.ref, revision: input.revision }],
          input: { existingRecord, newBlockRef, newInterval: newInterval.value },
        },
        async ({ input: request, records, context }) => {
          // Re-read inside transaction
          const current = await records.read(request.existingRecord.ref);
          if (current === null) {
            return err({
              code: 'invalid_value',
              message: 'The time block no longer exists.',
            });
          }
          const currentDoc = current.document as unknown as TimeBlockDocument;
          if (currentDoc.state !== 'planned' || currentDoc.supersededById !== undefined) {
            return err({
              code: 'invalid_transition',
              message: 'The time block can no longer be rescheduled.',
            });
          }

          // Cancel old block and mark superseded
          const cancelMutation = updateFrom(current, {
            ...currentDoc,
            state: 'canceled',
            supersededById: request.newBlockRef.id,
          });

          // Create new block
          const newDocument: TimeBlockDocument = {
            target: currentDoc.target,
            startsAt: request.newInterval.startsAt,
            endsAt: request.newInterval.endsAt,
            timeZone: request.newInterval.timeZone,
            state: 'planned',
            overlapAcknowledged: input.overlapAcknowledged ?? false,
          };
          const createNewMutation = createMutation(request.newBlockRef, newDocument);

          return ok(
            buildChange(
              [cancelMutation, createNewMutation],
              context,
              'timeBlock.rescheduled',
              buildInverse([current], [{ ref: request.newBlockRef, kind: 'time_block' }]),
            ),
          );
        },
      );
    },

    async transition(input, requestedCommandId) {
      const active = await identity();

      const parsedId = parseUUID(input.timeBlockId);
      if (!parsedId.ok) return domainFailure(parsedId);

      const record = await queries.getBlockRecord(active.ownerId, parsedId.value);
      if (record === null) {
        return notFound(createEntityRef('time_block', parsedId.value, active.ownerId));
      }

      return executeCommand(
        dependencies,
        {
          commandId: requestedCommandId ?? command(),
          ownerId: active.ownerId,
          actor: 'user',
          expectedRevisions: [{ ref: record.ref, revision: input.revision }],
          input: { record, to: input.to },
        },
        async ({ input: request, records, context }) => {
          const current = await records.read(request.record.ref);
          if (current === null) {
            return err({
              code: 'invalid_value',
              message: 'The time block no longer exists.',
            });
          }
          const currentDoc = current.document as unknown as TimeBlockDocument;

          // Build a minimal TimeBlock for validation
          const block: TimeBlock = {
            id: current.ref.id,
            ownerId: current.ref.ownerId,
            localRevision: current.localRevision,
            createdAt: context.now,
            updatedAt: context.now,
            interval: {
              startsAt: currentDoc.startsAt,
              endsAt: currentDoc.endsAt,
              timeZone: currentDoc.timeZone as unknown as IanaTimeZone,
            },
            target: currentDoc.target,
            state: currentDoc.state,
            ...(currentDoc.supersededById === undefined
              ? {}
              : { supersededById: currentDoc.supersededById }),
          };

          const validation = validateTimeBlockTransition(
            block,
            request.to,
            request.to === 'planned' ? 'reopen_or_undo' : undefined,
          );
          if (!validation.ok) return validation;

          const updatedDocument: TimeBlockDocument = {
            ...currentDoc,
            state: request.to,
          };
          const mutation = updateFrom(current, updatedDocument);
          return ok(
            buildChange([mutation], context, `timeBlock.${request.to}`, buildInverse([current])),
          );
        },
      );
    },
  };
}

/* ───── Mutation Helpers ───── */

function createMutation(
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

function updateFrom(
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

/* ───── Change Builder ───── */

type CreatedInverse = Readonly<{
  ref: EntityRef;
  kind: 'time_block';
}>;

function buildInverse(
  prior: readonly CanonicalRecordState[],
  created: readonly CreatedInverse[] = [],
) {
  return {
    prior: prior.map((record) => ({ ref: record.ref, document: record.document })),
    created,
  };
}

function buildChange(
  mutations: readonly CanonicalMutation[],
  context: CommandContext,
  eventType: string,
  inverse?: ReturnType<typeof buildInverse>,
): DomainChange<readonly CanonicalMutation[]> {
  const touched = mutations.map(({ ref }) => ref);
  const events: DomainEventDraft[] = touched.map((aggregate) => ({
    aggregate,
    eventType,
    version: 1,
    actor: context.actor,
    commandId: context.commandId,
    occurredAt: context.now,
    payload: {
      operation:
        mutations.find((m) => entityRefKey(m.ref) === entityRefKey(aggregate))?.operation ??
        'update',
    },
  }));
  return {
    value: mutations,
    touched,
    events,
    ...(inverse === undefined
      ? {}
      : {
          undo: {
            commandType: 'timeBlocks.restore_v1',
            version: 1 as const,
            payload: inverse,
            expectedRevisions: Object.fromEntries(
              mutations.map((mutation) => [
                entityRefKey(mutation.ref),
                mutation.operation === 'create' ? 1 : mutation.expectedRevision + 1,
              ]),
            ),
          },
        }),
  };
}

/* ───── Error Helpers ───── */

function domainFailure(result: {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
}): ApplicationResult<never> {
  return {
    ok: false,
    error: {
      code: 'domain_rejected',
      domainError: result.error as ApplicationResult<never> extends { error: infer E }
        ? E extends { domainError: infer D }
          ? D
          : never
        : never,
    },
  };
}

function notFound(ref: EntityRef): ApplicationResult<never> {
  return { ok: false, error: { code: 'entity_not_found', ref } };
}
