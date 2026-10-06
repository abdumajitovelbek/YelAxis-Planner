import { message as uiMessage, uiLocale } from '../messages';
/**
 * Neutral words for the Axis, Outcome, Project, and Milestone pages, the relationship list, and the
 * alignment map. Text carries every meaning (color never does), and nothing here ranks, grades, or
 * scores a plan.
 */
import type { AxisSummary, NextActionView, OutcomeProgressView } from '@yelaxis/application';
import {
  axisColorTokens,
  type ActionState,
  type AlignmentNodeKind,
  type AlignmentRelationship,
  type AxisState,
  type CalendarDate,
  type MilestoneState,
  type NoteState,
  type OutcomeState,
  type ProjectState,
  type RoutineState,
} from '@yelaxis/domain';

import { targetWindowText } from '../plan/theme-editor';

/* ───────────────────────── Kinds ───────────────────────── */

const kindLabels: Readonly<Record<AlignmentNodeKind, string>> = {
  axis: uiMessage('actions-ui.251'),
  outcome: uiMessage('alignment.milestone-detail.607'),
  project: uiMessage('actions-ui.254'),
  milestone: uiMessage('actions-ui.276'),
  action: uiMessage('actions-ui.282'),
  routine: uiMessage('plan.routine-form.1531'),
  note: uiMessage('plan.routines.1606'),
};

const kindPlurals: Readonly<Record<AlignmentNodeKind, string>> = {
  axis: uiMessage('alignment.alignment-page.384'),
  outcome: uiMessage('alignment.axis-detail.425'),
  project: uiMessage('alignment.axis-detail.429'),
  milestone: uiMessage('actions-ui.314'),
  action: uiMessage('alignment.project-detail.758'),
  routine: uiMessage('alignment.axis-detail.433'),
  note: uiMessage('alignment.object-forms.679'),
};

/** "Axis", "Outcome", "Project", "Milestone", "Action", "Routine", or "Note". */
export const kindLabel = (kind: AlignmentNodeKind): string => kindLabels[kind];

/** "Axes", "Outcomes", … */
export const kindPluralLabel = (kind: AlignmentNodeKind): string => kindPlurals[kind];

/** "1 Outcome", "3 Outcomes", "0 Routines". */
export const countLabel = (kind: AlignmentNodeKind, count: number): string =>
  `${new Intl.NumberFormat(uiLocale).format(count)} ${new Intl.PluralRules(uiLocale).select(count) === 'one' ? kindLabels[kind] : kindPlurals[kind]}`;

/** Neutral current-member counts of an Axis: "3 Outcomes · 2 Projects · 1 Routine". */
export const memberCountsText = (counts: AxisSummary['counts']): string =>
  [
    countLabel('outcome', counts.outcomes),
    countLabel('project', counts.projects),
    countLabel('routine', counts.routines),
  ].join(' · ');

/* ───────────────────────── States ───────────────────────── */

const stateLabels: {
  readonly [K in AlignmentNodeKind]: Readonly<Record<string, string>>;
} = {
  axis: {
    active: uiMessage('alignment.object-forms.677'),
    archived: uiMessage('alignment.alignment-page.405'),
  } satisfies Record<AxisState, string>,
  outcome: {
    active: uiMessage('alignment.object-forms.677'),
    paused: uiMessage('plan.routines.1533'),
    achieved: uiMessage('plan.theme-editor.1861'),
    abandoned: uiMessage('plan.theme-editor.1862'),
    archived: uiMessage('alignment.alignment-page.405'),
  } satisfies Record<OutcomeState, string>,
  project: {
    idea: uiMessage('alignment.object-forms.676'),
    active: uiMessage('alignment.object-forms.677'),
    blocked: uiMessage('plan.theme-editor.1864'),
    paused: uiMessage('plan.routines.1533'),
    completed: uiMessage('plan.plan-month.1324'),
    archived: uiMessage('alignment.alignment-page.405'),
  } satisfies Record<ProjectState, string>,
  milestone: {
    active: uiMessage('alignment.object-forms.677'),
    completed: uiMessage('plan.plan-month.1324'),
    canceled: uiMessage('plan.theme-editor.1863'),
    archived: uiMessage('alignment.alignment-page.405'),
  } satisfies Record<MilestoneState, string>,
  action: {
    inbox: uiMessage('actions-ui.230'),
    planned: uiMessage('plan.routines.1537'),
    scheduled: uiMessage('plan.theme-editor.1865'),
    in_progress: uiMessage('plan.scheduling-dialogs.1621'),
    completed: uiMessage('plan.plan-month.1324'),
    canceled: uiMessage('plan.theme-editor.1863'),
    archived: uiMessage('alignment.alignment-page.405'),
  } satisfies Record<ActionState, string>,
  routine: {
    active: uiMessage('alignment.object-forms.677'),
    paused: uiMessage('plan.routines.1533'),
    archived: uiMessage('alignment.alignment-page.405'),
  } satisfies Record<RoutineState, string>,
  note: {
    active: uiMessage('alignment.object-forms.677'),
    archived: uiMessage('alignment.alignment-page.405'),
  } satisfies Record<NoteState, string>,
};

/** State in words ("In progress"); an unknown state is shown as its readable name. */
export function stateLabel(kind: AlignmentNodeKind, state: string): string {
  const known = stateLabels[kind][state];
  if (known !== undefined) return known;
  const words = state.replace(/_/gu, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ───────────────────────── Relationships ───────────────────────── */

/**
 * How the other end of a relationship relates to the object in view. `up` rows name a parent of
 * the focus ("Axis · Contains this Outcome"); `down` rows name a child ("Project · Supports this
 * Milestone").
 */
const relationshipWords: Readonly<
  Record<AlignmentRelationship, { readonly up: string; readonly down: string }>
> = {
  axis_outcome: { up: uiMessage('release.labels.1'), down: uiMessage('release.labels.2') },
  axis_project: { up: uiMessage('release.labels.3'), down: uiMessage('release.labels.4') },
  axis_routine: { up: uiMessage('release.labels.5'), down: uiMessage('release.labels.6') },
  outcome_milestone: { up: uiMessage('release.labels.7'), down: uiMessage('release.labels.8') },
  outcome_primary_project: {
    up: uiMessage('release.labels.9'),
    down: uiMessage('release.labels.10'),
  },
  outcome_secondary_project: {
    up: uiMessage('release.labels.11'),
    down: uiMessage('release.labels.12'),
  },
  project_action: { up: uiMessage('release.labels.13'), down: uiMessage('release.labels.14') },
  project_note: { up: uiMessage('release.labels.15'), down: uiMessage('release.labels.16') },
  milestone_project: { up: uiMessage('release.labels.17'), down: uiMessage('release.labels.18') },
  milestone_action: { up: uiMessage('release.labels.19'), down: uiMessage('release.labels.18') },
};

export function relationshipLabel(
  relationship: AlignmentRelationship,
  direction: 'up' | 'down',
): string {
  return relationshipWords[relationship][direction];
}

/** Section headings for a group of related objects, seen from the object in view. */
const relationshipGroups: Readonly<
  Record<AlignmentRelationship, { readonly up: string; readonly down: string }>
> = {
  axis_outcome: { up: uiMessage('actions-ui.251'), down: uiMessage('alignment.axis-detail.425') },
  axis_project: { up: uiMessage('actions-ui.251'), down: uiMessage('alignment.axis-detail.429') },
  axis_routine: { up: uiMessage('actions-ui.251'), down: uiMessage('alignment.axis-detail.433') },
  outcome_milestone: {
    up: uiMessage('alignment.milestone-detail.607'),
    down: uiMessage('actions-ui.314'),
  },
  outcome_primary_project: {
    up: uiMessage('alignment.object-forms.681'),
    down: uiMessage('release.labels.20'),
  },
  outcome_secondary_project: {
    up: uiMessage('alignment.outcome-detail.729'),
    down: uiMessage('release.labels.21'),
  },
  project_action: {
    up: uiMessage('actions-ui.254'),
    down: uiMessage('alignment.project-detail.758'),
  },
  project_note: {
    up: uiMessage('actions-ui.254'),
    down: uiMessage('alignment.project-detail.764'),
  },
  milestone_project: { up: uiMessage('release.labels.22'), down: uiMessage('release.labels.23') },
  milestone_action: { up: uiMessage('release.labels.22'), down: uiMessage('release.labels.24') },
};

export function relationshipGroupLabel(
  relationship: AlignmentRelationship,
  direction: 'up' | 'down',
): string {
  return relationshipGroups[relationship][direction];
}

/* ───────────────────────── Progress, targets, next action ───────────────────────── */

/**
 * Outcome progress as plain text: "No progress measure", "40% (set manually)", "No milestones yet",
 * or "2 of 3 milestones completed · 1 canceled". Milestone progress is a count, never a percentage.
 */
export function progressText(progress: OutcomeProgressView, canceledMilestones?: number): string {
  switch (progress.mode) {
    case 'none':
      return uiMessage('alignment.alignment-page.391');
    case 'manual':
      return uiMessage('alignment.alignment-page.392', { value0: String(progress.percentage) });
    case 'milestone_derived': {
      const canceled = progress.canceled ?? canceledMilestones ?? 0;
      const canceledText =
        canceled === 0
          ? ''
          : uiMessage('alignment.alignment-page.393', { value0: String(canceled) });
      if (progress.total === 0)
        return uiMessage('alignment.alignment-page.394', { value0: canceledText });
      return uiMessage('alignment.alignment-page.395', {
        value0: String(progress.completed),
        value1: String(progress.total),
        value2: progress.total === 1 ? '' : 's',
        value3: canceledText,
      });
    }
  }
}

/** "Target Aug 1, 2026 – Aug 28, 2026", "Target by …", "Target from …", or "No target window". */
export const targetText = (start?: CalendarDate, end?: CalendarDate): string =>
  targetWindowText(start, end);

/** Next-action words for an active Project; null when the Project is not active. */
export function nextActionText(next: NextActionView): string | null {
  switch (next.status) {
    case 'not_applicable':
      return null;
    case 'missing':
      return uiMessage('alignment.kit.472');
    case 'present':
      return uiMessage('release.labels.25', { value0: next.action.title });
  }
}

/* ───────────────────────── Axis color ───────────────────────── */

/** The name of an Axis color token ("Cyan"), or "No color". Color is decorative only. */
export function axisColorLabel(token: string | undefined): string {
  return (
    axisColorTokens.find((entry) => entry.token === token)?.label ??
    uiMessage('alignment.object-forms.653')
  );
}

/* ───────────────────────── History ───────────────────────── */

const historyWords: Readonly<Record<string, string>> = {
  created: uiMessage('search.search-detail.2083'),
  edited: uiMessage('release.labels.26'),
  reordered: uiMessage('release.labels.27'),
  archived: uiMessage('alignment.alignment-page.405'),
  restored: uiMessage('release.labels.28'),
  transitioned: uiMessage('release.labels.29'),
  progress_set: uiMessage('release.labels.30'),
  reparented: uiMessage('release.labels.31'),
  linked: uiMessage('release.labels.32'),
  unlinked: uiMessage('release.labels.33'),
  undo_applied: uiMessage('release.labels.34'),
  placed: uiMessage('release.labels.35'),
  unplaced: uiMessage('release.labels.36'),
  placement_reordered: uiMessage('release.labels.37'),
  carried_forward: uiMessage('release.labels.38'),
  week_commitment_added: uiMessage('release.labels.39'),
  week_commitment_removed: uiMessage('release.labels.40'),
};

/** One audit event in words. Only the event type is known; payloads are never read. */
export function historyEventLabel(eventType: string): string {
  if (eventType.startsWith('onboarding.')) return uiMessage('release.labels.41');
  const action = eventType.slice(eventType.lastIndexOf('.') + 1);
  return historyWords[action] ?? uiMessage('release.labels.42');
}
