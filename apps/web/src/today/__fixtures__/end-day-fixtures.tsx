/**
 * Test-only fictional data for End Day (Today and Focus Part 3) and a stand-in for the focus draft editor,
 * so End Day's own behavior can be tested through the editor's fixed props. Never imported by
 * runtime code.
 */
import type { ReactNode } from 'react';

import type {
  ActionSummary,
  BlockRow,
  EndDayItemView,
  FocusCandidate,
  OccurrenceEntry,
} from '@yelaxis/application';
import { focusTargetKey, type Instant } from '@yelaxis/domain';

import { occurrence } from '../../plan/__fixtures__/c1-planning-fake';
import type { FocusDraftEditorProps, FocusDraftItem } from '../focus-strip';
import { todayAction, todayId, todayProfile } from './today-fake';

/* ───────────────────────── Fixture data (fictional) ───────────────────────── */

export function actionBlock(
  action: ActionSummary,
  startsAt: string,
  endsAt: string,
  blockId = todayId(900),
): BlockRow {
  return {
    id: blockId,
    localRevision: 1,
    startsAt: startsAt as Instant,
    endsAt: endsAt as Instant,
    timeZone: todayProfile.planningTimeZone,
    state: 'planned',
    overlapAcknowledged: false,
    target: {
      kind: 'action',
      actionId: action.id,
      title: action.title,
      actionState: action.state,
      actionRevision: action.localRevision,
    },
  };
}

export const report = todayAction(todayId(1), 'Write the report', {
  state: 'scheduled',
  localRevision: 4,
});
export const reportBlock = actionBlock(
  report,
  '2026-09-28T14:00:00.000Z',
  '2026-09-28T15:00:00.000Z',
  todayId(901),
);
export const outline = todayAction(todayId(2), 'Draft the outline', { localRevision: 2 });
export const venue = todayAction(todayId(3), 'Call the venue', { state: 'inbox' });
export const notes = todayAction(todayId(4), 'Review the notes', { state: 'in_progress' });
export const notesBlock = actionBlock(
  notes,
  '2026-09-30T09:00:00.000Z',
  '2026-09-30T10:00:00.000Z',
  todayId(902),
);
export const invoice = todayAction(todayId(5), 'Send the invoice', { state: 'completed' });

export const walk: OccurrenceEntry = occurrence({
  occurrenceId: todayId(801),
  routineId: todayId(811),
  title: 'Evening walk',
  day: '2026-09-28',
  timing: { kind: 'flexible' },
});
export const stretch: OccurrenceEntry = occurrence({
  occurrenceId: todayId(802),
  routineId: todayId(812),
  title: 'Stretch',
  day: '2026-09-28',
  timing: { kind: 'flexible' },
  state: 'completed',
  revision: 3,
});

export const scheduledItem: EndDayItemView = {
  kind: 'action',
  action: report,
  source: 'scheduled',
  block: reportBlock,
};
export const flexibleItem: EndDayItemView = { kind: 'action', action: outline, source: 'flexible' };
export const focusItem: EndDayItemView = { kind: 'action', action: venue, source: 'focus' };
export const elsewhereItem: EndDayItemView = {
  kind: 'action',
  action: notes,
  source: 'flexible',
  block: notesBlock,
};
export const walkItem: EndDayItemView = { kind: 'routine_occurrence', occurrence: walk };
export const invoiceDone: EndDayItemView = { kind: 'action', action: invoice, source: 'flexible' };
export const stretchDone: EndDayItemView = { kind: 'routine_occurrence', occurrence: stretch };

/** A plan-order focus candidate for an Action. */
export function actionCandidate(
  action: ActionSummary,
  source: 'scheduled' | 'flexible' | 'week' = 'flexible',
  selected = false,
): FocusCandidate {
  return {
    kind: 'action',
    key: focusTargetKey({ kind: 'action', actionId: action.id }),
    target: { kind: 'action', actionId: action.id },
    source,
    action,
    selected,
  };
}

/* ───────────────────────── Focus draft editor stand-in ───────────────────────── */

/** The props the stand-in received last, for assertions. */
export const draftEditor: { props: FocusDraftEditorProps | null } = { props: null };

const candidateLabel = (candidate: FocusCandidate): string =>
  candidate.kind === 'action' ? candidate.action.title : candidate.occurrence.ref.routineTitle;

const draftOf = (candidate: FocusCandidate): FocusDraftItem => ({
  key: candidate.key,
  label: candidateLabel(candidate),
  target: candidate.target,
});

/** Shows the draft and offers one button per candidate, calling `onChange` like the editor. */
function StandInFocusDraftEditor(props: FocusDraftEditorProps): ReactNode {
  draftEditor.props = props;
  const candidates = [...props.choices.candidates, ...(props.extraCandidates ?? [])];
  return (
    <div data-testid="focus-draft" data-prefix={props.idPrefix}>
      <ol aria-label="Focus draft">
        {props.value.map((item) => (
          <li key={item.key}>{item.label}</li>
        ))}
      </ol>
      {candidates.map((candidate) => (
        <button
          key={candidate.key}
          type="button"
          onClick={() => props.onChange([...props.value, draftOf(candidate)])}
        >
          {`Choose ${candidateLabel(candidate)}`}
        </button>
      ))}
      <button type="button" onClick={() => props.onChange([])}>
        Clear the focus draft
      </button>
    </div>
  );
}

export const focusStripStandIns = { FocusDraftEditor: StandInFocusDraftEditor };

export function resetDraftEditor(): void {
  draftEditor.props = null;
}
