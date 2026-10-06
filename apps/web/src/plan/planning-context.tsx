import { message as uiMessage } from '../messages';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type {
  ActionApplication,
  AlignmentApplication,
  ApplicationResult,
  CommandReceipt,
  NoChangeReceipt,
  PlanningApplication,
  ReviewApplication,
  TodayApplication,
} from '@yelaxis/application';
import {
  currentPlanningDate,
  type CalendarDate,
  type IanaTimeZone,
  type Instant,
  type UUID,
} from '@yelaxis/domain';

import { applicationErrorMessage, browserToday } from './format';

export const planChangedEvent = 'yelaxis:plan-changed';
export const actionsChangedEvent = 'yelaxis:actions-changed';

interface PlanningServices {
  readonly planning: PlanningApplication;
  readonly actions: ActionApplication;
  /** alignment facade; absent in isolated component trees that do not need it. */
  readonly alignment: AlignmentApplication | null;
  /** Today and Focus facade; absent in isolated component trees that do not need it. */
  readonly today: TodayApplication | null;
  /** Reviews facade; absent in isolated component trees that do not need it. */
  readonly reviews: ReviewApplication | null;
}

const PlanningContext = createContext<PlanningServices | null>(null);

export function PlanningProvider({
  actions,
  alignment,
  children,
  planning,
  reviews,
  today,
}: {
  readonly planning: PlanningApplication;
  readonly actions: ActionApplication;
  readonly alignment?: AlignmentApplication;
  readonly today?: TodayApplication;
  /** Null or absent until the Reviews facade is composed. */
  readonly reviews?: ReviewApplication | null;
  readonly children: ReactNode;
}): ReactNode {
  const value = useMemo<PlanningServices>(
    () => ({
      planning,
      actions,
      alignment: alignment ?? null,
      today: today ?? null,
      reviews: reviews ?? null,
    }),
    [actions, alignment, planning, reviews, today],
  );
  return <PlanningContext.Provider value={value}>{children}</PlanningContext.Provider>;
}

export function usePlanning(): PlanningApplication {
  const value = useContext(PlanningContext);
  if (value === null) throw new Error(uiMessage('plan.planning-context.1407'));
  return value.planning;
}

/** Planning services when rendered inside the provider; null in isolated component tests. */
export function usePlanningOptional(): PlanningApplication | null {
  return useContext(PlanningContext)?.planning ?? null;
}

export function useActionsApplication(): ActionApplication {
  const value = useContext(PlanningContext);
  if (value === null) throw new Error(uiMessage('plan.planning-context.1407'));
  return value.actions;
}

/** The alignment facade (Axes, Outcomes, Projects, Milestones, and their links). */
export function useAlignment(): AlignmentApplication {
  const alignment = useContext(PlanningContext)?.alignment ?? null;
  if (alignment === null) throw new Error(uiMessage('plan.planning-context.1408'));
  return alignment;
}

/** Alignment services when the provider has them; null in isolated component tests. */
export function useAlignmentOptional(): AlignmentApplication | null {
  return useContext(PlanningContext)?.alignment ?? null;
}

/** The Today facade (Today, focus, Focus mode, and End Day). */
export function useTodayApplication(): TodayApplication {
  const today = useContext(PlanningContext)?.today ?? null;
  if (today === null) throw new Error(uiMessage('plan.planning-context.1409'));
  return today;
}

/** Today services when the provider has them; null in isolated component tests. */
export function useTodayApplicationOptional(): TodayApplication | null {
  return useContext(PlanningContext)?.today ?? null;
}

/** The Reviews facade (daily, weekly, monthly, and yearly reviews). */
export function useReviewApplication(): ReviewApplication {
  const reviews = useContext(PlanningContext)?.reviews ?? null;
  if (reviews === null) throw new Error(uiMessage('plan.planning-context.1410'));
  return reviews;
}

/** Review services when the provider has them; null in isolated component tests. */
export function useReviewApplicationOptional(): ReviewApplication | null {
  return useContext(PlanningContext)?.reviews ?? null;
}

export interface PlanningToday {
  readonly date: CalendarDate;
  /** False while the Profile planning zone is still loading and `date` is the browser's date. */
  readonly settled: boolean;
}

/**
 * The Profile planning zone: undefined while it loads, null when planning services are absent or
 * the profile cannot be read.
 */
export function usePlanningZone(): IanaTimeZone | null | undefined {
  const planning = usePlanningOptional();
  const [zone, setZone] = useState<IanaTimeZone | null | undefined>(
    planning === null ? null : undefined,
  );
  useEffect(() => {
    if (planning === null) {
      setZone(null);
      return;
    }
    let live = true;
    const load = (): void => {
      planning.getCapacitySettings().then(
        (settings) => {
          if (live) setZone(settings.profile.planningTimeZone);
        },
        () => {
          if (live) setZone(null);
        },
      );
    };
    load();
    // A planning-zone change (or its undo) is a committed plan change.
    window.addEventListener(planChangedEvent, load);
    return () => {
      live = false;
      window.removeEventListener(planChangedEvent, load);
    };
  }, [planning]);
  return zone;
}

/** Today in a planning zone, or the browser's date when the zone is not known. */
export function planningDateToday(zone: IanaTimeZone | null | undefined): CalendarDate {
  return zone === null || zone === undefined
    ? (browserToday() as CalendarDate)
    : currentPlanningDate({ now: () => new Date().toISOString() as Instant }, zone);
}

/**
 * Today in the Profile planning zone, which can differ from the browser's date while traveling.
 * The browser date is only a fallback while the profile loads or when it cannot be read.
 */
export function usePlanningTodayState(): PlanningToday {
  const zone = usePlanningZone();
  return { date: planningDateToday(zone), settled: zone !== undefined };
}

/** Today's date in the Profile planning zone (the browser date while the profile loads). */
export function usePlanningToday(): CalendarDate {
  return usePlanningTodayState().date;
}

/** Tell every mounted view to re-query canonical SQLite state. */
export function notifyPlanChanged(): void {
  window.dispatchEvent(new Event(planChangedEvent));
  window.dispatchEvent(new Event(actionsChangedEvent));
}

export type PlanQueryState<Data> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: Data; readonly refreshing: boolean }
  | { readonly status: 'error'; readonly message: string };

/**
 * Load a read model and re-query after any committed planning or Action change. React keeps only
 * this presentation copy; SQLite remains canonical.
 */
export function usePlanQuery<Data>(
  load: () => Promise<Data>,
  dependencies: readonly unknown[],
): { readonly state: PlanQueryState<Data>; readonly reload: () => Promise<void> } {
  const [state, setState] = useState<PlanQueryState<Data>>({ status: 'loading' });
  const loader = useRef(load);
  loader.current = load;
  const mounted = useRef(true);
  const generation = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    const ticket = ++generation.current;
    setState((current) =>
      current.status === 'ready' ? { ...current, refreshing: true } : current,
    );
    try {
      const data = await loader.current();
      if (mounted.current && ticket === generation.current)
        setState({ status: 'ready', data, refreshing: false });
    } catch {
      if (mounted.current && ticket === generation.current)
        setState({
          status: 'error',
          message: uiMessage('plan.planning-context.1411'),
        });
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    setState({ status: 'loading' });
    void reload();
    return () => {
      mounted.current = false;
    };
  }, dependencies);
  useEffect(() => {
    // One committed change dispatches both events; coalesce them into a single re-query.
    let pending = false;
    const refresh = (): void => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        void reload();
      });
    };
    window.addEventListener(planChangedEvent, refresh);
    window.addEventListener(actionsChangedEvent, refresh);
    return () => {
      window.removeEventListener(planChangedEvent, refresh);
      window.removeEventListener(actionsChangedEvent, refresh);
    };
  }, [reload]);
  return { state, reload };
}

/** Announced when a link already exists: nothing was written and no undo is offered. */
export const alreadyLinkedMessage = uiMessage('plan.planning-context.1412');

const isNoChange = (value: CommandReceipt | NoChangeReceipt): value is NoChangeReceipt =>
  'status' in value && value.status === 'no_change';

/** Applies one command's undo descriptor. */
export type UndoCommand = (undoId: UUID) => Promise<ApplicationResult<CommandReceipt>>;

export interface CommandRunOptions {
  /**
   * How to apply this command's undo, for commands whose undo descriptor another facade owns (for
   * example `actions.undo` after `actions.transition`). Defaults to `planning.undo`
   * (`planning.restore_v1`). It stays with this command's undo id only.
   */
  readonly undo?: UndoCommand;
}

export interface CommandRunner {
  readonly busy: boolean;
  readonly error: string | null;
  readonly undoId: UUID | null;
  readonly announcement: string;
  /** Changes with every announcement, so a repeated message is announced again. */
  readonly announcementKey: number;
  /**
   * Visible text for a command that succeeded without changing anything (an existing link). The
   * announcement already reports it to assistive technology.
   */
  readonly notice?: string | null;
  /**
   * Run one command; returns true when it succeeded: it committed, or (for a duplicate link)
   * nothing needed to change, which is announced as "Already linked. Nothing changed." with no undo.
   * `options.undo` applies this command's undo instead of `planning.undo`.
   */
  run(
    operation: () => Promise<ApplicationResult<CommandReceipt | NoChangeReceipt>>,
    success?: string,
    options?: CommandRunOptions,
  ): Promise<boolean>;
  undo(): Promise<void>;
  clearError(): void;
  dismissUndo(): void;
}

/** Shared command feedback: busy state, calm errors, success announcement, and grouped undo. */
export function useCommandRunner(): CommandRunner {
  const planning = usePlanning();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The latest undoable command: its undo id and, when another facade owns it, how to apply it.
  const [pendingUndo, setPendingUndo] = useState<{
    readonly id: UUID;
    readonly apply?: UndoCommand;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announced, setAnnounced] = useState<{ readonly text: string; readonly key: number }>({
    text: '',
    key: 0,
  });
  const run = useCallback(
    async (
      operation: () => Promise<ApplicationResult<CommandReceipt | NoChangeReceipt>>,
      success = uiMessage('actions-ui.235'),
      options: CommandRunOptions = {},
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await operation();
        if (!result.ok) {
          setError(applicationErrorMessage(result.error));
          notifyPlanChanged();
          return false;
        }
        if (isNoChange(result.value)) {
          // Nothing was written: no undo, but re-read so the view shows the existing link.
          setPendingUndo(null);
          setNotice(alreadyLinkedMessage);
          setAnnounced((current) => ({ text: alreadyLinkedMessage, key: current.key + 1 }));
          notifyPlanChanged();
          return true;
        }
        const undo = result.value.undo;
        setPendingUndo(
          undo.available
            ? {
                id: undo.undoId,
                ...(options.undo === undefined ? {} : { apply: options.undo }),
              }
            : null,
        );
        setAnnounced((current) => ({ text: success, key: current.key + 1 }));
        notifyPlanChanged();
        return true;
      } catch {
        setError(uiMessage('actions-ui.363'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  const undo = useCallback(async (): Promise<void> => {
    if (pendingUndo === null) return;
    const { apply, id } = pendingUndo;
    setPendingUndo(null);
    await run(
      () => (apply === undefined ? planning.undo(id) : apply(id)),
      uiMessage('alignment.kit.476'),
    );
    setPendingUndo(null);
  }, [planning, run, pendingUndo]);
  return {
    busy,
    error,
    undoId: pendingUndo?.id ?? null,
    announcement: announced.text,
    announcementKey: announced.key,
    notice,
    run,
    undo,
    clearError: () => setError(null),
    dismissUndo: () => setPendingUndo(null),
  };
}

/**
 * The single polite live region for a runner. Each announcement replaces a keyed child, so a
 * repeated message (Skip on a second block) is still announced once per command.
 */
export function RunnerAnnouncement({ runner }: { readonly runner: CommandRunner }): ReactNode {
  return (
    <p className="sr-only" aria-live="polite">
      {runner.announcement === '' ? null : (
        <span key={runner.announcementKey}>{runner.announcement}</span>
      )}
    </p>
  );
}

/**
 * Visible confirmation with Undo. It is deliberately not a live region: the runner's announcement
 * already reports the change once.
 */
export function UndoBar({
  onDismiss,
  runner,
}: {
  readonly runner: CommandRunner;
  readonly onDismiss?: () => void;
}): ReactNode {
  if (runner.undoId === null) return null;
  return (
    <div className="undo-bar">
      <span>{uiMessage('actions-ui.235')}</span>
      <button type="button" disabled={runner.busy} onClick={() => void runner.undo()}>
        {uiMessage('actions-ui.236')}
      </button>
      {onDismiss !== undefined && (
        <button type="button" className="text-button" onClick={onDismiss}>
          {uiMessage('account.account-notice.71')}
        </button>
      )}
    </div>
  );
}

/**
 * Error, undo, and polite status region for a CommandRunner. Pass `showError={false}` when a dialog
 * already renders the error next to its fields, so it is not announced twice.
 */
export function CommandFeedback({
  runner,
  showError = true,
}: {
  readonly runner: CommandRunner;
  readonly showError?: boolean;
}): ReactNode {
  return (
    <>
      <RunnerAnnouncement runner={runner} />
      {showError && runner.error !== null && (
        <p className="validation-summary" role="alert">
          {runner.error}
        </p>
      )}
      {/* Not a live region: the announcement above already reports it once. */}
      {runner.notice !== undefined && runner.notice !== null && (
        <p className="runner-notice">{runner.notice}</p>
      )}
      <UndoBar runner={runner} />
    </>
  );
}
