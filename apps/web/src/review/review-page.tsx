import { message as uiMessage } from '../messages';
/**
 * One weekly, monthly, or yearly review (`/review/:type/:key`). A daily key opens End Day,
 * the daily review. The page shows the period in words and its calm status, then one of: a future
 * period (nothing to look back on yet), a week that no longer starts on the first weekday, a
 * finished or skipped review (read-only history), or the editable form. Finish review applies every
 * decision in one command with one Undo; Save for later keeps a draft; Skip this review applies
 * nothing. The page renders query results only and re-reads after every command.
 */
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';

import type { ReviewInput, ReviewResult, ReviewView } from '@yelaxis/application';
import { parseReviewPeriodKey, sameReviewPeriod, weekdayOf } from '@yelaxis/domain';

import {
  useCommandRunner,
  usePlanning,
  usePlanQuery,
  useReviewApplication,
} from '../plan/planning-context';
import { endDayPath, reviewPath, reviewPeriodPath } from '../plan/routes';
import { useFocusRescue } from '../plan/timeline';
import { MonthlyReviewForm } from './monthly-review';
import type { ReviewCommandKind, ReviewCommands } from './review-form';
import { ReviewReminderSection } from './review-reminder';
import {
  dueText,
  periodPhrase,
  periodTitle,
  reviewStatusLabel,
  reviewTitle,
  reviewTypeLabel,
  weekdayWord,
} from './review-text';
import { SavedReviewDetails } from './saved-review';
import { WeeklyReviewForm } from './weekly-review';
import { YearlyReviewForm } from './yearly-review';

import './review.css';

type PeriodType = 'weekly' | 'monthly' | 'yearly';

export function ReviewPeriodPage(): ReactNode {
  const { key = '', type = '' } = useParams();
  if (type === 'daily')
    return parseReviewPeriodKey('daily', key).ok ? (
      <Navigate replace to={endDayPath(key)} />
    ) : (
      <ReviewUnavailable />
    );
  if (type !== 'weekly' && type !== 'monthly' && type !== 'yearly') return <ReviewUnavailable />;
  if (!parseReviewPeriodKey(type, key).ok) return <ReviewUnavailable type={type} />;
  return <ReviewLoader key={`${type}/${key}`} type={type} periodKey={key} />;
}

/** A calm not-found state inside the Review area, for a link that names no review. */
export function ReviewUnavailable({ type }: { readonly type?: PeriodType }): ReactNode {
  const titleId = useId();
  return (
    <article className="review-page" aria-labelledby={titleId}>
      <header className="review-header">
        <Link className="back-link" to={reviewPath()}>
          {uiMessage('review.review-page.1978')}
        </Link>
        <p className="eyebrow">{type === undefined ? uiMessage('app.783') : reviewTitle(type)}</p>
        <h1 id={titleId}>{uiMessage('review.review-page.1979')}</h1>
      </header>
      <p className="page-message">{uiMessage('review.review-page.1980')}</p>
      <p>
        <Link className="primary-button inline-button" to={reviewPath()}>
          {uiMessage('review.review-page.1981')}
        </Link>
      </p>
    </article>
  );
}

function ReviewFrame({
  busy = false,
  children,
  eyebrow,
  facts,
  heading,
  type,
}: {
  readonly type: PeriodType;
  readonly eyebrow: string;
  readonly facts?: string;
  readonly heading: RefObject<HTMLHeadingElement | null>;
  readonly busy?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const titleId = useId();
  return (
    <article className="review-page" aria-labelledby={titleId} aria-busy={busy}>
      <header className="review-header">
        <Link className="back-link" to={reviewPath()}>
          {uiMessage('review.review-page.1978')}
        </Link>
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={titleId} ref={heading} tabIndex={-1}>
          {reviewTitle(type)}
        </h1>
        {facts !== undefined && <p className="review-page-facts">{facts}</p>}
      </header>
      {children}
    </article>
  );
}

type ResultKind = 'finished' | 'saved' | 'skipped' | 'undone';

const resultText: Readonly<Record<ResultKind, string>> = {
  finished: uiMessage('review.review-page.1982'),
  saved: uiMessage('review.review-page.1983'),
  skipped: uiMessage('review.review-page.1984'),
  undone: uiMessage('review.review-page.1985'),
};

function ReviewLoader({
  periodKey,
  type,
}: {
  readonly type: PeriodType;
  readonly periodKey: string;
}): ReactNode {
  const reviews = useReviewApplication();
  const planning = usePlanning();
  const { state, reload } = usePlanQuery(
    () => reviews.getReview(type, periodKey),
    [type, periodKey],
  );
  const runner = useCommandRunner();
  const heading = useRef<HTMLHeadingElement>(null);
  const view = state.status === 'ready' ? state.data : null;
  useFocusRescue(heading, runner, view);
  // Each result gets a new key, so a message that reads like the last one is announced again.
  const [result, setResult] = useState<{ readonly kind: ResultKind; readonly key: number } | null>(
    null,
  );
  const results = useRef(0);
  const [running, setRunning] = useState<ReviewCommandKind | null>(null);
  // A skipped review opens read-only; Resume review opens its choices in the form.
  const [resumed, setResumed] = useState(false);
  // Counts the page's own commands, so the Reminder section ends its result and Undo on each.
  const [pageCommands, setPageCommands] = useState(0);
  const busy = runner.busy || (state.status === 'ready' && state.refreshing);

  const run = async (
    kind: ReviewCommandKind,
    operation: () => ReviewResult,
    done: ResultKind,
  ): Promise<boolean> => {
    if (busy) return false;
    setResult(null);
    setPageCommands((count) => count + 1);
    setRunning(kind);
    // The visible result below is the status announcement, so the runner announces nothing.
    const succeeded = await runner.run(operation, '');
    setRunning(null);
    if (succeeded) {
      results.current += 1;
      setResult({ kind: done, key: results.current });
    }
    return succeeded;
  };
  const undo = async (): Promise<void> => {
    const undoId = runner.undoId;
    if (undoId === null) return;
    await run('undo', () => planning.undo(undoId), 'undone');
  };
  // A reminder command is the last command now: the review command's result and Undo end. (Undo
  // of the command that created the review would archive it and leave its reminder out of reach.)
  const reminderCommand = (): void => {
    setResult(null);
    runner.dismissUndo();
  };

  if (state.status === 'loading')
    return (
      <ReviewFrame type={type} eyebrow={uiMessage('app.783')} heading={heading} busy>
        <p className="page-message" role="status">
          {uiMessage('review.review-page.1986')}
        </p>
      </ReviewFrame>
    );
  if (state.status === 'error')
    return (
      <ReviewFrame type={type} eyebrow={uiMessage('app.783')} heading={heading}>
        <div className="validation-summary" role="alert">
          <p>{uiMessage('review.review-page.1987')}</p>
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      </ReviewFrame>
    );
  if (view === null) return <ReviewUnavailable type={type} />;

  const saved = view.saved;
  const status = saved === null ? 'not_started' : saved.state;
  const settled = status === 'completed' || status === 'skipped';
  // A week that starts on another weekday, with nothing saved, is never offered: no status or due.
  const facts =
    view.reviewable && (view.aligned || saved !== null)
      ? [reviewStatusLabel(status), ...(settled ? [] : [dueText(view.period, view.due)])].join(
          ' · ',
        )
      : undefined;
  const canEdit = view.editable && view.context !== null;
  const revision = saved === null ? {} : { revision: saved.localRevision };
  const commands: ReviewCommands = {
    busy,
    running,
    error: runner.error,
    finish: (input: ReviewInput) => run('finish', () => reviews.finishReview(input), 'finished'),
    save: (input: ReviewInput) => run('save', () => reviews.saveReview(input), 'saved'),
    skip: async () => {
      const skipped = await run(
        'skip',
        () => reviews.skipReview({ type, periodKey: view.period.key, ...revision }),
        'skipped',
      );
      // Skipped again, the review opens read-only again; Resume review brings its choices back.
      if (skipped) setResumed(false);
      return skipped;
    },
  };

  // A saved review's "Remind me to finish" reminder; outside the review form, so
  // Enter in its fields never finishes the review.
  const reminder =
    saved === null ? null : (
      <ReviewReminderSection
        saved={saved}
        profile={view.profile}
        today={view.today}
        pageBusy={busy}
        resetKey={pageCommands}
        onCommand={reminderCommand}
      />
    );
  let body: ReactNode;
  let formShown = false;
  let reminderInBody = false;
  if (!view.reviewable) body = <FutureNotice view={view} />;
  else if (saved?.state === 'completed') {
    body = <SavedReviewDetails view={view} saved={saved} reminder={reminder} />;
    reminderInBody = true;
  } else if (saved === null && !view.aligned) body = <NotAlignedNotice view={view} />;
  else if (saved?.state === 'skipped' && !(resumed && canEdit)) {
    body = (
      <SavedReviewDetails
        view={view}
        saved={saved}
        reminder={reminder}
        {...(canEdit
          ? {
              onResume: () => {
                setResumed(true);
                heading.current?.focus();
              },
            }
          : {})}
      />
    );
    reminderInBody = true;
  } else if (canEdit) {
    body = <ReviewForm view={view} commands={commands} />;
    formShown = true;
  } else body = <p className="page-message">{uiMessage('review.review-page.1988')}</p>;

  const otherPeriod =
    view.reviewable &&
    status !== 'completed' &&
    (view.aligned || saved !== null) &&
    !sameReviewPeriod(view.period, view.currentCheckpoint);

  return (
    <ReviewFrame
      type={type}
      eyebrow={periodTitle(view.period, view.today)}
      {...(facts === undefined ? {} : { facts })}
      heading={heading}
      busy={busy}
    >
      {otherPeriod && <CurrentCheckpointNote view={view} />}
      {body}
      {!reminderInBody && reminder}
      <div className="review-result">
        <div role="status">
          {result !== null && (
            <p key={result.key} className="review-summary">
              {resultText[result.kind]}
            </p>
          )}
        </div>
        {result !== null &&
          (result.kind === 'finished' || result.kind === 'skipped') &&
          runner.undoId !== null && (
            <div className="review-actions">
              <button
                type="button"
                aria-disabled={busy ? true : undefined}
                onClick={() => {
                  if (!busy) void undo();
                }}
              >
                {uiMessage('actions-ui.236')}
              </button>
            </div>
          )}
        {/* The form shows its own refusals next to its buttons. */}
        {result === null && runner.error !== null && !formShown && (
          <p className="validation-summary" role="alert">
            {runner.error}
          </p>
        )}
      </div>
    </ReviewFrame>
  );
}

function ReviewForm({
  commands,
  view,
}: {
  readonly view: ReviewView;
  readonly commands: ReviewCommands;
}): ReactNode {
  switch (view.type) {
    case 'weekly':
      return view.context === null ? null : (
        <WeeklyReviewForm view={view} context={view.context} commands={commands} />
      );
    case 'monthly':
      return view.context === null ? null : (
        <MonthlyReviewForm view={view} context={view.context} commands={commands} />
      );
    case 'yearly':
      return view.context === null ? null : (
        <YearlyReviewForm view={view} context={view.context} commands={commands} />
      );
    case 'daily':
      return null;
  }
}

/** "This review is for … The current weekly review is for …", with a link to it. */
function CurrentCheckpointNote({ view }: { readonly view: ReviewView }): ReactNode {
  const type = view.type;
  const current = view.currentCheckpoint;
  return (
    <div className="review-note-box">
      <p>
        {uiMessage('review.review-page.1989', {
          value0: periodPhrase(view.period, view.today),
          value1: type,
          value2: periodPhrase(current, view.today),
        })}
      </p>
      <p>
        <Link to={reviewPeriodPath(type, current.key)}>
          {uiMessage('review.review-page.1990', { value0: type })}
        </Link>
      </p>
    </div>
  );
}

function FutureNotice({ view }: { readonly view: ReviewView }): ReactNode {
  return (
    <>
      <p className="page-message">{uiMessage('review.review-page.1991')}</p>
      <p>
        <Link
          className="primary-button inline-button"
          to={reviewPeriodPath(view.type, view.currentCheckpoint.key)}
        >
          {uiMessage('review.review-page.1990', { value0: view.type })}
        </Link>
      </p>
    </>
  );
}

/** A week that starts on another weekday than the Profile's first weekday, with nothing saved. */
function NotAlignedNotice({ view }: { readonly view: ReviewView }): ReactNode {
  const starts = weekdayWord(weekdayOf(view.period.start));
  const first = weekdayWord(view.profile.weekStart);
  return (
    <>
      <p className="page-message">
        {uiMessage('review.review-page.1992', {
          value0: starts,
          value1: first,
          value2: reviewTypeLabel(view.type).toLowerCase(),
          value3: first,
        })}
      </p>
      <p>
        <Link
          className="primary-button inline-button"
          to={reviewPeriodPath(view.type, view.currentCheckpoint.key)}
        >
          {uiMessage('review.review-page.1990', { value0: view.type })}
        </Link>
      </p>
    </>
  );
}
