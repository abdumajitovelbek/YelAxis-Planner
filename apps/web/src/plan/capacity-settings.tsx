import { message as uiMessage } from '../messages';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';

import type { AvailabilityInput, CapacitySettings, PlanProfile } from '@yelaxis/application';
import type { ConstraintStrength, Weekday } from '@yelaxis/domain';

import { formatDuration, formatWallTime, formatWindowEnd } from './format';
import {
  CommandFeedback,
  useCommandRunner,
  usePlanning,
  usePlanQuery,
  type CommandRunner,
} from './planning-context';
import { useUnsavedGuard } from './unsaved-guard';

import './horizon-views.css';

type AvailabilitySet = CapacitySettings['availability'][number];

const weekdayOrder: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
const weekdayShort: Readonly<Record<Weekday, string>> = {
  monday: uiMessage('plan.capacity-settings.1143'),
  tuesday: uiMessage('plan.capacity-settings.1144'),
  wednesday: uiMessage('plan.capacity-settings.1145'),
  thursday: uiMessage('plan.capacity-settings.1146'),
  friday: uiMessage('plan.capacity-settings.1147'),
  saturday: uiMessage('plan.capacity-settings.1148'),
  sunday: uiMessage('plan.capacity-settings.1149'),
};
const weekdayLong: Readonly<Record<Weekday, string>> = {
  monday: uiMessage('onboarding-ui.1024'),
  tuesday: uiMessage('onboarding-ui.1025'),
  wednesday: uiMessage('onboarding-ui.1026'),
  thursday: uiMessage('onboarding-ui.1027'),
  friday: uiMessage('onboarding-ui.1028'),
  saturday: uiMessage('onboarding-ui.1029'),
  sunday: uiMessage('onboarding-ui.1030'),
};
const strengthOptions: readonly {
  readonly value: ConstraintStrength;
  readonly label: string;
  readonly help: string;
}[] = [
  {
    value: 'hard',
    label: uiMessage('plan.capacity-settings.1150'),
    help: uiMessage('plan.capacity-settings.1151'),
  },
  {
    value: 'soft',
    label: uiMessage('plan.capacity-settings.1152'),
    help: uiMessage('plan.capacity-settings.1153'),
  },
  {
    value: 'unknown',
    label: uiMessage('actions-ui.338'),
    help: uiMessage('plan.capacity-settings.1154'),
  },
];
const strengthLabels: Readonly<Record<ConstraintStrength, string>> = {
  hard: uiMessage('plan.capacity-settings.1150'),
  soft: uiMessage('plan.capacity-settings.1152'),
  unknown: uiMessage('plan.capacity-settings.1155'),
};

const wallTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/u;
/** As an end time, 00:00 means midnight at the end of the day. */
const midnight = '00:00';
const dayLimitMax = 24 * 60;
const weekLimitMax = 7 * 24 * 60;

/** Weekdays in the profile's week order. */
export function orderedWeekdays(weekStart: Weekday): readonly Weekday[] {
  const index = weekdayOrder.indexOf(weekStart);
  return [...weekdayOrder.slice(index), ...weekdayOrder.slice(0, index)];
}

/** "Mon 09:00–17:00, 18:00–19:00" lines in week order. */
export function windowLines(
  windows: AvailabilitySet['windows'],
  profile: PlanProfile,
): readonly string[] {
  return orderedWeekdays(profile.weekStart).flatMap((weekday) => {
    const day = windows
      .filter((window) => window.weekday === weekday)
      .sort((left, right) => left.start.localeCompare(right.start));
    if (day.length === 0) return [];
    const times = day
      .map(
        (window) =>
          `${formatWallTime(window.start, profile.timeFormat)}–${formatWindowEnd(
            window.end,
            profile.timeFormat,
          )}`,
      )
      .join(', ');
    return [`${weekdayShort[weekday]} ${times}`];
  });
}

interface WindowRow {
  readonly key: number;
  readonly days: readonly Weekday[];
  readonly start: string;
  readonly end: string;
}

interface EditorState {
  readonly target: { readonly id: string; readonly revision: number } | null;
  readonly strength: ConstraintStrength | '';
  readonly rows: readonly WindowRow[];
  /** Serialized starting point, used to detect unsaved edits. */
  readonly initial: string;
}

const serializeEditor = (editor: Pick<EditorState, 'strength' | 'rows'>): string =>
  JSON.stringify({
    strength: editor.strength,
    rows: editor.rows.map((row) => [[...row.days].sort(), row.start, row.end]),
  });

interface EditorErrors {
  readonly messages: readonly string[];
  readonly strength: boolean;
  readonly rows: Readonly<Record<number, { readonly days?: true; readonly time?: true }>>;
}

const noErrors: EditorErrors = { messages: [], strength: false, rows: {} };

/** Validate the editor draft into a command input, or explain every problem calmly. */
export function validateAvailabilityDraft(
  strength: ConstraintStrength | '',
  rows: readonly Pick<WindowRow, 'days' | 'start' | 'end'>[],
):
  | { readonly ok: true; readonly input: AvailabilityInput }
  | { readonly ok: false; readonly errors: EditorErrors } {
  const messages: string[] = [];
  const rowErrors: Record<number, { days?: true; time?: true }> = {};
  if (strength === '') messages.push(uiMessage('plan.capacity-settings.1156'));
  if (rows.length === 0) messages.push(uiMessage('plan.capacity-settings.1157'));
  rows.forEach((row, index) => {
    const label =
      rows.length === 1
        ? uiMessage('plan.capacity-settings.1158')
        : uiMessage('plan.capacity-settings.1159', { value0: String(index + 1) });
    if (row.days.length === 0) {
      messages.push(uiMessage('plan.capacity-settings.1160', { value0: label }));
      rowErrors[index] = { ...rowErrors[index], days: true };
    }
    if (!wallTimePattern.test(row.start) || !wallTimePattern.test(row.end)) {
      messages.push(uiMessage('plan.capacity-settings.1161', { value0: label }));
      rowErrors[index] = { ...rowErrors[index], time: true };
    } else if (!(row.end > row.start || (row.end === midnight && row.start !== midnight))) {
      messages.push(uiMessage('plan.capacity-settings.1162', { value0: label }));
      rowErrors[index] = { ...rowErrors[index], time: true };
    }
  });
  if (messages.length > 0 || strength === '')
    return { ok: false, errors: { messages, strength: strength === '', rows: rowErrors } };
  const windows = rows.flatMap((row) =>
    weekdayOrder
      .filter((weekday) => row.days.includes(weekday))
      .map((weekday) => ({ weekday, start: row.start, end: row.end })),
  );
  return { ok: true, input: { strength, windows } };
}

/** Split a limit into hour/minute field text. */
const limitFields = (minutes: number | undefined): { hours: string; minutes: string } =>
  minutes === undefined
    ? { hours: '', minutes: '' }
    : { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) };

type LimitFields = ReturnType<typeof limitFields>;

/** Whether two limit field pairs describe the same limit (blank means no limit). */
const sameLimit = (left: LimitFields, right: LimitFields): boolean =>
  Number(left.hours || 0) * 60 + Number(left.minutes || 0) ===
    Number(right.hours || 0) * 60 + Number(right.minutes || 0) &&
  (left.hours + left.minutes === '') === (right.hours + right.minutes === '');

/** Parse hour/minute field text into total minutes, or explain what is wrong. */
export function parseLimit(
  hours: string,
  minutes: string,
  period: 'day' | 'week',
):
  | { readonly ok: true; readonly minutes: number }
  | { readonly ok: false; readonly message: string } {
  const hourText = hours.trim() === '' ? '0' : hours.trim();
  const minuteText = minutes.trim() === '' ? '0' : minutes.trim();
  if (!/^\d+$/u.test(hourText) || !/^\d+$/u.test(minuteText))
    return { ok: false, message: uiMessage('plan.capacity-settings.1163') };
  const minuteValue = Number(minuteText);
  if (minuteValue > 59) return { ok: false, message: uiMessage('plan.capacity-settings.1164') };
  const total = Number(hourText) * 60 + minuteValue;
  const max = period === 'day' ? dayLimitMax : weekLimitMax;
  if (total === 0) return { ok: false, message: uiMessage('plan.capacity-settings.1165') };
  if (total > max)
    return {
      ok: false,
      message:
        period === 'day'
          ? uiMessage('plan.capacity-settings.1166')
          : uiMessage('plan.capacity-settings.1167'),
    };
  return { ok: true, minutes: total };
}

/**
 * Availability and capacity settings. Capacity compares planned time with time the user makes
 * available; days without defined availability stay unknown and are never treated as free.
 */
export function CapacitySettingsPage(): ReactNode {
  const planning = usePlanning();
  const titleId = useId();
  const { state, reload } = usePlanQuery(() => planning.getCapacitySettings(), [planning]);
  return (
    <section
      className="content-section horizon-view capacity-page"
      aria-labelledby={titleId}
      aria-busy={state.status === 'ready' && state.refreshing}
    >
      <p className="eyebrow">{uiMessage('actions-ui.250')}</p>
      <h1 id={titleId}>{uiMessage('plan.capacity-settings.1168')}</h1>
      <p className="page-message">{uiMessage('plan.capacity-settings.1169')}</p>
      {state.status === 'loading' && (
        <p className="field-help" role="status">
          {uiMessage('plan.capacity-settings.1170')}
        </p>
      )}
      {state.status === 'error' && (
        <div className="horizon-error">
          <p role="alert">{state.message}</p>
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      )}
      {state.status === 'ready' && <CapacitySettingsView settings={state.data} titleId={titleId} />}
    </section>
  );
}

function CapacitySettingsView({
  settings,
  titleId,
}: {
  readonly settings: CapacitySettings;
  readonly titleId: string;
}): ReactNode {
  const planning = usePlanning();
  const runner = useCommandRunner();
  const rowKey = useRef(0);
  const nextKey = (): number => ++rowKey.current;
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [focusEditor, setFocusEditor] = useState(false);
  const [errors, setErrors] = useState<EditorErrors>(noErrors);
  const errorSummary = useRef<HTMLDivElement>(null);
  const [dayLimit, setDayLimit] = useState(() => limitFields(settings.dayCap?.minutes));
  const [weekLimit, setWeekLimit] = useState(() => limitFields(settings.weekCap?.minutes));
  const [limitErrors, setLimitErrors] = useState<{
    day?: string | undefined;
    week?: string | undefined;
  }>({});

  // Dirtiness compares the fields with the canonical limit they were last synced to, not with a
  // freshly reloaded value, so a reload or Undo never makes untouched fields look edited.
  const dayMinutes = settings.dayCap?.minutes;
  const weekMinutes = settings.weekCap?.minutes;
  const syncedDay = useRef(dayMinutes);
  const syncedWeek = useRef(weekMinutes);
  const dayDirty = !sameLimit(dayLimit, limitFields(syncedDay.current));
  const weekDirty = !sameLimit(weekLimit, limitFields(syncedWeek.current));
  const editorDirty = editor !== null && serializeEditor(editor) !== editor.initial;

  // Keep untouched limit fields aligned with the canonical settings after reloads and undo; edited
  // fields keep the user's text. The new object always re-renders so dirtiness is recomputed.
  useEffect(() => {
    const previous = syncedDay.current;
    syncedDay.current = dayMinutes;
    setDayLimit((current) =>
      sameLimit(current, limitFields(previous)) ? limitFields(dayMinutes) : { ...current },
    );
  }, [dayMinutes]);
  useEffect(() => {
    const previous = syncedWeek.current;
    syncedWeek.current = weekMinutes;
    setWeekLimit((current) =>
      sameLimit(current, limitFields(previous)) ? limitFields(weekMinutes) : { ...current },
    );
  }, [weekMinutes]);

  useEffect(() => {
    if (focusEditor && editor !== null) {
      editorHeading.current?.focus();
      setFocusEditor(false);
    }
  }, [focusEditor, editor]);

  const openEditor = (set: AvailabilitySet | null): void => {
    const rows: WindowRow[] = [];
    if (set === null) rows.push({ key: nextKey(), days: [], start: '', end: '' });
    else {
      const groups = new Map<string, Weekday[]>();
      for (const window of set.windows) {
        const key = `${window.start}|${window.end}`;
        groups.set(key, [...(groups.get(key) ?? []), window.weekday]);
      }
      for (const [key, days] of groups) {
        const [start = '', end = ''] = key.split('|');
        rows.push({ key: nextKey(), days, start, end });
      }
    }
    const strength: ConstraintStrength | '' = set === null ? '' : set.strength;
    setErrors(noErrors);
    setEditor({
      target: set === null ? null : { id: set.id, revision: set.localRevision },
      strength,
      rows,
      initial: serializeEditor({ strength, rows }),
    });
    setFocusEditor(true);
  };

  const closeEditor = (): void => {
    setEditor(null);
    setErrors(noErrors);
    window.requestAnimationFrame(() => addButton.current?.focus());
  };

  const saveEditor = async (): Promise<boolean> => {
    if (editor === null) return true;
    const validated = validateAvailabilityDraft(editor.strength, editor.rows);
    if (!validated.ok) {
      setErrors(validated.errors);
      window.requestAnimationFrame(() => errorSummary.current?.focus());
      return false;
    }
    setErrors(noErrors);
    const target = editor.target;
    const saved = await runner.run(
      () =>
        target === null
          ? planning.addAvailability(validated.input)
          : planning.editAvailability({
              ...validated.input,
              constraintId: target.id,
              revision: target.revision,
            }),
      target === null
        ? uiMessage('plan.capacity-settings.1171')
        : uiMessage('plan.capacity-settings.1172'),
    );
    if (saved) closeEditor();
    return saved;
  };

  const saveLimit = async (period: 'day' | 'week'): Promise<boolean> => {
    const fields = period === 'day' ? dayLimit : weekLimit;
    const parsed = parseLimit(fields.hours, fields.minutes, period);
    if (!parsed.ok) {
      setLimitErrors((current) => ({ ...current, [period]: parsed.message }));
      return false;
    }
    setLimitErrors((current) => ({ ...current, [period]: undefined }));
    const saved = await runner.run(
      () => planning.setCapacityCap({ period, minutes: parsed.minutes }),
      period === 'day'
        ? uiMessage('plan.capacity-settings.1173')
        : uiMessage('plan.capacity-settings.1174'),
    );
    if (saved) {
      const next = limitFields(parsed.minutes);
      if (period === 'day') {
        syncedDay.current = parsed.minutes;
        setDayLimit(next);
      } else {
        syncedWeek.current = parsed.minutes;
        setWeekLimit(next);
      }
    }
    return saved;
  };

  const clearLimit = async (period: 'day' | 'week'): Promise<void> => {
    setLimitErrors((current) => ({ ...current, [period]: undefined }));
    const saved = await runner.run(
      () => planning.setCapacityCap({ period, minutes: null }),
      period === 'day'
        ? uiMessage('plan.capacity-settings.1175')
        : uiMessage('plan.capacity-settings.1176'),
    );
    if (saved) {
      if (period === 'day') {
        syncedDay.current = undefined;
        setDayLimit(limitFields(undefined));
      } else {
        syncedWeek.current = undefined;
        setWeekLimit(limitFields(undefined));
      }
    }
  };

  const saveAll = async (): Promise<boolean> => {
    if (editorDirty && !(await saveEditor())) return false;
    if (dayDirty && !(await saveLimit('day'))) return false;
    if (weekDirty && !(await saveLimit('week'))) return false;
    return true;
  };
  const { dialog } = useUnsavedGuard(editorDirty || dayDirty || weekDirty, saveAll);

  const knownDays = new Set(
    settings.availability.flatMap((set) => set.windows.map((window) => window.weekday)),
  );

  return (
    <>
      <p className="capacity-summary" aria-live="polite">
        {uiMessage('plan.capacity-settings.1177', { value0: String(knownDays.size) })}
        {settings.dayCap !== undefined &&
          knownDays.size < 7 &&
          uiMessage('plan.capacity-settings.1178', {
            value0: formatDuration(settings.dayCap.minutes),
          })}
      </p>
      <CommandFeedback runner={runner} />

      <section className="horizon-section" aria-labelledby={`${titleId}-sets`}>
        <h2 id={`${titleId}-sets`}>{uiMessage('plan.capacity-settings.1179')}</h2>
        {settings.availability.length === 0 ? (
          <p className="quiet-empty">{uiMessage('plan.capacity-settings.1180')}</p>
        ) : (
          <>
            {editor !== null && (
              <p className="field-help" id={`${titleId}-edit-lock`}>
                {uiMessage('plan.capacity-settings.1181')}
              </p>
            )}
            <ul className="horizon-list" aria-label={uiMessage('plan.capacity-settings.1182')}>
              {settings.availability.map((set, index) => (
                <AvailabilityItem
                  key={set.id}
                  set={set}
                  index={index}
                  profile={settings.profile}
                  runner={runner}
                  editing={editor?.target?.id === set.id}
                  // One editor at a time: switching never discards an open edit.
                  locked={editor !== null && editor.target?.id !== set.id}
                  lockNoteId={`${titleId}-edit-lock`}
                  onEdit={() => openEditor(set)}
                  onArchive={() => {
                    if (editor?.target?.id === set.id) closeEditor();
                    void runner.run(
                      () =>
                        planning.archiveConstraint({
                          constraintId: set.id,
                          revision: set.localRevision,
                        }),
                      uiMessage('plan.capacity-settings.1183'),
                    );
                  }}
                />
              ))}
            </ul>
          </>
        )}
        {editor === null && (
          <button
            ref={addButton}
            type="button"
            className="primary-button"
            onClick={() => openEditor(null)}
          >
            {uiMessage('plan.capacity-settings.1184')}
          </button>
        )}
      </section>

      {editor !== null && (
        <AvailabilityEditor
          editor={editor}
          errors={errors}
          busy={runner.busy}
          profile={settings.profile}
          headingRef={editorHeading}
          summaryRef={errorSummary}
          newKey={nextKey}
          onChange={setEditor}
          onSave={() => void saveEditor()}
          onCancel={closeEditor}
        />
      )}

      <section className="horizon-section" aria-labelledby={`${titleId}-limits`}>
        <h2 id={`${titleId}-limits`}>{uiMessage('plan.capacity-settings.1185')}</h2>
        <p className="field-help">{uiMessage('plan.capacity-settings.1186')}</p>
        <div className="limit-grid">
          <LimitEditor
            period="day"
            current={settings.dayCap?.minutes}
            fields={dayLimit}
            error={limitErrors.day}
            busy={runner.busy}
            onChange={setDayLimit}
            onSet={() => void saveLimit('day')}
            onClear={() => void clearLimit('day')}
          />
          <LimitEditor
            period="week"
            current={settings.weekCap?.minutes}
            fields={weekLimit}
            error={limitErrors.week}
            busy={runner.busy}
            onChange={setWeekLimit}
            onSet={() => void saveLimit('week')}
            onClear={() => void clearLimit('week')}
          />
        </div>
      </section>
      {dialog}
    </>
  );
}

function AvailabilityItem({
  editing,
  index,
  lockNoteId,
  locked,
  onArchive,
  onEdit,
  profile,
  runner,
  set,
}: {
  readonly set: AvailabilitySet;
  readonly index: number;
  readonly profile: PlanProfile;
  readonly runner: CommandRunner;
  readonly editing: boolean;
  /** Another set's editor is open; editing this one waits until it is saved or canceled. */
  readonly locked: boolean;
  readonly lockNoteId: string;
  readonly onEdit: () => void;
  readonly onArchive: () => void;
}): ReactNode {
  const headingId = useId();
  const name = set.label ?? uiMessage('plan.capacity-settings.1187', { value0: String(index + 1) });
  return (
    <li className="horizon-item availability-item" aria-labelledby={headingId}>
      <h3 id={headingId}>{name}</h3>
      <p className="horizon-meta">
        <span className="status-pill">{strengthLabels[set.strength]}</span>
        {editing && <span className="status-pill">{uiMessage('plan.capacity-settings.1188')}</span>}
      </p>
      <ul
        className="window-lines"
        aria-label={uiMessage('plan.capacity-settings.1189', { value0: name })}
      >
        {windowLines(set.windows, profile).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="theme-editor-actions">
        <button
          type="button"
          disabled={runner.busy || editing || locked}
          aria-label={uiMessage('plan.capacity-settings.1190', { value0: name })}
          {...(locked ? { 'aria-describedby': lockNoteId } : {})}
          onClick={onEdit}
        >
          {uiMessage('plan.capacity-settings.1191')}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={runner.busy}
          aria-label={uiMessage('alignment.lifecycle-dialogs.486', { value0: name })}
          onClick={onArchive}
        >
          {uiMessage('actions-ui.258')}
        </button>
      </div>
    </li>
  );
}

function AvailabilityEditor({
  busy,
  editor,
  errors,
  headingRef,
  newKey,
  onCancel,
  onChange,
  onSave,
  profile,
  summaryRef,
}: {
  readonly editor: EditorState;
  readonly errors: EditorErrors;
  readonly busy: boolean;
  readonly profile: PlanProfile;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly summaryRef: RefObject<HTMLDivElement | null>;
  readonly newKey: () => number;
  readonly onChange: (editor: EditorState) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const headingId = useId();
  const strengthName = useId();
  const weekdays = orderedWeekdays(profile.weekStart);
  const updateRow = (key: number, change: Partial<Omit<WindowRow, 'key'>>): void =>
    onChange({
      ...editor,
      rows: editor.rows.map((row) => (row.key === key ? { ...row, ...change } : row)),
    });
  const title =
    editor.target === null
      ? uiMessage('plan.capacity-settings.1184')
      : uiMessage('plan.capacity-settings.1192');
  return (
    <section className="horizon-section availability-editor" aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        {title}
      </h2>
      <form
        className="plan-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        {errors.messages.length > 0 && (
          <div ref={summaryRef} className="validation-summary" role="alert" tabIndex={-1}>
            <p>{uiMessage('alignment.object-forms.644')}</p>
            <ul>
              {errors.messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="field-help">{uiMessage('plan.capacity-settings.1193')}</p>
        <ol className="window-rows" aria-label={uiMessage('plan.capacity-settings.1194')}>
          {editor.rows.map((row, index) => {
            const rowError = errors.rows[index];
            const label =
              editor.rows.length === 1
                ? uiMessage('plan.capacity-settings.1195')
                : uiMessage('plan.capacity-settings.1159', { value0: String(index + 1) });
            return (
              <li key={row.key} className="window-row">
                <fieldset className="compact-fieldset" aria-invalid={rowError !== undefined}>
                  <legend>{label}</legend>
                  <fieldset className="weekday-fieldset" aria-invalid={rowError?.days === true}>
                    <legend className="sub-legend">{uiMessage('onboarding-ui.1065')}</legend>
                    <div className="weekday-options">
                      {weekdays.map((weekday) => (
                        <label key={weekday}>
                          <input
                            type="checkbox"
                            checked={row.days.includes(weekday)}
                            aria-label={weekdayLong[weekday]}
                            onChange={(event) =>
                              updateRow(row.key, {
                                days: event.target.checked
                                  ? [...row.days, weekday]
                                  : row.days.filter((day) => day !== weekday),
                              })
                            }
                          />
                          <span aria-hidden="true">
                            {`${weekdayShort[weekday]}${row.days.includes(weekday) ? ' ✓' : ''}`}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="two-column-fields">
                    <label className="field-label">
                      {uiMessage('actions-ui.270')}
                      <input
                        type="time"
                        value={row.start}
                        aria-invalid={rowError?.time === true}
                        onChange={(event) => updateRow(row.key, { start: event.target.value })}
                      />
                    </label>
                    <label className="field-label">
                      {uiMessage('actions-ui.271')}
                      <input
                        type="time"
                        value={row.end}
                        aria-invalid={rowError?.time === true}
                        onChange={(event) => updateRow(row.key, { end: event.target.value })}
                      />
                    </label>
                  </div>
                  {editor.rows.length > 1 && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        onChange({
                          ...editor,
                          rows: editor.rows.filter((candidate) => candidate.key !== row.key),
                        })
                      }
                    >
                      {uiMessage('plan.capacity-settings.1196', { value0: label.toLowerCase() })}
                    </button>
                  )}
                </fieldset>
              </li>
            );
          })}
        </ol>
        <div>
          <button
            type="button"
            onClick={() =>
              onChange({
                ...editor,
                rows: [...editor.rows, { key: newKey(), days: [], start: '', end: '' }],
              })
            }
          >
            {uiMessage('plan.capacity-settings.1197')}
          </button>
        </div>
        <fieldset className="compact-fieldset" aria-invalid={errors.strength}>
          <legend>{uiMessage('plan.capacity-settings.1198')}</legend>
          <div className="strength-options">
            {strengthOptions.map((option) => (
              <label key={option.value} className="radio-option">
                <input
                  type="radio"
                  name={strengthName}
                  value={option.value}
                  checked={editor.strength === option.value}
                  onChange={() => onChange({ ...editor, strength: option.value })}
                />
                <span>
                  <strong>{option.label}</strong> <span className="field-help">{option.help}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="theme-editor-actions">
          <button className="primary-button" type="submit" disabled={busy}>
            {busy
              ? uiMessage('account.conflicts-page.133')
              : uiMessage('plan.capacity-settings.1199')}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            {uiMessage('account.account-dialogs.20')}
          </button>
        </div>
      </form>
    </section>
  );
}

function LimitEditor({
  busy,
  current,
  error,
  fields,
  onChange,
  onClear,
  onSet,
  period,
}: {
  readonly period: 'day' | 'week';
  readonly current: number | undefined;
  readonly fields: { readonly hours: string; readonly minutes: string };
  readonly error: string | undefined;
  readonly busy: boolean;
  readonly onChange: (fields: { hours: string; minutes: string }) => void;
  readonly onSet: () => void;
  readonly onClear: () => void;
}): ReactNode {
  const noun =
    period === 'day'
      ? uiMessage('plan.capacity-settings.1200')
      : uiMessage('plan.capacity-settings.1201');
  const errorId = useId();
  const currentId = useId();
  const describedBy = [currentId, ...(error === undefined ? [] : [errorId])].join(' ');
  return (
    <fieldset className="compact-fieldset limit-editor">
      <legend>{noun}</legend>
      <p id={currentId} className="field-help">
        {current === undefined
          ? uiMessage('plan.capacity-settings.1202', { value0: noun.toLowerCase() })
          : uiMessage('plan.capacity-settings.1203', {
              value0: noun.toLowerCase(),
              value1: formatDuration(current),
            })}
      </p>
      <div className="two-column-fields">
        <label className="field-label">
          {uiMessage('plan.capacity-settings.1204')}
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={period === 'day' ? 24 : 168}
            value={fields.hours}
            aria-invalid={error !== undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange({ ...fields, hours: event.target.value })}
          />
        </label>
        <label className="field-label">
          {uiMessage('plan.capacity-settings.1205')}
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            value={fields.minutes}
            aria-invalid={error !== undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange({ ...fields, minutes: event.target.value })}
          />
        </label>
      </div>
      {error !== undefined && (
        <p id={errorId} className="warning-text" role="alert">
          {error}
        </p>
      )}
      <div className="theme-editor-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={onSet}>
          {uiMessage('plan.capacity-settings.1206', { value0: noun.toLowerCase() })}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={busy || current === undefined}
          onClick={onClear}
        >
          {uiMessage('plan.capacity-settings.1207', { value0: noun.toLowerCase() })}
        </button>
      </div>
    </fieldset>
  );
}
