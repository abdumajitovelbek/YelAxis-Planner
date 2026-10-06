import { message as uiMessage } from '../messages';
/**
 * Today's focus strip: the date's focus of at most three items in the person's own
 * order, the Add to focus button used beside Today's items, and (re-exported) the Choose focus
 * dialog and the focus draft editor that End Day reuses. Nothing is ranked, suggested, or chosen
 * for the person; finished or changed items stay until they are removed. Every change is one
 * command with Undo, and every state is said in words.
 */
import { useId, useRef, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import type { FocusItemView, FocusTargetInput, TodayView } from '@yelaxis/application';
import { dayFocusLimit, isFocusableActionState, type CalendarDate } from '@yelaxis/domain';

import { formatDate } from '../plan/format';
import { occurrenceTarget } from '../plan/occurrence-controls';
import {
  useActionsApplication,
  usePlanning,
  useTodayApplication,
  type CommandRunner,
} from '../plan/planning-context';
import { actionPath, focusPath, routinePath } from '../plan/routes';
import { isBlockEntry, type RequestDialog } from '../plan/scheduling-dialogs';
import {
  focusItemStatus,
  focusItemTitle,
  sameFocusTarget,
  useFocusReturn,
} from './choose-focus-dialog';

import './focus-mode.css';

export {
  ChooseFocusDialog,
  FocusDraftEditor,
  focusDraftItem,
  focusDraftOf,
} from './choose-focus-dialog';
export type {
  ChooseFocusDialogProps,
  FocusDraftEditorProps,
  FocusDraftItem,
} from './choose-focus-dialog';

/**
 * Navigation state of a Focus mode link opened from inside the app. Exit focus goes back in
 * history when it is present, and to Today otherwise.
 */
export interface FocusModeLinkState {
  readonly returnTo: string;
}

/**
 * "Focus mode" for one Action. It remembers the view it was opened from (path and selected date),
 * so Exit focus can go back to it; Today's other Focus mode entry points can use it too.
 */
export function FocusModeLink({
  actionId,
  className,
  title,
}: {
  readonly actionId: string;
  readonly title: string;
  readonly className?: string;
}): ReactNode {
  const location = useLocation();
  const state: FocusModeLinkState = { returnTo: `${location.pathname}${location.search}` };
  return (
    <Link
      to={focusPath(actionId)}
      state={state}
      {...(className === undefined ? {} : { className })}
    >
      {uiMessage('today.focus-strip.2260')}
      <span className="sr-only">
        {uiMessage('plan.occurrence-controls.1235')}
        {title}
      </span>
    </Link>
  );
}

/* ───────────────────────── Focus strip ───────────────────────── */

export interface FocusStripProps {
  readonly view: TodayView;
  /** The page's shared runner (one polite live region, one Undo). */
  readonly runner: CommandRunner;
  /** Opens the shared planning dialogs (for example Complete for a scheduled focus Action). */
  readonly onRequest: RequestDialog;
  /** Opens the Choose focus dialog. */
  readonly onChoose: () => void;
}

/** The date's focus (at most three) in the person's order. */
export function FocusStrip({ onChoose, onRequest, runner, view }: FocusStripProps): ReactNode {
  const today = useTodayApplication();
  const headingId = useId();
  const root = useRef<HTMLElement>(null);
  const focusReturn = useFocusReturn(root);
  const latest = useRef(view.focus);
  latest.current = view.focus;
  const items = view.focus;
  const editable = view.focusEditable;

  const move = (item: FocusItemView, index: number, direction: 'up' | 'down'): void => {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (runner.busy || target < 0 || target >= items.length) return;
    const opposite = direction === 'up' ? 'down' : 'up';
    focusReturn.request(
      [`${item.key}:${direction}`, `${item.key}:${opposite}`],
      () => latest.current.findIndex((row) => row.key === item.key) === target,
    );
    void runner
      .run(
        () =>
          today.reorderFocus({
            selectionId: item.selectionId,
            revision: item.localRevision,
            direction,
          }),
        uiMessage('today.flexible-list.2217', {
          value0: focusItemTitle(item),
          value1: String(target + 1),
          value2: String(items.length),
        }),
      )
      .then((saved) => {
        if (!saved) focusReturn.clear();
      });
  };

  return (
    <section ref={root} className="focus-strip" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('review.saved-review.2021')}</h2>
      <p className="field-help">{uiMessage('today.focus-strip.2261')}</p>
      {!editable && <p className="field-help">{uiMessage('today.choose-focus-dialog.2141')}</p>}
      {items.length === 0 ? (
        <p className="quiet-empty">{uiMessage('today.choose-focus-dialog.2136')}</p>
      ) : (
        <ol
          className="focus-list"
          aria-label={uiMessage('review.weekly-review.2030', {
            value0: formatDate(view.date, 'long'),
          })}
        >
          {items.map((item, index) => (
            <FocusRow
              key={item.selectionId}
              editable={editable}
              index={index}
              item={item}
              onMove={(direction) => move(item, index, direction)}
              onRequest={onRequest}
              runner={runner}
              total={items.length}
              view={view}
            />
          ))}
        </ol>
      )}
      {editable && (
        <button type="button" className="focus-choose" onClick={onChoose}>
          {uiMessage('today.focus-strip.2262')}
        </button>
      )}
    </section>
  );
}

function FocusRow({
  editable,
  index,
  item,
  onMove,
  onRequest,
  runner,
  total,
  view,
}: {
  readonly editable: boolean;
  readonly index: number;
  readonly item: FocusItemView;
  readonly onMove: (direction: 'up' | 'down') => void;
  readonly onRequest: RequestDialog;
  readonly runner: CommandRunner;
  readonly total: number;
  readonly view: TodayView;
}): ReactNode {
  const today = useTodayApplication();
  const title = focusItemTitle(item);
  const context = (
    <>
      {' '}
      <span className="sr-only">{title}</span>
    </>
  );
  const busy = runner.busy ? true : undefined;
  const unfinishedAction = item.kind === 'action' && isFocusableActionState(item.action.state);
  const stale = item.kind === 'routine_occurrence' && item.occurrence === null;
  return (
    <li className="focus-item">
      <span className="focus-position" aria-hidden="true">
        {index + 1}
      </span>
      <div className="focus-item-main">
        <p className="focus-item-title">
          <Link
            to={item.kind === 'action' ? actionPath(item.action.id) : routinePath(item.routineId)}
          >
            {title}
          </Link>
        </p>
        <p className="focus-item-meta">
          <span className="status-pill focus-state">
            {focusItemStatus(item, view.profile, view.date)}
          </span>
          {item.kind === 'action' && item.action.state === 'in_progress' && (
            <span className="field-help">{uiMessage('plan.scheduling-dialogs.1621')}</span>
          )}
          {stale && <span className="field-help">{uiMessage('today.focus-strip.2263')}</span>}
        </p>
        <div className="control-row">
          {unfinishedAction && <FocusModeLink actionId={item.action.id} title={title} />}
          {editable && !stale && (
            <CompleteFocusItem item={item} onRequest={onRequest} runner={runner} view={view} />
          )}
          {editable && total > 1 && (
            <>
              <button
                type="button"
                data-focus-key={`${item.key}:up`}
                aria-label={uiMessage('actions-ui.266', { value0: title })}
                aria-disabled={index === 0 || runner.busy ? true : undefined}
                onClick={() => {
                  if (index > 0) onMove('up');
                }}
              >
                {uiMessage('review.commitments-editor.1922')}
              </button>
              <button
                type="button"
                data-focus-key={`${item.key}:down`}
                aria-label={uiMessage('actions-ui.267', { value0: title })}
                aria-disabled={index === total - 1 || runner.busy ? true : undefined}
                onClick={() => {
                  if (index < total - 1) onMove('down');
                }}
              >
                {uiMessage('review.commitments-editor.1923')}
              </button>
            </>
          )}
          {editable && (
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => {
                if (runner.busy) return;
                void runner.run(
                  () =>
                    today.removeFocus({
                      selectionId: item.selectionId,
                      revision: item.localRevision,
                    }),
                  uiMessage('today.focus-strip.2264', { value0: title }),
                );
              }}
            >
              {uiMessage('today.focus-strip.2265')}
              {context}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Complete for a focus item, through the same commands as elsewhere: a scheduled Action opens the
 * planning time block dialog; a flexible Action completes with the Actions undo; a Routine Occurrence
 * completes (or logs one for a weekly count). An Action with a planned time on another day is
 * completed from Focus mode, which states what happens to that time.
 */
function CompleteFocusItem({
  item,
  onRequest,
  runner,
  view,
}: {
  readonly item: FocusItemView;
  readonly onRequest: RequestDialog;
  readonly runner: CommandRunner;
  readonly view: TodayView;
}): ReactNode {
  const actions = useActionsApplication();
  const planning = usePlanning();
  const title = focusItemTitle(item);
  const context = (
    <>
      {' '}
      <span className="sr-only">{title}</span>
    </>
  );
  const busy = runner.busy ? true : undefined;
  const run = (operation: () => ReturnType<CommandRunner['run']>): void => {
    if (!runner.busy) void operation();
  };
  if (item.kind === 'action') {
    const action = item.action;
    if (!isFocusableActionState(action.state)) return null;
    if (item.timing.kind === 'scheduled') {
      const blockId = item.timing.block.id;
      const entry = view.timeline.entries.find((candidate) => candidate.block?.id === blockId);
      if (entry === undefined || !isBlockEntry(entry)) return null;
      return (
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (!runner.busy) onRequest({ kind: 'completeActionBlock', entry });
          }}
        >
          {uiMessage('today.focus-mode.2235')}
          {context}
        </button>
      );
    }
    if (action.state === 'scheduled') return null;
    return (
      <button
        type="button"
        aria-disabled={busy}
        onClick={() =>
          run(() =>
            runner.run(
              () => actions.transition(action.id, action.localRevision, 'completed'),
              uiMessage('today.end-day.2156', { value0: title }),
              { undo: (undoId) => actions.undo(undoId) },
            ),
          )
        }
      >
        {uiMessage('actions-ui.257')}
        {context}
      </button>
    );
  }
  const occurrence = item.occurrence;
  if (occurrence === null) return null;
  const target = occurrenceTarget(occurrence);
  if (occurrence.timing.kind === 'weekly_count') {
    const goal =
      occurrence.targetCount ??
      (occurrence.ref.period.kind === 'week' ? occurrence.ref.period.targetCount : 0);
    if ((occurrence.completedCount ?? 0) >= goal) return null;
    return (
      <button
        type="button"
        aria-disabled={busy}
        onClick={() =>
          run(() =>
            runner.run(
              () => planning.completeOccurrence({ occurrence: target }),
              uiMessage('plan.occurrence-controls.1238'),
            ),
          )
        }
      >
        {uiMessage('plan.occurrence-controls.1239')}
        {context}
      </button>
    );
  }
  if (occurrence.state !== 'planned') return null;
  return (
    <button
      type="button"
      aria-disabled={busy}
      onClick={() =>
        run(() =>
          runner.run(
            () => planning.completeOccurrence({ occurrence: target }),
            uiMessage('plan.occurrence-controls.1242'),
          ),
        )
      }
    >
      {uiMessage('actions-ui.257')}
      {context}
    </button>
  );
}

/* ───────────────────────── Add to focus ───────────────────────── */

export interface AddToFocusButtonProps {
  readonly date: CalendarDate;
  readonly target: FocusTargetInput;
  /** The item's title, for the accessible name and the announcement. */
  readonly title: string;
  /** The date's current focus: a full day or an item already chosen keeps the button described. */
  readonly focus: readonly FocusItemView[];
  /** The date is today or later. */
  readonly editable: boolean;
  readonly runner: CommandRunner;
}

export const alreadyInFocusReason = uiMessage('today.focus-strip.2266');
export const focusFullReason = uiMessage('today.focus-strip.2267');

/**
 * Adds one item to a date's focus. When it cannot (already chosen, or the day holds three), it
 * stays focusable with `aria-disabled` and names the reason in visible text. An earlier day's
 * focus is read-only, so nothing is shown for it.
 */
export function AddToFocusButton({
  date,
  editable,
  focus,
  runner,
  target,
  title,
}: AddToFocusButtonProps): ReactNode {
  const today = useTodayApplication();
  const reasonId = useId();
  if (!editable) return null;
  const chosen = focus.some((item) => sameFocusTarget(item.target, target));
  const reason = chosen
    ? alreadyInFocusReason
    : focus.length >= dayFocusLimit
      ? focusFullReason
      : null;
  return (
    <span className="add-to-focus">
      <button
        type="button"
        aria-disabled={reason !== null || runner.busy ? true : undefined}
        aria-describedby={reason === null ? undefined : reasonId}
        onClick={() => {
          if (reason !== null || runner.busy) return;
          void runner.run(
            () => today.addFocus({ date, target }),
            uiMessage('today.focus-strip.2268', { value0: title }),
          );
        }}
      >
        {uiMessage('today.focus-strip.2269')}
        <span className="sr-only">{title}</span>
      </button>
      {reason !== null && (
        <span id={reasonId} className="field-help">
          {reason}
        </span>
      )}
    </span>
  );
}
