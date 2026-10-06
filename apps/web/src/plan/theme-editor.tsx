import { message as uiMessage } from '../messages';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type { ApplicationResult, CommandReceipt, OutcomeProgressView } from '@yelaxis/application';
import type {
  ActionState,
  CalendarDate,
  HorizonPeriod,
  MilestoneState,
  OutcomeState,
  ProjectState,
} from '@yelaxis/domain';

import { formatDate } from './format';
import { CommandFeedback, useCommandRunner } from './planning-context';
import type { PlanHorizon } from './routes';
import { useUnsavedGuard } from './unsaved-guard';

import './horizon-views.css';

export const themeTextLimit = 2000;

const numberFormat = new Intl.NumberFormat();

/**
 * Optional plain-text Month theme or Year direction. It is only text: no completion, progress, or
 * percentage. Saving replaces the single active record; clearing archives it. Both are undoable.
 */
export function ThemeEditor({
  clear,
  kind,
  periodLabel,
  save,
  text,
}: {
  readonly kind: 'month' | 'year';
  readonly periodLabel: string;
  readonly text: string | undefined;
  readonly save: (text: string) => Promise<ApplicationResult<CommandReceipt>>;
  readonly clear: () => Promise<ApplicationResult<CommandReceipt>>;
}): ReactNode {
  const noun = kind === 'month' ? 'theme' : 'direction';
  const title =
    kind === 'month' ? uiMessage('plan.theme-editor.1845') : uiMessage('plan.theme-editor.1846');
  const runner = useCommandRunner();
  const headingId = useId();
  const fieldId = useId();
  const helpId = useId();
  const countId = useId();
  const errorId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const current = text ?? '';
  const dirty = editing && draft.trim() !== current.trim();

  useEffect(() => {
    if (editing) field.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      opener.current?.focus();
    }
  }, [editing]);

  const submit = async (): Promise<boolean> => {
    const value = draft.trim();
    if (value.length === 0) {
      setError(uiMessage('plan.theme-editor.1847', { value0: noun }));
      field.current?.focus();
      return false;
    }
    if (value.length > themeTextLimit) {
      setError(
        uiMessage('alignment.object-forms.640', {
          value0: noun,
          value1: numberFormat.format(themeTextLimit),
        }),
      );
      field.current?.focus();
      return false;
    }
    setError(null);
    const saved = await runner.run(
      () => save(value),
      uiMessage('plan.theme-editor.1848', { value0: title }),
    );
    if (saved) {
      returnFocus.current = true;
      setEditing(false);
    }
    return saved;
  };
  const { dialog } = useUnsavedGuard(dirty, submit);

  const startEditing = (): void => {
    setDraft(current);
    setError(null);
    setEditing(true);
  };
  const cancel = (): void => {
    setError(null);
    returnFocus.current = true;
    setEditing(false);
  };

  return (
    <section className="theme-editor" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {editing ? (
        <form
          className="plan-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error !== null && (
            <p id={errorId} className="validation-summary" role="alert">
              {error}
            </p>
          )}
          <div>
            <label className="theme-field-label" htmlFor={fieldId}>
              {uiMessage('plan.theme-editor.1849', { value0: title, value1: periodLabel })}
            </label>
            <p id={helpId} className="field-help">
              {uiMessage('plan.theme-editor.1850')}
            </p>
          </div>
          <textarea
            id={fieldId}
            ref={field}
            rows={4}
            maxLength={themeTextLimit}
            value={draft}
            aria-invalid={error !== null}
            aria-describedby={[helpId, countId, ...(error === null ? [] : [errorId])].join(' ')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p id={countId} className="field-help">
            {uiMessage('alignment.project-detail.772', {
              value0: numberFormat.format(draft.length),
              value1: numberFormat.format(themeTextLimit),
            })}
          </p>
          <div className="theme-editor-actions">
            <button className="primary-button" type="submit" disabled={runner.busy}>
              {runner.busy
                ? uiMessage('account.conflicts-page.133')
                : uiMessage('plan.theme-editor.1851', { value0: noun })}
            </button>
            <button type="button" onClick={cancel} disabled={runner.busy}>
              {uiMessage('account.account-dialogs.20')}
            </button>
          </div>
        </form>
      ) : (
        <>
          {current.length > 0 ? (
            <p className="theme-text">{current}</p>
          ) : (
            <p className="field-help">
              {uiMessage('plan.theme-editor.1852', { value0: noun, value1: periodLabel })}
            </p>
          )}
          <div className="theme-editor-actions">
            <button ref={opener} type="button" onClick={startEditing} disabled={runner.busy}>
              {current.length > 0
                ? uiMessage('plan.capacity-settings.1190', { value0: noun })
                : uiMessage('plan.theme-editor.1853', { value0: noun })}
            </button>
            {current.length > 0 && (
              <button
                type="button"
                className="text-button"
                disabled={runner.busy}
                onClick={() =>
                  void runner.run(clear, uiMessage('plan.theme-editor.1854', { value0: title }))
                }
              >
                {uiMessage('plan.capacity-settings.1207', { value0: noun })}
              </button>
            )}
          </div>
        </>
      )}
      <CommandFeedback runner={runner} />
      {dialog}
    </section>
  );
}

/** A named horizon section with an h2 and optional help text. */
export function HorizonSection({
  children,
  help,
  title,
}: {
  readonly title: string;
  readonly help?: string;
  readonly children: ReactNode;
}): ReactNode {
  const headingId = useId();
  return (
    <section className="horizon-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {help !== undefined && <p className="field-help">{help}</p>}
      {children}
    </section>
  );
}

/* ───────────── Shared horizon text (neutral, read-only labels) ───────────── */

export function outcomeProgressText(progress: OutcomeProgressView): string {
  switch (progress.mode) {
    case 'none':
      return uiMessage('alignment.alignment-page.391');
    case 'manual':
      return uiMessage('alignment.alignment-page.392', { value0: String(progress.percentage) });
    case 'milestone_derived':
      return uiMessage('plan.theme-editor.1855', {
        value0: String(progress.completed),
        value1: String(progress.total),
        value2: progress.total === 1 ? '' : 's',
      });
  }
}

export function targetWindowText(start?: CalendarDate, end?: CalendarDate): string {
  if (start !== undefined && end !== undefined) {
    return start === end
      ? uiMessage('plan.theme-editor.1856', { value0: formatDate(end) })
      : uiMessage('plan.theme-editor.1857', { value0: formatDate(start), value1: formatDate(end) });
  }
  if (end !== undefined) return uiMessage('plan.theme-editor.1858', { value0: formatDate(end) });
  if (start !== undefined)
    return uiMessage('plan.theme-editor.1859', { value0: formatDate(start) });
  return uiMessage('plan.theme-editor.1860');
}

const outcomeStateLabels: Readonly<Record<OutcomeState, string>> = {
  active: uiMessage('alignment.object-forms.677'),
  paused: uiMessage('plan.routines.1533'),
  achieved: uiMessage('plan.theme-editor.1861'),
  abandoned: uiMessage('plan.theme-editor.1862'),
  archived: uiMessage('alignment.alignment-page.405'),
};
const milestoneStateLabels: Readonly<Record<MilestoneState, string>> = {
  active: uiMessage('alignment.object-forms.677'),
  completed: uiMessage('plan.plan-month.1324'),
  canceled: uiMessage('plan.theme-editor.1863'),
  archived: uiMessage('alignment.alignment-page.405'),
};
const projectStateLabels: Readonly<Record<ProjectState, string>> = {
  idea: uiMessage('alignment.object-forms.676'),
  active: uiMessage('alignment.object-forms.677'),
  blocked: uiMessage('plan.theme-editor.1864'),
  paused: uiMessage('plan.routines.1533'),
  completed: uiMessage('plan.plan-month.1324'),
  archived: uiMessage('alignment.alignment-page.405'),
};
const actionStateLabels: Readonly<Record<ActionState, string>> = {
  inbox: uiMessage('actions-ui.230'),
  planned: uiMessage('plan.routines.1537'),
  scheduled: uiMessage('plan.theme-editor.1865'),
  in_progress: uiMessage('plan.scheduling-dialogs.1621'),
  completed: uiMessage('plan.plan-month.1324'),
  canceled: uiMessage('plan.theme-editor.1863'),
  archived: uiMessage('alignment.alignment-page.405'),
};

export const outcomeStateLabel = (state: OutcomeState): string => outcomeStateLabels[state];
export const milestoneStateLabel = (state: MilestoneState): string => milestoneStateLabels[state];
export const projectStateLabel = (state: ProjectState): string => projectStateLabels[state];
export const actionStateLabel = (state: ActionState): string => actionStateLabels[state];

/** Plan horizon and a representative date that opens the given period. */
export function periodLocation(period: HorizonPeriod): {
  readonly horizon: PlanHorizon;
  readonly date: string;
} {
  switch (period.kind) {
    case 'day':
      return { horizon: 'day', date: period.date };
    case 'week':
      return { horizon: 'week', date: period.start };
    case 'month':
      return { horizon: 'month', date: `${period.month}-01` };
    case 'year':
      return { horizon: 'year', date: `${period.year}-01-01` };
  }
}
