import { message as uiMessage } from '../messages';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type {
  OccurrenceEntry,
  OccurrenceIntervalInput,
  OccurrenceTargetInput,
  PlanProfile,
} from '@yelaxis/application';
import type { RoutineSchedulingMode } from '@yelaxis/domain';

import { formatDate, formatInstantTime, formatWallTime } from './format';
import { Modal } from './modal';
import {
  CommandFeedback,
  useCommandRunner,
  usePlanning,
  usePlanningOptional,
  type CommandRunner,
} from './planning-context';
import { routinePath } from './routes';
import {
  DialogError,
  KeepOverlapCheckbox,
  dateInZone,
  isCalendarDate,
  isWallTime,
  previewOverlaps,
  stateLabel,
  useDialogAutofocus,
  wallTimeInZone,
  type IntervalPreviewState,
} from './timeline';

import './occurrence-controls.css';

/** Command target for a projected or materialized Routine Occurrence. */
export function occurrenceTarget(entry: OccurrenceEntry): OccurrenceTargetInput {
  return {
    routineId: entry.ref.routineId,
    generation: entry.ref.generation,
    period: entry.ref.period,
    ...(entry.ref.materialized && entry.ref.localRevision !== undefined
      ? { revision: entry.ref.localRevision }
      : {}),
  };
}

export const occurrenceKeyOf = (entry: OccurrenceEntry): string =>
  `occurrence:${entry.ref.occurrenceId}`;

/** Neutral state text; weekly counts read "n of target this week". Skipped is never alarming. */
export function occurrenceStatusText(entry: OccurrenceEntry): string {
  if (entry.timing.kind === 'weekly_count') {
    const done = entry.completedCount ?? 0;
    const target =
      entry.targetCount ?? (entry.ref.period.kind === 'week' ? entry.ref.period.targetCount : 0);
    return uiMessage('plan.occurrence-controls.1232', {
      value0: String(done),
      value1: String(target),
    });
  }
  return stateLabel(entry.state);
}

/**
 * Complete / Skip / Reopen, weekly Log one / Undo last, and Edit this occurrence for one Routine
 * Occurrence. Pass a shared `runner` to report through the surrounding view; otherwise the
 * controls show their own feedback. Without planning services they render read-only status.
 * `compact` (Today's Routines list) keeps the status and the Complete / Skip (or Log one) choices,
 * links to the Routine as "Details", and leaves Edit this occurrence to the Plan views.
 */
export function OccurrenceControls({
  compact = false,
  entry,
  profile,
  runner,
}: {
  readonly compact?: boolean;
  readonly entry: OccurrenceEntry;
  readonly profile?: PlanProfile;
  readonly runner?: CommandRunner;
}): ReactNode {
  const planning = usePlanningOptional();
  if (planning === null)
    return (
      <div className={compact ? 'occurrence-controls is-compact' : 'occurrence-controls'}>
        <span className="status-pill occurrence-state">{occurrenceStatusText(entry)}</span>
        <Link to={routinePath(entry.ref.routineId)}>
          {compact
            ? uiMessage('plan.occurrence-controls.1233')
            : uiMessage('plan.occurrence-controls.1234')}{' '}
          <span className="sr-only">
            {uiMessage('plan.occurrence-controls.1235')}
            {entry.ref.routineTitle}
          </span>
        </Link>
      </div>
    );
  return (
    <ConnectedOccurrenceControls
      compact={compact}
      entry={entry}
      {...(profile === undefined ? {} : { profile })}
      {...(runner === undefined ? {} : { runner })}
    />
  );
}

function ConnectedOccurrenceControls({
  compact,
  entry,
  profile,
  runner: shared,
}: {
  readonly compact: boolean;
  readonly entry: OccurrenceEntry;
  readonly profile?: PlanProfile;
  readonly runner?: CommandRunner;
}): ReactNode {
  const own = useCommandRunner();
  const runner = shared ?? own;
  const planning = usePlanningOptional();
  const [dialog, setDialog] = useState<'edit' | 'extra' | null>(null);
  if (planning === null) return null;
  const title = entry.ref.routineTitle;
  const target = occurrenceTarget(entry);
  const context = (
    <>
      {' '}
      <span className="sr-only">{title}</span>
    </>
  );
  const weekly = entry.timing.kind === 'weekly_count';
  const done = entry.completedCount ?? 0;
  const goal =
    entry.targetCount ?? (entry.ref.period.kind === 'week' ? entry.ref.period.targetCount : 0);
  const dated = entry.ref.period.kind === 'date';
  const close = (): void => {
    runner.clearError();
    setDialog(null);
  };

  return (
    <div className={compact ? 'occurrence-controls is-compact' : 'occurrence-controls'}>
      <span className="status-pill occurrence-state">{occurrenceStatusText(entry)}</span>
      {entry.moved && (
        <span className="field-help">{uiMessage('plan.occurrence-controls.1236')}</span>
      )}
      {entry.timing.kind === 'dst_skipped' && (
        <span className="field-help">{uiMessage('plan.occurrence-controls.1237')}</span>
      )}
      <div className="control-row">
        {weekly ? (
          <>
            <button
              type="button"
              disabled={runner.busy}
              onClick={() => {
                if (done >= goal) setDialog('extra');
                else
                  void runner.run(
                    () => planning.completeOccurrence({ occurrence: target }),
                    uiMessage('plan.occurrence-controls.1238'),
                  );
              }}
            >
              {uiMessage('plan.occurrence-controls.1239')}
              {context}
            </button>
            {done > 0 && (
              <button
                type="button"
                disabled={runner.busy}
                onClick={() =>
                  void runner.run(
                    () => planning.reopenOccurrence({ occurrence: target }),
                    uiMessage('plan.occurrence-controls.1240'),
                  )
                }
              >
                {uiMessage('plan.occurrence-controls.1241')}
                {context}
              </button>
            )}
          </>
        ) : entry.state === 'planned' ? (
          <>
            <button
              type="button"
              disabled={runner.busy}
              onClick={() =>
                void runner.run(
                  () => planning.completeOccurrence({ occurrence: target }),
                  uiMessage('plan.occurrence-controls.1242'),
                )
              }
            >
              {uiMessage('actions-ui.257')}
              {context}
            </button>
            <button
              type="button"
              disabled={runner.busy}
              onClick={() =>
                void runner.run(
                  () => planning.skipOccurrence({ occurrence: target }),
                  uiMessage('plan.conflicts.1228'),
                )
              }
            >
              {uiMessage('plan.occurrence-controls.1243')}
              {context}
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={runner.busy}
            onClick={() =>
              void runner.run(
                () => planning.reopenOccurrence({ occurrence: target }),
                uiMessage('plan.occurrence-controls.1244'),
              )
            }
          >
            {uiMessage('alignment.milestone-detail.603')}
            {context}
          </button>
        )}
        {!compact && dated && entry.state === 'planned' && (
          <button type="button" disabled={runner.busy} onClick={() => setDialog('edit')}>
            {uiMessage('plan.occurrence-controls.1245')}
            {context}
          </button>
        )}
        <Link className="routine-link" to={routinePath(entry.ref.routineId)}>
          {compact
            ? uiMessage('plan.occurrence-controls.1233')
            : uiMessage('plan.occurrence-controls.1234')}
          {context}
        </Link>
      </div>
      {shared === undefined && <CommandFeedback runner={own} showError={dialog === null} />}
      <Modal
        open={dialog === 'extra'}
        eyebrow={uiMessage('plan.occurrence-controls.2414')}
        title={uiMessage('plan.occurrence-controls.1246')}
        onClose={close}
      >
        <p>
          {title}
          {uiMessage('plan.occurrence-controls.1247')}
          {String(done)}
          {uiMessage('actions-ui.321')}
          {String(goal)}
          {uiMessage('plan.occurrence-controls.1248')}
        </p>
        <DialogError runner={runner} />
        <div className="dialog-actions">
          <button type="button" data-autofocus onClick={close}>
            {uiMessage('plan.occurrence-controls.1249')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={runner.busy}
            onClick={() =>
              void runner
                .run(
                  () => planning.completeOccurrence({ occurrence: target, confirmExtra: true }),
                  uiMessage('plan.occurrence-controls.1250'),
                )
                .then((saved) => {
                  if (saved) setDialog(null);
                })
            }
          >
            {uiMessage('plan.occurrence-controls.1251')}
          </button>
        </div>
      </Modal>
      <Modal
        open={dialog === 'edit'}
        eyebrow={title}
        title={uiMessage('plan.occurrence-controls.1252')}
        description={uiMessage('plan.occurrence-controls.1253')}
        onClose={close}
      >
        {dialog === 'edit' && (
          <EditOccurrenceForm
            entry={entry}
            runner={runner}
            onDone={() => setDialog(null)}
            onCancel={close}
            {...(profile === undefined ? {} : { profile })}
          />
        )}
      </Modal>
    </div>
  );
}

/**
 * This-occurrence edit: a new date and, optionally, a time. Times are read in the zone the Routine
 * resolves in (its fixed zone, else the planning zone), so an unchanged field never moves the
 * occurrence. A time-specific occurrence sends only the fields that changed; a day-flexible one
 * takes a start and a duration together, or neither. Any overlap needs an explicit Keep-overlap
 * choice.
 */
export function EditOccurrenceForm(props: {
  readonly entry: OccurrenceEntry;
  readonly focus?: 'date' | 'duration';
  readonly onCancel: () => void;
  readonly onDone: () => void;
  readonly profile?: PlanProfile;
  readonly runner: CommandRunner;
}): ReactNode {
  const { entry, onCancel, profile } = props;
  const planning = usePlanningOptional();
  const needsRoutine = entry.timing.kind === 'timed' || entry.timing.kind === 'dst_skipped';
  const [loaded, setLoaded] = useState<RoutineTimeState>(
    needsRoutine
      ? { status: 'loading' }
      : {
          status: 'ready',
          mode: { kind: 'day_flexible' },
          ...(profile === undefined ? {} : { planningTimeZone: profile.planningTimeZone }),
        },
  );
  const routineId = entry.ref.routineId;
  const generation = entry.ref.generation;
  useEffect(() => {
    if (!needsRoutine || planning === null) return;
    let active = true;
    planning
      .getRoutine(routineId)
      .then((detail) => {
        if (!active) return;
        const spec = detail?.routine.generations.find((item) => item.generation === generation);
        setLoaded(
          detail === null || spec === undefined
            ? { status: 'error' }
            : {
                status: 'ready',
                mode: spec.schedulingMode,
                planningTimeZone: detail.profile.planningTimeZone,
              },
        );
      })
      .catch(() => {
        if (active) setLoaded({ status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [generation, needsRoutine, planning, routineId]);

  if (planning === null) return null;
  if (loaded.status !== 'ready')
    return (
      <div>
        {loaded.status === 'loading' ? (
          <p className="field-help" role="status">
            {uiMessage('plan.occurrence-controls.1254')}
          </p>
        ) : (
          <p className="validation-summary" role="alert">
            {uiMessage('plan.occurrence-controls.1255')}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {uiMessage('account.account-dialogs.20')}
          </button>
        </div>
      </div>
    );
  return (
    <OccurrenceEditFields
      {...props}
      mode={loaded.mode}
      {...(loaded.planningTimeZone === undefined
        ? {}
        : { planningTimeZone: loaded.planningTimeZone })}
    />
  );
}

type RoutineTimeState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      readonly mode: RoutineSchedulingMode;
      readonly planningTimeZone?: string;
    };

const minutesBetween = (startsAt: string, endsAt: string): number =>
  Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60000);

const isDuration = (value: string): boolean => {
  const minutes = Number(value);
  return value.trim() !== '' && Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
};

function OccurrenceEditFields({
  entry,
  focus = 'date',
  mode,
  onCancel,
  onDone,
  planningTimeZone,
  profile,
  runner,
}: {
  readonly entry: OccurrenceEntry;
  readonly focus?: 'date' | 'duration';
  readonly mode: RoutineSchedulingMode;
  readonly onCancel: () => void;
  readonly onDone: () => void;
  readonly planningTimeZone?: string;
  readonly profile?: PlanProfile;
  readonly runner: CommandRunner;
}): ReactNode {
  const planning = usePlanning();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const fixedTime = mode.kind === 'time_specific';
  const zone =
    mode.kind === 'time_specific' && mode.zonePolicy.kind === 'fixed_zone'
      ? mode.zonePolicy.timeZone
      : planningTimeZone;
  const timeFormat = profile?.timeFormat ?? '24_hour';
  // The occurrence's own local date (its move date when moved), never a planning-zone reading.
  const initialDate = entry.date ?? (entry.ref.period.kind === 'date' ? entry.ref.period.date : '');
  const timed = entry.timing.kind === 'timed' ? entry.timing : null;
  const initialStart =
    timed !== null && zone !== undefined ? wallTimeInZone(timed.startsAt, zone) : '';
  const initialDuration =
    timed !== null
      ? String(minutesBetween(timed.startsAt, timed.endsAt))
      : mode.kind === 'time_specific'
        ? String(mode.durationMinutes)
        : '';
  const [date, setDate] = useState<string>(initialDate);
  const [startTime, setStartTime] = useState(initialStart);
  const [duration, setDuration] = useState(initialDuration);
  const [keep, setKeep] = useState(false);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const durationNumber = Number(duration);
  const startChanged = startTime !== initialStart;
  const durationChanged = duration !== initialDuration;
  const hasTime = startTime !== '' || duration.trim() !== '';
  const completeTime = isCalendarDate(date) && isWallTime(startTime) && isDuration(duration);
  // The preview sends exactly what Save sends: for a time-specific Routine, unchanged time fields
  // are omitted so the application keeps the stored wall time and duration (which may differ from
  // the displayed start on a clock-change day).
  const previewInput: OccurrenceIntervalInput | undefined = !isCalendarDate(date)
    ? undefined
    : fixedTime
      ? (startChanged && !isWallTime(startTime)) || (durationChanged && !isDuration(duration))
        ? undefined
        : {
            occurrence: occurrenceTarget(entry),
            date,
            ...(startChanged ? { startTime } : {}),
            ...(durationChanged ? { durationMinutes: durationNumber } : {}),
          }
      : completeTime
        ? { occurrence: occurrenceTarget(entry), date, startTime, durationMinutes: durationNumber }
        : undefined;
  const preview = useOccurrencePreview(previewInput, occurrenceKeyOf(entry));
  const overlaps = previewOverlaps(preview);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const next: string[] = [];
    if (!isCalendarDate(date)) next.push(uiMessage('alignment.detail-parts.460'));
    if (fixedTime) {
      if (startChanged && !isWallTime(startTime))
        next.push(uiMessage('plan.occurrence-controls.1256'));
      if (durationChanged && !isDuration(duration))
        next.push(uiMessage('plan.occurrence-controls.1257'));
    } else if (hasTime) {
      if (!isWallTime(startTime)) next.push(uiMessage('plan.occurrence-controls.1258'));
      if (!isDuration(duration)) next.push(uiMessage('plan.occurrence-controls.1259'));
    }
    if (
      completeTime &&
      next.length === 0 &&
      preview.status !== 'ready' &&
      preview.status !== 'error'
    )
      next.push(uiMessage('plan.occurrence-controls.1260'));
    if (overlaps.length > 0 && !keep) next.push(uiMessage('plan.occurrence-controls.1261'));
    setErrors(next);
    if (next.length > 0) return;
    // A time-specific occurrence sends only what changed, so an unchanged field is never re-read.
    const time = fixedTime
      ? {
          ...(startChanged ? { startTime } : {}),
          ...(durationChanged ? { durationMinutes: durationNumber } : {}),
        }
      : hasTime
        ? { startTime, durationMinutes: durationNumber }
        : {};
    void runner
      .run(
        () =>
          planning.editOccurrence({
            occurrence: occurrenceTarget(entry),
            date,
            ...time,
            overlapAcknowledged: overlaps.length > 0 && keep,
          }),
        uiMessage('plan.occurrence-controls.1262'),
      )
      .then((saved) => {
        if (saved) onDone();
      });
  };

  return (
    <form ref={container} noValidate onSubmit={submit}>
      {errors.length > 0 && (
        <div className="validation-summary" role="alert">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      <DialogError runner={runner} />
      <label className="field-label" htmlFor="occurrence-edit-date">
        {uiMessage('actions-ui.274')}
        <input
          id="occurrence-edit-date"
          type="date"
          required
          value={date}
          {...(focus === 'date' ? { 'data-autofocus': true } : {})}
          onChange={(event) => setDate(event.target.value)}
        />
        {entry.ref.period.kind === 'date' && (
          <span>
            {uiMessage('plan.occurrence-controls.1263')}
            {formatDate(entry.ref.period.date, 'weekday')}.
          </span>
        )}
      </label>
      <fieldset className="compact-fieldset">
        <legend>
          {fixedTime
            ? uiMessage('plan.occurrence-controls.1264')
            : uiMessage('plan.occurrence-controls.1265')}
        </legend>
        <p className="field-help">
          {mode.kind === 'time_specific'
            ? uiMessage('plan.occurrence-controls.1266', {
                value0: formatWallTime(mode.wallTime, timeFormat),
                value1: String(mode.durationMinutes),
              })
            : uiMessage('plan.occurrence-controls.1267')}
        </p>
        {zone !== undefined && (
          <p id="occurrence-edit-zone" className="field-help">
            {uiMessage('plan.occurrence-controls.1268')}
            {zone}.
            {planningTimeZone !== undefined && zone !== planningTimeZone
              ? uiMessage('plan.occurrence-controls.1269', { value0: planningTimeZone })
              : ''}
          </p>
        )}
        <div className="two-column-fields">
          <label className="field-label" htmlFor="occurrence-edit-start">
            {uiMessage('plan.occurrence-controls.1270')}
            <input
              id="occurrence-edit-start"
              type="time"
              value={startTime}
              {...(zone === undefined ? {} : { 'aria-describedby': 'occurrence-edit-zone' })}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </label>
          <label className="field-label" htmlFor="occurrence-edit-duration">
            {uiMessage('plan.occurrence-controls.1271')}
            <input
              id="occurrence-edit-duration"
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              step={1}
              value={duration}
              {...(focus === 'duration' ? { 'data-autofocus': true } : {})}
              onChange={(event) => setDuration(event.target.value)}
            />
          </label>
        </div>
      </fieldset>
      {previewInput !== undefined && (
        <OccurrencePreview
          preview={preview}
          requestedDate={date}
          {...(fixedTime && !startChanged ? {} : { requestedStart: startTime })}
          timeFormat={timeFormat}
          {...(zone === undefined ? {} : { zone })}
          {...(planningTimeZone === undefined ? {} : { planningTimeZone })}
        />
      )}
      {overlaps.length > 0 && (
        <KeepOverlapCheckbox id="occurrence-edit-keep" checked={keep} onChange={setKeep} />
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button type="submit" className="primary-button" disabled={runner.busy}>
          {uiMessage('plan.occurrence-controls.1272')}
        </button>
      </div>
    </form>
  );
}

/**
 * Live preview of a This-occurrence edit. The application resolves it in the Routine's zone with
 * its clock-change policies, exactly as the save would.
 */
function useOccurrencePreview(
  input: OccurrenceIntervalInput | undefined,
  ownKey: string,
): IntervalPreviewState {
  const planning = usePlanning();
  const [state, setState] = useState<IntervalPreviewState>({ status: 'idle' });
  const key =
    input === undefined
      ? ''
      : `${input.date}|${input.startTime ?? '-'}|${String(input.durationMinutes ?? '-')}`;
  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => {
    const current = inputRef.current;
    if (current === undefined) {
      setState({ status: 'idle' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    const timer = window.setTimeout(() => {
      planning
        .resolveLocalInterval(current, [ownKey])
        .then((result) => {
          if (!active) return;
          setState(
            result.ok
              ? { status: 'ready', resolution: result.value }
              : {
                  status: 'error',
                  message:
                    result.error.code === 'domain_rejected'
                      ? result.error.domainError.message
                      : uiMessage('plan.occurrence-controls.1273'),
                },
          );
        })
        .catch(() => {
          if (active)
            setState({ status: 'error', message: uiMessage('plan.occurrence-controls.1273') });
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // `key` captures every input that changes the resolution.
  }, [key, ownKey, planning]);
  return state;
}

function OccurrencePreview({
  planningTimeZone,
  preview,
  requestedDate,
  requestedStart,
  timeFormat,
  zone,
}: {
  readonly planningTimeZone?: string;
  readonly preview: IntervalPreviewState;
  readonly requestedDate: string;
  /** The start typed by the user; absent when the occurrence keeps its usual time. */
  readonly requestedStart?: string;
  readonly timeFormat: PlanProfile['timeFormat'];
  readonly zone?: string;
}): ReactNode {
  let content: ReactNode = null;
  if (preview.status === 'loading')
    content = <p className="field-help">{uiMessage('plan.occurrence-controls.1274')}</p>;
  else if (preview.status === 'error')
    content = <p className="field-help warning-text">{preview.message}</p>;
  else if (preview.status === 'ready') {
    const resolution = preview.resolution;
    const shownZone = resolution.timeZone ?? zone;
    const requested =
      requestedStart === undefined
        ? uiMessage('plan.occurrence-controls.1275')
        : formatWallTime(requestedStart, timeFormat);
    const local = formatWallTime(resolution.localStart, timeFormat);
    const elsewhere =
      planningTimeZone !== undefined && shownZone !== undefined && shownZone !== planningTimeZone;
    content = (
      <>
        <p className="interval-summary">
          {local} – {formatWallTime(resolution.localEnd, timeFormat)}
          {resolution.localEndDate !== requestedDate &&
            uiMessage('plan.occurrence-controls.1276', {
              value0: formatDate(resolution.localEndDate, 'weekday'),
            })}
          {shownZone === undefined
            ? ''
            : uiMessage('plan.occurrence-controls.1277', { value0: shownZone })}
          {uiMessage('plan.occurrence-controls.1278')}
          {resolution.utcOffset})
        </p>
        {elsewhere && (
          <p className="field-help">
            {uiMessage('plan.occurrence-controls.1279')}
            {planningTimeZone}):{' '}
            {formatDate(dateInZone(resolution.startsAt, planningTimeZone), 'weekday')},{' '}
            {formatInstantTime(resolution.startsAt, planningTimeZone, timeFormat)}.
          </p>
        )}
        {resolution.adjustment === 'dst_gap_shifted' && (
          <p className="warning-note">
            {requested}
            {uiMessage('plan.occurrence-controls.1280')}
            {local}.
          </p>
        )}
        {resolution.adjustment === 'dst_repeated_earlier' && (
          <p className="warning-note">
            {requested}
            {uiMessage('plan.occurrence-controls.1281')}
          </p>
        )}
        {resolution.adjustment === 'dst_repeated_later' && (
          <p className="warning-note">
            {requested}
            {uiMessage('plan.occurrence-controls.1282')}
          </p>
        )}
        {resolution.overlaps.length > 0 && (
          <div className="warning-note">
            <p className="warning-text">{uiMessage('plan.occurrence-controls.1283')}</p>
            <ul>
              {resolution.overlaps.map((item) => (
                <li key={item.key}>{item.title}</li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }
  return (
    <div className="interval-preview" role="status">
      {content}
    </div>
  );
}
