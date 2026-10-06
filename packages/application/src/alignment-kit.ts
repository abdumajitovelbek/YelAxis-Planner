/**
 * Private helpers shared by the alignment modules (projections, object commands, links, and
 * lifecycle). Like the planning scheduling kit, it resolves the active owner and runs one planned
 * change as one `executeCommand` transaction with minimized audit events and a grouped
 * `planning.restore_v1` undo; it is typed on the alignment query port instead.
 *
 * Generic errors (`rejected`, `rejectInvalid`, `missing`, `changed`, `invalid`) and `expectedOf`
 * live in `planning-scheduling-support.ts` and are shared as they are.
 */
import {
  alignmentLinkEntityType,
  alignmentLinkId,
  createEntityRef,
  entityRefKey,
  err,
  ok,
  parseUUID,
  type AlignmentJoinRelationship,
  type AlignmentLinkEntityType,
  type CommandContext,
  type CommandId,
  type DomainResult,
  type EntityRef,
  type EntityType,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type {
  AlignmentLinkDocument,
  AlignmentQueryPort,
  NoChangeReceipt,
} from './alignment-contracts';
import type {
  ApplicationResult,
  CanonicalMutation,
  CanonicalRecordState,
  CommandReceipt,
  ExpectedRevision,
} from './contracts';
import { executeCommand } from './execute-command';
import {
  applyEventTypes,
  planningChange,
  type CreatedRecord,
  type PlanningEventPayload,
} from './planning-kit';
import type { ApplicationDependencies, PlanningRecordReader } from './ports';

/* ───────────────────────── Command runner ───────────────────────── */

export interface AlignmentCommandPlan {
  readonly mutations: readonly CanonicalMutation[];
  /** Records the command creates, so undo can archive or unlink them. */
  readonly created?: readonly CreatedRecord[];
  /**
   * Minimized event details computed inside the transaction (ids and relationship names only).
   * When present it replaces the `run` option.
   */
  readonly eventPayload?: PlanningEventPayload;
  /**
   * Event type of one changed record when it differs from the command's own, for example
   * `axis.reordered` for the siblings whose order keys a create normalizes, so their history never
   * reads as created. `undefined` keeps the command's event type.
   */
  readonly eventTypeFor?: (mutation: CanonicalMutation) => string | undefined;
}

export type AlignmentPlanner = (request: {
  readonly records: PlanningRecordReader;
  readonly context: CommandContext;
}) => DomainResult<AlignmentCommandPlan> | Promise<DomainResult<AlignmentCommandPlan>>;

export interface AlignmentRunOptions {
  /** Minimized event details for every event of the command, or per changed record. */
  readonly eventPayload?: PlanningEventPayload;
}

export interface AlignmentKit {
  readonly dependencies: ApplicationDependencies;
  readonly queries: AlignmentQueryPort;
  /** The active planning identity; throws when none is active (the UI never calls without one). */
  ownerId(): Promise<OwnerId>;
  readonly nextId: () => UUID;
  /**
   * Run one planned change as one `executeCommand` transaction. `expected` must list every record
   * the plan updates or deletes (duplicates are dropped). An empty plan is refused as `no_change`.
   * Updated records are captured before any write for grouped undo; a plan that deletes anything
   * records no undo.
   */
  run(
    ownerId: OwnerId,
    commandId: CommandId | undefined,
    eventType: string,
    expected: readonly ExpectedRevision[],
    planner: AlignmentPlanner,
    options?: AlignmentRunOptions,
  ): Promise<ApplicationResult<CommandReceipt>>;
}

export function createAlignmentKit(
  dependencies: ApplicationDependencies,
  queries: AlignmentQueryPort,
): AlignmentKit {
  const ownerId = async (): Promise<OwnerId> => {
    const active = await dependencies.identityContext.getActiveIdentity();
    if (active === null) throw new Error('No active identity');
    return active.ownerId;
  };
  return {
    dependencies,
    queries,
    ownerId,
    nextId: () => dependencies.ids.next(),
    run(owner, commandId, eventType, expected, planner, options = {}) {
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
          if (planned.value.mutations.length === 0) return noChange();
          const prior: CanonicalRecordState[] = [];
          for (const mutation of planned.value.mutations) {
            if (mutation.operation === 'create') continue;
            const current = await records.read(mutation.ref);
            if (current === null) return recordChanged();
            prior.push(current);
          }
          const eventPayload = planned.value.eventPayload ?? options.eventPayload;
          return ok(
            applyEventTypes(
              planningChange(planned.value.mutations, context, eventType, {
                prior,
                created: planned.value.created ?? [],
                ...(eventPayload === undefined ? {} : { eventPayload }),
              }),
              planned.value.mutations,
              planned.value.eventTypeFor,
            ),
          );
        },
      );
    },
  };
}

function uniqueExpected(expected: readonly ExpectedRevision[]): readonly ExpectedRevision[] {
  const seen = new Set<string>();
  return expected.filter((item) => {
    const key = entityRefKey(item.ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The command would change nothing (never written, never undoable). */
export function noChange(): DomainResult<never> {
  return err({
    code: 'invalid_value',
    message: 'Nothing changed.',
    details: { reason: 'no_change' },
  });
}

function recordChanged(): DomainResult<never> {
  return err({
    code: 'invalid_value',
    message: 'This plan changed. Review it and try again.',
    details: { reason: 'record_missing' },
  });
}

/** Result of linking a pair that is already actively linked: no write and no undo. */
export const alreadyLinked: NoChangeReceipt = Object.freeze({
  status: 'no_change',
  reason: 'already_linked',
});

/** Parse a user-supplied id into an owner-scoped ref; a malformed id is `invalid_uuid`. */
export function parseAlignmentRef<Type extends EntityType>(
  type: Type,
  id: string,
  ownerId: OwnerId,
): DomainResult<EntityRef<Type>> {
  const parsed = parseUUID(id);
  return parsed.ok ? ok(createEntityRef(type, parsed.value, ownerId)) : parsed;
}

/* ───────────────────────── Join links ───────────────────────── */

/** The owner-scoped ref of the one join record of a pair (derived id; see `alignmentLinkId`). */
export function linkRef(
  ownerId: OwnerId,
  relationship: AlignmentJoinRelationship,
  parentId: UUID,
  childId: UUID,
): EntityRef<AlignmentLinkEntityType> {
  return createEntityRef(
    alignmentLinkEntityType(relationship),
    alignmentLinkId(relationship, parentId, childId),
    ownerId,
  );
}

/** The active join document of a pair; parent = Outcome or Milestone, child = Project or Action. */
export function linkDocument(
  relationship: AlignmentJoinRelationship,
  parentId: UUID,
  childId: UUID,
): AlignmentLinkDocument {
  switch (relationship) {
    case 'outcome_secondary_project':
      return { projectId: childId, outcomeId: parentId };
    case 'milestone_project':
      return { milestoneId: parentId, projectId: childId };
    case 'milestone_action':
      return { milestoneId: parentId, actionId: childId };
  }
}

/** Read the endpoints of a stored join document, or null when it is not that relationship's shape. */
export function linkEndpoints(
  relationship: AlignmentJoinRelationship,
  document: Readonly<Record<string, unknown>>,
): { readonly parentId: UUID; readonly childId: UUID } | null {
  const [parentKey, childKey] =
    relationship === 'outcome_secondary_project'
      ? (['outcomeId', 'projectId'] as const)
      : relationship === 'milestone_project'
        ? (['milestoneId', 'projectId'] as const)
        : (['milestoneId', 'actionId'] as const);
  const parent = document[parentKey];
  const child = document[childKey];
  if (typeof parent !== 'string' || typeof child !== 'string') return null;
  const parentId = parseUUID(parent);
  const childId = parseUUID(child);
  return parentId.ok && childId.ok ? { parentId: parentId.value, childId: childId.value } : null;
}

/** Whether a join document is an active link (not unlinked). */
export function isActiveLink(document: Readonly<Record<string, unknown>>): boolean {
  return document['unlinkedAt'] === undefined;
}
