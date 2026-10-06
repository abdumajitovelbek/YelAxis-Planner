import { message as uiMessage } from '../messages';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { MonthPlan, TimedEntry, WeekDensity } from '@yelaxis/application';
import type { CalendarDate } from '@yelaxis/domain';

import {
  formatDate,
  formatDuration,
  formatMonth,
  formatPeriod,
  formatWallTime,
  formatWeekRange,
} from './format';
import { usePlanning, usePlanQuery } from './planning-context';
import { actionPath, milestonePath, planPath } from './routes';
import {
  actionStateLabel,
  milestoneStateLabel,
  outcomeProgressText,
  outcomeStateLabel,
  projectStateLabel,
  HorizonSection,
  targetWindowText,
  ThemeEditor,
} from './theme-editor';

import './horizon-views.css';

/**
 * Month horizon: week-level density, Milestones, Commitments, Project targets, Outcomes, and
 * Month-placed Actions. There are intentionally no daily-task calendar cells.
 */
export function MonthView({ date }: { readonly date: CalendarDate }): ReactNode {
  const planning = usePlanning();
  const month = date.slice(0, 7);
  const titleId = useId();
  const { state, reload } = usePlanQuery(() => planning.getMonthPlan(month), [planning, month]);
  const title = formatMonth(month);

  if (state.status !== 'ready') {
    return (
      <section className="horizon-view month-view" aria-labelledby={titleId}>
        <p className="eyebrow">{uiMessage('actions-ui.249')}</p>
        <h1 id={titleId}>{title}</h1>
        {state.status === 'loading' ? (
          <p className="page-message" role="status">
            {uiMessage('plan.plan-month.1309')}
          </p>
        ) : (
          <div className="horizon-error">
            <p role="alert">{state.message}</p>
            <button type="button" onClick={() => void reload()}>
              {uiMessage('account.account-dialogs.47')}
            </button>
          </div>
        )}
      </section>
    );
  }

  const plan = state.data;
  return (
    <section
      className="horizon-view month-view"
      aria-labelledby={titleId}
      aria-busy={state.refreshing}
    >
      <p className="eyebrow">{uiMessage('actions-ui.249')}</p>
      <h1 id={titleId}>{title}</h1>
      <ThemeEditor
        key={month}
        kind="month"
        periodLabel={title}
        text={plan.theme?.text}
        save={(text) => planning.setMonthTheme({ month, text })}
        clear={() => planning.clearMonthTheme({ month })}
      />
      <MonthWeeks plan={plan} />
      <div className="horizon-columns">
        <MonthMilestones plan={plan} />
        <MonthCommitments plan={plan} />
        <MonthProjectTargets plan={plan} />
        <MonthOutcomes plan={plan} />
        <MonthActions plan={plan} />
      </div>
    </section>
  );
}

function MonthWeeks({ plan }: { readonly plan: MonthPlan }): ReactNode {
  const busiest = Math.max(0, ...plan.weeks.map((week) => week.plannedMinutes));
  return (
    <HorizonSection
      title={uiMessage('plan.plan-month.1310')}
      help={uiMessage('plan.plan-month.1311')}
    >
      {plan.weeks.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-month.1312')}</p>
      ) : (
        <ol className="density-list" aria-label={uiMessage('plan.plan-month.1313')}>
          {plan.weeks.map((week) => (
            <WeekDensityItem
              key={week.week.start}
              week={week}
              busiest={busiest}
              today={plan.today}
            />
          ))}
        </ol>
      )}
    </HorizonSection>
  );
}

function WeekDensityItem({
  busiest,
  today,
  week,
}: {
  readonly week: WeekDensity;
  readonly busiest: number;
  readonly today: CalendarDate;
}): ReactNode {
  const range = formatWeekRange(week.week);
  const current = week.week.start <= today && today <= week.week.end;
  const share = busiest === 0 ? 0 : week.plannedMinutes / busiest;
  return (
    <li className="density-item">
      <div className="density-heading">
        <Link
          to={planPath('week', week.week.start)}
          aria-label={uiMessage('plan.plan-month.1314', { value0: range })}
        >
          {range}
        </Link>
        {current && <span className="status-pill">{uiMessage('plan.plan-month.1315')}</span>}
      </div>
      <div className="density-track" aria-hidden="true">
        <span className="density-fill" style={{ inlineSize: `${String(share * 100)}%` }} />
      </div>
      <p className="density-summary">{week.summary}</p>
    </li>
  );
}

function MonthMilestones({ plan }: { readonly plan: MonthPlan }): ReactNode {
  return (
    <HorizonSection title={uiMessage('actions-ui.314')}>
      {plan.milestones.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-month.1316')}</p>
      ) : (
        <ul className="horizon-list" aria-label={uiMessage('plan.plan-month.1317')}>
          {plan.milestones.map((milestone) => (
            <li key={milestone.id} className="horizon-item">
              <Link className="horizon-item-title" to={milestonePath(milestone.id)}>
                {milestone.title}
              </Link>
              <p className="horizon-meta">{`Outcome: ${milestone.outcomeTitle}`}</p>
              <p className="horizon-meta">
                <span className="status-pill">{milestoneStateLabel(milestone.state)}</span>{' '}
                {targetWindowText(milestone.targetStart, milestone.targetEnd)}
                {milestone.placement !== undefined &&
                  uiMessage('plan.plan-month.1318', {
                    value0: formatPeriod(milestone.placement.period),
                  })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </HorizonSection>
  );
}

function commitmentStrengthLabel(entry: TimedEntry): string | null {
  const target = entry.block?.target;
  if (target?.kind !== 'commitment') return null;
  return target.strength === 'hard'
    ? uiMessage('plan.plan-month.1319')
    : uiMessage('plan.plan-month.1320');
}

function MonthCommitments({ plan }: { readonly plan: MonthPlan }): ReactNode {
  const timeFormat = plan.profile.timeFormat;
  return (
    <HorizonSection title={uiMessage('plan.plan-month.1321')}>
      {plan.commitments.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-month.1322')}</p>
      ) : (
        <ul className="horizon-list" aria-label={uiMessage('plan.plan-month.1323')}>
          {plan.commitments.map((entry) => {
            const strength = commitmentStrengthLabel(entry);
            return (
              <li key={entry.key} className="horizon-item">
                <p className="horizon-item-title">{entry.title}</p>
                <p className="horizon-meta">
                  <Link to={planPath('day', entry.localDate)}>
                    <time dateTime={entry.localDate}>{formatDate(entry.localDate, 'weekday')}</time>
                  </Link>
                  <span>
                    {`${formatWallTime(entry.localStart, timeFormat)}–${formatWallTime(
                      entry.localEnd,
                      timeFormat,
                    )} (${formatDuration(entry.durationMinutes)})`}
                  </span>
                </p>
                <p className="horizon-meta">
                  {strength !== null && <span className="status-pill">{strength}</span>}
                  {entry.state === 'completed' && (
                    <span className="status-pill">{uiMessage('plan.plan-month.1324')}</span>
                  )}
                  {entry.state === 'skipped' && (
                    <span className="status-pill">{uiMessage('plan.plan-month.1325')}</span>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </HorizonSection>
  );
}

function MonthProjectTargets({ plan }: { readonly plan: MonthPlan }): ReactNode {
  return (
    <HorizonSection title={uiMessage('plan.plan-month.1326')}>
      {plan.projectTargets.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-month.1327')}</p>
      ) : (
        <ul className="horizon-list" aria-label={uiMessage('plan.plan-month.1328')}>
          {plan.projectTargets.map((project) => (
            <li key={project.id} className="horizon-item">
              <p className="horizon-item-title">{project.title}</p>
              <p className="horizon-meta">
                <span className="status-pill">{projectStateLabel(project.state)}</span>{' '}
                {targetWindowText(project.targetStart, project.targetEnd)}
                {project.placement !== undefined &&
                  uiMessage('plan.plan-month.1318', {
                    value0: formatPeriod(project.placement.period),
                  })}
              </p>
              {project.axisTitle !== undefined && (
                <p className="horizon-meta">{`Axis: ${project.axisTitle}`}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </HorizonSection>
  );
}

function MonthOutcomes({ plan }: { readonly plan: MonthPlan }): ReactNode {
  return (
    <HorizonSection
      title={uiMessage('plan.plan-month.1329')}
      help={uiMessage('plan.plan-month.1330')}
    >
      {plan.outcomes.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-month.1331')}</p>
      ) : (
        <ul className="horizon-list" aria-label={uiMessage('plan.plan-month.1329')}>
          {plan.outcomes.map((outcome) => (
            <li key={outcome.id} className="horizon-item">
              <p className="horizon-item-title">{outcome.title}</p>
              <p className="horizon-meta">{`Progress: ${outcomeProgressText(outcome.progress)}`}</p>
              <p className="horizon-meta">
                <span className="status-pill">{outcomeStateLabel(outcome.state)}</span>{' '}
                {targetWindowText(outcome.targetStart, outcome.targetEnd)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </HorizonSection>
  );
}

function MonthActions({ plan }: { readonly plan: MonthPlan }): ReactNode {
  return (
    <HorizonSection title={uiMessage('plan.plan-month.1332')}>
      {plan.monthActions.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-month.1333')}</p>
      ) : (
        <ul className="horizon-list" aria-label={uiMessage('plan.plan-month.1332')}>
          {plan.monthActions.map((action) => (
            <li key={action.id} className="horizon-item">
              <Link className="horizon-item-title" to={actionPath(action.id)}>
                {action.title}
              </Link>
              <p className="horizon-meta">
                <span className="status-pill">{actionStateLabel(action.state)}</span>
                {action.estimateMinutes !== undefined &&
                  uiMessage('plan.plan-month.1334', {
                    value0: formatDuration(action.estimateMinutes),
                  })}
                {action.projectTitle !== undefined &&
                  uiMessage('plan.plan-month.1335', { value0: action.projectTitle })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </HorizonSection>
  );
}
