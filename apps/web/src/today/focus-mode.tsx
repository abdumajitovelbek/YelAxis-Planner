import { message as uiMessage } from '../messages';
/**
 * Focus mode (`/focus/:actionId`,): one Action with its context, an optional
 * timer, Complete, and Exit. Nothing here changes the plan except the explicit Complete, which uses
 * the same commands as elsewhere and offers Undo. There is no Start (in progress) command, and no
 * lock-in: no fullscreen, wake lock, leave prompt, notification, sound, or Escape shortcut. Exit
 * never asks and never records anything.
 */
import {
  useId,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import type { ActionSummary, BlockRow, FocusSessionView, PlanProfile } from '@yelaxis/application';
import { isFocusableActionState, type ActionState, type DueValue } from '@yelaxis/domain';

import { formatDate, formatDuration, formatInstantTime } from '../plan/format';
import { Modal } from '../plan/modal';
import {
  useActionsApplication,
  useCommandRunner,
  usePlanQuery,
  usePlanning,
  useTodayApplication,
  type CommandRunner,
} from '../plan/planning-context';
import { actionPath, focusPath } from '../plan/routes';
import { DialogError, ViewFeedback, dateInZone, useFocusRescue } from '../plan/timeline';
import { blockTimeText } from './choose-focus-dialog';
import { useClock } from './clock-context';
import type { FocusModeLinkState } from './focus-strip';
import {
  customTimerMinutes,
  initialTimerState,
  minutesMs,
  parseCustomMinutes,
  timerReading,
  timerReducer,
  timerStatusText,
  useTimerNow,
  type TimerAction,
  type TimerState,
} from './focus-timer';

import './focus-mode.css';

/** True when Focus mode was opened from a page in this app (it can go back to it). */
export function isFocusModeLinkState(state: unknown): state is FocusModeLinkState {
  if (typeof state !== 'object' || state === null) return false;
  const returnTo = (state as { readonly returnTo?: unknown }).returnTo;
  return typeof returnTo === 'string' && returnTo.startsWith('/');
}

/** Focus mode for one Action; the timer resets when another Action opens. */
export function FocusPage(): ReactNode {
  const { actionId = '' } = useParams();
  return <FocusSession key={actionId} actionId={actionId} />;
}

function FocusSession({ actionId }: { readonly actionId: string }): ReactNode {
  const today = useTodayApplication();
  const runner = useCommandRunner();
  const heading = useRef<HTMLHeadingElement>(null);
  const { reload, state } = usePlanQuery(() => today.getFocusSession(actionId), [actionId]);
  useFocusRescue(heading, runner, state.status === 'ready' ? state.data : null);
  // Presentation state only, kept here so a Complete and its Undo do not lose the timer.
  const [timer, dispatch] = useReducer(timerReducer, initialTimerState);

  if (state.status === 'loading')
    return (
      <section className="content-section focus-mode" aria-busy="true" aria-labelledby="page-title">
        <p className="eyebrow">{uiMessage('review.saved-review.2021')}</p>
        <h1 id="page-title" ref={heading} tabIndex={-1}>
          {uiMessage('today.focus-mode.2224')}
        </h1>
      </section>
    );
  if (state.status === 'error')
    return (
      <section className="content-section focus-mode" aria-labelledby="page-title">
        <p className="eyebrow">{uiMessage('review.saved-review.2021')}</p>
        <h1 id="page-title" ref={heading} tabIndex={-1}>
          {uiMessage('today.focus-mode.2225')}
        </h1>
        <p className="validation-summary" role="alert">
          {uiMessage('today.focus-mode.2226')}
        </p>
        <div className="focus-page-actions">
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
          <Link className="inline-button" to="/">
            {uiMessage('today.end-day.2162')}
          </Link>
        </div>
      </section>
    );
  const session = state.data;
  if (session === null)
    return (
      <section className="content-section focus-mode" aria-labelledby="page-title">
        <p className="eyebrow">{uiMessage('review.saved-review.2021')}</p>
        <h1 id="page-title" ref={heading} tabIndex={-1}>
          {uiMessage('today.focus-mode.2227')}
        </h1>
        <p className="page-message">{uiMessage('alignment.alignment-page.389')}</p>
        <Link className="inline-button" to="/">
          {uiMessage('today.end-day.2162')}
        </Link>
      </section>
    );
  return (
    <FocusView
      dispatch={dispatch}
      heading={heading}
      runner={runner}
      session={session}
      timer={timer}
    />
  );
}

/* ───────────────────────── The page ───────────────────────── */

const actionStateText: Record<ActionState, string> = {
  inbox: uiMessage('actions-ui.230'),
  planned: uiMessage('plan.routines.1537'),
  scheduled: uiMessage('plan.theme-editor.1865'),
  in_progress: uiMessage('plan.scheduling-dialogs.1621'),
  completed: uiMessage('plan.plan-month.1324'),
  canceled: uiMessage('plan.theme-editor.1863'),
  archived: uiMessage('alignment.alignment-page.405'),
};

function dueText(due: DueValue, overdue: boolean, profile: PlanProfile): string {
  const when =
    due.kind === 'date'
      ? formatDate(due.date, 'long')
      : `${formatDate(dateInZone(due.instant, due.authoredTimeZone), 'long')}, ${formatInstantTime(
          due.instant,
          due.authoredTimeZone,
          profile.timeFormat,
        )}`;
  return overdue ? uiMessage('today.focus-mode.2228', { value0: when }) : when;
}

function plannedTimeText(block: BlockRow, session: FocusSessionView): string {
  const date = dateInZone(block.startsAt, session.profile.planningTimeZone);
  const day = date === session.today ? uiMessage('app.782') : formatDate(date, 'long');
  return `${day}, ${blockTimeText(block, session.profile)}`;
}

function FocusFacts({ session }: { readonly session: FocusSessionView }): ReactNode {
  const action = session.action;
  const facts: { readonly term: string; readonly value: string }[] = [
    { term: uiMessage('alignment.alignment-page.404'), value: actionStateText[action.state] },
    ...(action.projectTitle === undefined
      ? []
      : [{ term: uiMessage('actions-ui.254'), value: action.projectTitle }]),
    ...(action.axisTitle === undefined
      ? []
      : [{ term: uiMessage('actions-ui.251'), value: action.axisTitle }]),
    ...(action.estimateMinutes === undefined
      ? []
      : [{ term: uiMessage('plan.routines.1605'), value: formatDuration(action.estimateMinutes) }]),
    ...(action.due === undefined
      ? []
      : [
          {
            term: uiMessage('today.focus-mode.2229'),
            value: dueText(action.due, session.overdue, session.profile),
          },
        ]),
    ...(session.plannedBlock === undefined
      ? []
      : [
          {
            term: uiMessage('today.focus-mode.2230'),
            value: plannedTimeText(session.plannedBlock, session),
          },
        ]),
    ...(action.note === undefined || action.note.trim() === ''
      ? []
      : [{ term: uiMessage('plan.routines.1606'), value: action.note }]),
  ];
  return (
    <dl className="focus-facts">
      {facts.map((fact) => (
        <div key={fact.term}>
          <dt>{fact.term}</dt>
          <dd className={fact.term === 'Note' ? 'focus-note' : undefined}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function FocusView({
  dispatch,
  heading,
  runner,
  session,
  timer,
}: {
  readonly dispatch: Dispatch<TimerAction>;
  readonly heading: RefObject<HTMLHeadingElement | null>;
  readonly runner: CommandRunner;
  readonly session: FocusSessionView;
  readonly timer: TimerState;
}): ReactNode {
  const actions = useActionsApplication();
  const navigate = useNavigate();
  const location = useLocation();
  const [completing, setCompleting] = useState(false);
  const action = session.action;
  const unfinished = isFocusableActionState(action.state);
  const next = session.todayFocus?.next;
  const linkState: FocusModeLinkState | null = isFocusModeLinkState(location.state)
    ? location.state
    : null;
  const inApp = linkState !== null;
  const exit = (): void => {
    // Back to the view that opened Focus mode (its date and scroll), or to Today for a direct link.
    if (inApp) void navigate(-1);
    else void navigate('/');
  };
  const nextLink =
    next === undefined ? null : (
      <Link to={focusPath(next.actionId)} replace state={linkState}>
        {uiMessage('today.focus-mode.2231')}
        {next.title}
      </Link>
    );
  const completeOnly = (): Promise<boolean> =>
    runner.run(
      () => actions.transition(action.id, action.localRevision, 'completed'),
      uiMessage('today.end-day.2156', { value0: action.title }),
      { undo: (undoId) => actions.undo(undoId) },
    );

  return (
    <section className="content-section focus-mode" aria-labelledby="page-title">
      <p className="eyebrow">{uiMessage('review.saved-review.2021')}</p>
      <h1 id="page-title" ref={heading} tabIndex={-1}>
        {action.title}
      </h1>
      <ViewFeedback runner={runner} showError={!completing} />
      {!unfinished ? (
        <>
          <p className="page-message">
            {uiMessage('today.focus-mode.2232', {
              value0: actionStateText[action.state].toLowerCase(),
            })}
          </p>
          {nextLink !== null && <p className="focus-links">{nextLink}</p>}
          <div className="focus-page-actions">
            <Link className="inline-button" to={actionPath(action.id)}>
              {uiMessage('today.focus-mode.2233')}
            </Link>
            {/* Completed here (opened in the app): Exit still returns to the opening view. */}
            {inApp ? (
              <button type="button" onClick={exit}>
                {uiMessage('today.focus-mode.2234')}
              </button>
            ) : (
              <Link className="inline-button" to="/">
                {uiMessage('today.end-day.2162')}
              </Link>
            )}
          </div>
        </>
      ) : (
        <>
          <FocusFacts session={session} />
          <p className="focus-links">
            <Link to={actionPath(action.id)}>{uiMessage('today.focus-mode.2233')}</Link>
            {nextLink}
          </p>
          <FocusTimer action={action} dispatch={dispatch} state={timer} />
          <div className="focus-page-actions">
            <button
              type="button"
              className="primary-button"
              aria-disabled={runner.busy ? true : undefined}
              onClick={() => {
                if (runner.busy) return;
                if (session.plannedBlock === undefined) void completeOnly();
                else setCompleting(true);
              }}
            >
              {session.plannedBlock === undefined
                ? uiMessage('actions-ui.257')
                : uiMessage('today.focus-mode.2235')}
            </button>
            <button type="button" onClick={exit}>
              {uiMessage('today.focus-mode.2234')}
            </button>
          </div>
          {session.plannedBlock !== undefined && (
            <CompleteFocusDialog
              block={session.plannedBlock}
              completeOnly={completeOnly}
              onClose={() => {
                runner.clearError();
                setCompleting(false);
              }}
              open={completing}
              runner={runner}
              session={session}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * Complete an Action that has a planned time block: both together, or the Action only (the block
 * stays planned). The consequence of each choice is stated before it is made.
 */
function CompleteFocusDialog({
  block,
  completeOnly,
  onClose,
  open,
  runner,
  session,
}: {
  readonly block: BlockRow;
  readonly completeOnly: () => Promise<boolean>;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly runner: CommandRunner;
  readonly session: FocusSessionView;
}): ReactNode {
  const planning = usePlanning();
  const bothId = useId();
  const onlyId = useId();
  const title = session.action.title;
  const finish = (saved: boolean): void => {
    if (saved) onClose();
  };
  return (
    <Modal
      open={open}
      eyebrow={uiMessage('actions-ui.257')}
      title={uiMessage('today.focus-mode.2236', { value0: title })}
      onClose={onClose}
    >
      <DialogError runner={runner} />
      <p>{uiMessage('today.focus-mode.2237', { value0: plannedTimeText(block, session) })}</p>
      <div className="focus-complete-choices">
        <div>
          <button
            type="button"
            className="primary-button"
            data-autofocus
            aria-describedby={bothId}
            aria-disabled={runner.busy ? true : undefined}
            onClick={() => {
              if (runner.busy) return;
              void runner
                .run(
                  () =>
                    planning.setBlockState({
                      blockId: block.id,
                      revision: block.localRevision,
                      to: 'completed',
                      alsoCompleteAction: true,
                    }),
                  uiMessage('today.focus-mode.2238', { value0: title }),
                )
                .then(finish);
            }}
          >
            {uiMessage('today.focus-mode.2239')}
          </button>
          <p id={bothId} className="field-help">
            {uiMessage('today.focus-mode.2240')}
          </p>
        </div>
        <div>
          <button
            type="button"
            aria-describedby={onlyId}
            aria-disabled={runner.busy ? true : undefined}
            onClick={() => {
              if (!runner.busy) void completeOnly().then(finish);
            }}
          >
            {uiMessage('today.focus-mode.2241')}
          </button>
          <p id={onlyId} className="field-help">
            {uiMessage('today.focus-mode.2242')}
          </p>
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {uiMessage('account.account-dialogs.20')}
        </button>
      </div>
    </Modal>
  );
}

/* ───────────────────────── Timer ───────────────────────── */

type TimerPreset = '15' | '25' | '50' | 'estimate' | 'none' | 'custom';

const fixedPresets: readonly { readonly value: TimerPreset; readonly minutes: number }[] = [
  { value: '15', minutes: 15 },
  { value: '25', minutes: 25 },
  { value: '50', minutes: 50 },
];

/**
 * The optional timer: presets or count-up, Pause, Resume, Reset, and Add 5 minutes. It lives only
 * in this page's memory and never changes the plan. The reading is not a live region; the status
 * line says each change once (started, paused, resumed, reset, time up).
 */
function FocusTimer({
  action,
  dispatch,
  state,
}: {
  readonly action: ActionSummary;
  readonly dispatch: Dispatch<TimerAction>;
  readonly state: TimerState;
}): ReactNode {
  const now = useClock();
  const drawnAt = useTimerNow(state, now);
  const headingId = useId();
  const customId = useId();
  const customHelpId = useId();
  const customErrorId = useId();
  const [preset, setPreset] = useState<TimerPreset>('25');
  const [custom, setCustom] = useState('');
  const [customError, setCustomError] = useState(false);
  // Every press replaces the status text node, so a repeated message ("5 minutes added." twice) is
  // still said once per press, like the runner's announcement.
  const [presses, setPresses] = useState(0);
  const apply = (action: TimerAction): void => {
    dispatch(action);
    setPresses((count) => count + 1);
  };
  const primary = useRef<HTMLButtonElement>(null);
  const customInput = useRef<HTMLInputElement>(null);
  const estimate =
    action.estimateMinutes !== undefined &&
    Number.isInteger(action.estimateMinutes) &&
    action.estimateMinutes >= customTimerMinutes.min &&
    action.estimateMinutes <= customTimerMinutes.max
      ? action.estimateMinutes
      : null;
  const choice = preset === 'estimate' && estimate === null ? '25' : preset;
  /** The chosen length: ms, null for no limit, or undefined for a custom length not set yet. */
  const chosenLimit = (): number | null | undefined => {
    switch (choice) {
      case '15':
      case '25':
      case '50':
        return minutesMs(Number(choice));
      case 'estimate':
        return estimate === null ? undefined : minutesMs(estimate);
      case 'none':
        return null;
      case 'custom': {
        const minutes = parseCustomMinutes(custom);
        return minutes === null ? undefined : minutesMs(minutes);
      }
    }
  };
  const idleLimit = chosenLimit();
  const reading = timerReading(state, drawnAt, idleLimit ?? null);
  const status = timerStatusText(state, reading);
  const limited = state.status === 'idle' ? idleLimit !== null : state.limitMs !== null;
  const shown =
    state.status === 'idle' && idleLimit === undefined
      ? uiMessage('today.focus-mode.2243')
      : reading.text;

  const press = (): void => {
    const at = now();
    if (state.status === 'running') apply({ type: 'pause', at });
    else if (state.status === 'paused') apply({ type: 'resume', at });
    else if (idleLimit === undefined) {
      setCustomError(true);
      customInput.current?.focus();
    } else {
      setCustomError(false);
      apply({ type: 'start', at, limitMs: idleLimit });
    }
  };
  const options: readonly { readonly value: TimerPreset; readonly label: string }[] = [
    ...fixedPresets.map(({ minutes, value }) => ({
      value,
      label: uiMessage('today.focus-mode.2244', { value0: String(minutes) }),
    })),
    ...(estimate === null
      ? []
      : [
          {
            value: 'estimate' as const,
            label: uiMessage('today.focus-mode.2245', { value0: String(estimate) }),
          },
        ]),
    { value: 'none', label: uiMessage('today.focus-mode.2246') },
    { value: 'custom', label: uiMessage('today.focus-mode.2247') },
  ];

  return (
    <section className="focus-timer" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('today.focus-mode.2248')}</h2>
      <p className="field-help">{uiMessage('today.focus-mode.2249')}</p>
      <fieldset className="timer-presets" disabled={state.status !== 'idle'}>
        <legend>{uiMessage('today.focus-mode.2250')}</legend>
        <div className="timer-options">
          {options.map((option) => (
            <label key={option.value} className="radio-option">
              <input
                type="radio"
                name={`${headingId}-length`}
                value={option.value}
                checked={choice === option.value}
                onChange={() => {
                  setPreset(option.value);
                  setCustomError(false);
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {choice === 'custom' && (
          <div className="timer-custom">
            <label htmlFor={customId}>{uiMessage('today.focus-mode.2251')}</label>
            <input
              ref={customInput}
              id={customId}
              type="number"
              inputMode="numeric"
              min={customTimerMinutes.min}
              max={customTimerMinutes.max}
              step={1}
              value={custom}
              aria-invalid={customError ? true : undefined}
              aria-describedby={customError ? `${customHelpId} ${customErrorId}` : customHelpId}
              onChange={(event) => {
                setCustom(event.target.value);
                setCustomError(false);
              }}
            />
            <p id={customHelpId} className="field-help">
              {uiMessage('today.focus-mode.2252')}
            </p>
            {customError && (
              <p id={customErrorId} className="validation-summary" role="alert">
                {uiMessage('today.focus-mode.2253')}
              </p>
            )}
          </div>
        )}
        {state.status !== 'idle' && (
          <p className="field-help">{uiMessage('today.focus-mode.2254')}</p>
        )}
      </fieldset>
      <p role="timer" className="timer-reading">
        {shown}
      </p>
      <p className="timer-status" aria-live="polite">
        {status === '' ? null : <span key={presses}>{status}</span>}
      </p>
      <div className="control-row timer-controls">
        <button ref={primary} type="button" onClick={press}>
          {state.status === 'idle'
            ? uiMessage('today.focus-mode.2255')
            : state.status === 'running'
              ? uiMessage('today.focus-mode.2256')
              : uiMessage('today.focus-mode.2257')}
        </button>
        {state.status !== 'idle' && (
          <button
            type="button"
            onClick={() => {
              apply({ type: 'reset', at: now() });
              // Reset leaves; the Start button keeps the place.
              primary.current?.focus();
            }}
          >
            {uiMessage('today.focus-mode.2258')}
          </button>
        )}
        {state.status !== 'idle' && limited && (
          <button type="button" onClick={() => apply({ type: 'extend', at: now() })}>
            {uiMessage('today.focus-mode.2259')}
          </button>
        )}
      </div>
    </section>
  );
}
