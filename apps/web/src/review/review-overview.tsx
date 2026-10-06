import { message as uiMessage } from '../messages';
/**
 * Review (`/review`): the one current checkpoint of each review type, other reviews in
 * progress, and history with a type filter and paging. Due is derived and calm: an overdue review
 * never blocks anything, and nothing is scored, ranked, or graded. The page renders query results
 * only; every review opens its own page (the daily review is End Day).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type {
  PlanProfile,
  ReviewCheckpoint,
  ReviewHistoryPage,
  ReviewOverview,
  ReviewSummary,
} from '@yelaxis/application';
import type { ReviewType } from '@yelaxis/domain';

import { usePlanQuery, useReviewApplication } from '../plan/planning-context';
import { reviewPeriodPath } from '../plan/routes';
import {
  checkpointLinkLabel,
  decisionCountText,
  dueText,
  energyWord,
  finishedText,
  periodTitle,
  reviewStatusLabel,
  reviewTitle,
} from './review-text';

import './review.css';

export function ReviewOverviewPage(): ReactNode {
  const reviews = useReviewApplication();
  const { state, reload } = usePlanQuery(() => reviews.getOverview(), [reviews]);
  const titleId = useId();
  return (
    <article
      className="review-page"
      aria-labelledby={titleId}
      aria-busy={state.status === 'loading' || (state.status === 'ready' && state.refreshing)}
    >
      <header className="review-header">
        <h1 id={titleId} tabIndex={-1}>
          {uiMessage('app.783')}
        </h1>
        <p className="review-intro">{uiMessage('review.review-overview.1956')}</p>
      </header>
      {state.status === 'loading' && (
        <p className="page-message" role="status">
          {uiMessage('review.review-overview.1957')}
        </p>
      )}
      {state.status === 'error' && (
        <div className="validation-summary" role="alert">
          <p>{uiMessage('review.review-overview.1958')}</p>
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <Checkpoints overview={state.data} />
          <InProgress overview={state.data} />
          <History profile={state.data.profile} today={state.data.today} />
        </>
      )}
    </article>
  );
}

/* ───────────────────────── Current checkpoints ───────────────────────── */

function Checkpoints({ overview }: { readonly overview: ReviewOverview }): ReactNode {
  const headingId = useId();
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('review.review-overview.1959')}</h2>
      <ul className="review-cards">
        {overview.checkpoints.map((checkpoint) => (
          <CheckpointCard
            key={checkpoint.period.type}
            checkpoint={checkpoint}
            today={overview.today}
          />
        ))}
      </ul>
    </section>
  );
}

function CheckpointCard({
  checkpoint,
  today,
}: {
  readonly checkpoint: ReviewCheckpoint;
  readonly today: string;
}): ReactNode {
  const { due, period, status } = checkpoint;
  const settled = status === 'completed' || status === 'skipped';
  return (
    <li className="review-card">
      <h3>{reviewTitle(period.type)}</h3>
      <p className="review-card-period">{periodTitle(period, today)}</p>
      <p className="review-card-facts">
        <span className="review-status" data-status={status}>
          {reviewStatusLabel(status)}
        </span>
        {!settled && <span className="review-due">{dueText(period, due)}</span>}
      </p>
      <Link className="inline-button" to={reviewPeriodPath(period.type, period.key)}>
        {checkpointLinkLabel(checkpoint)} <span className="sr-only">({period.type})</span>
      </Link>
    </li>
  );
}

/* ───────────────────────── Rows ───────────────────────── */

function ReviewRow({
  profile,
  summary,
  today,
}: {
  readonly summary: ReviewSummary;
  readonly profile: PlanProfile;
  readonly today: string;
}): ReactNode {
  const { period } = summary;
  const facts = [
    reviewTitle(period.type),
    reviewStatusLabel(summary.state),
    ...(summary.energy === undefined ? [] : [`Energy: ${energyWord(summary.energy)}`]),
    ...(summary.decisionCount > 0 ? [decisionCountText(summary.decisionCount)] : []),
    ...(summary.completedAt === undefined ? [] : [finishedText(summary.completedAt, profile)]),
  ];
  return (
    <li className="review-row">
      <Link to={reviewPeriodPath(period.type, period.key)}>
        {periodTitle(period, today)}{' '}
        <span className="sr-only">
          ({period.type}
          {uiMessage('review.review-overview.1960')}
        </span>
      </Link>
      <p className="review-row-facts">{facts.join(' · ')}</p>
      {summary.notesExcerpt !== undefined && (
        <p className="review-row-excerpt">{summary.notesExcerpt}</p>
      )}
    </li>
  );
}

/* ───────────────────────── In progress ───────────────────────── */

function InProgress({ overview }: { readonly overview: ReviewOverview }): ReactNode {
  const headingId = useId();
  const { items, total } = overview.inProgress;
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('plan.scheduling-dialogs.1621')}</h2>
      {items.length === 0 ? (
        <p className="quiet-empty">{uiMessage('review.review-overview.1961')}</p>
      ) : (
        <>
          <p className="field-help">{uiMessage('review.review-overview.1962')}</p>
          <ul className="review-list" aria-label={uiMessage('review.review-overview.1963')}>
            {items.map((summary) => (
              <ReviewRow
                key={summary.reviewId}
                summary={summary}
                profile={overview.profile}
                today={overview.today}
              />
            ))}
          </ul>
          {total > items.length && (
            <p className="field-help">
              {uiMessage('review.review-overview.1964', {
                value0: String(items.length),
                value1: String(total),
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/* ───────────────────────── History ───────────────────────── */

type HistoryFilter = 'all' | ReviewType;

const filters: readonly (readonly [HistoryFilter, string])[] = [
  ['all', uiMessage('review.review-overview.1965')],
  ['daily', uiMessage('review.review-overview.1966')],
  ['weekly', uiMessage('review.review-overview.1967')],
  ['monthly', uiMessage('review.review-overview.1968')],
  ['yearly', uiMessage('review.review-overview.1969')],
];

type HistoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      readonly items: readonly ReviewSummary[];
      readonly nextCursor: string | null;
      readonly more: 'idle' | 'loading' | 'error';
    };

const pageState = (
  items: readonly ReviewSummary[],
  page: ReviewHistoryPage,
): Extract<HistoryState, { readonly status: 'ready' }> => ({
  status: 'ready',
  items: [...items, ...page.items],
  nextCursor: page.nextCursor ?? null,
  more: 'idle',
});

function History({
  profile,
  today,
}: {
  readonly profile: PlanProfile;
  readonly today: string;
}): ReactNode {
  const reviews = useReviewApplication();
  const headingId = useId();
  const filterName = useId();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  // Each filter (or retry) is a new generation; a page that answers late for an older one is dropped.
  const generation = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const typeOption = filter === 'all' ? {} : { type: filter };

  useEffect(() => {
    const ticket = ++generation.current;
    setState({ status: 'loading' });
    reviews.listHistory(filter === 'all' ? {} : { type: filter }).then(
      (page) => {
        if (ticket === generation.current) setState(pageState([], page));
      },
      () => {
        if (ticket === generation.current) setState({ status: 'error' });
      },
    );
  }, [reviews, filter, attempt]);

  useEffect(() => {
    // After Show more, keyboard focus moves to the first review that was added.
    if (focusRow === null) return;
    setFocusRow(null);
    list.current?.querySelectorAll<HTMLAnchorElement>('li > a')[focusRow]?.focus();
  }, [focusRow]);

  const showMore = async (): Promise<void> => {
    if (state.status !== 'ready' || state.nextCursor === null || state.more === 'loading') return;
    const ticket = generation.current;
    const shown = state.items;
    setState({ ...state, more: 'loading' });
    try {
      const page = await reviews.listHistory({ ...typeOption, cursor: state.nextCursor });
      if (ticket !== generation.current) return;
      setState(pageState(shown, page));
      if (page.items.length > 0) setFocusRow(shown.length);
    } catch {
      if (ticket === generation.current) setState({ ...state, more: 'error' });
    }
  };

  const typeWord = filter === 'all' ? '' : `${filter} `;
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('alignment.kit.474')}</h2>
      <fieldset className="review-filter">
        <legend>{uiMessage('review.review-overview.1970')}</legend>
        <div className="review-choices">
          {filters.map(([value, label]) => (
            <label key={value} className="review-choice">
              <input
                type="radio"
                name={filterName}
                value={value}
                checked={filter === value}
                onChange={() => setFilter(value)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {state.status === 'loading' && (
        <p role="status">{uiMessage('review.review-overview.1971')}</p>
      )}
      {state.status === 'error' && (
        <div className="validation-summary" role="alert">
          <p>{uiMessage('review.review-overview.1972')}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      )}
      {state.status === 'ready' &&
        (state.items.length === 0 ? (
          <p className="quiet-empty">
            {uiMessage('review.review-overview.1973', { value0: typeWord })}
          </p>
        ) : (
          <ul
            ref={list}
            className="review-list"
            aria-label={uiMessage('review.review-overview.1974')}
          >
            {state.items.map((summary) => (
              <ReviewRow key={summary.reviewId} summary={summary} profile={profile} today={today} />
            ))}
          </ul>
        ))}
      {state.status === 'ready' && state.more === 'error' && (
        <p className="validation-summary" role="alert">
          {uiMessage('review.review-overview.1975')}
        </p>
      )}
      {state.status === 'ready' && state.nextCursor !== null && (
        <div className="review-actions">
          <button
            type="button"
            aria-disabled={state.more === 'loading' ? true : undefined}
            onClick={() => void showMore()}
          >
            {uiMessage('review.review-overview.1976')}
          </button>
          {state.more === 'loading' && (
            <span role="status">{uiMessage('review.review-overview.1977')}</span>
          )}
        </div>
      )}
    </section>
  );
}
