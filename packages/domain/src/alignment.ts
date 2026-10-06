/**
 * alignment rules for Axes, Outcomes, Projects, and Milestones: lifecycle helpers, command
 * input limits, the typed relationship catalog with its link and unlink rules, Outcome progress, and
 * the Project next-action projection.
 *
 * Everything here is pure and manual. Nothing ranks, scores, or changes a state because of
 * progress, time, placement, or a relationship. Error messages are shown to the person as written,
 * so each one is calm and says what to do next.
 */
import {
  entityRefKey,
  err,
  ok,
  parseUUID,
  type DomainError,
  type DomainResult,
  type EntityRef,
  type UUID,
} from './contracts.js';
import type { OutcomeProgress } from './entities.js';
import { compareOrder } from './ordering.js';
import {
  relationshipKey,
  validateRelationshipLink,
  validateRelationshipUnlink,
  type TypedRelationship,
} from './planning-policy.js';
import {
  restoreLifecycle,
  transitionLifecycle,
  type ActionState,
  type AxisState,
  type MilestoneState,
  type OutcomeState,
  type ProjectState,
  type RoutineState,
} from './states.js';
import {
  createTargetWindow,
  parseCalendarDate,
  type CalendarDate,
  type TargetWindow,
} from './time.js';
import { deriveNameBasedUuid, yelaxisDerivedIdNamespace } from './uuid.js';

/* ───────────────────────── Kinds and states ───────────────────────── */

/** Objects managed by the alignment surfaces. */
export type AlignmentKind = 'axis' | 'outcome' | 'project' | 'milestone';
/** Every object that can appear as a node of the alignment map or relationship list. */
export type AlignmentNodeKind = AlignmentKind | 'action' | 'routine' | 'note';

export const alignmentKinds: readonly AlignmentKind[] = ['axis', 'outcome', 'project', 'milestone'];
export const alignmentNodeKinds: readonly AlignmentNodeKind[] = [
  ...alignmentKinds,
  'action',
  'routine',
  'note',
];

export interface AlignmentStates {
  readonly axis: AxisState;
  readonly outcome: OutcomeState;
  readonly project: ProjectState;
  readonly milestone: MilestoneState;
}
export type AlignmentState<K extends AlignmentKind = AlignmentKind> = AlignmentStates[K];
/** Any state except `archived`, which only the archive and restore commands enter and leave. */
export type AlignmentLiveState<K extends AlignmentKind = AlignmentKind> = Exclude<
  AlignmentStates[K],
  'archived'
>;

export const alignmentLiveStates: {
  readonly [K in AlignmentKind]: readonly AlignmentLiveState<K>[];
} = {
  axis: ['active'],
  outcome: ['active', 'paused', 'achieved', 'abandoned'],
  project: ['idea', 'active', 'blocked', 'paused', 'completed'],
  milestone: ['active', 'completed', 'canceled'],
};

/** "Current" sets for Axis counts and default lists; finished states sit behind "Show finished". */
export const currentOutcomeStates: readonly OutcomeState[] = ['active', 'paused'];
export const currentProjectStates: readonly ProjectState[] = [
  'idea',
  'active',
  'blocked',
  'paused',
];
export const currentRoutineStates: readonly RoutineState[] = ['active', 'paused'];

const kindLabels: Readonly<Record<AlignmentNodeKind, string>> = {
  axis: 'Axis',
  outcome: 'Outcome',
  project: 'Project',
  milestone: 'Milestone',
  action: 'Action',
  routine: 'Routine',
  note: 'Note',
};

const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/* ───────────────────────── Lifecycle ───────────────────────── */

/** The lifecycle facts a transition needs; a stored document of the same kind satisfies it. */
export interface AlignmentLifecycleSnapshot<K extends AlignmentKind = AlignmentKind> {
  readonly state: AlignmentState<K>;
  readonly stateBeforeArchive?: AlignmentLiveState<K> | undefined;
  /** Projects only: leaving `idea` needs a non-blank desired result. */
  readonly desiredResult?: string | undefined;
}

const transitionRejected = (
  kind: AlignmentKind,
  from: string,
  to: string,
  reason: string,
  message: string,
): DomainResult<never> =>
  err({ code: 'invalid_transition', message, details: { entityType: kind, from, to, reason } });

const stateWord = (state: string): string => (state === 'idea' ? 'an idea' : state);

/**
 * Validate a manual state change of an Axis, Outcome, Project, or Milestone. `archived` is never a
 * source or destination here: archive and restore are their own commands. The legal pairs are the
 * shared lifecycle machines (state-machines.md); leaving a Project `idea` needs a desired result.
 */
export const transitionAlignmentObject = <K extends AlignmentKind>(
  kind: K,
  current: AlignmentLifecycleSnapshot<K>,
  to: AlignmentState<K>,
): DomainResult<AlignmentLiveState<K>> => {
  const from: string = current.state;
  const target: string = to;
  const label = kindLabels[kind];
  if (target === 'archived') {
    return transitionRejected(
      kind,
      from,
      target,
      'archive_command',
      `Use Archive to archive this ${label}. It keeps its history and links.`,
    );
  }
  if (from === 'archived') {
    return transitionRejected(
      kind,
      from,
      target,
      'restore_first',
      `Restore this ${label} before changing its state.`,
    );
  }
  if (from === target) {
    return transitionRejected(
      kind,
      from,
      target,
      'same_state',
      `This ${label} is already ${stateWord(target)}.`,
    );
  }
  const live: readonly string[] = alignmentLiveStates[kind];
  if (
    !live.includes(from) ||
    !live.includes(target) ||
    !transitionLifecycle({ entityType: kind, current: { state: current.state }, to }).ok
  ) {
    return transitionRejected(
      kind,
      from,
      target,
      'not_allowed',
      `This ${label} cannot change from ${from} to ${target}.`,
    );
  }
  if (kind === 'project' && target !== 'idea' && !hasText(current.desiredResult)) {
    return transitionRejected(
      kind,
      from,
      target,
      'desired_result_required',
      target === 'active'
        ? 'Add a desired result before activating this Project.'
        : 'Add a desired result before changing the state of this Project.',
    );
  }
  return ok(target as AlignmentLiveState<K>);
};

/**
 * The state a restore returns to: the recorded `stateBeforeArchive` when it is still valid,
 * otherwise `active`. A Project without a desired result can only be an idea, so its fallback is
 * `idea` (a recorded non-idea state without a desired result also falls back to `idea`).
 */
export const restoreAlignmentState = <K extends AlignmentKind>(
  kind: K,
  snapshot: AlignmentLifecycleSnapshot<K>,
): DomainResult<AlignmentLiveState<K>> => {
  if (snapshot.state !== 'archived') {
    return transitionRejected(
      kind,
      snapshot.state,
      'restore',
      'not_archived',
      `This ${kindLabels[kind]} is not archived.`,
    );
  }
  const live: readonly string[] = alignmentLiveStates[kind];
  const recorded: string | undefined = snapshot.stateBeforeArchive;
  const recordedIsLive = recorded !== undefined && live.includes(recorded);
  if (kind === 'project') {
    const withResult = hasText(snapshot.desiredResult);
    if (recordedIsLive && (recorded === 'idea' || withResult)) {
      return ok(recorded as AlignmentLiveState<K>);
    }
    return ok((withResult ? 'active' : 'idea') as AlignmentLiveState<K>);
  }
  const restored = restoreLifecycle(kind, {
    state: 'archived',
    ...(recordedIsLive ? { stateBeforeArchive: recorded as AlignmentLiveState<K> } : {}),
  });
  if (!restored.ok) return restored;
  return ok(restored.value.state as AlignmentLiveState<K>);
};

/* ───────────────────────── Command input limits ───────────────────────── */

/**
 * Limits for new command input only. They are never applied when decoding stored rows or in
 * database triggers, so an existing longer value (for example from a template) still loads.
 */
export const alignmentFieldLimits = Object.freeze({
  axisTitle: 80,
  outcomeTitle: 120,
  projectTitle: 200,
  milestoneTitle: 200,
  /** purpose, success definition, desired result, measurable checkpoint, Project description. */
  longText: 2_000,
  projectNotes: 10_000,
});

/** Named, decorative Axis colors. The UI labels each by name; color never carries meaning. */
export const axisColorTokens = Object.freeze([
  { token: 'cyan', label: 'Cyan' },
  { token: 'violet', label: 'Violet' },
  { token: 'emerald', label: 'Emerald' },
  { token: 'amber', label: 'Amber' },
  { token: 'rose', label: 'Rose' },
  { token: 'slate', label: 'Slate' },
] as const);
export type AxisColorToken = (typeof axisColorTokens)[number]['token'];

export const isAxisColorToken = (value: unknown): value is AxisColorToken =>
  typeof value === 'string' && axisColorTokens.some((entry) => entry.token === value);

/** Optional Axis icon name: a lowercase letter followed by up to 31 letters, digits, or hyphens. */
export const axisIconPattern = /^[a-z][a-z0-9-]{0,31}$/u;

export interface AxisFieldsInput {
  readonly title: string;
  readonly purpose?: string | undefined;
  readonly color?: string | undefined;
  readonly icon?: string | undefined;
}

export interface OutcomeFieldsInput {
  readonly title: string;
  readonly successDefinition: string;
  readonly targetStart?: string | undefined;
  readonly targetEnd?: string | undefined;
}

export interface ProjectFieldsInput {
  readonly title: string;
  readonly desiredResult?: string | undefined;
  readonly description?: string | undefined;
  readonly notes?: string | undefined;
  readonly targetStart?: string | undefined;
  readonly targetEnd?: string | undefined;
}

export interface MilestoneFieldsInput {
  readonly title: string;
  readonly measurableCheckpoint: string;
  readonly targetStart?: string | undefined;
  readonly targetEnd?: string | undefined;
}

/** Inclusive calendar dates; either boundary may be absent; start is never after end. */
export interface TargetWindowFields {
  readonly targetStart?: CalendarDate;
  readonly targetEnd?: CalendarDate;
}

export interface AxisFields {
  readonly title: string;
  readonly purpose?: string;
  readonly color?: AxisColorToken;
  readonly icon?: string;
}

export interface OutcomeFields extends TargetWindowFields {
  readonly title: string;
  readonly successDefinition: string;
}

export interface ProjectFields extends TargetWindowFields {
  readonly title: string;
  readonly desiredResult?: string;
  readonly description?: string;
  readonly notes?: string;
}

export interface MilestoneFields extends TargetWindowFields {
  readonly title: string;
  readonly measurableCheckpoint: string;
}

export interface AlignmentFieldsInputs {
  readonly axis: AxisFieldsInput;
  readonly outcome: OutcomeFieldsInput;
  readonly project: ProjectFieldsInput;
  readonly milestone: MilestoneFieldsInput;
}

export interface AlignmentFieldsByKind {
  readonly axis: AxisFields;
  readonly outcome: OutcomeFields;
  readonly project: ProjectFields;
  readonly milestone: MilestoneFields;
}

const fieldError = (reason: string, field: string, message: string): DomainResult<never> =>
  err({ code: 'invalid_value', message, details: { reason, field } });

const count = (value: number): string => value.toLocaleString('en-US');

const requiredTitle = (value: unknown, maximum: number): DomainResult<string> => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) return fieldError('title_required', 'title', 'Add a title.');
  if (text.length > maximum) {
    return fieldError(
      'title_too_long',
      'title',
      `Keep the title to ${count(maximum)} characters or fewer.`,
    );
  }
  return ok(text);
};

interface TextField {
  readonly field: string;
  /** Used in "Add a …" and "Keep the … to N characters or fewer." */
  readonly name: string;
  readonly article: 'a' | 'an' | '';
  readonly maximum: number;
}

const tooLong = (spec: TextField): DomainResult<never> =>
  fieldError(
    'text_too_long',
    spec.field,
    `Keep the ${spec.name} to ${count(spec.maximum)} characters or fewer.`,
  );

const requiredText = (value: unknown, spec: TextField): DomainResult<string> => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    const noun = spec.article === '' ? spec.name : `${spec.article} ${spec.name}`;
    return fieldError('text_required', spec.field, `Add ${noun}.`);
  }
  if (text.length > spec.maximum) return tooLong(spec);
  return ok(text);
};

/** Blank optional text is omitted rather than stored. */
const optionalText = (value: unknown, spec: TextField): DomainResult<string | undefined> => {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== 'string') {
    return fieldError('text_invalid', spec.field, `Check the ${spec.name} and try again.`);
  }
  const text = value.trim();
  if (text.length === 0) return ok(undefined);
  if (text.length > spec.maximum) return tooLong(spec);
  return ok(text);
};

const longText = (field: string, name: string, article: TextField['article']): TextField => ({
  field,
  name,
  article,
  maximum: alignmentFieldLimits.longText,
});

const textFields = {
  purpose: longText('purpose', 'purpose', 'a'),
  successDefinition: longText('successDefinition', 'success definition', 'a'),
  desiredResult: longText('desiredResult', 'desired result', 'a'),
  description: longText('description', 'description', 'a'),
  measurableCheckpoint: longText('measurableCheckpoint', 'measurable checkpoint', 'a'),
  notes: {
    field: 'notes',
    name: 'notes',
    article: '',
    maximum: alignmentFieldLimits.projectNotes,
  },
} as const satisfies Readonly<Record<string, TextField>>;

const absent = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

const parseTargetDate = (
  value: unknown,
  field: 'targetStart' | 'targetEnd',
): DomainResult<CalendarDate | undefined> => {
  if (absent(value)) return ok(undefined);
  const parsed = typeof value === 'string' ? parseCalendarDate(value.trim()) : undefined;
  if (parsed?.ok === true) return ok(parsed.value);
  return fieldError(
    'target_window',
    field,
    field === 'targetStart'
      ? 'Enter the target start as a valid date.'
      : 'Enter the target end as a valid date.',
  );
};

/** Validate an optional, possibly one-sided, inclusive target window. */
export const validateTargetWindowInput = (
  start: unknown,
  end: unknown,
): DomainResult<TargetWindowFields> => {
  const targetStart = parseTargetDate(start, 'targetStart');
  if (!targetStart.ok) return targetStart;
  const targetEnd = parseTargetDate(end, 'targetEnd');
  if (!targetEnd.ok) return targetEnd;
  const window: TargetWindow = {
    ...(targetStart.value === undefined ? {} : { start: targetStart.value }),
    ...(targetEnd.value === undefined ? {} : { end: targetEnd.value }),
  };
  if (window.start !== undefined || window.end !== undefined) {
    const ordered = createTargetWindow(window);
    if (!ordered.ok) {
      return fieldError(
        'target_window',
        'targetEnd',
        'The target end must be on or after the target start.',
      );
    }
  }
  return ok({
    ...(targetStart.value === undefined ? {} : { targetStart: targetStart.value }),
    ...(targetEnd.value === undefined ? {} : { targetEnd: targetEnd.value }),
  });
};

const optionalColor = (value: unknown): DomainResult<AxisColorToken | undefined> => {
  if (absent(value)) return ok(undefined);
  return isAxisColorToken(value)
    ? ok(value)
    : fieldError('color', 'color', 'Choose one of the listed colors.');
};

const optionalIcon = (value: unknown): DomainResult<string | undefined> => {
  if (absent(value)) return ok(undefined);
  return typeof value === 'string' && axisIconPattern.test(value)
    ? ok(value)
    : fieldError(
        'icon',
        'icon',
        'Use an icon name that starts with a lowercase letter and has up to 32 lowercase letters, digits, or hyphens.',
      );
};

const validateAxisFields = (input: AxisFieldsInput): DomainResult<AxisFields> => {
  const title = requiredTitle(input.title, alignmentFieldLimits.axisTitle);
  if (!title.ok) return title;
  const purpose = optionalText(input.purpose, textFields.purpose);
  if (!purpose.ok) return purpose;
  const color = optionalColor(input.color);
  if (!color.ok) return color;
  const icon = optionalIcon(input.icon);
  if (!icon.ok) return icon;
  return ok({
    title: title.value,
    ...(purpose.value === undefined ? {} : { purpose: purpose.value }),
    ...(color.value === undefined ? {} : { color: color.value }),
    ...(icon.value === undefined ? {} : { icon: icon.value }),
  });
};

const validateOutcomeFields = (input: OutcomeFieldsInput): DomainResult<OutcomeFields> => {
  const title = requiredTitle(input.title, alignmentFieldLimits.outcomeTitle);
  if (!title.ok) return title;
  const success = requiredText(input.successDefinition, textFields.successDefinition);
  if (!success.ok) return success;
  const window = validateTargetWindowInput(input.targetStart, input.targetEnd);
  if (!window.ok) return window;
  return ok({ title: title.value, successDefinition: success.value, ...window.value });
};

const validateProjectFields = (input: ProjectFieldsInput): DomainResult<ProjectFields> => {
  const title = requiredTitle(input.title, alignmentFieldLimits.projectTitle);
  if (!title.ok) return title;
  const desiredResult = optionalText(input.desiredResult, textFields.desiredResult);
  if (!desiredResult.ok) return desiredResult;
  const description = optionalText(input.description, textFields.description);
  if (!description.ok) return description;
  const notes = optionalText(input.notes, textFields.notes);
  if (!notes.ok) return notes;
  const window = validateTargetWindowInput(input.targetStart, input.targetEnd);
  if (!window.ok) return window;
  return ok({
    title: title.value,
    ...(desiredResult.value === undefined ? {} : { desiredResult: desiredResult.value }),
    ...(description.value === undefined ? {} : { description: description.value }),
    ...(notes.value === undefined ? {} : { notes: notes.value }),
    ...window.value,
  });
};

const validateMilestoneFields = (input: MilestoneFieldsInput): DomainResult<MilestoneFields> => {
  const title = requiredTitle(input.title, alignmentFieldLimits.milestoneTitle);
  if (!title.ok) return title;
  const checkpoint = requiredText(input.measurableCheckpoint, textFields.measurableCheckpoint);
  if (!checkpoint.ok) return checkpoint;
  const window = validateTargetWindowInput(input.targetStart, input.targetEnd);
  if (!window.ok) return window;
  return ok({ title: title.value, measurableCheckpoint: checkpoint.value, ...window.value });
};

const fieldValidators: {
  readonly [K in AlignmentKind]: (
    input: AlignmentFieldsInputs[K],
  ) => DomainResult<AlignmentFieldsByKind[K]>;
} = {
  axis: validateAxisFields,
  outcome: validateOutcomeFields,
  project: validateProjectFields,
  milestone: validateMilestoneFields,
};

/**
 * Trim, cap, and normalize the editable fields of one kind. Blank optional text is dropped;
 * errors are `invalid_value` with `details.reason` (`title_required`, `title_too_long`,
 * `text_required`, `text_too_long`, `target_window`, `color`, `icon`) and `details.field`.
 */
export const validateAlignmentInput = <K extends AlignmentKind>(
  kind: K,
  input: AlignmentFieldsInputs[K],
): DomainResult<AlignmentFieldsByKind[K]> => {
  if (typeof input !== 'object' || input === null) {
    return fieldError('input', 'input', 'Check the details and try again.');
  }
  const validate: (value: AlignmentFieldsInputs[K]) => DomainResult<AlignmentFieldsByKind[K]> =
    fieldValidators[kind];
  return validate(input);
};

/* ───────────────────────── Snapshot invariants ───────────────────────── */

const snapshotError = (reason: string): DomainResult<never> =>
  err({
    code: 'invalid_value',
    message: 'This item has details that cannot be saved. Check them and try again.',
    details: { reason },
  });

const archiveMetadataAgrees = (value: {
  readonly state: string;
  readonly stateBeforeArchive?: string | undefined;
  readonly archivedAt?: string | undefined;
}): boolean => {
  const archived = value.state === 'archived';
  return (
    archived === (value.archivedAt !== undefined) &&
    archived === (value.stateBeforeArchive !== undefined)
  );
};

/** Axis invariants; a stored Axis document satisfies this shape. No input caps apply here. */
export interface AxisSnapshot {
  readonly title: string;
  readonly orderKey: string;
  readonly state: AxisState;
  readonly stateBeforeArchive?: 'active' | undefined;
  readonly archivedAt?: string | undefined;
}

export const validateAxisSnapshot = <T extends AxisSnapshot>(axis: T): DomainResult<T> => {
  if (!hasText(axis.title) || !hasText(axis.orderKey)) return snapshotError('axis_required_text');
  if (axis.state !== 'active' && axis.state !== 'archived') return snapshotError('axis_state');
  if (
    (axis.stateBeforeArchive !== undefined && axis.stateBeforeArchive !== 'active') ||
    !archiveMetadataAgrees(axis)
  ) {
    return snapshotError('axis_archive_metadata');
  }
  return ok(axis);
};

/**
 * Milestone invariants; a stored Milestone document (target dates) or a domain Milestone (target
 * window) satisfies this shape. No input caps apply here.
 */
export interface MilestoneSnapshot {
  readonly title: string;
  readonly measurableCheckpoint: string;
  readonly outcomeId: string;
  readonly orderKey: string;
  readonly state: MilestoneState;
  readonly stateBeforeArchive?: Exclude<MilestoneState, 'archived'> | undefined;
  readonly archivedAt?: string | undefined;
  readonly targetStart?: string | undefined;
  readonly targetEnd?: string | undefined;
  readonly targetWindow?: TargetWindow | undefined;
}

export const validateMilestoneSnapshot = <T extends MilestoneSnapshot>(
  milestone: T,
): DomainResult<T> => {
  if (
    !hasText(milestone.title) ||
    !hasText(milestone.measurableCheckpoint) ||
    !hasText(milestone.orderKey)
  ) {
    return snapshotError('milestone_required_text');
  }
  if (!parseUUID(milestone.outcomeId).ok) return snapshotError('milestone_outcome');
  const states: readonly string[] = [...alignmentLiveStates.milestone, 'archived'];
  if (
    !states.includes(milestone.state) ||
    (milestone.stateBeforeArchive !== undefined &&
      !alignmentLiveStates.milestone.includes(milestone.stateBeforeArchive)) ||
    !archiveMetadataAgrees(milestone)
  ) {
    return snapshotError('milestone_archive_metadata');
  }
  const windows = [
    [milestone.targetStart, milestone.targetEnd],
    [milestone.targetWindow?.start, milestone.targetWindow?.end],
  ] as const;
  for (const [start, end] of windows) {
    if (start !== undefined && end !== undefined && start > end) {
      return snapshotError('milestone_target_window');
    }
  }
  return ok(milestone);
};

/* ───────────────────────── Outcome progress ───────────────────────── */

/**
 * Normalize a progress choice. Only `manual` stores a percentage (an integer 0-100); switching to
 * another mode drops it. Progress never changes the Outcome state.
 */
export const validateOutcomeProgressInput = (
  input: OutcomeProgress,
): DomainResult<OutcomeProgress> => {
  const mode: unknown = (input as { readonly mode?: unknown } | null)?.mode;
  switch (mode) {
    case 'none':
      return ok({ mode: 'none' });
    case 'milestone_derived':
      return ok({ mode: 'milestone_derived' });
    case 'manual': {
      const percentage: unknown = (input as { readonly percentage?: unknown }).percentage;
      if (
        typeof percentage !== 'number' ||
        !Number.isInteger(percentage) ||
        percentage < 0 ||
        percentage > 100
      ) {
        return fieldError(
          'progress_percentage',
          'percentage',
          'Enter a whole number from 0 to 100.',
        );
      }
      return ok({ mode: 'manual', percentage });
    }
    default:
      return fieldError('progress_mode', 'progress', 'Choose how progress is measured.');
  }
};

/**
 * Milestone counts for Milestone-derived progress (flagged for owner review):
 * `completed` counts `completed` Milestones; `total` counts `active` plus `completed`; `canceled` is
 * reported separately and never counted; archived Milestones are excluded entirely.
 */
export interface MilestoneProgressCounts {
  readonly completed: number;
  readonly total: number;
  readonly canceled: number;
}

export const countMilestoneProgress = (
  states: Iterable<MilestoneState>,
): MilestoneProgressCounts => {
  let completed = 0;
  let total = 0;
  let canceled = 0;
  for (const state of states) {
    if (state === 'completed') {
      completed += 1;
      total += 1;
    } else if (state === 'active') {
      total += 1;
    } else if (state === 'canceled') {
      canceled += 1;
    }
  }
  return { completed, total, canceled };
};

/** Structurally compatible with the application `OutcomeProgressView`. */
export type OutcomeProgressSummary =
  | { readonly mode: 'none' }
  | { readonly mode: 'manual'; readonly percentage: number }
  | {
      readonly mode: 'milestone_derived';
      readonly completed: number;
      readonly total: number;
      readonly canceled: number;
    };

/** The visible progress of an Outcome. Milestone-derived progress is a count, never a percentage. */
export const outcomeProgress = (
  progress: OutcomeProgress,
  counts: MilestoneProgressCounts,
): OutcomeProgressSummary => {
  switch (progress.mode) {
    case 'none':
      return { mode: 'none' };
    case 'manual':
      return { mode: 'manual', percentage: progress.percentage };
    case 'milestone_derived':
      return {
        mode: 'milestone_derived',
        completed: counts.completed,
        total: counts.total,
        canceled: counts.canceled,
      };
  }
};

/**
 * How progress reads: `no_measure` ("No progress measure"), `manual_percentage` ("N% (set
 * manually)"), `no_milestones` ("No milestones yet", never 0%), or `milestone_count` ("C of T
 * milestones completed", canceled shown separately).
 */
export type OutcomeProgressStatus =
  'no_measure' | 'manual_percentage' | 'no_milestones' | 'milestone_count';

export const outcomeProgressStatus = (
  progress:
    | { readonly mode: 'none' }
    | { readonly mode: 'manual'; readonly percentage: number }
    | { readonly mode: 'milestone_derived'; readonly total: number },
): OutcomeProgressStatus => {
  switch (progress.mode) {
    case 'none':
      return 'no_measure';
    case 'manual':
      return 'manual_percentage';
    case 'milestone_derived':
      return progress.total === 0 ? 'no_milestones' : 'milestone_count';
  }
};

/* ───────────────────────── Project next action ───────────────────────── */

/** Unfinished Action states that can be a Project's next action. */
export const nextActionStates: readonly ActionState[] = [
  'inbox',
  'planned',
  'scheduled',
  'in_progress',
];

export interface NextActionCandidate {
  readonly id: string;
  readonly state: ActionState;
  readonly orderKey: string;
}

export type ProjectNextAction<T> =
  | { readonly status: 'not_applicable' }
  | { readonly status: 'missing' }
  | { readonly status: 'present'; readonly action: T };

/**
 * The next action of an `active` Project: its first unfinished Action (inbox, planned, scheduled,
 * or in progress) in (order key, id) order. Other Project states are `not_applicable`. The caller
 * passes the Project's own Actions. This is a projection only: it never blocks saving, never
 * re-ranks, and never changes an Action.
 */
export const projectNextAction = <T extends NextActionCandidate>(
  projectState: ProjectState,
  projectActions: readonly T[],
): ProjectNextAction<T> => {
  if (projectState !== 'active') return { status: 'not_applicable' };
  let next: T | undefined;
  for (const action of projectActions) {
    if (!nextActionStates.includes(action.state)) continue;
    if (next === undefined || compareOrder(action, next) < 0) next = action;
  }
  return next === undefined ? { status: 'missing' } : { status: 'present', action: next };
};

/* ───────────────────────── Relationship catalog ───────────────────────── */

export type AlignmentRelationship =
  | 'axis_outcome'
  | 'axis_project'
  | 'axis_routine'
  | 'outcome_milestone'
  | 'outcome_primary_project'
  | 'outcome_secondary_project'
  | 'project_action'
  | 'project_note'
  | 'milestone_project'
  | 'milestone_action';

/** Many-to-many relationships stored as typed join records. */
export type AlignmentJoinRelationship =
  'outcome_secondary_project' | 'milestone_project' | 'milestone_action';

/** Entity types of the join records. */
export type AlignmentLinkEntityType =
  'project_secondary_outcome' | 'milestone_project' | 'milestone_action';

export type AlignmentParentKind = 'axis' | 'outcome' | 'project' | 'milestone';
export type AlignmentChildKind =
  'outcome' | 'project' | 'routine' | 'milestone' | 'action' | 'note';
/** Child document field that holds the parent id of a foreign-key relationship. */
export type AlignmentForeignKey = 'axisId' | 'outcomeId' | 'primaryOutcomeId' | 'projectId';

interface AlignmentRelationshipRuleBase {
  readonly relationship: AlignmentRelationship;
  readonly parentKind: AlignmentParentKind;
  readonly childKind: AlignmentChildKind;
  /** A required link is moved (reparented), never removed. */
  readonly required: boolean;
  /**
   * alignment commands never link or unlink it: a Note's Project is shown only, and a
   * Routine's Axis is edited in the Routine form.
   */
  readonly displayOnly: boolean;
}

export type AlignmentRelationshipRule =
  | (AlignmentRelationshipRuleBase & {
      readonly storage: 'fk';
      /** How many parents of this relationship one child may have. */
      readonly childCardinality: 'zero_or_one' | 'exactly_one';
      readonly foreignKey: AlignmentForeignKey;
    })
  | (AlignmentRelationshipRuleBase & {
      readonly storage: 'join';
      readonly childCardinality: 'many';
      readonly linkEntityType: AlignmentLinkEntityType;
    });

const fk = (
  relationship: AlignmentRelationship,
  parentKind: AlignmentParentKind,
  childKind: AlignmentChildKind,
  foreignKey: AlignmentForeignKey,
  options: { readonly required?: boolean; readonly displayOnly?: boolean } = {},
): AlignmentRelationshipRule => ({
  relationship,
  parentKind,
  childKind,
  storage: 'fk',
  childCardinality: options.required === true ? 'exactly_one' : 'zero_or_one',
  foreignKey,
  required: options.required === true,
  displayOnly: options.displayOnly === true,
});

const join = (
  relationship: AlignmentJoinRelationship,
  parentKind: AlignmentParentKind,
  childKind: AlignmentChildKind,
  linkEntityType: AlignmentLinkEntityType,
): AlignmentRelationshipRule => ({
  relationship,
  parentKind,
  childKind,
  storage: 'join',
  childCardinality: 'many',
  linkEntityType,
  required: false,
  displayOnly: false,
});

export const alignmentRelationshipRules: Readonly<
  Record<AlignmentRelationship, AlignmentRelationshipRule>
> = Object.freeze({
  axis_outcome: fk('axis_outcome', 'axis', 'outcome', 'axisId'),
  axis_project: fk('axis_project', 'axis', 'project', 'axisId'),
  axis_routine: fk('axis_routine', 'axis', 'routine', 'axisId', { displayOnly: true }),
  outcome_milestone: fk('outcome_milestone', 'outcome', 'milestone', 'outcomeId', {
    required: true,
  }),
  outcome_primary_project: fk('outcome_primary_project', 'outcome', 'project', 'primaryOutcomeId'),
  outcome_secondary_project: join(
    'outcome_secondary_project',
    'outcome',
    'project',
    'project_secondary_outcome',
  ),
  project_action: fk('project_action', 'project', 'action', 'projectId'),
  project_note: fk('project_note', 'project', 'note', 'projectId', { displayOnly: true }),
  milestone_project: join('milestone_project', 'milestone', 'project', 'milestone_project'),
  milestone_action: join('milestone_action', 'milestone', 'action', 'milestone_action'),
});

/**
 * Every allowed alignment relationship in fixed display order. Parent and child kinds are typed, so
 * a cycle is structurally impossible; any other pair, or a swapped endpoint pair, is unsupported.
 */
export const alignmentRelationships: readonly AlignmentRelationshipRule[] = Object.freeze(
  (
    [
      'axis_outcome',
      'axis_project',
      'axis_routine',
      'outcome_milestone',
      'outcome_primary_project',
      'outcome_secondary_project',
      'project_action',
      'project_note',
      'milestone_project',
      'milestone_action',
    ] as const
  ).map((relationship) => alignmentRelationshipRules[relationship]),
);

export const isAlignmentRelationship = (value: unknown): value is AlignmentRelationship =>
  typeof value === 'string' && Object.hasOwn(alignmentRelationshipRules, value);

/** Relationships in which `kind` is the child (its direct parents), in display order. */
export const alignmentRelationshipsAbove = (
  kind: AlignmentNodeKind,
): readonly AlignmentRelationshipRule[] =>
  alignmentRelationships.filter((rule) => rule.childKind === kind);

/** Relationships in which `kind` is the parent (its direct children), in display order. */
export const alignmentRelationshipsBelow = (
  kind: AlignmentNodeKind,
): readonly AlignmentRelationshipRule[] =>
  alignmentRelationships.filter((rule) => rule.parentKind === kind);

/** Entity type of the join record that stores a many-to-many relationship. */
export const alignmentLinkEntityType = (
  relationship: AlignmentJoinRelationship,
): AlignmentLinkEntityType =>
  relationship === 'outcome_secondary_project' ? 'project_secondary_outcome' : relationship;

/**
 * Stable id of the one join record for a pair, so relinking revives the same row:
 * `deriveNameBasedUuid(yelaxisDerivedIdNamespace, "<relationship>:<parentId>:<childId>")`, where the
 * parent is the Outcome or Milestone and the child is the Project or Action.
 */
export const alignmentLinkId = (
  relationship: AlignmentJoinRelationship,
  parentId: UUID,
  childId: UUID,
): UUID => deriveNameBasedUuid(yelaxisDerivedIdNamespace, `${relationship}:${parentId}:${childId}`);

/** An Action and a Project are cross-Axis only when both name an Axis and the Axes differ. */
export const isCrossAxis = (
  projectAxisId: string | undefined,
  actionAxisId: string | undefined,
): boolean =>
  projectAxisId !== undefined && actionAxisId !== undefined && projectAxisId !== actionAxisId;

/* ───────────────────────── Link and unlink rules ───────────────────────── */

/**
 * The facts a link decision needs, read by the caller before and re-checked inside the command.
 * `parent` and `child` follow the catalog direction (for example the Outcome and the Project of
 * `outcome_primary_project`).
 */
export interface AlignmentLinkRequest {
  readonly relationship: AlignmentRelationship;
  readonly parent: EntityRef;
  readonly child: EntityRef;
  readonly parentArchived: boolean;
  readonly childArchived: boolean;
  /** Foreign-key kinds: the parent id the child holds now, if any. */
  readonly currentParentId?: string | undefined;
  /** Join kinds: an active (not unlinked) join record already links this pair. */
  readonly activeLinkExists?: boolean | undefined;
  /** Replace the child's current parent in a single-valued kind; the caller previewed it. */
  readonly replaceExisting?: boolean | undefined;
  /** `outcome_secondary_project`: the Project's primary Outcome id. */
  readonly primaryOutcomeId?: string | undefined;
  /** `outcome_primary_project`: the Outcome is already an active supporting Outcome of the Project. */
  readonly outcomeIsSupporting?: boolean | undefined;
  /** `project_action`: the Project's Axis and the Action's explicit Axis. */
  readonly projectAxisId?: string | undefined;
  readonly actionAxisId?: string | undefined;
  readonly confirmCrossAxis?: boolean | undefined;
}

export interface AlignmentLinkDecision {
  /** `existing`: already linked, nothing to write. `create`: write the link (or revive it). */
  readonly status: 'create' | 'existing';
  readonly relationship: AlignmentRelationship;
  /** Single-valued replacement: the previous parent id, recorded in the minimized event. */
  readonly replacesParentId?: string;
  /** `project_action` across different Axes (confirmed when the status is `create`). */
  readonly crossAxis: boolean;
}

const typedRelationship = (
  relationship: AlignmentRelationship,
  parent: EntityRef,
  child: EntityRef,
): TypedRelationship => {
  // The casts only shape the value; validateRelationshipLink checks the real endpoint types.
  switch (relationship) {
    case 'axis_outcome':
      return {
        kind: relationship,
        axis: parent as EntityRef<'axis'>,
        outcome: child as EntityRef<'outcome'>,
      };
    case 'axis_project':
      return {
        kind: relationship,
        axis: parent as EntityRef<'axis'>,
        project: child as EntityRef<'project'>,
      };
    case 'axis_routine':
      return {
        kind: relationship,
        axis: parent as EntityRef<'axis'>,
        routine: child as EntityRef<'routine'>,
      };
    case 'outcome_milestone':
      return {
        kind: relationship,
        outcome: parent as EntityRef<'outcome'>,
        milestone: child as EntityRef<'milestone'>,
      };
    case 'outcome_primary_project':
    case 'outcome_secondary_project':
      return {
        kind: relationship,
        outcome: parent as EntityRef<'outcome'>,
        project: child as EntityRef<'project'>,
      };
    case 'project_action':
      return {
        kind: relationship,
        project: parent as EntityRef<'project'>,
        action: child as EntityRef<'action'>,
      };
    case 'project_note':
      return {
        kind: relationship,
        project: parent as EntityRef<'project'>,
        note: child as EntityRef<'note'>,
      };
    case 'milestone_project':
      return {
        kind: relationship,
        milestone: parent as EntityRef<'milestone'>,
        project: child as EntityRef<'project'>,
      };
    case 'milestone_action':
      return {
        kind: relationship,
        milestone: parent as EntityRef<'milestone'>,
        action: child as EntityRef<'action'>,
      };
  }
};

const requiredOwnerMessage =
  'A milestone always belongs to one Outcome. Move it to another Outcome instead.';

const unsupportedLink = (relationship: unknown): DomainResult<never> =>
  err({
    code: 'unsupported_relationship',
    message: 'These items cannot be linked that way.',
    details: { reason: 'unsupported_relationship', relationship: String(relationship) },
  });

const occupiedMessage = (rule: AlignmentRelationshipRule): string =>
  rule.required
    ? requiredOwnerMessage
    : `This ${kindLabels[rule.childKind]} is already linked to another ${kindLabels[rule.parentKind]}. Confirm the replacement to change it.`;

/** Re-word a shared relationship error for the alignment surfaces; the code never changes. */
const linkError = (
  error: DomainError,
  rule: AlignmentRelationshipRule,
  reason?: string,
): DomainResult<never> => {
  if (error.code === 'unsupported_relationship') return unsupportedLink(rule.relationship);
  const messages: Partial<Record<DomainError['code'], string>> = {
    owner_mismatch: 'These items cannot be linked.',
    archived_endpoint: 'Restore the archived item before linking it.',
    cross_axis_confirmation_required:
      'This Action is in a different Axis than the Project. Confirm to link them.',
    cardinality_violation:
      reason === 'secondary_is_primary'
        ? "This Outcome is already the Project's primary Outcome."
        : occupiedMessage(rule),
    required_relationship: requiredOwnerMessage,
  };
  return err({
    code: error.code,
    message: messages[error.code] ?? error.message,
    details: { ...error.details, reason: reason ?? error.code, relationship: rule.relationship },
  });
};

/**
 * Decide a link against the catalog, built on the shared `validateRelationshipLink`: same owner;
 * catalog endpoint kinds (a swapped pair is unsupported); an active duplicate is `existing`; no new
 * link to an archived endpoint (finished states may still be linked); a supporting Outcome cannot
 * become primary; a supporting Outcome cannot equal the primary; cross-Axis Action/Project links
 * need confirmation; an occupied single-valued link needs `replaceExisting`. No cross-Axis rule is
 * applied to Milestone links.
 */
export const validateAlignmentLink = (
  request: AlignmentLinkRequest,
): DomainResult<AlignmentLinkDecision> => {
  if (!isAlignmentRelationship(request.relationship)) return unsupportedLink(request.relationship);
  const rule = alignmentRelationshipRules[request.relationship];
  const relationship = typedRelationship(rule.relationship, request.parent, request.child);
  const existing =
    rule.storage === 'fk'
      ? request.currentParentId !== undefined && request.currentParentId === request.parent.id
      : request.activeLinkExists === true;
  const archivedEndpoints = [
    ...(request.parentArchived ? [entityRefKey(request.parent)] : []),
    ...(request.childArchived ? [entityRefKey(request.child)] : []),
  ];
  const base = validateRelationshipLink({
    relationship,
    archivedEndpoints,
    ...(existing ? { existingRelationshipKeys: [relationshipKey(relationship)] } : {}),
  });
  if (!base.ok) return linkError(base.error, rule);
  const crossAxis =
    rule.relationship === 'project_action' &&
    isCrossAxis(request.projectAxisId, request.actionAxisId);
  if (base.value.status === 'existing') {
    return ok({ status: 'existing', relationship: rule.relationship, crossAxis });
  }
  if (rule.relationship === 'outcome_primary_project' && request.outcomeIsSupporting === true) {
    return err({
      code: 'cardinality_violation',
      message:
        'This Outcome is already a supporting Outcome of this Project. Remove it as a supporting Outcome first.',
      details: { reason: 'primary_is_secondary', relationship: rule.relationship },
    });
  }
  const secondaryIsPrimary =
    rule.relationship === 'outcome_secondary_project' &&
    request.primaryOutcomeId !== undefined &&
    request.primaryOutcomeId === request.parent.id;
  const currentParentId = rule.storage === 'fk' ? request.currentParentId : undefined;
  const occupied = currentParentId !== undefined && currentParentId !== request.parent.id;
  const checked = validateRelationshipLink({
    relationship,
    archivedEndpoints,
    duplicatesPrimaryRelationship: secondaryIsPrimary,
    axisMismatch: crossAxis,
    crossAxisConfirmed: request.confirmCrossAxis === true,
    cardinalityOccupied: occupied && request.replaceExisting !== true,
  });
  if (!checked.ok) {
    return linkError(
      checked.error,
      rule,
      checked.error.code === 'cardinality_violation'
        ? secondaryIsPrimary
          ? 'secondary_is_primary'
          : 'occupied'
        : undefined,
    );
  }
  return ok({
    status: 'create',
    relationship: rule.relationship,
    crossAxis,
    ...(occupied ? { replacesParentId: currentParentId } : {}),
  });
};

export interface AlignmentUnlinkRequest {
  readonly relationship: AlignmentRelationship;
  readonly parent: EntityRef;
  readonly child: EntityRef;
}

/**
 * Unlinking is always allowed, including when an endpoint is archived, except for the required
 * Outcome owner of a Milestone (reparent it instead). It never changes either endpoint's state.
 */
export const validateAlignmentUnlink = (
  request: AlignmentUnlinkRequest,
): DomainResult<{ readonly unlinkOnly: true }> => {
  if (!isAlignmentRelationship(request.relationship)) return unsupportedLink(request.relationship);
  const rule = alignmentRelationshipRules[request.relationship];
  if (request.parent.type !== rule.parentKind || request.child.type !== rule.childKind) {
    return unsupportedLink(rule.relationship);
  }
  if (request.parent.ownerId !== request.child.ownerId) {
    return linkError(
      { code: 'owner_mismatch', message: 'Relationship endpoints must share an owner.' },
      rule,
    );
  }
  const decision = validateRelationshipUnlink(
    typedRelationship(rule.relationship, request.parent, request.child),
  );
  return decision.ok ? decision : linkError(decision.error, rule);
};

/* ───────────────────────── Permanent delete confirmation ───────────────────────── */

/** Permanent delete is confirmed by typing the exact current title. */
export const validateDeleteConfirmation = (
  title: string,
  confirmation: string,
): DomainResult<true> =>
  confirmation === title
    ? ok(true)
    : err({
        code: 'invalid_value',
        message: 'Type the exact title to confirm.',
        details: { reason: 'delete_confirmation', field: 'confirmation' },
      });
