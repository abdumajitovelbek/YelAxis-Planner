/**
 * alignment object commands (part A2): create, edit, progress, and state changes of Axes, Outcomes,
 * Projects, and Milestones, and ordering within their lists, including a Project's Actions
 *
 * Each command is one `executeCommand` transaction run by the alignment kit: expected revisions
 * for every record it changes, audit events that carry the operation only (never titles or other
 * planning text), a receipt, and a grouped `planning.restore_v1` undo (a created object is
 * archived; a changed record gets its prior document back). Input shape and limits are checked
 * before the transaction. Every rule that depends on stored state is checked inside it, after the
 * command-id receipt lookup, so repeating a command id returns the original receipt and a refused
 * command writes nothing. Progress, target dates, order, and time never change a state.
 */
import {
  appendOrderKey,
  compareOrder,
  createEntityRef,
  currentOutcomeStates,
  currentProjectStates,
  err,
  maxOrderedItems,
  needsOrderNormalization,
  ok,
  parseUUID,
  reorderWithin,
  type OrderNormalization,
  spacedOrderKey,
  transitionAlignmentObject,
  validateAlignmentInput,
  validateAlignmentLink,
  validateOutcomeProgressInput,
  type AlignmentKind,
  type AlignmentLifecycleSnapshot,
  type AlignmentRelationship,
  type AlignmentState,
  type CommandId,
  type DomainError,
  type DomainResult,
  type EntityRef,
  type OrderedItem,
  type OrderKeyChange,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type {
  AlignmentContainerRow,
  AlignmentObjectMethods,
  AlignmentResult,
  ReorderScope,
  RevisionRef,
} from './alignment-contracts';
import { noChange, parseAlignmentRef, type AlignmentKit } from './alignment-kit';
import type { CanonicalMutation, ExpectedRevision } from './contracts';
import type {
  AxisDocument,
  MilestoneDocument,
  OutcomeDocument,
  ProjectDocument,
} from './planning-contracts';
import { createMutation, updateFrom } from './planning-kit';
import { changed, isArchivedDocument, missing, rejected } from './planning-scheduling-support';
import type { PlanningRecordReader } from './ports';

type Document = Readonly<Record<string, unknown>>;
type OrderedKind = AlignmentKind | 'action';

/** One row of an ordering container and the order key the command gives it. */
interface OrderChange {
  readonly row: AlignmentContainerRow;
  readonly orderKey: string;
}

/** A parent the created object is linked to; it must exist and must not be archived. */
interface ParentLink {
  readonly ref: EntityRef;
  readonly relationship: AlignmentRelationship;
  /** Replaces the generic "before linking" wording, since this is a create. */
  readonly archivedMessage: string;
}

const labels: Readonly<Record<AlignmentKind, string>> = {
  axis: 'Axis',
  outcome: 'Outcome',
  project: 'Project',
  milestone: 'Milestone',
};

/** The kind of object each ordering container holds. */
const containerKinds: Readonly<Record<ReorderScope['container'], OrderedKind>> = {
  axes: 'axis',
  axis_outcomes: 'outcome',
  axis_projects: 'project',
  outcome_milestones: 'milestone',
  project_actions: 'action',
};

/**
 * Lists with a "Show finished" toggle keep a move among the current rows or among
 * the finished rows, so Move up or Move down always passes a neighbor the person can see. The other
 * lists are one section.
 */
const currentStatesOf: Readonly<Record<ReorderScope['container'], readonly string[] | null>> = {
  axes: null,
  axis_outcomes: currentOutcomeStates,
  axis_projects: currentProjectStates,
  outcome_milestones: null,
  project_actions: null,
};

/* ───────────────────────── Errors ───────────────────────── */

const refuse = (error: DomainError): AlignmentResult => Promise.resolve(rejected(error));

/** The UI only sends ids it has read, so a malformed one means the page is out of date. */
const unavailableId = (field: string): DomainError => ({
  code: 'invalid_uuid',
  message: 'This item is unavailable. Refresh and try again.',
  details: { reason: 'invalid_id', field },
});

const targetKindError: DomainError = {
  code: 'invalid_value',
  message: 'This item cannot be changed here.',
  details: { reason: 'target_kind' },
};

const orderScopeError: DomainError = {
  code: 'invalid_value',
  message: 'This item cannot be moved in that list.',
  details: { reason: 'order_scope' },
};

const directionError: DomainError = {
  code: 'invalid_value',
  message: 'Choose Move up or Move down.',
  details: { reason: 'direction' },
};

const projectStateError: DomainError = {
  code: 'invalid_value',
  message: 'Choose whether the new Project is an idea or active.',
  details: { reason: 'project_state', field: 'state' },
};

const outcomeRequired: DomainError = {
  code: 'invalid_value',
  message: 'Choose the Outcome this Milestone belongs to.',
  details: { reason: 'outcome_required', field: 'outcomeId' },
};

/** A Project that has left `idea` keeps a desired result (the stored-row invariant). */
const desiredResultRequired: DomainError = {
  code: 'invalid_value',
  message: 'Add a desired result. Only a Project that is still an idea can go without one.',
  details: { reason: 'text_required', field: 'desiredResult' },
};

/** An archived object is read-only until it is restored. */
const restoreFirst = (kind: AlignmentKind, change: string): DomainError => ({
  code: 'invalid_value',
  message: `Restore this ${labels[kind]} before ${change}.`,
  details: { reason: 'archived_target' },
});

/* ───────────────────────── Input parsing ───────────────────────── */

function parseId<Type extends OrderedKind>(
  type: Type,
  id: unknown,
  ownerId: OwnerId,
  field: string,
): DomainResult<EntityRef<Type>> {
  if (typeof id !== 'string') return err(unavailableId(field));
  const parsed = parseAlignmentRef(type, id, ownerId);
  return parsed.ok ? parsed : err(unavailableId(field));
}

/** The record a command changes: its kind must match the command and its id must be a UUID. */
function parseTarget(
  kind: AlignmentKind,
  ref: RevisionRef,
  ownerId: OwnerId,
): DomainResult<EntityRef<AlignmentKind>> {
  return ref.kind === kind ? parseId(kind, ref.id, ownerId, 'id') : err(targetKindError);
}

/** An optional parent picked in a form; blank means none. */
function parseParentId<Type extends 'axis' | 'outcome'>(
  type: Type,
  id: string | undefined,
  ownerId: OwnerId,
  field: string,
): DomainResult<EntityRef<Type> | undefined> {
  if (typeof id !== 'string' || id.trim() === '') return ok(undefined);
  return parseId(type, id, ownerId, field);
}

function parseScopeId(value: unknown, field: string): DomainResult<UUID> {
  const parsed = typeof value === 'string' ? parseUUID(value) : null;
  return parsed?.ok === true ? parsed : err(unavailableId(field));
}

/** Normalize the ids of an ordering container; `axisId: null` is "Not in an Axis". */
function parseScope(scope: ReorderScope): DomainResult<ReorderScope> {
  switch (scope.container) {
    case 'axes':
      return ok({ container: 'axes' });
    case 'axis_outcomes':
    case 'axis_projects': {
      if (scope.axisId === null) return ok({ container: scope.container, axisId: null });
      const axisId = parseScopeId(scope.axisId, 'axisId');
      return axisId.ok ? ok({ container: scope.container, axisId: axisId.value }) : axisId;
    }
    case 'outcome_milestones': {
      const outcomeId = parseScopeId(scope.outcomeId, 'outcomeId');
      return outcomeId.ok
        ? ok({ container: scope.container, outcomeId: outcomeId.value })
        : outcomeId;
    }
    case 'project_actions': {
      const projectId = parseScopeId(scope.projectId, 'projectId');
      return projectId.ok
        ? ok({ container: scope.container, projectId: projectId.value })
        : projectId;
    }
    default:
      return err(orderScopeError);
  }
}

/* ───────────────────────── Documents ───────────────────────── */

/** Copy a stored document without the listed optional fields (a form save replaces them). */
function omit<T extends Document, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) Reflect.deleteProperty(copy, key);
  return copy;
}

/** Structural equality of stored JSON documents, for refusing a save that changes nothing. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  const leftRecord = left as Document;
  const rightRecord = right as Document;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

const unlessArchived =
  (kind: AlignmentKind, change: string, build: (document: Document) => DomainResult<Document>) =>
  (document: Document): DomainResult<Document> =>
    isArchivedDocument(document) ? err(restoreFirst(kind, change)) : build(document);

const withState = (document: Document, state: DomainResult<string>): DomainResult<Document> =>
  state.ok ? ok({ ...document, state: state.value }) : state;

/** Objects whose manual state changes share one rule (Axes only archive and restore). */
export type TransitionKind = Exclude<AlignmentKind, 'axis'>;

/** The event type of a manual state change, such as `project.transitioned`. */
export const transitionEventType = (kind: TransitionKind): string => `${kind}.transitioned`;

/**
 * The shared manual state change of an Outcome, Project, or Milestone: the stored
 * document with its next state, or the transition rule's refusal. `transitionOutcome`,
 * `transitionProject`, `transitionMilestone`, and a review's Finish all change state through it.
 */
export function transitionedDocument<K extends TransitionKind>(
  kind: K,
  document: Document,
  to: AlignmentState<K>,
): DomainResult<Document> {
  return withState(
    document,
    transitionAlignmentObject(kind, document as unknown as AlignmentLifecycleSnapshot<K>, to),
  );
}

/* ───────────────────────── Ordering ───────────────────────── */

const orderedItem = (row: AlignmentContainerRow): OrderedItem => ({
  id: row.ref.id,
  orderKey: row.orderKey,
});

const expectedRow = ({ row }: OrderChange): ExpectedRevision => ({
  ref: row.ref,
  revision: row.localRevision,
});

function changesFor(
  rows: readonly AlignmentContainerRow[],
  changes: readonly OrderKeyChange[],
): readonly OrderChange[] {
  const byId = new Map<string, AlignmentContainerRow>(rows.map((row) => [row.ref.id, row]));
  return changes.flatMap((change) => {
    const row = byId.get(change.id);
    return row === undefined ? [] : [{ row, orderKey: change.orderKey }];
  });
}

/**
 * The order keys a move changes. A one-section list follows the domain rule as it is (swap with the
 * neighbor, normalizing onboarding or tied keys first). In a list with a finished section the whole
 * container is normalized the same way when needed, and the swap happens with the nearest row of
 * the target's own section.
 */
function reorderInSection(
  rows: readonly AlignmentContainerRow[],
  targetId: string,
  direction: 'up' | 'down',
  currentStates: readonly string[] | null,
  normalization: OrderNormalization,
): DomainResult<readonly OrderKeyChange[]> {
  const items = rows.map(orderedItem);
  const target = rows.find((row) => row.ref.id === targetId);
  if (currentStates === null || target === undefined || rows.length > maxOrderedItems) {
    return reorderWithin(items, targetId, direction, normalization);
  }
  const isCurrent = (state: string): boolean => currentStates.includes(state);
  const sorted = [...rows].sort((left, right) =>
    compareOrder(orderedItem(left), orderedItem(right)),
  );
  const normalize = needsOrderNormalization(items);
  const keys = new Map<string, string>(
    sorted.map((row, index) => [row.ref.id, normalize ? spacedOrderKey(index) : row.orderKey]),
  );
  const section = sorted
    .filter((row) => isCurrent(row.state) === isCurrent(target.state))
    .map((row) => ({ id: row.ref.id, orderKey: keys.get(row.ref.id) ?? row.orderKey }));
  const swapped = reorderWithin(section, targetId, direction);
  if (!swapped.ok) return swapped;
  for (const change of swapped.value) keys.set(change.id, change.orderKey);
  return ok(
    sorted.flatMap((row) => {
      const orderKey = keys.get(row.ref.id) ?? row.orderKey;
      return orderKey === row.orderKey ? [] : [{ id: row.ref.id, orderKey }];
    }),
  );
}

function planReorder(
  rows: readonly AlignmentContainerRow[],
  targetId: string,
  direction: 'up' | 'down',
  currentStates: readonly string[] | null,
  normalization: OrderNormalization,
): DomainResult<readonly OrderChange[]> {
  const moved = reorderInSection(rows, targetId, direction, currentStates, normalization);
  return moved.ok ? ok(changesFor(rows, moved.value)) : moved;
}

/** Re-read each row inside the transaction and give it its new key; any drift fails closed. */
async function orderUpdates(
  records: PlanningRecordReader,
  changes: readonly OrderChange[],
): Promise<DomainResult<readonly CanonicalMutation[]>> {
  const mutations: CanonicalMutation[] = [];
  for (const { row, orderKey } of changes) {
    const current = await records.read(row.ref);
    if (
      current === null ||
      isArchivedDocument(current.document) ||
      current.document['orderKey'] !== row.orderKey
    ) {
      return changed('order_changed');
    }
    mutations.push(updateFrom(current, { ...current.document, orderKey }));
  }
  return ok(mutations);
}

/* ───────────────────────── Parents ───────────────────────── */

/** The shared link rules decide whether the new object may join this parent (not archived). */
async function parentAvailable(
  records: PlanningRecordReader,
  parent: ParentLink,
  child: EntityRef,
): Promise<DomainResult<true>> {
  const current = await records.read(parent.ref);
  if (current === null) return changed('parent_missing');
  const decision = validateAlignmentLink({
    relationship: parent.relationship,
    parent: parent.ref,
    child,
    parentArchived: isArchivedDocument(current.document),
    childArchived: false,
  });
  if (decision.ok) return ok(true);
  return decision.error.code === 'archived_endpoint'
    ? err({ ...decision.error, message: parent.archivedMessage })
    : decision;
}

/* ───────────────────────── Commands ───────────────────────── */

export function createAlignmentObjectCommands(kit: AlignmentKit): AlignmentObjectMethods {
  const { queries } = kit;

  /** The key that appends after a container's rows, plus any normalization it needs. */
  const appendTo = async (
    ownerId: OwnerId,
    scope: ReorderScope,
  ): Promise<
    DomainResult<{ readonly orderKey: string; readonly normalized: readonly OrderChange[] }>
  > => {
    const rows = await queries.listContainer(ownerId, scope);
    const appended = appendOrderKey(rows.map(orderedItem));
    if (!appended.ok) return appended;
    return ok({
      orderKey: appended.value.orderKey,
      normalized: changesFor(rows, appended.value.changes),
    });
  };

  /**
   * Create one object last in its container. The created record comes first in the receipt; the
   * siblings whose keys the append normalizes are recorded as reordered, never as created.
   */
  const create = async (
    ownerId: OwnerId,
    commandId: CommandId | undefined,
    ref: EntityRef<AlignmentKind>,
    scope: ReorderScope,
    parents: readonly ParentLink[],
    build: (orderKey: string) => Document,
  ): AlignmentResult => {
    for (const parent of parents) {
      if ((await queries.readRecord(ownerId, parent.ref)) === null) return missing(parent.ref);
    }
    const order = await appendTo(ownerId, scope);
    if (!order.ok) return rejected(order.error);
    const kind = ref.type;
    return kit.run(
      ownerId,
      commandId,
      `${kind}.created`,
      order.value.normalized.map(expectedRow),
      async ({ records }) => {
        for (const parent of parents) {
          const available = await parentAvailable(records, parent, ref);
          if (!available.ok) return available;
        }
        const normalized = await orderUpdates(records, order.value.normalized);
        if (!normalized.ok) return normalized;
        return ok({
          mutations: [createMutation(ref, build(order.value.orderKey)), ...normalized.value],
          created: [{ ref, kind }],
          eventTypeFor: (mutation) =>
            mutation.operation === 'update' ? `${kind}.reordered` : undefined,
        });
      },
    );
  };

  /** Change one existing record; a result equal to the stored document is refused as no change. */
  const changeOne = async (
    kind: AlignmentKind,
    ref: RevisionRef,
    commandId: CommandId | undefined,
    eventType: string,
    next: (document: Document) => DomainResult<Document>,
  ): AlignmentResult => {
    const ownerId = await kit.ownerId();
    const target = parseTarget(kind, ref, ownerId);
    if (!target.ok) return rejected(target.error);
    return kit.run(
      ownerId,
      commandId,
      eventType,
      [{ ref: target.value, revision: ref.revision }],
      async ({ records }) => {
        const current = await records.read(target.value);
        if (current === null) return changed('target_missing');
        const document = next(current.document);
        if (!document.ok) return document;
        return sameValue(document.value, current.document)
          ? noChange()
          : ok({ mutations: [updateFrom(current, document.value)] });
      },
    );
  };

  return {
    async createAxis(input, commandId) {
      const fields = validateAlignmentInput('axis', input);
      if (!fields.ok) return rejected(fields.error);
      const ownerId = await kit.ownerId();
      return create(
        ownerId,
        commandId,
        createEntityRef('axis', kit.nextId(), ownerId),
        { container: 'axes' },
        [],
        (orderKey) => ({ ...fields.value, orderKey, state: 'active' }) satisfies AxisDocument,
      );
    },

    editAxis(ref, input, commandId) {
      const fields = validateAlignmentInput('axis', input);
      if (!fields.ok) return refuse(fields.error);
      return changeOne(
        'axis',
        ref,
        commandId,
        'axis.edited',
        unlessArchived('axis', 'editing it', (document) =>
          ok({
            ...omit(document as AxisDocument, ['purpose', 'color', 'icon']),
            ...fields.value,
          } satisfies AxisDocument),
        ),
      );
    },

    async createOutcome(input, commandId) {
      const fields = validateAlignmentInput('outcome', input);
      if (!fields.ok) return rejected(fields.error);
      const progress = validateOutcomeProgressInput(input.progress ?? { mode: 'none' });
      if (!progress.ok) return rejected(progress.error);
      const ownerId = await kit.ownerId();
      const axis = parseParentId('axis', input.axisId, ownerId, 'axisId');
      if (!axis.ok) return rejected(axis.error);
      const axisId = axis.value?.id;
      return create(
        ownerId,
        commandId,
        createEntityRef('outcome', kit.nextId(), ownerId),
        { container: 'axis_outcomes', axisId: axisId ?? null },
        axis.value === undefined
          ? []
          : [
              {
                ref: axis.value,
                relationship: 'axis_outcome',
                archivedMessage: 'Restore this Axis before adding an Outcome to it.',
              },
            ],
        (orderKey) =>
          ({
            ...fields.value,
            ...(axisId === undefined ? {} : { axisId }),
            progress: progress.value,
            orderKey,
            state: 'active',
          }) satisfies OutcomeDocument,
      );
    },

    editOutcome(ref, input, commandId) {
      const fields = validateAlignmentInput('outcome', input);
      if (!fields.ok) return refuse(fields.error);
      return changeOne(
        'outcome',
        ref,
        commandId,
        'outcome.edited',
        unlessArchived('outcome', 'editing it', (document) =>
          ok({
            ...omit(document as OutcomeDocument, ['targetStart', 'targetEnd']),
            ...fields.value,
          } satisfies OutcomeDocument),
        ),
      );
    },

    setOutcomeProgress(ref, progress, commandId) {
      const normalized = validateOutcomeProgressInput(progress);
      if (!normalized.ok) return refuse(normalized.error);
      return changeOne(
        'outcome',
        ref,
        commandId,
        'outcome.progress_set',
        unlessArchived('outcome', 'changing its progress', (document) =>
          ok({
            ...(document as OutcomeDocument),
            progress: normalized.value,
          } satisfies OutcomeDocument),
        ),
      );
    },

    transitionOutcome(ref, to, commandId) {
      return changeOne('outcome', ref, commandId, transitionEventType('outcome'), (document) =>
        transitionedDocument('outcome', document, to),
      );
    },

    async createProject(input, commandId) {
      const fields = validateAlignmentInput('project', input);
      if (!fields.ok) return rejected(fields.error);
      const state = input.state ?? 'idea';
      if (state !== 'idea' && state !== 'active') return rejected(projectStateError);
      if (state === 'active') {
        const activated = transitionAlignmentObject(
          'project',
          { state: 'idea', desiredResult: fields.value.desiredResult },
          'active',
        );
        if (!activated.ok) return rejected(activated.error);
      }
      const ownerId = await kit.ownerId();
      const axis = parseParentId('axis', input.axisId, ownerId, 'axisId');
      if (!axis.ok) return rejected(axis.error);
      const primary = parseParentId('outcome', input.primaryOutcomeId, ownerId, 'primaryOutcomeId');
      if (!primary.ok) return rejected(primary.error);
      const axisId = axis.value?.id;
      const primaryOutcomeId = primary.value?.id;
      const parents: ParentLink[] = [];
      if (axis.value !== undefined) {
        parents.push({
          ref: axis.value,
          relationship: 'axis_project',
          archivedMessage: 'Restore this Axis before adding a Project to it.',
        });
      }
      if (primary.value !== undefined) {
        parents.push({
          ref: primary.value,
          relationship: 'outcome_primary_project',
          archivedMessage: 'Restore this Outcome before adding a Project to it.',
        });
      }
      return create(
        ownerId,
        commandId,
        createEntityRef('project', kit.nextId(), ownerId),
        { container: 'axis_projects', axisId: axisId ?? null },
        parents,
        (orderKey) =>
          ({
            ...fields.value,
            ...(axisId === undefined ? {} : { axisId }),
            ...(primaryOutcomeId === undefined ? {} : { primaryOutcomeId }),
            orderKey,
            state,
          }) satisfies ProjectDocument,
      );
    },

    editProject(ref, input, commandId) {
      const fields = validateAlignmentInput('project', input);
      if (!fields.ok) return refuse(fields.error);
      return changeOne(
        'project',
        ref,
        commandId,
        'project.edited',
        unlessArchived('project', 'editing it', (document) => {
          const next = {
            ...omit(document as ProjectDocument, [
              'desiredResult',
              'description',
              'notes',
              'targetStart',
              'targetEnd',
            ]),
            ...fields.value,
          } satisfies ProjectDocument;
          return next.state !== 'idea' && next.desiredResult === undefined
            ? err(desiredResultRequired)
            : ok(next);
        }),
      );
    },

    transitionProject(ref, to, commandId) {
      return changeOne('project', ref, commandId, transitionEventType('project'), (document) =>
        transitionedDocument('project', document, to),
      );
    },

    async createMilestone(input, commandId) {
      const fields = validateAlignmentInput('milestone', input);
      if (!fields.ok) return rejected(fields.error);
      const ownerId = await kit.ownerId();
      const outcome = parseParentId('outcome', input.outcomeId, ownerId, 'outcomeId');
      if (!outcome.ok) return rejected(outcome.error);
      if (outcome.value === undefined) return rejected(outcomeRequired);
      const outcomeId = outcome.value.id;
      return create(
        ownerId,
        commandId,
        createEntityRef('milestone', kit.nextId(), ownerId),
        { container: 'outcome_milestones', outcomeId },
        [
          {
            ref: outcome.value,
            relationship: 'outcome_milestone',
            archivedMessage: 'Restore this Outcome before adding a Milestone to it.',
          },
        ],
        (orderKey) =>
          ({ ...fields.value, outcomeId, orderKey, state: 'active' }) satisfies MilestoneDocument,
      );
    },

    editMilestone(ref, input, commandId) {
      const fields = validateAlignmentInput('milestone', input);
      if (!fields.ok) return refuse(fields.error);
      return changeOne(
        'milestone',
        ref,
        commandId,
        'milestone.edited',
        unlessArchived('milestone', 'editing it', (document) =>
          ok({
            ...omit(document as MilestoneDocument, ['targetStart', 'targetEnd']),
            ...fields.value,
          } satisfies MilestoneDocument),
        ),
      );
    },

    transitionMilestone(ref, to, commandId) {
      return changeOne('milestone', ref, commandId, transitionEventType('milestone'), (document) =>
        transitionedDocument('milestone', document, to),
      );
    },

    async reorder(input, commandId) {
      if (input.direction !== 'up' && input.direction !== 'down') return rejected(directionError);
      const scope = parseScope(input.scope);
      if (!scope.ok) return rejected(scope.error);
      const kind = containerKinds[scope.value.container];
      if (input.target.kind !== kind) return rejected(orderScopeError);
      const ownerId = await kit.ownerId();
      const target = parseId(kind, input.target.id, ownerId, 'id');
      if (!target.ok) return rejected(target.error);
      const rows = await queries.listContainer(ownerId, scope.value);
      const planned = planReorder(
        rows,
        target.value.id,
        input.direction,
        currentStatesOf[scope.value.container],
        // Project Actions share the Actions' Inbox/Backlog keys: ties are broken in place so no
        // Action jumps to another region of those lists.
        scope.value.container === 'project_actions' ? 'in_place' : 'spaced',
      );
      // A refused move still goes through the command so a repeated command id gets its receipt.
      return kit.run(
        ownerId,
        commandId,
        `${kind}.reordered`,
        [
          { ref: target.value, revision: input.target.revision },
          ...(planned.ok ? planned.value.map(expectedRow) : []),
        ],
        async ({ records }) => {
          if (!planned.ok) return planned;
          const mutations = await orderUpdates(records, planned.value);
          return mutations.ok ? ok({ mutations: mutations.value }) : mutations;
        },
      );
    },
  };
}
