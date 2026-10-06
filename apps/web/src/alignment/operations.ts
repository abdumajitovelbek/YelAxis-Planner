/**
 * The single source of alignment operations and wording shared by the relationship list and the
 * alignment map, so both views always offer the same named controls. Pure
 * presentation helpers: nothing here ranks, scores, or changes a plan.
 */
import type {
  AlignmentEdge,
  AlignmentNeighborhood,
  AlignmentNode,
  AlignmentNodeKind,
  AlignmentRelationship,
} from '@yelaxis/application';
import {
  alignmentNodeKinds,
  alignmentRelationshipRules,
  alignmentRelationships,
  alignmentRelationshipsAbove,
  alignmentRelationshipsBelow,
  parseUUID,
  type AlignmentRelationshipRule,
  type UUID,
} from '@yelaxis/domain';

import {
  actionPath,
  axisPath,
  milestonePath,
  outcomePath,
  projectPath,
  routinePath,
} from '../plan/routes';
import { kindLabel } from './labels';

export type AlignmentOperationId = 'inspect' | 'center' | 'link' | 'unlink' | 'reparent' | 'open';

export interface AlignmentOperation {
  readonly id: AlignmentOperationId;
  /** Visible text of the control. */
  readonly label: string;
  /** The object it acts on, announced after the label so every control name is unique. */
  readonly target: string;
}

/** Accessible name of an operation control: the visible label, then the object it acts on. */
export const operationName = (operation: AlignmentOperation): string =>
  `${operation.label} ${operation.target}`;

const operation = (
  id: AlignmentOperationId,
  label: string,
  target: string,
): AlignmentOperation => ({ id, label, target });

/**
 * Operations for the selected object (no edge) or for an object related to it through `edge`.
 * Required edges (a Milestone's Outcome) offer Move to another Outcome, never Unlink; display-only
 * relationships are never unlinked here; archived objects never get Link.
 */
export function operationsFor(
  focus: AlignmentNode,
  edge?: AlignmentEdge,
): readonly AlignmentOperation[] {
  if (edge === undefined) {
    return [
      operation('inspect', 'Inspect', focus.title),
      ...(!focus.archived && linkableRelationships(focus.kind).length > 0
        ? [operation('link', 'Link…', focus.title)]
        : []),
      ...(nodePath(focus) === null ? [] : [operation('open', 'Open', focus.title)]),
    ];
  }
  const other = edge.other;
  const rule = alignmentRelationshipRules[edge.relationship];
  const change: AlignmentOperation[] = [];
  if (edge.required || rule.required) {
    const milestone = edge.direction === 'up' ? focus : other;
    if (!milestone.archived)
      change.push(operation('reparent', 'Move to another Outcome…', milestone.title));
  } else if (!rule.displayOnly) {
    change.push(operation('unlink', 'Unlink…', other.title));
  }
  return [
    operation('inspect', 'Inspect', other.title),
    operation('center', 'Center', other.title),
    ...change,
    ...(nodePath(other) === null ? [] : [operation('open', 'Open', other.title)]),
  ];
}

/** Relationships a person links from an object of `kind` (not required, not display-only). */
export function linkableRelationships(
  kind: AlignmentNodeKind,
): readonly AlignmentRelationshipRule[] {
  return alignmentRelationships.filter(
    (rule) =>
      !rule.required && !rule.displayOnly && (rule.parentKind === kind || rule.childKind === kind),
  );
}

/** Detail page of an object, or null when it has none (captured Notes). */
export function nodePath(node: {
  readonly kind: AlignmentNodeKind;
  readonly id: string;
}): string | null {
  switch (node.kind) {
    case 'axis':
      return axisPath(node.id);
    case 'outcome':
      return outcomePath(node.id);
    case 'project':
      return projectPath(node.id);
    case 'milestone':
      return milestonePath(node.id);
    case 'action':
      return actionPath(node.id);
    case 'routine':
      return routinePath(node.id);
    case 'note':
      return null;
  }
}

/* ───────────────────────── Neighborhood wording ───────────────────────── */

export interface EdgeGroup {
  readonly relationship: AlignmentRelationship;
  readonly edges: readonly AlignmentEdge[];
  /** Every link of this relationship, including those beyond the loaded limit. */
  readonly total: number;
}

/** Edges above (`up`) or below (`down`) the focus, grouped by relationship in catalog order. */
export function edgeGroups(
  neighborhood: AlignmentNeighborhood,
  direction: 'up' | 'down',
): readonly EdgeGroup[] {
  const edges = direction === 'up' ? neighborhood.above : neighborhood.below;
  const rules =
    direction === 'up'
      ? alignmentRelationshipsAbove(neighborhood.focus.kind)
      : alignmentRelationshipsBelow(neighborhood.focus.kind);
  return rules
    .map((rule) => {
      const members = edges.filter((candidate) => candidate.relationship === rule.relationship);
      return {
        relationship: rule.relationship,
        edges: members,
        total: Math.max(neighborhood.totals[rule.relationship] ?? 0, members.length),
      };
    })
    .filter((group) => group.total > 0);
}

const kindPlurals: Readonly<Record<AlignmentNodeKind, string>> = {
  axis: 'Axes',
  outcome: 'Outcomes',
  project: 'Projects',
  milestone: 'Milestones',
  action: 'Actions',
  routine: 'Routines',
  note: 'Notes',
};

/** "1 Axis", "3 Milestones". */
export const countText = (count: number, kind: AlignmentNodeKind): string =>
  `${String(count)} ${count === 1 ? kindLabel(kind) : kindPlurals[kind]}`;

/** Plural heading of a group of children, e.g. "Supporting Projects". */
const groupHeadings: Readonly<Record<AlignmentRelationship, string>> = {
  axis_outcome: 'Outcomes',
  axis_project: 'Projects',
  axis_routine: 'Routines',
  outcome_milestone: 'Milestones',
  outcome_primary_project: 'Primary Projects',
  outcome_secondary_project: 'Supporting Projects',
  project_action: 'Actions',
  project_note: 'Captured notes',
  milestone_project: 'Supporting Projects',
  milestone_action: 'Supporting Actions',
};

export const groupHeading = (relationship: AlignmentRelationship): string =>
  groupHeadings[relationship];

/** Counts by object kind, in the catalog order of the relationships that first mention each kind. */
function countsByKind(groups: readonly EdgeGroup[], direction: 'up' | 'down'): string {
  const counts = new Map<AlignmentNodeKind, number>();
  for (const group of groups) {
    const rule = alignmentRelationshipRules[group.relationship];
    const kind = direction === 'up' ? rule.parentKind : rule.childKind;
    counts.set(kind, (counts.get(kind) ?? 0) + group.total);
  }
  const parts = [...counts].map(([kind, count]) => countText(count, kind));
  return parts.length === 0 ? 'nothing' : parts.join(', ');
}

/** "Outcome “X”. Above: 1 Axis. Below: 2 Milestones, 1 Project." Counts only, never a score. */
export function neighborhoodSummary(neighborhood: AlignmentNeighborhood): string {
  const focus = neighborhood.focus;
  const above = countsByKind(edgeGroups(neighborhood, 'up'), 'up');
  const below = countsByKind(edgeGroups(neighborhood, 'down'), 'down');
  return `${kindLabel(focus.kind)} “${focus.title}”${focus.archived ? ', archived' : ''}. Above: ${above}. Below: ${below}.`;
}

/** Lifecycle state in words; the text always names the state, never only a color. */
export function stateText(state: string): string {
  if (state === 'in_progress') return 'In progress';
  return state.length === 0 ? state : `${state.charAt(0).toUpperCase()}${state.slice(1)}`;
}

/* ───────────────────────── URL focus ───────────────────────── */

export interface AlignmentFocusRef {
  readonly kind: AlignmentNodeKind;
  readonly id: UUID;
}

/**
 * Parse `?focus=<kind>:<uuid>`: null when absent, `invalid` for any malformed value (the page
 * then shows a calm unavailable state instead of guessing).
 */
export function parseAlignmentFocus(value: string | null): AlignmentFocusRef | null | 'invalid' {
  if (value === null) return null;
  const parts = value.split(':');
  if (parts.length !== 2) return 'invalid';
  const [kind = '', id = ''] = parts;
  if (!alignmentNodeKinds.some((candidate) => candidate === kind)) return 'invalid';
  const parsed = parseUUID(id);
  return parsed.ok ? { kind: kind as AlignmentNodeKind, id: parsed.value } : 'invalid';
}
