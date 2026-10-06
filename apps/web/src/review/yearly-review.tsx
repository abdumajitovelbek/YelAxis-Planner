import { message as uiMessage } from '../messages';
/**
 * The yearly review form: the retrospective, Outcome decisions, this
 * year's direction as it was written, and one direction decision for the planning year: continue
 * it, write a new one, or record that it is outdated (which changes no plan record). Decisions stay
 * drafts until Finish review.
 */
import { useId, useState, type ReactNode } from 'react';

import type { ReviewView, YearlyReviewContext, YearlyReviewInput } from '@yelaxis/application';
import {
  reviewLimits,
  type ReviewDirectionChoice,
  type ReviewDirectionDecision,
} from '@yelaxis/domain';

import { outcomeDecisions } from './monthly-review';
import { hasText, storedText } from './review-draft';
import {
  BoundedTextField,
  ChoiceGroup,
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
import { directionChoiceWord } from './review-text';

type YearlyView = Extract<ReviewView, { readonly type: 'yearly' }>;
type DirectionChoice = 'later' | ReviewDirectionChoice;

interface YearlyDraft {
  readonly notes: string;
  readonly outcomes: Readonly<Record<string, ObjectChoice>>;
  readonly direction: DirectionChoice;
  /** The new direction's text (`new` only). */
  readonly directionText: string;
}

function draftFrom(view: YearlyView): YearlyDraft {
  const direction = view.saved?.direction;
  return {
    notes: view.saved?.notes ?? '',
    outcomes: savedObjectChoices(view, 'outcome', outcomeDecisions),
    direction: direction?.choice ?? 'later',
    directionText: direction?.text ?? '',
  };
}

/** Whether two drafts would save the same review. */
const sameDraft = (context: YearlyReviewContext, left: YearlyDraft, right: YearlyDraft): boolean =>
  storedText(left.notes) === storedText(right.notes) &&
  left.direction === right.direction &&
  (left.direction !== 'new' || left.directionText.trim() === right.directionText.trim()) &&
  sameChoices(context.outcomes, left.outcomes, right.outcomes);

function buildInput(
  view: YearlyView,
  context: YearlyReviewContext,
  draft: YearlyDraft,
): BuiltInput {
  const notes = notesProblem(draft.notes, uiMessage('review.yearly-review.2063'));
  if (notes !== null) return { problem: notes };
  let direction: ReviewDirectionDecision | undefined;
  if (draft.direction === 'new') {
    const text = draft.directionText.trim();
    if (text === '') return { problem: uiMessage('review.yearly-review.2064') };
    if (text.length > reviewLimits.directionText)
      return {
        problem: uiMessage('review.yearly-review.2065', {
          value0: reviewLimits.directionText.toLocaleString('en-US'),
        }),
      };
    direction = { choice: 'new', text };
  } else if (draft.direction !== 'later') direction = { choice: draft.direction };
  const input: YearlyReviewInput = {
    type: 'yearly',
    periodKey: view.period.key,
    ...(view.saved === null ? {} : { revision: view.saved.localRevision }),
    ...(hasText(draft.notes) ? { notes: draft.notes } : {}),
    outcomes: objectDecisionInput(context.outcomes, draft.outcomes),
    ...(direction === undefined ? {} : { direction }),
  };
  return { input };
}

export function YearlyReviewForm({
  commands,
  context,
  view,
}: {
  readonly view: YearlyView;
  readonly context: YearlyReviewContext;
  readonly commands: ReviewCommands;
}): ReactNode {
  const directionHeading = useId();
  const choiceName = useId();
  const [draft, setDraft] = useState(() => draftFrom(view));
  const dirty = !sameDraft(context, draft, draftFrom(view));
  const update = (change: Partial<YearlyDraft>): void =>
    setDraft((current) => ({ ...current, ...change }));
  const year = view.period.key;
  const reviewed = context.reviewedDirection;
  // Continue and Outdated need a direction to act on; a saved choice is always shown.
  const choices: readonly (readonly [DirectionChoice, string])[] = [
    ['later', uiMessage('review.review-form.1940')],
    ...(reviewed !== undefined || draft.direction === 'continue'
      ? [['continue', directionChoiceWord('continue')] as const]
      : []),
    ['new', directionChoiceWord('new')],
    ...(reviewed !== undefined || draft.direction === 'outdated'
      ? [['outdated', directionChoiceWord('outdated')] as const]
      : []),
  ];
  return (
    <ReviewFormFrame
      commands={commands}
      build={() => buildInput(view, context, draft)}
      dirty={dirty}
      draft={draft}
      saved={view.saved}
      skipped={view.saved?.state === 'skipped'}
    >
      <p className="review-intro">{uiMessage('review.yearly-review.2066')}</p>
      <NotesSection type="yearly" value={draft.notes} onChange={(notes) => update({ notes })} />
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
      <section className="review-section" aria-labelledby={directionHeading}>
        <h2 id={directionHeading}>{uiMessage('review.saved-review.2012')}</h2>
        {/* Reviewed after it ended (in January), the year is no longer "this year". */}
        <h3>
          {year === view.today.slice(0, 4)
            ? uiMessage('review.yearly-review.2067', { value0: year })
            : uiMessage('review.yearly-review.2068', { value0: year })}
        </h3>
        <p className="review-quote">
          {reviewed ?? uiMessage('review.yearly-review.2069', { value0: year })}
        </p>
        {context.planningDirection !== undefined && (
          <p>
            {uiMessage('review.yearly-review.2070', {
              value0: context.planningYear,
              value1: context.planningDirection,
            })}
          </p>
        )}
        <ChoiceGroup
          legend={uiMessage('review.yearly-review.2071', { value0: context.planningYear })}
          name={choiceName}
          options={choices}
          value={draft.direction}
          onChange={(direction) => update({ direction })}
        />
        {draft.direction === 'new' && (
          <BoundedTextField
            label={uiMessage('review.yearly-review.2072', { value0: context.planningYear })}
            value={draft.directionText}
            onChange={(directionText) => update({ directionText })}
            limit={reviewLimits.directionText}
            rows={3}
          />
        )}
        {draft.direction === 'outdated' && (
          <p className="field-help">{uiMessage('review.yearly-review.2073')}</p>
        )}
      </section>
    </ReviewFormFrame>
  );
}
