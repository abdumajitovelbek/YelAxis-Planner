import { message as uiMessage } from '../messages';
/**
 * Choosing a day's focus: the focus draft editor (also used by End Day) and the
 * Choose focus dialog, plus the focus wording shared with the focus strip. Candidates are listed in
 * plan order and never ranked or preselected; only items already in the day's focus start checked.
 * The dialog saves the whole choice in one command with one Undo.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import type {
  FocusCandidate,
  FocusChoices,
  FocusItemView,
  FocusTargetInput,
  OccurrenceEntry,
  PlanProfile,
} from '@yelaxis/application';
import {
  dayFocusLimit,
  occurrencePeriodKey,
  type CalendarDate,
  type HorizonPeriod,
  type Instant,
} from '@yelaxis/domain';

import { formatDate, formatInstantTime, formatMonth, formatWeekRange } from '../plan/format';
import { Modal, autofocusIn, focusIsOnField, mayMoveAutofocus } from '../plan/modal';
import { occurrenceStatusText } from '../plan/occurrence-controls';
import { useTodayApplication, type CommandRunner } from '../plan/planning-context';
import { DialogError } from '../plan/timeline';

import './focus-mode.css';

/* ───────────────────────── Shared focus wording ───────────────────────── */

/** The title a focus item or candidate is known by. */
export function focusItemTitle(item: FocusItemView): string {
  return item.kind === 'action' ? item.action.title : item.routineTitle;
}

export function focusCandidateTitle(candidate: FocusCandidate): string {
  return candidate.kind === 'action'
    ? candidate.action.title
    : candidate.occurrence.ref.routineTitle;
}

/** "2:00 PM–3:00 PM" in the planning zone. */
export function blockTimeText(
  block: { readonly startsAt: Instant; readonly endsAt: Instant },
  profile: PlanProfile,
): string {
  const time = (value: Instant): string =>
    formatInstantTime(value, profile.planningTimeZone, profile.timeFormat);
  return `${time(block.startsAt)}–${time(block.endsAt)}`;
}

function periodText(period: HorizonPeriod, date: CalendarDate): string {
  switch (period.kind) {
    case 'day':
      return period.date === date
        ? uiMessage('plan.plan-day.1293')
        : uiMessage('today.choose-focus-dialog.2122', {
            value0: formatDate(period.date, 'weekday'),
          });
    case 'week':
      return period.start <= date && date <= period.end
        ? uiMessage('plan.plan-month.1315')
        : uiMessage('plan.plan-month.1314', { value0: formatWeekRange(period) });
    case 'month':
      return formatMonth(period.month);
    case 'year':
      return period.year;
  }
}

const finishedActionText = {
  completed: uiMessage('plan.plan-month.1324'),
  canceled: uiMessage('plan.theme-editor.1863'),
  archived: uiMessage('alignment.alignment-page.405'),
};

/** Why a Routine Occurrence item offers only Remove: it no longer projects on the date. */
export function staleOccurrenceText(
  item: Extract<FocusItemView, { kind: 'routine_occurrence' }>,
): string {
  return item.routineState === 'archived'
    ? uiMessage('today.choose-focus-dialog.2123')
    : uiMessage('today.choose-focus-dialog.2124');
}

function occurrenceText(entry: OccurrenceEntry, profile: PlanProfile): string {
  const status = occurrenceStatusText(entry);
  if (entry.timing.kind === 'timed' && entry.state === 'planned')
    return uiMessage('today.choose-focus-dialog.2125', {
      value0: blockTimeText(entry.timing, profile),
    });
  return uiMessage('today.choose-focus-dialog.2125', { value0: status });
}

/**
 * A focus item's state and timing in words: "Scheduled 2:00 PM–3:00 PM", "Flexible", "This week",
 * "Completed", or "Routine · Skipped". Color never carries it.
 */
export function focusItemStatus(
  item: FocusItemView,
  profile: PlanProfile,
  date: CalendarDate,
): string {
  if (item.kind === 'routine_occurrence')
    return item.occurrence === null
      ? staleOccurrenceText(item)
      : occurrenceText(item.occurrence, profile);
  const action = item.action;
  if (action.state === 'completed' || action.state === 'canceled' || action.state === 'archived')
    return finishedActionText[action.state];
  if (item.timing.kind === 'scheduled')
    return uiMessage('today.choose-focus-dialog.2126', {
      value0: blockTimeText(item.timing.block, profile),
    });
  if (item.timing.kind === 'flexible') return uiMessage('plan.plan-day.1293');
  if (action.state === 'scheduled') return uiMessage('today.choose-focus-dialog.2127');
  if (action.placement !== undefined) return periodText(action.placement.period, date);
  return action.state === 'inbox'
    ? uiMessage('actions-ui.230')
    : uiMessage('today.choose-focus-dialog.2128');
}

/** A focus candidate's timing in words, for its checkbox. */
export function focusCandidateDetail(candidate: FocusCandidate, profile: PlanProfile): string {
  if (candidate.kind === 'routine_occurrence') return occurrenceText(candidate.occurrence, profile);
  const progress =
    candidate.action.state === 'in_progress' ? uiMessage('today.choose-focus-dialog.2129') : '';
  switch (candidate.source) {
    case 'scheduled':
      return candidate.block === undefined
        ? `Scheduled${progress}`
        : uiMessage('today.choose-focus-dialog.2130', {
            value0: blockTimeText(candidate.block, profile),
            value1: progress,
          });
    case 'flexible':
      return `Flexible${progress}`;
    case 'week':
      return uiMessage('today.choose-focus-dialog.2131', { value0: progress });
  }
}

/**
 * Whether two focus inputs name the same target: the same Action, or the same Routine Occurrence
 * (Routine, generation, and period).
 */
export function sameFocusTarget(left: FocusTargetInput, right: FocusTargetInput): boolean {
  if (left.kind === 'action' || right.kind === 'action')
    return (
      left.kind === 'action' &&
      right.kind === 'action' &&
      left.actionId.toLowerCase() === right.actionId.toLowerCase()
    );
  const a = left.occurrence;
  const b = right.occurrence;
  return (
    a.routineId.toLowerCase() === b.routineId.toLowerCase() &&
    a.generation === b.generation &&
    occurrencePeriodKey(a.period) === occurrencePeriodKey(b.period)
  );
}

/* ───────────────────────── Keyboard focus after a change ───────────────────────── */

/**
 * Puts keyboard focus back on a list control after the list re-renders in a new order or loses a
 * row. The request names `data-focus-key` values in preference order; the first one present and
 * not `aria-disabled` wins. Focus is only moved while it is still inside `container` or went away
 * with a removed row, never pulled from a control the person moved to.
 */
export function useFocusReturn(container: RefObject<HTMLElement | null>): {
  readonly request: (keys: readonly string[], ready?: () => boolean) => void;
  readonly clear: () => void;
} {
  const pending = useRef<{
    readonly keys: readonly string[];
    readonly ready: () => boolean;
    readonly until: number;
  } | null>(null);
  useLayoutEffect(() => {
    const target = pending.current;
    if (target === null) return;
    if (Date.now() > target.until) {
      pending.current = null;
      return;
    }
    if (!target.ready()) return;
    pending.current = null;
    const active = document.activeElement;
    const root = container.current;
    if (root === null) return;
    if (!(active === null || active === document.body || root.contains(active))) return;
    for (const key of target.keys) {
      const element = root.querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
      if (element !== null && element.getAttribute('aria-disabled') !== 'true') {
        element.focus();
        return;
      }
    }
  });
  useEffect(() => {
    // A pointer press anywhere else means the person moved on: never pull focus back after it.
    const forget = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || container.current?.contains(event.target) !== true)
        pending.current = null;
    };
    document.addEventListener('pointerdown', forget, true);
    return () => document.removeEventListener('pointerdown', forget, true);
  }, [container]);
  return {
    request: (keys, ready = () => true) => {
      pending.current = { keys, ready, until: Date.now() + 5000 };
    },
    clear: () => {
      pending.current = null;
    },
  };
}

/* ───────────────────────── Focus draft editor ───────────────────────── */

/** One chosen item of a focus draft, in order. */
export interface FocusDraftItem {
  /** Stable key, for example the target's `FocusTargetKey`. */
  readonly key: string;
  readonly label: string;
  readonly target: FocusTargetInput;
}

export interface FocusDraftEditorProps {
  readonly choices: FocusChoices;
  /** The chosen items in order (at most three). */
  readonly value: readonly FocusDraftItem[];
  readonly onChange: (value: readonly FocusDraftItem[]) => void;
  /** Candidates not in `choices` yet (End Day: Actions carried or moved to the date). */
  readonly extraCandidates?: readonly FocusCandidate[];
  /** Prefix for element ids, so two editors never share one. */
  readonly idPrefix: string;
}

/** The draft item for a day's current focus item (kept even when finished or changed). */
export function focusDraftItem(item: FocusItemView): FocusDraftItem {
  return { key: item.key, label: focusItemTitle(item), target: item.target };
}

/** The draft of a date's current focus, in the person's order. */
export function focusDraftOf(choices: FocusChoices): readonly FocusDraftItem[] {
  return choices.current.map(focusDraftItem);
}

const candidateGroups = [
  { source: 'scheduled', legend: uiMessage('plan.theme-editor.1865') },
  { source: 'flexible', legend: uiMessage('plan.plan-day.1293') },
  { source: 'routine', legend: uiMessage('alignment.axis-detail.433') },
  { source: 'week', legend: uiMessage('plan.plan-month.1315') },
] as const;

export const focusLimitReason = uiMessage('today.choose-focus-dialog.2132');

/**
 * Choose up to three items and put them in order, without saving. Checkboxes are grouped in plan
 * order (Scheduled, Flexible, Routines, This week); the Order list moves or removes chosen items
 * with buttons. Items already chosen that are no longer candidates (finished, changed, or chosen
 * from elsewhere) appear only in the Order list, where they can be removed.
 */
export function FocusDraftEditor({
  choices,
  extraCandidates = [],
  idPrefix,
  onChange,
  value,
}: FocusDraftEditorProps): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const focusReturn = useFocusReturn(root);
  const latest = useRef(value);
  latest.current = value;
  /** Focus returns once the parent has rendered the changed draft. */
  const changedFrom = (before: readonly FocusDraftItem[]) => () => latest.current !== before;
  const orderHeadingId = `${idPrefix}-order-heading`;
  const limitId = `${idPrefix}-limit`;
  const seen = new Set<string>();
  const candidates = [...choices.candidates, ...extraCandidates].filter((candidate) => {
    if (seen.has(candidate.key)) return false;
    seen.add(candidate.key);
    return true;
  });
  const chosen = new Set(value.map((item) => item.key));
  const full = value.length >= dayFocusLimit;
  const details = new Map<string, string>();
  for (const candidate of candidates)
    details.set(candidate.key, focusCandidateDetail(candidate, choices.profile));
  for (const item of choices.current)
    details.set(item.key, focusItemStatus(item, choices.profile, choices.date));
  const weekShown = choices.candidates.filter((candidate) => candidate.source === 'week').length;

  const toggle = (candidate: FocusCandidate, checked: boolean): void => {
    if (checked) {
      if (chosen.has(candidate.key) || full) return;
      onChange([
        ...value,
        { key: candidate.key, label: focusCandidateTitle(candidate), target: candidate.target },
      ]);
    } else onChange(value.filter((item) => item.key !== candidate.key));
  };
  const move = (index: number, direction: 'up' | 'down'): void => {
    const other = direction === 'up' ? index - 1 : index + 1;
    const item = value[index];
    const neighbor = value[other];
    if (item === undefined || neighbor === undefined) return;
    const next = [...value];
    next[index] = neighbor;
    next[other] = item;
    // The same button again, or its sibling once the item reaches an end of the list.
    const opposite = direction === 'up' ? 'down' : 'up';
    focusReturn.request(
      [`${item.key}:${direction}`, `${item.key}:${opposite}`],
      changedFrom(value),
    );
    onChange(next);
  };
  const remove = (index: number): void => {
    const next = value.filter((_, position) => position !== index);
    const after = next[index] ?? next[index - 1];
    focusReturn.request(
      after === undefined ? ['order-empty'] : [`${after.key}:remove`],
      changedFrom(value),
    );
    onChange(next);
  };

  return (
    <div ref={root} className="focus-draft">
      {candidates.length === 0 ? (
        <p className="quiet-empty">{uiMessage('today.choose-focus-dialog.2133')}</p>
      ) : (
        candidateGroups.map(({ legend, source }) => {
          const group = candidates.filter((candidate) => candidate.source === source);
          if (group.length === 0) return null;
          return (
            <fieldset key={source} className="focus-choice-group">
              <legend>{legend}</legend>
              <ul className="focus-choice-list">
                {group.map((candidate) => {
                  const checked = chosen.has(candidate.key);
                  const blocked = !checked && full;
                  const id = `${idPrefix}-choice-${candidate.key}`;
                  const detailId = `${id}-detail`;
                  return (
                    <li key={candidate.key} className="focus-choice">
                      <label className="check-row" htmlFor={id}>
                        <input
                          id={id}
                          type="checkbox"
                          checked={checked}
                          aria-disabled={blocked ? true : undefined}
                          aria-describedby={blocked ? `${detailId} ${limitId}` : detailId}
                          onChange={(event) => toggle(candidate, event.target.checked)}
                        />
                        <span>{focusCandidateTitle(candidate)}</span>
                      </label>
                      <p id={detailId} className="field-help focus-choice-detail">
                        {details.get(candidate.key)}
                      </p>
                    </li>
                  );
                })}
              </ul>
              {source === 'week' && choices.weekTotal > weekShown && (
                <p className="field-help">
                  {uiMessage('today.choose-focus-dialog.2134', {
                    value0: String(weekShown),
                    value1: String(choices.weekTotal),
                  })}
                </p>
              )}
            </fieldset>
          );
        })
      )}
      <p className="focus-draft-count" aria-live="polite">
        {uiMessage('review.commitments-editor.1919', {
          value0: String(value.length),
          value1: String(dayFocusLimit),
        })}
      </p>
      {full && (
        <p id={limitId} className="field-help">
          {focusLimitReason}
        </p>
      )}
      <h3 id={orderHeadingId} className="focus-order-heading">
        {uiMessage('today.choose-focus-dialog.2135')}
      </h3>
      {value.length === 0 ? (
        <p className="quiet-empty" data-focus-key="order-empty" tabIndex={-1}>
          {uiMessage('today.choose-focus-dialog.2136')}
        </p>
      ) : (
        <ol className="focus-order" aria-labelledby={orderHeadingId}>
          {value.map((item, index) => (
            <li key={item.key} className="focus-order-item">
              <span className="focus-position" aria-hidden="true">
                {index + 1}
              </span>
              <div className="focus-order-main">
                <p className="focus-order-title">{item.label}</p>
                {details.has(item.key) && (
                  <p className="field-help focus-order-detail">{details.get(item.key)}</p>
                )}
                <div className="control-row">
                  <button
                    type="button"
                    data-focus-key={`${item.key}:up`}
                    aria-label={uiMessage('actions-ui.266', { value0: item.label })}
                    aria-disabled={index === 0 ? true : undefined}
                    onClick={() => {
                      if (index > 0) move(index, 'up');
                    }}
                  >
                    {uiMessage('review.commitments-editor.1922')}
                  </button>
                  <button
                    type="button"
                    data-focus-key={`${item.key}:down`}
                    aria-label={uiMessage('actions-ui.267', { value0: item.label })}
                    aria-disabled={index === value.length - 1 ? true : undefined}
                    onClick={() => {
                      if (index < value.length - 1) move(index, 'down');
                    }}
                  >
                    {uiMessage('review.commitments-editor.1923')}
                  </button>
                  <button
                    type="button"
                    data-focus-key={`${item.key}:remove`}
                    onClick={() => remove(index)}
                  >
                    {uiMessage('plan.plan-week.1373')}
                    <span className="sr-only">{item.label}</span>
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ───────────────────────── Choose focus dialog ───────────────────────── */

export interface ChooseFocusDialogProps {
  readonly open: boolean;
  /** The date whose focus is chosen; the dialog loads its own choices. */
  readonly date: CalendarDate;
  readonly runner: CommandRunner;
  readonly onClose: () => void;
}

/**
 * Choose a date's focus (at most three) and its order, saved in one command. An open dialog keeps
 * the date it opened with: when the live page rolls over to a new day, the title,
 * the loaded choices, the person's draft, and Save all stay on that date.
 */
export function ChooseFocusDialog({
  date,
  onClose,
  open,
  runner,
}: ChooseFocusDialogProps): ReactNode {
  const [openedFor, setOpenedFor] = useState<CalendarDate | null>(open ? date : null);
  if (open && openedFor === null) setOpenedFor(date);
  else if (!open && openedFor !== null) setOpenedFor(null);
  const shown = open ? (openedFor ?? date) : date;
  const close = (): void => {
    runner.clearError();
    onClose();
  };
  return (
    <Modal
      open={open}
      className="focus-dialog"
      eyebrow={uiMessage('review.saved-review.2021')}
      title={uiMessage('today.choose-focus-dialog.2137', { value0: formatDate(shown, 'long') })}
      description={uiMessage('today.choose-focus-dialog.2138')}
      onClose={close}
    >
      {open && <ChooseFocusBody date={shown} runner={runner} onClose={close} onDone={onClose} />}
    </Modal>
  );
}

type ChoicesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly choices: FocusChoices }
  | { readonly status: 'error' };

function ChooseFocusBody({
  date,
  onClose,
  onDone,
  runner,
}: {
  readonly date: CalendarDate;
  readonly runner: CommandRunner;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const today = useTodayApplication();
  const idPrefix = useId();
  const container = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ChoicesState>({ status: 'loading' });
  const [draft, setDraft] = useState<readonly FocusDraftItem[]>([]);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    today.getFocusChoices(date).then(
      (choices) => {
        if (!live) return;
        setDraft(focusDraftOf(choices));
        setState({ status: 'ready', choices });
      },
      () => {
        if (live) setState({ status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [today, date, attempt]);
  useEffect(() => {
    // The choices load after the dialog opened: move focus to the first choice once, unless the
    // person has already moved it.
    if (state.status === 'loading') return;
    const element = container.current;
    const dialog = element?.closest('dialog');
    if (element === null || dialog === null || dialog === undefined) return;
    if (!mayMoveAutofocus(dialog) || focusIsOnField(dialog)) return;
    autofocusIn(
      dialog,
      element.querySelector<HTMLElement>('[data-autofocus]') ??
        element.querySelector<HTMLElement>('input'),
    );
  }, [state.status]);

  if (state.status === 'loading')
    return (
      <div ref={container} aria-busy="true">
        <p role="status">{uiMessage('today.choose-focus-dialog.2139')}</p>
      </div>
    );
  if (state.status === 'error')
    return (
      <div ref={container}>
        <p className="validation-summary" role="alert">
          {uiMessage('today.choose-focus-dialog.2140')}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {uiMessage('actions-ui.221')}
          </button>
          <button type="button" data-autofocus onClick={() => setAttempt((value) => value + 1)}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      </div>
    );
  const choices = state.choices;
  if (!choices.editable)
    return (
      <div ref={container}>
        <p>{uiMessage('today.choose-focus-dialog.2141')}</p>
        <div className="dialog-actions">
          <button type="button" data-autofocus onClick={onClose}>
            {uiMessage('actions-ui.221')}
          </button>
        </div>
      </div>
    );
  const unchanged =
    draft.length === choices.current.length &&
    draft.every((item, index) => item.key === choices.current[index]?.key);
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (runner.busy) return;
    if (unchanged) {
      onDone();
      return;
    }
    const saved = await runner.run(
      () => today.setDayFocus({ date, items: draft.map((item) => item.target) }),
      uiMessage('today.choose-focus-dialog.2142', { value0: formatDate(date, 'long') }),
    );
    if (saved) onDone();
  };
  return (
    <div ref={container}>
      <form noValidate onSubmit={(event) => void save(event)}>
        <DialogError runner={runner} />
        <FocusDraftEditor
          choices={choices}
          value={draft}
          onChange={setDraft}
          idPrefix={`${idPrefix}focus`}
        />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {uiMessage('account.account-dialogs.20')}
          </button>
          <button
            type="submit"
            className="primary-button"
            aria-disabled={runner.busy ? true : undefined}
          >
            {runner.busy
              ? uiMessage('account.conflicts-page.133')
              : uiMessage('today.choose-focus-dialog.2143')}
          </button>
        </div>
      </form>
    </div>
  );
}
