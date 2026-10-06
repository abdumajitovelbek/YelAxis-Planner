/**
 * Alignment lifecycle commands: archive, restore, and permanent delete of Axes, Outcomes,
 * Projects, and Milestones, with their impact previews.
 *
 * Archive changes only the target's state: no cascade, no unlink, and its placement stays for
 * restore. Restore returns to the recorded state, or the documented fallback. Permanent delete is
 * restrict by default, needs the exact current title, and is never undoable. `unlink_and_delete`
 * clears optional foreign keys on other records and removes join rows, placements, and selections;
 * it never deletes another domain object. The target's own history rows (unlinked join rows,
 * archived placements and selections) always go with it, as the preview discloses. Review
 * decisions that name the target are kept under every policy: only their reference is cleared, so
 * history shows "Deleted object" (placement contract, permanent delete rule 6). Routine action
 * defaults still block it.
 */
import {
  alignmentKinds,
  alignmentLiveStates,
  alignmentRelationshipRules,
  createEntityRef,
  entityRefKey,
  err,
  isAlignmentRelationship,
  ok,
  parseUUID,
  previewPermanentDelete,
  previewRestore as previewRestoreBlockers,
  restoreAlignmentState,
  transitionLifecycle,
  validateDeleteConfirmation,
  type AlignmentJoinRelationship,
  type AlignmentKind,
  type AlignmentLifecycleSnapshot,
  type AlignmentNodeKind,
  type DomainError,
  type DomainResult,
  type EntityRef,
  type EntityType,
  type Instant,
  type LifecycleState,
  type OwnerId,
  type PermanentDeleteBlocker,
  type PermanentDeletePolicy,
  type PermanentDeletePreview,
} from '@yelaxis/domain';

import type {
  AlignmentLifecycleMethods,
  AlignmentNode,
  Bounded,
  DeleteImpactRecords,
  DeleteReferrerRelationship,
  ImpactItem,
} from './alignment-contracts';
import { linkEndpoints, type AlignmentKit } from './alignment-kit';
import type {
  ApplicationResult,
  CanonicalMutation,
  CanonicalRecordState,
  ExpectedRevision,
} from './contracts';
import { deleteFrom, updateFrom, without, type PlanningEventDetails } from './planning-kit';
import { changed, isArchivedDocument, rejected } from './planning-scheduling-support';
import type { ReviewItemTargetDocument } from './review-contracts';

type Doc = Readonly<Record<string, unknown>>;

/** Preview lists show at most this many items, with the full total. */
const maxListed = 200;

const kindLabels: Readonly<Record<AlignmentKind, string>> = {
  axis: 'Axis',
  outcome: 'Outcome',
  project: 'Project',
  milestone: 'Milestone',
};

const nodeKinds: readonly string[] = [
  'axis',
  'outcome',
  'project',
  'milestone',
  'action',
  'routine',
  'note',
];

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const titleOf = (document: Doc): string => text(document['title']) ?? text(document['body']) ?? '';

const isAlignmentKind = (value: unknown): value is AlignmentKind =>
  typeof value === 'string' && (alignmentKinds as readonly string[]).includes(value);

const isNodeKind = (value: EntityType): value is AlignmentNodeKind => nodeKinds.includes(value);

const alignmentNode = (kind: AlignmentNodeKind, record: CanonicalRecordState): AlignmentNode => ({
  id: record.ref.id,
  kind,
  title: titleOf(record.document),
  state: text(record.document['state']) ?? 'active',
  archived: isArchivedDocument(record.document),
  localRevision: record.localRevision,
});

/* ───────────────────────── Targets ───────────────────────── */

/** A malformed id names nothing the person can act on. */
const unavailable = (): DomainError => ({
  code: 'invalid_uuid',
  message: 'That item is no longer available.',
  details: { reason: 'invalid_id' },
});

const unsupportedKind = (): DomainError => ({
  code: 'invalid_value',
  message: 'This item cannot be changed here.',
  details: { reason: 'kind' },
});

interface Target {
  readonly kind: AlignmentKind;
  readonly ref: EntityRef<AlignmentKind>;
}

function parseTarget(
  target: { readonly kind: unknown; readonly id: unknown },
  ownerId: OwnerId,
): DomainResult<Target> {
  if (!isAlignmentKind(target.kind)) return err(unsupportedKind());
  const id = typeof target.id === 'string' ? parseUUID(target.id) : null;
  if (id?.ok !== true) return err(unavailable());
  return ok({ kind: target.kind, ref: createEntityRef(target.kind, id.value, ownerId) });
}

/** The owner-scoped record behind a preview request, or null for a malformed or unknown one. */
async function readTarget(
  kit: AlignmentKit,
  target: { readonly kind: unknown; readonly id: unknown },
): Promise<(Target & { readonly ownerId: OwnerId; readonly record: CanonicalRecordState }) | null> {
  const ownerId = await kit.ownerId();
  const parsed = parseTarget(target, ownerId);
  if (!parsed.ok) return null;
  const record = await kit.queries.readRecord(ownerId, parsed.value.ref);
  return record === null ? null : { ...parsed.value, ownerId, record };
}

/* ───────────────────────── Archive and restore ───────────────────────── */

const lifecycleSnapshot = (document: Doc): AlignmentLifecycleSnapshot => ({
  state: document['state'] as AlignmentLifecycleSnapshot['state'],
  stateBeforeArchive: document[
    'stateBeforeArchive'
  ] as AlignmentLifecycleSnapshot['stateBeforeArchive'],
  desiredResult: text(document['desiredResult']),
});

const alreadyArchived = (kind: AlignmentKind): DomainError => ({
  code: 'invalid_transition',
  message: `This ${kindLabels[kind]} is already archived.`,
  details: { reason: 'already_archived', entityType: kind },
});

/** The event type of an archive, such as `outcome.archived`. */
export const archiveEventType = (kind: AlignmentKind): string => `${kind}.archived`;

/**
 * The shared archive rule: only the target changes — no cascade, no unlink, and its
 * placement stays for restore. It records the prior live state. `archive` and a review's Finish
 * archive through it, inside their command transactions.
 */
export function planAlignmentArchive(
  kind: AlignmentKind,
  current: CanonicalRecordState,
  now: Instant,
): DomainResult<CanonicalMutation> {
  const state = text(current.document['state']);
  if (state === 'archived' || current.document['archivedAt'] !== undefined) {
    return err(alreadyArchived(kind));
  }
  const live: readonly string[] = alignmentLiveStates[kind];
  if (state === undefined || !live.includes(state)) return changed('archive_state');
  const archived = transitionLifecycle({
    entityType: kind,
    current: { state: state as LifecycleState },
    to: 'archived',
  });
  if (!archived.ok) return archived;
  // Only the target changes: children, links, and its placement stay as they are.
  return ok(
    updateFrom(current, {
      ...current.document,
      state: 'archived',
      stateBeforeArchive: state,
      archivedAt: now,
    }),
  );
}

const parentUnavailable = (): DomainError => ({
  code: 'required_relationship',
  message: 'Its Outcome is no longer available, so this Milestone cannot be restored.',
  details: { reason: 'required_parent_missing' },
});

/** A Milestone always has its Outcome (restrict foreign key); restore still re-checks it. */
async function milestoneParentMissing(
  read: (ref: EntityRef) => Promise<CanonicalRecordState | null>,
  ownerId: OwnerId,
  document: Doc,
): Promise<boolean> {
  const outcomeId = text(document['outcomeId']);
  const parsed = outcomeId === undefined ? null : parseUUID(outcomeId);
  if (parsed?.ok !== true) return true;
  return (await read(createEntityRef('outcome', parsed.value, ownerId))) === null;
}

/** Archive keeps the placement; the preview says so only when there is one. */
async function hasActivePlacement(
  kit: AlignmentKit,
  ownerId: OwnerId,
  target: Target,
): Promise<boolean> {
  const id = target.ref.id;
  switch (target.kind) {
    case 'axis':
      return false;
    case 'outcome':
      return (await kit.queries.getOutcome(ownerId, id, 1))?.outcome.placement !== undefined;
    case 'project':
      return (
        (await kit.queries.getProject(ownerId, id, { actionLimit: 1, limit: 1 }))?.project
          .placement !== undefined
      );
    case 'milestone':
      return (await kit.queries.getMilestone(ownerId, id, 1))?.milestone.placement !== undefined;
  }
}

/* ───────────────────────── Permanent delete ───────────────────────── */

const joinRelationshipByType: Readonly<Partial<Record<EntityType, AlignmentJoinRelationship>>> = {
  project_secondary_outcome: 'outcome_secondary_project',
  milestone_project: 'milestone_project',
  milestone_action: 'milestone_action',
};

const joinRelationshipOf = (type: EntityType): AlignmentJoinRelationship | null =>
  joinRelationshipByType[type] ?? null;

/** The foreign key a referrer holds for the target, or null when it is not an optional one. */
const referrerForeignKey = (relationship: DeleteReferrerRelationship): string | null => {
  if (relationship === 'axis_action' || relationship === 'axis_note') return 'axisId';
  if (!isAlignmentRelationship(relationship)) return null;
  const rule = alignmentRelationshipRules[relationship];
  return rule.storage === 'fk' && !rule.required ? rule.foreignKey : null;
};

/* ───────────────────────── Review decisions kept ───────────────────────── */

/** Event type of a review item whose target was permanently deleted. */
export const reviewTargetClearedEventType = 'review_item.target_cleared';

/** Kinds whose permanent delete keeps the review decisions that name them. */
type ReviewedKind = 'axis' | 'outcome' | 'project' | 'milestone' | 'action';

const reviewedKinds: readonly string[] = ['axis', 'outcome', 'project', 'milestone', 'action'];

const isReviewedKind = (value: string): value is ReviewedKind => reviewedKinds.includes(value);

/** Whether a review item record (same owner) still names the target. */
export function reviewItemNames(item: CanonicalRecordState, target: EntityRef): boolean {
  const named: unknown = item.document['target'];
  if (
    item.ref.type !== 'review_item' ||
    item.ref.ownerId !== target.ownerId ||
    !isReviewedKind(target.type) ||
    typeof named !== 'object' ||
    named === null
  ) {
    return false;
  }
  const document = named as Doc;
  return document['kind'] === target.type && document[`${target.type}Id`] === target.id;
}

/**
 * Keep a review decision whose target is permanently deleted (placement contract,
 * permanent delete rule 6): the same document with only its target replaced by
 * `{ kind: 'deleted', deletedKind, deletedAt }`. The decision, its note, its order, and its review
 * stay; no title or body of the deleted object is copied anywhere. Null when the item no longer
 * names the target.
 */
export function clearReviewItemTarget(
  item: CanonicalRecordState,
  target: EntityRef,
  now: Instant,
): CanonicalMutation | null {
  if (!isReviewedKind(target.type) || !reviewItemNames(item, target)) return null;
  const cleared: ReviewItemTargetDocument = {
    kind: 'deleted',
    deletedKind: target.type,
    deletedAt: now,
  };
  return updateFrom(item, { ...item.document, target: cleared });
}

/** Review item rows naming the target that this command cannot clear (a sync tombstone). */
const unclearedReviewReferences = (impact: DeleteImpactRecords): number =>
  Math.max(0, impact.reviewReferences - impact.reviewItems.length);

/**
 * How many kept review decisions review history lists, counted as its `decision_count` is: items
 * that are not a removed choice, in a review that is not archived (an Undo archives a review it
 * created). The others lose their reference too, but nothing shows them, so the preview never
 * counts them.
 */
async function listedReviewDecisions(
  kit: AlignmentKit,
  ownerId: OwnerId,
  items: readonly CanonicalRecordState[],
): Promise<number> {
  const listedReviews = new Map<string, boolean>();
  let count = 0;
  for (const item of items) {
    const reviewId: unknown = item.document['reviewId'];
    const parsed = typeof reviewId === 'string' ? parseUUID(reviewId) : null;
    if (isArchivedDocument(item.document) || parsed === null || !parsed.ok) continue;
    let listed = listedReviews.get(parsed.value);
    if (listed === undefined) {
      // Sequential reads: the browser owns one SQLite worker connection.
      const review = await kit.queries.readRecord(
        ownerId,
        createEntityRef('review', parsed.value, ownerId),
      );
      listed = review !== null && !isArchivedDocument(review.document);
      listedReviews.set(parsed.value, listed);
    }
    if (listed) count += 1;
  }
  return count;
}

function deleteDecision(
  ref: EntityRef,
  impact: DeleteImpactRecords,
  policy: PermanentDeletePolicy,
): PermanentDeletePreview {
  return previewPermanentDelete(
    {
      target: ref,
      optionalRelationshipCount: impact.optionalReferrers.length + impact.activeLinks.length,
      requiredChildCount: impact.requiredChildren.total,
      placementCount: impact.activePlacements.length,
      selectionCount: impact.activeSelections.length,
      // Reminders cannot target Axes, Outcomes, Projects, or Milestones.
      reminderCount: 0,
      hasOpenConflict: impact.openConflict,
      hasPendingMutation: impact.pendingMutation,
      historyReferenceCount:
        impact.inactiveLinks.length +
        impact.archivedPlacements.length +
        impact.archivedSelections.length,
      // Review decisions stay as "Deleted object"; Routine defaults still block.
      keptHistoryReferenceCount: impact.reviewItems.length,
      blockingHistoryReferenceCount:
        impact.routineDefaultReferences + unclearedReviewReferences(impact),
    },
    policy,
  );
}

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

function deleteBlockedMessage(
  kind: AlignmentKind,
  blockers: readonly PermanentDeleteBlocker[],
  impact: DeleteImpactRecords,
): string {
  const label = kindLabels[kind];
  if (blockers.includes('required_children')) {
    return `This ${label} still owns ${plural(impact.requiredChildren.total, 'milestone')}. Move or delete each one first.`;
  }
  if (blockers.includes('history_references')) {
    return impact.routineDefaultReferences > 0
      ? `Routine defaults still refer to this ${label}. Archive it instead to keep that history.`
      : `Some history still refers to this ${label}. Archive it instead to keep that history.`;
  }
  if (blockers.includes('open_conflict')) {
    return `This ${label} has a sync conflict. Resolve it before deleting.`;
  }
  if (blockers.includes('pending_mutation')) {
    return `This ${label} has changes that have not synced yet. Try again after they sync.`;
  }
  return `This ${label} is still linked to other items or placed in your plan. Remove those first, or choose to remove them with it.`;
}

const deleteRestricted = (
  kind: AlignmentKind,
  blockers: readonly PermanentDeleteBlocker[],
  impact: DeleteImpactRecords,
): DomainError => ({
  code: 'delete_restricted',
  message: deleteBlockedMessage(kind, blockers, impact),
  details: { reason: 'delete_restricted', blockers: [...blockers] },
});

/** One record whose optional foreign keys to the target are cleared. */
interface FieldClear {
  readonly record: CanonicalRecordState;
  readonly foreignKeys: readonly string[];
  readonly details: PlanningEventDetails;
}

/** One record deleted with the target. */
interface Removal {
  readonly record: CanonicalRecordState;
  readonly details?: PlanningEventDetails;
}

interface DeletePlan {
  readonly clears: readonly FieldClear[];
  /** Review items kept with their reference cleared, under every policy. */
  readonly reviewItems: readonly CanonicalRecordState[];
  readonly removals: readonly Removal[];
}

/**
 * Every write of one permanent delete, in order: cleared foreign keys, kept review decisions with
 * their reference cleared, then join rows, placements, and selections (active ones only under
 * `unlink_and_delete`), then the target. Null when the port reported a referrer or review item this
 * command cannot clear, so nothing is written.
 */
function planDelete(
  target: EntityRef,
  impact: DeleteImpactRecords,
  policy: PermanentDeletePolicy,
): DeletePlan | null {
  if (!impact.reviewItems.every((item) => reviewItemNames(item, target))) return null;
  const unlink = policy === 'unlink_and_delete';
  const clears = new Map<string, FieldClear>();
  for (const referrer of unlink ? impact.optionalReferrers : []) {
    const foreignKey = referrerForeignKey(referrer.relationship);
    if (foreignKey === null) return null;
    const key = entityRefKey(referrer.record.ref);
    const existing = clears.get(key);
    clears.set(key, {
      record: referrer.record,
      foreignKeys: [...(existing?.foreignKeys ?? []), foreignKey],
      details: existing?.details ?? {
        ...(isAlignmentRelationship(referrer.relationship)
          ? { relationship: referrer.relationship }
          : {}),
        previousId: target.id,
      },
    });
  }
  const links = [...(unlink ? impact.activeLinks : []), ...impact.inactiveLinks];
  const removals: Removal[] = [];
  for (const link of links) {
    const relationship = joinRelationshipOf(link.ref.type);
    if (relationship === null) return null;
    removals.push({ record: link, details: { relationship } });
  }
  for (const record of [
    ...(unlink ? impact.activePlacements : []),
    ...impact.archivedPlacements,
    ...(unlink ? impact.activeSelections : []),
    ...impact.archivedSelections,
  ])
    removals.push({ record });
  return { clears: [...clears.values()], reviewItems: impact.reviewItems, removals };
}

/** The other endpoint of one of the target's active join rows, as the preview lists it. */
async function linkImpactItem(
  kit: AlignmentKit,
  ownerId: OwnerId,
  target: EntityRef,
  link: CanonicalRecordState,
): Promise<ImpactItem | null> {
  const relationship = joinRelationshipOf(link.ref.type);
  if (relationship === null) return null;
  const endpoints = linkEndpoints(relationship, link.document);
  if (endpoints === null) return null;
  const rule = alignmentRelationshipRules[relationship];
  const targetIsParent = rule.parentKind === target.type && endpoints.parentId === target.id;
  const kind = targetIsParent ? rule.childKind : rule.parentKind;
  const id = targetIsParent ? endpoints.childId : endpoints.parentId;
  const other = await kit.queries.readRecord(ownerId, createEntityRef(kind, id, ownerId));
  return {
    kind,
    id,
    ...(other === null ? {} : { title: titleOf(other.document) }),
    relationship,
    archived: other !== null && isArchivedDocument(other.document),
  };
}

/** What `unlink_and_delete` would remove, in the order the command writes it. */
async function optionalLinkItems(
  kit: AlignmentKit,
  ownerId: OwnerId,
  target: EntityRef,
  impact: DeleteImpactRecords,
): Promise<Bounded<ImpactItem>> {
  const items: ImpactItem[] = [];
  for (const referrer of impact.optionalReferrers) {
    if (items.length >= maxListed) break;
    const type = referrer.record.ref.type;
    if (!isNodeKind(type)) continue;
    items.push({
      kind: type,
      id: referrer.record.ref.id,
      title: referrer.title ?? titleOf(referrer.record.document),
      relationship: referrer.relationship,
      archived: isArchivedDocument(referrer.record.document),
    });
  }
  for (const link of impact.activeLinks) {
    if (items.length >= maxListed) break;
    const item = await linkImpactItem(kit, ownerId, target, link);
    if (item !== null) items.push(item);
  }
  const placed: readonly (readonly ['placement' | 'selection', CanonicalRecordState])[] = [
    ...impact.activePlacements.map((record) => ['placement', record] as const),
    ...impact.activeSelections.map((record) => ['selection', record] as const),
  ];
  for (const [kind, record] of placed) {
    if (items.length >= maxListed) break;
    items.push({ kind, id: record.ref.id, archived: false });
  }
  return {
    items,
    total:
      impact.optionalReferrers.length +
      impact.activeLinks.length +
      impact.activePlacements.length +
      impact.activeSelections.length,
  };
}

const revisionConflict = (
  ref: EntityRef,
  expectedRevision: number,
  actualRevision: number,
): ApplicationResult<never> => ({
  ok: false,
  error: { code: 'revision_conflict', ref, expectedRevision, actualRevision },
});

const isPolicy = (value: unknown): value is PermanentDeletePolicy =>
  value === 'restrict' || value === 'unlink_and_delete';

/* ───────────────────────── Commands ───────────────────────── */

export function createAlignmentLifecycleCommands(kit: AlignmentKit): AlignmentLifecycleMethods {
  return {
    async previewArchive(target) {
      const found = await readTarget(kit, target);
      if (found === null) return null;
      const activeChildren = await kit.queries.getArchiveImpact(found.ownerId, found.ref);
      return {
        target: alignmentNode(found.kind, found.record),
        activeChildren,
        placementKept: await hasActivePlacement(kit, found.ownerId, found),
        remindersToDisable: 0,
      };
    },

    async previewRestore(target) {
      const found = await readTarget(kit, target);
      if (found === null) return null;
      const restored = restoreAlignmentState(found.kind, lifecycleSnapshot(found.record.document));
      if (!restored.ok) {
        return {
          allowed: false,
          blockers: [],
          restoresTo: text(found.record.document['state']) ?? '',
        };
      }
      const decision = previewRestoreBlockers({
        requiredParentMissing:
          found.kind === 'milestone' &&
          (await milestoneParentMissing(
            (ref) => kit.queries.readRecord(found.ownerId, ref),
            found.ownerId,
            found.record.document,
          )),
        periodInvalid: false,
        constraintConflict: false,
      });
      return { allowed: decision.allowed, blockers: decision.blockers, restoresTo: restored.value };
    },

    async previewDelete(target, policy) {
      const found = await readTarget(kit, target);
      if (found === null) return null;
      const chosen: PermanentDeletePolicy =
        policy === 'unlink_and_delete' ? 'unlink_and_delete' : 'restrict';
      const impact = await kit.queries.getDeleteImpact(found.ownerId, found.ref);
      const decision = deleteDecision(found.ref, impact, chosen);
      return {
        target: alignmentNode(found.kind, found.record),
        policy: chosen,
        allowed: decision.allowed,
        blockers: decision.blockers,
        requiredChildren: {
          items: impact.requiredChildren.items.slice(0, maxListed).map((child): ImpactItem => ({
            kind: 'milestone',
            id: child.id,
            title: child.title,
            relationship: 'outcome_milestone',
            archived: child.archived,
          })),
          total: impact.requiredChildren.total,
        },
        optionalLinks: await optionalLinkItems(kit, found.ownerId, found.ref, impact),
        placements: impact.activePlacements.length,
        selections: impact.activeSelections.length,
        historyReferences: {
          reviews: await listedReviewDecisions(kit, found.ownerId, impact.reviewItems),
          routineDefaults: impact.routineDefaultReferences,
        },
        removedHistory: {
          inactiveLinks: impact.inactiveLinks.length,
          archivedPlacements: impact.archivedPlacements.length,
          archivedSelections: impact.archivedSelections.length,
        },
        pendingSync: impact.pendingMutation,
        openConflict: impact.openConflict,
        confirmationText: titleOf(found.record.document),
      };
    },

    async archive(target, commandId) {
      const ownerId = await kit.ownerId();
      const parsed = parseTarget(target, ownerId);
      if (!parsed.ok) return rejected(parsed.error);
      const { kind, ref } = parsed.value;
      return kit.run(
        ownerId,
        commandId,
        archiveEventType(kind),
        [{ ref, revision: target.revision }],
        async ({ records, context }) => {
          const current = await records.read(ref);
          if (current === null) return changed('archive_target_missing');
          const mutation = planAlignmentArchive(kind, current, context.now);
          return mutation.ok ? ok({ mutations: [mutation.value] }) : mutation;
        },
      );
    },

    async restore(target, commandId) {
      const ownerId = await kit.ownerId();
      const parsed = parseTarget(target, ownerId);
      if (!parsed.ok) return rejected(parsed.error);
      const { kind, ref } = parsed.value;
      return kit.run(
        ownerId,
        commandId,
        `${kind}.restored`,
        [{ ref, revision: target.revision }],
        async ({ records }) => {
          const current = await records.read(ref);
          if (current === null) return changed('restore_target_missing');
          const restored = restoreAlignmentState(kind, lifecycleSnapshot(current.document));
          if (!restored.ok) return restored;
          if (
            kind === 'milestone' &&
            (await milestoneParentMissing(
              (parent) => records.read(parent),
              ownerId,
              current.document,
            ))
          ) {
            return err(parentUnavailable());
          }
          const next = without(without(current.document, 'stateBeforeArchive'), 'archivedAt');
          return ok({ mutations: [updateFrom(current, { ...next, state: restored.value })] });
        },
      );
    },

    async deletePermanently(input, commandId) {
      const ownerId = await kit.ownerId();
      const parsed = parseTarget(input.target, ownerId);
      if (!parsed.ok) return rejected(parsed.error);
      const policy: unknown = input.policy;
      if (!isPolicy(policy)) {
        return rejected({
          code: 'invalid_value',
          message: 'Choose how to delete this item.',
          details: { reason: 'policy' },
        });
      }
      const { kind, ref } = parsed.value;
      const revision = input.target.revision;
      const eventType = `${kind}.deleted`;
      const record = await kit.queries.readRecord(ownerId, ref);
      if (record === null) {
        // Already gone: a repeated command id still returns its receipt; otherwise not found.
        return kit.run(ownerId, commandId, eventType, [{ ref, revision }], () =>
          changed('delete_target_missing'),
        );
      }
      if (record.localRevision !== revision) {
        return revisionConflict(ref, revision, record.localRevision);
      }
      const confirmed = validateDeleteConfirmation(titleOf(record.document), input.confirmation);
      if (!confirmed.ok) return rejected(confirmed.error);
      const impact = await kit.queries.getDeleteImpact(ownerId, ref);
      const decision = deleteDecision(ref, impact, policy);
      if (!decision.allowed) return rejected(deleteRestricted(kind, decision.blockers, impact));
      const plan = planDelete(ref, impact, policy);
      if (plan === null) {
        return rejected({
          code: 'delete_restricted',
          message: `This ${kindLabels[kind]} cannot be deleted safely right now. Archive it instead.`,
          details: { reason: 'delete_restricted', blockers: [] },
        });
      }
      const others = [
        ...plan.clears.map(({ record: other }) => other),
        ...plan.reviewItems,
        ...plan.removals.map(({ record: other }) => other),
      ];
      const expected: ExpectedRevision[] = [
        { ref, revision },
        ...others.map((other) => ({ ref: other.ref, revision: other.localRevision })),
      ];
      return kit.run(ownerId, commandId, eventType, expected, async ({ records, context }) => {
        const current = await records.read(ref);
        if (current === null) return changed('delete_target_missing');
        const title = validateDeleteConfirmation(titleOf(current.document), input.confirmation);
        if (!title.ok) return title;
        const mutations: CanonicalMutation[] = [];
        const details = new Map<string, PlanningEventDetails>();
        for (const clear of plan.clears) {
          const referrer = await records.read(clear.record.ref);
          if (referrer === null) return changed('delete_referrer_changed');
          let document = referrer.document;
          for (const foreignKey of clear.foreignKeys) {
            if (document[foreignKey] !== ref.id) return changed('delete_referrer_changed');
            document = without(document, foreignKey);
          }
          mutations.push(updateFrom(referrer, document));
          details.set(entityRefKey(referrer.ref), clear.details);
        }
        // Review decisions stay; only their reference changes, before the target is deleted.
        const keptReviews = new Set<string>();
        for (const item of plan.reviewItems) {
          const kept = await records.read(item.ref);
          const mutation = kept === null ? null : clearReviewItemTarget(kept, ref, context.now);
          if (mutation === null) return changed('delete_history_changed');
          mutations.push(mutation);
          keptReviews.add(entityRefKey(item.ref));
        }
        for (const removal of plan.removals) {
          const other = await records.read(removal.record.ref);
          if (other === null) return changed('delete_history_changed');
          mutations.push(deleteFrom(other, context.now));
          if (removal.details !== undefined) details.set(entityRefKey(other.ref), removal.details);
        }
        mutations.push(deleteFrom(current, context.now));
        return ok({
          mutations,
          // Ids and relationship names only; a kept review decision records `{ operation }`.
          eventPayload: (mutation) => details.get(entityRefKey(mutation.ref)),
          eventTypeFor: (mutation) =>
            keptReviews.has(entityRefKey(mutation.ref)) ? reviewTargetClearedEventType : undefined,
        });
      });
    },
  };
}
