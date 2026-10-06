import { message as uiMessage } from '../messages';
import { useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';

import type {
  LocalIntervalInput,
  LocalTimeResolution,
  PlanProfile,
  TimedEntry,
} from '@yelaxis/application';
import type { CalendarDate, Weekday } from '@yelaxis/domain';

import { ItemPageControls, useItemPage } from '../item-pages';

import { formatDate, formatWallTime } from './format';
import { autofocusIn, focusIsOnField, mayMoveAutofocus } from './modal';
import { RunnerAnnouncement, UndoBar, usePlanning, type CommandRunner } from './planning-context';

import './timeline.css';

/* ───────────────────────── Calendar helpers (presentation only) ───────────────────────── */

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/u;

const asDate = (value: string): CalendarDate => value as CalendarDate;
const utcDate = (value: string): Date => new Date(`${value}T00:00:00Z`);
const isoDate = (value: Date): CalendarDate => asDate(value.toISOString().slice(0, 10));

/** A real `YYYY-MM-DD` calendar date (rejects 2026-02-30 and similar). */
export function isCalendarDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const parsed = utcDate(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isWallTime(value: string): boolean {
  return timePattern.test(value);
}

export function shiftDays(date: string, days: number): CalendarDate {
  const value = utcDate(date);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

/** Move by whole months, keeping the day when it exists and otherwise the month's last day. */
export function shiftMonths(date: string, months: number): CalendarDate {
  const value = utcDate(date);
  const day = value.getUTCDate();
  const target = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return isoDate(target);
}

const weekdayOrder: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function weekdayOfDate(date: string): Weekday {
  return weekdayOrder[utcDate(date).getUTCDay()] ?? 'monday';
}

/** The seven dates of the week containing `date`, starting on `weekStart`. */
export function weekDatesFor(date: string, weekStart: Weekday): readonly CalendarDate[] {
  const offset =
    (utcDate(date).getUTCDay() - weekdayOrder.indexOf(weekStart) + 7) % weekdayOrder.length;
  const start = shiftDays(date, -offset);
  return Array.from({ length: 7 }, (_, index) => shiftDays(start, index));
}

export function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

/** Minutes after local midnight for a `HH:MM` wall time. */
export function minutesOfWallTime(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

export function wallTimeFromMinutes(minutes: number): string {
  const safe = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

/** `HH:MM` wall time of an instant in the planning zone (used to prefill forms). */
export function wallTimeInZone(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

/** Local calendar date of an instant in the planning zone. */
export function dateInZone(instant: string, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '';
  return asDate(`${part('year')}-${part('month')}-${part('day')}`);
}

/* ───────────────────────── Labels ───────────────────────── */

export function entryKindLabel(entry: TimedEntry): string {
  switch (entry.kind) {
    case 'action_block':
      return uiMessage('plan.timeline.1866');
    case 'commitment_block':
      return entry.block?.target.kind === 'commitment' && entry.block.target.strength === 'hard'
        ? uiMessage('plan.plan-month.1319')
        : uiMessage('plan.plan-month.1320');
    case 'custom_block':
      return uiMessage('plan.timeline.1867');
    case 'occurrence_block':
    case 'routine_occurrence':
      return uiMessage('plan.routine-form.1531');
  }
}

export function stateLabel(state: 'planned' | 'completed' | 'skipped' | 'canceled'): string {
  switch (state) {
    case 'planned':
      return uiMessage('plan.routines.1537');
    case 'completed':
      return uiMessage('plan.plan-month.1324');
    case 'skipped':
      return uiMessage('plan.plan-month.1325');
    case 'canceled':
      return uiMessage('plan.theme-editor.1863');
  }
}

/** Local time range of an entry relative to one column date, with cross-midnight wording. */
export function entryTimeText(
  entry: TimedEntry,
  date: string,
  format: PlanProfile['timeFormat'],
): string {
  const startsBefore = entry.localDate < date;
  const endsAfter = entry.localEndDate > date && entry.localEnd !== '00:00';
  const start = formatWallTime(entry.localStart, format);
  const end = formatWallTime(entry.localEnd, format);
  if (startsBefore && endsAfter) return `All day, from the previous day, continues after midnight`;
  if (startsBefore) return uiMessage('plan.timeline.1868', { value0: start, value1: end });
  if (endsAfter) return uiMessage('plan.timeline.1869', { value0: start, value1: end });
  return `${start} – ${end}`;
}

/* ───────────────────────── Feedback and focus ───────────────────────── */

/**
 * Page feedback for a shared runner: polite status, undo, and (when no dialog owns it) the error.
 * Mirrors the shared CommandFeedback so an open dialog can show the error instead.
 */
export function ViewFeedback({
  runner,
  showError,
}: {
  readonly runner: CommandRunner;
  readonly showError: boolean;
}): ReactNode {
  return (
    <>
      <RunnerAnnouncement runner={runner} />
      {showError && runner.error !== null && (
        <p className="validation-summary" role="alert">
          {runner.error}
        </p>
      )}
      <UndoBar runner={runner} onDismiss={() => runner.dismissUndo()} />
    </>
  );
}

/** Error from the runner shown inside an open dialog. */
export function DialogError({ runner }: { readonly runner: CommandRunner }): ReactNode {
  if (runner.error === null) return null;
  return (
    <p className="validation-summary" role="alert">
      {runner.error}
    </p>
  );
}

/**
 * When a committed change re-renders the view and the control that had focus disappears, move
 * focus to the view heading instead of leaving it on the document body. Pass the loaded data, not
 * the query state: the rescue stays armed until data re-queried after the command has rendered,
 * because a closing dialog can first return focus to its opener and the re-query may remove that
 * opener a moment later.
 */
export function useFocusRescue(
  heading: RefObject<HTMLElement | null>,
  runner: Pick<CommandRunner, 'busy'>,
  data: unknown,
): void {
  // The data shown while the last command ran, or null when no command awaits its re-query.
  const pending = useRef<{ readonly data: unknown } | null>(null);
  useEffect(() => {
    if (runner.busy) pending.current = { data };
  }, [runner.busy, data]);
  useEffect(() => {
    const armed = pending.current;
    if (armed === null || runner.busy) return;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        heading.current?.focus({ preventScroll: true });
        pending.current = null;
      } else if (data !== armed.data && !document.querySelector('dialog[open]')) {
        // The re-queried view has rendered and focus survived it.
        pending.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data, runner.busy, heading]);
}

/**
 * Move focus to the element marked `data-autofocus` once a dialog has opened, unless focus has
 * already settled on a field or the person has moved it (the Modal focuses first, and a fast
 * keyboard user may already be on another control).
 */
export function useDialogAutofocus(container: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        const element = container.current;
        if (element === null) return;
        const dialog = element.closest('dialog') ?? element;
        if (!mayMoveAutofocus(dialog) || focusIsOnField(dialog)) return;
        autofocusIn(dialog, element.querySelector<HTMLElement>('[data-autofocus]'));
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [container]);
}

/* ───────────────────────── Interval fields and preview ───────────────────────── */

export interface IntervalDraft {
  readonly date: string;
  readonly startTime: string;
  readonly duration: string;
}

/** Validate a local interval draft. Duration is always explicit; nothing is invented. */
export function validateInterval(draft: IntervalDraft): {
  readonly errors: readonly string[];
  readonly input?: LocalIntervalInput;
} {
  const errors: string[] = [];
  if (!isCalendarDate(draft.date)) errors.push(uiMessage('alignment.detail-parts.460'));
  if (!isWallTime(draft.startTime)) errors.push(uiMessage('plan.timeline.1870'));
  const duration = Number(draft.duration);
  if (draft.duration.trim() === '' || !Number.isInteger(duration) || duration < 1)
    errors.push(uiMessage('plan.timeline.1871'));
  else if (duration > 24 * 60) errors.push(uiMessage('plan.timeline.1872'));
  if (errors.length > 0) return { errors };
  return {
    errors,
    input: { date: draft.date, startTime: draft.startTime, durationMinutes: duration },
  };
}

export type IntervalPreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly resolution: LocalTimeResolution }
  | { readonly status: 'error'; readonly message: string };

/** Live resolution of a draft interval in the planning zone, with the items it would overlap. */
export function useIntervalPreview(
  input: LocalIntervalInput | undefined,
  exclude: readonly string[],
): IntervalPreviewState {
  const planning = usePlanning();
  const [state, setState] = useState<IntervalPreviewState>({ status: 'idle' });
  const key =
    input === undefined
      ? ''
      : `${input.date}|${input.startTime}|${String(input.durationMinutes)}|${exclude.join(',')}`;
  const excludeRef = useRef(exclude);
  excludeRef.current = exclude;
  useEffect(() => {
    if (input === undefined) {
      setState({ status: 'idle' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    const timer = window.setTimeout(() => {
      planning
        .resolveLocalInterval(input, excludeRef.current)
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
  }, [key, planning]);
  return state;
}

export function IntervalFields({
  autofocus,
  draft,
  durationHelp,
  idPrefix,
  onChange,
}: {
  readonly autofocus?: 'date' | 'start' | 'duration';
  readonly draft: IntervalDraft;
  readonly durationHelp?: string;
  readonly idPrefix: string;
  readonly onChange: (next: IntervalDraft) => void;
}): ReactNode {
  return (
    <div className="three-column-fields interval-fields">
      <label className="field-label" htmlFor={`${idPrefix}-date`}>
        {uiMessage('actions-ui.274')}
        <input
          id={`${idPrefix}-date`}
          type="date"
          required
          {...(autofocus === 'date' ? { 'data-autofocus': true } : {})}
          value={draft.date}
          onChange={(event) => onChange({ ...draft, date: event.target.value })}
        />
      </label>
      <label className="field-label" htmlFor={`${idPrefix}-start`}>
        {uiMessage('plan.occurrence-controls.1270')}
        <input
          id={`${idPrefix}-start`}
          type="time"
          required
          {...(autofocus === 'start' ? { 'data-autofocus': true } : {})}
          value={draft.startTime}
          onChange={(event) => onChange({ ...draft, startTime: event.target.value })}
        />
      </label>
      <label className="field-label" htmlFor={`${idPrefix}-duration`}>
        {uiMessage('plan.occurrence-controls.1271')}
        <input
          id={`${idPrefix}-duration`}
          {...(autofocus === 'duration' ? { 'data-autofocus': true } : {})}
          type="number"
          inputMode="numeric"
          min={1}
          max={1440}
          step={1}
          required
          value={draft.duration}
          aria-describedby={durationHelp === undefined ? undefined : `${idPrefix}-duration-help`}
          onChange={(event) => onChange({ ...draft, duration: event.target.value })}
        />
        {durationHelp !== undefined && <span id={`${idPrefix}-duration-help`}>{durationHelp}</span>}
      </label>
    </div>
  );
}

/**
 * The resolved interval, the planning zone, any clock-change adjustment, and the items it would
 * overlap. When overlaps exist the caller renders the explicit Keep-overlap checkbox.
 */
export function IntervalPreview({
  preview,
  profile,
  requestedDate,
  requestedStart,
}: {
  readonly preview: IntervalPreviewState;
  readonly profile: PlanProfile | undefined;
  readonly requestedDate: string;
  readonly requestedStart: string;
}): ReactNode {
  const format = profile?.timeFormat ?? '24_hour';
  let content: ReactNode = null;
  if (preview.status === 'loading')
    content = <p className="field-help">{uiMessage('plan.occurrence-controls.1274')}</p>;
  else if (preview.status === 'error')
    content = <p className="field-help warning-text">{preview.message}</p>;
  else if (preview.status === 'ready') {
    const resolution = preview.resolution;
    const zone = profile?.planningTimeZone;
    const endDate = resolution.localEndDate;
    content = (
      <>
        <p className="interval-summary">
          {formatWallTime(resolution.localStart, format)} –{' '}
          {formatWallTime(resolution.localEnd, format)}
          {endDate !== requestedDate &&
            uiMessage('plan.occurrence-controls.1276', { value0: formatDate(endDate, 'weekday') })}
          {zone === undefined ? '' : uiMessage('plan.occurrence-controls.1277', { value0: zone })}
          {uiMessage('plan.occurrence-controls.1278')}
          {resolution.utcOffset})
        </p>
        {resolution.adjustment === 'dst_gap_shifted' && (
          <p className="warning-note">
            {formatWallTime(requestedStart, format)}
            {uiMessage('plan.timeline.1873')} {formatWallTime(resolution.localStart, format)}.
          </p>
        )}
        {resolution.adjustment === 'dst_repeated_earlier' && (
          <p className="warning-note">
            {formatWallTime(requestedStart, format)}
            {uiMessage('plan.occurrence-controls.1281')}
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

/** Overlaps currently known for a draft; empty while the preview is not ready. */
export function previewOverlaps(
  preview: IntervalPreviewState,
): readonly { readonly key: string; readonly title: string }[] {
  return preview.status === 'ready' ? preview.resolution.overlaps : [];
}

export function KeepOverlapCheckbox({
  checked,
  id,
  onChange,
}: {
  readonly checked: boolean;
  readonly id: string;
  readonly onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <label className="check-row" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {uiMessage('plan.timeline.1874')}
        <span className="field-help block-help">{uiMessage('plan.timeline.1875')}</span>
      </span>
    </label>
  );
}

/* ───────────────────────── Drag and drop ───────────────────────── */

export const actionDragType = 'application/x-yelaxis-action';

/** Props that make an Action draggable onto the timeline or a Week day (mouse enhancement only). */
export function actionDragProps(actionId: string): {
  readonly draggable: true;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
} {
  return {
    draggable: true,
    onDragStart: (event) => {
      event.dataTransfer.setData(actionDragType, actionId);
      event.dataTransfer.effectAllowed = 'move';
    },
  };
}

export function draggedActionId(event: DragEvent<HTMLElement>): string | null {
  const value = event.dataTransfer.getData(actionDragType);
  return value === '' ? null : value;
}

export function acceptsActionDrop(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(actionDragType);
}

/* ───────────────────────── Day timeline ───────────────────────── */

interface PlacedEntry {
  readonly entry: TimedEntry;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly lane: number;
  readonly lanes: number;
}

const gcd = (left: number, right: number): number =>
  right === 0 ? left : gcd(right, left % right);
const lcm = (left: number, right: number): number => (left * right) / gcd(left, right);

/** Minutes of an entry clipped to one local date. */
export function entryMinutesOn(
  entry: TimedEntry,
  date: string,
): { readonly start: number; readonly end: number } {
  const start = entry.localDate < date ? 0 : minutesOfWallTime(entry.localStart);
  const end = entry.localEndDate > date ? 24 * 60 : minutesOfWallTime(entry.localEnd);
  return { start, end: Math.max(end, start + 1) };
}

/** Assign overlapping entries to side-by-side lanes within each overlapping cluster. */
export function layoutEntries(
  entries: readonly TimedEntry[],
  date: string,
): readonly PlacedEntry[] {
  const sorted = entries
    .map((entry) => ({ entry, ...entryMinutesOn(entry, date) }))
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const placed: PlacedEntry[] = [];
  let cluster: { entry: TimedEntry; start: number; end: number; lane: number }[] = [];
  let clusterEnd = -1;
  const flush = (): void => {
    const lanes = cluster.reduce((max, item) => Math.max(max, item.lane + 1), 1);
    for (const item of cluster)
      placed.push({
        entry: item.entry,
        startMinute: item.start,
        endMinute: item.end,
        lane: item.lane,
        lanes,
      });
    cluster = [];
  };
  for (const item of sorted) {
    if (item.start >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    const laneEnds: number[] = [];
    for (const existing of cluster)
      laneEnds[existing.lane] = Math.max(laneEnds[existing.lane] ?? 0, existing.end);
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) lane = laneEnds.length;
    cluster.push({ ...item, lane });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return placed;
}

const defaultFirstHour = 6;

/**
 * An ordered list of timed entries positioned on an hour scale. Overlapping entries sit side by
 * side in lanes. Hour rows accept a dragged Action; every drop only opens the Schedule dialog.
 */
export function DayTimeline({
  date,
  entries,
  label,
  now,
  onDropAction,
  profile,
  renderEntry,
}: {
  readonly date: string;
  readonly entries: readonly TimedEntry[];
  readonly label: string;
  /**
   * The current time on this date (Today only): minutes after local midnight in the planning zone
   * and the visible text, e.g. "Now 9:05 AM". The marker line is decorative; the text says it.
   */
  readonly now?: { readonly minute: number; readonly label: string };
  readonly onDropAction?: (actionId: string, startTime: string) => void;
  readonly profile: PlanProfile;
  readonly renderEntry: (entry: TimedEntry) => ReactNode;
}): ReactNode {
  const placed = layoutEntries(entries, date);
  const page = useItemPage(placed, date);
  const dense = placed.some((item) => item.lanes > 12);
  const earliest = placed.reduce((min, item) => Math.min(min, item.startMinute), 24 * 60);
  const [showEarly, setShowEarly] = useState(false);
  const needsEarly = earliest < defaultFirstHour * 60;
  const nowMinute =
    now === undefined ? undefined : Math.max(0, Math.min(24 * 60 - 1, Math.floor(now.minute)));
  const nowEarly = nowMinute !== undefined && nowMinute < defaultFirstHour * 60;
  const firstHour = showEarly || needsEarly || nowEarly ? 0 : defaultFirstHour;
  const [dropHour, setDropHour] = useState<number | null>(null);
  const columns = placed.reduce((value, item) => {
    const next = lcm(value, item.lanes);
    return next > 12 ? value : next;
  }, 1);
  const rowOf = (minute: number): number => Math.floor(minute / 15) - firstHour * 4 + 1;
  const hours = Array.from({ length: 24 - firstHour }, (_, index) => firstHour + index);

  return (
    <div className="day-timeline">
      <div className="timeline-toolbar">
        {now !== undefined && <p className="timeline-now-text">{now.label}</p>}
        {needsEarly ? (
          <p className="field-help">{uiMessage('plan.timeline.1876')}</p>
        ) : nowEarly ? (
          <p className="field-help">{uiMessage('plan.timeline.1877')}</p>
        ) : (
          <button
            type="button"
            className="text-button"
            aria-pressed={showEarly}
            onClick={() => setShowEarly((value) => !value)}
          >
            {showEarly ? uiMessage('plan.timeline.1878') : uiMessage('plan.timeline.1879')}
          </button>
        )}
      </div>
      {entries.length === 0 && <p className="quiet-empty">{uiMessage('plan.timeline.1880')}</p>}
      {dense && <p className="field-help">{uiMessage('timeline.dense')}</p>}
      <ItemPageControls page={page} />
      <ol
        className={dense ? 'timeline-grid is-list' : 'timeline-grid'}
        aria-label={label}
        style={{
          gridTemplateRows: `repeat(${String((24 - firstHour) * 4)}, minmax(0.75rem, auto))`,
          gridTemplateColumns: `4.5rem repeat(${String(columns)}, minmax(0, 1fr))`,
        }}
      >
        {!dense &&
          hours.map((hour) => (
            <li
              key={`hour-${String(hour)}`}
              aria-hidden="true"
              className={`timeline-hour${dropHour === hour ? ' is-drop-target' : ''}`}
              style={{ gridRow: `${String(rowOf(hour * 60))} / span 4` }}
              onDragOver={(event) => {
                if (onDropAction === undefined || !acceptsActionDrop(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropHour(hour);
              }}
              onDragLeave={() => setDropHour((current) => (current === hour ? null : current))}
              onDrop={(event) => {
                setDropHour(null);
                const actionId = draggedActionId(event);
                if (onDropAction === undefined || actionId === null) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                const fraction =
                  box.height > 0
                    ? Math.min(0.99, Math.max(0, (event.clientY - box.top) / box.height))
                    : 0;
                const quarter = Math.floor(fraction * 4) * 15;
                onDropAction(actionId, wallTimeFromMinutes(hour * 60 + quarter));
              }}
            >
              <span className="timeline-hour-label">
                {formatWallTime(wallTimeFromMinutes(hour * 60), profile.timeFormat)}
              </span>
            </li>
          ))}
        {page.items.map((item) => {
          const span = columns % item.lanes === 0 ? columns / item.lanes : 1;
          const startColumn = 2 + item.lane * span;
          const startRow = Math.max(1, rowOf(item.startMinute));
          const endRow = Math.max(startRow + 1, rowOf(Math.ceil(item.endMinute / 15) * 15));
          return (
            <li
              key={item.entry.key}
              className="timeline-entry"
              style={
                dense
                  ? undefined
                  : {
                      gridRow: `${String(startRow)} / ${String(endRow)}`,
                      gridColumn: `${String(startColumn)} / span ${String(span)}`,
                    }
              }
            >
              {renderEntry(item.entry)}
            </li>
          );
        })}
        {!dense && nowMinute !== undefined && (
          <li
            aria-hidden="true"
            className="timeline-now"
            data-testid="timeline-now"
            style={{ gridRow: `${String(rowOf(nowMinute))} / span 1` }}
          >
            <span
              className="timeline-now-line"
              style={{ top: `${String(((nowMinute % 15) / 15) * 100)}%` }}
            >
              <span className="timeline-now-label">{uiMessage('plan.timeline.1886')}</span>
            </span>
          </li>
        )}
      </ol>
    </div>
  );
}
