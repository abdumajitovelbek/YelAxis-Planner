import { PagedItems } from '../item-pages';
import { message as uiMessage } from '../messages';
/**
 * Today's flexible Actions: Day-placed Actions without a time on the date, in the
 * person's own order. Every change is an explicit command with Undo; dragging onto the timeline
 * only opens the Schedule dialog, and every drag has a button path.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { ActionSummary, TodayView } from '@yelaxis/application';

import { formatDate } from '../plan/format';
import {
  useActionsApplication,
  usePlanning,
  useTodayApplication,
  type CommandRunner,
} from '../plan/planning-context';
import { actionPath, focusPath } from '../plan/routes';
import { ActionRow, actionPlaceTarget, type RequestDialog } from '../plan/scheduling-dialogs';
import { AddToFocusButton } from './focus-strip';

export interface FlexibleListProps {
  readonly view: TodayView;
  /** The viewed date is the live planning today ("Done today" rather than "Done"). */
  readonly isLiveToday: boolean;
  readonly runner: CommandRunner;
  readonly onRequest: RequestDialog;
  /** Where Focus mode returns to (this Today URL). */
  readonly returnTo: string;
}

export function FlexibleList({
  isLiveToday,
  onRequest,
  returnTo,
  runner,
  view,
}: FlexibleListProps): ReactNode {
  const actions = useActionsApplication();
  const { done, open } = view.flexible;
  const longDate = formatDate(view.date, 'long');
  // The Action just completed here fades into the Done list (static in reduced motion).
  const [completedId, setCompletedId] = useState<string | null>(null);
  const reopen = (action: ActionSummary): void =>
    void runner.run(
      () => actions.transition(action.id, action.localRevision, 'planned'),
      uiMessage('today.flexible-list.2210', { value0: action.title }),
      { undo: (undoId) => actions.undo(undoId) },
    );
  return (
    <section className="today-section today-flexible" aria-labelledby="today-flexible-heading">
      <h2 id="today-flexible-heading">{uiMessage('plan.plan-day.1293')}</h2>
      <p className="field-help">{uiMessage('today.flexible-list.2211')}</p>
      {open.length === 0 ? (
        <p className="quiet-empty">{uiMessage('today.flexible-list.2212')}</p>
      ) : (
        <ul
          className="action-list today-flexible-list"
          aria-label={uiMessage('today.flexible-list.2213', { value0: longDate })}
        >
          <PagedItems items={open} identity={view.date}>
            {(action, index) => (
              <FlexibleRow
                key={action.id}
                action={action}
                index={index}
                total={open.length}
                view={view}
                runner={runner}
                onRequest={onRequest}
                onCompleted={setCompletedId}
                returnTo={returnTo}
              />
            )}
          </PagedItems>
        </ul>
      )}
      {done.length > 0 && (
        <details className="today-done">
          <summary>
            {isLiveToday ? uiMessage('today.flexible-list.2214') : uiMessage('today.end-day.2184')}{' '}
            ({String(done.length)})
          </summary>
          <ul
            className="action-list"
            aria-label={uiMessage('today.end-day.2186', { value0: longDate })}
          >
            <PagedItems items={done} identity={view.date}>
              {(action) => (
                <li
                  key={action.id}
                  className={`action-row today-done-item${action.id === completedId ? ' is-just-completed' : ''}`}
                >
                  <p className="action-row-title">
                    <Link to={actionPath(action.id)}>{action.title}</Link>
                  </p>
                  <p className="field-help">{uiMessage('plan.plan-month.1324')}</p>
                  <div className="control-row">
                    <button type="button" disabled={runner.busy} onClick={() => reopen(action)}>
                      {uiMessage('today.flexible-list.2216')}
                      <span className="sr-only">{action.title}</span>
                    </button>
                  </div>
                </li>
              )}
            </PagedItems>
          </ul>
        </details>
      )}
    </section>
  );
}

function FlexibleRow({
  action,
  index,
  onCompleted,
  onRequest,
  returnTo,
  runner,
  total,
  view,
}: {
  readonly action: ActionSummary;
  readonly index: number;
  readonly total: number;
  readonly view: TodayView;
  readonly runner: CommandRunner;
  readonly onRequest: RequestDialog;
  readonly onCompleted: (actionId: string) => void;
  readonly returnTo: string;
}): ReactNode {
  const today = useTodayApplication();
  const actions = useActionsApplication();
  const planning = usePlanning();
  const date = view.date;
  const title = action.title;
  const context = (
    <>
      {' '}
      <span className="sr-only">{title}</span>
    </>
  );
  const complete = (): void =>
    void runner
      .run(
        () => actions.transition(action.id, action.localRevision, 'completed'),
        uiMessage('today.end-day.2156', { value0: title }),
        // The Actions facade owns this undo descriptor (actions.restore_v1).
        { undo: (undoId) => actions.undo(undoId) },
      )
      .then((saved) => {
        if (saved) onCompleted(action.id);
      });
  const move = (direction: 'up' | 'down'): void => {
    const placement = action.placement;
    if (placement === undefined) return;
    const position = index + (direction === 'up' ? 0 : 2);
    void runner.run(
      () =>
        today.reorderFlexible({
          date,
          placementId: placement.id,
          revision: placement.localRevision,
          direction,
        }),
      uiMessage('today.flexible-list.2217', {
        value0: title,
        value1: String(position),
        value2: String(total),
      }),
    );
  };
  return (
    <ActionRow action={action}>
      <button type="button" disabled={runner.busy} onClick={complete}>
        {uiMessage('actions-ui.257')}
        {context}
      </button>
      <button
        type="button"
        disabled={runner.busy}
        onClick={() => onRequest({ kind: 'schedule', action, date })}
      >
        {uiMessage('today.flexible-list.2218')}
        {context}
      </button>
      <MoveButtons
        title={title}
        isFirst={index === 0}
        isLast={index === total - 1}
        busy={runner.busy}
        onMove={move}
      />
      <details className="today-more-options">
        <summary>
          {uiMessage('today.flexible-list.2219')}
          <span className="sr-only">
            {uiMessage('plan.occurrence-controls.1235')}
            {title}
          </span>
        </summary>
        <div className="control-row">
          <AddToFocusButton
            date={date}
            target={{ kind: 'action', actionId: action.id }}
            title={title}
            focus={view.focus}
            editable={view.focusEditable}
            runner={runner}
          />
          <button
            type="button"
            disabled={runner.busy}
            onClick={() =>
              onRequest({ kind: 'place', target: actionPlaceTarget(action), date, choice: 'day' })
            }
          >
            {uiMessage('today.end-day.2205')}
            {context}
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
            {uiMessage('today.flexible-list.2220')}
            {context}
          </button>
          <Link to={focusPath(action.id)} state={{ returnTo }}>
            {uiMessage('today.flexible-list.2221')}
            {context}
          </Link>
        </div>
      </details>
    </ActionRow>
  );
}

/**
 * Move up and Move down for one row, named "Move {title} up" / "Move {title} down". The visible
 * label ("↑ Up", "↓ Down") is part of that name, so speech input can say it (WCAG 2.5.3). They
 * stay focusable at the ends of the list and while a move saves (`aria-disabled`), and focus
 * returns to the pressed button once the re-read list renders in its new order (moving a row can
 * detach its focused button).
 */
function MoveButtons({
  busy,
  isFirst,
  isLast,
  onMove,
  title,
}: {
  readonly title: string;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly busy: boolean;
  readonly onMove: (direction: 'up' | 'down') => void;
}): ReactNode {
  const up = useRef<HTMLButtonElement>(null);
  const down = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ readonly direction: 'up' | 'down'; readonly until: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const target = pending.current;
    if (target === null) return;
    if (Date.now() > target.until) {
      pending.current = null;
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) {
      (target.direction === 'up' ? up : down).current?.focus();
      pending.current = null;
    }
  });
  useEffect(() => {
    // A pointer press or focus anywhere else means the person moved on (by mouse or keyboard):
    // never pull focus back after it. A detached button sends focus to the body without focusin.
    const forget = (event: Event): void => {
      const target = event.target instanceof Node ? event.target : null;
      const own = (button: HTMLButtonElement | null): boolean =>
        target !== null && button?.contains(target) === true;
      if (!own(up.current) && !own(down.current)) pending.current = null;
    };
    document.addEventListener('pointerdown', forget, true);
    document.addEventListener('focusin', forget, true);
    return () => {
      document.removeEventListener('pointerdown', forget, true);
      document.removeEventListener('focusin', forget, true);
    };
  }, []);
  const press = (direction: 'up' | 'down'): void => {
    if (busy || (direction === 'up' ? isFirst : isLast)) return;
    pending.current = { direction, until: Date.now() + 3000 };
    onMove(direction);
  };
  return (
    <>
      <button
        ref={up}
        type="button"
        aria-label={uiMessage('actions-ui.266', { value0: title })}
        aria-disabled={busy || isFirst}
        onClick={() => press('up')}
      >
        <span aria-hidden="true">↑</span>
        {uiMessage('today.flexible-list.2222')}
      </button>
      <button
        ref={down}
        type="button"
        aria-label={uiMessage('actions-ui.267', { value0: title })}
        aria-disabled={busy || isLast}
        onClick={() => press('down')}
      >
        <span aria-hidden="true">↓</span>
        {uiMessage('today.flexible-list.2223')}
      </button>
    </>
  );
}
