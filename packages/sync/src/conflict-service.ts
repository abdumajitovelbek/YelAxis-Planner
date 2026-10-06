/**
 * `ConflictService`: conflicts as display text a person can compare (never raw JSON
 * or ids), with labels for known fields, the records each version links to named by their titles
 * on this device, and resolution through the application's sync facade. Text stays on this
 * device; nothing here logs or sends it anywhere.
 */
import type {
  SyncApplication,
  SyncConflictLink,
  SyncConflictSide,
  SyncConflictView,
  SyncDocument,
  SyncErrorCode,
  SyncResolution,
} from '@yelaxis/application';
import { canonicalJson, fieldGroupsFor } from '@yelaxis/application';
import type { EntityType, UUID } from '@yelaxis/domain';

import type {
  AccountResult,
  ConflictChoice,
  ConflictDetailView,
  ConflictFieldView,
  ConflictService,
  ConflictSummaryView,
} from './controller-contract';

const entityLabels: Readonly<Record<EntityType, string>> = {
  profile: 'Planning preferences',
  axis: 'Axis',
  outcome: 'Outcome',
  milestone: 'Milestone',
  project: 'Project',
  action: 'Action',
  note: 'Note',
  commitment: 'Commitment',
  time_block: 'Time Block',
  routine: 'Routine',
  routine_occurrence: 'Routine occurrence',
  routine_action_defaults: 'Routine defaults',
  template: 'Template',
  review: 'Review',
  review_item: 'Review decision',
  reminder: 'Reminder',
  context: 'Context entry',
  constraint: 'Constraint',
  planning_placement: 'Placement',
  focus_selection: 'Focus selection',
  theme: 'Month theme',
  direction: 'Year direction',
  project_secondary_outcome: 'Outcome link',
  milestone_project: 'Milestone link',
  milestone_action: 'Milestone link',
};

/** Labels of field groups and fields, as people read them. */
const fieldLabels: Readonly<Record<string, string>> = {
  title: 'Title',
  note: 'Note',
  notes: 'Notes',
  body: 'Text',
  text: 'Text',
  description: 'Description',
  desiredResult: 'Desired result',
  successDefinition: 'Success definition',
  measurableCheckpoint: 'Checkpoint',
  purpose: 'Purpose',
  color: 'Color',
  icon: 'Icon',
  due: 'Due',
  estimateMinutes: 'Estimate',
  energy: 'Energy',
  priority: 'Priority',
  captureOrigin: 'Captured from',
  progress: 'Progress',
  strength: 'Strength',
  schedule: 'Reminder time',
  state: 'Status',
  lifecycle: 'Status',
  placement: 'Place and order',
  targetWindow: 'Target dates',
  interval: 'Time',
  recurrence: 'Repeats',
  period: 'Period',
  value: 'Limit or window',
  decision: 'Decision',
  target: 'Linked to',
  record: 'Context entry',
  blueprint: 'Template items',
  endpoints: 'Link',
  routine: 'Routine',
  unlinkedAt: 'Link status',
  contextId: 'Context',
  planningTimeZone: 'Planning time zone',
  weekStart: 'Week starts on',
  timeFormat: 'Time format',
  projectId: 'Project',
  axisId: 'Axis',
  outcomeId: 'Outcome',
  milestoneId: 'Milestone',
  orderKey: 'Order',
  override: 'Changed occurrence',
  archivedAt: 'Archived',
};

const textFields = new Set([
  'title',
  'note',
  'notes',
  'body',
  'text',
  'description',
  'desiredResult',
  'successDefinition',
  'measurableCheckpoint',
  'purpose',
  'themeText',
  'directionText',
  'value',
  'key',
]);

const maximumText = 280;

function humanize(value: string): string {
  const words = value.replaceAll('_', ' ').trim();
  return words.length === 0 ? words : `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
}

function text(value: string): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  return collapsed.length > maximumText ? `${collapsed.slice(0, maximumText - 1)}…` : collapsed;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const instantPattern = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?Z$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function instantText(value: string): string {
  const match = instantPattern.exec(value);
  return match === null ? value : `${match[1] ?? ''} ${match[2] ?? ''} UTC`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Records the versions link to, by id (empty when the view carries none). */
type Links = Readonly<Record<string, SyncConflictLink>>;

function withArticle(label: string): string {
  return `${/^[AEIOU]/u.test(label) ? 'An' : 'A'} ${label}`;
}

/** The record a link names, as this device knows it: by title when it can, never by id. */
function linkText(link: SyncConflictLink | undefined): string {
  if (link === undefined) return 'A linked record';
  const label = entityLabels[link.entityType];
  switch (link.presence) {
    case 'here':
      return link.title === undefined ? withArticle(label) : `${label} “${text(link.title)}”`;
    case 'deleted':
      return `A deleted ${label}`;
    case 'missing':
      return `${withArticle(label)} not on this device`;
  }
}

/** A phrase placed after other words: its leading article is lower case. */
function inSentence(phrase: string): string {
  return /^An? /u.test(phrase) ? `a${phrase.slice(1)}` : phrase;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameGroup(
  fields: readonly string[],
  left: SyncDocument | null,
  right: SyncDocument | null,
): boolean {
  return fields.every((field) => sameValue(left?.[field], right?.[field]));
}

/** One value as words. Objects get a summary by shape; nothing is ever shown as JSON. */
function valueText(field: string, value: unknown, links: Links): string {
  if (value === undefined || value === null) return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (field === 'estimateMinutes' || field === 'offsetMinutes') return `${String(value)} min`;
    if (field === 'percentage') return `${String(value)}%`;
    return String(value);
  }
  if (typeof value === 'string') {
    if (textFields.has(field)) return text(value);
    if (field === 'orderKey') return 'Set';
    if (uuidPattern.test(value)) return linkText(links[value]);
    if (datePattern.test(value)) return value;
    if (instantPattern.test(value)) return instantText(value);
    return humanize(value);
  }
  if (Array.isArray(value)) {
    if (field === 'generations') {
      return value.length === 1 ? 'One repeat rule' : `${String(value.length)} repeat rules`;
    }
    if (value.every((item) => typeof item === 'string')) {
      return value.map((item) => humanize(item)).join(', ');
    }
    return `${String(value.length)} items`;
  }
  if (isRecord(value)) return objectText(field, value, links);
  return 'Set';
}

function objectText(field: string, value: Readonly<Record<string, unknown>>, links: Links): string {
  const kind = typeof value['kind'] === 'string' ? value['kind'] : undefined;
  if (field === 'due' || field === 'schedule') {
    const date = value['date'] ?? value['instant'] ?? value['remindAt'];
    const zone = value['authoredTimeZone'] ?? value['timeZone'];
    const when = typeof date === 'string' ? valueText('date', date, links) : 'Set';
    return typeof zone === 'string' ? `${when} (${zone})` : when;
  }
  if (field === 'progress') {
    return value['mode'] === 'manual' && typeof value['percentage'] === 'number'
      ? `${String(value['percentage'])}%`
      : humanize(typeof value['mode'] === 'string' ? value['mode'] : 'none');
  }
  if (field === 'period' && kind !== undefined) {
    const parts = ['date', 'start', 'end', 'month', 'year']
      .map((key) => value[key])
      .filter((item): item is string => typeof item === 'string');
    return `${humanize(kind)} ${parts.join(' – ')}`.trim();
  }
  if (field === 'target' && kind !== undefined) {
    if (kind === 'custom' && typeof value['title'] === 'string') return text(value['title']);
    if (kind === 'deleted') return 'A deleted item';
    const id = Object.values(value).find(
      (item): item is string => typeof item === 'string' && uuidPattern.test(item),
    );
    const link = id === undefined ? undefined : links[id];
    return link === undefined ? humanize(kind) : linkText(link);
  }
  if (field === 'convertedTo' && typeof value['type'] === 'string') {
    const id = value['id'];
    const link = typeof id === 'string' ? links[id] : undefined;
    return `Converted to ${link === undefined ? humanize(value['type']) : linkText(link)}`;
  }
  if (field === 'value' && kind !== undefined) return humanize(kind);
  return kind === undefined ? 'Set' : humanize(kind);
}

/**
 * Order keys and parent ids mean nothing as text: say where a version is (without a base), or how
 * it moved from the base, naming the records it moved to or out of.
 */
function placementText(
  fields: readonly string[],
  document: SyncDocument,
  base: SyncDocument | null,
  links: Links,
): string {
  const parents = fields.filter((field) => field !== 'orderKey');
  if (base === null) {
    const places = [
      ...new Set(
        parents
          .filter((field) => document[field] !== undefined)
          .map((field) => valueText(field, document[field], links)),
      ),
    ];
    return places.length === 0 ? 'Not placed under anything' : `In ${places.join(', ')}`;
  }
  const moved = parents.filter((field) => !sameValue(document[field], base[field]));
  if (moved.length === 0) {
    return sameValue(document['orderKey'], base['orderKey'])
      ? 'Original place'
      : 'Moved in the list';
  }
  if (moved.includes('period')) return `Moved to ${valueText('period', document['period'], links)}`;
  if (!moved.every((field) => field.endsWith('Id'))) return 'Moved to another place';
  const places = moved.map((field) =>
    document[field] === undefined
      ? `out of ${inSentence(valueText(field, base[field], links))}`
      : `to ${inSentence(valueText(field, document[field], links))}`,
  );
  return `Moved ${places.join(', ')}`;
}

/** A whole field group as one line of words. */
function groupText(
  entityType: EntityType,
  fields: readonly string[],
  side: SyncConflictSide,
  base: SyncDocument | null,
  links: Links,
): string | undefined {
  if (side.deleted) return 'Deleted';
  const document = side.document;
  if (document === null) return undefined;
  if (fields.includes('startsAt') && fields.includes('endsAt')) {
    const starts = document['startsAt'];
    const ends = document['endsAt'];
    const zone = document['timeZone'];
    if (typeof starts === 'string' && typeof ends === 'string') {
      return `${instantText(starts)} – ${instantText(ends)}${typeof zone === 'string' ? ` (${zone})` : ''}`;
    }
  }
  if (fields.includes('state')) {
    const state = document['state'];
    if (typeof state === 'string') return humanize(state);
  }
  if (fields.includes('orderKey')) return placementText(fields, document, base, links);
  if (entityType === 'context' && fields.length > 1) {
    const value = document['value'];
    const key = document['key'];
    return [
      typeof key === 'string' ? text(key) : undefined,
      typeof value === 'string' ? text(value) : undefined,
    ]
      .filter((item) => item !== undefined)
      .join(': ');
  }
  // The account's own planning preferences are the same Profile on every version.
  const parts = fields
    .filter((field) => field !== 'profileId' && document[field] !== undefined)
    .map((field) => valueText(field, document[field], links));
  return parts.length === 0 ? 'Not set' : parts.join(' · ');
}

/**
 * Delete versus edit: the groups the edited version changed against the base, or every group it
 * holds when there is no base (the deleted side reads "Deleted").
 */
function editedGroups(
  view: SyncConflictView,
  groups: readonly { readonly key: string; readonly fields: readonly string[] }[],
): readonly string[] {
  const edited = view.local.deleted ? view.remote.document : view.local.document;
  if (edited === null) return [];
  const base = view.base;
  return groups
    .filter((group) =>
      base === null
        ? group.fields.some((field) => edited[field] !== undefined)
        : !sameGroup(group.fields, edited, base),
    )
    .map((group) => group.key);
}

function fieldViews(view: SyncConflictView): readonly ConflictFieldView[] {
  const links = view.links ?? {};
  const groups = fieldGroupsFor(view.entityType, [
    view.base,
    view.local.document,
    view.remote.document,
  ]);
  const keys = view.local.deleted || view.remote.deleted ? editedGroups(view, groups) : view.fields;
  return keys.map((key) => {
    const group = groups.find((item) => item.key === key);
    const fields = group?.fields ?? [key];
    const describe = (side: SyncConflictSide): string | undefined =>
      groupText(view.entityType, fields, side, view.base, links);
    const base = view.base === null ? undefined : describe({ deleted: false, document: view.base });
    const local = describe(view.local);
    let remote = describe(view.remote);
    // Two different versions never read alike, so a choice between them is never a guess.
    if (
      local !== undefined &&
      remote !== undefined &&
      local === remote &&
      !sameGroup(fields, view.local.document, view.remote.document)
    ) {
      remote = `${remote} (different)`;
    }
    return {
      field: key,
      label: fieldLabels[key] ?? humanize(key),
      ...(base === undefined ? {} : { base }),
      ...(local === undefined ? {} : { local }),
      ...(remote === undefined ? {} : { remote }),
    };
  });
}

function titleOf(view: SyncConflictView): string {
  for (const side of [view.local, view.remote, { deleted: false, document: view.base }]) {
    const document = side.document;
    if (document === null) continue;
    for (const field of ['title', 'text', 'key', 'body']) {
      const value = document[field];
      if (typeof value === 'string' && value.trim().length > 0) return text(value);
    }
  }
  return withArticle(entityLabels[view.entityType]);
}

function summaryOf(view: SyncConflictView): ConflictSummaryView {
  return {
    conflictId: view.conflictId,
    // The record kind; what happened to it is told by `kind`.
    kindLabel: entityLabels[view.entityType],
    title: titleOf(view),
    kind: view.kind,
    createdAt: view.createdAt,
  };
}

const errorMessages: Readonly<Record<SyncErrorCode, string>> = {
  no_account: 'Sign in to resolve this change.',
  not_found: 'This conflict is no longer here.',
  not_open: 'This conflict was already resolved.',
  invalid_choice: 'That choice is not available for this conflict.',
  invalid_merge: 'Choose a version for every field. The combined version has to be valid.',
  still_referenced:
    'Other items on this device still use this one. Change or remove them first, or restore it.',
  not_ready:
    'A change to this item is still on its way to your account. Try again after the next sync.',
  transaction_failed: 'Nothing was changed. Try again.',
};

export interface ConflictServiceOptions {
  readonly application: SyncApplication;
  /** Called after a resolution commits (for example to sync at once). */
  readonly onResolved?: () => void;
}

export function createConflictService(options: ConflictServiceOptions): ConflictService {
  const { application } = options;
  return {
    async list() {
      return (await application.listConflicts()).map(summaryOf);
    },
    async get(conflictId: string): Promise<ConflictDetailView | null> {
      const view = await application.getConflict(conflictId as UUID);
      if (view === null) return null;
      return { ...summaryOf(view), fields: fieldViews(view), choices: view.choices };
    },
    async resolve(conflictId: string, choice: ConflictChoice): Promise<AccountResult> {
      const resolution: SyncResolution =
        choice.choice === 'merge'
          ? { choice: 'merge', fields: choice.fields }
          : { choice: choice.choice };
      const result = await application.resolveConflict(conflictId as UUID, resolution);
      if (!result.ok) {
        return { ok: false, code: result.code, message: errorMessages[result.code] };
      }
      try {
        options.onResolved?.();
      } catch {
        // Syncing afterwards is a convenience; the resolution already committed locally.
      }
      return { ok: true, value: undefined };
    },
  };
}
