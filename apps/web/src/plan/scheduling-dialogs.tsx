import { message as uiMessage } from '../messages';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type {
  ActionSummary,
  BlockRow,
  ConflictView,
  LocalIntervalInput,
  OccurrenceEntry,
  PlaceableTargetInput,
  PlacementPeriodInput,
  PlanProfile,
  PlanningApplication,
  ReminderView,
  TimeBlockReminderInput,
  TimedEntry,
  TimedItemRef,
} from '@yelaxis/application';
import type { CommitmentStrength } from '@yelaxis/domain';

import { formatDate, formatDuration, formatMonth, formatWallTime, formatWeekRange } from './format';
import { Modal } from './modal';
import { EditOccurrenceForm, OccurrenceControls, occurrenceTarget } from './occurrence-controls';
import { usePlanning, type CommandRunner } from './planning-context';
import { actionPath } from './routes';
import {
  DialogError,
  IntervalFields,
  IntervalPreview,
  KeepOverlapCheckbox,
  actionDragProps,
  entryKindLabel,
  entryTimeText,
  isCalendarDate,
  isWallTime,
  minutesOfWallTime,
  monthKeyOf,
  previewOverlaps,
  shiftMonths,
  stateLabel,
  useDialogAutofocus,
  useIntervalPreview,
  validateInterval,
  wallTimeFromMinutes,
  weekDatesFor,
  type IntervalDraft,
} from './timeline';

import './scheduling-dialogs.css';

/* ───────────────────────── Requests ───────────────────────── */

export interface PlaceTarget {
  readonly input: PlaceableTargetInput;
  readonly title: string;
}

export type BlockEntry = TimedEntry & { readonly block: BlockRow };

export type DialogRequest =
  | {
      readonly kind: 'schedule';
      readonly action: ActionSummary;
      readonly date: string;
      readonly startTime?: string;
    }
  | { readonly kind: 'customBlock'; readonly date: string }
  | { readonly kind: 'commitment'; readonly date: string }
  | { readonly kind: 'move'; readonly entry: BlockEntry }
  | { readonly kind: 'shorten'; readonly entry: BlockEntry }
  | { readonly kind: 'completeActionBlock'; readonly entry: BlockEntry }
  | { readonly kind: 'cancelBlock'; readonly entry: BlockEntry }
  | { readonly kind: 'blockReminder'; readonly entry: BlockEntry }
  | {
      readonly kind: 'place';
      readonly target: PlaceTarget;
      readonly date: string;
      readonly choice: 'day' | 'date' | 'week' | 'month';
    }
  | { readonly kind: 'placeOn'; readonly target: PlaceTarget; readonly date: string }
  | { readonly kind: 'keepOverlap'; readonly conflict: ConflictView }
  | {
      readonly kind: 'editOccurrence';
      readonly occurrence: OccurrenceEntry;
      readonly focus: 'date' | 'duration';
    }
  | { readonly kind: 'saveWeekTemplate'; readonly weekDate: string };

export type RequestDialog = (request: DialogRequest) => void;

type RequestOf<Kind extends DialogRequest['kind']> = Extract<DialogRequest, { kind: Kind }>;

export function isBlockEntry(entry: TimedEntry): entry is BlockEntry {
  return entry.block !== undefined;
}

export function actionPlaceTarget(action: ActionSummary): PlaceTarget {
  return {
    input: { kind: 'action', id: action.id, revision: action.localRevision },
    title: action.title,
  };
}

/** Command reference for either side of a conflict. */
export function timedItemRef(entry: TimedEntry): TimedItemRef | null {
  if (entry.block !== undefined)
    return { kind: 'block', blockId: entry.block.id, revision: entry.block.localRevision };
  if (entry.occurrence !== undefined)
    return { kind: 'occurrence', occurrence: occurrenceTarget(entry.occurrence) };
  return null;
}

/* ───────────────────────── Conflict index ───────────────────────── */

export type ConflictIndex = ReadonlyMap<
  string,
  readonly { readonly title: string; readonly kept: boolean }[]
>;

export function buildConflictIndex(conflicts: readonly ConflictView[]): ConflictIndex {
  const index = new Map<string, { title: string; kept: boolean }[]>();
  const add = (key: string, title: string, kept: boolean): void => {
    const list = index.get(key) ?? [];
    list.push({ title, kept });
    index.set(key, list);
  };
  for (const conflict of conflicts) {
    add(conflict.firstKey, conflict.second.title, conflict.kept);
    add(conflict.secondKey, conflict.first.title, conflict.kept);
  }
  return index;
}

/* ───────────────────────── Entry card and block controls ───────────────────────── */

/**
 * One timed item: local time, title, kind, state, and overlap text. Conflicts are outlined in amber
 * and always named in text. Controls sit in a disclosure to keep the schedule readable;
 * `extraOptions` adds a view's own choices there (Today: Add to focus and Focus mode).
 */
export function TimedEntryCard({
  conflictIndex,
  date,
  entry,
  extraOptions,
  onRequest,
  profile,
  runner,
}: {
  readonly conflictIndex: ConflictIndex;
  readonly date: string;
  readonly entry: TimedEntry;
  readonly extraOptions?: (entry: TimedEntry) => ReactNode;
  readonly onRequest: RequestDialog;
  readonly profile: PlanProfile;
  readonly runner: CommandRunner;
}): ReactNode {
  const extra = extraOptions?.(entry);
  const known = conflictIndex.get(entry.key) ?? [];
  const open = known.filter((item) => !item.kept);
  const unknownOverlap =
    known.length === 0 && entry.state === 'planned' && entry.conflictsWith.length > 0;
  const keptOnly = open.length === 0 && known.length > 0;
  const hasConflict = open.length > 0 || unknownOverlap;
  const actionTarget = entry.block?.target.kind === 'action' ? entry.block.target : null;
  return (
    <div
      className={`timed-entry state-${entry.state}${hasConflict ? ' has-conflict' : ''}${entry.kind === 'commitment_block' ? ' is-commitment' : ''}`}
    >
      <p className="entry-time">{entryTimeText(entry, date, profile.timeFormat)}</p>
      <p className="entry-title">
        {actionTarget === null ? (
          entry.title
        ) : (
          <Link to={actionPath(actionTarget.actionId)}>{entry.title}</Link>
        )}
      </p>
      <p className="entry-meta">
        <span>{entryKindLabel(entry)}</span>
        <span className="status-pill entry-state">{stateLabel(entry.state)}</span>
      </p>
      {open.length > 0 && (
        <p className="warning-text entry-conflict">
          {uiMessage('plan.scheduling-dialogs.1614')}
          {open.map((item) => item.title).join(', ')}
        </p>
      )}
      {unknownOverlap && (
        <p className="warning-text entry-conflict">{uiMessage('plan.scheduling-dialogs.1615')}</p>
      )}
      {keptOnly && <p className="entry-kept">{uiMessage('plan.conflicts.1224')}</p>}
      <details className="entry-options">
        <summary>
          {uiMessage('plan.scheduling-dialogs.1616')}
          <span className="sr-only">
            {uiMessage('plan.occurrence-controls.1235')}
            {entry.title}
          </span>
        </summary>
        {isBlockEntry(entry) ? (
          <BlockStateControls entry={entry} onRequest={onRequest} runner={runner} />
        ) : entry.occurrence !== undefined ? (
          <OccurrenceControls entry={entry.occurrence} profile={profile} runner={runner} />
        ) : null}
        {extra !== undefined && extra !== null && extra !== false && (
          <div className="control-row entry-extra-options">{extra}</div>
        )}
      </details>
    </div>
  );
}

/**
 * Complete / Skip / Cancel / Move / Shorten for a planned block, Reopen for a resolved one. The
 * Action is only completed when the user explicitly asks for it.
 */
export function BlockStateControls({
  entry,
  onRequest,
  runner,
}: {
  readonly entry: BlockEntry;
  readonly onRequest: RequestDialog;
  readonly runner: CommandRunner;
}): ReactNode {
  const planning = usePlanning();
  const block = entry.block;
  const context = (
    <>
      {' '}
      <span className="sr-only">{entry.title}</span>
    </>
  );
  const setState = (to: 'planned' | 'completed' | 'skipped', success: string): void =>
    void runner.run(
      () => planning.setBlockState({ blockId: block.id, revision: block.localRevision, to }),
      success,
    );
  if (block.state !== 'planned')
    return (
      <div className="control-row">
        <button
          type="button"
          disabled={runner.busy}
          onClick={() => setState('planned', uiMessage('plan.scheduling-dialogs.1617'))}
        >
          {uiMessage('alignment.milestone-detail.603')}
          {context}
        </button>
      </div>
    );
  const commitment = block.target.kind === 'commitment';
  return (
    <div className="control-row">
      <button
        type="button"
        disabled={runner.busy}
        onClick={() => {
          if (block.target.kind === 'action') onRequest({ kind: 'completeActionBlock', entry });
          else setState('completed', uiMessage('plan.scheduling-dialogs.1618'));
        }}
      >
        {uiMessage('actions-ui.257')}
        {block.target.kind === 'action' ? '…' : ''}
        {context}
      </button>
      <button
        type="button"
        disabled={runner.busy}
        onClick={() => setState('skipped', uiMessage('plan.scheduling-dialogs.1619'))}
      >
        {uiMessage('plan.occurrence-controls.1243')}
        {context}
      </button>
      <button
        type="button"
        disabled={runner.busy}
        onClick={() => onRequest({ kind: 'move', entry })}
      >
        {uiMessage('alignment.milestone-detail.610')}
        {context}
      </button>
      {entry.durationMinutes > 1 && (
        <button
          type="button"
          disabled={runner.busy}
          onClick={() => onRequest({ kind: 'shorten', entry })}
        >
          {uiMessage('plan.conflicts.1225')}
          {context}
        </button>
      )}
      <button
        type="button"
        disabled={runner.busy}
        onClick={() => onRequest({ kind: 'blockReminder', entry })}
      >
        {uiMessage('plan.routines.1568')}
        {context}
      </button>
      <button
        type="button"
        disabled={runner.busy}
        onClick={() => onRequest({ kind: 'cancelBlock', entry })}
      >
        {commitment ? uiMessage('plan.conflicts.1226') : uiMessage('plan.conflicts.1227')}
        {context}
      </button>
    </div>
  );
}

/* ───────────────────────── Action rows ───────────────────────── */

/**
 * One flexible or unplaced Action. Mouse users may drag it onto a Day timeline or a Week day; the
 * visible buttons passed as children do the same things from the keyboard.
 */
export function ActionRow({
  action,
  children,
  note,
}: {
  readonly action: ActionSummary;
  readonly children: ReactNode;
  readonly note?: string;
}): ReactNode {
  const facts = [
    action.estimateMinutes === undefined
      ? null
      : uiMessage('plan.scheduling-dialogs.1620', {
          value0: formatDuration(action.estimateMinutes),
        }),
    action.state === 'in_progress' ? uiMessage('plan.scheduling-dialogs.1621') : null,
    action.projectTitle ?? null,
    note ?? null,
  ].filter((value): value is string => value !== null);
  return (
    <li className="action-row" {...actionDragProps(action.id)}>
      <p className="action-row-title">
        <Link to={actionPath(action.id)} draggable={false}>
          {action.title}
        </Link>
      </p>
      {facts.length > 0 && <p className="field-help action-row-facts">{facts.join(' · ')}</p>}
      <div className="control-row">{children}</div>
    </li>
  );
}

/* ───────────────────────── Dialog host ───────────────────────── */

/**
 * Every scheduling dialog for one view. Each stays mounted so the shared Modal returns focus to
 * the control that opened it; content renders only while open.
 */
export function PlanDialogs({
  onClose,
  onSavedTemplate,
  profile,
  request,
  runner,
  viewDate,
}: {
  readonly onClose: () => void;
  readonly onSavedTemplate?: () => void;
  readonly profile: PlanProfile;
  readonly request: DialogRequest | null;
  readonly runner: CommandRunner;
  readonly viewDate: string;
}): ReactNode {
  const close = (): void => {
    runner.clearError();
    onClose();
  };
  const pick = <Kind extends DialogRequest['kind']>(kind: Kind): RequestOf<Kind> | null =>
    request !== null && request.kind === kind ? (request as RequestOf<Kind>) : null;
  const shared = { onClose: close, onDone: onClose, profile, runner };
  const editing = pick('editOccurrence');
  return (
    <>
      <ScheduleActionDialog request={pick('schedule')} {...shared} />
      <CustomBlockDialog request={pick('customBlock')} {...shared} />
      <CommitmentDialog request={pick('commitment')} {...shared} />
      <MoveBlockDialog request={pick('move')} {...shared} />
      <ShortenDialog request={pick('shorten')} {...shared} />
      <CompleteActionBlockDialog request={pick('completeActionBlock')} {...shared} />
      <CancelBlockDialog request={pick('cancelBlock')} {...shared} />
      <BlockReminderDialog request={pick('blockReminder')} {...shared} />
      <PlaceActionDialog request={pick('place')} viewDate={viewDate} {...shared} />
      <PlaceOnDayDialog request={pick('placeOn')} {...shared} />
      <KeepOverlapDialog request={pick('keepOverlap')} {...shared} />
      <Modal
        open={editing !== null}
        eyebrow={editing?.occurrence.ref.routineTitle ?? uiMessage('plan.routine-form.1531')}
        title={uiMessage('plan.occurrence-controls.1252')}
        description={uiMessage('plan.occurrence-controls.1253')}
        onClose={close}
      >
        {editing !== null && (
          <EditOccurrenceForm
            entry={editing.occurrence}
            focus={editing.focus}
            profile={profile}
            runner={runner}
            onCancel={close}
            onDone={onClose}
          />
        )}
      </Modal>
      <SaveWeekTemplateDialog
        request={pick('saveWeekTemplate')}
        {...shared}
        onDone={() => {
          onClose();
          onSavedTemplate?.();
        }}
      />
    </>
  );
}

interface DialogProps<Kind extends DialogRequest['kind']> {
  readonly request: RequestOf<Kind> | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly profile: PlanProfile;
  readonly runner: CommandRunner;
}

/* ───────────────────────── Shared interval submit ───────────────────────── */

type OverlapCheck =
  | { readonly ok: true; readonly overlaps: number }
  | { readonly ok: false; readonly message: string };

/** Re-resolve the interval at submit time so the overlap decision uses current data. */
async function checkInterval(
  planning: PlanningApplication,
  input: LocalIntervalInput,
  exclude: readonly string[],
): Promise<OverlapCheck> {
  try {
    const result = await planning.resolveLocalInterval(input, exclude);
    if (!result.ok)
      return {
        ok: false,
        message:
          result.error.code === 'domain_rejected'
            ? result.error.domainError.message
            : uiMessage('plan.scheduling-dialogs.1622'),
      };
    return { ok: true, overlaps: result.value.overlaps.length };
  } catch {
    return { ok: false, message: uiMessage('plan.scheduling-dialogs.1622') };
  }
}

const overlapMessage = uiMessage('plan.occurrence-controls.1261');

function useIntervalForm(initial: IntervalDraft, exclude: readonly string[]) {
  const planning = usePlanning();
  const [draft, setDraft] = useState(initial);
  const [keep, setKeep] = useState(false);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const validation = validateInterval(draft);
  const preview = useIntervalPreview(validation.input, exclude);
  const overlaps = previewOverlaps(preview);
  /** Validate and check overlaps; returns the input and acknowledgement or null with errors shown. */
  const prepare = async (
    extra: readonly string[] = [],
  ): Promise<{ readonly input: LocalIntervalInput; readonly acknowledged: boolean } | null> => {
    const next = [...extra, ...validation.errors];
    if (next.length > 0 || validation.input === undefined) {
      setErrors(next);
      return null;
    }
    const check = await checkInterval(planning, validation.input, exclude);
    if (!check.ok) {
      setErrors([check.message]);
      return null;
    }
    if (check.overlaps > 0 && !keep) {
      setErrors([overlapMessage]);
      return null;
    }
    setErrors([]);
    return { input: validation.input, acknowledged: check.overlaps > 0 && keep };
  };
  return { draft, setDraft, keep, setKeep, errors, setErrors, preview, overlaps, prepare };
}

function ErrorList({ errors }: { readonly errors: readonly string[] }): ReactNode {
  if (errors.length === 0) return null;
  return (
    <div className="validation-summary" role="alert">
      {errors.map((error) => (
        <p key={error}>{error}</p>
      ))}
    </div>
  );
}

function IntervalSection({
  autofocus,
  form,
  durationHelp,
  idPrefix,
  profile,
}: {
  readonly autofocus?: 'date' | 'start' | 'duration';
  readonly form: ReturnType<typeof useIntervalForm>;
  readonly durationHelp?: string;
  readonly idPrefix: string;
  readonly profile: PlanProfile;
}): ReactNode {
  return (
    <>
      <IntervalFields
        draft={form.draft}
        idPrefix={idPrefix}
        onChange={form.setDraft}
        {...(durationHelp === undefined ? {} : { durationHelp })}
        {...(autofocus === undefined ? {} : { autofocus })}
      />
      <p className="field-help">
        {uiMessage('plan.scheduling-dialogs.1623')}
        {profile.planningTimeZone}.
      </p>
      <IntervalPreview
        preview={form.preview}
        profile={profile}
        requestedDate={form.draft.date}
        requestedStart={form.draft.startTime}
      />
      {form.overlaps.length > 0 && (
        <KeepOverlapCheckbox id={`${idPrefix}-keep`} checked={form.keep} onChange={form.setKeep} />
      )}
    </>
  );
}

function FormActions({
  busy,
  label,
  onCancel,
}: {
  readonly busy: boolean;
  readonly label: string;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <div className="dialog-actions">
      <button type="button" onClick={onCancel}>
        {uiMessage('account.account-dialogs.20')}
      </button>
      <button type="submit" className="primary-button" disabled={busy}>
        {busy ? uiMessage('account.conflicts-page.133') : label}
      </button>
    </div>
  );
}

/* ───────────────────────── Schedule an Action ───────────────────────── */

export function ScheduleActionDialog(props: DialogProps<'schedule'>): ReactNode {
  const { request, onClose } = props;
  return (
    <Modal
      open={request !== null}
      eyebrow={uiMessage('onboarding-ui.1129')}
      title={
        request === null
          ? uiMessage('plan.scheduling-dialogs.1624')
          : uiMessage('plan.scheduling-dialogs.1625', { value0: request.action.title })
      }
      description={uiMessage('plan.scheduling-dialogs.1626')}
      onClose={onClose}
    >
      {request !== null && <ScheduleActionForm {...props} request={request} />}
    </Modal>
  );
}

function ScheduleActionForm({
  onClose,
  onDone,
  profile,
  request,
  runner,
}: DialogProps<'schedule'> & { readonly request: RequestOf<'schedule'> }): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const estimate = request.action.estimateMinutes;
  const form = useIntervalForm(
    {
      date: request.date,
      startTime: request.startTime ?? '',
      duration: estimate === undefined ? '' : String(estimate),
    },
    [],
  );
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const prepared = await form.prepare();
    if (prepared === null) return;
    const saved = await runner.run(
      () =>
        planning.scheduleAction({
          ...prepared.input,
          actionId: request.action.id,
          revision: request.action.localRevision,
          overlapAcknowledged: prepared.acknowledged,
        }),
      uiMessage('plan.scheduling-dialogs.1627'),
    );
    if (saved) onDone();
  };
  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      <ErrorList errors={form.errors} />
      <DialogError runner={runner} />
      <IntervalSection
        form={form}
        idPrefix="schedule"
        profile={profile}
        autofocus={request.startTime === undefined ? 'start' : 'duration'}
        durationHelp={
          estimate === undefined
            ? uiMessage('plan.scheduling-dialogs.1628')
            : uiMessage('plan.scheduling-dialogs.1629', { value0: formatDuration(estimate) })
        }
      />
      <FormActions busy={runner.busy} label={uiMessage('onboarding-ui.1129')} onCancel={onClose} />
    </form>
  );
}

/* ───────────────────────── Custom time block ───────────────────────── */

export function CustomBlockDialog(props: DialogProps<'customBlock'>): ReactNode {
  return (
    <Modal
      open={props.request !== null}
      eyebrow={uiMessage('plan.timeline.1867')}
      title={uiMessage('plan.scheduling-dialogs.1630')}
      description={uiMessage('plan.scheduling-dialogs.1631')}
      onClose={props.onClose}
    >
      {props.request !== null && <CustomBlockForm {...props} request={props.request} />}
    </Modal>
  );
}

function CustomBlockForm({
  onClose,
  onDone,
  profile,
  request,
  runner,
}: DialogProps<'customBlock'> & { readonly request: RequestOf<'customBlock'> }): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const [title, setTitle] = useState('');
  const form = useIntervalForm({ date: request.date, startTime: '', duration: '' }, []);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const prepared = await form.prepare(
      title.trim() === '' ? [uiMessage('plan.routine-form.1430')] : [],
    );
    if (prepared === null) return;
    const saved = await runner.run(
      () =>
        planning.createCustomBlock({
          ...prepared.input,
          title: title.trim(),
          overlapAcknowledged: prepared.acknowledged,
        }),
      uiMessage('plan.scheduling-dialogs.1632'),
    );
    if (saved) onDone();
  };
  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      <ErrorList errors={form.errors} />
      <DialogError runner={runner} />
      <label className="field-label" htmlFor="custom-block-title">
        {uiMessage('alignment.object-forms.649')}
        <input
          id="custom-block-title"
          data-autofocus
          required
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <IntervalSection form={form} idPrefix="custom-block" profile={profile} />
      <FormActions busy={runner.busy} label={uiMessage('plan.plan-day.1288')} onCancel={onClose} />
    </form>
  );
}

/* ───────────────────────── Fixed commitment ───────────────────────── */

export function CommitmentDialog(props: DialogProps<'commitment'>): ReactNode {
  return (
    <Modal
      open={props.request !== null}
      eyebrow={uiMessage('plan.scheduling-dialogs.2417')}
      title={uiMessage('plan.scheduling-dialogs.1633')}
      description={uiMessage('plan.scheduling-dialogs.1634')}
      onClose={props.onClose}
    >
      {props.request !== null && <CommitmentForm {...props} request={props.request} />}
    </Modal>
  );
}

function CommitmentForm({
  onClose,
  onDone,
  profile,
  request,
  runner,
}: DialogProps<'commitment'> & { readonly request: RequestOf<'commitment'> }): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const [title, setTitle] = useState('');
  const [strength, setStrength] = useState<CommitmentStrength>('hard');
  const form = useIntervalForm({ date: request.date, startTime: '', duration: '' }, []);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const prepared = await form.prepare(
      title.trim() === '' ? [uiMessage('plan.routine-form.1430')] : [],
    );
    if (prepared === null) return;
    const saved = await runner.run(
      () =>
        planning.createCommitment({
          ...prepared.input,
          title: title.trim(),
          strength,
          overlapAcknowledged: prepared.acknowledged,
        }),
      uiMessage('plan.scheduling-dialogs.1635'),
    );
    if (saved) onDone();
  };
  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      <ErrorList errors={form.errors} />
      <DialogError runner={runner} />
      <label className="field-label" htmlFor="commitment-title">
        {uiMessage('alignment.object-forms.649')}
        <input
          id="commitment-title"
          data-autofocus
          required
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <fieldset className="compact-fieldset">
        <legend>{uiMessage('plan.scheduling-dialogs.1636')}</legend>
        <label className="check-row" htmlFor="commitment-hard">
          <input
            id="commitment-hard"
            type="radio"
            name="commitment-strength"
            checked={strength === 'hard'}
            onChange={() => setStrength('hard')}
          />
          <span>
            {uiMessage('plan.capacity-settings.1150')}
            <span className="field-help block-help">
              {uiMessage('plan.scheduling-dialogs.1637')}
            </span>
          </span>
        </label>
        <label className="check-row" htmlFor="commitment-soft">
          <input
            id="commitment-soft"
            type="radio"
            name="commitment-strength"
            checked={strength === 'soft'}
            onChange={() => setStrength('soft')}
          />
          <span>
            {uiMessage('plan.capacity-settings.1152')}
            <span className="field-help block-help">
              {uiMessage('plan.scheduling-dialogs.1638')}
            </span>
          </span>
        </label>
      </fieldset>
      <IntervalSection form={form} idPrefix="commitment" profile={profile} />
      <FormActions
        busy={runner.busy}
        label={uiMessage('plan.scheduling-dialogs.1639')}
        onCancel={onClose}
      />
    </form>
  );
}

/* ───────────────────────── Move and shorten ───────────────────────── */

export function MoveBlockDialog(props: DialogProps<'move'>): ReactNode {
  return (
    <Modal
      open={props.request !== null}
      eyebrow={uiMessage('plan.scheduling-dialogs.1647')}
      title={
        props.request === null
          ? uiMessage('plan.scheduling-dialogs.1640')
          : uiMessage('alignment.milestone-detail.626', { value0: props.request.entry.title })
      }
      onClose={props.onClose}
    >
      {props.request !== null && <MoveBlockForm {...props} request={props.request} />}
    </Modal>
  );
}

function MoveBlockForm({
  onClose,
  onDone,
  profile,
  request,
  runner,
}: DialogProps<'move'> & { readonly request: RequestOf<'move'> }): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const entry = request.entry;
  const form = useIntervalForm(
    {
      date: entry.localDate,
      startTime: entry.localStart,
      duration: String(entry.durationMinutes),
    },
    [entry.key],
  );
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const prepared = await form.prepare();
    if (prepared === null) return;
    const saved = await runner.run(
      () =>
        planning.moveBlock({
          ...prepared.input,
          blockId: entry.block.id,
          revision: entry.block.localRevision,
          overlapAcknowledged: prepared.acknowledged,
        }),
      uiMessage('plan.scheduling-dialogs.1641'),
    );
    if (saved) onDone();
  };
  const kind = entry.block.target.kind;
  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      <ErrorList errors={form.errors} />
      <DialogError runner={runner} />
      <p className="field-help">
        {uiMessage('plan.scheduling-dialogs.1642')}
        {formatDate(entry.localDate, 'weekday')},{' '}
        {formatWallTime(entry.localStart, profile.timeFormat)}
        {uiMessage('plan.scheduling-dialogs.1643')} {formatDuration(entry.durationMinutes)}.
      </p>
      {kind === 'action' && (
        <p className="scope-note">{uiMessage('plan.scheduling-dialogs.1644')}</p>
      )}
      {kind === 'commitment' && (
        <p className="scope-note">{uiMessage('plan.scheduling-dialogs.1645')}</p>
      )}
      <p className="scope-note">{uiMessage('plan.scheduling-dialogs.1646')}</p>
      <IntervalSection form={form} idPrefix="move-block" profile={profile} autofocus="date" />
      <FormActions
        busy={runner.busy}
        label={uiMessage('plan.scheduling-dialogs.1647')}
        onCancel={onClose}
      />
    </form>
  );
}

export function ShortenDialog(props: DialogProps<'shorten'>): ReactNode {
  return (
    <Modal
      open={props.request !== null}
      eyebrow={uiMessage('plan.scheduling-dialogs.1658')}
      title={
        props.request === null
          ? uiMessage('plan.scheduling-dialogs.1648')
          : uiMessage('plan.scheduling-dialogs.1649', { value0: props.request.entry.title })
      }
      description={uiMessage('plan.scheduling-dialogs.1650')}
      onClose={props.onClose}
    >
      {props.request !== null && <ShortenForm {...props} request={props.request} />}
    </Modal>
  );
}

function ShortenForm({
  onClose,
  onDone,
  profile,
  request,
  runner,
}: DialogProps<'shorten'> & { readonly request: RequestOf<'shorten'> }): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const entry = request.entry;
  const [duration, setDuration] = useState('');
  const [errors, setErrors] = useState<readonly string[]>([]);
  const minutes = Number(duration);
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes < entry.durationMinutes;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid) {
      setErrors([
        uiMessage('plan.scheduling-dialogs.1651', { value0: String(entry.durationMinutes) }),
      ]);
      return;
    }
    setErrors([]);
    const saved = await runner.run(
      () =>
        planning.shortenBlock({
          blockId: entry.block.id,
          revision: entry.block.localRevision,
          durationMinutes: minutes,
        }),
      uiMessage('plan.scheduling-dialogs.1652'),
    );
    if (saved) onDone();
  };
  const start = minutesOfWallTime(entry.localStart);
  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      <ErrorList errors={errors} />
      <DialogError runner={runner} />
      <p className="field-help">
        {uiMessage('plan.scheduling-dialogs.1642')}
        {formatWallTime(entry.localStart, profile.timeFormat)} –{' '}
        {formatWallTime(entry.localEnd, profile.timeFormat)} (
        {formatDuration(entry.durationMinutes)}).
      </p>
      <label className="field-label" htmlFor="shorten-duration">
        {uiMessage('plan.scheduling-dialogs.1653')}
        <input
          id="shorten-duration"
          data-autofocus
          type="number"
          inputMode="numeric"
          min={1}
          max={entry.durationMinutes - 1}
          step={1}
          required
          value={duration}
          aria-describedby="shorten-duration-help"
          onChange={(event) => setDuration(event.target.value)}
        />
        <span id="shorten-duration-help">
          {uiMessage('plan.scheduling-dialogs.1654')}
          {String(entry.durationMinutes)}
          {uiMessage('plan.scheduling-dialogs.1655')}
        </span>
      </label>
      <p className="interval-summary" role="status">
        {valid && start + minutes < 24 * 60
          ? uiMessage('plan.scheduling-dialogs.1656', {
              value0: formatWallTime(wallTimeFromMinutes(start + minutes), profile.timeFormat),
            })
          : ''}
      </p>
      <p className="scope-note">{uiMessage('plan.scheduling-dialogs.1657')}</p>
      <FormActions
        busy={runner.busy}
        label={uiMessage('plan.scheduling-dialogs.1658')}
        onCancel={onClose}
      />
    </form>
  );
}

/* ───────────────────────── Block reminder ───────────────────────── */

/**
 * Reminder definitions remain canonical; browser permission and open-app delivery are opt-in
 * through Settings.
 */
export const reminderSavedCopy = uiMessage('plan.routine-form.1428');

/** At most seven days before, like every manual planning reminder. */
const reminderMinutesLimit = 10_080;

export type BlockReminderChoice = 'off' | 'at' | 'relative';

export interface BlockReminderDraft {
  readonly choice: BlockReminderChoice;
  readonly date: string;
  readonly time: string;
  readonly minutes: string;
}

export interface BlockReminderErrors {
  readonly date?: string;
  readonly time?: string;
  readonly minutes?: string;
}

/** A local date and time of an instant in a zone, as the date and time inputs hold them. */
function zonedDateTime(
  instant: string,
  zone: string,
): { readonly date: string; readonly time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}

/**
 * The form a block's reminder dialog opens with: its scheduled reminder (a set time read in the
 * planning zone), or Off with the block's own date and start and 15 minutes ready to choose.
 */
export function blockReminderDraft(
  entry: Pick<TimedEntry, 'localDate' | 'localStart'>,
  reminder: ReminderView | null,
  planningTimeZone: string,
): BlockReminderDraft {
  const base: BlockReminderDraft = {
    choice: 'off',
    date: entry.localDate,
    time: entry.localStart.slice(0, 5),
    minutes: '15',
  };
  if (reminder === null) return base;
  if (reminder.kind === 'relative')
    return { ...base, choice: 'relative', minutes: String(reminder.minutesBefore ?? 0) };
  return { ...base, choice: 'at', ...zonedDateTime(reminder.remindAt, planningTimeZone) };
}

/** Check the draft in words; `input` is null for Off. */
export function validateBlockReminder(draft: BlockReminderDraft): {
  readonly errors: BlockReminderErrors;
  readonly input?: TimeBlockReminderInput | null;
} {
  if (draft.choice === 'off') return { errors: {}, input: null };
  if (draft.choice === 'at') {
    const errors: BlockReminderErrors = {
      ...(isCalendarDate(draft.date) ? {} : { date: uiMessage('plan.scheduling-dialogs.1659') }),
      ...(isWallTime(draft.time) ? {} : { time: uiMessage('plan.scheduling-dialogs.1660') }),
    };
    return Object.keys(errors).length > 0
      ? { errors }
      : { errors, input: { kind: 'at', date: draft.date, time: draft.time.slice(0, 5) } };
  }
  const text = draft.minutes.trim();
  const minutes = Number(text);
  if (!/^\d+$/u.test(text) || minutes > reminderMinutesLimit)
    return { errors: { minutes: uiMessage('plan.scheduling-dialogs.1661') } };
  return { errors: {}, input: { kind: 'relative', minutesBefore: minutes } };
}

/** Whether the chosen reminder is the one the block already has. */
function sameReminder(
  input: TimeBlockReminderInput | null,
  current: ReminderView | null,
  planningTimeZone: string,
): boolean {
  if (input === null || current === null) return input === null && current === null;
  if (input.kind === 'relative')
    return current.kind === 'relative' && current.minutesBefore === input.minutesBefore;
  if (current.kind !== 'at') return false;
  const shown = zonedDateTime(current.remindAt, planningTimeZone);
  return shown.date === input.date && shown.time === input.time;
}

/**
 * Off, At a time, or Before the start (minutes), in one fieldset with its legend. Each error is tied
 * to its field; the choice is native radios, so keyboard and pointer work the same.
 */
export function BlockReminderFieldset({
  draft,
  errors,
  idPrefix,
  onChange,
  startText,
}: {
  readonly draft: BlockReminderDraft;
  readonly errors: BlockReminderErrors;
  readonly idPrefix: string;
  readonly onChange: (draft: BlockReminderDraft) => void;
  /** The block's start in words, for the minutes help. */
  readonly startText: string;
}): ReactNode {
  const name = `${idPrefix}-choice`;
  const helpId = `${idPrefix}-help`;
  const choose = (choice: BlockReminderChoice): void => onChange({ ...draft, choice });
  const described = (field: keyof BlockReminderErrors, help?: string): string | undefined => {
    const ids = [help, errors[field] === undefined ? undefined : `${idPrefix}-${field}-error`];
    const joined = ids.filter((id): id is string => id !== undefined).join(' ');
    return joined === '' ? undefined : joined;
  };
  const fieldError = (field: keyof BlockReminderErrors): ReactNode =>
    errors[field] === undefined ? null : (
      <p id={`${idPrefix}-${field}-error`} className="warning-text">
        {errors[field]}
      </p>
    );
  return (
    <fieldset className="compact-fieldset reminder-fieldset" aria-describedby={helpId}>
      <legend>{uiMessage('plan.routine-form.1510')}</legend>
      <p id={helpId} className="field-help">
        {reminderSavedCopy}
      </p>
      <label className="check-row" htmlFor={`${idPrefix}-off`}>
        <input
          id={`${idPrefix}-off`}
          data-autofocus={draft.choice === 'off' ? true : undefined}
          type="radio"
          name={name}
          checked={draft.choice === 'off'}
          onChange={() => choose('off')}
        />
        <span>{uiMessage('plan.routine-form.1511')}</span>
      </label>
      <label className="check-row" htmlFor={`${idPrefix}-at`}>
        <input
          id={`${idPrefix}-at`}
          data-autofocus={draft.choice === 'at' ? true : undefined}
          type="radio"
          name={name}
          checked={draft.choice === 'at'}
          onChange={() => choose('at')}
        />
        <span>{uiMessage('plan.scheduling-dialogs.1662')}</span>
      </label>
      {draft.choice === 'at' && (
        <div className="nested-fields two-column-fields">
          <label className="field-label" htmlFor={`${idPrefix}-date`}>
            {uiMessage('plan.scheduling-dialogs.1663')}
            <input
              id={`${idPrefix}-date`}
              type="date"
              required
              value={draft.date}
              aria-invalid={errors.date !== undefined}
              aria-describedby={described('date')}
              onChange={(event) => onChange({ ...draft, date: event.target.value })}
            />
          </label>
          <label className="field-label" htmlFor={`${idPrefix}-time`}>
            {uiMessage('plan.scheduling-dialogs.1664')}
            <input
              id={`${idPrefix}-time`}
              type="time"
              required
              value={draft.time}
              aria-invalid={errors.time !== undefined}
              aria-describedby={described('time')}
              onChange={(event) => onChange({ ...draft, time: event.target.value })}
            />
          </label>
          {fieldError('date')}
          {fieldError('time')}
        </div>
      )}
      <label className="check-row" htmlFor={`${idPrefix}-relative`}>
        <input
          id={`${idPrefix}-relative`}
          data-autofocus={draft.choice === 'relative' ? true : undefined}
          type="radio"
          name={name}
          checked={draft.choice === 'relative'}
          onChange={() => choose('relative')}
        />
        <span>{uiMessage('plan.scheduling-dialogs.1665')}</span>
      </label>
      {draft.choice === 'relative' && (
        <div className="nested-fields">
          <label className="field-label" htmlFor={`${idPrefix}-minutes`}>
            {uiMessage('plan.scheduling-dialogs.1666')}
            <input
              id={`${idPrefix}-minutes`}
              type="number"
              inputMode="numeric"
              min={0}
              max={reminderMinutesLimit}
              step={1}
              required
              value={draft.minutes}
              aria-invalid={errors.minutes !== undefined}
              aria-describedby={described('minutes', `${idPrefix}-minutes-help`)}
              onChange={(event) => onChange({ ...draft, minutes: event.target.value })}
            />
            <span id={`${idPrefix}-minutes-help`}>
              {uiMessage('plan.scheduling-dialogs.1667')}
              {startText}.
            </span>
          </label>
          {fieldError('minutes')}
        </div>
      )}
    </fieldset>
  );
}

export function BlockReminderDialog(props: DialogProps<'blockReminder'>): ReactNode {
  return (
    <Modal
      open={props.request !== null}
      eyebrow={uiMessage('plan.routine-form.1510')}
      title={
        props.request === null
          ? uiMessage('plan.scheduling-dialogs.1668')
          : uiMessage('plan.scheduling-dialogs.1669', { value0: props.request.entry.title })
      }
      description={uiMessage('plan.scheduling-dialogs.1670')}
      onClose={props.onClose}
    >
      {props.request !== null && <BlockReminderBody {...props} request={props.request} />}
    </Modal>
  );
}

type ReminderLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly reminder: ReminderView | null }
  | { readonly status: 'error' };

/** Reads the block's current reminder, then shows the form prefilled with it. */
function BlockReminderBody(
  props: DialogProps<'blockReminder'> & { readonly request: RequestOf<'blockReminder'> },
): ReactNode {
  const planning = usePlanning();
  const blockId = props.request.entry.block.id;
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<ReminderLoad>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    setLoad({ status: 'loading' });
    planning
      .getTimeBlockReminder(blockId)
      .then((reminder) => {
        if (active) setLoad({ status: 'ready', reminder });
      })
      .catch(() => {
        if (active) setLoad({ status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [planning, blockId, attempt]);
  if (load.status === 'loading')
    return (
      <p className="field-help" role="status">
        {uiMessage('plan.scheduling-dialogs.1671')}
      </p>
    );
  if (load.status === 'error')
    return (
      <div className="validation-summary" role="alert">
        <p>{uiMessage('plan.scheduling-dialogs.1672')}</p>
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose}>
            {uiMessage('account.account-dialogs.20')}
          </button>
          <button type="button" data-autofocus onClick={() => setAttempt((value) => value + 1)}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      </div>
    );
  return <BlockReminderForm {...props} current={load.reminder} />;
}

function BlockReminderForm({
  current,
  onClose,
  onDone,
  profile,
  request,
  runner,
}: DialogProps<'blockReminder'> & {
  readonly request: RequestOf<'blockReminder'>;
  readonly current: ReminderView | null;
}): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const entry = request.entry;
  const zone = profile.planningTimeZone;
  const [draft, setDraft] = useState(() => blockReminderDraft(entry, current, zone));
  const [errors, setErrors] = useState<BlockReminderErrors>({});
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const checked = validateBlockReminder(draft);
    setErrors(checked.errors);
    if (checked.input === undefined) return;
    const input = checked.input;
    // Choosing what the block already has saves nothing.
    if (sameReminder(input, current, zone)) {
      onDone();
      return;
    }
    const saved =
      input === null
        ? current !== null &&
          (await runner.run(
            () =>
              planning.turnOffTimeBlockReminder({
                blockId: entry.block.id,
                reminderRevision: current.localRevision,
              }),
            uiMessage('plan.routines.1599'),
          ))
        : await runner.run(
            () =>
              planning.setTimeBlockReminder({
                blockId: entry.block.id,
                revision: entry.block.localRevision,
                ...(current === null ? {} : { reminderRevision: current.localRevision }),
                reminder: input,
              }),
            uiMessage('plan.routines.1600'),
          );
    if (saved) onDone();
  };
  const fieldErrors = Object.values(errors).filter((value): value is string => value !== undefined);
  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      <ErrorList errors={fieldErrors} />
      <DialogError runner={runner} />
      <BlockReminderFieldset
        draft={draft}
        errors={errors}
        idPrefix="block-reminder"
        startText={`${formatDate(entry.localDate, 'weekday')}, ${formatWallTime(
          entry.localStart,
          profile.timeFormat,
        )}`}
        onChange={setDraft}
      />
      <p className="field-help">
        {uiMessage('plan.scheduling-dialogs.1623')}
        {zone}.
      </p>
      <FormActions busy={runner.busy} label={uiMessage('plan.routines.1601')} onCancel={onClose} />
    </form>
  );
}

/* ───────────────────────── Block state confirmations ───────────────────────── */

export function CompleteActionBlockDialog(props: DialogProps<'completeActionBlock'>): ReactNode {
  return (
    <Modal
      open={props.request !== null}
      eyebrow={uiMessage('actions-ui.257')}
      title={uiMessage('plan.scheduling-dialogs.1673')}
      onClose={props.onClose}
    >
      {props.request !== null && <CompleteActionBlockForm {...props} request={props.request} />}
    </Modal>
  );
}

function CompleteActionBlockForm({
  onClose,
  onDone,
  request,
  runner,
}: DialogProps<'completeActionBlock'> & {
  readonly request: RequestOf<'completeActionBlock'>;
}): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const [alsoComplete, setAlsoComplete] = useState(false);
  const block = request.entry.block;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const saved = await runner.run(
      () =>
        planning.setBlockState({
          blockId: block.id,
          revision: block.localRevision,
          to: 'completed',
          alsoCompleteAction: alsoComplete,
        }),
      alsoComplete
        ? uiMessage('plan.scheduling-dialogs.1674')
        : uiMessage('plan.scheduling-dialogs.1675'),
    );
    if (saved) onDone();
  };
  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      <DialogError runner={runner} />
      <p>
        {uiMessage('plan.scheduling-dialogs.1676')}
        {request.entry.title}
        {uiMessage('plan.scheduling-dialogs.1677')}
      </p>
      <label className="check-row" htmlFor="complete-also-action">
        <input
          id="complete-also-action"
          data-autofocus
          type="checkbox"
          checked={alsoComplete}
          onChange={(event) => setAlsoComplete(event.target.checked)}
        />
        <span>
          {uiMessage('plan.scheduling-dialogs.1678')}
          <span className="field-help block-help">{uiMessage('plan.scheduling-dialogs.1679')}</span>
        </span>
      </label>
      <FormActions
        busy={runner.busy}
        label={uiMessage('plan.scheduling-dialogs.1680')}
        onCancel={onClose}
      />
    </form>
  );
}

export function CancelBlockDialog(props: DialogProps<'cancelBlock'>): ReactNode {
  const commitment = props.request?.entry.block.target.kind === 'commitment';
  return (
    <Modal
      open={props.request !== null}
      eyebrow={uiMessage('account.account-dialogs.20')}
      title={
        commitment
          ? uiMessage('plan.scheduling-dialogs.1681')
          : uiMessage('plan.scheduling-dialogs.1682')
      }
      onClose={props.onClose}
    >
      {props.request !== null && <CancelBlockBody {...props} request={props.request} />}
    </Modal>
  );
}

function CancelBlockBody({
  onClose,
  onDone,
  request,
  runner,
}: DialogProps<'cancelBlock'> & { readonly request: RequestOf<'cancelBlock'> }): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLDivElement>(null);
  useDialogAutofocus(container);
  const block = request.entry.block;
  const kind = block.target.kind;
  const confirm = async (): Promise<void> => {
    const saved = await runner.run(
      () =>
        planning.setBlockState({
          blockId: block.id,
          revision: block.localRevision,
          to: 'canceled',
        }),
      kind === 'commitment'
        ? uiMessage('plan.scheduling-dialogs.1683')
        : uiMessage('plan.scheduling-dialogs.1684'),
    );
    if (saved) onDone();
  };
  return (
    <div ref={container}>
      <DialogError runner={runner} />
      {kind === 'commitment' ? (
        <p className="warning-note">
          {uiMessage('plan.scheduling-dialogs.1685')}
          {request.entry.title}”.
        </p>
      ) : kind === 'action' ? (
        <p>
          {uiMessage('plan.scheduling-dialogs.1686')}
          {request.entry.title}
          {uiMessage('plan.scheduling-dialogs.1687')}
        </p>
      ) : (
        <p>
          “{request.entry.title}
          {uiMessage('plan.scheduling-dialogs.1688')}
        </p>
      )}
      <p className="field-help">{uiMessage('plan.scheduling-dialogs.1689')}</p>
      <div className="dialog-actions">
        <button type="button" data-autofocus onClick={onClose}>
          {uiMessage('plan.scheduling-dialogs.1690')}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={runner.busy}
          onClick={() => void confirm()}
        >
          {kind === 'commitment'
            ? uiMessage('plan.scheduling-dialogs.1691')
            : uiMessage('plan.scheduling-dialogs.1692')}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Placement ───────────────────────── */

type PlaceChoice = RequestOf<'place'>['choice'];

function placementText(period: PlacementPeriodInput, profile: PlanProfile): string {
  switch (period.kind) {
    case 'day':
      return uiMessage('plan.scheduling-dialogs.1693', { value0: formatDate(period.date, 'long') });
    case 'week': {
      const dates = weekDatesFor(period.date, profile.weekStart);
      const start = dates[0];
      const end = dates[6];
      if (start === undefined || end === undefined)
        return uiMessage('plan.scheduling-dialogs.1694');
      return uiMessage('plan.scheduling-dialogs.1695', { value0: formatWeekRange({ start, end }) });
    }
    case 'month':
      return uiMessage('plan.routine-form.1447', { value0: formatMonth(monthKeyOf(period.date)) });
    case 'year':
      return uiMessage('plan.routine-form.1447', { value0: period.date.slice(0, 4) });
  }
}

export function PlaceActionDialog(
  props: DialogProps<'place'> & { readonly viewDate: string },
): ReactNode {
  return (
    <Modal
      open={props.request !== null}
      eyebrow={uiMessage('alignment.detail-parts.459')}
      title={
        props.request === null
          ? uiMessage('alignment.detail-parts.459')
          : uiMessage('alignment.detail-parts.466', { value0: props.request.target.title })
      }
      description={uiMessage('plan.scheduling-dialogs.1696')}
      onClose={props.onClose}
    >
      {props.request !== null && <PlaceForm {...props} request={props.request} />}
    </Modal>
  );
}

function PlaceForm({
  onClose,
  onDone,
  profile,
  request,
  runner,
  viewDate,
}: DialogProps<'place'> & {
  readonly request: RequestOf<'place'>;
  readonly viewDate: string;
}): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const idBase = useId();
  const weekDates = weekDatesFor(request.date, profile.weekStart);
  const [choice, setChoice] = useState<PlaceChoice>(request.choice);
  const [weekDay, setWeekDay] = useState<string>(
    weekDates.some((date) => date === request.date) ? request.date : (weekDates[0] ?? request.date),
  );
  const [specificDate, setSpecificDate] = useState(request.date);
  const [weekDate, setWeekDate] = useState(request.date);
  const months = Array.from({ length: 13 }, (_, index) =>
    monthKeyOf(shiftMonths(`${monthKeyOf(viewDate)}-01`, index)),
  );
  const [month, setMonth] = useState(monthKeyOf(request.date));
  const [error, setError] = useState<string | null>(null);
  const period: PlacementPeriodInput | null =
    choice === 'day'
      ? { kind: 'day', date: weekDay }
      : choice === 'date'
        ? isCalendarDate(specificDate)
          ? { kind: 'day', date: specificDate }
          : null
        : choice === 'week'
          ? isCalendarDate(weekDate)
            ? { kind: 'week', date: weekDate }
            : null
          : { kind: 'month', date: `${month}-01` };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (period === null) {
      setError(uiMessage('alignment.detail-parts.460'));
      return;
    }
    setError(null);
    const saved = await runner.run(
      () => planning.place({ target: request.target.input, period }),
      uiMessage('plan.scheduling-dialogs.1697', { value0: placementText(period, profile) }),
    );
    if (saved) onDone();
  };
  const option = (value: PlaceChoice, label: string): ReactNode => (
    <label className="check-row" htmlFor={`${idBase}-choice-${value}`}>
      <input
        id={`${idBase}-choice-${value}`}
        type="radio"
        name={`${idBase}-choice`}
        checked={choice === value}
        {...(choice === value ? { 'data-autofocus': true } : {})}
        onChange={() => setChoice(value)}
      />
      <span>{label}</span>
    </label>
  );
  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      {error !== null && (
        <p className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <DialogError runner={runner} />
      <fieldset className="compact-fieldset">
        <legend>{uiMessage('alignment.detail-parts.462')}</legend>
        {option('day', uiMessage('plan.scheduling-dialogs.1698'))}
        {option('date', uiMessage('plan.scheduling-dialogs.1699'))}
        {option('week', uiMessage('plan.scheduling-dialogs.2472'))}
        {option('month', uiMessage('plan.scheduling-dialogs.2474'))}
      </fieldset>
      {choice === 'day' && (
        <label className="field-label" htmlFor={`${idBase}-weekday`}>
          {uiMessage('actions-ui.247')}
          <select
            id={`${idBase}-weekday`}
            value={weekDay}
            onChange={(event) => setWeekDay(event.target.value)}
          >
            {weekDates.map((date) => (
              <option key={date} value={date}>
                {formatDate(date, 'long')}
              </option>
            ))}
          </select>
        </label>
      )}
      {choice === 'date' && (
        <label className="field-label" htmlFor={`${idBase}-date`}>
          {uiMessage('actions-ui.274')}
          <input
            id={`${idBase}-date`}
            type="date"
            value={specificDate}
            onChange={(event) => setSpecificDate(event.target.value)}
          />
        </label>
      )}
      {choice === 'week' && (
        <label className="field-label" htmlFor={`${idBase}-week`}>
          {uiMessage('alignment.detail-parts.464')}
          <input
            id={`${idBase}-week`}
            type="date"
            value={weekDate}
            onChange={(event) => setWeekDate(event.target.value)}
          />
        </label>
      )}
      {choice === 'month' && (
        <label className="field-label" htmlFor={`${idBase}-month`}>
          {uiMessage('actions-ui.249')}
          <select
            id={`${idBase}-month`}
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          >
            {months.map((value) => (
              <option key={value} value={value}>
                {formatMonth(value)}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="interval-summary" role="status">
        {period === null
          ? uiMessage('alignment.detail-parts.460')
          : uiMessage('plan.scheduling-dialogs.1700', {
              value0: request.target.title,
              value1: placementText(period, profile),
            })}
      </p>
      <FormActions
        busy={runner.busy}
        label={uiMessage('alignment.detail-parts.459')}
        onCancel={onClose}
      />
    </form>
  );
}

/** Confirmation after dragging an Action onto a Week day: states the destination first. */
export function PlaceOnDayDialog(props: DialogProps<'placeOn'>): ReactNode {
  const request = props.request;
  return (
    <Modal
      open={request !== null}
      eyebrow={uiMessage('alignment.detail-parts.459')}
      title={
        request === null
          ? uiMessage('plan.scheduling-dialogs.1701')
          : uiMessage('plan.scheduling-dialogs.1702', {
              value0: formatDate(request.date, 'weekday'),
            })
      }
      onClose={props.onClose}
    >
      {request !== null && <PlaceOnDayBody {...props} request={request} />}
    </Modal>
  );
}

function PlaceOnDayBody({
  onClose,
  onDone,
  request,
  runner,
}: DialogProps<'placeOn'> & { readonly request: RequestOf<'placeOn'> }): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLDivElement>(null);
  useDialogAutofocus(container);
  const confirm = async (): Promise<void> => {
    const saved = await runner.run(
      () =>
        planning.place({
          target: request.target.input,
          period: { kind: 'day', date: request.date },
        }),
      uiMessage('plan.plan-day.1307', { value0: formatDate(request.date, 'long') }),
    );
    if (saved) onDone();
  };
  return (
    <div ref={container}>
      <DialogError runner={runner} />
      <p>
        “{request.target.title}
        {uiMessage('plan.scheduling-dialogs.1703')}
        {formatDate(request.date, 'long')}
        {uiMessage('plan.scheduling-dialogs.1704')}
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {uiMessage('plan.scheduling-dialogs.1705')}
        </button>
        <button
          type="button"
          className="primary-button"
          data-autofocus
          disabled={runner.busy}
          onClick={() => void confirm()}
        >
          {uiMessage('plan.scheduling-dialogs.1706')}
          {formatDate(request.date, 'weekday')}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Keep overlap ───────────────────────── */

export function KeepOverlapDialog(props: DialogProps<'keepOverlap'>): ReactNode {
  return (
    <Modal
      open={props.request !== null}
      eyebrow={uiMessage('plan.scheduling-dialogs.2418')}
      title={uiMessage('plan.scheduling-dialogs.1707')}
      description={uiMessage('plan.scheduling-dialogs.1708')}
      onClose={props.onClose}
    >
      {props.request !== null && <KeepOverlapBody {...props} request={props.request} />}
    </Modal>
  );
}

function KeepOverlapBody({
  onClose,
  onDone,
  profile,
  request,
  runner,
}: DialogProps<'keepOverlap'> & { readonly request: RequestOf<'keepOverlap'> }): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLDivElement>(null);
  useDialogAutofocus(container);
  const { first, second } = request.conflict;
  const firstRef = timedItemRef(first);
  const secondRef = timedItemRef(second);
  const confirm = async (): Promise<void> => {
    if (firstRef === null || secondRef === null) return;
    const saved = await runner.run(
      () => planning.keepOverlap({ first: firstRef, second: secondRef }),
      uiMessage('plan.scheduling-dialogs.1709'),
    );
    if (saved) onDone();
  };
  const describe = (entry: TimedEntry): string =>
    `${formatWallTime(entry.localStart, profile.timeFormat)} – ${formatWallTime(
      entry.localEnd,
      profile.timeFormat,
    )} ${entry.title}`;
  return (
    <div ref={container}>
      <DialogError runner={runner} />
      <ul className="overlap-pair">
        <li>{describe(first)}</li>
        <li>{describe(second)}</li>
      </ul>
      {(firstRef === null || secondRef === null) && (
        <p className="warning-note">{uiMessage('plan.scheduling-dialogs.1710')}</p>
      )}
      <div className="dialog-actions">
        <button type="button" data-autofocus onClick={onClose}>
          {uiMessage('plan.scheduling-dialogs.1711')}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={runner.busy || firstRef === null || secondRef === null}
          onClick={() => void confirm()}
        >
          {uiMessage('plan.scheduling-dialogs.1712')}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Save week as template ───────────────────────── */

export function SaveWeekTemplateDialog(props: DialogProps<'saveWeekTemplate'>): ReactNode {
  return (
    <Modal
      open={props.request !== null}
      eyebrow={uiMessage('plan.templates.1798')}
      title={uiMessage('plan.plan-week.1348')}
      description={uiMessage('plan.scheduling-dialogs.1713')}
      onClose={props.onClose}
    >
      {props.request !== null && <SaveWeekTemplateForm {...props} request={props.request} />}
    </Modal>
  );
}

function SaveWeekTemplateForm({
  onClose,
  onDone,
  request,
  runner,
}: DialogProps<'saveWeekTemplate'> & {
  readonly request: RequestOf<'saveWeekTemplate'>;
}): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (title.trim() === '') {
      setError(uiMessage('plan.scheduling-dialogs.1714'));
      return;
    }
    setError(null);
    const saved = await runner.run(
      () => planning.saveWeekAsTemplate({ weekDate: request.weekDate, title: title.trim() }),
      uiMessage('plan.scheduling-dialogs.1715'),
    );
    if (saved) onDone();
  };
  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      {error !== null && (
        <p className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <DialogError runner={runner} />
      <label className="field-label" htmlFor="week-template-title">
        {uiMessage('plan.scheduling-dialogs.1716')}
        <input
          id="week-template-title"
          data-autofocus
          required
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <FormActions
        busy={runner.busy}
        label={uiMessage('plan.scheduling-dialogs.1717')}
        onCancel={onClose}
      />
    </form>
  );
}
