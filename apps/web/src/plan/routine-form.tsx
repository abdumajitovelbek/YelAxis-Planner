import { message as uiMessage } from '../messages';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import type {
  ApplicationError,
  ApplicationResult,
  ChoiceRow,
  CommandReceipt,
  PlanProfile,
  PlanningApplication,
  RoutineDefaultsInput,
  RoutineGenerationDocument,
  RoutineInput,
  RoutinePreviewEntry,
  RoutineReminderInput,
  RoutineRow,
} from '@yelaxis/application';
import type { RecurrenceRuleV1, RoutineSchedulingMode, Weekday } from '@yelaxis/domain';

import { applicationErrorMessage, browserToday, formatDate, formatWallTime } from './format';
import { autofocusIn, mayMoveAutofocus } from './modal';
import type { CommandRunner } from './planning-context';
import './routine-form.css';

/* ───────────────────────── Form state ───────────────────────── */

export type RepeatPattern = RecurrenceRuleV1['kind'];

export interface RoutineFormState {
  readonly title: string;
  readonly description: string;
  readonly pattern: RepeatPattern;
  readonly intervalDays: string;
  readonly intervalWeeks: string;
  readonly weekdays: readonly Weekday[];
  readonly targetCount: string;
  /** Empty means "use the planning week start". */
  readonly weekStart: Weekday | '';
  readonly dayOfMonth: string;
  readonly intervalMonths: string;
  readonly missingDayPolicy: 'skip' | 'last_day';
  readonly startsOn: string;
  readonly endsOn: string;
  readonly timing: 'day_flexible' | 'time_specific';
  readonly wallTime: string;
  readonly durationMinutes: string;
  readonly zoneKind: 'follow_profile' | 'fixed_zone';
  readonly timeZone: string;
  readonly gapPolicy: 'shift_forward' | 'skip';
  readonly overlapPolicy: 'earlier_offset' | 'later_offset';
  readonly projectId: string;
  readonly note: string;
  readonly estimate: string;
  readonly energy: string;
  readonly priority: string;
  /** Review: a reminder before each occurrence, offered only for a Routine at a set time. */
  readonly reminder: 'off' | 'before';
  readonly reminderMinutes: string;
}

export type RoutineFormSetter = <Key extends keyof RoutineFormState>(
  key: Key,
  value: RoutineFormState[Key],
) => void;

export const weekdayOrder: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const weekdayNames: Readonly<Record<Weekday, string>> = {
  monday: uiMessage('onboarding-ui.1024'),
  tuesday: uiMessage('onboarding-ui.1025'),
  wednesday: uiMessage('onboarding-ui.1026'),
  thursday: uiMessage('onboarding-ui.1027'),
  friday: uiMessage('onboarding-ui.1028'),
  saturday: uiMessage('onboarding-ui.1029'),
  sunday: uiMessage('onboarding-ui.1030'),
};

export function weekdayName(weekday: Weekday): string {
  return weekdayNames[weekday];
}

const isDateText = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/u.test(value);

/** Weekday of a `YYYY-MM-DD` date (UTC arithmetic; no time zone involved). */
export function weekdayOf(date: string): Weekday {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekdayOrder[(day + 6) % 7] ?? 'monday';
}

/** Calendar arithmetic on `YYYY-MM-DD` strings. */
export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * A blank Routine form. Pass planning-zone today (`usePlanningToday`); the browser date is only a
 * fallback for callers without a Profile.
 */
export function emptyRoutineForm(startsOn: string = browserToday()): RoutineFormState {
  return {
    title: '',
    description: '',
    pattern: 'daily',
    intervalDays: '1',
    intervalWeeks: '1',
    weekdays: isDateText(startsOn) ? [weekdayOf(startsOn)] : ['monday'],
    targetCount: '3',
    weekStart: '',
    dayOfMonth: isDateText(startsOn) ? String(Number(startsOn.slice(8, 10))) : '1',
    intervalMonths: '1',
    missingDayPolicy: 'skip',
    startsOn,
    endsOn: '',
    timing: 'day_flexible',
    wallTime: '',
    durationMinutes: '',
    zoneKind: 'follow_profile',
    timeZone: '',
    gapPolicy: 'shift_forward',
    overlapPolicy: 'earlier_offset',
    projectId: '',
    note: '',
    estimate: '',
    energy: '',
    priority: '',
    reminder: 'off',
    reminderMinutes: '15',
  };
}

/** Prefill the pattern and scheduling fields from an existing generation. */
export function routineFormFromGeneration(
  generation: RoutineGenerationDocument,
  details: {
    readonly title?: string;
    readonly description?: string;
    readonly defaults?: RoutineRow['defaults'];
    readonly startsOn?: string;
  } = {},
): RoutineFormState {
  const { rule, schedulingMode: mode } = generation;
  const base = emptyRoutineForm(details.startsOn ?? rule.startsOn);
  const defaults = details.defaults;
  const withRule: RoutineFormState = {
    ...base,
    title: details.title ?? '',
    description: details.description ?? '',
    pattern: rule.kind,
    endsOn: rule.endsOn ?? '',
    ...(rule.kind === 'daily' ? { intervalDays: String(rule.intervalDays) } : {}),
    ...(rule.kind === 'weekly_days'
      ? { intervalWeeks: String(rule.intervalWeeks), weekdays: rule.weekdays }
      : {}),
    ...(rule.kind === 'weekly_count'
      ? { targetCount: String(rule.targetCount), weekStart: rule.weekStart }
      : {}),
    ...(rule.kind === 'monthly_day'
      ? {
          dayOfMonth: String(rule.dayOfMonth),
          intervalMonths: String(rule.intervalMonths),
          missingDayPolicy: rule.missingDayPolicy,
        }
      : {}),
    projectId: defaults?.projectId ?? '',
    note: defaults?.note ?? '',
    estimate: defaults?.estimateMinutes?.toString() ?? '',
    energy: defaults?.energy ?? '',
    priority: defaults?.priority ?? '',
  };
  if (mode.kind === 'day_flexible') return withRule;
  return {
    ...withRule,
    timing: 'time_specific',
    wallTime: mode.wallTime,
    durationMinutes: String(mode.durationMinutes),
    zoneKind: mode.zonePolicy.kind,
    timeZone: mode.zonePolicy.kind === 'fixed_zone' ? mode.zonePolicy.timeZone : '',
    gapPolicy: mode.gapPolicy,
    overlapPolicy: mode.overlapPolicy,
  };
}

/* ───────────────────────── Building domain candidates ───────────────────────── */

export type BuildResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly errors: readonly string[] };

const wholeNumber = (value: string, min: number, max: number): number | null => {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= min && parsed <= max ? parsed : null;
};

const validWallTime = (value: string): boolean => {
  const match = /^(\d{2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return false;
  return Number(match[1]) < 24 && Number(match[2]) < 60;
};

/**
 * Build the RecurrenceRuleV1 and RoutineSchedulingMode candidates exactly as the domain expects.
 * Errors are stated in words; the domain still validates on preview and on save.
 */
export function buildRoutineSchedule(
  form: RoutineFormState,
  fallbackWeekStart: Weekday,
): BuildResult<{
  readonly rule: RecurrenceRuleV1;
  readonly schedulingMode: RoutineSchedulingMode;
}> {
  const errors: string[] = [];
  if (!isDateText(form.startsOn)) errors.push(uiMessage('plan.routine-form.1413'));
  if (form.endsOn !== '' && !isDateText(form.endsOn))
    errors.push(uiMessage('plan.routine-form.1414'));
  if (isDateText(form.startsOn) && isDateText(form.endsOn) && form.endsOn < form.startsOn)
    errors.push(uiMessage('plan.routine-form.1415'));
  const bounds = {
    startsOn: form.startsOn,
    ...(form.endsOn === '' ? {} : { endsOn: form.endsOn }),
  };
  let rule: Record<string, unknown> | null = null;
  switch (form.pattern) {
    case 'daily': {
      const interval = wholeNumber(form.intervalDays, 1, 365);
      if (interval === null) errors.push(uiMessage('plan.routine-form.1416'));
      else rule = { version: 1, kind: 'daily', intervalDays: interval, ...bounds };
      break;
    }
    case 'weekly_days': {
      const interval = wholeNumber(form.intervalWeeks, 1, 52);
      if (interval === null) errors.push(uiMessage('plan.routine-form.1417'));
      if (form.weekdays.length === 0) errors.push(uiMessage('plan.routine-form.1418'));
      if (interval !== null && form.weekdays.length > 0)
        rule = {
          version: 1,
          kind: 'weekly_days',
          intervalWeeks: interval,
          weekdays: weekdayOrder.filter((day) => form.weekdays.includes(day)),
          ...bounds,
        };
      break;
    }
    case 'weekly_count': {
      const count = wholeNumber(form.targetCount, 1, 99);
      if (count === null) errors.push(uiMessage('plan.routine-form.1419'));
      else
        rule = {
          version: 1,
          kind: 'weekly_count',
          targetCount: count,
          weekStart: form.weekStart === '' ? fallbackWeekStart : form.weekStart,
          ...bounds,
        };
      break;
    }
    case 'monthly_day': {
      const day = wholeNumber(form.dayOfMonth, 1, 31);
      const interval = wholeNumber(form.intervalMonths, 1, 12);
      if (day === null) errors.push(uiMessage('plan.routine-form.1420'));
      if (interval === null) errors.push(uiMessage('plan.routine-form.1421'));
      if (day !== null && interval !== null)
        rule = {
          version: 1,
          kind: 'monthly_day',
          intervalMonths: interval,
          dayOfMonth: day,
          missingDayPolicy: form.missingDayPolicy,
          ...bounds,
        };
      break;
    }
  }
  let schedulingMode: RoutineSchedulingMode | null = { kind: 'day_flexible' };
  if (form.timing === 'time_specific' && form.pattern !== 'weekly_count') {
    const duration = wholeNumber(form.durationMinutes, 1, 1440);
    const timeOk = validWallTime(form.wallTime);
    if (!timeOk) errors.push(uiMessage('plan.routine-form.1422'));
    if (duration === null) errors.push(uiMessage('plan.routine-form.1423'));
    const zoneOk = form.zoneKind === 'follow_profile' || form.timeZone.trim() !== '';
    if (!zoneOk) errors.push(uiMessage('plan.routine-form.1424'));
    schedulingMode =
      timeOk && duration !== null && zoneOk
        ? ({
            kind: 'time_specific',
            wallTime: form.wallTime.trim(),
            durationMinutes: duration,
            zonePolicy:
              form.zoneKind === 'follow_profile'
                ? { kind: 'follow_profile' }
                : { kind: 'fixed_zone', timeZone: form.timeZone.trim() },
            gapPolicy: form.gapPolicy,
            overlapPolicy: form.overlapPolicy,
          } as RoutineSchedulingMode)
        : null;
  }
  if (errors.length > 0 || rule === null || schedulingMode === null)
    return {
      ok: false,
      errors: errors.length > 0 ? errors : [uiMessage('plan.routine-form.1425')],
    };
  return { ok: true, value: { rule: rule as unknown as RecurrenceRuleV1, schedulingMode } };
}

export function buildRoutineDefaults(
  form: RoutineFormState,
): BuildResult<RoutineDefaultsInput | undefined> {
  const errors: string[] = [];
  let estimate: number | undefined;
  if (form.estimate.trim() !== '') {
    const parsed = wholeNumber(form.estimate, 1, 10080);
    if (parsed === null) errors.push(uiMessage('plan.routine-form.1426'));
    else estimate = parsed;
  }
  if (form.note.length > 10000) errors.push(uiMessage('plan.routine-form.1427'));
  if (errors.length > 0) return { ok: false, errors };
  const defaults: RoutineDefaultsInput = {
    ...(form.projectId === '' ? {} : { projectId: form.projectId }),
    ...(form.note.trim() === '' ? {} : { note: form.note }),
    ...(estimate === undefined ? {} : { estimateMinutes: estimate }),
    ...(form.energy === '' ? {} : { energy: form.energy }),
    ...(form.priority === '' ? {} : { priority: form.priority }),
  };
  return { ok: true, value: Object.keys(defaults).length === 0 ? undefined : defaults };
}

/** The reminder copy shared with Time Block and Action reminders (saved definitions only). */
export const routineReminderSavedCopy = uiMessage('plan.routine-form.1428');

export const routineReminderMinutesError = uiMessage('plan.routine-form.1429');

/** Whether the form describes a Routine at a set time, the only kind that can have a reminder. */
export const isTimedRoutineForm = (form: RoutineFormState): boolean =>
  form.timing === 'time_specific' && form.pattern !== 'weekly_count';

/** Minutes before each occurrence when the reminder is on; `undefined` when it is off. */
export function buildRoutineReminder(
  choice: RoutineFormState['reminder'],
  minutes: string,
): BuildResult<RoutineReminderInput | undefined> {
  if (choice === 'off') return { ok: true, value: undefined };
  const parsed = wholeNumber(minutes, 0, 10_080);
  return parsed === null
    ? { ok: false, errors: [routineReminderMinutesError] }
    : { ok: true, value: { minutesBefore: parsed } };
}

export function buildRoutineInput(
  form: RoutineFormState,
  fallbackWeekStart: Weekday,
  options: { readonly axisId?: string; readonly includeReminder?: boolean } = {},
): BuildResult<RoutineInput> {
  const errors: string[] = [];
  const title = form.title.trim();
  if (title.length === 0) errors.push(uiMessage('plan.routine-form.1430'));
  else if (title.length > 200) errors.push(uiMessage('plan.routine-form.1431'));
  if (form.description.length > 10000) errors.push(uiMessage('plan.routine-form.1432'));
  const schedule = buildRoutineSchedule(form, fallbackWeekStart);
  if (!schedule.ok) errors.push(...schedule.errors);
  const defaults = buildRoutineDefaults(form);
  if (!defaults.ok) errors.push(...defaults.errors);
  // A reminder is only offered, and only sent, for a Routine at a set time.
  const reminder =
    options.includeReminder === true && isTimedRoutineForm(form)
      ? buildRoutineReminder(form.reminder, form.reminderMinutes)
      : ({ ok: true, value: undefined } as const);
  if (!reminder.ok) errors.push(...reminder.errors);
  if (errors.length > 0 || !schedule.ok || !defaults.ok || !reminder.ok)
    return { ok: false, errors };
  return {
    ok: true,
    value: {
      title,
      ...(form.description.trim() === '' ? {} : { description: form.description.trim() }),
      ...(options.axisId === undefined || options.axisId === '' ? {} : { axisId: options.axisId }),
      rule: schedule.value.rule,
      schedulingMode: schedule.value.schedulingMode,
      ...(defaults.value === undefined ? {} : { defaults: defaults.value }),
      ...(reminder.value === undefined ? {} : { reminder: reminder.value }),
    },
  };
}

/* ───────────────────────── Words ───────────────────────── */

const listWords = (values: readonly string[]): string => {
  if (values.length <= 1) return values.join('');
  if (values.length === 2)
    return uiMessage('alignment.lifecycle-dialogs.477', {
      value0: values[0] ?? '',
      value1: values[1] ?? '',
    });
  return uiMessage('plan.routine-form.1433', {
    value0: values.slice(0, -1).join(', '),
    value1: values[values.length - 1] ?? '',
  });
};

/** The repeat pattern alone, in plain words. */
export function describePattern(rule: RecurrenceRuleV1): string {
  switch (rule.kind) {
    case 'daily':
      return rule.intervalDays === 1
        ? uiMessage('plan.routine-form.1434')
        : uiMessage('plan.routine-form.1435', { value0: String(rule.intervalDays) });
    case 'weekly_days': {
      const days = listWords(rule.weekdays.map(weekdayName));
      return rule.intervalWeeks === 1
        ? uiMessage('plan.routine-form.1436', { value0: days })
        : uiMessage('plan.routine-form.1437', { value0: String(rule.intervalWeeks), value1: days });
    }
    case 'weekly_count':
      return uiMessage('plan.routine-form.1438', {
        value0: String(rule.targetCount),
        value1: rule.targetCount === 1 ? 'time' : 'times',
        value2: weekdayName(rule.weekStart),
      });
    case 'monthly_day': {
      const every =
        rule.intervalMonths === 1
          ? uiMessage('plan.routine-form.1439', { value0: String(rule.dayOfMonth) })
          : uiMessage('plan.routine-form.1440', {
              value0: String(rule.intervalMonths),
              value1: String(rule.dayOfMonth),
            });
      if (rule.dayOfMonth <= 28) return every;
      return rule.missingDayPolicy === 'skip'
        ? uiMessage('plan.routine-form.1441', { value0: every })
        : uiMessage('plan.routine-form.1442', { value0: every });
    }
  }
}

/** The complete rule in plain words, including its start and optional end. */
export function describeRule(rule: RecurrenceRuleV1): string {
  const start = uiMessage('plan.routine-form.1443', { value0: formatDate(rule.startsOn) });
  const end =
    rule.endsOn === undefined
      ? ''
      : uiMessage('plan.routine-form.1444', { value0: formatDate(rule.endsOn) });
  return `${describePattern(rule)}, ${start}${end}.`;
}

/** Scheduling in plain words, e.g. "At 07:30 for 30 minutes, in your planning time zone". */
export function describeScheduling(
  mode: RoutineSchedulingMode,
  timeFormat: PlanProfile['timeFormat'] = '24_hour',
): string {
  if (mode.kind === 'day_flexible') return uiMessage('plan.routine-form.1445');
  const zone =
    mode.zonePolicy.kind === 'follow_profile'
      ? uiMessage('plan.routine-form.1446')
      : uiMessage('plan.routine-form.1447', { value0: mode.zonePolicy.timeZone });
  return uiMessage('plan.routine-form.1448', {
    value0: formatWallTime(mode.wallTime, timeFormat),
    value1: String(mode.durationMinutes),
    value2: mode.durationMinutes === 1 ? 'minute' : 'minutes',
    value3: zone,
  });
}

const reasonMessages: Readonly<Record<string, string>> = {
  startsOn: uiMessage('alignment.milestone-detail.629'),
  endsOn: uiMessage('plan.routine-form.1415'),
  shape: uiMessage('plan.routine-form.1449'),
  daily: uiMessage('plan.routine-form.1450'),
  weekly_days: uiMessage('plan.routine-form.1451'),
  weekly_count: uiMessage('plan.routine-form.1452'),
  monthly_day: uiMessage('plan.routine-form.1420'),
  unsupported_kind: uiMessage('plan.routine-form.1453'),
  window: uiMessage('plan.routine-form.1454'),
  generation: uiMessage('plan.routine-form.1454'),
  scheduling_mode: uiMessage('plan.routine-form.1455'),
  wall_time: uiMessage('plan.routine-form.1422'),
  duration_minutes: uiMessage('plan.routine-form.1423'),
  zone_policy: uiMessage('plan.routine-form.1456'),
  gap_policy: uiMessage('plan.routine-form.1457'),
  overlap_policy: uiMessage('plan.routine-form.1458'),
  title: uiMessage('plan.routine-form.1459'),
  description: uiMessage('plan.routine-form.1432'),
  weekly_count_is_day_flexible: uiMessage('plan.routine-form.1460'),
  pause_in_past: uiMessage('plan.routine-form.1461'),
  resume_in_past: uiMessage('plan.routine-form.1462'),
  week_start_required: uiMessage('plan.routine-form.1463'),
  split_before_generation: uiMessage('plan.routine-form.1464'),
  split_after_generation: uiMessage('plan.routine-form.1465'),
  future_rule: uiMessage('plan.routine-form.1466'),
  routine_not_active: uiMessage('plan.routine-form.1467'),
  routine_not_paused: uiMessage('plan.routine-form.1468'),
  routine_archived: uiMessage('plan.routine-form.1469'),
};

/** Routine command and preview errors in words; falls back to the shared messages. */
export function routineErrorMessage(error: ApplicationError): string {
  if (error.code === 'domain_rejected') {
    const reason = error.domainError.details?.['reason'];
    if (typeof reason === 'string') {
      const message = reasonMessages[reason];
      if (message !== undefined) return message;
    }
  }
  return applicationErrorMessage(error);
}

/**
 * Run one command through the shared runner and return a message in words for inline display
 * (dialogs keep their own error so entered values stay in place).
 */
export async function runCommand(
  runner: CommandRunner,
  operation: () => Promise<ApplicationResult<CommandReceipt>>,
  success: string,
  describe: (error: ApplicationError) => string = routineErrorMessage,
): Promise<{ readonly message: string | null; readonly receipt?: CommandReceipt }> {
  const outcome: { failure?: ApplicationError; receipt?: CommandReceipt } = {};
  const committed = await runner.run(async () => {
    const result = await operation();
    if (result.ok) outcome.receipt = result.value;
    else outcome.failure = result.error;
    return result;
  }, success);
  if (committed)
    return outcome.receipt === undefined
      ? { message: null }
      : { message: null, receipt: outcome.receipt };
  runner.clearError();
  return {
    message:
      outcome.failure === undefined ? uiMessage('actions-ui.363') : describe(outcome.failure),
  };
}

/* ───────────────────────── Time zones ───────────────────────── */

function supportedTimeZones(): readonly string[] {
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    if (zones.length > 0) return zones;
  } catch {
    // Fall through to the device zone.
  }
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return device === 'UTC' ? ['UTC'] : [device, 'UTC'];
}

/** Searchable native time-zone select: a filter field narrows the options. */
export function ZonePicker({
  label,
  onChange,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}): ReactNode {
  const zones = useMemo(supportedTimeZones, []);
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase().replace(/\s+/gu, '_');
  const shown = zones.filter((zone) => needle === '' || zone.toLowerCase().includes(needle));
  const options = value !== '' && !shown.includes(value) ? [value, ...shown] : shown;
  return (
    <div className="zone-picker">
      <label className="field-label">
        {uiMessage('plan.routine-form.1470')}
        <span>{uiMessage('plan.routine-form.1471')}</span>
        <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </label>
      <label className="field-label">
        {label}
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {value === '' && <option value="">{uiMessage('plan.routine-form.1472')}</option>}
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace(/_/gu, ' ')}
            </option>
          ))}
        </select>
      </label>
      {options.length === 0 && <p className="field-help">{uiMessage('plan.routine-form.1473')}</p>}
    </div>
  );
}

/* ───────────────────────── Fields ───────────────────────── */

const patternLabels: Readonly<Record<RepeatPattern, string>> = {
  daily: uiMessage('plan.routine-form.1474'),
  weekly_days: uiMessage('plan.routine-form.1475'),
  weekly_count: uiMessage('plan.routine-form.1476'),
  monthly_day: uiMessage('plan.routine-form.1477'),
};

/** Repeat pattern, start/end, and scheduling fields (shared by the full and compact forms). */
export function RoutinePatternFields({
  autoFocusStart = false,
  compact = false,
  form,
  planningZone,
  set,
  startLabel = uiMessage('plan.routine-form.1478'),
  weekStart,
}: {
  /** Focus the start date first when a dialog opens (date-scoped changes). */
  readonly autoFocusStart?: boolean;
  readonly compact?: boolean;
  readonly form: RoutineFormState;
  readonly planningZone?: string;
  readonly set: RoutineFormSetter;
  readonly startLabel?: string;
  readonly weekStart: Weekday;
}): ReactNode {
  const effectiveWeekStart = form.weekStart === '' ? weekStart : form.weekStart;
  const startIndex = weekdayOrder.indexOf(weekStart);
  const orderedDays = [...weekdayOrder.slice(startIndex), ...weekdayOrder.slice(0, startIndex)];
  const countOnly = form.pattern === 'weekly_count';
  const groupName = useId();
  return (
    <div className={compact ? 'routine-fields compact' : 'routine-fields'}>
      <fieldset className="routine-fieldset">
        <legend>{uiMessage('plan.routine-form.1479')}</legend>
        <div className="routine-choice-list">
          {(Object.keys(patternLabels) as RepeatPattern[]).map((pattern) => (
            <label key={pattern} className="toggle-row">
              <input
                type="radio"
                name={`${groupName}-pattern`}
                value={pattern}
                checked={form.pattern === pattern}
                onChange={() => set('pattern', pattern)}
              />
              {patternLabels[pattern]}
            </label>
          ))}
        </div>
        {form.pattern === 'daily' && (
          <label className="field-label">
            {uiMessage('plan.routine-form.1480')}
            <span>{uiMessage('plan.routine-form.1481')}</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="365"
              value={form.intervalDays}
              onChange={(event) => set('intervalDays', event.target.value)}
            />
          </label>
        )}
        {form.pattern === 'weekly_days' && (
          <>
            <fieldset className="weekday-fieldset">
              <legend>{uiMessage('plan.routine-form.1482')}</legend>
              <div className="weekday-options">
                {orderedDays.map((day) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={form.weekdays.includes(day)}
                      onChange={(event) =>
                        set(
                          'weekdays',
                          event.target.checked
                            ? [...form.weekdays, day]
                            : form.weekdays.filter((value) => value !== day),
                        )
                      }
                    />
                    <span>{weekdayName(day)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="field-label">
              {uiMessage('plan.routine-form.1480')}
              <span>{uiMessage('plan.routine-form.1483')}</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max="52"
                value={form.intervalWeeks}
                onChange={(event) => set('intervalWeeks', event.target.value)}
              />
            </label>
          </>
        )}
        {form.pattern === 'weekly_count' && (
          <div className="two-column-fields">
            <label className="field-label">
              {uiMessage('plan.routine-form.1484')}
              <span>{uiMessage('plan.routine-form.1485')}</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max="99"
                value={form.targetCount}
                onChange={(event) => set('targetCount', event.target.value)}
              />
            </label>
            <label className="field-label">
              {uiMessage('plan.routine-form.1486')}
              <select
                value={effectiveWeekStart}
                onChange={(event) => set('weekStart', event.target.value as Weekday)}
              >
                {weekdayOrder.map((day) => (
                  <option key={day} value={day}>
                    {weekdayName(day)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {form.pattern === 'monthly_day' && (
          <>
            <div className="two-column-fields">
              <label className="field-label">
                {uiMessage('plan.routine-form.1487')}
                <span>{uiMessage('plan.routine-form.1488')}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="31"
                  value={form.dayOfMonth}
                  onChange={(event) => set('dayOfMonth', event.target.value)}
                />
              </label>
              <label className="field-label">
                {uiMessage('plan.routine-form.1480')}
                <span>{uiMessage('plan.routine-form.1489')}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="12"
                  value={form.intervalMonths}
                  onChange={(event) => set('intervalMonths', event.target.value)}
                />
              </label>
            </div>
            <fieldset className="routine-fieldset nested">
              <legend>{uiMessage('plan.routine-form.1490')}</legend>
              <label className="toggle-row">
                <input
                  type="radio"
                  name={`${groupName}-missing-day`}
                  checked={form.missingDayPolicy === 'skip'}
                  onChange={() => set('missingDayPolicy', 'skip')}
                />
                {uiMessage('plan.routine-form.1491')}
              </label>
              <label className="toggle-row">
                <input
                  type="radio"
                  name={`${groupName}-missing-day`}
                  checked={form.missingDayPolicy === 'last_day'}
                  onChange={() => set('missingDayPolicy', 'last_day')}
                />
                {uiMessage('plan.routine-form.1492')}
              </label>
            </fieldset>
          </>
        )}
      </fieldset>
      <div className="two-column-fields">
        <label className="field-label">
          {startLabel}
          <input
            data-autofocus={autoFocusStart ? true : undefined}
            type="date"
            required
            value={form.startsOn}
            onChange={(event) => set('startsOn', event.target.value)}
          />
        </label>
        <label className="field-label">
          {uiMessage('plan.routine-form.1493')}
          <span>{uiMessage('plan.routine-form.1494')}</span>
          <input
            type="date"
            min={form.startsOn === '' ? undefined : form.startsOn}
            value={form.endsOn}
            onChange={(event) => set('endsOn', event.target.value)}
          />
        </label>
      </div>
      <fieldset className="routine-fieldset">
        <legend>{uiMessage('plan.routine-form.1495')}</legend>
        <label className="toggle-row">
          <input
            type="radio"
            name={`${groupName}-timing`}
            checked={countOnly || form.timing === 'day_flexible'}
            onChange={() => set('timing', 'day_flexible')}
          />
          {uiMessage('plan.routine-form.1445')}
        </label>
        <label className="toggle-row">
          <input
            type="radio"
            name={`${groupName}-timing`}
            disabled={countOnly}
            checked={!countOnly && form.timing === 'time_specific'}
            onChange={() => set('timing', 'time_specific')}
          />
          {uiMessage('plan.routine-form.1496')}
        </label>
        {countOnly && <p className="field-help">{uiMessage('plan.routine-form.1497')}</p>}
        {!countOnly && form.timing === 'time_specific' && (
          <div className="nested-fields">
            <div className="two-column-fields">
              <label className="field-label">
                {uiMessage('actions-ui.351')}
                <input
                  type="time"
                  required
                  value={form.wallTime}
                  onChange={(event) => set('wallTime', event.target.value)}
                />
              </label>
              <label className="field-label">
                {uiMessage('plan.routine-form.1498')}
                <span>{uiMessage('plan.routine-form.1499')}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  required
                  min="1"
                  max="1440"
                  value={form.durationMinutes}
                  onChange={(event) => set('durationMinutes', event.target.value)}
                />
              </label>
            </div>
            <fieldset className="routine-fieldset nested">
              <legend>{uiMessage('plan.routine-form.1500')}</legend>
              <label className="toggle-row">
                <input
                  type="radio"
                  name={`${groupName}-zone`}
                  checked={form.zoneKind === 'follow_profile'}
                  onChange={() => set('zoneKind', 'follow_profile')}
                />
                {uiMessage('plan.routine-form.1501')}
                {planningZone === undefined ? '' : ` (${planningZone.replace(/_/gu, ' ')})`}
              </label>
              <label className="toggle-row">
                <input
                  type="radio"
                  name={`${groupName}-zone`}
                  checked={form.zoneKind === 'fixed_zone'}
                  onChange={() => {
                    set('zoneKind', 'fixed_zone');
                    if (form.timeZone === '' && planningZone !== undefined)
                      set('timeZone', planningZone);
                  }}
                />
                {uiMessage('plan.routine-form.1502')}
              </label>
              {form.zoneKind === 'fixed_zone' && (
                <ZonePicker
                  label={uiMessage('plan.routine-form.1503')}
                  value={form.timeZone}
                  onChange={(value) => set('timeZone', value)}
                />
              )}
            </fieldset>
            <div className="two-column-fields">
              <label className="field-label">
                {uiMessage('plan.routine-form.1504')}
                <select
                  value={form.gapPolicy}
                  onChange={(event) =>
                    set('gapPolicy', event.target.value as RoutineFormState['gapPolicy'])
                  }
                >
                  <option value="shift_forward">{uiMessage('plan.routine-form.1505')}</option>
                  <option value="skip">{uiMessage('plan.routine-form.1506')}</option>
                </select>
              </label>
              <label className="field-label">
                {uiMessage('plan.routine-form.1507')}
                <select
                  value={form.overlapPolicy}
                  onChange={(event) =>
                    set('overlapPolicy', event.target.value as RoutineFormState['overlapPolicy'])
                  }
                >
                  <option value="earlier_offset">{uiMessage('plan.routine-form.1508')}</option>
                  <option value="later_offset">{uiMessage('plan.routine-form.1509')}</option>
                </select>
              </label>
            </div>
          </div>
        )}
      </fieldset>
    </div>
  );
}

/**
 * Off, or minutes before each occurrence, in one fieldset with its legend (Review). The minutes error
 * is tied to its field; the choice is native radios, so keyboard and pointer work the same.
 */
export function RoutineReminderFields({
  autoFocus = false,
  choice,
  error,
  minutes,
  onChoice,
  onMinutes,
}: {
  /** Focus the chosen option first when a dialog opens on this fieldset. */
  readonly autoFocus?: boolean;
  readonly choice: RoutineFormState['reminder'];
  readonly error?: string;
  readonly minutes: string;
  readonly onChoice: (choice: RoutineFormState['reminder']) => void;
  readonly onMinutes: (minutes: string) => void;
}): ReactNode {
  const id = useId();
  const helpId = `${id}-help`;
  const minutesHelpId = `${id}-minutes-help`;
  const errorId = `${id}-minutes-error`;
  return (
    <fieldset className="routine-fieldset routine-reminder" aria-describedby={helpId}>
      <legend>{uiMessage('plan.routine-form.1510')}</legend>
      <p id={helpId} className="field-help">
        {routineReminderSavedCopy}
      </p>
      <label className="toggle-row">
        <input
          data-autofocus={autoFocus && choice === 'off' ? true : undefined}
          type="radio"
          name={`${id}-reminder`}
          checked={choice === 'off'}
          onChange={() => onChoice('off')}
        />
        {uiMessage('plan.routine-form.1511')}
      </label>
      <label className="toggle-row">
        <input
          data-autofocus={autoFocus && choice === 'before' ? true : undefined}
          type="radio"
          name={`${id}-reminder`}
          checked={choice === 'before'}
          onChange={() => onChoice('before')}
        />
        {uiMessage('plan.routine-form.1512')}
      </label>
      {choice === 'before' && (
        <div className="nested-fields">
          <label className="field-label">
            {uiMessage('plan.routine-form.1513')}
            <input
              type="number"
              inputMode="numeric"
              min="0"
              max="10080"
              required
              value={minutes}
              aria-invalid={error !== undefined}
              aria-describedby={error === undefined ? minutesHelpId : `${minutesHelpId} ${errorId}`}
              onChange={(event) => onMinutes(event.target.value)}
            />
            <span id={minutesHelpId}>{uiMessage('plan.routine-form.1514')}</span>
          </label>
          {error !== undefined && (
            <p id={errorId} className="warning-text">
              {error}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}

/** Optional defaults copied to each occurrence (Project, note, estimate, energy, priority). */
export function RoutineDefaultsFields({
  form,
  projects,
  set,
}: {
  readonly form: RoutineFormState;
  readonly projects: readonly ChoiceRow[];
  readonly set: RoutineFormSetter;
}): ReactNode {
  return (
    <details className="expanded-fields routine-defaults">
      <summary>{uiMessage('plan.routine-form.1515')}</summary>
      <p className="field-help">{uiMessage('plan.routine-form.1516')}</p>
      <label className="field-label">
        {uiMessage('actions-ui.254')}
        <select value={form.projectId} onChange={(event) => set('projectId', event.target.value)}>
          <option value="">{uiMessage('actions-ui.330')}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      </label>
      <label className="field-label">
        {uiMessage('actions-ui.327')}
        <span>{uiMessage('actions-ui.328')}</span>
        <textarea
          rows={3}
          maxLength={10000}
          value={form.note}
          onChange={(event) => set('note', event.target.value)}
        />
      </label>
      <div className="three-column-fields">
        <label className="field-label">
          {uiMessage('actions-ui.335')}
          <span>{uiMessage('plan.routine-form.1517')}</span>
          <input
            type="number"
            inputMode="numeric"
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
    </details>
  );
}

/* ───────────────────────── Preview ───────────────────────── */

const dstNotes: Readonly<Record<NonNullable<RoutinePreviewEntry['dstNote']>, string>> = {
  gap_shifted: uiMessage('plan.routine-form.1518'),
  gap_skipped: uiMessage('plan.routine-form.1519'),
  repeated_earlier: uiMessage('plan.routine-form.1520'),
  repeated_later: uiMessage('plan.routine-form.1521'),
};

const instantTime = (
  instant: string,
  zone: string,
  timeFormat: PlanProfile['timeFormat'],
): string => {
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: timeFormat === '12_hour' ? 'h12' : 'h23',
    }).format(new Date(instant));
  } catch {
    return instant.slice(11, 16);
  }
};

/** One preview/occurrence line in words. */
export function describePreviewEntry(
  entry: RoutinePreviewEntry,
  context: { readonly zone: string; readonly timeFormat: PlanProfile['timeFormat'] },
): { readonly when: string; readonly detail: string; readonly note?: string } {
  const note = entry.dstNote === undefined ? undefined : dstNotes[entry.dstNote];
  const withNote = <Value extends { when: string; detail: string }>(value: Value) =>
    note === undefined ? value : { ...value, note };
  if (entry.period.kind === 'week') {
    return withNote({
      when: uiMessage('plan.routine-form.1522', {
        value0: formatDate(entry.period.start, 'short'),
        value1: formatDate(entry.period.end),
      }),
      detail: uiMessage('plan.routine-form.1523', {
        value0: String(entry.period.targetCount),
        value1: entry.period.targetCount === 1 ? 'time' : 'times',
      }),
    });
  }
  const date = entry.date ?? entry.period.date;
  const when = formatDate(date, 'long');
  switch (entry.timing.kind) {
    case 'flexible':
    case 'weekly_count':
      return withNote({ when, detail: uiMessage('plan.routine-form.1445') });
    case 'timed': {
      const start =
        entry.localStart === undefined
          ? instantTime(entry.timing.startsAt, context.zone, context.timeFormat)
          : formatWallTime(entry.localStart, context.timeFormat);
      const end = instantTime(entry.timing.endsAt, context.zone, context.timeFormat);
      return withNote({
        when,
        detail: uiMessage('plan.routine-form.1524', {
          value0: start,
          value1: end,
          value2: context.zone.replace(/_/gu, ' '),
        }),
      });
    }
    case 'dst_skipped':
      return {
        when,
        detail: uiMessage('plan.routine-form.1525', {
          value0: formatWallTime(entry.timing.wallTime, context.timeFormat),
        }),
        ...(note === undefined ? {} : { note }),
      };
  }
}

type PreviewState =
  | { readonly status: 'idle'; readonly errors: readonly string[] }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly RoutinePreviewEntry[] }
  | { readonly status: 'error'; readonly message: string };

/** Live preview of the next occurrences, computed by the domain through the facade. */
export function RoutinePreview({
  count = 10,
  form,
  planning,
  profile,
}: {
  readonly count?: number;
  readonly form: RoutineFormState;
  readonly planning: PlanningApplication;
  readonly profile: PlanProfile | null;
}): ReactNode {
  const headingId = useId();
  const weekStart = profile?.weekStart ?? 'monday';
  const built = buildRoutineSchedule(form, weekStart);
  const key = built.ok ? JSON.stringify(built.value) : null;
  const [state, setState] = useState<PreviewState>({ status: 'idle', errors: [] });
  useEffect(() => {
    if (!built.ok || key === null) {
      setState({ status: 'idle', errors: built.ok ? [] : built.errors });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    const timer = window.setTimeout(() => {
      planning
        .previewRoutine(built.value, count)
        .then((result) => {
          if (!active) return;
          setState(
            result.ok
              ? { status: 'ready', entries: result.value }
              : { status: 'error', message: routineErrorMessage(result.error) },
          );
        })
        .catch(() => {
          if (active)
            setState({
              status: 'error',
              message: uiMessage('plan.routine-form.1526'),
            });
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [key, count, planning, built.ok ? '' : built.errors.join('|')]);
  const mode = built.ok ? built.value.schedulingMode : null;
  const zone =
    mode?.kind === 'time_specific' && mode.zonePolicy.kind === 'fixed_zone'
      ? mode.zonePolicy.timeZone
      : (profile?.planningTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const timeFormat = profile?.timeFormat ?? '24_hour';
  return (
    <section className="routine-preview" aria-labelledby={headingId}>
      <h3 id={headingId}>{uiMessage('plan.routine-form.1527')}</h3>
      {state.status === 'idle' && (
        <div className="field-help">
          <p>{uiMessage('plan.routine-form.1528')}</p>
          {state.errors.length > 0 && (
            <ul className="routine-preview-issues">
              {state.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {state.status === 'loading' && (
        <p className="field-help">{uiMessage('plan.routine-form.1529')}</p>
      )}
      {state.status === 'error' && <p className="warning-note">{state.message}</p>}
      {state.status === 'ready' &&
        (state.entries.length === 0 ? (
          <p className="warning-note">{uiMessage('plan.routine-form.1530')}</p>
        ) : (
          <ol className="routine-preview-list">
            {state.entries.map((entry, index) => {
              const text = describePreviewEntry(entry, { zone, timeFormat });
              return (
                <li key={`${entry.date ?? ''}-${String(index)}`}>
                  <strong>{text.when}</strong>
                  <span>{text.detail}</span>
                  {text.note !== undefined && <span className="warning-text">{text.note}</span>}
                </li>
              );
            })}
          </ol>
        ))}
    </section>
  );
}

/* ───────────────────────── Complete form ───────────────────────── */

/**
 * Move focus to the `[data-autofocus]` field inside a dialog form once it opens. The shared Modal
 * focuses first; this runs two frames later and only while focus has neither moved into the form
 * nor been moved by the person anywhere else in the dialog.
 */
export function useDialogAutofocus(): RefObject<HTMLFormElement | null> {
  const container = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        const element = container.current;
        if (element === null || element.contains(document.activeElement)) return;
        const dialog = element.closest('dialog');
        if (dialog === null || !mayMoveAutofocus(dialog)) return;
        autofocusIn(dialog, element.querySelector<HTMLElement>('[data-autofocus]'));
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, []);
  return container;
}

/** Profile for defaults (week start, planning zone); falls back to device values. */
export function usePlanProfile(
  planning: PlanningApplication,
  provided?: PlanProfile | null,
): PlanProfile | null {
  const [profile, setProfile] = useState<PlanProfile | null>(provided ?? null);
  useEffect(() => {
    if (provided !== undefined && provided !== null) {
      setProfile(provided);
      return;
    }
    let active = true;
    planning
      .getCapacitySettings()
      .then((settings) => {
        if (active) setProfile(settings.profile);
      })
      .catch(() => {
        // Defaults stay device-derived when the profile cannot be read.
      });
    return () => {
      active = false;
    };
  }, [planning, provided]);
  return profile;
}

/**
 * Routine form: title and description (optional section), repeat pattern, scheduling, defaults,
 * a live preview, and validation in words. Entered values are preserved on any error.
 */
export function RoutineForm({
  intro,
  initial,
  onCancel,
  onSubmit,
  planning,
  profile: providedProfile,
  showDefaults = true,
  showDetails = true,
  showReminder = false,
  startLabel,
  submitLabel,
}: {
  readonly intro?: ReactNode;
  readonly initial: RoutineFormState;
  readonly onCancel?: () => void;
  /** Returns an error message in words, or null when the command committed. */
  readonly onSubmit: (input: RoutineInput, form: RoutineFormState) => Promise<string | null>;
  readonly planning: PlanningApplication;
  readonly profile?: PlanProfile | null;
  readonly showDefaults?: boolean;
  readonly showDetails?: boolean;
  /** Offer a reminder before each occurrence when the Routine is at a set time (Review). */
  readonly showReminder?: boolean;
  readonly startLabel?: string;
  readonly submitLabel: string;
}): ReactNode {
  const [form, setForm] = useState<RoutineFormState>(initial);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const autofocusRef = useDialogAutofocus();
  const [projects, setProjects] = useState<readonly ChoiceRow[]>([]);
  const profile = usePlanProfile(planning, providedProfile);
  const set: RoutineFormSetter = (key, value) =>
    setForm((current) => ({ ...current, [key]: value }));
  useEffect(() => {
    if (!showDefaults) return;
    let active = true;
    planning
      .listProjects()
      .then((rows) => {
        if (active) setProjects(rows);
      })
      .catch(() => {
        // The Project default is optional; the form stays usable without choices.
      });
    return () => {
      active = false;
    };
  }, [planning, showDefaults]);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const built = buildRoutineInput(
      showDetails
        ? form
        : {
            ...form,
            title: form.title.trim() === '' ? uiMessage('plan.routine-form.1531') : form.title,
          },
      profile?.weekStart ?? 'monday',
      showReminder ? { includeReminder: true } : {},
    );
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const message = await onSubmit(built.value, form);
      if (message !== null) setErrors([message]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      ref={autofocusRef}
      className="plan-form routine-form"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      {intro}
      {errors.length > 0 && (
        <div className="validation-summary" role="alert">
          <p>
            <strong>{uiMessage('alignment.object-forms.644')}</strong>
          </p>
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      {showDetails && (
        <>
          <label className="field-label">
            {uiMessage('actions-ui.325')}
            <span>{uiMessage('actions-ui.326')}</span>
            <input
              data-autofocus
              required
              maxLength={200}
              value={form.title}
              onChange={(event) => set('title', event.target.value)}
            />
          </label>
          <label className="field-label">
            {uiMessage('plan.routine-form.1532')}
            <span>{uiMessage('alignment.object-forms.664')}</span>
            <textarea
              rows={2}
              maxLength={10000}
              value={form.description}
              onChange={(event) => set('description', event.target.value)}
            />
          </label>
        </>
      )}
      <RoutinePatternFields
        autoFocusStart={!showDetails}
        form={form}
        set={set}
        weekStart={profile?.weekStart ?? 'monday'}
        {...(profile === null ? {} : { planningZone: profile.planningTimeZone })}
        {...(startLabel === undefined ? {} : { startLabel })}
      />
      {showReminder && isTimedRoutineForm(form) && (
        <RoutineReminderFields
          choice={form.reminder}
          minutes={form.reminderMinutes}
          onChoice={(value) => set('reminder', value)}
          onMinutes={(value) => set('reminderMinutes', value)}
          {...(errors.includes(routineReminderMinutesError)
            ? { error: routineReminderMinutesError }
            : {})}
        />
      )}
      {showDefaults && <RoutineDefaultsFields form={form} projects={projects} set={set} />}
      <RoutinePreview form={form} planning={planning} profile={profile} />
      <div className="dialog-actions">
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel}>
            {uiMessage('account.account-dialogs.20')}
          </button>
        )}
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? uiMessage('account.conflicts-page.133') : submitLabel}
        </button>
      </div>
    </form>
  );
}
