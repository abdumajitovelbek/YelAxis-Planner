import { message as uiMessage } from '../messages';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { ImportantDate, YearMonthSummary, YearPlan } from '@yelaxis/application';
import type { CalendarDate } from '@yelaxis/domain';

import { formatDate, formatMonth, formatPeriod } from './format';
import { usePlanning, usePlanQuery } from './planning-context';
import { milestonePath, planPath } from './routes';
import {
  HorizonSection,
  milestoneStateLabel,
  outcomeProgressText,
  outcomeStateLabel,
  targetWindowText,
  ThemeEditor,
} from './theme-editor';

import './horizon-views.css';

type YearLayout = 'quarters' | 'months';

export const yearLayoutKey = 'yelaxis:plan:year-layout';

const readStoredLayout = (): YearLayout => {
  try {
    return window.localStorage.getItem(yearLayoutKey) === 'months' ? 'months' : 'quarters';
  } catch {
    return 'quarters';
  }
};

const storeLayout = (layout: YearLayout): void => {
  try {
    window.localStorage.setItem(yearLayoutKey, layout);
  } catch {
    // Presentation preference only; the URL still carries it.
  }
};

/** Presentation preference: `?view=quarters|months`, falling back to the last local choice. */
function useYearLayout(): [YearLayout, (layout: YearLayout) => void] {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('view');
  const urlLayout = fromUrl === 'months' || fromUrl === 'quarters' ? fromUrl : null;
  // Local state answers the click immediately; the URL (replace navigation) follows.
  const [layout, setLayout] = useState<YearLayout>(() => urlLayout ?? readStoredLayout());
  useEffect(() => {
    if (urlLayout !== null) setLayout(urlLayout);
  }, [urlLayout]);
  const choose = (next: YearLayout): void => {
    setLayout(next);
    storeLayout(next);
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.set('view', next);
        return updated;
      },
      { replace: true },
    );
  };
  return [layout, choose];
}

const importantDateKinds: Readonly<Record<ImportantDate['kind'], string>> = {
  outcome_target: uiMessage('plan.plan-year.1384'),
  milestone_target: uiMessage('plan.plan-year.1385'),
  project_target: uiMessage('plan.plan-year.1386'),
};

/**
 * Year horizon: optional direction, twelve months (or quarters), active Outcomes with read-only
 * progress, Milestones, and important dates. Daily Actions are intentionally absent.
 */
export function YearView({ date }: { readonly date: CalendarDate }): ReactNode {
  const planning = usePlanning();
  const year = date.slice(0, 4);
  const titleId = useId();
  const { state, reload } = usePlanQuery(() => planning.getYearPlan(year), [planning, year]);

  if (state.status !== 'ready') {
    return (
      <section className="horizon-view year-view" aria-labelledby={titleId}>
        <p className="eyebrow">{uiMessage('alignment.detail-parts.463')}</p>
        <h1 id={titleId}>{year}</h1>
        {state.status === 'loading' ? (
          <p className="page-message" role="status">
            {uiMessage('plan.plan-year.1387')}
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
      className="horizon-view year-view"
      aria-labelledby={titleId}
      aria-busy={state.refreshing}
    >
      <p className="eyebrow">{uiMessage('alignment.detail-parts.463')}</p>
      <h1 id={titleId}>{year}</h1>
      <ThemeEditor
        key={year}
        kind="year"
        periodLabel={year}
        text={plan.direction?.text}
        save={(text) => planning.setYearDirection({ year, text })}
        clear={() => planning.clearYearDirection({ year })}
      />
      <YearMonths plan={plan} />
      <p className="quiet-empty">{uiMessage('plan.plan-year.1388')}</p>
      <div className="horizon-columns">
        <YearOutcomes plan={plan} />
        <YearMilestones plan={plan} />
        <YearImportantDates plan={plan} />
      </div>
    </section>
  );
}

function YearMonths({ plan }: { readonly plan: YearPlan }): ReactNode {
  const [layout, setLayout] = useYearLayout();
  const legendId = useId();
  const quarters = [0, 1, 2, 3].map((quarter) => plan.months.slice(quarter * 3, quarter * 3 + 3));
  return (
    <HorizonSection
      title={uiMessage('plan.plan-year.1389')}
      help={uiMessage('plan.plan-year.1390')}
    >
      <fieldset className="compact-fieldset year-layout" aria-labelledby={legendId}>
        <legend id={legendId}>{uiMessage('plan.plan-year.1391')}</legend>
        <div className="segmented-options">
          {(['quarters', 'months'] as const).map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="year-layout"
                value={option}
                checked={layout === option}
                onChange={() => setLayout(option)}
              />
              <span>
                {option === 'quarters'
                  ? uiMessage('plan.plan-year.1392')
                  : uiMessage('plan.plan-year.1389')}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {layout === 'quarters' ? (
        <div className="quarter-grid">
          {quarters.map((months, index) => {
            const first = months[0];
            const last = months.at(-1);
            if (first === undefined || last === undefined) return null;
            const label = `Q${String(index + 1)}`;
            return (
              <section
                key={label}
                className="quarter"
                aria-label={uiMessage('plan.plan-year.1393', {
                  value0: label,
                  value1: formatMonth(first.month),
                  value2: formatMonth(last.month),
                })}
              >
                <h3>
                  {label}
                  <span className="quarter-range">{` ${monthName(first.month)} – ${monthName(
                    last.month,
                  )}`}</span>
                </h3>
                <MonthCards
                  months={months}
                  label={uiMessage('plan.plan-year.1394', { value0: label })}
                />
              </section>
            );
          })}
        </div>
      ) : (
        <MonthCards
          months={plan.months}
          label={uiMessage('plan.plan-year.1394', { value0: plan.year })}
        />
      )}
    </HorizonSection>
  );
}

const monthName = (month: string): string =>
  new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(
    new Date(`${month}-01T12:00:00Z`),
  );

function countText(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? '' : 's'}`;
}

function MonthCards({
  label,
  months,
}: {
  readonly months: readonly YearMonthSummary[];
  readonly label: string;
}): ReactNode {
  return (
    <ul className="month-cards" aria-label={label}>
      {months.map((summary) => (
        <li key={summary.month} className="month-card">
          <Link className="horizon-item-title" to={planPath('month', `${summary.month}-01`)}>
            {formatMonth(summary.month)}
          </Link>
          {summary.theme !== undefined ? (
            <p className="month-card-theme">{summary.theme.text}</p>
          ) : (
            <p className="horizon-meta">{uiMessage('plan.plan-year.1395')}</p>
          )}
          <p className="horizon-meta">
            {summary.milestoneCount === 0 && summary.outcomeCount === 0
              ? uiMessage('plan.plan-year.1396')
              : `${countText(summary.milestoneCount, 'milestone')}, ${countText(
                  summary.outcomeCount,
                  'outcome',
                )}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

function YearOutcomes({ plan }: { readonly plan: YearPlan }): ReactNode {
  return (
    <HorizonSection
      title={uiMessage('plan.plan-year.1397')}
      help={uiMessage('plan.plan-month.1330')}
    >
      {plan.outcomes.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-year.1398')}</p>
      ) : (
        <ul className="horizon-list" aria-label={uiMessage('plan.plan-year.1399')}>
          {plan.outcomes.map((outcome) => (
            <li key={outcome.id} className="horizon-item">
              <p className="horizon-item-title">{outcome.title}</p>
              <p className="horizon-meta">{`Progress: ${outcomeProgressText(outcome.progress)}`}</p>
              <p className="horizon-meta">
                <span className="status-pill">{outcomeStateLabel(outcome.state)}</span>{' '}
                {targetWindowText(outcome.targetStart, outcome.targetEnd)}
              </p>
              {outcome.axisTitle !== undefined && (
                <p className="horizon-meta">{`Axis: ${outcome.axisTitle}`}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </HorizonSection>
  );
}

function YearMilestones({ plan }: { readonly plan: YearPlan }): ReactNode {
  return (
    <HorizonSection title={uiMessage('actions-ui.314')}>
      {plan.milestones.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-year.1400')}</p>
      ) : (
        <ul className="horizon-list" aria-label={uiMessage('plan.plan-year.1401')}>
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

function YearImportantDates({ plan }: { readonly plan: YearPlan }): ReactNode {
  const dates = [...plan.importantDates].sort(
    (left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title),
  );
  return (
    <HorizonSection
      title={uiMessage('plan.plan-year.1402')}
      help={uiMessage('plan.plan-year.1403')}
    >
      {dates.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.plan-year.1404')}</p>
      ) : (
        <ul className="horizon-list" aria-label={uiMessage('plan.plan-year.1405')}>
          {dates.map((item) => (
            <li key={`${item.kind}:${item.id}:${item.date}`} className="horizon-item date-item">
              <time dateTime={item.date}>{formatDate(item.date)}</time>
              <span className="horizon-meta">{importantDateKinds[item.kind]}</span>
              {item.kind === 'milestone_target' ? (
                <Link className="horizon-item-title" to={milestonePath(item.id)}>
                  {item.title}
                </Link>
              ) : (
                <span className="horizon-item-title">{item.title}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </HorizonSection>
  );
}
