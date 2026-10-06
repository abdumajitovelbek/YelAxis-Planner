/**
 * alignment read-only alignment projections (part A1): Axis overview and details, Outcome, Project, and
 * Milestone details, the alignment neighborhood, link candidates, and form choices.
 *
 * Every method is read-only and owner-scoped through the active identity. Ids from routes, links,
 * or forms are validated first: a malformed id (or an unknown kind) returns null (or an empty list)
 * without touching the port. Every list is bounded (hard cap 200) and keeps its full
 * `total` for "Show all N". Nothing here ranks, scores, or writes.
 */
import {
  alignmentKinds,
  alignmentNodeKinds,
  alignmentRelationshipRules,
  createEntityRef,
  isAlignmentRelationship,
  isCrossAxis,
  parseUUID,
  type AlignmentJoinRelationship,
  type AlignmentKind,
  type AlignmentNodeKind,
  type AlignmentRelationshipRule,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type {
  AlignmentNode,
  AlignmentProjectionMethods,
  AlignmentQueryPort,
  Bounded,
} from './alignment-contracts';
import { isActiveLink, type AlignmentKit } from './alignment-kit';
import type { CanonicalRecordState } from './contracts';

/** The hard cap of every alignment list; the port never returns more rows than this. */
const maxListLimit = 200;
/** Default page sizes where the page offers "Show all N" (up to the hard cap). */
const defaultProjectActionLimit = 50;
const defaultNeighborhoodLimit = 50;
const defaultCandidateLimit = 50;
/** Titles are at most 200 characters, so a longer search can never match more. */
const maxSearchLength = 200;

type Doc = Readonly<Record<string, unknown>>;

type Candidate = AlignmentNode & { readonly alreadyLinked: boolean; readonly crossAxis: boolean };

const noCandidates: Bounded<Candidate> = Object.freeze({ items: Object.freeze([]), total: 0 });

/** A caller-supplied limit as a whole number from 1 to 200; anything unusable uses the default. */
const boundedLimit = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1), maxListLimit)
    : fallback;

/** A canonical (lowercase) UUID, or null when the value is not a well-formed UUID string. */
const parseId = (value: unknown): UUID | null => {
  if (typeof value !== 'string') return null;
  const parsed = parseUUID(value);
  return parsed.ok ? parsed.value : null;
};

const isNodeKind = (value: unknown): value is AlignmentNodeKind =>
  typeof value === 'string' && (alignmentNodeKinds as readonly string[]).includes(value);

const isAlignmentKind = (value: unknown): value is AlignmentKind =>
  typeof value === 'string' && (alignmentKinds as readonly string[]).includes(value);

/** A trimmed title filter, bounded in length; blank or non-text input means no filter. */
const searchText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, maxSearchLength);
};

const textField = (document: Doc, key: string): string | undefined => {
  const value = document[key];
  return typeof value === 'string' ? value : undefined;
};

const isArchivedDocument = (document: Doc): boolean =>
  document['state'] === 'archived' || document['archivedAt'] !== undefined;

/** The exact node shape (extra port fields such as `axisId` are not passed on). */
const toNode = (row: AlignmentNode): AlignmentNode => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  state: row.state,
  archived: row.archived,
  localRevision: row.localRevision,
});

/** A focus given by a route or dialog: a known node kind and a well-formed id. */
const parseFocus = (
  focus: unknown,
): { readonly kind: AlignmentNodeKind; readonly id: UUID } | null => {
  if (typeof focus !== 'object' || focus === null) return null;
  const { kind, id } = focus as { readonly kind?: unknown; readonly id?: unknown };
  const parsed = parseId(id);
  return isNodeKind(kind) && parsed !== null ? { kind, id: parsed } : null;
};

export function createAlignmentProjections(kit: AlignmentKit): AlignmentProjectionMethods {
  const { queries } = kit;

  return {
    async listAxes(options) {
      return queries.listAxes(await kit.ownerId(), {
        includeArchived: options?.includeArchived === true,
        limit: maxListLimit,
      });
    },

    async listUnassigned() {
      return queries.listUnassigned(await kit.ownerId(), maxListLimit);
    },

    async getAxis(axisId, options) {
      const id = parseId(axisId);
      if (id === null) return null;
      return queries.getAxis(await kit.ownerId(), id, {
        includeFinished: options?.includeFinished === true,
        limit: maxListLimit,
      });
    },

    async getOutcome(outcomeId) {
      const id = parseId(outcomeId);
      if (id === null) return null;
      return queries.getOutcome(await kit.ownerId(), id, maxListLimit);
    },

    async getProject(projectId, options) {
      const id = parseId(projectId);
      if (id === null) return null;
      return queries.getProject(await kit.ownerId(), id, {
        actionLimit: boundedLimit(options?.actionLimit, defaultProjectActionLimit),
        limit: maxListLimit,
      });
    },

    async getMilestone(milestoneId) {
      const id = parseId(milestoneId);
      if (id === null) return null;
      return queries.getMilestone(await kit.ownerId(), id, maxListLimit);
    },

    async getNeighborhood(focus, options) {
      const parsed = parseFocus(focus);
      if (parsed === null) return null;
      return queries.getNeighborhood(
        await kit.ownerId(),
        parsed,
        boundedLimit(options?.limit, defaultNeighborhoodLimit),
      );
    },

    async listLinkCandidates(input) {
      if (typeof input !== 'object' || input === null) return noCandidates;
      const focus = parseFocus(input.focus);
      if (focus === null || !isAlignmentRelationship(input.relationship)) return noCandidates;
      const rule = alignmentRelationshipRules[input.relationship];
      // A Note's Project and a Routine's Axis are shown only; alignment never links them here.
      if (rule.displayOnly) return noCandidates;
      const focusIsParent = rule.parentKind === focus.kind;
      if (!focusIsParent && rule.childKind !== focus.kind) return noCandidates;

      const ownerId = await kit.ownerId();
      const focusRecord = await queries.readRecord(
        ownerId,
        createEntityRef(focus.kind, focus.id, ownerId),
      );
      // Nothing new can be linked to an archived object ("Restore it before linking").
      if (focusRecord === null || isArchivedDocument(focusRecord.document)) return noCandidates;

      const page = await queries.listCandidates(
        ownerId,
        focusIsParent ? rule.childKind : rule.parentKind,
        searchText(input.search),
        boundedLimit(input.limit, defaultCandidateLimit),
      );
      const items: Candidate[] = [];
      for (const row of page.items) {
        items.push({
          ...toNode(row),
          alreadyLinked: await isLinked(queries, ownerId, rule, focusRecord, focusIsParent, row),
          crossAxis: crossAxisPair(rule, focusRecord, focusIsParent, row),
        });
      }
      return { items, total: page.total };
    },

    async listChoices(kind) {
      if (!isAlignmentKind(kind)) return [];
      const page = await queries.listCandidates(await kit.ownerId(), kind, undefined, maxListLimit);
      return page.items.map(toNode);
    },
  };
}

/**
 * Whether the focus and one candidate are already actively linked by this relationship. Foreign
 * keys are read from the child side (the candidate row already carries its Axis); join links count
 * only while they are active, so an unlinked pair can be linked (revived) again.
 */
async function isLinked(
  queries: AlignmentQueryPort,
  ownerId: OwnerId,
  rule: AlignmentRelationshipRule,
  focus: CanonicalRecordState,
  focusIsParent: boolean,
  candidate: AlignmentNode & { readonly axisId?: UUID },
): Promise<boolean> {
  if (rule.storage === 'join') {
    const link = await queries.findLink(
      ownerId,
      rule.relationship as AlignmentJoinRelationship,
      focusIsParent ? focus.ref.id : candidate.id,
      focusIsParent ? candidate.id : focus.ref.id,
    );
    return link !== null && isActiveLink(link.document);
  }
  if (!focusIsParent) return textField(focus.document, rule.foreignKey) === candidate.id;
  if (rule.foreignKey === 'axisId') return candidate.axisId === focus.ref.id;
  const child = await queries.readRecord(
    ownerId,
    createEntityRef(rule.childKind, candidate.id, ownerId),
  );
  return child !== null && textField(child.document, rule.foreignKey) === focus.ref.id;
}

/** Only an Action and a Project that both name an Axis, and different ones, are cross-Axis. */
function crossAxisPair(
  rule: AlignmentRelationshipRule,
  focus: CanonicalRecordState,
  focusIsParent: boolean,
  candidate: { readonly axisId?: UUID },
): boolean {
  if (rule.relationship !== 'project_action') return false;
  const focusAxis = textField(focus.document, 'axisId');
  return focusIsParent
    ? isCrossAxis(focusAxis, candidate.axisId)
    : isCrossAxis(candidate.axisId, focusAxis);
}
