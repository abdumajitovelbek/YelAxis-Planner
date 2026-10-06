import { message as uiMessage } from '../messages';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useParams } from 'react-router-dom';

import type { CalendarDate } from '@yelaxis/domain';

import { CapacitySettingsPage } from './capacity-settings';
import { DayView } from './plan-day';
import { MonthView } from './plan-month';
import { usePlanningToday, usePlanningTodayState } from './planning-context';
import { WeekView } from './plan-week';
import { YearView } from './plan-year';
import { RoutineDetailPage, RoutinesPage } from './routines';
import {
  capacityPath,
  lastHorizonKey,
  planHorizons,
  planPath,
  routinesPath,
  templatesPath,
  type PlanHorizon,
} from './routes';
import { useScrollMemory } from './scroll-memory';
import { TemplateDetailPage, TemplatesPage } from './templates';
import { isCalendarDate, shiftDays, shiftMonths } from './timeline';
import { NavigationGuardProvider, useGuardedNavigate } from './unsaved-guard';

import './plan-shell.css';

const horizonLabels: Readonly<Record<PlanHorizon, string>> = {
  year: uiMessage('alignment.detail-parts.463'),
  month: uiMessage('actions-ui.249'),
  week: uiMessage('actions-ui.248'),
  day: uiMessage('actions-ui.247'),
};

const isHorizon = (value: string | undefined): value is PlanHorizon =>
  planHorizons.some((horizon) => horizon === value);

/** The browser's last horizon choice (a per-browser presentation preference only). */
function storedHorizon(): PlanHorizon {
  try {
    const value = window.localStorage.getItem(lastHorizonKey) ?? undefined;
    return isHorizon(value) ? value : 'week';
  } catch {
    return 'week';
  }
}

function rememberHorizon(horizon: PlanHorizon): void {
  try {
    window.localStorage.setItem(lastHorizonKey, horizon);
  } catch {
    // Storage may be unavailable; the preference is optional.
  }
}

/** The adjacent period for a horizon. Months keep the day when it exists. */
export function adjacentDate(horizon: PlanHorizon, date: string, direction: 1 | -1): CalendarDate {
  switch (horizon) {
    case 'day':
      return shiftDays(date, direction);
    case 'week':
      return shiftDays(date, 7 * direction);
    case 'month':
      return shiftMonths(date, direction);
    case 'year':
      return shiftMonths(date, 12 * direction);
  }
}

/** Plan routes: horizons, Routines, Templates, and Availability. */
export function PlanRoutes(): ReactNode {
  useScrollMemory();
  return (
    <NavigationGuardProvider>
      <Routes>
        <Route index element={<PlanIndexRedirect />} />
        <Route
          path="routines"
          element={
            <PlanToolFrame>
              <RoutinesPage />
            </PlanToolFrame>
          }
        />
        <Route
          path="routines/:routineId"
          element={
            <PlanToolFrame>
              <RoutineDetailPage />
            </PlanToolFrame>
          }
        />
        <Route
          path="templates"
          element={
            <PlanToolFrame>
              <TemplatesPage />
            </PlanToolFrame>
          }
        />
        <Route
          path="templates/:templateId"
          element={
            <PlanToolFrame>
              <TemplateDetailPage />
            </PlanToolFrame>
          }
        />
        <Route
          path="availability"
          element={
            <PlanToolFrame>
              <CapacitySettingsPage />
            </PlanToolFrame>
          }
        />
        <Route path=":horizon/:date" element={<HorizonPage />} />
        <Route path="*" element={<InvalidPlanLink />} />
      </Routes>
    </NavigationGuardProvider>
  );
}

function PlanIndexRedirect(): ReactNode {
  // Wait for the Profile planning zone so the entry opens the same today the views mark.
  const today = usePlanningTodayState();
  if (!today.settled) return null;
  return <Navigate replace to={planPath(storedHorizon(), today.date)} />;
}

function HorizonPage(): ReactNode {
  const { horizon, date } = useParams();
  const valid = isHorizon(horizon) && date !== undefined && isCalendarDate(date);
  useEffect(() => {
    if (isHorizon(horizon)) rememberHorizon(horizon);
  }, [horizon]);
  if (!valid) return <InvalidPlanLink />;
  const day = date as CalendarDate;
  return (
    <div className="plan-shell-page">
      <PlanHeader horizon={horizon} date={day} />
      {horizon === 'week' ? (
        <WeekView date={day} />
      ) : horizon === 'day' ? (
        <DayView date={day} />
      ) : horizon === 'month' ? (
        <MonthView date={day} />
      ) : (
        <YearView date={day} />
      )}
    </div>
  );
}

function PlanToolFrame({ children }: { readonly children: ReactNode }): ReactNode {
  const today = usePlanningToday();
  return (
    <div className="plan-shell-page">
      <PlanHeader horizon={null} date={today} />
      {children}
    </div>
  );
}

const periodNoun: Readonly<Record<PlanHorizon, string>> = {
  year: 'year',
  month: 'month',
  week: 'week',
  day: 'day',
};

function PlanHeader({
  date,
  horizon,
}: {
  readonly date: CalendarDate;
  readonly horizon: PlanHorizon | null;
}): ReactNode {
  const navigate = useGuardedNavigate();
  const today = usePlanningToday();
  const [target, setTarget] = useState<string>(date);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setTarget(date), [date]);
  const active = horizon ?? storedHorizon();
  const goTo = (event: FormEvent): void => {
    event.preventDefault();
    if (!isCalendarDate(target)) {
      setError(uiMessage('alignment.detail-parts.460'));
      return;
    }
    setError(null);
    navigate(planPath(active, target));
  };
  return (
    <div className="plan-header">
      <nav aria-label={uiMessage('actions-ui.246')} className="horizon-nav">
        <ul>
          {planHorizons.map((item) => (
            <li key={item}>
              <Link
                to={planPath(item, date)}
                aria-current={item === horizon ? 'page' : undefined}
                className={item === horizon ? 'is-active' : undefined}
              >
                {horizonLabels[item]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {horizon !== null && (
        <nav aria-label={uiMessage('plan.plan-shell.1336')} className="period-nav">
          <ul>
            <li>
              <Link to={planPath(horizon, adjacentDate(horizon, date, -1))}>
                {uiMessage('plan.plan-shell.1337')}
                <span className="sr-only">{periodNoun[horizon]}</span>
              </Link>
            </li>
            <li>
              <Link to={planPath(horizon, today)}>{uiMessage('app.782')}</Link>
            </li>
            <li>
              <Link to={planPath(horizon, adjacentDate(horizon, date, 1))}>
                {uiMessage('plan.plan-shell.1338')}
                <span className="sr-only">{periodNoun[horizon]}</span>
              </Link>
            </li>
          </ul>
        </nav>
      )}
      <form className="go-to-date" onSubmit={goTo} noValidate>
        <label htmlFor="plan-go-to-date">{uiMessage('plan.plan-shell.1339')}</label>
        <input
          id="plan-go-to-date"
          type="date"
          value={target}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : 'plan-go-to-date-error'}
          onChange={(event) => setTarget(event.target.value)}
        />
        <button type="submit">{uiMessage('plan.plan-shell.1340')}</button>
        {error !== null && (
          <p id="plan-go-to-date-error" className="warning-text" role="alert">
            {error}
          </p>
        )}
      </form>
      <nav aria-label={uiMessage('plan.plan-shell.1341')} className="tools-nav">
        <ul>
          <li>
            <NavLink to={routinesPath}>{uiMessage('alignment.axis-detail.433')}</NavLink>
          </li>
          <li>
            <NavLink to={templatesPath}>{uiMessage('plan.plan-shell.1342')}</NavLink>
          </li>
          <li>
            <NavLink to={capacityPath}>{uiMessage('plan.capacity-settings.1179')}</NavLink>
          </li>
        </ul>
      </nav>
    </div>
  );
}

function InvalidPlanLink(): ReactNode {
  const today = usePlanningToday();
  return (
    <section className="plan-view" aria-labelledby="plan-invalid-title">
      <p className="eyebrow">{uiMessage('actions-ui.250')}</p>
      <h1 id="plan-invalid-title">{uiMessage('plan.plan-shell.1343')}</h1>
      <p className="page-message">{uiMessage('plan.plan-shell.1344')}</p>
      <Link className="inline-button" to={planPath('week', today)}>
        {uiMessage('plan.plan-shell.1345')}
      </Link>
    </section>
  );
}
