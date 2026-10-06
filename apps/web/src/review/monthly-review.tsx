import { message as uiMessage } from '../messages';
/**
 * The monthly review form: Outcome, Milestone, and Project decisions
 * (continue, pause, stop, achieve, archive), and the planning month's theme. Blank theme text leaves
 * the theme as it is. Decisions stay drafts until Finish review.
 */
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { MonthlyReviewContext, MonthlyReviewInput, ReviewView } from '@yelaxis/application';
import { reviewLimits, type ReviewDecisionKind } from '@yelaxis/domain';

import { formatMonth } from '../plan/format';
import { planPath } from '../plan/routes';
import { hasText, storedText } from './review-draft';
import {
  BoundedTextField,
  NotesSection,
  notesProblem,
  objectDecisionInput,
  ObjectDecisionSection,
  ReviewFormFrame,
  sameChoices,
  savedObjectChoices,
  type BuiltInput,
  type ObjectChoice,
  type ReviewCommands,
} from './review-form';

type MonthlyView = Extract<ReviewView, { readonly type: 'monthly' }>;

export const outcomeDecisions: readonly ReviewDecisionKind[] = [
  'continue',
  'pause',
  'complete',
  'cancel',
  'archive',
];
const milestoneDecisions: readonly ReviewDecisionKind[] = [
  'continue',
  'complete',
  'cancel',
  'archive',
];
const projectDecisions: readonly ReviewDecisionKind[] = [
  'continue',
  'pause',
  'complete',
  'archive',
];

interface MonthlyDraft {
  readonly notes: string;
  readonly outcomes: Readonly<Record<string, ObjectChoice>>;
  readonly milestones: Readonly<Record<string, ObjectChoice>>;
  readonly projects: Readonly<Record<string, ObjectChoice>>;
  /** A new theme; blank leaves the current theme unchanged. */
  readonly theme: string;
}

function draftFrom(view: MonthlyView): MonthlyDraft {
  return {
    notes: view.saved?.notes ?? '',
    outcomes: savedObjectChoices(view, 'outcome', outcomeDecisions),
    milestones: savedObjectChoices(view, 'milestone', milestoneDecisions),
    projects: savedObjectChoices(view, 'project', projectDecisions),
    theme: view.saved?.themeText ?? '',
  };
}

/** Whether two drafts would save the same review. */
const sameDraft = (
  context: MonthlyReviewContext,
  left: MonthlyDraft,
  right: MonthlyDraft,
): boolean =>
  storedText(left.notes) === storedText(right.notes) &&
  left.theme.trim() === right.theme.trim() &&
  sameChoices(context.outcomes, left.outcomes, right.outcomes) &&
  sameChoices(context.milestones, left.milestones, right.milestones) &&
  sameChoices(context.projects, left.projects, right.projects);

function buildInput(
  view: MonthlyView,
  context: MonthlyReviewContext,
  draft: MonthlyDraft,
): BuiltInput {
  const notes = notesProblem(draft.notes, uiMessage('review.monthly-review.1924'));
  if (notes !== null) return { problem: notes };
  const theme = draft.theme.trim();
  if (theme.length > reviewLimits.themeText)
    return {
      problem: uiMessage('review.monthly-review.1925', {
        value0: reviewLimits.themeText.toLocaleString('en-US'),
      }),
    };
  const input: MonthlyReviewInput = {
    type: 'monthly',
    periodKey: view.period.key,
    ...(view.saved === null ? {} : { revision: view.saved.localRevision }),
    ...(hasText(draft.notes) ? { notes: draft.notes } : {}),
    outcomes: objectDecisionInput(context.outcomes, draft.outcomes),
    milestones: objectDecisionInput(context.milestones, draft.milestones),
    projects: objectDecisionInput(context.projects, draft.projects),
    ...(theme === '' ? {} : { theme }),
  };
  return { input };
}

export function MonthlyReviewForm({
  commands,
  context,
  view,
}: {
  readonly view: MonthlyView;
  readonly context: MonthlyReviewContext;
  readonly commands: ReviewCommands;
}): ReactNode {
  const themeHeading = useId();
  const [draft, setDraft] = useState(() => draftFrom(view));
  const dirty = !sameDraft(context, draft, draftFrom(view));
  const update = (change: Partial<MonthlyDraft>): void =>
    setDraft((current) => ({ ...current, ...change }));
  const month = formatMonth(context.planningMonth);
  const current = context.theme;
  return (
    <ReviewFormFrame
      commands={commands}
      build={() => buildInput(view, context, draft)}
      dirty={dirty}
      draft={draft}
      saved={view.saved}
      skipped={view.saved?.state === 'skipped'}
    >
      <p className="review-intro">{uiMessage('review.monthly-review.1926')}</p>
      <ObjectDecisionSection
        title={uiMessage('alignment.axis-detail.425')}
        help={uiMessage('review.monthly-review.1927')}
        empty={uiMessage('review.monthly-review.1928')}
        kind="outcome"
        rows={context.outcomes}
        offered={outcomeDecisions}
        choices={draft.outcomes}
        onChoice={(id, choice) => update({ outcomes: { ...draft.outcomes, [id]: choice } })}
      />
      <ObjectDecisionSection
        title={uiMessage('actions-ui.314')}
        help={uiMessage('review.monthly-review.1929')}
        empty={uiMessage('review.monthly-review.1930')}
        kind="milestone"
        rows={context.milestones}
        offered={milestoneDecisions}
        choices={draft.milestones}
        onChoice={(id, choice) => update({ milestones: { ...draft.milestones, [id]: choice } })}
      />
      <ObjectDecisionSection
        title={uiMessage('alignment.axis-detail.429')}
        help={uiMessage('review.monthly-review.1931')}
        empty={uiMessage('review.monthly-review.1932')}
        kind="project"
        rows={context.projects}
        offered={projectDecisions}
        choices={draft.projects}
        onChoice={(id, choice) => update({ projects: { ...draft.projects, [id]: choice } })}
      />
      <section className="review-section" aria-labelledby={themeHeading}>
        <h2 id={themeHeading}>{uiMessage('review.monthly-review.1933', { value0: month })}</h2>
        <p>
          {current === undefined
            ? uiMessage('review.monthly-review.1934', { value0: month })
            : uiMessage('review.monthly-review.1935', { value0: current })}
        </p>
        <BoundedTextField
          label={uiMessage('review.monthly-review.1936')}
          help={
            current === undefined
              ? uiMessage('review.monthly-review.1937')
              : uiMessage('review.monthly-review.1938')
          }
          value={draft.theme}
          onChange={(theme) => update({ theme })}
          limit={reviewLimits.themeText}
          rows={2}
        />
        <p>
          <Link to={planPath('month', `${context.planningMonth}-01`)}>
            {uiMessage('review.monthly-review.1939', { value0: month })}
          </Link>
        </p>
      </section>
      <NotesSection type="monthly" value={draft.notes} onChange={(notes) => update({ notes })} />
    </ReviewFormFrame>
  );
}
