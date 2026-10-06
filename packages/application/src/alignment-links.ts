/**
 * Alignment link commands: preview, link, unlink, and Milestone reparent.
 *
 * Foreign-key relationships (Axis membership, primary Outcome, an Action's Project) change one field
 * of the child; the three many-to-many relationships create, revive, or unlink one join record whose
 * id is derived from the pair. Every decision is the domain's `validateAlignmentLink` or
 * `validateAlignmentUnlink`, re-checked on the records read inside the command transaction.
 *
 * Linking never creates or deletes an endpoint, never changes its state or order, and never
 * rewrites another relationship. A Milestone's Outcome is moved with `reparentMilestone`, never
 * removed. An active duplicate writes nothing and offers no undo.
 */
import {
  alignmentLinkEntityType,
  alignmentRelationshipRules,
  createEntityRef,
  err,
  isAlignmentRelationship,
  isCrossAxis,
  ok,
  parseUUID,
  validateAlignmentLink,
  validateAlignmentUnlink,
  type AlignmentForeignKey,
  type AlignmentJoinRelationship,
  type AlignmentLinkDecision,
  type AlignmentLinkEntityType,
  type AlignmentLinkRequest,
  type AlignmentNodeKind,
  type AlignmentRelationship,
  type AlignmentRelationshipRule,
  type DomainError,
  type DomainResult,
  type EntityRef,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type {
  AlignmentLinkMethods,
  AlignmentNode,
  LinkInput,
  LinkPreview,
  UnlinkInput,
} from './alignment-contracts';
import {
  alreadyLinked,
  isActiveLink,
  linkDocument,
  linkEndpoints,
  linkRef,
  parseAlignmentRef,
  type AlignmentCommandPlan,
  type AlignmentKit,
} from './alignment-kit';
import type { ApplicationResult, CanonicalRecordState, ExpectedRevision } from './contracts';
import { createMutation, updateFrom, without, type PlanningEventDetails } from './planning-kit';
import { changed, isArchivedDocument, missing, rejected } from './planning-scheduling-support';
import type { PlanningRecordReader } from './ports';

type Doc = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const titleOf = (document: Doc): string => text(document['title']) ?? text(document['body']) ?? '';

const joinRelationships: readonly AlignmentRelationship[] = [
  'outcome_secondary_project',
  'milestone_project',
  'milestone_action',
];

const isJoin = (relationship: AlignmentRelationship): relationship is AlignmentJoinRelationship =>
  joinRelationships.includes(relationship);

/* ───────────────────────── Calm refusals ───────────────────────── */

/** A malformed id names nothing the person can act on. */
const unavailable = (): DomainError => ({
  code: 'invalid_uuid',
  message: 'That item is no longer available.',
  details: { reason: 'invalid_id' },
});

const unsupported = (relationship: unknown): DomainError => ({
  code: 'unsupported_relationship',
  message: 'These items cannot be linked that way.',
  details: {
    reason: 'unsupported_relationship',
    relationship: typeof relationship === 'string' ? relationship : 'unknown',
  },
});

const alreadyLinkedReason = 'already_linked';

/**
 * Raised inside the transaction when the pair is already actively linked. It writes nothing and is
 * turned into the no-change receipt; a repeated command id still gets its original receipt, because
 * `executeCommand` looks the id up before planning.
 */
const alreadyLinkedRefusal = (): DomainResult<never> =>
  err({
    code: 'invalid_value',
    message: 'Already linked. Nothing changed.',
    details: { reason: alreadyLinkedReason },
  });

const isAlreadyLinkedRefusal = (result: ApplicationResult<unknown>): boolean =>
  !result.ok &&
  result.error.code === 'domain_rejected' &&
  result.error.domainError.details?.['reason'] === alreadyLinkedReason;

const alreadyRemoved = (): DomainResult<never> =>
  err({
    code: 'invalid_value',
    message: 'This link is already removed. Nothing changed.',
    details: { reason: 'no_change' },
  });

/* ───────────────────────── Input parsing ───────────────────────── */

interface RevisionRefShape {
  readonly kind: AlignmentNodeKind;
  readonly id: string;
  readonly revision: number;
}

const isRevisionRefOf = (value: unknown, kind: AlignmentNodeKind): value is RevisionRefShape => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return (
    candidate['kind'] === kind &&
    typeof candidate['id'] === 'string' &&
    typeof candidate['revision'] === 'number'
  );
};

const endpointRef = (
  kind: AlignmentNodeKind,
  id: unknown,
  ownerId: OwnerId,
): DomainResult<EntityRef> => {
  const parsed = typeof id === 'string' ? parseAlignmentRef(kind, id, ownerId) : null;
  return parsed?.ok === true ? parsed : err(unavailable());
};

/** The relationships link and unlink write: every catalog kind except display-only ones. */
const writableRule = (relationship: unknown): AlignmentRelationshipRule | null => {
  if (!isAlignmentRelationship(relationship)) return null;
  const rule = alignmentRelationshipRules[relationship];
  return rule.displayOnly ? null : rule;
};

/** A link request with typed endpoints. Parent = Axis, Outcome, Project, or Milestone. */
type ParsedLink =
  | {
      readonly storage: 'fk';
      readonly rule: AlignmentRelationshipRule;
      readonly foreignKey: AlignmentForeignKey;
      readonly parent: EntityRef;
      readonly child: EntityRef;
      /** The child revision the caller saw: its foreign key changes. */
      readonly childRevision: number;
    }
  | {
      readonly storage: 'join';
      readonly rule: AlignmentRelationshipRule;
      readonly relationship: AlignmentJoinRelationship;
      readonly linkEntityType: AlignmentLinkEntityType;
      readonly parent: EntityRef;
      readonly child: EntityRef;
    };

function linkFields(input: LinkInput): { readonly parentId: unknown; readonly child: unknown } {
  switch (input.relationship) {
    case 'axis_outcome':
      return { parentId: input.axisId, child: input.outcome };
    case 'axis_project':
      return { parentId: input.axisId, child: input.project };
    case 'outcome_primary_project':
      return { parentId: input.outcomeId, child: input.project };
    case 'outcome_secondary_project':
      return { parentId: input.outcomeId, child: input.projectId };
    case 'milestone_project':
      return { parentId: input.milestoneId, child: input.projectId };
    case 'milestone_action':
      return { parentId: input.milestoneId, child: input.actionId };
    case 'project_action':
      return { parentId: input.projectId, child: input.action };
  }
}

function parseLink(input: LinkInput, ownerId: OwnerId): DomainResult<ParsedLink> {
  const relationship: unknown = (input as { readonly relationship?: unknown }).relationship;
  const rule = writableRule(relationship);
  // A Milestone's Outcome is required: it is moved with reparent, never linked.
  if (rule === null || rule.required) return err(unsupported(relationship));
  const fields = linkFields(input);
  const parent = endpointRef(rule.parentKind, fields.parentId, ownerId);
  if (!parent.ok) return parent;
  if (rule.storage === 'join') {
    if (!isJoin(rule.relationship)) return err(unsupported(relationship));
    const child = endpointRef(rule.childKind, fields.child, ownerId);
    if (!child.ok) return child;
    return ok({
      storage: 'join',
      rule,
      relationship: rule.relationship,
      linkEntityType: rule.linkEntityType,
      parent: parent.value,
      child: child.value,
    });
  }
  // A foreign-key child carries its revision; a swapped endpoint kind is not a catalog pair.
  if (!isRevisionRefOf(fields.child, rule.childKind)) return err(unsupported(relationship));
  const child = endpointRef(rule.childKind, fields.child.id, ownerId);
  if (!child.ok) return child;
  return ok({
    storage: 'fk',
    rule,
    foreignKey: rule.foreignKey,
    parent: parent.value,
    child: child.value,
    childRevision: fields.child.revision,
  });
}

/* ───────────────────────── Link facts ───────────────────────── */

interface LinkFacts {
  readonly parent: CanonicalRecordState;
  readonly child: CanonicalRecordState;
  /** Join kinds: the pair's join record in any state (active or unlinked), or null. */
  readonly link: CanonicalRecordState | null;
  /** `outcome_primary_project`: the pair's supporting-Outcome record in any state, or null. */
  readonly supporting: CanonicalRecordState | null;
}

/** Read the facts before the command so it knows every record it may write and its revision. */
async function readLinkFacts(
  kit: AlignmentKit,
  ownerId: OwnerId,
  parsed: ParsedLink,
): Promise<ApplicationResult<LinkFacts>> {
  const parent = await kit.queries.readRecord(ownerId, parsed.parent);
  if (parent === null) return missing(parsed.parent);
  const child = await kit.queries.readRecord(ownerId, parsed.child);
  if (child === null) return missing(parsed.child);
  // Found by endpoints, not by derived id, so a join row with any id is revived rather than duplicated.
  const link =
    parsed.storage === 'join'
      ? await kit.queries.findLink(ownerId, parsed.relationship, parsed.parent.id, parsed.child.id)
      : null;
  const supporting =
    parsed.rule.relationship === 'outcome_primary_project'
      ? await kit.queries.findLink(
          ownerId,
          'outcome_secondary_project',
          parsed.parent.id,
          parsed.child.id,
        )
      : null;
  return { ok: true, value: { parent, child, link, supporting } };
}

/** The join record of the pair as it is inside the transaction. */
async function readPair(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  relationship: AlignmentJoinRelationship,
  parsed: ParsedLink,
  known: CanonicalRecordState | null,
): Promise<DomainResult<CanonicalRecordState | null>> {
  const record = await records.read(
    known?.ref ?? linkRef(ownerId, relationship, parsed.parent.id, parsed.child.id),
  );
  if (record === null) return known === null ? ok(null) : changed('link_changed');
  const endpoints = linkEndpoints(relationship, record.document);
  return endpoints?.parentId === parsed.parent.id && endpoints.childId === parsed.child.id
    ? ok(record)
    : changed('link_changed');
}

/** Re-read every fact inside the transaction; the command decides only on these. */
async function currentLinkFacts(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  parsed: ParsedLink,
  known: LinkFacts,
): Promise<DomainResult<LinkFacts>> {
  const parent = await records.read(parsed.parent);
  const child = await records.read(parsed.child);
  if (parent === null || child === null) return changed('link_endpoint_missing');
  let link: CanonicalRecordState | null = null;
  if (parsed.storage === 'join') {
    const pair = await readPair(records, ownerId, parsed.relationship, parsed, known.link);
    if (!pair.ok) return pair;
    // A record that appeared after the first read is not covered by the expected revisions.
    if (known.link === null && pair.value !== null) return changed('link_changed');
    link = pair.value;
  }
  let supporting: CanonicalRecordState | null = null;
  if (parsed.rule.relationship === 'outcome_primary_project') {
    const pair = await readPair(
      records,
      ownerId,
      'outcome_secondary_project',
      parsed,
      known.supporting,
    );
    if (!pair.ok) return pair;
    supporting = pair.value;
  }
  return ok({ parent, child, link, supporting });
}

interface LinkChoices {
  readonly replaceExisting: boolean;
  readonly confirmCrossAxis: boolean;
}

function linkRequest(
  parsed: ParsedLink,
  facts: LinkFacts,
  choices: LinkChoices,
): AlignmentLinkRequest {
  const relationship = parsed.rule.relationship;
  const child = facts.child.document;
  return {
    relationship,
    parent: parsed.parent,
    child: parsed.child,
    parentArchived: isArchivedDocument(facts.parent.document),
    childArchived: isArchivedDocument(child),
    currentParentId: parsed.storage === 'fk' ? text(child[parsed.foreignKey]) : undefined,
    activeLinkExists: facts.link !== null && isActiveLink(facts.link.document),
    replaceExisting: choices.replaceExisting,
    primaryOutcomeId:
      relationship === 'outcome_secondary_project' ? text(child['primaryOutcomeId']) : undefined,
    outcomeIsSupporting: facts.supporting !== null && isActiveLink(facts.supporting.document),
    projectAxisId:
      relationship === 'project_action' ? text(facts.parent.document['axisId']) : undefined,
    actionAxisId: relationship === 'project_action' ? text(child['axisId']) : undefined,
    confirmCrossAxis: choices.confirmCrossAxis,
  };
}

const storedId = (value: string | undefined): UUID | undefined => {
  if (value === undefined) return undefined;
  const parsed = parseUUID(value);
  return parsed.ok ? parsed.value : undefined;
};

/** One link write: the child's foreign key, or a created or revived join record. */
function planLink(
  ownerId: OwnerId,
  parsed: ParsedLink,
  facts: LinkFacts,
  decision: AlignmentLinkDecision,
): AlignmentCommandPlan {
  const parentId = parsed.parent.id;
  const previousId = storedId(decision.replacesParentId);
  const eventPayload: PlanningEventDetails = {
    relationship: parsed.rule.relationship,
    nextId: parentId,
    ...(previousId === undefined ? {} : { previousId }),
  };
  if (parsed.storage === 'fk') {
    return {
      mutations: [
        updateFrom(facts.child, { ...facts.child.document, [parsed.foreignKey]: parentId }),
      ],
      eventPayload,
    };
  }
  if (facts.link !== null) {
    // Relinking revives the same record: it is active again once `unlinkedAt` is gone.
    return {
      mutations: [updateFrom(facts.link, without(facts.link.document, 'unlinkedAt'))],
      eventPayload,
    };
  }
  const ref = linkRef(ownerId, parsed.relationship, parentId, parsed.child.id);
  return {
    mutations: [createMutation(ref, linkDocument(parsed.relationship, parentId, parsed.child.id))],
    created: [{ ref, kind: parsed.linkEntityType }],
    eventPayload,
  };
}

/* ───────────────────────── Preview ───────────────────────── */

type PreviewReason = NonNullable<LinkPreview['reason']>;

const refusedPreview = (reason: PreviewReason): LinkPreview => ({
  allowed: false,
  alreadyLinked: false,
  reason,
  crossAxis: false,
});

function previewReason(error: DomainError): PreviewReason {
  if (error.code === 'archived_endpoint') return 'archived_endpoint';
  if (error.code === 'cardinality_violation') {
    return error.details?.['reason'] === 'primary_is_secondary'
      ? 'primary_is_secondary'
      : 'cardinality_violation';
  }
  return 'unsupported_relationship';
}

async function nodeOf(
  kit: AlignmentKit,
  ownerId: OwnerId,
  kind: AlignmentNodeKind,
  id: UUID,
): Promise<AlignmentNode | null> {
  const record = await kit.queries.readRecord(ownerId, createEntityRef(kind, id, ownerId));
  if (record === null) return null;
  return {
    id: record.ref.id,
    kind,
    title: titleOf(record.document),
    state: text(record.document['state']) ?? 'active',
    archived: isArchivedDocument(record.document),
    localRevision: record.localRevision,
  };
}

/* ───────────────────────── Unlink ───────────────────────── */

type UnlinkFields =
  | { readonly storage: 'fk'; readonly child: unknown }
  | { readonly storage: 'join'; readonly linkId: unknown; readonly revision: unknown };

function unlinkFields(input: UnlinkInput): UnlinkFields {
  switch (input.relationship) {
    case 'axis_outcome':
      return { storage: 'fk', child: input.outcome };
    case 'axis_project':
    case 'outcome_primary_project':
      return { storage: 'fk', child: input.project };
    case 'project_action':
      return { storage: 'fk', child: input.action };
    case 'outcome_secondary_project':
    case 'milestone_project':
    case 'milestone_action':
      return { storage: 'join', linkId: input.linkId, revision: input.revision };
  }
}

/**
 * A Milestone's Outcome is moved, never removed. The refusal depends on the relationship alone, so
 * the endpoints are placeholders of the catalog kinds (nothing is read or written).
 */
function requiredRefusal(ownerId: OwnerId, rule: AlignmentRelationshipRule) {
  const placeholder = (kind: AlignmentNodeKind): EntityRef =>
    createEntityRef(kind, ownerId, ownerId);
  const refusal = validateAlignmentUnlink({
    relationship: rule.relationship,
    parent: placeholder(rule.parentKind),
    child: placeholder(rule.childKind),
  });
  return rejected(refusal.ok ? unsupported(rule.relationship) : refusal.error);
}

/* ───────────────────────── Reparent ───────────────────────── */

const alreadyInOutcome = (): DomainResult<never> =>
  err({
    code: 'invalid_value',
    message: 'This Milestone already belongs to that Outcome.',
    details: { reason: 'no_change' },
  });

/** Say which endpoint to restore; "linking" is the wrong word for a move. */
const reparentRefusal = (error: DomainError, milestoneArchived: boolean): DomainError =>
  error.code === 'archived_endpoint'
    ? {
        ...error,
        message: milestoneArchived
          ? 'Restore this Milestone before moving it.'
          : 'Restore that Outcome before moving a Milestone to it.',
      }
    : error;

/* ───────────────────────── Commands ───────────────────────── */

export function createAlignmentLinkCommands(kit: AlignmentKit): AlignmentLinkMethods {
  return {
    async previewLink(input) {
      const ownerId = await kit.ownerId();
      const parsed = parseLink(input, ownerId);
      if (!parsed.ok) {
        return refusedPreview(
          parsed.error.code === 'unsupported_relationship'
            ? 'unsupported_relationship'
            : 'not_found',
        );
      }
      const facts = await readLinkFacts(kit, ownerId, parsed.value);
      if (!facts.ok) return refusedPreview('not_found');
      // Preview the link as it would be once the person confirms a replacement or a cross-Axis
      // context; `replaces` and `crossAxis` tell the dialog which confirmation to ask for.
      const request = linkRequest(parsed.value, facts.value, {
        replaceExisting: true,
        confirmCrossAxis: true,
      });
      const crossAxis = isCrossAxis(request.projectAxisId, request.actionAxisId);
      const decided = validateAlignmentLink(request);
      if (!decided.ok) {
        return {
          allowed: false,
          alreadyLinked: false,
          reason: previewReason(decided.error),
          crossAxis,
        };
      }
      if (decided.value.status === 'existing') {
        return { allowed: true, alreadyLinked: true, crossAxis };
      }
      const replacedId = storedId(decided.value.replacesParentId);
      const replaces =
        replacedId === undefined
          ? null
          : await nodeOf(kit, ownerId, parsed.value.rule.parentKind, replacedId);
      return {
        allowed: true,
        alreadyLinked: false,
        crossAxis,
        ...(replaces === null ? {} : { replaces }),
      };
    },

    async link(input, commandId) {
      const ownerId = await kit.ownerId();
      const parsed = parseLink(input, ownerId);
      if (!parsed.ok) return rejected(parsed.error);
      const known = await readLinkFacts(kit, ownerId, parsed.value);
      if (!known.ok) return known;
      const target = parsed.value;
      const choices: LinkChoices = {
        replaceExisting: 'replaceExisting' in input && input.replaceExisting === true,
        confirmCrossAxis: 'confirmCrossAxis' in input && input.confirmCrossAxis === true,
      };
      const existingLink = known.value.link;
      const expected: readonly ExpectedRevision[] =
        target.storage === 'fk'
          ? [{ ref: target.child, revision: target.childRevision }]
          : existingLink === null
            ? []
            : [{ ref: existingLink.ref, revision: existingLink.localRevision }];
      const result = await kit.run(
        ownerId,
        commandId,
        'alignment.linked',
        expected,
        async ({ records }) => {
          const facts = await currentLinkFacts(records, ownerId, target, known.value);
          if (!facts.ok) return facts;
          const decided = validateAlignmentLink(linkRequest(target, facts.value, choices));
          if (!decided.ok) return decided;
          if (decided.value.status === 'existing') return alreadyLinkedRefusal();
          return ok(planLink(ownerId, target, facts.value, decided.value));
        },
      );
      return isAlreadyLinkedRefusal(result) ? { ok: true, value: alreadyLinked } : result;
    },

    async unlink(input, commandId) {
      const ownerId = await kit.ownerId();
      const relationship: unknown = (input as { readonly relationship?: unknown }).relationship;
      const rule = writableRule(relationship);
      if (rule === null) return rejected(unsupported(relationship));
      if (rule.required) return requiredRefusal(ownerId, rule);
      const fields = unlinkFields(input);

      if (rule.storage === 'fk') {
        if (fields.storage !== 'fk' || !isRevisionRefOf(fields.child, rule.childKind)) {
          return rejected(unsupported(relationship));
        }
        const child = endpointRef(rule.childKind, fields.child.id, ownerId);
        if (!child.ok) return rejected(child.error);
        const childRef = child.value;
        const foreignKey = rule.foreignKey;
        return kit.run(
          ownerId,
          commandId,
          'alignment.unlinked',
          [{ ref: childRef, revision: fields.child.revision }],
          async ({ records }) => {
            const current = await records.read(childRef);
            if (current === null) return changed('link_endpoint_missing');
            const stored = text(current.document[foreignKey]);
            if (stored === undefined) return alreadyRemoved();
            const parentId = storedId(stored);
            if (parentId === undefined) return changed('link_invalid');
            const allowed = validateAlignmentUnlink({
              relationship: rule.relationship,
              parent: createEntityRef(rule.parentKind, parentId, ownerId),
              child: childRef,
            });
            if (!allowed.ok) return allowed;
            return ok({
              mutations: [updateFrom(current, without(current.document, foreignKey))],
              eventPayload: { relationship: rule.relationship, previousId: parentId },
            });
          },
        );
      }

      if (
        fields.storage !== 'join' ||
        !isJoin(rule.relationship) ||
        typeof fields.revision !== 'number'
      ) {
        return rejected(unsupported(relationship));
      }
      const join = rule.relationship;
      const linkId = typeof fields.linkId === 'string' ? parseUUID(fields.linkId) : null;
      if (linkId?.ok !== true) return rejected(unavailable());
      const ref = createEntityRef(alignmentLinkEntityType(join), linkId.value, ownerId);
      return kit.run(
        ownerId,
        commandId,
        'alignment.unlinked',
        [{ ref, revision: fields.revision }],
        async ({ records, context }) => {
          const current = await records.read(ref);
          if (current === null) return changed('link_missing');
          const endpoints = linkEndpoints(join, current.document);
          if (endpoints === null) return changed('link_invalid');
          if (!isActiveLink(current.document)) return alreadyRemoved();
          const allowed = validateAlignmentUnlink({
            relationship: join,
            parent: createEntityRef(rule.parentKind, endpoints.parentId, ownerId),
            child: createEntityRef(rule.childKind, endpoints.childId, ownerId),
          });
          if (!allowed.ok) return allowed;
          // Both endpoints stay; only the link becomes inactive and is kept for history.
          return ok({
            mutations: [updateFrom(current, { ...current.document, unlinkedAt: context.now })],
            eventPayload: { relationship: join, previousId: endpoints.parentId },
          });
        },
      );
    },

    async reparentMilestone(ref, outcomeId, commandId) {
      const ownerId = await kit.ownerId();
      if (!isRevisionRefOf(ref, 'milestone')) return rejected(unsupported('outcome_milestone'));
      const milestone = endpointRef('milestone', ref.id, ownerId);
      if (!milestone.ok) return rejected(milestone.error);
      const outcome = endpointRef('outcome', outcomeId, ownerId);
      if (!outcome.ok) return rejected(outcome.error);
      const milestoneRef = milestone.value;
      const outcomeRef = outcome.value;
      if ((await kit.queries.readRecord(ownerId, outcomeRef)) === null) return missing(outcomeRef);
      return kit.run(
        ownerId,
        commandId,
        'milestone.reparented',
        [{ ref: milestoneRef, revision: ref.revision }],
        async ({ records }) => {
          const current = await records.read(milestoneRef);
          const destination = await records.read(outcomeRef);
          if (current === null || destination === null) return changed('reparent_changed');
          const previous = text(current.document['outcomeId']);
          const milestoneArchived = isArchivedDocument(current.document);
          // Moving is an explicit replacement of the one required Outcome.
          const decided = validateAlignmentLink({
            relationship: 'outcome_milestone',
            parent: outcomeRef,
            child: milestoneRef,
            parentArchived: isArchivedDocument(destination.document),
            childArchived: milestoneArchived,
            currentParentId: previous,
            replaceExisting: true,
          });
          if (!decided.ok) return err(reparentRefusal(decided.error, milestoneArchived));
          if (decided.value.status === 'existing') return alreadyInOutcome();
          const previousId = storedId(previous);
          // Only the Outcome changes: state, order, placement, and links stay as they are.
          return ok({
            mutations: [updateFrom(current, { ...current.document, outcomeId: outcomeRef.id })],
            eventPayload: {
              relationship: 'outcome_milestone',
              nextId: outcomeRef.id,
              ...(previousId === undefined ? {} : { previousId }),
            },
          });
        },
      );
    },
  };
}
