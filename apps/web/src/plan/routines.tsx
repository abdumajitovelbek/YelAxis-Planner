import { PagedItems } from '../item-pages';
import { message as uiMessage } from '../messages';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import type {
  ChoiceRow,
  OccurrenceEntry,
  PlanProfile,
  ReminderView,
  RoutineDetail,
  RoutineGenerationDocument,
  RoutineSummary,
} from '@yelaxis/application';
import type { RecurrenceRuleV1 } from '@yelaxis/domain';

import { formatDate, formatDuration, formatWallTime } from './format';
import { Modal } from './modal';
import { OccurrenceControls } from './occurrence-controls';
import {
  CommandFeedback,
  useCommandRunner,
  usePlanning,
  usePlanningToday,
  usePlanQuery,
  type CommandRunner,
} from './planning-context';
import {
  buildRoutineReminder,
  describePattern,
  describeRule,
  describeScheduling,
  emptyRoutineForm,
  routineFormFromGeneration,
  RoutineForm,
  RoutineReminderFields,
  routineReminderMinutesError,
  runCommand,
  useDialogAutofocus,
  shiftDate,
  weekdayOf,
} from './routine-form';
import { routinePath, routinesPath } from './routes';
import './routines.css';

/* ───────────────────────── Shared words ───────────────────────── */

function stateLabel(routine: Pick<RoutineSummary, 'state' | 'pauseEffectiveOn'>): string {
  switch (routine.state) {
    case 'active':
      return uiMessage('alignment.object-forms.677');
    case 'paused':
      return routine.pauseEffectiveOn === undefined
        ? uiMessage('plan.routines.1533')
        : uiMessage('plan.routines.1534', { value0: formatDate(routine.pauseEffectiveOn) });
    case 'archived':
      return uiMessage('alignment.alignment-page.405');
  }
}

/** A Routine reminder in words: minutes before each occurrence, never a promise of delivery. */
export function describeRoutineReminder(reminder: ReminderView | undefined): string {
  const minutes = reminder?.minutesBefore;
  if (reminder === undefined || minutes === undefined) return uiMessage('plan.routine-form.1511');
  return minutes === 0
    ? uiMessage('plan.routines.1535')
    : uiMessage('plan.routines.1536', { value0: formatDuration(minutes) });
}

const occurrenceStateLabel: Readonly<Record<OccurrenceEntry['state'], string>> = {
  planned: uiMessage('plan.routines.1537'),
  completed: uiMessage('plan.plan-month.1324'),
  skipped: uiMessage('plan.plan-month.1325'),
};

function zoneFor(generation: RoutineGenerationDocument | undefined, profile: PlanProfile): string {
  const mode = generation?.schedulingMode;
  return mode?.kind === 'time_specific' && mode.zonePolicy.kind === 'fixed_zone'
    ? mode.zonePolicy.timeZone
    : profile.planningTimeZone;
}

function instantTime(instant: string, zone: string, format: PlanProfile['timeFormat']): string {
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: format === '12_hour' ? 'h12' : 'h23',
    }).format(new Date(instant));
  } catch {
    return instant.slice(11, 16);
  }
}

/** One occurrence in neutral words: when, timing, and state. */
export function describeOccurrence(
  entry: OccurrenceEntry,
  context: { readonly zone: string; readonly timeFormat: PlanProfile['timeFormat'] },
): { readonly when: string; readonly detail: string; readonly state: string } {
  const period = entry.ref.period;
  const when =
    period.kind === 'week'
      ? uiMessage('plan.routine-form.1522', {
          value0: formatDate(period.start, 'short'),
          value1: formatDate(period.end),
        })
      : formatDate(entry.date ?? period.date, 'long');
  let detail: string;
  switch (entry.timing.kind) {
    case 'flexible':
      detail = uiMessage('plan.routine-form.1445');
      break;
    case 'weekly_count': {
      const target = entry.targetCount ?? (period.kind === 'week' ? period.targetCount : 1);
      detail = uiMessage('plan.routines.1538', {
        value0: String(entry.completedCount ?? 0),
        value1: String(target),
      });
      break;
    }
    case 'timed':
      detail = uiMessage('plan.routine-form.1524', {
        value0: instantTime(entry.timing.startsAt, context.zone, context.timeFormat),
        value1: instantTime(entry.timing.endsAt, context.zone, context.timeFormat),
        value2: context.zone.replace(/_/gu, ' '),
      });
      break;
    case 'dst_skipped':
      detail = uiMessage('plan.routines.1539', {
        value0: formatWallTime(entry.timing.wallTime, context.timeFormat),
      });
      break;
  }
  const moved = entry.moved ? uiMessage('plan.routines.1540') : '';
  return { when, detail: `${detail}${moved}`, state: occurrenceStateLabel[entry.state] };
}

/** First valid date for a date-scoped change: never before `earliest`; week starts for counts. */
function suggestedDate(earliest: string, rule: RecurrenceRuleV1): string {
  let date = earliest;
  if (rule.kind !== 'weekly_count') return date;
  for (let step = 0; step < 7 && weekdayOf(date) !== rule.weekStart; step += 1)
    date = shiftDate(date, 1);
  return date;
}

/* ───────────────────────── Routines list ───────────────────────── */

export function RoutinesPage(): ReactNode {
  const planning = usePlanning();
  const today = usePlanningToday();
  const runner = useCommandRunner();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const { state, reload } = usePlanQuery(
    () => planning.listRoutines({ includeArchived: showArchived }),
    [planning, showArchived],
  );
  const groups =
    state.status === 'ready'
      ? ([
          [
            uiMessage('plan.routines.1541'),
            state.data.filter((routine) => routine.state === 'active'),
          ],
          [
            uiMessage('plan.routines.1542'),
            state.data.filter((routine) => routine.state === 'paused'),
          ],
          [
            uiMessage('plan.routines.1543'),
            state.data.filter((routine) => routine.state === 'archived'),
          ],
        ] as const)
      : [];
  return (
    <section
      className="content-section routines-page"
      aria-labelledby="page-title"
      aria-busy={state.status === 'loading' || runner.busy}
    >
      <Link className="back-link" to="/plan">
        {uiMessage('plan.routines.1544')}
      </Link>
      <p className="eyebrow">{uiMessage('actions-ui.250')}</p>
      <h1 id="page-title">{uiMessage('alignment.axis-detail.433')}</h1>
      <p className="page-message">{uiMessage('plan.routines.1545')}</p>
      <div className="routines-toolbar">
        <button className="primary-button" type="button" onClick={() => setCreating(true)}>
          {uiMessage('plan.routines.1546')}
        </button>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          {uiMessage('plan.routines.1547')}
        </label>
      </div>
      <CommandFeedback runner={runner} />
      {state.status === 'loading' && (
        <p className="page-message">{uiMessage('plan.routines.1548')}</p>
      )}
      {state.status === 'error' && (
        <div className="validation-summary" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      )}
      {state.status === 'ready' && state.data.length === 0 && (
        <div className="quiet-empty">
          <h2>{uiMessage('plan.routines.1549')}</h2>
          <p>{uiMessage('plan.routines.1550')}</p>
        </div>
      )}
      {groups.map(([label, routines]) =>
        routines.length === 0 ? null : (
          <section key={label} className="routine-group" aria-label={label}>
            <h2>{label}</h2>
            <ul className="routine-list">
              <PagedItems items={routines}>
                {(routine) => <RoutineCard key={routine.id} routine={routine} />}
              </PagedItems>
            </ul>
          </section>
        ),
      )}
      <Modal
        open={creating}
        eyebrow={uiMessage('alignment.axis-detail.433')}
        title={uiMessage('plan.routines.1546')}
        onClose={() => setCreating(false)}
      >
        <RoutineForm
          initial={emptyRoutineForm(today)}
          planning={planning}
          showReminder
          submitLabel={uiMessage('actions-ui.222')}
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            const result = await runCommand(
              runner,
              () => planning.createRoutine(input),
              input.reminder === undefined
                ? uiMessage('actions-ui.213')
                : uiMessage('plan.routines.1551'),
            );
            if (result.message === null) setCreating(false);
            return result.message;
          }}
        />
      </Modal>
    </section>
  );
}

function RoutineCard({ routine }: { readonly routine: RoutineSummary }): ReactNode {
  return (
    <li className="routine-card">
      <div className="routine-card-heading">
        <h3>
          <Link to={routinePath(routine.id)}>{routine.title}</Link>
        </h3>
        <span className="status-pill">{stateLabel(routine)}</span>
      </div>
      <p>{describeRule(routine.current.rule)}</p>
      <p className="field-help">
        {describeScheduling(routine.current.schedulingMode)}
        {routine.axisTitle === undefined
          ? ''
          : uiMessage('plan.routines.1552', { value0: routine.axisTitle })}
      </p>
    </li>
  );
}

/* ───────────────────────── Routine detail ───────────────────────── */

type DetailDialog = 'details' | 'future' | 'pause' | 'resume' | 'reminder' | 'archive' | null;

export function RoutineDetailPage(): ReactNode {
  const planning = usePlanning();
  const runner = useCommandRunner();
  const { routineId = '' } = useParams();
  const [dialog, setDialog] = useState<DetailDialog>(null);
  const { state, reload } = usePlanQuery(
    () => planning.getRoutine(routineId),
    [planning, routineId],
  );
  if (state.status === 'loading')
    return (
      <section className="content-section routine-detail" aria-busy="true">
        <p className="eyebrow">{uiMessage('plan.routine-form.1531')}</p>
        <h1>{uiMessage('plan.routines.1553')}</h1>
      </section>
    );
  if (state.status === 'error')
    return (
      <section className="content-section routine-detail" aria-labelledby="page-title">
        <p className="eyebrow">{uiMessage('plan.routine-form.1531')}</p>
        <h1 id="page-title">{uiMessage('plan.routines.1554')}</h1>
        <p className="validation-summary" role="alert">
          {state.message}
        </p>
        <button type="button" onClick={() => void reload()}>
          {uiMessage('account.account-dialogs.47')}
        </button>
      </section>
    );
  if (state.data === null)
    return (
      <section className="content-section routine-detail" aria-labelledby="page-title">
        <p className="eyebrow">{uiMessage('plan.routine-form.1531')}</p>
        <h1 id="page-title">{uiMessage('plan.routines.1555')}</h1>
        <p className="page-message">{uiMessage('plan.routines.1556')}</p>
        <Link className="inline-button" to={routinesPath}>
          {uiMessage('plan.routines.1557')}
        </Link>
      </section>
    );
  const detail = state.data;
  const routine = detail.routine;
  const revision = routine.localRevision;
  const close = (): void => setDialog(null);
  const archived = routine.state === 'archived';
  const timed = routine.current.schedulingMode.kind === 'time_specific';
  const archive = (): void =>
    void runner.run(
      () => planning.archiveRoutine({ routineId: routine.id, revision }),
      detail.reminder === undefined
        ? uiMessage('plan.routines.1558')
        : uiMessage('plan.routines.1559'),
    );
  return (
    <section
      className="content-section routine-detail"
      aria-labelledby="page-title"
      aria-busy={runner.busy || state.refreshing}
    >
      <Link className="back-link" to={routinesPath}>
        {uiMessage('plan.routines.1560')}
      </Link>
      <p className="eyebrow">
        {uiMessage('plan.routines.1561')}
        {stateLabel(routine)}
      </p>
      <h1 id="page-title">{routine.title}</h1>
      {routine.description !== undefined && <p className="page-message">{routine.description}</p>}
      {routine.state === 'paused' && (
        <p className="quiet-empty">
          {stateLabel(routine)}
          {uiMessage('plan.routines.1562')}
        </p>
      )}
      {archived && <p className="quiet-empty">{uiMessage('plan.routines.1563')}</p>}
      <CommandFeedback runner={runner} />
      <div className="detail-actions routine-actions">
        <button type="button" disabled={runner.busy} onClick={() => setDialog('details')}>
          {uiMessage('plan.routines.1564')}
        </button>
        {!archived && (
          <button type="button" disabled={runner.busy} onClick={() => setDialog('future')}>
            {uiMessage('plan.routines.1565')}
          </button>
        )}
        {routine.state === 'active' && (
          <button type="button" disabled={runner.busy} onClick={() => setDialog('pause')}>
            {uiMessage('plan.routines.1566')}
          </button>
        )}
        {routine.state === 'paused' && (
          <button type="button" disabled={runner.busy} onClick={() => setDialog('resume')}>
            {uiMessage('plan.routines.1567')}
          </button>
        )}
        {!archived && ((routine.state === 'active' && timed) || detail.reminder !== undefined) && (
          <button type="button" disabled={runner.busy} onClick={() => setDialog('reminder')}>
            {uiMessage('plan.routines.1568')}
          </button>
        )}
        {archived ? (
          <button
            type="button"
            disabled={runner.busy}
            onClick={() =>
              void runner.run(
                () => planning.restoreRoutine({ routineId: routine.id, revision }),
                uiMessage('plan.routines.1569'),
              )
            }
          >
            {uiMessage('actions-ui.298')}
          </button>
        ) : detail.reminder === undefined ? (
          <button type="button" disabled={runner.busy} onClick={archive}>
            {uiMessage('actions-ui.258')}
          </button>
        ) : (
          // Archiving turns the reminder off; the confirmation says so before anything changes.
          <button type="button" disabled={runner.busy} onClick={() => setDialog('archive')}>
            {uiMessage('alignment.axis-detail.423')}
          </button>
        )}
      </div>
      <PatternSection detail={detail} />
      <ReminderSection detail={detail} />
      <DefaultsSection routine={routine} />
      <OccurrenceSection
        title={uiMessage('plan.routines.1570')}
        empty={
          routine.state === 'paused'
            ? uiMessage('plan.routines.1571')
            : archived
              ? uiMessage('plan.routines.1572')
              : uiMessage('plan.routines.1573')
        }
        entries={detail.upcoming}
        detail={detail}
        controls
      />
      <OccurrenceSection
        title={uiMessage('alignment.kit.474')}
        empty={uiMessage('plan.routines.1574')}
        entries={detail.history}
        detail={detail}
      />
      <Modal
        open={dialog === 'details'}
        eyebrow={uiMessage('plan.routine-form.1531')}
        title={uiMessage('plan.routines.1575')}
        onClose={close}
      >
        <EditDetailsForm detail={detail} runner={runner} onDone={close} />
      </Modal>
      <Modal
        open={dialog === 'future'}
        eyebrow={uiMessage('plan.routine-form.1531')}
        title={uiMessage('plan.routines.1576')}
        description={uiMessage('plan.routines.1577')}
        onClose={close}
      >
        <RoutineForm
          initial={routineFormFromGeneration(routine.current, {
            title: routine.title,
            ...(routine.defaults === undefined ? {} : { defaults: routine.defaults }),
            startsOn: suggestedDate(
              detail.today > routine.current.rule.startsOn
                ? detail.today
                : shiftDate(routine.current.rule.startsOn, 1),
              routine.current.rule,
            ),
          })}
          planning={planning}
          profile={detail.profile}
          showDetails={false}
          startLabel={uiMessage('plan.routines.2415')}
          submitLabel={uiMessage('plan.routines.2416')}
          onCancel={close}
          onSubmit={async (input) => {
            const rule = input.rule as RecurrenceRuleV1;
            const result = await runCommand(
              runner,
              () =>
                planning.editRoutineThisAndFuture({
                  routineId: routine.id,
                  revision,
                  selectedOn: rule.startsOn,
                  rule: input.rule,
                  schedulingMode: input.schedulingMode,
                  defaults: input.defaults ?? {},
                }),
              uiMessage('plan.routines.1578'),
            );
            if (result.message === null) close();
            return result.message;
          }}
        />
      </Modal>
      <Modal
        open={dialog === 'reminder'}
        eyebrow={uiMessage('plan.routine-form.1531')}
        title={uiMessage('plan.routines.1579')}
        description={uiMessage('plan.routines.1580')}
        onClose={close}
      >
        <RoutineReminderForm detail={detail} runner={runner} onDone={close} />
      </Modal>
      <Modal
        open={dialog === 'archive'}
        eyebrow={uiMessage('plan.routine-form.1531')}
        title={uiMessage('plan.routines.1581')}
        description={uiMessage('plan.routines.1582')}
        onClose={close}
      >
        <ArchiveRoutineConfirmation
          reminder={detail.reminder}
          busy={runner.busy}
          onCancel={close}
          onConfirm={() => {
            close();
            archive();
          }}
        />
      </Modal>
      <Modal
        open={dialog === 'pause'}
        eyebrow={uiMessage('plan.routine-form.1531')}
        title={uiMessage('plan.routines.1583')}
        description={uiMessage('plan.routines.1584')}
        onClose={close}
      >
        <DateCommandForm
          label={uiMessage('plan.routines.1585')}
          help={
            routine.current.rule.kind === 'weekly_count'
              ? uiMessage('plan.routines.1586')
              : uiMessage('plan.routines.1587')
          }
          min={detail.today}
          initialDate={suggestedDate(detail.today, routine.current.rule)}
          submitLabel={uiMessage('plan.routines.1583')}
          onCancel={close}
          onSubmit={async (pauseOn) => {
            const result = await runCommand(
              runner,
              () => planning.pauseRoutine({ routineId: routine.id, revision, pauseOn }),
              uiMessage('plan.routines.1588'),
            );
            if (result.message === null) close();
            return result.message;
          }}
        />
      </Modal>
      <Modal
        open={dialog === 'resume'}
        eyebrow={uiMessage('plan.routine-form.1531')}
        title={uiMessage('plan.routines.1589')}
        description={uiMessage('plan.routines.1590')}
        onClose={close}
      >
        <DateCommandForm
          label={uiMessage('plan.routines.1591')}
          help={
            routine.current.rule.kind === 'weekly_count'
              ? uiMessage('plan.routines.1586')
              : uiMessage('plan.routines.1587')
          }
          min={detail.today}
          initialDate={suggestedDate(detail.today, routine.current.rule)}
          submitLabel={uiMessage('plan.routines.1589')}
          onCancel={close}
          onSubmit={async (resumeOn) => {
            const result = await runCommand(
              runner,
              () => planning.resumeRoutine({ routineId: routine.id, revision, resumeOn }),
              uiMessage('plan.routines.1592'),
            );
            if (result.message === null) close();
            return result.message;
          }}
        />
      </Modal>
    </section>
  );
}

function PatternSection({ detail }: { readonly detail: RoutineDetail }): ReactNode {
  const routine = detail.routine;
  const earlier = routine.generations.filter(
    (generation) => generation.generation !== routine.current.generation,
  );
  const timeFormat = detail.profile.timeFormat;
  return (
    <section className="routine-section" aria-labelledby="routine-pattern-title">
      <h2 id="routine-pattern-title">{uiMessage('plan.routines.1593')}</h2>
      <dl className="routine-facts">
        <div>
          <dt>{uiMessage('plan.routine-form.1479')}</dt>
          <dd>{describeRule(routine.current.rule)}</dd>
        </div>
        <div>
          <dt>{uiMessage('plan.routines.1594')}</dt>
          <dd>
            {describeScheduling(routine.current.schedulingMode, timeFormat)}
            {routine.current.schedulingMode.kind === 'time_specific' &&
            routine.current.schedulingMode.zonePolicy.kind === 'follow_profile'
              ? ` (${detail.profile.planningTimeZone.replace(/_/gu, ' ')})`
              : ''}
          </dd>
        </div>
        {earlier.length > 0 && (
          <div>
            <dt>{uiMessage('plan.routines.1595')}</dt>
            <dd>
              {uiMessage('plan.routines.1596')}
              {formatDate(routine.current.rule.startsOn)}
            </dd>
          </div>
        )}
        {routine.axisTitle !== undefined && (
          <div>
            <dt>{uiMessage('actions-ui.251')}</dt>
            <dd>{routine.axisTitle}</dd>
          </div>
        )}
      </dl>
      {earlier.length > 0 && (
        <>
          <h3>{uiMessage('plan.routines.1597')}</h3>
          <ol className="routine-generations">
            <PagedItems items={earlier}>
              {(generation) => (
                <li key={generation.generation}>
                  <strong>
                    {formatDate(generation.rule.startsOn)}
                    {generation.rule.endsOn === undefined
                      ? ''
                      : uiMessage('plan.routines.1598', {
                          value0: formatDate(generation.rule.endsOn),
                        })}
                  </strong>
                  <span>
                    {describePattern(generation.rule)} ·{' '}
                    {describeScheduling(generation.schedulingMode, timeFormat)}
                  </span>
                </li>
              )}
            </PagedItems>
          </ol>
        </>
      )}
    </section>
  );
}

/** The Routine's reminder, before each occurrence, in words; it is a saved definition only. */
function ReminderSection({ detail }: { readonly detail: RoutineDetail }): ReactNode {
  return (
    <section className="routine-section" aria-labelledby="routine-reminder-title">
      <h2 id="routine-reminder-title">{uiMessage('plan.routine-form.1510')}</h2>
      <p>{describeRoutineReminder(detail.reminder)}</p>
      <p className="field-help">{uiMessage('plan.routine-form.1428')}</p>
    </section>
  );
}

/** Off, or minutes before each occurrence; turning it off or setting it is one command. */
function RoutineReminderForm({
  detail,
  onDone,
  runner,
}: {
  readonly detail: RoutineDetail;
  readonly onDone: () => void;
  readonly runner: CommandRunner;
}): ReactNode {
  const planning = usePlanning();
  const routine = detail.routine;
  const current = detail.reminder;
  const [choice, setChoice] = useState<'off' | 'before'>(current === undefined ? 'off' : 'before');
  const [minutes, setMinutes] = useState(String(current?.minutesBefore ?? 15));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autofocusRef = useDialogAutofocus();
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const built = buildRoutineReminder(choice, minutes);
    if (!built.ok) {
      setError(built.errors[0] ?? routineReminderMinutesError);
      return;
    }
    const next = built.value;
    // Choosing what the routine already has saves nothing.
    if (
      (next === undefined && current === undefined) ||
      (next !== undefined && current?.minutesBefore === next.minutesBefore)
    ) {
      onDone();
      return;
    }
    setBusy(true);
    setError(null);
    const result =
      next === undefined
        ? await runCommand(
            runner,
            () =>
              planning.turnOffRoutineReminder({
                routineId: routine.id,
                reminderRevision: current?.localRevision ?? 0,
              }),
            uiMessage('plan.routines.1599'),
          )
        : await runCommand(
            runner,
            () =>
              planning.setRoutineReminder({
                routineId: routine.id,
                revision: routine.localRevision,
                ...(current === undefined ? {} : { reminderRevision: current.localRevision }),
                reminder: next,
              }),
            uiMessage('plan.routines.1600'),
          );
    setBusy(false);
    if (result.message === null) onDone();
    else setError(result.message);
  };
  const fieldError = error === routineReminderMinutesError ? error : undefined;
  return (
    <form
      ref={autofocusRef}
      className="plan-form"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      {error !== null && (
        <p className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <RoutineReminderFields
        autoFocus
        choice={choice}
        minutes={minutes}
        onChoice={setChoice}
        onMinutes={setMinutes}
        {...(fieldError === undefined ? {} : { error: fieldError })}
      />
      <p className="field-help">
        {describeScheduling(routine.current.schedulingMode, detail.profile.timeFormat)}.
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={onDone}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? uiMessage('account.conflicts-page.133') : uiMessage('plan.routines.1601')}
        </button>
      </div>
    </form>
  );
}

/**
 * The archive policy's stated sub-operation: archiving turns the routine's reminder
 * off, and restoring the routine later does not turn it back on.
 */
function ArchiveRoutineConfirmation({
  busy,
  onCancel,
  onConfirm,
  reminder,
}: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly reminder: ReminderView | undefined;
}): ReactNode {
  return (
    <div className="plan-form">
      <p>
        {uiMessage('plan.routines.1602')}
        {describeRoutineReminder(reminder).toLowerCase()}
        {uiMessage('plan.routines.1603')}
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button
          className="primary-button"
          type="button"
          data-autofocus
          disabled={busy}
          onClick={onConfirm}
        >
          {uiMessage('plan.routines.1604')}
        </button>
      </div>
    </div>
  );
}

function DefaultsSection({ routine }: { readonly routine: RoutineSummary }): ReactNode {
  const defaults = routine.defaults;
  const facts: (readonly [string, string])[] = [];
  if (defaults?.projectTitle !== undefined)
    facts.push([uiMessage('actions-ui.254'), defaults.projectTitle]);
  if (defaults?.estimateMinutes !== undefined)
    facts.push([uiMessage('plan.routines.1605'), formatDuration(defaults.estimateMinutes)]);
  if (defaults?.energy !== undefined)
    facts.push([uiMessage('actions-ui.337'), capitalize(defaults.energy)]);
  if (defaults?.priority !== undefined)
    facts.push([uiMessage('actions-ui.343'), capitalize(defaults.priority)]);
  if (defaults?.note !== undefined) facts.push([uiMessage('plan.routines.1606'), defaults.note]);
  return (
    <section className="routine-section" aria-labelledby="routine-defaults-title">
      <h2 id="routine-defaults-title">{uiMessage('plan.routine-form.1515')}</h2>
      {facts.length === 0 ? (
        <p className="field-help">{uiMessage('plan.routines.1607')}</p>
      ) : (
        <dl className="routine-facts">
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function OccurrenceSection({
  controls = false,
  detail,
  empty,
  entries,
  title,
}: {
  readonly controls?: boolean;
  readonly detail: RoutineDetail;
  readonly empty: string;
  readonly entries: readonly OccurrenceEntry[];
  readonly title: string;
}): ReactNode {
  const id = `routine-${title.toLowerCase()}-title`;
  return (
    <section className="routine-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {entries.length === 0 ? (
        <p className="field-help">{empty}</p>
      ) : (
        <ul className="occurrence-list" aria-labelledby={id}>
          <PagedItems items={entries}>
            {(entry) => {
              const generation = detail.routine.generations.find(
                (candidate) => candidate.generation === entry.ref.generation,
              );
              const text = describeOccurrence(entry, {
                zone: zoneFor(generation ?? detail.routine.current, detail.profile),
                timeFormat: detail.profile.timeFormat,
              });
              return (
                <li key={entry.ref.logicalKey} className="occurrence-row">
                  <div className="occurrence-text">
                    <strong>{text.when}</strong>
                    <span>{text.detail}</span>
                  </div>
                  <span className="status-pill">{text.state}</span>
                  {controls && (
                    <div className="occurrence-controls-slot">
                      <OccurrenceControls entry={entry} />
                    </div>
                  )}
                </li>
              );
            }}
          </PagedItems>
        </ul>
      )}
    </section>
  );
}

function EditDetailsForm({
  detail,
  onDone,
  runner,
}: {
  readonly detail: RoutineDetail;
  readonly onDone: () => void;
  readonly runner: CommandRunner;
}): ReactNode {
  const planning = usePlanning();
  const routine = detail.routine;
  const [title, setTitle] = useState(routine.title);
  const [description, setDescription] = useState(routine.description ?? '');
  const [axisId, setAxisId] = useState(routine.axisId ?? '');
  const [axes, setAxes] = useState<readonly ChoiceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autofocusRef = useDialogAutofocus();
  useEffect(() => {
    let active = true;
    planning
      .listAxes()
      .then((rows) => {
        if (active) setAxes(rows);
      })
      .catch(() => {
        if (active) setError(uiMessage('plan.routines.1608'));
      });
    return () => {
      active = false;
    };
  }, [planning]);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      setError(uiMessage('plan.routine-form.1459'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await runCommand(
      runner,
      () =>
        planning.editRoutineDetails({
          routineId: routine.id,
          revision: routine.localRevision,
          title: trimmed,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
          ...(axisId === '' ? {} : { axisId }),
        }),
      uiMessage('plan.routines.1609'),
    );
    setBusy(false);
    if (result.message === null) onDone();
    else setError(result.message);
  };
  return (
    <form
      ref={autofocusRef}
      className="plan-form"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      {error !== null && (
        <p className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <label className="field-label">
        {uiMessage('actions-ui.325')}
        <span>{uiMessage('actions-ui.326')}</span>
        <input
          data-autofocus
          required
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="field-label">
        {uiMessage('plan.routine-form.1532')}
        <span>{uiMessage('alignment.object-forms.664')}</span>
        <textarea
          rows={3}
          maxLength={10000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label className="field-label">
        {uiMessage('actions-ui.251')}
        <select value={axisId} onChange={(event) => setAxisId(event.target.value)}>
          <option value="">{uiMessage('actions-ui.329')}</option>
          {axes.map((axis) => (
            <option key={axis.id} value={axis.id}>
              {axis.title}
            </option>
          ))}
        </select>
      </label>
      <p className="field-help">{uiMessage('plan.routines.1610')}</p>
      <div className="dialog-actions">
        <button type="button" onClick={onDone}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? uiMessage('account.conflicts-page.133') : uiMessage('plan.routines.1611')}
        </button>
      </div>
    </form>
  );
}

function DateCommandForm({
  help,
  initialDate,
  label,
  min,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  readonly help: string;
  readonly initialDate: string;
  readonly label: string;
  readonly min: string;
  readonly onCancel: () => void;
  readonly onSubmit: (date: string) => Promise<string | null>;
  readonly submitLabel: string;
}): ReactNode {
  const [date, setDate] = useState(initialDate);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autofocusRef = useDialogAutofocus();
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      setError(uiMessage('plan.routines.1612'));
      return;
    }
    setBusy(true);
    setError(null);
    const message = await onSubmit(date);
    setBusy(false);
    if (message !== null) setError(message);
  };
  return (
    <form
      ref={autofocusRef}
      className="plan-form"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      {error !== null && (
        <p className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <label className="field-label">
        {label} <span>{help}</span>
        <input
          data-autofocus
          type="date"
          required
          min={min}
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </label>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? uiMessage('account.conflicts-page.133') : submitLabel}
        </button>
      </div>
    </form>
  );
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}
