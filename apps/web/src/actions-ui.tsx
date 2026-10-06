import { message as uiMessage } from './messages';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import type {
  ActionApplication,
  ActionCanonicalDocument,
  ActionChoice,
  ActionFormInput,
  ActionWorkspace,
  AlignmentApplication,
  AlignmentEdge,
  ApplicationError,
  BlockDocument,
  BulkChange,
  CaptureIntent,
  InboxPage as InboxProjection,
  MilestoneChoice,
  PlacementDocument,
  PlanProfile,
  ReminderDocument,
} from '@yelaxis/application';
import {
  formatInstantInZone,
  type ActionState,
  type IanaTimeZone,
  type CaptureOrigin,
  type UUID,
} from '@yelaxis/domain';

import { LinkDialog, UnlinkDialog } from './alignment/link-dialogs';
import { stateText } from './alignment/operations';
import { autofocusIn, focusIsOnField, mayMoveAutofocus, Modal } from './plan/modal';
import {
  CommandFeedback,
  notifyPlanChanged,
  planningDateToday,
  useAlignmentOptional,
  useCommandRunner,
  usePlanningOptional,
  usePlanningZone,
  usePlanQuery,
} from './plan/planning-context';
import {
  buildRoutineInput,
  emptyRoutineForm,
  routineErrorMessage,
  RoutineForm,
  RoutinePatternFields,
  RoutinePreview,
  runCommand,
  shiftDate,
  type RoutineFormSetter,
  type RoutineFormState,
} from './plan/routine-form';
import { milestonePath, routinePath } from './plan/routes';

type FormState = {
  title: string;
  note: string;
  axisId: string;
  projectId: string;
  plannedDate: string;
  dueDate: string;
  dueTime: string;
  estimate: string;
  energy: string;
  priority: string;
  scheduled: boolean;
  scheduleDate: string;
  startTime: string;
  endTime: string;
  reminderEnabled: boolean;
  reminderKind: 'at' | 'relative';
  reminderDate: string;
  reminderTime: string;
  reminderOffset: string;
  /** The person confirmed a Project in a different Axis than the Action's. */
  confirmCrossAxis: boolean;
};

const emptyForm: FormState = {
  title: '',
  note: '',
  axisId: '',
  projectId: '',
  plannedDate: '',
  dueDate: '',
  dueTime: '',
  estimate: '',
  energy: '',
  priority: '',
  scheduled: false,
  scheduleDate: '',
  startTime: '',
  endTime: '',
  reminderEnabled: false,
  reminderKind: 'at',
  reminderDate: '',
  reminderTime: '',
  reminderOffset: '15',
  confirmCrossAxis: false,
};

type AxisProjectPair = Readonly<{ axisId: string; projectId: string }>;

const noPair: AxisProjectPair = { axisId: '', projectId: '' };
const pairKey = (pair: AxisProjectPair): string => `${pair.axisId}|${pair.projectId}`;

/**
 * Whether the chosen Axis and Project need the cross-Axis confirmation before saving: both are
 * set, the pair differs from the saved one, and the Project names a different Axis. The
 * application re-checks this inside the command; a rejection shows the same confirmation.
 */
export function crossAxisPending(
  form: AxisProjectPair,
  saved: AxisProjectPair,
  projects: readonly ActionChoice[],
): boolean {
  if (form.axisId === '' || form.projectId === '') return false;
  if (form.axisId === saved.axisId && form.projectId === saved.projectId) return false;
  const projectAxis = projects.find((project) => project.id === form.projectId)?.axisId;
  return projectAxis !== undefined && projectAxis !== form.axisId;
}

const isCrossAxisRejection = (error: ApplicationError): boolean =>
  error.code === 'domain_rejected' && error.domainError.code === 'cross_axis_confirmation_required';

export function GlobalCapture({
  application,
}: {
  readonly application: ActionApplication;
}): ReactNode {
  const location = useLocation();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [intent, setIntent] = useState<CaptureIntent | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [axes, setAxes] = useState<readonly ActionChoice[]>([]);
  const [projects, setProjects] = useState<readonly ActionChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [crossAxisPrompt, setCrossAxisPrompt] = useState<string | null>(null);
  const planning = usePlanningOptional();
  const [repeat, setRepeat] = useState(false);
  const [routineForm, setRoutineForm] = useState<RoutineFormState>(() => emptyRoutineForm());
  const [planProfile, setPlanProfile] = useState<PlanProfile | null>(null);
  const setRoutineField: RoutineFormSetter = (key, value) =>
    setRoutineForm((current) => ({ ...current, [key]: value }));
  const focusTitle = (): void => {
    window.requestAnimationFrame(() => {
      dialog.current?.querySelector<HTMLInputElement>('input[required]')?.focus();
    });
  };

  const open = (): void => {
    setIntent(application.newCaptureIntent(originForPath(location.pathname)));
    setError(null);
    setCrossAxisPrompt(null);
    setForm(emptyForm);
    setRepeat(false);
    // The browser date only seeds the form until the Profile planning zone is known.
    const fallbackStart = todayString();
    setRoutineForm(emptyRoutineForm(fallbackStart));
    if (planning !== null)
      planning
        .getCapacitySettings()
        .then((settings) => {
          setPlanProfile(settings.profile);
          const today = planningDateToday(settings.profile.planningTimeZone);
          setRoutineForm((current) =>
            current.startsOn === fallbackStart ? { ...current, startsOn: today } : current,
          );
        })
        .catch(() => setPlanProfile(null));
    void application
      .listAxes()
      .then((nextAxes) => {
        setAxes(nextAxes);
        return application.listProjects();
      })
      .then(setProjects)
      .catch(() => setError(uiMessage('actions-ui.208')));
    dialog.current?.showModal();
    // Focus the title in the same task so no other control (such as Close) is announced first.
    // Next frame, restore it only if the re-rendered form lost focus; never pull focus back from
    // any control the person already moved to.
    const opened = dialog.current;
    if (opened !== null) autofocusIn(opened, opened.querySelector<HTMLElement>('input[required]'));
    window.requestAnimationFrame(() => {
      const current = dialog.current;
      if (current !== null && mayMoveAutofocus(current) && !focusIsOnField(current))
        autofocusIn(current, current.querySelector<HTMLElement>('input[required]'));
    });
  };

  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (event.altKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [location.pathname]);

  const close = (): void => {
    if (form.title.trim().length > 0 && !window.confirm(uiMessage('actions-ui.209'))) return;
    dialog.current?.close();
    opener.current?.focus();
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (intent === null || busy) return;
    if (repeat && planning !== null) {
      await submitRoutine();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await application.capture(intent, toInput(form));
      if (!result.ok) {
        setError(applicationMessage(result.error));
        if (isCrossAxisRejection(result.error)) setCrossAxisPrompt(pairKey(form));
        else focusTitle();
        return;
      }
      dialog.current?.close();
      setForm(emptyForm);
      setIntent(null);
      window.dispatchEvent(new Event('yelaxis:actions-changed'));
      setAnnouncement(uiMessage('actions-ui.211'));
      opener.current?.focus();
    } catch {
      setError(uiMessage('actions-ui.212'));
      focusTitle();
    } finally {
      setBusy(false);
    }
  };

  const submitRoutine = async (): Promise<void> => {
    if (planning === null) return;
    const built = buildRoutineInput(
      {
        ...routineForm,
        title: form.title,
        note: form.note,
        projectId: form.projectId,
        estimate: form.estimate,
        energy: form.energy,
        priority: form.priority,
      },
      planProfile?.weekStart ?? 'monday',
      { axisId: form.axisId },
    );
    if (!built.ok) {
      setError(built.errors.join(' '));
      focusTitle();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await planning.createRoutine(built.value);
      if (!result.ok) {
        setError(routineErrorMessage(result.error));
        focusTitle();
        return;
      }
      dialog.current?.close();
      setForm(emptyForm);
      setRepeat(false);
      setIntent(null);
      notifyPlanChanged();
      setAnnouncement(uiMessage('actions-ui.213'));
      opener.current?.focus();
    } catch {
      setError(uiMessage('actions-ui.214'));
      focusTitle();
    } finally {
      setBusy(false);
    }
  };

  const repeatControl =
    planning === null ? undefined : (
      <fieldset className="optional-section">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={repeat}
            onChange={(event) => setRepeat(event.target.checked)}
          />
          {uiMessage('actions-ui.215')}
        </label>
        <p className="field-help">{uiMessage('actions-ui.216')}</p>
        {repeat && (
          <div className="nested-fields">
            <RoutinePatternFields
              compact
              form={routineForm}
              set={setRoutineField}
              weekStart={planProfile?.weekStart ?? 'monday'}
              {...(planProfile === null ? {} : { planningZone: planProfile.planningTimeZone })}
            />
            <RoutinePreview
              count={5}
              form={routineForm}
              planning={planning}
              profile={planProfile}
            />
          </div>
        )}
      </fieldset>
    );

  return (
    <>
      <button
        className="capture-trigger"
        type="button"
        ref={opener}
        onClick={open}
        aria-keyshortcuts="Alt+C"
      >
        {uiMessage('actions-ui.217')}
        <kbd>{uiMessage('actions-ui.218')}</kbd>
      </button>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      <dialog
        className="action-dialog capture-dialog"
        ref={dialog}
        aria-labelledby="capture-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <form onSubmit={(event) => void submit(event)}>
          <div className="dialog-heading">
            <div>
              <p className="eyebrow">{uiMessage('actions-ui.219')}</p>
              <h2 id="capture-title">{uiMessage('actions-ui.220')}</h2>
            </div>
            <button type="button" className="text-button" onClick={close}>
              {uiMessage('actions-ui.221')}
            </button>
          </div>
          {error !== null && (
            <p className="validation-summary" role="alert">
              {error}
            </p>
          )}
          <ActionFields
            form={form}
            setForm={setForm}
            axes={axes}
            projects={projects}
            autoFocus
            compact
            crossAxis={
              !(repeat && planning !== null) &&
              (crossAxisPending(form, noPair, projects) || crossAxisPrompt === pairKey(form))
            }
            repeating={repeat && planning !== null}
            {...(repeatControl === undefined ? {} : { repeatControl })}
          />
          <div className="dialog-actions">
            <button type="button" onClick={close}>
              {uiMessage('account.account-dialogs.20')}
            </button>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy
                ? uiMessage('account.conflicts-page.133')
                : repeat && planning !== null
                  ? uiMessage('actions-ui.222')
                  : uiMessage('actions-ui.223')}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

export function InboxPage({ application }: { readonly application: ActionApplication }): ReactNode {
  const [page, setPage] = useState<InboxProjection | null>(null);
  const [cursors, setCursors] = useState<readonly (InboxProjection['nextCursor'] | undefined)[]>([
    undefined,
  ]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<Map<UUID, number>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoId, setUndoId] = useState<UUID | null>(null);
  const [planDate, setPlanDate] = useState(todayString());
  const [planHorizon, setPlanHorizon] = useState<'day' | 'week' | 'month'>('day');
  const [bulkAxis, setBulkAxis] = useState('');
  const [bulkProject, setBulkProject] = useState('');
  /** Which bulk change the application asked to confirm across Axes, and for which value. */
  const [bulkCrossAxis, setBulkCrossAxis] = useState<string | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [axes, setAxes] = useState<readonly ActionChoice[]>([]);
  const [projects, setProjects] = useState<readonly ActionChoice[]>([]);
  const [milestones, setMilestones] = useState<readonly MilestoneChoice[]>([]);

  const load = async (index = pageIndex): Promise<void> => {
    setError(null);
    try {
      setPage(
        await application.listInbox({
          limit: 50,
          ...(cursors[index] === undefined ? {} : { after: cursors[index] }),
        }),
      );
    } catch {
      setError(uiMessage('actions-ui.224'));
    }
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      await load();
      const nextAxes = await application.listAxes();
      const nextProjects = await application.listProjects();
      if (active) {
        setAxes(nextAxes);
        setProjects(nextProjects);
      }
    })().catch(() => {
      if (active) setError(uiMessage('actions-ui.224'));
    });
    return () => {
      active = false;
    };
  }, [pageIndex]);
  useEffect(() => {
    // The Milestone choice is optional: without it, Plan still works exactly as before.
    let active = true;
    application.listMilestones().then(
      (choices) => {
        if (active) setMilestones(choices);
      },
      () => {
        if (active) setMilestones([]);
      },
    );
    return () => {
      active = false;
    };
  }, [application]);
  useEffect(() => {
    const refresh = (): void => {
      void load();
    };
    window.addEventListener('yelaxis:actions-changed', refresh);
    return () => window.removeEventListener('yelaxis:actions-changed', refresh);
  });

  /** Run one Inbox command; returns the rejection, or null once it committed. */
  const apply = async (
    operation: () => ReturnType<ActionApplication['triage']>,
  ): Promise<ApplicationError | null> => {
    if (busy) return null;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (!result.ok) {
        // Reload first: a reload clears the previous message, and this one must stay visible.
        await load();
        setError(applicationMessage(result.error));
        return result.error;
      }
      setUndoId(result.value.undo.available ? result.value.undo.undoId : null);
      setSelected(new Map());
      await load();
      return null;
    } catch {
      setError(uiMessage('actions-ui.225'));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const bulk = async (kind: BulkChange): Promise<void> => {
    if (selected.size === 0) return;
    if (
      (kind.kind === 'archive' || kind.kind === 'cancel') &&
      !window.confirm(
        uiMessage('actions-ui.226', {
          value0: kind.kind === 'archive' ? 'Archive' : 'Cancel',
          value1: String(selected.size),
        }),
      )
    )
      return;
    const failure = await apply(() =>
      application.bulk(
        [...selected].map(([id, revision]) => ({ id, revision })),
        kind,
      ),
    );
    if (failure !== null && isCrossAxisRejection(failure)) {
      setBulkCrossAxis(bulkPromptKey(kind));
      setBulkConfirm(false);
    } else if (failure === null) {
      setBulkCrossAxis(null);
      setBulkConfirm(false);
    }
  };
  const bulkPromptKey = (kind: BulkChange): string =>
    kind.kind === 'axis'
      ? `axis|${kind.axisId ?? ''}`
      : kind.kind === 'project'
        ? `project|${kind.projectId ?? ''}`
        : kind.kind;
  const bulkAxisChange: BulkChange = {
    kind: 'axis',
    ...(bulkAxis === '' ? {} : { axisId: bulkAxis }),
  };
  const bulkProjectChange: BulkChange = {
    kind: 'project',
    ...(bulkProject === '' ? {} : { projectId: bulkProject }),
  };
  const confirmedBulk = (change: BulkChange): BulkChange =>
    bulkConfirm &&
    bulkCrossAxis === bulkPromptKey(change) &&
    (change.kind === 'axis' || change.kind === 'project')
      ? { ...change, confirmCrossAxis: true }
      : change;
  const bulkCrossAxisControl = (change: BulkChange): ReactNode =>
    bulkCrossAxis === bulkPromptKey(change) ? (
      <label className="compact-check">
        <span>
          <input
            type="checkbox"
            checked={bulkConfirm}
            onChange={(event) => setBulkConfirm(event.target.checked)}
          />{' '}
          {uiMessage('actions-ui.227')}
        </span>
      </label>
    ) : null;
  const selectAll = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const all = await application.listAllInbox();
      setSelected(new Map(all.map(({ ref, revision }) => [ref.id, revision])));
    } catch {
      setError(uiMessage('actions-ui.228'));
    } finally {
      setBusy(false);
    }
  };
  const undo = async (): Promise<void> => {
    if (undoId === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await application.undo(undoId);
      if (!result.ok) setError(applicationMessage(result.error));
      else {
        setUndoId(null);
        await load();
      }
    } catch {
      setError(uiMessage('actions-ui.229'));
    } finally {
      setBusy(false);
    }
  };

  if (page === null && error !== null)
    return (
      <section className="content-section inbox-page" aria-labelledby="page-title">
        <p className="eyebrow">{uiMessage('actions-ui.230')}</p>
        <h1 id="page-title">{uiMessage('actions-ui.231')}</h1>
        <p className="validation-summary" role="alert">
          {error}
        </p>
        <button type="button" onClick={() => void load()}>
          {uiMessage('account.account-dialogs.47')}
        </button>
      </section>
    );
  if (page === null)
    return (
      <section className="content-section inbox-page" aria-busy="true">
        <p className="eyebrow">{uiMessage('actions-ui.230')}</p>
        <h1>{uiMessage('actions-ui.232')}</h1>
      </section>
    );
  return (
    <section className="content-section inbox-page" aria-labelledby="page-title" aria-busy={busy}>
      <div className="page-heading-row">
        <div>
          <p className="eyebrow">{uiMessage('actions-ui.230')}</p>
          <h1 id="page-title">{uiMessage('actions-ui.233')}</h1>
        </div>
        <span className="count-badge">{page.total}</span>
      </div>
      <p className="page-message">{uiMessage('actions-ui.234')}</p>
      {error !== null && (
        <p className="validation-summary" role="alert">
          {error}
        </p>
      )}
      {undoId !== null && (
        <div className="undo-bar" role="status">
          <span>{uiMessage('actions-ui.235')}</span>
          <button type="button" onClick={() => void undo()}>
            {uiMessage('actions-ui.236')}
          </button>
        </div>
      )}
      {page.items.length === 0 ? (
        <div className="inbox-empty">
          <h2>{uiMessage('actions-ui.237')}</h2>
          <p>{uiMessage('actions-ui.238')}</p>
          <p>
            <kbd>{uiMessage('actions-ui.218')}</kbd>
            {uiMessage('actions-ui.239')}
          </p>
        </div>
      ) : (
        <>
          <section className="bulk-bar" aria-label={uiMessage('actions-ui.240')}>
            <strong aria-live="polite">
              {selected.size}
              {uiMessage('actions-ui.241')}
            </strong>
            <button type="button" disabled={busy} onClick={() => void selectAll()}>
              {uiMessage('actions-ui.242')}
              {page.total}
            </button>
            <button
              type="button"
              disabled={selected.size === 0 || busy}
              onClick={() => setSelected(new Map())}
            >
              {uiMessage('actions-ui.243')}
            </button>
            <label>
              {uiMessage('actions-ui.244')}
              <input
                type="date"
                value={planDate}
                onChange={(event) => setPlanDate(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={selected.size === 0 || busy}
              onClick={() => void bulk({ kind: 'do', date: planDate })}
            >
              {uiMessage('actions-ui.245')}
            </button>
            <label>
              {uiMessage('actions-ui.246')}
              <select
                value={planHorizon}
                onChange={(event) => setPlanHorizon(event.target.value as typeof planHorizon)}
              >
                <option value="day">{uiMessage('actions-ui.247')}</option>
                <option value="week">{uiMessage('actions-ui.248')}</option>
                <option value="month">{uiMessage('actions-ui.249')}</option>
              </select>
            </label>
            <button
              type="button"
              disabled={selected.size === 0 || busy}
              onClick={() =>
                void bulk({ kind: 'plan', period: { kind: planHorizon, date: planDate } })
              }
            >
              {uiMessage('actions-ui.250')}
            </button>
            <label>
              {uiMessage('actions-ui.251')}
              <select value={bulkAxis} onChange={(event) => setBulkAxis(event.target.value)}>
                <option value="">{uiMessage('actions-ui.252')}</option>
                {axes.map(choiceOption)}
              </select>
            </label>
            {bulkCrossAxisControl(bulkAxisChange)}
            <button
              type="button"
              disabled={selected.size === 0 || busy}
              onClick={() => void bulk(confirmedBulk(bulkAxisChange))}
            >
              {uiMessage('actions-ui.253')}
            </button>
            <label>
              {uiMessage('actions-ui.254')}
              <select value={bulkProject} onChange={(event) => setBulkProject(event.target.value)}>
                <option value="">{uiMessage('actions-ui.255')}</option>
                {projects.map(choiceOption)}
              </select>
            </label>
            {bulkCrossAxisControl(bulkProjectChange)}
            <button
              type="button"
              disabled={selected.size === 0 || busy}
              onClick={() => void bulk(confirmedBulk(bulkProjectChange))}
            >
              {uiMessage('actions-ui.256')}
            </button>
            <button
              type="button"
              disabled={selected.size === 0 || busy}
              onClick={() => void bulk({ kind: 'complete' })}
            >
              {uiMessage('actions-ui.257')}
            </button>
            <button
              type="button"
              disabled={selected.size === 0 || busy}
              onClick={() => void bulk({ kind: 'cancel' })}
            >
              {uiMessage('account.account-dialogs.20')}
            </button>
            <button
              type="button"
              disabled={selected.size === 0 || busy}
              onClick={() => void bulk({ kind: 'archive' })}
            >
              {uiMessage('actions-ui.258')}
            </button>
          </section>
          <ul className="inbox-list" aria-label={uiMessage('actions-ui.259')}>
            {page.items.map((item, index) => (
              <InboxRow
                key={item.id}
                item={item}
                selected={selected.has(item.id)}
                setSelected={setSelected}
                application={application}
                projects={projects}
                milestones={milestones}
                busy={busy}
                apply={apply}
                onReorder={(direction) =>
                  apply(() => application.reorder(item.id, item.localRevision, direction))
                }
                first={index === 0 && pageIndex === 0}
                last={index === page.items.length - 1 && page.nextCursor === undefined}
              />
            ))}
          </ul>
          <nav className="pager" aria-label={uiMessage('actions-ui.260')}>
            <button
              type="button"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((value) => value - 1)}
            >
              {uiMessage('actions-ui.261')}
            </button>
            <span>
              {uiMessage('actions-ui.262')}
              {pageIndex + 1}
            </span>
            <button
              type="button"
              disabled={page.nextCursor === undefined}
              onClick={() => {
                if (page.nextCursor !== undefined) {
                  setCursors((current) => [...current.slice(0, pageIndex + 1), page.nextCursor]);
                  setPageIndex((value) => value + 1);
                }
              }}
            >
              {uiMessage('actions-ui.263')}
            </button>
          </nav>
        </>
      )}
    </section>
  );
}

function InboxRow({
  application,
  apply,
  busy,
  first,
  item,
  last,
  milestones,
  onReorder,
  projects,
  selected,
  setSelected,
}: {
  readonly application: ActionApplication;
  readonly apply: (
    operation: () => ReturnType<ActionApplication['triage']>,
  ) => Promise<ApplicationError | null>;
  readonly busy: boolean;
  readonly first: boolean;
  readonly item: InboxProjection['items'][number];
  readonly last: boolean;
  readonly milestones: readonly MilestoneChoice[];
  readonly onReorder: (direction: 'up' | 'down') => Promise<unknown>;
  readonly projects: readonly ActionChoice[];
  readonly selected: boolean;
  readonly setSelected: React.Dispatch<React.SetStateAction<Map<UUID, number>>>;
}): ReactNode {
  const [date, setDate] = useState(todayString());
  const [horizon, setHorizon] = useState<'day' | 'week' | 'month'>('day');
  const [projectId, setProjectId] = useState('');
  const [milestoneId, setMilestoneId] = useState('');
  /** The Project the application asked to confirm across Axes, and whether the person did. */
  const [crossAxisProject, setCrossAxisProject] = useState<string | null>(null);
  const [confirmCrossAxis, setConfirmCrossAxis] = useState(false);
  const [timed, setTimed] = useState(false);
  const idBase = useId();
  const plan = async (): Promise<void> => {
    const confirmed = confirmCrossAxis && crossAxisProject === projectId;
    const failure = await apply(() =>
      application.triage(item.id, item.localRevision, {
        kind: 'plan',
        period: { kind: horizon, date },
        ...(projectId === '' ? {} : { projectId }),
        ...(milestoneId === '' ? {} : { milestoneId }),
        ...(confirmed ? { confirmCrossAxis: true } : {}),
      }),
    );
    if (failure !== null && isCrossAxisRejection(failure)) {
      setCrossAxisProject(projectId);
      setConfirmCrossAxis(false);
    }
  };
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('09:30');
  const toggle = (): void =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item.localRevision);
      return next;
    });
  return (
    <li className={selected ? 'selected' : undefined}>
      <div className="inbox-row-main">
        <label className="selection-control">
          <input type="checkbox" checked={selected} onChange={toggle} />
          <span className="sr-only">
            {uiMessage('actions-ui.264')}
            {item.title}
          </span>
        </label>
        <div className="inbox-copy">
          <Link to={`/actions/${item.id}`}>{item.title}</Link>
          <small>{inboxMetadata(item)}</small>
        </div>
        <div
          className="reorder-controls"
          aria-label={uiMessage('actions-ui.265', { value0: item.title })}
        >
          <button
            type="button"
            disabled={first || busy}
            onClick={() => void onReorder('up')}
            aria-label={uiMessage('actions-ui.266', { value0: item.title })}
          >
            ↑
          </button>
          <button
            type="button"
            disabled={last || busy}
            onClick={() => void onReorder('down')}
            aria-label={uiMessage('actions-ui.267', { value0: item.title })}
          >
            ↓
          </button>
        </div>
      </div>
      <details className="triage-panel">
        <summary>{uiMessage('actions-ui.268')}</summary>
        <div className="triage-actions">
          <label className="compact-check">
            <span>
              <input
                type="checkbox"
                checked={timed}
                onChange={(event) => setTimed(event.target.checked)}
              />{' '}
              {uiMessage('actions-ui.269')}
            </span>
          </label>
          {timed && (
            <>
              <label>
                {uiMessage('actions-ui.270')}
                <input
                  type="time"
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                />
              </label>
              <label>
                {uiMessage('actions-ui.271')}
                <input
                  type="time"
                  value={endTime}
                  onChange={(event) => setEndTime(event.target.value)}
                />
              </label>
            </>
          )}
          <button
            type="button"
            onClick={() =>
              void apply(() =>
                application.triage(item.id, item.localRevision, {
                  kind: 'do',
                  date,
                  ...(timed ? { schedule: { date, startTime, endTime } } : {}),
                }),
              )
            }
          >
            {uiMessage('actions-ui.272')}
            {timed ? uiMessage('actions-ui.273') : uiMessage('actions-ui.2439')}
          </button>
          <label>
            {uiMessage('actions-ui.246')}
            <select
              value={horizon}
              onChange={(event) => setHorizon(event.target.value as typeof horizon)}
            >
              <option value="day">{uiMessage('actions-ui.247')}</option>
              <option value="week">{uiMessage('actions-ui.248')}</option>
              <option value="month">{uiMessage('actions-ui.249')}</option>
            </select>
          </label>
          <label>
            {uiMessage('actions-ui.274')}
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label>
            {uiMessage('actions-ui.254')}
            <select
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setConfirmCrossAxis(false);
              }}
            >
              <option value="">{uiMessage('actions-ui.275')}</option>
              {projects.map(choiceOption)}
            </select>
          </label>
          {crossAxisProject !== null && crossAxisProject === projectId && (
            <label className="compact-check" htmlFor={`${idBase}-cross-axis`}>
              <span>
                <input
                  id={`${idBase}-cross-axis`}
                  type="checkbox"
                  checked={confirmCrossAxis}
                  onChange={(event) => setConfirmCrossAxis(event.target.checked)}
                />{' '}
                {uiMessage('actions-ui.227')}
              </span>
            </label>
          )}
          {milestones.length > 0 && (
            <label>
              {uiMessage('actions-ui.276')}
              <select value={milestoneId} onChange={(event) => setMilestoneId(event.target.value)}>
                <option value="">{uiMessage('actions-ui.277')}</option>
                {milestones.map((milestone) => (
                  <option key={milestone.id} value={milestone.id}>
                    {milestone.title} · {milestone.outcomeTitle}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" onClick={() => void plan()}>
            {uiMessage('actions-ui.250')}
          </button>
          <button
            type="button"
            onClick={() =>
              void apply(() =>
                application.triage(item.id, item.localRevision, { kind: 'keep_note' }),
              )
            }
          >
            {uiMessage('actions-ui.278')}
          </button>
          <button
            type="button"
            onClick={() =>
              void apply(() =>
                application.triage(item.id, item.localRevision, { kind: 'keep_project' }),
              )
            }
          >
            {uiMessage('actions-ui.279')}
          </button>
          <button
            type="button"
            onClick={() =>
              void apply(() =>
                application.triage(item.id, item.localRevision, { kind: 'complete' }),
              )
            }
          >
            {uiMessage('actions-ui.257')}
          </button>
          <button
            type="button"
            onClick={() =>
              void apply(() => application.triage(item.id, item.localRevision, { kind: 'cancel' }))
            }
          >
            {uiMessage('account.account-dialogs.20')}
          </button>
          <button
            type="button"
            onClick={() =>
              void apply(() => application.triage(item.id, item.localRevision, { kind: 'archive' }))
            }
          >
            {uiMessage('actions-ui.258')}
          </button>
        </div>
      </details>
    </li>
  );
}

export function ActionDetailPage({
  application,
}: {
  readonly application: ActionApplication;
}): ReactNode {
  const { actionId = '' } = useParams();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<
    (ActionWorkspace & { readonly overdue: boolean }) | null | undefined
  >(undefined);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [baseline, setBaseline] = useState('');
  const [axes, setAxes] = useState<readonly ActionChoice[]>([]);
  const [projects, setProjects] = useState<readonly ActionChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoId, setUndoId] = useState<UUID | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState('');
  const [crossAxisPrompt, setCrossAxisPrompt] = useState<string | null>(null);
  const planning = usePlanningOptional();
  // Only a loaded Action can have unsaved edits: never while it is opening or when it is
  // unavailable (for example after a permanent delete).
  const dirty = workspace !== undefined && workspace !== null && JSON.stringify(form) !== baseline;
  const load = async (): Promise<void> => {
    const result = await application.getAction(actionId);
    setWorkspace(result);
    if (result !== null) {
      const next = formFromWorkspace(result);
      setForm(next);
      setBaseline(JSON.stringify(next));
    }
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      await load();
      const nextAxes = await application.listAxes();
      const nextProjects = await application.listProjects();
      if (active) {
        setAxes(nextAxes);
        setProjects(nextProjects);
      }
    })().catch(() => {
      if (active) {
        setWorkspace(null);
        setError(uiMessage('actions-ui.280'));
      }
    });
    return () => {
      active = false;
    };
  }, [actionId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    const guardLinks = (event: MouseEvent): void => {
      if (!dirty || event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      const link = target instanceof Element ? target.closest('a[href]') : null;
      if (link !== null && !window.confirm(uiMessage('actions-ui.281'))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('click', guardLinks, true);
    return () => document.removeEventListener('click', guardLinks, true);
  }, [dirty]);
  if (workspace === undefined)
    return (
      <section className="content-section" aria-busy="true">
        <p className="eyebrow">{uiMessage('actions-ui.282')}</p>
        <h1>{uiMessage('actions-ui.283')}</h1>
      </section>
    );
  if (workspace === null)
    return (
      <section className="content-section">
        <p className="eyebrow">{uiMessage('actions-ui.282')}</p>
        <h1>{error === null ? uiMessage('actions-ui.284') : uiMessage('actions-ui.285')}</h1>
        {error === null ? (
          <p className="page-message">{uiMessage('actions-ui.286')}</p>
        ) : (
          <p className="validation-summary" role="alert">
            {error}
          </p>
        )}
        {error !== null && (
          <button type="button" onClick={() => void load()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        )}
        <Link className="inline-button" to="/inbox">
          {uiMessage('actions-ui.287')}
        </Link>
      </section>
    );
  const actionDocument = workspace.action.document as ActionCanonicalDocument;
  const run = async (operation: () => ReturnType<ActionApplication['edit']>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setError(applicationMessage(result.error));
        if (isCrossAxisRejection(result.error)) {
          // Keep the unsaved choice on screen with the confirmation next to it.
          setCrossAxisPrompt(pairKey(form));
          return false;
        }
        await load();
        return false;
      }
      setCrossAxisPrompt(null);
      setUndoId(result.value.undo.available ? result.value.undo.undoId : null);
      await load();
      return true;
    } catch {
      setError(uiMessage('actions-ui.225'));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    await run(() => application.edit(actionId, workspace.action.localRevision, toInput(form)));
  };
  const transition = (to: ActionState): void => {
    void run(() => application.transition(actionId, workspace.action.localRevision, to));
  };
  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await application.deletePermanently(
        actionId,
        workspace.action.localRevision,
        confirmation,
      );
      if (!result.ok) {
        setError(applicationMessage(result.error));
        deleteDialog.current?.close();
        return;
      }
      deleteDialog.current?.close();
      void navigate('/inbox');
    } catch {
      setError(uiMessage('actions-ui.288'));
      deleteDialog.current?.close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="content-section action-detail"
      aria-labelledby="page-title"
      aria-busy={busy}
    >
      <Link className="back-link" to="/inbox">
        {uiMessage('actions-ui.289')}
      </Link>
      <p className="eyebrow">
        {uiMessage('actions-ui.290')}
        {actionDocument.state.replace('_', ' ')}
      </p>
      <h1 id="page-title">{actionDocument.title}</h1>
      <dl className="action-facts">
        <div>
          <dt>{uiMessage('actions-ui.291')}</dt>
          <dd>{new Date(workspace.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>{uiMessage('actions-ui.292')}</dt>
          <dd>{actionDocument.captureOrigin.replace('_', ' ')}</dd>
        </div>
        <div>
          <dt>{uiMessage('actions-ui.293')}</dt>
          <dd>{workspace.action.localRevision}</dd>
        </div>
        {workspace.overdue && (
          <div>
            <dt>{uiMessage('actions-ui.294')}</dt>
            <dd>{uiMessage('actions-ui.295')}</dd>
          </div>
        )}
        {workspace.placement !== null && (
          <div>
            <dt>{uiMessage('actions-ui.296')}</dt>
            <dd>{placementLabel(workspace.placement.document as PlacementDocument)}</dd>
          </div>
        )}
        {workspace.axisTitle !== undefined && (
          <div>
            <dt>{uiMessage('actions-ui.251')}</dt>
            <dd>{workspace.axisTitle}</dd>
          </div>
        )}
        {workspace.projectTitle !== undefined && (
          <div>
            <dt>{uiMessage('actions-ui.254')}</dt>
            <dd>{workspace.projectTitle}</dd>
          </div>
        )}
      </dl>
      {error !== null && (
        <p role="alert" className="validation-summary">
          {error}
        </p>
      )}
      {undoId !== null && (
        <div className="undo-bar" role="status">
          <span>{uiMessage('actions-ui.235')}</span>
          <button type="button" onClick={() => void run(() => application.undo(undoId))}>
            {uiMessage('actions-ui.236')}
          </button>
        </div>
      )}
      <form onSubmit={(event) => void save(event)}>
        <ActionFields
          form={form}
          setForm={setForm}
          axes={axes}
          projects={projects}
          crossAxis={
            crossAxisPending(
              form,
              { axisId: actionDocument.axisId ?? '', projectId: actionDocument.projectId ?? '' },
              projects,
            ) || crossAxisPrompt === pairKey(form)
          }
        />
        <div className="detail-actions">
          <button className="primary-button" type="submit" disabled={busy || !dirty}>
            {uiMessage('actions-ui.297')}
          </button>
          {actionDocument.state !== 'completed' && actionDocument.state !== 'archived' && (
            <button type="button" onClick={() => transition('completed')}>
              {uiMessage('actions-ui.257')}
            </button>
          )}
          {actionDocument.state !== 'canceled' && actionDocument.state !== 'archived' && (
            <button type="button" onClick={() => transition('canceled')}>
              {uiMessage('account.account-dialogs.20')}
            </button>
          )}
          {actionDocument.state !== 'archived' && (
            <button type="button" onClick={() => transition('archived')}>
              {uiMessage('actions-ui.258')}
            </button>
          )}
          {actionDocument.state === 'archived' &&
            actionDocument.stateBeforeArchive !== undefined && (
              <button type="button" onClick={() => transition(actionDocument.stateBeforeArchive!)}>
                {uiMessage('actions-ui.298')}
              </button>
            )}
          {(actionDocument.state === 'completed' || actionDocument.state === 'canceled') && (
            <button type="button" onClick={() => transition('planned')}>
              {uiMessage('actions-ui.299')}
            </button>
          )}
        </div>
      </form>
      <ActionMilestones actionId={workspace.action.ref.id} />
      {planning !== null && actionDocument.state !== 'archived' && (
        <RepeatAfterAction actionId={actionId} document={actionDocument} workspace={workspace} />
      )}
      <section className="danger-zone">
        <h2>{uiMessage('actions-ui.300')}</h2>
        <p>{uiMessage('actions-ui.301')}</p>
        <button
          className="destructive-button"
          type="button"
          onClick={() => {
            setConfirmation('');
            deleteDialog.current?.showModal();
          }}
        >
          {uiMessage('actions-ui.302')}
        </button>
      </section>
      <dialog className="action-dialog" ref={deleteDialog} aria-labelledby="delete-title">
        <h2 id="delete-title">{uiMessage('actions-ui.303')}</h2>
        <p>{uiMessage('actions-ui.304')}</p>
        <p>
          {uiMessage('actions-ui.305')}
          <strong>{actionDocument.title}</strong>
        </p>
        <label className="field-label">
          {uiMessage('actions-ui.306')}
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={() => deleteDialog.current?.close()}>
            {uiMessage('account.account-dialogs.20')}
          </button>
          <button
            className="destructive-button"
            type="button"
            disabled={confirmation !== actionDocument.title || busy}
            onClick={() => void remove()}
          >
            {busy ? uiMessage('account.account-dialogs.69') : uiMessage('actions-ui.307')}
          </button>
        </div>
      </dialog>
    </section>
  );
}

/**
 * First date for "Repeat after this". It follows the command's reference date: the Action's day
 * placement, else its planned block's local date in the planning zone, else its due date, else
 * planning-zone today. The Routine starts the day after that reference, and never before today.
 */
export function repeatStartDate(
  workspace: ActionWorkspace,
  planningTimeZone: IanaTimeZone | null | undefined,
  today: string,
): string {
  const placement = workspace.placement?.document as PlacementDocument | undefined;
  const block = workspace.plannedBlock?.document as BlockDocument | undefined;
  const due = (workspace.action.document as ActionCanonicalDocument).due;
  const reference =
    placement?.period.kind === 'day'
      ? placement.period.date
      : block !== undefined
        ? formatInstantInZone(block.startsAt, planningTimeZone ?? block.timeZone).date
        : due?.kind === 'date'
          ? due.date
          : today;
  const next = shiftDate(reference, 1);
  return next < today ? today : next;
}

/**
 * "Repeat after this": the Action stays a one-off and a new Routine starts after it, through the
 * shared Routine engine. Rendered only inside the planning provider.
 */
function RepeatAfterAction({
  actionId,
  document,
  workspace,
}: {
  readonly actionId: string;
  readonly document: ActionCanonicalDocument;
  readonly workspace: ActionWorkspace;
}): ReactNode {
  const planning = usePlanningOptional();
  const zone = usePlanningZone();
  const startsOn = repeatStartDate(workspace, zone, planningDateToday(zone));
  const runner = useCommandRunner();
  const [open, setOpen] = useState(false);
  const [routineId, setRoutineId] = useState<string | null>(null);
  if (planning === null) return null;
  const initial: RoutineFormState = {
    ...emptyRoutineForm(startsOn),
    title: document.title,
    note: document.note ?? '',
    projectId: document.projectId ?? '',
    estimate: document.estimateMinutes?.toString() ?? '',
    energy: document.energy ?? '',
    priority: document.priority ?? '',
  };
  return (
    <section className="repeat-after" aria-labelledby="repeat-after-title">
      <h2 id="repeat-after-title">{uiMessage('actions-ui.215')}</h2>
      <p className="field-help">{uiMessage('actions-ui.308')}</p>
      <CommandFeedback runner={runner} />
      {routineId !== null && (
        <p>
          <Link to={routinePath(routineId)}>{uiMessage('actions-ui.309')}</Link>
        </p>
      )}
      <button type="button" disabled={runner.busy} onClick={() => setOpen(true)}>
        {uiMessage('actions-ui.310')}
      </button>
      <Modal
        open={open}
        eyebrow={uiMessage('actions-ui.215')}
        title={uiMessage('actions-ui.311')}
        description={uiMessage('actions-ui.312')}
        onClose={() => setOpen(false)}
      >
        <RoutineForm
          initial={initial}
          planning={planning}
          submitLabel={uiMessage('actions-ui.222')}
          onCancel={() => setOpen(false)}
          onSubmit={async (input) => {
            const result = await runCommand(
              runner,
              () =>
                planning.repeatAfterAction({
                  ...input,
                  ...(document.axisId === undefined ? {} : { axisId: document.axisId }),
                  actionId,
                }),
              uiMessage('actions-ui.313'),
            );
            if (result.message === null) {
              setOpen(false);
              setRoutineId(
                result.receipt?.canonical.find((change) => change.ref.type === 'routine')?.ref.id ??
                  null,
              );
            }
            return result.message;
          }}
        />
      </Modal>
    </section>
  );
}

/**
 * Milestones this Action supports (`milestone_action` links), with Link and Unlink. Rendered only
 * when the alignment services are available; the links never change the Action or a Milestone.
 */
function ActionMilestones({ actionId }: { readonly actionId: string }): ReactNode {
  const alignment = useAlignmentOptional();
  if (alignment === null) return null;
  return <ActionMilestonesSection actionId={actionId} alignment={alignment} />;
}

function ActionMilestonesSection({
  actionId,
  alignment,
}: {
  readonly actionId: string;
  readonly alignment: AlignmentApplication;
}): ReactNode {
  const runner = useCommandRunner();
  const headingId = useId();
  const { state, reload } = usePlanQuery(
    () => alignment.getNeighborhood({ kind: 'action', id: actionId }),
    [alignment, actionId],
  );
  const [linkOpen, setLinkOpen] = useState(false);
  const [unlink, setUnlink] = useState<{
    readonly edge: AlignmentEdge;
    readonly open: boolean;
  } | null>(null);
  const neighborhood = state.status === 'ready' ? state.data : null;
  const milestones =
    neighborhood?.above.filter((edge) => edge.relationship === 'milestone_action') ?? [];
  const total = Math.max(neighborhood?.totals.milestone_action ?? 0, milestones.length);
  return (
    <section className="action-milestones" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('actions-ui.314')}</h2>
      <p className="field-help">{uiMessage('actions-ui.315')}</p>
      <CommandFeedback runner={runner} showError={!linkOpen && unlink?.open !== true} />
      {state.status === 'loading' ? (
        <p className="field-help" role="status">
          {uiMessage('actions-ui.316')}
        </p>
      ) : state.status === 'error' ? (
        <div className="horizon-error">
          <p role="alert">{state.message}</p>
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      ) : neighborhood === null ? null : (
        <>
          {milestones.length === 0 ? (
            <p className="quiet-empty">{uiMessage('actions-ui.317')}</p>
          ) : (
            <ul className="action-milestone-list" aria-label={uiMessage('actions-ui.318')}>
              {milestones.map((edge) => (
                <li key={edge.linkId ?? edge.other.id}>
                  <Link to={milestonePath(edge.other.id)}>{edge.other.title}</Link>
                  <span className="status-pill">{stateText(edge.other.state)}</span>
                  <button type="button" onClick={() => setUnlink({ edge, open: true })}>
                    {uiMessage('actions-ui.319')}
                    <span className="sr-only">{edge.other.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {total > milestones.length && (
            <p className="field-help">
              {uiMessage('actions-ui.320')}
              {milestones.length}
              {uiMessage('actions-ui.321')}
              {total}.
            </p>
          )}
          {neighborhood.focus.archived ? (
            <p className="field-help">{uiMessage('actions-ui.322')}</p>
          ) : (
            <button type="button" onClick={() => setLinkOpen(true)}>
              {uiMessage('actions-ui.323')}
            </button>
          )}
          <LinkDialog
            open={linkOpen}
            focus={neighborhood.focus}
            relationships={['milestone_action']}
            runner={runner}
            onClose={() => setLinkOpen(false)}
          />
          {unlink !== null && (
            <UnlinkDialog
              open={unlink.open}
              focus={neighborhood.focus}
              edge={unlink.edge}
              runner={runner}
              onClose={() =>
                setUnlink((current) => (current === null ? null : { ...current, open: false }))
              }
            />
          )}
        </>
      )}
    </section>
  );
}

function ActionFields({
  autoFocus = false,
  axes,
  compact = false,
  crossAxis = false,
  form,
  projects,
  repeatControl,
  repeating = false,
  setForm,
}: {
  readonly autoFocus?: boolean;
  readonly axes: readonly ActionChoice[];
  readonly compact?: boolean;
  /** The chosen Project is in a different Axis: ask for an explicit confirmation. */
  readonly crossAxis?: boolean;
  readonly form: FormState;
  readonly projects: readonly ActionChoice[];
  /** Optional Repeat control (capture only); when repeating, one-off date fields are hidden. */
  readonly repeatControl?: ReactNode;
  readonly repeating?: boolean;
  readonly setForm: React.Dispatch<React.SetStateAction<FormState>>;
}): ReactNode {
  const crossAxisId = useId();
  const set = <Key extends keyof FormState>(key: Key, value: FormState[Key]): void =>
    setForm((current) => ({
      ...current,
      [key]: value,
      // A confirmation covers one Axis/Project pair only.
      ...(key === 'axisId' || key === 'projectId' ? { confirmCrossAxis: false } : {}),
    }));
  const crossAxisControl = crossAxis ? (
    <div className="cross-axis-confirm">
      <label className="toggle-row" htmlFor={crossAxisId}>
        <input
          id={crossAxisId}
          type="checkbox"
          checked={form.confirmCrossAxis}
          aria-describedby={`${crossAxisId}-help`}
          onChange={(event) => set('confirmCrossAxis', event.target.checked)}
        />
        {uiMessage('actions-ui.227')}
      </label>
      <p id={`${crossAxisId}-help`} className="field-help">
        {uiMessage('actions-ui.324')}
      </p>
    </div>
  ) : null;
  const titleField = (
    <label className="field-label">
      {uiMessage('actions-ui.325')}
      <span>{uiMessage('actions-ui.326')}</span>
      <input
        autoFocus={autoFocus}
        required
        maxLength={200}
        value={form.title}
        onChange={(event) => set('title', event.target.value)}
      />
    </label>
  );
  const fields = (
    <>
      <label className="field-label">
        {uiMessage('actions-ui.327')}
        <span>{uiMessage('actions-ui.328')}</span>
        <textarea
          rows={4}
          maxLength={10000}
          value={form.note}
          onChange={(event) => set('note', event.target.value)}
        />
      </label>
      <div className="two-column-fields">
        <label className="field-label">
          {uiMessage('actions-ui.251')}
          <select value={form.axisId} onChange={(event) => set('axisId', event.target.value)}>
            <option value="">{uiMessage('actions-ui.329')}</option>
            {axes.map(choiceOption)}
          </select>
        </label>
        <label className="field-label">
          {uiMessage('actions-ui.254')}
          <select value={form.projectId} onChange={(event) => set('projectId', event.target.value)}>
            <option value="">{uiMessage('actions-ui.330')}</option>
            {projects.map(choiceOption)}
          </select>
        </label>
      </div>
      {!compact && crossAxisControl}
      {!repeating && (
        <div className="three-column-fields">
          <label className="field-label">
            {uiMessage('actions-ui.331')}
            <input
              type="date"
              value={form.plannedDate}
              onChange={(event) => set('plannedDate', event.target.value)}
            />
          </label>
          <label className="field-label">
            {uiMessage('actions-ui.332')}
            <input
              type="date"
              value={form.dueDate}
              onChange={(event) => set('dueDate', event.target.value)}
            />
          </label>
          <label className="field-label">
            {uiMessage('actions-ui.333')}
            <span>{uiMessage('actions-ui.334')}</span>
            <input
              type="time"
              value={form.dueTime}
              disabled={form.dueDate === ''}
              onChange={(event) => set('dueTime', event.target.value)}
            />
          </label>
        </div>
      )}
      <div className="three-column-fields">
        <label className="field-label">
          {uiMessage('actions-ui.335')}
          <span>{uiMessage('actions-ui.336')}</span>
          <input
            type="number"
            min="1"
            max="10080"
            value={form.estimate}
            onChange={(event) => set('estimate', event.target.value)}
          />
        </label>
        <label className="field-label">
          {uiMessage('actions-ui.337')}
          <select value={form.energy} onChange={(event) => set('energy', event.target.value)}>
            <option value="">{uiMessage('actions-ui.338')}</option>
            <option value="low">{uiMessage('actions-ui.339')}</option>
            <option value="medium">{uiMessage('actions-ui.340')}</option>
            <option value="high">{uiMessage('actions-ui.341')}</option>
            <option value="focused">{uiMessage('actions-ui.342')}</option>
          </select>
        </label>
        <label className="field-label">
          {uiMessage('actions-ui.343')}
          <select value={form.priority} onChange={(event) => set('priority', event.target.value)}>
            <option value="">{uiMessage('actions-ui.344')}</option>
            <option value="low">{uiMessage('actions-ui.339')}</option>
            <option value="normal">{uiMessage('actions-ui.345')}</option>
            <option value="high">{uiMessage('actions-ui.341')}</option>
          </select>
        </label>
      </div>
      {!repeating && (
        <fieldset className="optional-section">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={form.scheduled}
              onChange={(event) => set('scheduled', event.target.checked)}
            />
            {uiMessage('actions-ui.346')}
          </label>
          {form.scheduled && (
            <div className="three-column-fields nested-fields">
              <label className="field-label">
                {uiMessage('actions-ui.274')}
                <input
                  required
                  type="date"
                  value={form.scheduleDate}
                  onChange={(event) => set('scheduleDate', event.target.value)}
                />
              </label>
              <label className="field-label">
                {uiMessage('actions-ui.270')}
                <input
                  required
                  type="time"
                  value={form.startTime}
                  onChange={(event) => set('startTime', event.target.value)}
                />
              </label>
              <label className="field-label">
                {uiMessage('actions-ui.271')}
                <input
                  required
                  type="time"
                  value={form.endTime}
                  onChange={(event) => set('endTime', event.target.value)}
                />
              </label>
            </div>
          )}
        </fieldset>
      )}
      {!repeating && (
        <fieldset className="optional-section">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={form.reminderEnabled}
              onChange={(event) => set('reminderEnabled', event.target.checked)}
            />
            {uiMessage('actions-ui.347')}
          </label>
          <p className="field-help">{uiMessage('actions-ui.348')}</p>
          {form.reminderEnabled && (
            <div className="nested-fields">
              <label className="field-label">
                {uiMessage('actions-ui.294')}
                <select
                  value={form.reminderKind}
                  onChange={(event) =>
                    set('reminderKind', event.target.value as FormState['reminderKind'])
                  }
                >
                  <option value="at">{uiMessage('actions-ui.349')}</option>
                  <option value="relative">{uiMessage('actions-ui.350')}</option>
                </select>
              </label>
              {form.reminderKind === 'at' ? (
                <div className="two-column-fields">
                  <label className="field-label">
                    {uiMessage('actions-ui.274')}
                    <input
                      required
                      type="date"
                      value={form.reminderDate}
                      onChange={(event) => set('reminderDate', event.target.value)}
                    />
                  </label>
                  <label className="field-label">
                    {uiMessage('actions-ui.351')}
                    <input
                      required
                      type="time"
                      value={form.reminderTime}
                      onChange={(event) => set('reminderTime', event.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <label className="field-label">
                  {uiMessage('actions-ui.352')}
                  <input
                    required
                    type="number"
                    min="0"
                    max="10080"
                    value={form.reminderOffset}
                    onChange={(event) => set('reminderOffset', event.target.value)}
                  />
                </label>
              )}
            </div>
          )}
        </fieldset>
      )}
      {repeatControl}
    </>
  );
  return (
    <>
      {titleField}
      {compact && crossAxisControl}
      {compact ? (
        <details className="expanded-fields">
          <summary>{uiMessage('actions-ui.353')}</summary>
          {fields}
        </details>
      ) : (
        fields
      )}
    </>
  );
}

function toInput(form: FormState): ActionFormInput {
  return {
    title: form.title,
    note: form.note,
    axisId: form.axisId,
    projectId: form.projectId,
    plannedDate: form.plannedDate,
    dueDate: form.dueDate,
    dueTime: form.dueTime,
    ...(form.estimate === '' ? {} : { estimateMinutes: Number(form.estimate) }),
    energy: form.energy,
    priority: form.priority,
    ...(form.scheduled
      ? { schedule: { date: form.scheduleDate, startTime: form.startTime, endTime: form.endTime } }
      : {}),
    reminder: {
      enabled: form.reminderEnabled,
      kind: form.reminderKind,
      ...(form.reminderKind === 'at'
        ? { date: form.reminderDate, time: form.reminderTime }
        : { offsetMinutes: Number(form.reminderOffset) }),
    },
    ...(form.confirmCrossAxis ? { confirmCrossAxis: true } : {}),
  };
}

function formFromWorkspace(workspace: ActionWorkspace): FormState {
  const document = workspace.action.document as ActionCanonicalDocument;
  const placement = workspace.placement?.document as PlacementDocument | undefined;
  const block = workspace.plannedBlock?.document as BlockDocument | undefined;
  const reminder = workspace.reminder?.document as ReminderDocument | undefined;
  const dueDisplay =
    document.due?.kind === 'instant'
      ? formatInstantInZone(document.due.instant, document.due.authoredTimeZone)
      : undefined;
  const blockStart =
    block === undefined ? undefined : formatInstantInZone(block.startsAt, block.timeZone);
  const blockEnd =
    block === undefined ? undefined : formatInstantInZone(block.endsAt, block.timeZone);
  const reminderAt =
    reminder === undefined
      ? undefined
      : formatInstantInZone(reminder.schedule.remindAt, reminder.schedule.timeZone);
  return {
    ...emptyForm,
    title: document.title,
    note: document.note ?? '',
    axisId: document.axisId ?? '',
    projectId: document.projectId ?? '',
    plannedDate: placement?.period.kind === 'day' ? placement.period.date : '',
    dueDate: document.due?.kind === 'date' ? document.due.date : (dueDisplay?.date ?? ''),
    dueTime: dueDisplay?.time ?? '',
    estimate: document.estimateMinutes?.toString() ?? '',
    energy: document.energy ?? '',
    priority: document.priority ?? '',
    scheduled: block !== undefined,
    scheduleDate: blockStart?.date ?? '',
    startTime: blockStart?.time ?? '',
    endTime: blockEnd?.time ?? '',
    reminderEnabled: reminder?.state === 'scheduled',
    reminderKind: reminder?.schedule.kind ?? 'at',
    reminderDate: reminderAt?.date ?? '',
    reminderTime: reminderAt?.time ?? '',
    reminderOffset:
      reminder?.schedule.kind === 'relative'
        ? String(Math.abs(reminder.schedule.offsetMinutes))
        : '15',
  };
}

function inboxMetadata(item: InboxProjection['items'][number]): string {
  const values = [
    new Date(item.createdAt).toLocaleString(),
    item.due === undefined
      ? undefined
      : item.due.kind === 'date'
        ? uiMessage('actions-ui.354', { value0: item.due.date })
        : uiMessage('actions-ui.354', { value0: new Date(item.due.instant).toLocaleString() }),
    item.estimateMinutes === undefined
      ? undefined
      : uiMessage('actions-ui.355', { value0: String(item.estimateMinutes) }),
    item.energy,
    item.priority,
  ];
  return values.filter(Boolean).join(' · ');
}
function placementLabel(document: PlacementDocument): string {
  const period = document.period;
  if (period.kind === 'day') return uiMessage('actions-ui.356', { value0: period.date });
  if (period.kind === 'week')
    return uiMessage('actions-ui.357', { value0: period.start, value1: period.end });
  if (period.kind === 'month') return uiMessage('actions-ui.358', { value0: period.month });
  return uiMessage('actions-ui.359', { value0: period.year });
}
function choiceOption(choice: ActionChoice): ReactNode {
  return (
    <option key={choice.id} value={choice.id}>
      {choice.title}
    </option>
  );
}
function originForPath(path: string): CaptureOrigin {
  if (path === '/') return 'today';
  if (path.startsWith('/plan')) return 'plan';
  if (path.startsWith('/axis')) return 'axis';
  if (path.startsWith('/review')) return 'review';
  if (path.startsWith('/inbox')) return 'inbox';
  if (path.startsWith('/actions')) return 'other';
  return 'global_capture';
}
function applicationMessage(error: ApplicationError): string {
  if (error.code === 'domain_rejected') return error.domainError.message;
  if (error.code === 'revision_conflict') return uiMessage('actions-ui.360');
  if (error.code === 'undo_unavailable') return uiMessage('actions-ui.361');
  if (error.code === 'entity_not_found') return uiMessage('actions-ui.362');
  if (error.code === 'transaction_failed') return uiMessage('actions-ui.363');
  return uiMessage('actions-ui.364');
}
function todayString(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
