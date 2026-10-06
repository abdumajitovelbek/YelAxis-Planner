/**
 * Three-way merge of canonical record documents. Each
 * document is compared per field group: a semantic group (an interval, a recurrence, lifecycle
 * state with its completion and archive metadata, a target window, ordering with its parent fields,
 * a Constraint's value and strength, a Review's notes and decisions) behaves as one field. Equal
 * sides converge, one-sided changes are taken, disjoint changes merge, and the same group changed
 * differently on both sides is a conflict. Nothing ever uses last-write-wins.
 */
import type { EntityType } from '@yelaxis/domain';

import type { SyncDocument } from './sync-contracts';

export interface SyncFieldGroup {
  /** Stable key used in conflict records and merge choices. */
  readonly key: string;
  readonly fields: readonly string[];
}

interface FieldGroupSpec {
  /** Every field is one group: any concurrent change conflicts (Context). */
  readonly whole?: true;
  readonly groups: readonly SyncFieldGroup[];
}

const group = (key: string, ...fields: string[]): SyncFieldGroup => ({ key, fields });

const archiveLifecycle = group('lifecycle', 'state', 'stateBeforeArchive', 'archivedAt');
const targetWindow = group('targetWindow', 'targetStart', 'targetEnd');

/** Semantic groups per entity; a field outside every group is its own group. */
export const syncFieldGroups: Readonly<Record<EntityType, FieldGroupSpec>> = {
  profile: { groups: [] },
  axis: { groups: [archiveLifecycle] },
  outcome: {
    groups: [targetWindow, archiveLifecycle, group('placement', 'orderKey', 'axisId')],
  },
  milestone: {
    groups: [targetWindow, archiveLifecycle, group('placement', 'orderKey', 'outcomeId')],
  },
  project: {
    groups: [
      targetWindow,
      archiveLifecycle,
      group('placement', 'orderKey', 'axisId', 'primaryOutcomeId'),
    ],
  },
  action: {
    groups: [
      group('lifecycle', 'state', 'stateBeforeArchive', 'completedAt', 'archivedAt', 'convertedTo'),
      group('placement', 'orderKey', 'axisId', 'projectId'),
    ],
  },
  note: { groups: [archiveLifecycle, group('placement', 'orderKey', 'axisId', 'projectId')] },
  commitment: { groups: [archiveLifecycle] },
  time_block: {
    groups: [
      group('interval', 'startsAt', 'endsAt', 'timeZone', 'overlapAcknowledged'),
      group('lifecycle', 'state', 'supersededById'),
    ],
  },
  routine: {
    groups: [
      group('recurrence', 'generations'),
      group('lifecycle', 'state', 'stateBeforeArchive', 'pauseEffectiveOn', 'archivedAt'),
      group('placement', 'orderKey', 'axisId'),
    ],
  },
  routine_occurrence: {
    groups: [
      group('period', 'routineId', 'generation', 'periodKey', 'period', 'targetCount'),
      group('lifecycle', 'state', 'completedAt', 'completedCount', 'extraCompletionsConfirmed'),
    ],
  },
  routine_action_defaults: { groups: [group('routine', 'routineId', 'generation')] },
  template: { groups: [archiveLifecycle] },
  review: {
    groups: [
      group(
        'period',
        'profileId',
        'reviewType',
        'periodKey',
        'periodStart',
        'periodEnd',
        'weekStart',
      ),
      group('notes', 'notes', 'themeText', 'directionChoice', 'directionText', 'clearedLists'),
      group('lifecycle', 'state', 'stateBeforeArchive', 'completedAt', 'archivedAt'),
    ],
  },
  review_item: {
    groups: [
      group('decision', 'decision', 'period', 'note'),
      group('target', 'reviewId', 'target'),
    ],
  },
  reminder: { groups: [group('target', 'actionId', 'timeBlockId', 'routineId', 'reviewId')] },
  context: { whole: true, groups: [] },
  constraint: {
    groups: [group('value', 'constraintKind', 'strength', 'value'), archiveLifecycle],
  },
  planning_placement: { groups: [group('placement', 'period', 'orderKey')] },
  focus_selection: {
    groups: [
      group('target', 'kind', 'profileId', 'target'),
      group('placement', 'periodStart', 'periodEnd', 'weekStart', 'orderKey'),
    ],
  },
  theme: { groups: [group('period', 'profileId', 'month')] },
  direction: { groups: [group('period', 'profileId', 'year')] },
  project_secondary_outcome: { groups: [group('endpoints', 'projectId', 'outcomeId')] },
  milestone_project: { groups: [group('endpoints', 'milestoneId', 'projectId')] },
  milestone_action: { groups: [group('endpoints', 'milestoneId', 'actionId')] },
};

/** The groups that cover every field present in any of the documents, in a stable order. */
export function fieldGroupsFor(
  entityType: EntityType,
  documents: readonly (SyncDocument | null)[],
): readonly SyncFieldGroup[] {
  const spec = syncFieldGroups[entityType];
  const present = new Set<string>();
  for (const document of documents) {
    if (document !== null) for (const key of Object.keys(document)) present.add(key);
  }
  if (spec.whole === true) return [{ key: 'record', fields: [...present].sort() }];
  const grouped = new Set(spec.groups.flatMap((item) => item.fields));
  const singles = [...present]
    .filter((field) => !grouped.has(field))
    .sort()
    .map((field) => ({ key: field, fields: [field] }));
  return [...spec.groups, ...singles];
}

/* ───────────────────────── Canonical values ───────────────────────── */

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, `undefined` members omitted. Two
 * documents are equal exactly when their canonical JSON is equal; hashes use the same text.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError('Value is not JSON.');
    return text;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Group values as canonical text; absent fields are omitted, so absent equals absent. */
function groupText(document: SyncDocument | null, fields: readonly string[]): string {
  if (document === null) return '∅';
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (document[field] !== undefined) picked[field] = document[field];
  }
  return canonicalJson(picked);
}

export function sameDocument(left: SyncDocument | null, right: SyncDocument | null): boolean {
  if (left === null || right === null) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function assignGroup(
  target: Record<string, unknown>,
  source: SyncDocument,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (source[field] === undefined) delete target[field];
    else target[field] = source[field];
  }
}

/* ───────────────────────── Three-way merge ───────────────────────── */

export type SyncMergeResult =
  /** Local equals remote: converge. */
  | { readonly status: 'equal' }
  /** Only the remote side changed: take it. */
  | { readonly status: 'remote' }
  /** Only the local side changed: keep the local intent. */
  | { readonly status: 'local' }
  /** Both changed disjoint groups; the document still has to validate. */
  | { readonly status: 'merged'; readonly document: SyncDocument }
  /** The same group changed differently on both sides (or there is no common base). */
  | { readonly status: 'conflict'; readonly groups: readonly string[] };

/**
 * Compare base, local, and remote per field group. Without a base (`null`) every difference is a
 * conflict: nothing proves which side changed.
 */
export function threeWayMerge(
  entityType: EntityType,
  base: SyncDocument | null,
  local: SyncDocument,
  remote: SyncDocument,
): SyncMergeResult {
  if (sameDocument(local, remote)) return { status: 'equal' };
  if (base !== null && sameDocument(local, base)) return { status: 'remote' };
  if (base !== null && sameDocument(remote, base)) return { status: 'local' };

  const merged: Record<string, unknown> = { ...local };
  const conflicts: string[] = [];
  for (const item of fieldGroupsFor(entityType, [base, local, remote])) {
    const localText = groupText(local, item.fields);
    const remoteText = groupText(remote, item.fields);
    if (localText === remoteText) continue;
    const baseText = base === null ? null : groupText(base, item.fields);
    if (baseText === localText) {
      assignGroup(merged, remote, item.fields);
    } else if (baseText !== remoteText) {
      conflicts.push(item.key);
    }
  }
  if (conflicts.length > 0) return { status: 'conflict', groups: conflicts };
  return { status: 'merged', document: merged };
}

/** The document a merge result stands for, given its inputs (null for a conflict). */
export function mergedDocument(
  result: SyncMergeResult,
  local: SyncDocument,
  remote: SyncDocument,
): SyncDocument | null {
  switch (result.status) {
    case 'equal':
    case 'local':
      return local;
    case 'remote':
      return remote;
    case 'merged':
      return result.document;
    case 'conflict':
      return null;
  }
}

/**
 * Merge details: every conflicting group takes the chosen side; every other group takes whichever
 * side changed it. Returns null when a conflicting group has no choice.
 */
export function mergeWithChoices(
  entityType: EntityType,
  base: SyncDocument | null,
  local: SyncDocument,
  remote: SyncDocument,
  choices: Readonly<Record<string, 'local' | 'remote'>>,
): SyncDocument | null {
  const merged: Record<string, unknown> = { ...local };
  for (const item of fieldGroupsFor(entityType, [base, local, remote])) {
    const localText = groupText(local, item.fields);
    const remoteText = groupText(remote, item.fields);
    if (localText === remoteText) continue;
    const baseText = base === null ? null : groupText(base, item.fields);
    const choice =
      baseText === localText ? 'remote' : baseText === remoteText ? 'local' : choices[item.key];
    if (choice === undefined) return null;
    if (choice === 'remote') assignGroup(merged, remote, item.fields);
  }
  return merged;
}
