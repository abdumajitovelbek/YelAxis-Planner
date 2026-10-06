import { message as uiMessage } from '../messages';
/**
 * A saved review, read-only: a finished review in history, or a skipped review
 * with the choices it kept. Every decision names its object, or "Deleted object" once that object
 * was permanently deleted; no deleted title is ever shown. Nothing here is a score or a grade.
 */
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { PlanProfile, ReviewView, SavedReview, SavedReviewItem } from '@yelaxis/application';

import { reviewPath } from '../plan/routes';
import { isClearedList, itemsBySlot } from './review-draft';
import {
  decisionWords,
  directionChoiceWord,
  finishedText,
  movePeriodWords,
  targetTitle,
} from './review-text';

import './review.css';

/** State decisions in words: "Launch the course · Paused", "Deleted object · Completed". */
export function DecisionList({
  applied,
  items,
  label,
  profile,
  today,
}: {
  readonly items: readonly SavedReviewItem[];
  /** The review was finished, so the decisions were applied. */
  readonly applied: boolean;
  readonly label: string;
  readonly profile: PlanProfile;
  readonly today: string;
}): ReactNode {
  return (
    <ul className="review-plain-list" aria-label={label}>
      {items.map((item) => (
        <li key={item.itemId}>
          <span className="review-plain-title">{targetTitle(item.target)}</span>
          <span className="review-facts">
            {` · ${decisionWords(
              item.target.kind,
              item.decision,
              applied,
              item.period === undefined
                ? undefined
                : movePeriodWords(item.period, profile.weekStart, today),
            )}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Focus or commitments in the person's order. */
export function OrderedTargets({
  items,
  label,
}: {
  readonly items: readonly SavedReviewItem[];
  readonly label: string;
}): ReactNode {
  return (
    <ol className="review-ordered-list" aria-label={label}>
      {items.map((item) => (
        <li key={item.itemId}>{targetTitle(item.target)}</li>
      ))}
    </ol>
  );
}

function Section({ children, title }: { readonly title: string; readonly children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {children}
    </section>
  );
}

/**
 * A finished or skipped weekly, monthly, or yearly review. A skipped review can be resumed when the
 * review is still editable (`onResume`); its choices then open in the form.
 */
export function SavedReviewDetails({
  onResume,
  reminder,
  saved,
  view,
}: {
  readonly view: ReviewView;
  readonly saved: SavedReview;
  readonly onResume?: () => void;
  /** The review's Reminder section, shown after its choices. */
  readonly reminder?: ReactNode;
}): ReactNode {
  const applied = saved.state === 'completed';
  const slots = itemsBySlot(saved.items);
  const notesTitle =
    view.type === 'yearly'
      ? uiMessage('review.review-form.1945')
      : uiMessage('alignment.object-forms.679');
  return (
    <>
      {applied ? (
        <p className="review-intro">
          {saved.completedAt === undefined
            ? uiMessage('review.saved-review.2003')
            : uiMessage('review.saved-review.2004', {
                value0: finishedText(saved.completedAt, view.profile),
              })}
        </p>
      ) : (
        <div className="review-skipped">
          <p className="review-intro">{uiMessage('review.saved-review.2005')}</p>
          {onResume !== undefined && (
            <p>
              <button type="button" className="primary-button" onClick={onResume}>
                {uiMessage('review.saved-review.2006')}
              </button>
            </p>
          )}
        </div>
      )}
      <Section title={notesTitle}>
        {saved.notes === undefined ? (
          <p className="quiet-empty">
            {view.type === 'yearly'
              ? uiMessage('review.saved-review.2007')
              : uiMessage('review.saved-review.2008')}
          </p>
        ) : (
          <p className="review-quote">{saved.notes}</p>
        )}
      </Section>
      {view.type === 'monthly' && (
        <Section title={uiMessage('review.saved-review.2009')}>
          <p>
            {saved.themeText === undefined
              ? uiMessage('review.saved-review.2010')
              : uiMessage('review.saved-review.2011', { value0: saved.themeText })}
          </p>
        </Section>
      )}
      {view.type === 'yearly' && (
        <Section title={uiMessage('review.saved-review.2012')}>
          <p>
            {saved.direction === undefined
              ? uiMessage('review.saved-review.2013')
              : saved.direction.choice === 'new'
                ? uiMessage('review.saved-review.2014', { value0: saved.direction.text ?? '' })
                : directionChoiceWord(saved.direction.choice)}
          </p>
        </Section>
      )}
      {slots.note.length > 0 && (
        <Section title={uiMessage('review.saved-review.2015')}>
          <ul className="review-plain-list" aria-label={uiMessage('review.saved-review.2016')}>
            {slots.note.map((item) => (
              <li key={item.itemId}>
                <span className="review-plain-title">{targetTitle(item.target)}</span>
                <span className="review-quote">{item.note ?? ''}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={uiMessage('review.saved-review.2017')}>
        {slots.state.length === 0 ? (
          <p className="quiet-empty">{uiMessage('review.saved-review.2018')}</p>
        ) : (
          <DecisionList
            items={slots.state}
            applied={applied}
            label={uiMessage('review.saved-review.2017')}
            profile={view.profile}
            today={view.today}
          />
        )}
      </Section>
      {slots.commit.length > 0 ? (
        <Section title={uiMessage('plan.plan-month.1321')}>
          <OrderedTargets items={slots.commit} label={uiMessage('plan.plan-month.1321')} />
        </Section>
      ) : (
        isClearedList(saved, 'commitments') && (
          <Section title={uiMessage('plan.plan-month.1321')}>
            <p>
              {applied
                ? uiMessage('review.saved-review.2019')
                : uiMessage('review.saved-review.2020')}
            </p>
          </Section>
        )
      )}
      {slots.focus.length > 0 ? (
        <Section title={uiMessage('review.saved-review.2021')}>
          <OrderedTargets items={slots.focus} label={uiMessage('review.saved-review.2021')} />
        </Section>
      ) : (
        isClearedList(saved, 'first_day_focus') && (
          <Section title={uiMessage('review.saved-review.2021')}>
            <p>
              {applied
                ? uiMessage('review.saved-review.2022')
                : uiMessage('review.saved-review.2023')}
            </p>
          </Section>
        )
      )}
      {reminder}
      <p>
        <Link className="inline-button" to={reviewPath()}>
          {uiMessage('review.saved-review.2024')}
        </Link>
      </p>
    </>
  );
}
