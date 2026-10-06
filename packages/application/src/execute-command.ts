import {
  entityRefKey,
  type CommandContext,
  type DomainChange,
  type DomainResult,
  type EntityRefKey,
  type EntityRef,
  type EntityType,
} from '@yelaxis/domain';

import type {
  ApplicationError,
  ApplicationResult,
  AppliedCanonicalChange,
  CanonicalMutation,
  CommandEnvelope,
  CommandReceipt,
  ExpectedRevision,
  OutboxMutationGroup,
  ProjectionInvalidation,
  StoredUndoDescriptor,
  UndoAvailability,
} from './contracts';
import type { ApplicationDependencies, PlanningRecordReader } from './ports';

export interface CommandHandlerRequest<TInput> {
  readonly input: TInput;
  readonly context: CommandContext;
  readonly records: PlanningRecordReader;
  readonly undoDescriptor?: StoredUndoDescriptor;
}

export type CommandHandler<TInput> = (
  request: CommandHandlerRequest<TInput>,
) =>
  | DomainResult<DomainChange<readonly CanonicalMutation[]>>
  | Promise<DomainResult<DomainChange<readonly CanonicalMutation[]>>>;

interface TransactionOutcome {
  readonly result: ApplicationResult<CommandReceipt>;
  readonly invalidation?: ProjectionInvalidation;
}

interface PreflightState {
  readonly expectedByEntity: ReadonlyMap<EntityRefKey, number>;
}

const deletionTombstoneKeys = [
  'deletedAt',
  'entityId',
  'entityType',
  'ownerId',
  'revision',
] as const;

export async function executeCommand<TInput>(
  dependencies: ApplicationDependencies,
  envelope: CommandEnvelope<TInput>,
  handler: CommandHandler<TInput>,
): Promise<ApplicationResult<CommandReceipt>> {
  let activeIdentity;

  try {
    activeIdentity = await dependencies.identityContext.getActiveIdentity();
  } catch {
    return failure({ code: 'identity_unavailable' });
  }

  if (activeIdentity === null) {
    return failure({ code: 'no_active_identity' });
  }
  if (activeIdentity.ownerId !== envelope.ownerId) {
    return failure({ code: 'owner_mismatch' });
  }

  let outcome: TransactionOutcome;

  try {
    outcome = await dependencies.unitOfWork.runInTransaction(async (unitOfWork) => {
      const existingReceipt = await unitOfWork.receipts.find(
        activeIdentity.ownerId,
        envelope.commandId,
      );

      if (existingReceipt !== null) {
        return { result: success(existingReceipt) };
      }

      const undoDescriptor =
        envelope.consumesUndoId === undefined
          ? null
          : await unitOfWork.undo.find(activeIdentity.ownerId, envelope.consumesUndoId);
      if (envelope.consumesUndoId !== undefined && undoDescriptor === null) {
        return { result: failure({ code: 'undo_unavailable' }) };
      }
      const undoExpected =
        undoDescriptor === null
          ? envelope.expectedRevisions
          : expectedRevisionsFromUndo(undoDescriptor.descriptor.expectedRevisions);
      if (undoExpected === null) {
        return {
          result: failure({ code: 'invalid_command_plan', reason: 'invalid_expected_revision' }),
        };
      }
      if (undoDescriptor !== null && envelope.expectedRevisions.length !== 0) {
        return {
          result: failure({ code: 'invalid_command_plan', reason: 'duplicate_expected_revision' }),
        };
      }

      const expectedResult = await preflightExpectedRevisions(
        unitOfWork.records,
        undoExpected,
        activeIdentity.ownerId,
      );
      if (!expectedResult.ok) {
        return { result: expectedResult };
      }

      const context: CommandContext = {
        ownerId: activeIdentity.ownerId,
        actor: envelope.actor,
        commandId: envelope.commandId,
        now: dependencies.clock.now(),
      };
      let foreignOwnerReadAttempted = false;
      const commandReader: PlanningRecordReader = {
        read: (ref) => {
          if (ref.ownerId !== activeIdentity.ownerId) {
            foreignOwnerReadAttempted = true;
            return Promise.resolve(null);
          }
          return unitOfWork.records.read(ref);
        },
      };
      const domainResult = await handler({
        input: envelope.input,
        context,
        records: commandReader,
        ...(undoDescriptor === null ? {} : { undoDescriptor }),
      });

      if (foreignOwnerReadAttempted) {
        return { result: failure({ code: 'owner_mismatch' }) };
      }

      if (!domainResult.ok) {
        return {
          result: failure({ code: 'domain_rejected', domainError: domainResult.error }),
        };
      }

      const change = domainResult.value;
      const planError = validateCommandPlan(change, context, expectedResult.value.expectedByEntity);
      if (planError !== null) {
        return { result: failure(planError) };
      }

      const mutationError = await preflightMutations(
        unitOfWork.records,
        change.value,
        expectedResult.value.expectedByEntity,
        activeIdentity.ownerId,
        change.undo,
      );
      if (mutationError !== null) {
        return { result: failure(mutationError) };
      }

      const appliedChanges: AppliedCanonicalChange[] = [];
      for (const mutation of change.value) {
        appliedChanges.push(await unitOfWork.records.apply(mutation, context));
      }

      const eventRecords = change.events.map((event) => ({
        eventId: dependencies.ids.next(),
        ownerId: activeIdentity.ownerId,
        event,
      }));
      await unitOfWork.events.append(eventRecords);

      if (undoDescriptor !== null) {
        await unitOfWork.undo.markApplied(
          activeIdentity.ownerId,
          undoDescriptor.undoId,
          undoDescriptor.localRevision,
          context.now,
        );
      }

      const undo: UndoAvailability =
        change.undo === undefined
          ? { available: false }
          : { available: true, undoId: dependencies.ids.next() };

      if (change.undo !== undefined && undo.available) {
        await unitOfWork.undo.append({
          undoId: undo.undoId,
          ownerId: activeIdentity.ownerId,
          commandId: envelope.commandId,
          createdAt: context.now,
          descriptor: change.undo,
        });
      }

      const shouldQueueSync = activeIdentity.syncEnabled && envelope.actor !== 'sync';
      const outboxGroup = shouldQueueSync
        ? createOutboxGroup(dependencies, envelope, context, change.value)
        : null;

      if (outboxGroup !== null) {
        await unitOfWork.outbox.append(outboxGroup);
      }

      const receipt: CommandReceipt = {
        commandId: envelope.commandId,
        ownerId: activeIdentity.ownerId,
        actor: envelope.actor,
        acceptedAt: context.now,
        canonical: appliedChanges.map(({ ref, localRevision }) => ({ ref, localRevision })),
        eventIds: eventRecords.map(({ eventId }) => eventId),
        undo,
        sync:
          outboxGroup === null
            ? { queued: false }
            : {
                queued: true,
                mutationGroupId: outboxGroup.mutationGroupId,
                operationIds: outboxGroup.operations.map(({ operationId }) => operationId),
              },
      };
      await unitOfWork.receipts.append(receipt);

      return {
        result: success(receipt),
        invalidation: {
          commandId: envelope.commandId,
          ownerId: activeIdentity.ownerId,
          committedAt: context.now,
          touched: change.touched,
        },
      };
    });
  } catch {
    return failure({ code: 'transaction_failed' });
  }

  if (!outcome.result.ok || outcome.invalidation === undefined) {
    return outcome.result;
  }

  try {
    await dependencies.projections.notifyCommitted(outcome.invalidation);
  } catch {
    // Projection notifications are rebuildable and run only after the canonical commit.
  }

  return outcome.result;
}

const entityTypes = new Set<EntityType>([
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
  'review',
  'review_item',
  'reminder',
  'context',
  'constraint',
  'planning_placement',
  'focus_selection',
  'theme',
  'direction',
  'project_secondary_outcome',
  'milestone_project',
  'milestone_action',
]);

function expectedRevisionsFromUndo(
  revisions: Readonly<Record<EntityRefKey, number>>,
): ExpectedRevision[] | null {
  const result: ExpectedRevision[] = [];
  for (const [key, revision] of Object.entries(revisions)) {
    const parts = key.split(':');
    if (parts.length !== 3) return null;
    const [ownerId, type, id] = parts;
    if (
      ownerId === undefined ||
      type === undefined ||
      id === undefined ||
      !entityTypes.has(type as EntityType)
    ) {
      return null;
    }
    result.push({ ref: { ownerId, type: type as EntityType, id } as EntityRef, revision });
  }
  return result;
}

async function preflightExpectedRevisions(
  records: PlanningRecordReader,
  expectedRevisions: readonly ExpectedRevision[],
  ownerId: CommandContext['ownerId'],
): Promise<ApplicationResult<PreflightState>> {
  const expectedByEntity = new Map<EntityRefKey, number>();

  for (const expected of expectedRevisions) {
    if (expected.ref.ownerId !== ownerId) {
      return failure({ code: 'owner_mismatch' });
    }
    if (!Number.isSafeInteger(expected.revision) || expected.revision < 0) {
      return failure({
        code: 'invalid_command_plan',
        reason: 'invalid_expected_revision',
        ref: expected.ref,
      });
    }

    const key = entityRefKey(expected.ref);
    if (expectedByEntity.has(key)) {
      return failure({
        code: 'invalid_command_plan',
        reason: 'duplicate_expected_revision',
        ref: expected.ref,
      });
    }
    expectedByEntity.set(key, expected.revision);

    const current = await records.read(expected.ref);
    if (current === null) {
      return failure({ code: 'entity_not_found', ref: expected.ref });
    }
    if (current.ref.ownerId !== ownerId) {
      return failure({ code: 'owner_mismatch' });
    }
    if (current.localRevision !== expected.revision) {
      return failure({
        code: 'revision_conflict',
        ref: expected.ref,
        expectedRevision: expected.revision,
        actualRevision: current.localRevision,
      });
    }
  }

  return success({ expectedByEntity });
}

function validateCommandPlan(
  change: DomainChange<readonly CanonicalMutation[]>,
  context: CommandContext,
  expectedByEntity: ReadonlyMap<EntityRefKey, number>,
): ApplicationError | null {
  if (change.value.length === 0) {
    return { code: 'invalid_command_plan', reason: 'missing_canonical_change' };
  }
  if (change.events.length === 0) {
    return { code: 'invalid_command_plan', reason: 'missing_audit_event' };
  }

  const mutationKeys = new Set<EntityRefKey>();
  for (const mutation of change.value) {
    if (mutation.ref.ownerId !== context.ownerId) {
      return { code: 'owner_mismatch' };
    }
    const key = entityRefKey(mutation.ref);
    if (mutationKeys.has(key)) {
      return { code: 'invalid_command_plan', reason: 'duplicate_mutation', ref: mutation.ref };
    }
    mutationKeys.add(key);

    if (
      mutation.operation !== 'create' &&
      expectedByEntity.get(key) !== mutation.expectedRevision
    ) {
      return {
        code: 'invalid_command_plan',
        reason: 'missing_expected_revision',
        ref: mutation.ref,
      };
    }

    if (
      mutation.operation === 'delete' &&
      (!hasExactDeletionTombstoneShape(mutation.tombstone) ||
        mutation.tombstone.ownerId !== mutation.ref.ownerId ||
        mutation.tombstone.entityType !== mutation.ref.type ||
        mutation.tombstone.entityId !== mutation.ref.id ||
        mutation.tombstone.revision !== mutation.expectedRevision + 1 ||
        mutation.tombstone.deletedAt !== context.now)
    ) {
      return {
        code: 'invalid_command_plan',
        reason: 'invalid_delete_tombstone',
        ref: mutation.ref,
      };
    }
  }

  if (change.undo !== undefined && change.value.some(({ operation }) => operation === 'delete')) {
    return { code: 'invalid_command_plan', reason: 'permanent_delete_not_undoable' };
  }

  const touchedKeys = new Set<EntityRefKey>();
  for (const ref of change.touched) {
    if (ref.ownerId !== context.ownerId) {
      return { code: 'owner_mismatch' };
    }
    const key = entityRefKey(ref);
    if (touchedKeys.has(key)) {
      return { code: 'invalid_command_plan', reason: 'duplicate_touched_ref', ref };
    }
    touchedKeys.add(key);
  }

  if (!sameKeys(mutationKeys, touchedKeys)) {
    return { code: 'invalid_command_plan', reason: 'touched_change_mismatch' };
  }

  const eventAggregateKeys = new Set<EntityRefKey>();
  for (const event of change.events) {
    const aggregateKey = entityRefKey(event.aggregate);
    if (
      event.aggregate.ownerId !== context.ownerId ||
      !touchedKeys.has(aggregateKey) ||
      event.actor !== context.actor ||
      event.commandId !== context.commandId ||
      event.occurredAt !== context.now
    ) {
      return {
        code: 'invalid_command_plan',
        reason: 'event_context_mismatch',
        ref: event.aggregate,
      };
    }
    eventAggregateKeys.add(aggregateKey);
  }

  if (!sameKeys(touchedKeys, eventAggregateKeys)) {
    return { code: 'invalid_command_plan', reason: 'missing_entity_audit_event' };
  }

  return null;
}

async function preflightMutations(
  records: PlanningRecordReader,
  mutations: readonly CanonicalMutation[],
  expectedByEntity: ReadonlyMap<EntityRefKey, number>,
  ownerId: CommandContext['ownerId'],
  undo: DomainChange<unknown>['undo'],
): Promise<ApplicationError | null> {
  const postWriteRevisions = new Map<EntityRefKey, number>();

  for (const mutation of mutations) {
    const key = entityRefKey(mutation.ref);
    const current = await records.read(mutation.ref);

    if (mutation.operation === 'create') {
      if (expectedByEntity.has(key)) {
        return {
          code: 'invalid_command_plan',
          reason: 'invalid_expected_revision',
          ref: mutation.ref,
        };
      }
      if (current !== null) {
        return { code: 'entity_already_exists', ref: mutation.ref };
      }
      if (mutation.baseServerRevision !== 0 || mutation.baseSnapshotHash !== null) {
        return { code: 'invalid_command_plan', reason: 'invalid_sync_base', ref: mutation.ref };
      }
      postWriteRevisions.set(key, 1);
      continue;
    }

    if (current === null) {
      return { code: 'entity_not_found', ref: mutation.ref };
    }
    if (current.ref.ownerId !== ownerId) {
      return { code: 'owner_mismatch' };
    }
    if (current.localRevision !== mutation.expectedRevision) {
      return {
        code: 'revision_conflict',
        ref: mutation.ref,
        expectedRevision: mutation.expectedRevision,
        actualRevision: current.localRevision,
      };
    }
    if (
      current.serverRevision !== mutation.baseServerRevision ||
      current.baseSnapshotHash !== mutation.baseSnapshotHash
    ) {
      return { code: 'invalid_command_plan', reason: 'invalid_sync_base', ref: mutation.ref };
    }
    postWriteRevisions.set(key, current.localRevision + 1);
  }

  if (undo !== undefined) {
    const undoEntries = Object.entries(undo.expectedRevisions) as [EntityRefKey, number][];
    if (
      undoEntries.length !== postWriteRevisions.size ||
      undoEntries.some(([key, revision]) => postWriteRevisions.get(key) !== revision)
    ) {
      return { code: 'invalid_command_plan', reason: 'undo_revision_mismatch' };
    }
  }

  return null;
}

function createOutboxGroup<TInput>(
  dependencies: ApplicationDependencies,
  envelope: CommandEnvelope<TInput>,
  context: CommandContext,
  mutations: readonly CanonicalMutation[],
): OutboxMutationGroup {
  const mutationGroupId = dependencies.ids.next();
  return {
    mutationGroupId,
    ownerId: context.ownerId,
    commandId: context.commandId,
    actor: context.actor,
    createdAt: context.now,
    operations: mutations.map((mutation, sequence) => ({
      operationId: dependencies.ids.next(),
      mutationGroupId,
      sequence,
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: context.now,
      mutation,
    })),
  };
}

function sameKeys(left: ReadonlySet<EntityRefKey>, right: ReadonlySet<EntityRefKey>): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function hasExactDeletionTombstoneShape(value: unknown): boolean {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== deletionTombstoneKeys.length ||
      deletionTombstoneKeys.some((key) => !ownKeys.includes(key))
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return deletionTombstoneKeys.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
    });
  } catch {
    return false;
  }
}

function success<T>(value: T): ApplicationResult<T> {
  return { ok: true, value };
}

function failure<T = never>(error: ApplicationError): ApplicationResult<T> {
  return { ok: false, error };
}
