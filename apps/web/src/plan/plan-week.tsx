import { PagedItems } from '../item-pages';
import { message as uiMessage } from '../messages';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type {
  ActionSummary,
  DayColumn,
  PlanProfile,
  PlacementRow,
  WeekPlan,
  WeekSelectionRow,
} from '@yelaxis/application';
import type { CalendarDate } from '@yelaxis/domain';

import { CapacitySummary, ConflictCount, shortDayCapacity } from './capacity-summary';
import { ConflictsPanel } from './conflicts';
import {
  formatDate,
  formatPeriod,
  formatWallTime,
  formatWeekRange,
  formatWindowEnd,
} from './format';
import { OccurrenceControls } from './occurrence-controls';
import {
  useCommandRunner,
  usePlanning,
  usePlanQuery,
  type CommandRunner,
} from './planning-context';
import { milestonePath, planPath, templatesPath } from './routes';
import {
  ActionRow,
  PlanDialogs,
  TimedEntryCard,
  actionPlaceTarget,
  buildConflictIndex,
  type ConflictIndex,
  type DialogRequest,
  type RequestDialog,
} from './scheduling-dialogs';
import { ViewFeedback, acceptsActionDrop, draggedActionId, useFocusRescue } from './timeline';

import './plan-week.css';

/**
 * Week horizon. The week begins with reality: fixed commitments and available time, then overlaps,
 * the seven days, carry-forward, this week's commitments, and the Backlog.
 */
export function WeekView({ date }: { readonly date: CalendarDate }): ReactNode {
  const planning = usePlanning();
  const { state, reload } = usePlanQuery(() => planning.getWeekPlan(date), [date]);
  const runner = useCommandRunner();
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [savedTemplate, setSavedTemplate] = useState(false);
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
          <p className="eyebrow">{uiMessage('actions-ui.248')}</p>
          <h1 id="plan-view-title" ref={heading} tabIndex={-1}>
            {uiMessage('plan.plan-week.1346')}
          </h1>
        </header>
        {state.status === 'loading' ? (
          <p className="page-message" role="status">
            {uiMessage('plan.plan-week.1347')}
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
  const conflictIndex = buildConflictIndex(plan.conflicts);
  const actionsById = indexActions(plan);
  const shared = { conflictIndex, onRequest: openDialog, profile: plan.profile, runner };

  return (
    <article
      className="plan-view week-view"
      aria-labelledby="plan-view-title"
      aria-busy={state.refreshing}
    >
      <header className="plan-view-header">
        <p className="eyebrow">{uiMessage('actions-ui.248')}</p>
        <h1 id="plan-view-title" ref={heading} tabIndex={-1}>
          {formatWeekRange(plan.week)}
        </h1>
        <CapacitySummary capacity={plan.capacity} />
        <ConflictCount conflicts={plan.conflicts} />
        <div className="plan-page-actions">
          <button type="button" onClick={() => openDialog({ kind: 'customBlock', date })}>
            {uiMessage('plan.plan-day.1288')}
          </button>
          <button type="button" onClick={() => openDialog({ kind: 'commitment', date })}>
            {uiMessage('plan.plan-day.1289')}
          </button>
          <button
            type="button"
            onClick={() => {
              setSavedTemplate(false);
              openDialog({ kind: 'saveWeekTemplate', weekDate: plan.week.start });
            }}
          >
            {uiMessage('plan.plan-week.1348')}
          </button>
        </div>
        {savedTemplate && (
          <p className="scope-note" role="status">
            {uiMessage('plan.plan-week.1349')}
            <Link to={templatesPath}>{uiMessage('plan.plan-week.1350')}</Link>
          </p>
        )}
      </header>
      <ViewFeedback runner={runner} showError={request === null} />

      <FixedCommitments plan={plan} {...shared} />
      <ConflictsPanel
        conflicts={plan.conflicts}
        onRequest={openDialog}
        profile={plan.profile}
        runner={runner}
      />

      <div className="week-board">
        <div className="week-board-grid">
          <section className="week-schedule" aria-labelledby="week-schedule-heading">
            <h2 id="week-schedule-heading">{uiMessage('onboarding-ui.1129')}</h2>
            <ol className="week-days">
              {plan.days.map((day) => (
                <li key={day.date}>
                  <DayCard
                    day={day}
                    today={plan.today}
                    onDropAction={(actionId) => {
                      const action = actionsById.get(actionId);
                      if (action !== undefined)
                        openDialog({
                          kind: 'placeOn',
                          target: actionPlaceTarget(action),
                          date: day.date,
                        });
                    }}
                    {...shared}
                  />
                </li>
              ))}
            </ol>
            <WeeklyRoutines plan={plan} runner={runner} />
          </section>
          <div className="week-side">
            <CarryForward plan={plan} runner={runner} />
            <ThisWeek plan={plan} date={date} onRequest={openDialog} runner={runner} />
            <Backlog plan={plan} date={date} onRequest={openDialog} />
          </div>
        </div>
      </div>

      <PlanDialogs
        request={request}
        onClose={() => setRequest(null)}
        onSavedTemplate={() => setSavedTemplate(true)}
        profile={plan.profile}
        runner={runner}
        viewDate={date}
      />
    </article>
  );
}

function indexActions(plan: WeekPlan): ReadonlyMap<string, ActionSummary> {
  const map = new Map<string, ActionSummary>();
  const add = (action: ActionSummary): void => {
    map.set(action.id, action);
  };
  plan.backlog.items.forEach(add);
  plan.weekActions.forEach(add);
  plan.carryForward.items.forEach(add);
  plan.days.forEach((day) => day.flexibleActions.forEach(add));
  return map;
}

interface SharedProps {
  readonly conflictIndex: ConflictIndex;
  readonly onRequest: RequestDialog;
  readonly profile: PlanProfile;
  readonly runner: CommandRunner;
}

function FixedCommitments({
  plan,
  ...shared
}: SharedProps & { readonly plan: WeekPlan }): ReactNode {
  return (
    <section className="plan-section" aria-labelledby="week-fixed-heading">
      <h2 id="week-fixed-heading">{uiMessage('onboarding-ui.1100')}</h2>
      {plan.fixed.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-week.1351')}</p>
      ) : (
        <ul className="fixed-list">
          <PagedItems items={plan.fixed}>
            {(entry) => (
              <li key={entry.key}>
                <p className="entry-day">{formatDate(entry.localDate, 'weekday')}</p>
                <TimedEntryCard entry={entry} date={entry.localDate} {...shared} />
              </li>
            )}
          </PagedItems>
        </ul>
      )}
    </section>
  );
}

function availabilityText(day: DayColumn, profile: PlanProfile): string {
  if (day.availability.length === 0) return uiMessage('plan.plan-week.1352');
  return uiMessage('plan.plan-week.1353', {
    value0: day.availability
      .map(
        (window) =>
          `${formatWallTime(window.start, profile.timeFormat)}–${formatWindowEnd(
            window.end,
            profile.timeFormat,
          )}`,
      )
      .join(', '),
  });
}

function DayCard({
  conflictIndex,
  day,
  onDropAction,
  onRequest,
  profile,
  runner,
  today,
}: SharedProps & {
  readonly day: DayColumn;
  readonly onDropAction: (actionId: string) => void;
  readonly today: CalendarDate;
}): ReactNode {
  const planning = usePlanning();
  const [dropping, setDropping] = useState(false);
  const weekday = formatDate(day.date, 'weekday');
  const empty =
    day.timed.length === 0 &&
    day.flexibleActions.length === 0 &&
    day.flexibleOccurrences.length === 0;
  const headingId = `week-day-${day.date}`;
  return (
    <section
      className={`day-card${day.date === today ? ' is-today' : ''}${dropping ? ' is-drop-target' : ''}`}
      aria-labelledby={headingId}
      onDragOver={(event) => {
        if (!acceptsActionDrop(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        setDropping(false);
        const actionId = draggedActionId(event);
        if (actionId === null) return;
        event.preventDefault();
        onDropAction(actionId);
      }}
    >
      <h3 id={headingId} className="day-card-heading">
        <Link to={planPath('day', day.date)}>{weekday}</Link>
        {day.date === today && (
          <span className="status-pill today-pill">{uiMessage('app.782')}</span>
        )}
      </h3>
      <p className="day-capacity">{shortDayCapacity(day.capacity)}</p>
      <p className="day-availability field-help">{availabilityText(day, profile)}</p>
      {day.timed.length > 0 && (
        <ul
          className="entry-list"
          aria-label={uiMessage('plan.plan-week.1354', { value0: weekday })}
        >
          <PagedItems items={day.timed}>
            {(entry) => (
              <li key={entry.key}>
                <TimedEntryCard
                  entry={entry}
                  date={day.date}
                  conflictIndex={conflictIndex}
                  onRequest={onRequest}
                  profile={profile}
                  runner={runner}
                />
              </li>
            )}
          </PagedItems>
        </ul>
      )}
      {day.flexibleActions.length > 0 && (
        <ul
          className="action-list"
          aria-label={uiMessage('plan.plan-week.1355', { value0: weekday })}
        >
          <PagedItems items={day.flexibleActions}>
            {(action) => (
              <ActionRow key={action.id} action={action}>
                <button
                  type="button"
                  disabled={runner.busy}
                  onClick={() => onRequest({ kind: 'schedule', action, date: day.date })}
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
                      date: day.date,
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
      {day.flexibleOccurrences.length > 0 && (
        <ul
          className="routine-list"
          aria-label={uiMessage('plan.plan-week.1356', { value0: weekday })}
        >
          <PagedItems items={day.flexibleOccurrences}>
            {(entry) => (
              <li key={entry.ref.occurrenceId}>
                <p className="routine-title">{entry.ref.routineTitle}</p>
                <OccurrenceControls entry={entry} profile={profile} runner={runner} />
              </li>
            )}
          </PagedItems>
        </ul>
      )}
      {empty && <p className="quiet-empty">{uiMessage('plan.plan-week.1357')}</p>}
    </section>
  );
}

function WeeklyRoutines({
  plan,
  runner,
}: {
  readonly plan: WeekPlan;
  readonly runner: CommandRunner;
}): ReactNode {
  if (plan.weeklyCounts.length === 0) return null;
  return (
    <section className="plan-subsection" aria-labelledby="week-routines-heading">
      <h3 id="week-routines-heading">{uiMessage('plan.plan-day.1302')}</h3>
      <ul className="routine-list">
        <PagedItems items={plan.weeklyCounts}>
          {(entry) => (
            <li key={entry.ref.occurrenceId}>
              <p className="routine-title">{entry.ref.routineTitle}</p>
              <OccurrenceControls entry={entry} profile={plan.profile} runner={runner} />
            </li>
          )}
        </PagedItems>
      </ul>
    </section>
  );
}

function CarryForward({
  plan,
  runner,
}: {
  readonly plan: WeekPlan;
  readonly runner: CommandRunner;
}): ReactNode {
  const planning = usePlanning();
  const items = plan.carryForward.items;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [destination, setDestination] = useState<string>('week');
  const selectAll = useRef<HTMLInputElement>(null);
  const available = items.filter((item) => selected.has(item.id));
  useEffect(() => {
    setSelected((current) => {
      const ids = new Set<string>(items.map((item) => item.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);
  useEffect(() => {
    if (selectAll.current !== null)
      selectAll.current.indeterminate = available.length > 0 && available.length < items.length;
  }, [available.length, items.length]);
  const destinationLabel =
    destination === 'week' ? uiMessage('plan.plan-week.1358') : formatDate(destination, 'weekday');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (available.length === 0) return;
    void runner
      .run(
        () =>
          planning.carryForward({
            actions: available.map((item) => ({ id: item.id, revision: item.localRevision })),
            period:
              destination === 'week'
                ? { kind: 'week', date: plan.week.start }
                : { kind: 'day', date: destination },
          }),
        uiMessage('plan.plan-week.1359', {
          value0: String(available.length),
          value1: destinationLabel,
        }),
      )
      .then((saved) => {
        if (saved) setSelected(new Set());
      });
  };
  return (
    <section className="plan-section side-section" aria-labelledby="week-carry-heading">
      <h2 id="week-carry-heading">{uiMessage('plan.plan-week.1360')}</h2>
      {items.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-week.1361')}</p>
      ) : (
        <form className="carry-form" onSubmit={submit}>
          <p className="field-help">{uiMessage('plan.plan-week.1362')}</p>
          <label className="check-row" htmlFor="carry-select-all">
            <input
              id="carry-select-all"
              ref={selectAll}
              type="checkbox"
              checked={available.length === items.length}
              onChange={(event) =>
                setSelected(
                  event.target.checked ? new Set(items.map((item) => item.id)) : new Set(),
                )
              }
            />
            <span>
              {uiMessage('plan.plan-week.1363')}
              {String(items.length)})
            </span>
          </label>
          <ul className="carry-list" aria-label={uiMessage('plan.plan-week.1364')}>
            <PagedItems items={items}>
              {(item) => (
                <li key={item.id}>
                  <label className="check-row" htmlFor={`carry-${item.id}`}>
                    <input
                      id={`carry-${item.id}`}
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        })
                      }
                    />
                    <span>
                      {item.title}
                      {item.placement !== undefined && (
                        <span className="field-help block-help">
                          {uiMessage('plan.plan-week.1365')}
                          {formatPeriod(item.placement.period)}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              )}
            </PagedItems>
          </ul>
          {plan.carryForward.total > items.length && (
            <p className="field-help">
              {uiMessage('actions-ui.320')}
              {String(items.length)}
              {uiMessage('actions-ui.321')}
              {String(plan.carryForward.total)}.
            </p>
          )}
          <label className="field-label" htmlFor="carry-destination">
            {uiMessage('plan.plan-week.1366')}
            <select
              id="carry-destination"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
            >
              <option value="week">{uiMessage('plan.plan-week.1367')}</option>
              {plan.days.map((day) => (
                <option key={day.date} value={day.date}>
                  {formatDate(day.date, 'long')}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={runner.busy || available.length === 0}
          >
            {uiMessage('plan.plan-week.1368')}
            {destinationLabel}
          </button>
          {available.length === 0 && (
            <p className="field-help">{uiMessage('plan.plan-week.1369')}</p>
          )}
        </form>
      )}
    </section>
  );
}

function selectionKindLabel(row: WeekSelectionRow): string {
  switch (row.target.kind) {
    case 'action':
      return uiMessage('actions-ui.282');
    case 'project':
      return uiMessage('actions-ui.254');
    case 'milestone':
      return uiMessage('actions-ui.276');
  }
}

function placedObjectTarget(row: PlacementRow) {
  switch (row.target.kind) {
    case 'project':
    case 'milestone':
    case 'outcome':
      return {
        input: { kind: row.target.kind, id: row.target.id, revision: row.target.localRevision },
        title: row.target.title,
      } as const;
    case 'action':
      return actionPlaceTarget(row.target.action);
  }
}

function ThisWeek({
  date,
  onRequest,
  plan,
  runner,
}: {
  readonly date: CalendarDate;
  readonly onRequest: RequestDialog;
  readonly plan: WeekPlan;
  readonly runner: CommandRunner;
}): ReactNode {
  const planning = usePlanning();
  const committed = new Set(
    plan.weekCommitments.map((row) => `${row.target.kind}:${row.target.id}`),
  );
  const commit = (kind: 'action' | 'project' | 'milestone', id: string): void =>
    void runner.run(
      () => planning.addWeekCommitment({ weekDate: plan.week.start, target: { kind, id } }),
      uiMessage('alignment.project-detail.748'),
    );
  const objects = plan.weekObjects.filter(
    (row) => row.target.kind === 'project' || row.target.kind === 'milestone',
  );
  return (
    <section className="plan-section side-section" aria-labelledby="week-this-heading">
      <h2 id="week-this-heading">{uiMessage('plan.plan-month.1315')}</h2>
      <h3>{uiMessage('plan.plan-month.1321')}</h3>
      {plan.weekCommitments.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-week.1370')}</p>
      ) : (
        <ul className="commitment-list" aria-label={uiMessage('plan.plan-week.1371')}>
          <PagedItems items={plan.weekCommitments}>
            {(row) => (
              <li key={row.id}>
                <p>
                  {row.target.kind === 'milestone' ? (
                    <Link to={milestonePath(row.target.id)}>{row.target.title}</Link>
                  ) : (
                    row.target.title
                  )}{' '}
                  <span className="field-help">{selectionKindLabel(row)}</span>
                </p>
                <button
                  type="button"
                  disabled={runner.busy}
                  onClick={() =>
                    void runner.run(
                      () =>
                        planning.removeWeekCommitment({
                          selectionId: row.id,
                          revision: row.localRevision,
                        }),
                      uiMessage('plan.plan-week.1372'),
                    )
                  }
                >
                  {uiMessage('plan.plan-week.1373')}
                  <span className="sr-only">
                    {row.target.title}
                    {uiMessage('plan.plan-week.1374')}
                  </span>
                </button>
              </li>
            )}
          </PagedItems>
        </ul>
      )}
      {plan.weekCommitments.length > 3 && (
        <p className="field-help">{uiMessage('plan.plan-week.1375')}</p>
      )}
      <h3>{uiMessage('plan.plan-week.1376')}</h3>
      {plan.weekActions.length === 0 && objects.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-week.1377')}</p>
      ) : (
        <ul className="action-list" aria-label={uiMessage('plan.plan-week.1376')}>
          <PagedItems items={plan.weekActions}>
            {(action) => (
              <ActionRow key={action.id} action={action}>
                <button
                  type="button"
                  disabled={runner.busy}
                  onClick={() =>
                    onRequest({
                      kind: 'place',
                      target: actionPlaceTarget(action),
                      date,
                      choice: 'day',
                    })
                  }
                >
                  {uiMessage('plan.plan-week.1378')}
                  <span className="sr-only">{action.title}</span>
                </button>
                <button
                  type="button"
                  disabled={runner.busy}
                  onClick={() => onRequest({ kind: 'schedule', action, date })}
                >
                  {uiMessage('alignment.project-detail.744')}
                  <span className="sr-only">{action.title}</span>
                </button>
                {!committed.has(`action:${action.id}`) && (
                  <button
                    type="button"
                    disabled={runner.busy}
                    onClick={() => commit('action', action.id)}
                  >
                    {uiMessage('plan.plan-week.1379')}
                    <span className="sr-only">{action.title}</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={runner.busy}
                  onClick={() =>
                    void runner.run(
                      () => planning.unplace({ target: actionPlaceTarget(action).input }),
                      uiMessage('plan.plan-week.1380'),
                    )
                  }
                >
                  {uiMessage('plan.plan-week.1381')}
                  <span className="sr-only">{action.title}</span>
                </button>
              </ActionRow>
            )}
          </PagedItems>
          <PagedItems items={objects}>
            {(row) => {
              const target = placedObjectTarget(row);
              const kind = row.target.kind === 'milestone' ? 'milestone' : 'project';
              return (
                <li key={row.id} className="action-row">
                  <p className="action-row-title">
                    {row.target.kind === 'milestone' ? (
                      <Link to={milestonePath(row.target.id)}>{row.target.title}</Link>
                    ) : (
                      target.title
                    )}
                  </p>
                  <p className="field-help">
                    {kind === 'milestone'
                      ? uiMessage('actions-ui.276')
                      : uiMessage('actions-ui.254')}
                  </p>
                  <div className="control-row">
                    <button
                      type="button"
                      disabled={runner.busy}
                      onClick={() => onRequest({ kind: 'place', target, date, choice: 'day' })}
                    >
                      {uiMessage('plan.plan-week.1378')}
                      <span className="sr-only">{target.title}</span>
                    </button>
                    {!committed.has(`${kind}:${target.input.id}`) && (
                      <button
                        type="button"
                        disabled={runner.busy}
                        onClick={() => commit(kind, target.input.id)}
                      >
                        {uiMessage('plan.plan-week.1379')}
                        <span className="sr-only">{target.title}</span>
                      </button>
                    )}
                  </div>
                </li>
              );
            }}
          </PagedItems>
        </ul>
      )}
    </section>
  );
}

function Backlog({
  date,
  onRequest,
  plan,
}: {
  readonly date: CalendarDate;
  readonly onRequest: RequestDialog;
  readonly plan: WeekPlan;
}): ReactNode {
  const { items, total } = plan.backlog;
  return (
    <section
      className="plan-section side-section backlog-panel"
      aria-labelledby="week-backlog-heading"
    >
      <h2 id="week-backlog-heading">{uiMessage('plan.plan-day.1303')}</h2>
      <p className="field-help">
        {total === 0
          ? uiMessage('plan.plan-day.1304')
          : uiMessage('plan.plan-week.1382', {
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
                  onClick={() =>
                    onRequest({
                      kind: 'place',
                      target: actionPlaceTarget(action),
                      date,
                      choice: 'day',
                    })
                  }
                >
                  {uiMessage('plan.plan-week.1378')}
                  <span className="sr-only">{action.title}</span>
                </button>
                <button type="button" onClick={() => onRequest({ kind: 'schedule', action, date })}>
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
