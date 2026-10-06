import { message as uiMessage } from '../messages';
/**
 * Today (`/`), and to, . The live planning today
 * or a date chosen in the app: the day's focus, overlaps, timeline with the current time, flexible
 * Actions, Routines, and the way to End day. It renders query results only and re-reads after
 * every command; every change is an existing explicit command with Undo. Nothing is ranked,
 * scheduled, or completed for the person. The header carries the quiet review line (Review) and,
 * for an account, the quiet sync line when something waits or needs an action (account sync).
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useLocation } from 'react-router-dom';

import type { TimedEntry, TodayView } from '@yelaxis/application';
import type { CalendarDate, IanaTimeZone } from '@yelaxis/domain';
import { englishCatalog } from '@yelaxis/i18n';

import { TodaySyncLine } from '../account/sync-status-line';
import { CapacitySummary, ConflictCount } from '../plan/capacity-summary';
import { ConflictsPanel } from '../plan/conflicts';
import { formatDate } from '../plan/format';
import { occurrenceTarget } from '../plan/occurrence-controls';
import {
  useCommandRunner,
  usePlanQuery,
  usePlanningZone,
  useReviewApplicationOptional,
  useTodayApplication,
  type CommandRunner,
} from '../plan/planning-context';
import { endDayPath, focusPath, planPath, reviewPath, todayPath } from '../plan/routes';
import {
  PlanDialogs,
  TimedEntryCard,
  buildConflictIndex,
  type DialogRequest,
  type RequestDialog,
} from '../plan/scheduling-dialogs';
import { useScrollMemory } from '../plan/scroll-memory';
import { DayTimeline, ViewFeedback, shiftDays, useFocusRescue } from '../plan/timeline';
import { reviewNoticeText } from '../review/review-text';
import { FlexibleList } from './flexible-list';
import { AddToFocusButton, ChooseFocusDialog, FocusStrip } from './focus-strip';
import { useLiveNow, type LiveNow } from './live-clock';
import { deviceTimeZone, nowMarker } from './now-marker';
import { TodayRoutines } from './today-routines';
import { useTodayMode, type TodayMode } from './today-route';

import './today.css';

export interface TodayRouteProps {
  /** The preferred name from setup, when one was given. */
  readonly preferredName?: string | undefined;
  /** Setup defaults (planning zone, week start, time format) are confirmed. */
  readonly defaultsConfirmed: boolean;
  /**
   * Reopen setup. Today does not repeat the button: the shell's setup banner already offers
   * Resume setup while setup is unfinished.
   */
  readonly onResumeSetup: () => void;
}

const titleId = 'today-title';

/** The verified onboarding greeting: exact strings the journeys wait for. */
function greeting(name: string | undefined): string {
  return name === undefined
    ? uiMessage('today.today-page.2270')
    : uiMessage('today.today-page.2271', { value0: name });
}

/** A date seen from the live planning today, in words for the eyebrow. */
export function relationWord(date: CalendarDate, liveDate: CalendarDate): string {
  if (date === liveDate) return uiMessage('app.782');
  if (date === shiftDays(liveDate, -1)) return uiMessage('today.today-page.2272');
  if (date === shiftDays(liveDate, 1)) return uiMessage('today.today-page.2273');
  return date < liveDate ? uiMessage('today.today-page.2274') : uiMessage('today.today-page.2275');
}

/** Nothing on the day at all: no focus, timed items, flexible Actions, or Routines. */
export function isIntentionallyEmpty(view: TodayView): boolean {
  return (
    view.focus.length === 0 &&
    view.timeline.entries.length === 0 &&
    view.flexible.open.length === 0 &&
    view.flexible.done.length === 0 &&
    view.routines.day.length === 0 &&
    view.routines.week.length === 0
  );
}

export function TodayRoute({ defaultsConfirmed, preferredName }: TodayRouteProps): ReactNode {
  useScrollMemory();
  const mode = useTodayMode();
  const zone = usePlanningZone();
  const name =
    preferredName !== undefined && preferredName.trim() !== '' ? preferredName : undefined;
  if (!defaultsConfirmed)
    return (
      <section className="content-section" aria-labelledby={titleId}>
        <p className="eyebrow">{uiMessage('app.782')}</p>
        <h1 id={titleId}>{uiMessage('today.today-page.2276')}</h1>
        <p className="page-message">{uiMessage('today.today-page.2277')}</p>
      </section>
    );
  if (zone === undefined)
    return (
      <article className="today-page" aria-labelledby={titleId} aria-busy="true">
        <header className="today-header">
          <p className="eyebrow">{uiMessage('app.782')}</p>
          <h1 id={titleId}>{uiMessage('today.today-page.2278')}</h1>
        </header>
      </article>
    );
  // Without a readable Profile zone the device zone stands in; the Today read then says why.
  const planningZone = zone ?? ((deviceTimeZone() ?? 'UTC') as IanaTimeZone);
  return <TodayScreen zone={planningZone} mode={mode} name={name} />;
}

function TodayScreen({
  mode,
  name,
  zone,
}: {
  readonly mode: TodayMode;
  readonly name: string | undefined;
  readonly zone: IanaTimeZone;
}): ReactNode {
  const live = useLiveNow(zone);
  if (mode.kind === 'invalid') return <InvalidDayLink />;
  return (
    <TodayDay live={live} name={name} selected={mode.kind === 'selected' ? mode.date : null} />
  );
}

function InvalidDayLink(): ReactNode {
  return (
    <article className="today-page" aria-labelledby={titleId}>
      <header className="today-header">
        <p className="eyebrow">{uiMessage('app.782')}</p>
        <h1 id={titleId}>{uiMessage('today.today-page.2279')}</h1>
      </header>
      <p className="page-message">{uiMessage('today.end-day.2160')}</p>
      <p>
        <Link className="primary-button inline-button" to="/">
          {uiMessage('today.today-page.2280')}
        </Link>
      </p>
    </article>
  );
}

function TodayDay({
  live,
  name,
  selected,
}: {
  readonly live: LiveNow;
  readonly name: string | undefined;
  /** A date chosen in the app, or null for the live today. */
  readonly selected: CalendarDate | null;
}): ReactNode {
  const application = useTodayApplication();
  const location = useLocation();
  const isLive = selected === null;
  const date = selected ?? live.date;
  // Live mode keeps one query and re-reads at rollover (below), so the page never flashes empty.
  const { state, reload } = usePlanQuery(() => application.getToday(date), [selected ?? 'live']);
  const runner = useCommandRunner();
  const heading = useRef<HTMLHeadingElement>(null);
  const data = state.status === 'ready' ? state.data : null;
  useFocusRescue(heading, runner, data);
  const [request, setRequest] = useState<DialogRequest | null>(null);
  // An open Choose focus dialog keeps the date it was opened for, even across midnight.
  const [choosing, setChoosing] = useState<CalendarDate | null>(null);
  const rollover = useRollover(live.date, isLive, reload);
  useDayChangeFocus(heading, isLive ? `live:${live.date}` : `date:${date}`, data);
  const openDialog: RequestDialog = (next) => {
    runner.clearError();
    setRequest(next);
  };
  const openChoose = (day: CalendarDate): void => {
    runner.clearError();
    setChoosing(day);
  };

  const header = (view: TodayView | null, content?: ReactNode) => (
    <TodayHeader
      date={view?.date ?? date}
      liveDate={live.date}
      isLive={isLive}
      title={
        view === null && state.status === 'loading'
          ? isLive
            ? uiMessage('today.today-page.2278')
            : uiMessage('today.today-page.2281')
          : isLive
            ? greeting(name)
            : formatDate(view?.date ?? date, 'long')
      }
      heading={heading}
    >
      {content}
    </TodayHeader>
  );
  const announcement = (
    <p className="sr-only" aria-live="polite">
      {rollover}
    </p>
  );

  if (state.status !== 'ready')
    return (
      <article
        className="today-page"
        aria-labelledby={titleId}
        aria-busy={state.status === 'loading'}
      >
        {header(null)}
        {announcement}
        {state.status === 'error' && (
          <div className="validation-summary today-error" role="alert">
            <p>{uiMessage('today.today-page.2282')}</p>
            <div className="control-row">
              <button type="button" onClick={() => void reload()}>
                {uiMessage('account.account-dialogs.47')}
              </button>
              <Link to={planPath('day', date)}>{uiMessage('today.today-page.2283')}</Link>
            </div>
          </div>
        )}
      </article>
    );

  const view = state.data;
  const conflicts = view.timeline.conflicts;
  const capacity = view.timeline.capacity;
  const empty = isIntentionallyEmpty(view);
  const returnTo = `${location.pathname}${location.search}`;
  const endDayOpen = view.date <= live.date;

  return (
    <article className="today-page" aria-labelledby={titleId} aria-busy={state.refreshing}>
      {header(
        view,
        <>
          <ReviewNotice />
          <TodaySyncLine />
          <div className="today-facts">
            <CapacitySummary capacity={capacity} />
            {capacity.overByMinutes !== undefined && (
              <p className="today-overload">
                <Link to={planPath('day', view.date)}>{uiMessage('today.today-page.2284')}</Link>
              </p>
            )}
            {conflicts.length > 0 && <ConflictCount conflicts={conflicts} />}
            <p className="today-header-links">
              <Link to={planPath('day', view.date)}>{uiMessage('today.today-page.2283')}</Link>
            </p>
          </div>
        </>,
      )}
      {announcement}
      <ViewFeedback runner={runner} showError={request === null && choosing === null} />

      {empty ? (
        <EmptyDay view={view} onChoose={() => openChoose(view.date)} />
      ) : (
        <FocusStrip
          view={view}
          runner={runner}
          onRequest={openDialog}
          onChoose={() => openChoose(view.date)}
        />
      )}

      {conflicts.length > 0 && (
        <ConflictsPanel
          conflicts={conflicts}
          onRequest={openDialog}
          profile={view.profile}
          runner={runner}
        />
      )}

      {!empty && (
        <div className="today-board">
          <div className="today-board-grid">
            <TimelineSection
              view={view}
              live={live}
              runner={runner}
              onRequest={openDialog}
              returnTo={returnTo}
            />
            <div className="today-side">
              <FlexibleList
                view={view}
                isLiveToday={view.date === live.date}
                runner={runner}
                onRequest={openDialog}
                returnTo={returnTo}
              />
              <TodayRoutines view={view} runner={runner} />
            </div>
          </div>
        </div>
      )}

      {endDayOpen && (
        <section className="today-section today-end" aria-labelledby="today-end-heading">
          <h2 id="today-end-heading">{uiMessage('today.today-page.2285')}</h2>
          <p className="field-help">{uiMessage('today.today-page.2286')}</p>
          <p>
            <Link className="inline-button" to={endDayPath(view.date)}>
              {uiMessage('today.today-page.2287')}
            </Link>
          </p>
        </section>
      )}

      <PlanDialogs
        request={request}
        onClose={() => setRequest(null)}
        profile={view.profile}
        runner={runner}
        viewDate={view.date}
      />
      <ChooseFocusDialog
        open={choosing !== null}
        date={choosing ?? view.date}
        runner={runner}
        onClose={() => setChoosing(null)}
      />
    </article>
  );
}

/**
 * One quiet line when a weekly, monthly, or yearly review is ready: never a
 * dialog, never announced on load, never blocking, and nothing without the Reviews facade.
 */
function ReviewNotice(): ReactNode {
  const reviews = useReviewApplicationOptional();
  const { state } = usePlanQuery(
    () => (reviews === null ? Promise.resolve(null) : reviews.getNotice()),
    [reviews],
  );
  const text =
    state.status === 'ready' && state.data !== null ? reviewNoticeText(state.data.due) : null;
  if (text === null) return null;
  return (
    <p className="today-review-notice">
      <span>{text}</span> <Link to={reviewPath()}>{uiMessage('search.search-detail.2075')}</Link>
    </p>
  );
}

/**
 * At midnight the live today moves on (announced once, politely) and the page re-reads without a
 * loading flash. A date that moves back (the clock was corrected, or the planning zone changed) is
 * announced without saying a new day started. A selected date never rolls over; it is only
 * re-read, since whether its focus and End day are open depends on today.
 */
function useRollover(liveDate: CalendarDate, isLive: boolean, reload: () => Promise<void>): string {
  const [message, setMessage] = useState('');
  const shown = useRef(liveDate);
  useEffect(() => {
    const previous = shown.current;
    if (previous === liveDate) return;
    shown.current = liveDate;
    if (isLive) {
      const now = uiMessage('today.today-page.2288', { value0: formatDate(liveDate, 'long') });
      setMessage(liveDate > previous ? uiMessage('today.today-page.2289', { value0: now }) : now);
    }
    void reload();
  }, [liveDate, isLive, reload]);
  return message;
}

/**
 * When the shown day changes (another date, back to the live today, or midnight) and the control
 * that had focus went away with the old day (for example Back to today), focus moves to the page
 * heading once the new day has rendered, never to the page body. Focus that survived stays put.
 */
function useDayChangeFocus(
  heading: RefObject<HTMLHeadingElement | null>,
  dayKey: string,
  data: TodayView | null,
): void {
  const shownKey = useRef(dayKey);
  const latest = useRef(data);
  latest.current = data;
  // The data the old day showed, while the new day's read is awaited.
  const armed = useRef<{ readonly data: TodayView | null } | null>(null);
  useEffect(() => {
    if (shownKey.current === dayKey) return;
    shownKey.current = dayKey;
    armed.current = { data: latest.current };
  }, [dayKey]);
  useEffect(() => {
    const target = armed.current;
    if (target === null || data === null || data === target.data) return;
    armed.current = null;
    // The new day is committed: decide now, in the same task (no animation frame, which headless
    // Firefox can delay past the person's next key press).
    const active = document.activeElement;
    if (active === null || active === document.body)
      heading.current?.focus({ preventScroll: true });
  }, [data, heading]);
}

function TodayHeader({
  children,
  date,
  heading,
  isLive,
  liveDate,
  title,
}: {
  readonly date: CalendarDate;
  readonly liveDate: CalendarDate;
  readonly isLive: boolean;
  readonly title: string;
  readonly heading: RefObject<HTMLHeadingElement | null>;
  readonly children?: ReactNode;
}): ReactNode {
  const longDate = formatDate(date, 'long');
  return (
    <header className="today-header">
      <p className="eyebrow">
        {isLive ? uiMessage('app.782') : relationWord(date, liveDate)} · {longDate}
      </p>
      <h1 id={titleId} ref={heading} tabIndex={-1}>
        {title}
      </h1>
      {!isLive && (
        <p className="today-selected-banner">
          <span>
            {uiMessage('today.today-page.2290')}
            {longDate}.
          </span>{' '}
          <Link to="/">{uiMessage('today.today-page.2291')}</Link>
        </p>
      )}
      <nav className="today-day-nav" aria-label={uiMessage('actions-ui.247')}>
        <ul>
          <li>
            <Link to={todayPath(shiftDays(date, -1), liveDate)}>
              {uiMessage('today.today-page.2292')}
            </Link>
          </li>
          <li>
            <Link to="/" aria-current={isLive ? 'page' : undefined}>
              {uiMessage('app.782')}
            </Link>
          </li>
          <li>
            <Link to={todayPath(shiftDays(date, 1), liveDate)}>
              {uiMessage('today.today-page.2293')}
            </Link>
          </li>
        </ul>
      </nav>
      {children}
    </header>
  );
}

/** an intentionally empty day is calm, never a warning. */
function EmptyDay({
  onChoose,
  view,
}: {
  readonly view: TodayView;
  readonly onChoose: () => void;
}): ReactNode {
  return (
    <section className="today-section today-empty" aria-labelledby="today-empty-heading">
      {view.focusEditable ? (
        <>
          <h2 id="today-empty-heading">{englishCatalog['empty.today.title']}</h2>
          <p>{englishCatalog['empty.today.message']}</p>
          <p>
            <button type="button" className="primary-button" onClick={onChoose}>
              {uiMessage('today.focus-strip.2262')}
            </button>
          </p>
        </>
      ) : (
        <h2 id="today-empty-heading">{uiMessage('today.today-page.2294')}</h2>
      )}
    </section>
  );
}

function TimelineSection({
  live,
  onRequest,
  returnTo,
  runner,
  view,
}: {
  readonly view: TodayView;
  readonly live: LiveNow;
  readonly runner: CommandRunner;
  readonly onRequest: RequestDialog;
  readonly returnTo: string;
}): ReactNode {
  const conflictIndex = buildConflictIndex(view.timeline.conflicts);
  const marker = nowMarker(live, view.date, view.profile);
  const extras = (entry: TimedEntry): ReactNode => {
    const block = entry.block;
    if (block?.target.kind === 'action' && block.state === 'planned') {
      const actionId = block.target.actionId;
      return (
        <>
          <AddToFocusButton
            date={view.date}
            target={{ kind: 'action', actionId }}
            title={entry.title}
            focus={view.focus}
            editable={view.focusEditable}
            runner={runner}
          />
          <Link to={focusPath(actionId)} state={{ returnTo }}>
            {uiMessage('today.focus-strip.2260')}
            <span className="sr-only">{entry.title}</span>
          </Link>
        </>
      );
    }
    const occurrence = entry.occurrence;
    if (occurrence?.state === 'planned')
      return (
        <AddToFocusButton
          date={view.date}
          target={{ kind: 'routine_occurrence', occurrence: occurrenceTarget(occurrence) }}
          title={occurrence.ref.routineTitle}
          focus={view.focus}
          editable={view.focusEditable}
          runner={runner}
        />
      );
    return null;
  };
  return (
    <section className="today-section today-timeline" aria-labelledby="today-timeline-heading">
      <h2 id="today-timeline-heading">{uiMessage('plan.plan-day.1290')}</h2>
      <p className="field-help">{uiMessage('today.today-page.2295')}</p>
      <DayTimeline
        date={view.date}
        entries={view.timeline.entries}
        label={uiMessage('plan.plan-day.1292', { value0: formatDate(view.date, 'long') })}
        profile={view.profile}
        {...(marker === undefined ? {} : { now: marker })}
        onDropAction={(actionId, startTime) => {
          const action = view.flexible.open.find((item) => item.id === actionId);
          if (action !== undefined)
            onRequest({ kind: 'schedule', action, date: view.date, startTime });
        }}
        renderEntry={(entry) => (
          <TimedEntryCard
            entry={entry}
            date={view.date}
            conflictIndex={conflictIndex}
            onRequest={onRequest}
            profile={view.profile}
            runner={runner}
            extraOptions={extras}
          />
        )}
      />
    </section>
  );
}
