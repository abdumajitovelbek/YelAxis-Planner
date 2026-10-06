import { PagedItems } from '../item-pages';
import { message as uiMessage } from '../messages';
import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { ActionSummary, DayPlan } from '@yelaxis/application';
import type { CalendarDate } from '@yelaxis/domain';

import { CapacitySummary, ConflictCount } from './capacity-summary';
import { ConflictsPanel } from './conflicts';
import { formatDate, formatWallTime, formatWeekRange, formatWindowEnd } from './format';
import { OccurrenceControls } from './occurrence-controls';
import {
  useCommandRunner,
  usePlanning,
  usePlanQuery,
  type CommandRunner,
} from './planning-context';
import { planPath } from './routes';
import {
  ActionRow,
  PlanDialogs,
  TimedEntryCard,
  actionPlaceTarget,
  buildConflictIndex,
  type DialogRequest,
  type RequestDialog,
} from './scheduling-dialogs';
import { DayTimeline, ViewFeedback, useFocusRescue } from './timeline';

import './plan-day.css';

/**
 * Day horizon: a timeline plus the flexible list. Dropping or scheduling onto the
 * timeline always asks for the duration instead of inventing one.
 */
export function DayView({ date }: { readonly date: CalendarDate }): ReactNode {
  const planning = usePlanning();
  const { state, reload } = usePlanQuery(() => planning.getDayPlan(date), [date]);
  const runner = useCommandRunner();
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusRescue(heading, runner, state.status === 'ready' ? state.data : null);
  const openDialog: RequestDialog = (next) => {
    runner.clearError();
    setRequest(next);
  };

  if (state.status !== 'ready')
    return (
      <article className="plan-view" aria-labelledby="plan-view-title">
        <header className="plan-view-header">
          <p className="eyebrow">{uiMessage('actions-ui.247')}</p>
          <h1 id="plan-view-title" ref={heading} tabIndex={-1}>
            {formatDate(date, 'long')}
          </h1>
        </header>
        {state.status === 'loading' ? (
          <p className="page-message" role="status">
            {uiMessage('plan.plan-day.1284')}
          </p>
        ) : (
          <div className="validation-summary" role="alert">
            <p>{state.message}</p>
            <button type="button" onClick={() => void reload()}>
              {uiMessage('account.account-dialogs.47')}
            </button>
          </div>
        )}
      </article>
    );

  const plan = state.data;
  const day = plan.day;
  const profile = plan.profile;
  const conflictIndex = buildConflictIndex(plan.conflicts);
  const findAction = (actionId: string): ActionSummary | undefined =>
    day.flexibleActions.find((item) => item.id === actionId) ??
    plan.backlog.items.find((item) => item.id === actionId);

  return (
    <article
      className="plan-view day-view"
      aria-labelledby="plan-view-title"
      aria-busy={state.refreshing}
    >
      <header className="plan-view-header">
        <p className="eyebrow">
          {uiMessage('actions-ui.247')}
          {day.date === plan.today ? uiMessage('plan.plan-day.2464') : ''}
        </p>
        <h1 id="plan-view-title" ref={heading} tabIndex={-1}>
          {formatDate(day.date, 'long')}
        </h1>
        <CapacitySummary capacity={day.capacity} />
        <p className="field-help">
          {day.availability.length === 0
            ? uiMessage('plan.plan-day.1285')
            : uiMessage('plan.plan-day.1286', {
                value0: day.availability
                  .map(
                    (window) =>
                      `${formatWallTime(window.start, profile.timeFormat)}–${formatWindowEnd(
                        window.end,
                        profile.timeFormat,
                      )}`,
                  )
                  .join(', '),
              })}{' '}
          <Link to={planPath('week', day.date)}>
            {uiMessage('plan.plan-day.1287')}
            {formatWeekRange(plan.week)}
          </Link>
        </p>
        <ConflictCount conflicts={plan.conflicts} />
        <div className="plan-page-actions">
          <button type="button" onClick={() => openDialog({ kind: 'customBlock', date })}>
            {uiMessage('plan.plan-day.1288')}
          </button>
          <button type="button" onClick={() => openDialog({ kind: 'commitment', date })}>
            {uiMessage('plan.plan-day.1289')}
          </button>
        </div>
      </header>
      <ViewFeedback runner={runner} showError={request === null} />

      <ConflictsPanel
        conflicts={plan.conflicts}
        onRequest={openDialog}
        profile={profile}
        runner={runner}
      />

      <div className="day-board">
        <div className="day-board-grid">
          <section
            className="plan-section day-timeline-section"
            aria-labelledby="day-timeline-heading"
          >
            <h2 id="day-timeline-heading">{uiMessage('plan.plan-day.1290')}</h2>
            <p className="field-help">{uiMessage('plan.plan-day.1291')}</p>
            <DayTimeline
              date={day.date}
              entries={day.timed}
              label={uiMessage('plan.plan-day.1292', { value0: formatDate(day.date, 'long') })}
              profile={profile}
              onDropAction={(actionId, startTime) => {
                const action = findAction(actionId);
                if (action !== undefined)
                  openDialog({ kind: 'schedule', action, date: day.date, startTime });
              }}
              renderEntry={(entry) => (
                <TimedEntryCard
                  entry={entry}
                  date={day.date}
                  conflictIndex={conflictIndex}
                  onRequest={openDialog}
                  profile={profile}
                  runner={runner}
                />
              )}
            />
          </section>
          <div className="day-side">
            <FlexibleList plan={plan} onRequest={openDialog} runner={runner} />
            <DayBacklog plan={plan} onRequest={openDialog} runner={runner} />
          </div>
        </div>
      </div>

      <PlanDialogs
        request={request}
        onClose={() => setRequest(null)}
        profile={profile}
        runner={runner}
        viewDate={date}
      />
    </article>
  );
}

function FlexibleList({
  onRequest,
  plan: dayPlan,
  runner,
}: {
  readonly onRequest: RequestDialog;
  readonly plan: DayPlan;
  readonly runner: CommandRunner;
}): ReactNode {
  const planning = usePlanning();
  const profile = dayPlan.profile;
  const column = dayPlan.day;
  const empty =
    column.flexibleActions.length === 0 &&
    column.flexibleOccurrences.length === 0 &&
    dayPlan.weeklyCounts.length === 0;
  return (
    <section className="plan-section side-section" aria-labelledby="day-flexible-heading">
      <h2 id="day-flexible-heading">{uiMessage('plan.plan-day.1293')}</h2>
      <p className="field-help">{uiMessage('plan.plan-day.1294')}</p>
      {empty && <p className="quiet-empty">{uiMessage('plan.plan-day.1295')}</p>}
      {column.flexibleActions.length > 0 && (
        <ul className="action-list" aria-label={uiMessage('plan.plan-day.1296')}>
          <PagedItems items={column.flexibleActions} identity={column.date}>
            {(action) => (
              <ActionRow key={action.id} action={action}>
                <button
                  type="button"
                  disabled={runner.busy}
                  onClick={() => onRequest({ kind: 'schedule', action, date: column.date })}
                >
                  {uiMessage('alignment.project-detail.744')}
                  <span className="sr-only">{action.title}</span>
                </button>
                <button
                  type="button"
                  disabled={runner.busy}
                  onClick={() =>
                    onRequest({
                      kind: 'place',
                      target: actionPlaceTarget(action),
                      date: column.date,
                      choice: 'day',
                    })
                  }
                >
                  {uiMessage('plan.plan-day.1297')}
                  <span className="sr-only">{action.title}</span>
                </button>
                <button
                  type="button"
                  disabled={runner.busy}
                  onClick={() =>
                    void runner.run(
                      () => planning.unplace({ target: actionPlaceTarget(action).input }),
                      uiMessage('plan.plan-day.1298'),
                    )
                  }
                >
                  {uiMessage('plan.plan-day.1299')}
                  <span className="sr-only">{action.title}</span>
                </button>
              </ActionRow>
            )}
          </PagedItems>
        </ul>
      )}
      {column.flexibleOccurrences.length > 0 && (
        <>
          <h3>{uiMessage('alignment.axis-detail.433')}</h3>
          <ul className="routine-list" aria-label={uiMessage('plan.plan-day.1300')}>
            <PagedItems items={column.flexibleOccurrences} identity={column.date}>
              {(entry) => (
                <li key={entry.ref.occurrenceId}>
                  <p className="routine-title">{entry.ref.routineTitle}</p>
                  <OccurrenceControls entry={entry} profile={profile} runner={runner} />
                </li>
              )}
            </PagedItems>
          </ul>
        </>
      )}
      {dayPlan.weeklyCounts.length > 0 && (
        <>
          <h3>{uiMessage('plan.plan-day.1301')}</h3>
          <ul className="routine-list" aria-label={uiMessage('plan.plan-day.1302')}>
            <PagedItems items={dayPlan.weeklyCounts}>
              {(entry) => (
                <li key={entry.ref.occurrenceId}>
                  <p className="routine-title">{entry.ref.routineTitle}</p>
                  <OccurrenceControls entry={entry} profile={profile} runner={runner} />
                </li>
              )}
            </PagedItems>
          </ul>
        </>
      )}
    </section>
  );
}

function DayBacklog({
  onRequest,
  plan: dayPlan,
  runner,
}: {
  readonly onRequest: RequestDialog;
  readonly plan: DayPlan;
  readonly runner: CommandRunner;
}): ReactNode {
  const planning = usePlanning();
  const { items, total } = dayPlan.backlog;
  const column = dayPlan.day;
  return (
    <section
      className="plan-section side-section backlog-panel"
      aria-labelledby="day-backlog-heading"
    >
      <h2 id="day-backlog-heading">{uiMessage('plan.plan-day.1303')}</h2>
      <p className="field-help">
        {total === 0
          ? uiMessage('plan.plan-day.1304')
          : uiMessage('plan.plan-day.1305', {
              value0: String(total),
              value1:
                total === 1
                  ? uiMessage('actions-ui.282')
                  : uiMessage('alignment.project-detail.758'),
              value2: total > items.length ? `, showing ${String(items.length)}` : '',
            })}
      </p>
      {items.length > 0 && (
        <ul className="action-list" aria-label={uiMessage('plan.plan-day.1306')}>
          <PagedItems items={items}>
            {(action) => (
              <ActionRow key={action.id} action={action}>
                <button
                  type="button"
                  disabled={runner.busy}
                  onClick={() =>
                    void runner.run(
                      () =>
                        planning.place({
                          target: actionPlaceTarget(action).input,
                          period: { kind: 'day', date: column.date },
                        }),
                      uiMessage('plan.plan-day.1307', { value0: formatDate(column.date, 'long') }),
                    )
                  }
                >
                  {uiMessage('plan.plan-day.1308')}
                  <span className="sr-only">{action.title}</span>
                </button>
                <button
                  type="button"
                  disabled={runner.busy}
                  onClick={() => onRequest({ kind: 'schedule', action, date: column.date })}
                >
                  {uiMessage('alignment.project-detail.744')}
                  <span className="sr-only">{action.title}</span>
                </button>
              </ActionRow>
            )}
          </PagedItems>
        </ul>
      )}
    </section>
  );
}
