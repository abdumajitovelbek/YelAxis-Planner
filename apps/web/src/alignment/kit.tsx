import { message as uiMessage } from '../messages';
/**
 * Shared building blocks for the Axis, Outcome, Project, and Milestone pages: deep-link states,
 * page header and facts, neutral status text, keyboard reordering, history, and the notice shown
 * after a command that moves to another page. React keeps only presentation state; every write is
 * an application command.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import type {
  ApplicationError,
  ApplicationResult,
  AxisSummary,
  CommandReceipt,
  HistoryEntry,
  NoChangeReceipt,
  OutcomeItem,
  ProjectItem,
  ReorderScope,
} from '@yelaxis/application';
import { parseUUID, type AlignmentKind, type UUID } from '@yelaxis/domain';

import { applicationErrorMessage } from '../plan/format';
import {
  RunnerAnnouncement,
  useAlignment,
  useCommandRunner,
  usePlanning,
  usePlanQuery,
  type CommandRunner,
  type PlanQueryState,
} from '../plan/planning-context';
import { actionPath, axisOverviewPath, outcomePath, projectPath } from '../plan/routes';
import { HorizonSection } from '../plan/theme-editor';
import {
  countLabel,
  historyEventLabel,
  kindLabel,
  progressText,
  stateLabel,
  targetText,
} from './labels';

import './alignment.css';

/* ───────────────────────── Ids and queries ───────────────────────── */

/** True for a well-formed object id; anything else is shown as unavailable without a query. */
export const isAlignmentId = (value: string): boolean => parseUUID(value).ok;

/**
 * Load one object for a page and re-query after every committed change. A malformed id resolves to
 * null without calling `load`. A new id starts from the loading state; a change in `deps` (page
 * options such as "Show finished") re-queries in place, so the page and its focus stay.
 */
export function useObjectQuery<T>(
  id: string,
  load: (id: string) => Promise<T | null>,
  deps: readonly unknown[] = [],
): { readonly state: PlanQueryState<T | null>; readonly reload: () => Promise<void> } {
  const valid = isAlignmentId(id);
  const query = usePlanQuery<T | null>(
    () => (valid ? load(id) : Promise.resolve(null)),
    [id, valid],
  );
  const { reload } = query;
  const options = JSON.stringify(deps);
  const previous = useRef(options);
  useEffect(() => {
    if (previous.current === options) return;
    previous.current = options;
    void reload();
  }, [options, reload]);
  return query;
}

/**
 * Deep-link frame for one object page. It renders the loading ("Opening Outcome…"), read-error
 * (Try again, Back to Axes), and unavailable ("This Outcome is unavailable") states with a single
 * h1, and hands the loaded object to `children`. Render a component from `children` (hooks cannot
 * run inside the render function itself).
 */
export function ObjectPage<T>({
  children,
  deps = [],
  id,
  kind,
  load,
}: {
  readonly kind: AlignmentKind;
  readonly id: string;
  readonly load: (id: string) => Promise<T | null>;
  readonly children: (data: T, reload: () => Promise<void>) => ReactNode;
  /**
   * Page options the query depends on (for example an "include finished" toggle), compared by
   * value; a change re-queries in place.
   */
  readonly deps?: readonly unknown[];
}): ReactNode {
  const { state, reload } = useObjectQuery(id, load, deps);
  const titleId = useId();
  const label = kindLabel(kind);
  if (state.status === 'loading') {
    return (
      <section
        className="content-section alignment-page"
        aria-labelledby={titleId}
        aria-busy="true"
      >
        <p className="eyebrow">{label}</p>
        <h1 id={titleId}>{uiMessage('alignment.kit.468', { value0: label })}</h1>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="content-section alignment-page" aria-labelledby={titleId}>
        <p className="eyebrow">{label}</p>
        <h1 id={titleId}>{uiMessage('alignment.kit.469', { value0: label })}</h1>
        <p className="validation-summary" role="alert">
          {state.message}
        </p>
        <div className="detail-actions">
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
          <Link className="inline-button" to={axisOverviewPath}>
            {uiMessage('alignment.alignment-page.390')}
          </Link>
        </div>
      </section>
    );
  }
  if (state.data === null) {
    return (
      <section className="content-section alignment-page" aria-labelledby={titleId}>
        <p className="eyebrow">{label}</p>
        <h1 id={titleId}>{uiMessage('alignment.alignment-page.388', { value0: label })}</h1>
        <p className="page-message">{uiMessage('alignment.alignment-page.389')}</p>
        <Link className="inline-button" to={axisOverviewPath}>
          {uiMessage('alignment.alignment-page.390')}
        </Link>
      </section>
    );
  }
  return children(state.data, reload);
}

/* ───────────────────────── Header, facts, status ───────────────────────── */

/** State in words, in a pill. The text carries the meaning; color never does. */
export function StatusPill({ label }: { readonly label: string }): ReactNode {
  return <span className="status-pill alignment-status">{label}</span>;
}

/**
 * Back link, eyebrow "{Type} · {State}", and the page's only h1. The h1 takes focus when a
 * committed change removes the control that had it (see `useFocusRescue`).
 */
export function ObjectHeader({
  back,
  headingRef,
  kind,
  state,
  title,
  titleId,
}: {
  readonly kind: AlignmentKind;
  readonly state: string;
  readonly title: string;
  readonly titleId?: string;
  readonly headingRef?: RefObject<HTMLHeadingElement | null>;
  readonly back?: { readonly to: string; readonly label: string };
}): ReactNode {
  return (
    <>
      {back !== undefined && (
        <Link className="back-link" to={back.to}>
          ← {back.label}
        </Link>
      )}
      <p className="eyebrow">
        {kindLabel(kind)} · {stateLabel(kind, state)}
      </p>
      <h1 id={titleId} ref={headingRef} tabIndex={-1} className="object-title">
        {title}
      </h1>
    </>
  );
}

export interface Fact {
  readonly term: string;
  readonly value: ReactNode;
}

/** Facts of an object as a description list. */
export function FactList({
  items,
  label,
}: {
  readonly items: readonly Fact[];
  readonly label?: string;
}): ReactNode {
  return (
    <dl className="object-facts" {...(label === undefined ? {} : { 'aria-label': label })}>
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Neutral member counts ("3 Outcomes · 2 Projects · 1 Routine"); each count stays on one line when
 * the text wraps.
 */
export function MemberCounts({ counts }: { readonly counts: AxisSummary['counts'] }): ReactNode {
  const parts = [
    countLabel('outcome', counts.outcomes),
    countLabel('project', counts.projects),
    countLabel('routine', counts.routines),
  ];
  return (
    <span className="member-counts">
      {parts.map((part, index) => (
        <Fragment key={part}>
          {index > 0 && ' · '}
          <span>{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** "Showing 200 of 340 Outcomes." when a bounded list is cut; nothing otherwise. */
export function BoundedNote({
  noun,
  shown,
  total,
}: {
  readonly shown: number;
  readonly total: number;
  readonly noun: string;
}): ReactNode {
  if (total <= shown) return null;
  return (
    <p className="field-help">
      {uiMessage('alignment.kit.470', {
        value0: String(shown),
        value1: String(total),
        value2: noun,
      })}
    </p>
  );
}

/* ───────────────────────── Reordering ───────────────────────── */

/**
 * "Move {item} up" and "Move {item} down" for keyboard and pointer reordering. The buttons stay
 * focusable at the ends of a list and while a move is saving (`aria-disabled`), and focus returns
 * to the pressed button when the list re-renders in its new order.
 */
export function MoveButtons({
  disabled = false,
  isFirst,
  isLast,
  itemLabel,
  onMove,
}: {
  readonly itemLabel: string;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly disabled?: boolean;
  readonly onMove: (direction: 'up' | 'down') => void;
}): ReactNode {
  const group = useRef<HTMLDivElement>(null);
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
    // Moving a row can detach the focused button; put focus back once, then stop tracking.
    const active = document.activeElement;
    if (active === null || active === document.body) {
      (target.direction === 'up' ? up : down).current?.focus();
      pending.current = null;
    }
  });
  useEffect(() => {
    // A pointer press anywhere else means the person moved on: never pull focus back after it.
    const forget = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || group.current?.contains(event.target) !== true)
        pending.current = null;
    };
    document.addEventListener('pointerdown', forget, true);
    return () => document.removeEventListener('pointerdown', forget, true);
  }, []);
  const press = (direction: 'up' | 'down'): void => {
    if (disabled || (direction === 'up' ? isFirst : isLast)) return;
    pending.current = { direction, until: Date.now() + 3000 };
    onMove(direction);
  };
  return (
    <div
      ref={group}
      className="move-buttons"
      role="group"
      aria-label={uiMessage('alignment.kit.471', { value0: itemLabel })}
    >
      <button
        ref={up}
        type="button"
        aria-label={uiMessage('actions-ui.266', { value0: itemLabel })}
        aria-disabled={disabled || isFirst}
        onClick={() => press('up')}
      >
        ↑
      </button>
      <button
        ref={down}
        type="button"
        aria-label={uiMessage('actions-ui.267', { value0: itemLabel })}
        aria-disabled={disabled || isLast}
        onClick={() => press('down')}
      >
        ↓
      </button>
    </div>
  );
}

/* ───────────────────────── Outcome and Project rows ───────────────────────── */

type MoveDirection = 'up' | 'down';

/** Reorder one row inside its container, announcing the move in words. */
function useReorder(
  runner: CommandRunner,
  scope: ReorderScope | undefined,
): (
  target: { readonly kind: AlignmentKind; readonly id: string; readonly revision: number },
  title: string,
  direction: MoveDirection,
) => void {
  const alignment = useAlignment();
  return (target, title, direction) => {
    if (scope === undefined || runner.busy) return;
    void runner.run(
      () => alignment.reorder({ target, direction, scope }),
      uiMessage('alignment.axis-overview.452', { value0: title, value1: direction }),
    );
  };
}

/**
 * Outcomes in order: title link, state, progress in words, and target. With a `scope` each row
 * can move up or down within that container.
 */
export function OutcomeRows({
  emptyText,
  items,
  label,
  runner,
  scope,
}: {
  readonly items: readonly OutcomeItem[];
  /** Accessible name of the list, e.g. "Outcomes in Health". */
  readonly label: string;
  readonly emptyText: string;
  readonly runner: CommandRunner;
  readonly scope?: ReorderScope;
}): ReactNode {
  const move = useReorder(runner, scope);
  if (items.length === 0) return <p className="quiet-empty">{emptyText}</p>;
  return (
    <ol className="alignment-list" aria-label={label}>
      {items.map((outcome, index) => {
        const target =
          outcome.targetStart === undefined && outcome.targetEnd === undefined
            ? null
            : targetText(outcome.targetStart, outcome.targetEnd);
        return (
          <li key={outcome.id} className="alignment-row">
            <div className="alignment-row-main">
              <p className="alignment-row-title">
                <Link to={outcomePath(outcome.id)}>{outcome.title}</Link>
                <StatusPill label={stateLabel('outcome', outcome.state)} />
              </p>
              <div className="alignment-row-meta">
                <p>{progressText(outcome.progress, outcome.canceledMilestones)}</p>
                {target !== null && <p>{target}</p>}
              </div>
            </div>
            {scope !== undefined && outcome.state !== 'archived' && (
              <MoveButtons
                itemLabel={outcome.title}
                isFirst={index === 0}
                isLast={index === items.length - 1}
                disabled={runner.busy}
                onMove={(direction) =>
                  move(
                    { kind: 'outcome', id: outcome.id, revision: outcome.localRevision },
                    outcome.title,
                    direction,
                  )
                }
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The next action of an active Project in words; nothing for other states. */
export function NextActionStatus({ project }: { readonly project: ProjectItem }): ReactNode {
  const next = project.nextAction;
  switch (next.status) {
    case 'not_applicable':
      return null;
    case 'missing':
      return <span className="next-action-missing">{uiMessage('alignment.kit.472')}</span>;
    case 'present':
      return (
        <span>
          {uiMessage('alignment.kit.473')}
          <Link to={actionPath(next.action.id)}>{next.action.title}</Link>
        </span>
      );
  }
}

/**
 * Projects in order: title link, state, next action (active Projects only), and target. With a
 * `scope` each row can move up or down within that container.
 */
export function ProjectRows({
  emptyText,
  items,
  label,
  runner,
  scope,
}: {
  readonly items: readonly ProjectItem[];
  readonly label: string;
  readonly emptyText: string;
  readonly runner: CommandRunner;
  readonly scope?: ReorderScope;
}): ReactNode {
  const move = useReorder(runner, scope);
  if (items.length === 0) return <p className="quiet-empty">{emptyText}</p>;
  return (
    <ol className="alignment-list" aria-label={label}>
      {items.map((project, index) => {
        const target =
          project.targetStart === undefined && project.targetEnd === undefined
            ? null
            : targetText(project.targetStart, project.targetEnd);
        return (
          <li key={project.id} className="alignment-row">
            <div className="alignment-row-main">
              <p className="alignment-row-title">
                <Link to={projectPath(project.id)}>{project.title}</Link>
                <StatusPill label={stateLabel('project', project.state)} />
              </p>
              {(project.nextAction.status !== 'not_applicable' || target !== null) && (
                <div className="alignment-row-meta">
                  {project.nextAction.status !== 'not_applicable' && (
                    <p>
                      <NextActionStatus project={project} />
                    </p>
                  )}
                  {target !== null && <p>{target}</p>}
                </div>
              )}
            </div>
            {scope !== undefined && project.state !== 'archived' && (
              <MoveButtons
                itemLabel={project.title}
                isFirst={index === 0}
                isLast={index === items.length - 1}
                disabled={runner.busy}
                onMove={(direction) =>
                  move(
                    { kind: 'project', id: project.id, revision: project.localRevision },
                    project.title,
                    direction,
                  )
                }
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ───────────────────────── History ───────────────────────── */

const historyTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : historyTime.format(date);
}

/** Recent audit events of an object: what happened and when, never the changed text. */
export function HistoryList({
  entries,
  title = uiMessage('alignment.kit.474'),
}: {
  readonly entries: readonly HistoryEntry[];
  readonly title?: string;
}): ReactNode {
  return (
    <HorizonSection title={title}>
      {entries.length === 0 ? (
        <p className="quiet-empty">{uiMessage('alignment.kit.475')}</p>
      ) : (
        <ol className="history-list">
          {entries.map((entry, index) => (
            <li key={`${entry.occurredAt}:${entry.eventType}:${String(index)}`}>
              <span>{historyEventLabel(entry.eventType)}</span>
              <time dateTime={entry.occurredAt}>{formatHistoryTime(entry.occurredAt)}</time>
            </li>
          ))}
        </ol>
      )}
    </HorizonSection>
  );
}

/* ───────────────────────── Commands ───────────────────────── */

export type CommandOutcome =
  | {
      readonly ok: true;
      /** Null when the command changed nothing (an existing link). */
      readonly receipt: CommandReceipt | null;
    }
  | { readonly ok: false; readonly message: string; readonly error: ApplicationError | null };

const isNoChangeReceipt = (value: CommandReceipt | NoChangeReceipt): value is NoChangeReceipt =>
  'status' in value && value.status === 'no_change';

/**
 * Run a command through the shared runner (busy state, announcement, undo) and return its receipt
 * or its message. The runner's own error is cleared: the caller shows the message next to its
 * fields, so it is not announced twice.
 */
export async function runForReceipt(
  runner: CommandRunner,
  operation: () => Promise<ApplicationResult<CommandReceipt | NoChangeReceipt>>,
  success: string,
): Promise<CommandOutcome> {
  const captured: { receipt?: CommandReceipt; error?: ApplicationError } = {};
  const done = await runner.run(async () => {
    const result = await operation();
    if (!result.ok) captured.error = result.error;
    else if (!isNoChangeReceipt(result.value)) captured.receipt = result.value;
    return result;
  }, success);
  if (done) return { ok: true, receipt: captured.receipt ?? null };
  runner.clearError();
  return captured.error === undefined
    ? {
        ok: false,
        message: uiMessage('actions-ui.363'),
        error: null,
      }
    : { ok: false, message: applicationErrorMessage(captured.error), error: captured.error };
}

/** Id of the object a create command made (the first canonical record of its receipt). */
export const createdId = (receipt: CommandReceipt | null): string | null =>
  receipt?.canonical[0]?.ref.id ?? null;

/** The undo a receipt offers, for a notice on the page a command navigates to. */
export const undoIdOf = (receipt: CommandReceipt | null): UUID | null =>
  receipt !== null && receipt.undo.available ? receipt.undo.undoId : null;

/** The form field a domain rejection names, when it names one. */
export function rejectedField(error: ApplicationError | null): string | null {
  if (error?.code !== 'domain_rejected') return null;
  const field = error.domainError.details?.['field'];
  return typeof field === 'string' ? field : null;
}

/* ───────────────────────── Notice after navigation ───────────────────────── */

interface NoticeState {
  readonly alignmentNotice: { readonly text: string; readonly undoId: UUID | null };
}

function readNotice(state: unknown): NoticeState['alignmentNotice'] | null {
  if (typeof state !== 'object' || state === null || !('alignmentNotice' in state)) return null;
  const notice = (state as { readonly alignmentNotice: unknown }).alignmentNotice;
  if (typeof notice !== 'object' || notice === null) return null;
  const text = (notice as { readonly text?: unknown }).text;
  const undoId = (notice as { readonly undoId?: unknown }).undoId;
  if (typeof text !== 'string' || text === '') return null;
  return { text, undoId: typeof undoId === 'string' ? (undoId as UUID) : null };
}

/** Router state that makes the destination page show `text` (and Undo when `undoId` is given). */
export function noticeState(text: string, undoId: UUID | null = null): NoticeState {
  return { alignmentNotice: { text, undoId } };
}

/**
 * Navigate after a command that leaves the page (a created object opens; a deleted one returns to
 * its parent), carrying the confirmation and, when available, its undo.
 */
export function useNoticeNavigate(): (to: string, text: string, undoId?: UUID | null) => void {
  const navigate = useNavigate();
  return useCallback(
    (to: string, text: string, undoId: UUID | null = null) =>
      void navigate(to, { state: noticeState(text, undoId) }),
    [navigate],
  );
}

/**
 * Shows the confirmation a previous page passed through navigation, with Undo when the command
 * offered one. The polite region is always present, so the message is announced after the route
 * change; the notice is removed from the history entry so Back, Forward, or a reload never repeats
 * it.
 */
export function NavigationNotice(): ReactNode {
  const location = useLocation();
  const planning = usePlanning();
  const runner = useCommandRunner();
  const [shown, setShown] = useState<{
    readonly key: string;
    /** Announced once; later visible changes are announced by the runner instead. */
    readonly announcement: string;
    readonly text: string;
    readonly undoId: UUID | null;
  } | null>(null);
  useEffect(() => {
    // A new page never inherits the previous notice or its undo error.
    runner.clearError();
    const notice = readNotice(location.state);
    if (notice === null) {
      setShown(null);
      return;
    }
    setShown({
      key: location.key,
      announcement: notice.text,
      text: notice.text,
      undoId: notice.undoId,
    });
    try {
      const entry: unknown = window.history.state;
      if (typeof entry === 'object' && entry !== null && 'usr' in entry)
        window.history.replaceState({ ...entry, usr: null }, '');
    } catch {
      // The notice is a convenience; a history entry that cannot change keeps it.
    }
  }, [location.key]);
  const visible = shown !== null && shown.key === location.key ? shown : null;
  return (
    <>
      <p className="sr-only" aria-live="polite">
        {visible === null ? null : <span key={visible.key}>{visible.announcement}</span>}
      </p>
      <RunnerAnnouncement runner={runner} />
      {visible !== null && (
        <div className="undo-bar navigation-notice">
          <span>{visible.text}</span>
          {visible.undoId !== null && (
            <button
              type="button"
              aria-disabled={runner.busy}
              onClick={() => {
                const undoId = visible.undoId;
                if (undoId === null || runner.busy) return;
                // The shared planning undo, like every runner's Undo.
                void runner
                  .run(() => planning.undo(undoId), uiMessage('alignment.kit.476'))
                  .then((undone) => {
                    setShown((current) =>
                      current === null
                        ? null
                        : {
                            ...current,
                            text: undone ? uiMessage('alignment.kit.476') : current.text,
                            undoId: null,
                          },
                    );
                    // The Undo button is gone; keep focus in the page instead of on nothing.
                    window.requestAnimationFrame(() => {
                      const active = document.activeElement;
                      if (active === null || active === document.body)
                        document.querySelector<HTMLElement>('#main-content')?.focus();
                    });
                  });
              }}
            >
              {uiMessage('actions-ui.236')}
            </button>
          )}
        </div>
      )}
      {visible !== null && runner.error !== null && (
        <p className="validation-summary" role="alert">
          {runner.error}
        </p>
      )}
    </>
  );
}
