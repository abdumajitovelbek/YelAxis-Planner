import { message as uiMessage } from '../messages';
/**
 * Create and edit dialogs for Axes, Outcomes, Projects, and Milestones, and the Outcome progress
 * editor. Fields are validated in words before any command runs (the same limits the application
 * enforces), entered values survive every error, and leaving a changed form offers Save, Discard,
 * or Continue editing.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import type {
  AlignmentNode,
  ApplicationResult,
  AxisInput,
  AxisSummary,
  CommandReceipt,
  MilestoneItem,
  OutcomeItem,
  OutcomeProgressInput,
  ProjectItem,
} from '@yelaxis/application';
import {
  alignmentFieldLimits,
  axisColorTokens,
  validateTargetWindowInput,
  type AlignmentKind,
} from '@yelaxis/domain';

import { Modal } from '../plan/modal';
import { useAlignment, type CommandRunner } from '../plan/planning-context';
import { useUnsavedGuard } from '../plan/unsaved-guard';
import { AxisIcon } from './axis-icon';
import { axisIconEntry, axisIcons } from './axis-icons';
import { createdId, rejectedField, runForReceipt } from './kit';
import { progressText } from './labels';

/* ───────────────────────── Shared validation ───────────────────────── */

const number = (value: number): string => value.toLocaleString('en-US');

function titleProblem(value: string, maximum: number): string | undefined {
  const text = value.trim();
  if (text === '') return uiMessage('alignment.object-forms.637');
  if (text.length > maximum)
    return uiMessage('alignment.object-forms.638', { value0: number(maximum) });
  return undefined;
}

function requiredTextProblem(value: string, name: string, maximum: number): string | undefined {
  const text = value.trim();
  if (text === '') return uiMessage('alignment.object-forms.639', { value0: name });
  if (text.length > maximum)
    return uiMessage('alignment.object-forms.640', { value0: name, value1: number(maximum) });
  return undefined;
}

function optionalTextProblem(value: string, name: string, maximum: number): string | undefined {
  return value.trim().length > maximum
    ? uiMessage('alignment.object-forms.640', { value0: name, value1: number(maximum) })
    : undefined;
}

function targetProblems(
  start: string,
  end: string,
): { readonly targetStart?: string; readonly targetEnd?: string } {
  const window = validateTargetWindowInput(start, end);
  if (window.ok) return {};
  return window.error.details?.['field'] === 'targetStart'
    ? { targetStart: window.error.message }
    : { targetEnd: window.error.message };
}

/** Blank optional text is omitted; the application stores nothing for it. */
const optional = <Key extends string>(key: Key, value: string): { readonly [K in Key]?: string } =>
  (value.trim() === '' ? {} : { [key]: value.trim() }) as { readonly [K in Key]?: string };

type Problems<Field extends string> = { readonly [K in Field]?: string | undefined };

const firstProblem = <Field extends string>(
  order: readonly Field[],
  problems: Problems<Field>,
): Field | null => order.find((field) => problems[field] !== undefined) ?? null;

const problemList = <Field extends string>(
  order: readonly Field[],
  problems: Problems<Field>,
): readonly string[] =>
  order.flatMap((field) => {
    const problem = problems[field];
    return problem === undefined ? [] : [problem];
  });

/* ───────────────────────── Form state and submit ───────────────────────── */

interface DialogFormState<Form, Field extends string> {
  readonly open: boolean;
  readonly form: Form;
  readonly baseline: Form;
  readonly problems: Problems<Field>;
  /** A command failure that names no field. */
  readonly failure: string | null;
}

interface DialogForm<Form, Field extends string> {
  readonly form: Form;
  readonly problems: Problems<Field>;
  readonly failure: string | null;
  readonly dirty: boolean;
  readonly set: <Key extends keyof Form>(key: Key, value: Form[Key]) => void;
  readonly report: (problems: Problems<Field>, failure?: string | null) => void;
}

/**
 * Form values for a dialog, reset from `init` each time it opens. Entered values survive errors
 * because nothing else resets them.
 */
function useDialogForm<Form extends object, Field extends string>(
  open: boolean,
  init: () => Form,
): DialogForm<Form, Field> {
  const [state, setState] = useState<DialogFormState<Form, Field>>(() => {
    const form = init();
    return { open, form, baseline: form, problems: {}, failure: null };
  });
  let current = state;
  if (state.open !== open) {
    const form = init();
    current = { open, form, baseline: form, problems: {}, failure: null };
    setState(current);
  }
  return {
    form: current.form,
    problems: current.problems,
    failure: current.failure,
    dirty: JSON.stringify(current.form) !== JSON.stringify(current.baseline),
    set: (key, value) =>
      setState((previous) => ({ ...previous, form: { ...previous.form, [key]: value } })),
    report: (problems, failure = null) =>
      setState((previous) => ({ ...previous, problems, failure })),
  };
}

interface SubmitPlan<Field extends string> {
  /** Field order, used for the summary and for the first field to focus. */
  readonly order: readonly Field[];
  readonly problems: Problems<Field>;
  /** Runs only when there are no problems. */
  readonly command: () => Promise<ApplicationResult<CommandReceipt>>;
  readonly success: string;
  /** The edited object's id; a create reports the id from its receipt. */
  readonly editingId: string | undefined;
}

/**
 * Validate, run one command through the shared runner, and then either close (reporting the saved
 * id) or show the problem next to its field and move focus there (or to the summary).
 */
function useFormSubmit<Field extends string>(
  runner: CommandRunner,
  form: Pick<DialogForm<object, Field>, 'report'>,
  fieldId: (field: Field) => string,
  onClose: () => void,
  onSaved: ((id: string, receipt: CommandReceipt | null) => void) | undefined,
): {
  readonly summaryRef: RefObject<HTMLDivElement | null>;
  readonly submit: (plan: SubmitPlan<Field>) => Promise<boolean>;
} {
  const summaryRef = useRef<HTMLDivElement>(null);
  const focus = (field: Field | null): void => {
    window.requestAnimationFrame(() => {
      const element = field === null ? null : document.getElementById(fieldId(field));
      (element ?? summaryRef.current)?.focus();
    });
  };
  const submit = async (plan: SubmitPlan<Field>): Promise<boolean> => {
    if (runner.busy) return false;
    const first = firstProblem(plan.order, plan.problems);
    if (first !== null) {
      form.report(plan.problems);
      focus(first);
      return false;
    }
    form.report({});
    const outcome = await runForReceipt(runner, plan.command, plan.success);
    if (!outcome.ok) {
      const named = rejectedField(outcome.error);
      const field = plan.order.find((candidate) => candidate === named);
      if (field === undefined) form.report({}, outcome.message);
      else form.report({ [field]: outcome.message } as Problems<Field>);
      focus(field ?? null);
      return false;
    }
    onClose();
    const savedId = plan.editingId ?? createdId(outcome.receipt);
    if (savedId !== null) onSaved?.(savedId, outcome.receipt);
    return true;
  };
  return { summaryRef, submit };
}

/** Active choices for a picker, loaded while the dialog is open. */
function useChoices(
  open: boolean,
  kind: AlignmentKind,
  enabled = true,
): {
  readonly choices: readonly AlignmentNode[];
  readonly status: 'loading' | 'ready' | 'error';
} {
  const alignment = useAlignment();
  const [state, setState] = useState<{
    readonly choices: readonly AlignmentNode[];
    readonly status: 'loading' | 'ready' | 'error';
  }>({ choices: [], status: 'loading' });
  useEffect(() => {
    if (!open || !enabled) return;
    let live = true;
    setState((previous) => ({ ...previous, status: 'loading' }));
    alignment.listChoices(kind).then(
      (choices) => {
        if (live) setState({ choices, status: 'ready' });
      },
      () => {
        if (live) setState({ choices: [], status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [alignment, enabled, kind, open]);
  return state;
}

/** Picker options: an empty choice, the loaded choices, and the current value if not loaded yet. */
function choiceOptions(
  emptyLabel: string,
  choices: readonly AlignmentNode[],
  current: string,
): readonly { readonly value: string; readonly label: string }[] {
  const options = [
    { value: '', label: emptyLabel },
    ...choices.map((choice): { readonly value: string; readonly label: string } => ({
      value: choice.id,
      label: choice.title,
    })),
  ];
  return current === '' || options.some((option) => option.value === current)
    ? options
    : [...options, { value: current, label: uiMessage('alignment.object-forms.641') }];
}

/* ───────────────────────── Fields ───────────────────────── */

interface FieldBase {
  readonly id: string;
  readonly label: string;
  /** Short constraint text shown under the label, e.g. "Required, up to 80 characters". */
  readonly hint?: string;
  readonly problem?: string | undefined;
}

const describedBy = (field: FieldBase): string | undefined => {
  const ids = [
    ...(field.hint === undefined ? [] : [`${field.id}-hint`]),
    ...(field.problem === undefined ? [] : [`${field.id}-problem`]),
  ];
  return ids.length === 0 ? undefined : ids.join(' ');
};

function FieldFrame({
  children,
  field,
}: {
  readonly field: FieldBase;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="form-field">
      <label htmlFor={field.id}>{field.label}</label>
      {field.hint !== undefined && (
        <p id={`${field.id}-hint`} className="field-help">
          {field.hint}
        </p>
      )}
      {children}
      {field.problem !== undefined && (
        <p id={`${field.id}-problem`} className="field-problem">
          {field.problem}
        </p>
      )}
    </div>
  );
}

function TextField({
  field,
  maxLength,
  multiline = false,
  onChange,
  rows = 3,
  value,
}: {
  readonly field: FieldBase;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength: number;
  readonly multiline?: boolean;
  readonly rows?: number;
}): ReactNode {
  const shared = {
    id: field.id,
    value,
    maxLength,
    'aria-invalid': field.problem !== undefined,
    'aria-describedby': describedBy(field),
  };
  return (
    <FieldFrame field={field}>
      {multiline ? (
        <textarea {...shared} rows={rows} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input {...shared} type="text" onChange={(event) => onChange(event.target.value)} />
      )}
    </FieldFrame>
  );
}

function DateField({
  field,
  onChange,
  value,
}: {
  readonly field: FieldBase;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <FieldFrame field={field}>
      <input
        id={field.id}
        type="date"
        value={value}
        aria-invalid={field.problem !== undefined}
        aria-describedby={describedBy(field)}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldFrame>
  );
}

function SelectField({
  field,
  onChange,
  options,
  value,
}: {
  readonly field: FieldBase;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}): ReactNode {
  return (
    <FieldFrame field={field}>
      <select
        id={field.id}
        value={value}
        aria-invalid={field.problem !== undefined}
        aria-describedby={describedBy(field)}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}

/** Optional, possibly one-sided target dates; ids are `${idPrefix}-targetStart` and `-targetEnd`. */
function TargetFields({
  end,
  idPrefix,
  onEnd,
  onStart,
  problems,
  start,
}: {
  readonly idPrefix: string;
  readonly start: string;
  readonly end: string;
  readonly onStart: (value: string) => void;
  readonly onEnd: (value: string) => void;
  readonly problems: {
    readonly targetStart?: string | undefined;
    readonly targetEnd?: string | undefined;
  };
}): ReactNode {
  return (
    <fieldset className="target-fields">
      <legend>{uiMessage('alignment.object-forms.642')}</legend>
      <p className="field-help">{uiMessage('alignment.object-forms.643')}</p>
      <div className="target-field-row">
        <DateField
          field={{
            id: `${idPrefix}-targetStart`,
            label: uiMessage('alignment.milestone-detail.634'),
            problem: problems.targetStart,
          }}
          value={start}
          onChange={onStart}
        />
        <DateField
          field={{
            id: `${idPrefix}-targetEnd`,
            label: uiMessage('alignment.milestone-detail.635'),
            problem: problems.targetEnd,
          }}
          value={end}
          onChange={onEnd}
        />
      </div>
    </fieldset>
  );
}

/* ───────────────────────── Dialog frame ───────────────────────── */

function FormDialog({
  busy,
  children,
  dirty,
  eyebrow,
  failure,
  messages,
  onClose,
  open,
  save,
  submitLabel,
  summaryRef,
  title,
}: {
  readonly open: boolean;
  readonly eyebrow: string;
  readonly title: string;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly dirty: boolean;
  readonly messages: readonly string[];
  readonly failure: string | null;
  readonly summaryRef: RefObject<HTMLDivElement | null>;
  readonly save: () => Promise<boolean>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  // The guard dialog is a sibling of the form dialog, never nested in it, so Escape in one never
  // reaches the other. It is rendered first: when Discard or Save closes both in one update, the
  // guard closes before the form, and the form then returns focus to the control that opened it.
  const { dialog, guard } = useUnsavedGuard(open && dirty, save);
  const requestClose = (): void => guard(onClose);
  const lines = failure === null ? messages : [...messages, failure];
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    // Before the dialog opens (its effect runs later), focus is still on the control that opened it.
    if (open) {
      opener.current = document.activeElement;
      return;
    }
    // Safety net: when the dialogs close in separate updates, the last one may leave focus nowhere.
    const frame = window.requestAnimationFrame(() => {
      const target = opener.current;
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (lost && target instanceof HTMLElement && target.isConnected) target.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);
  return (
    <>
      {dialog}
      <Modal
        open={open}
        eyebrow={eyebrow}
        title={title}
        className="alignment-dialog"
        onClose={requestClose}
      >
        <form
          className="plan-form alignment-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void save();
          }}
        >
          {lines.length > 0 && (
            <div ref={summaryRef} className="validation-summary" role="alert" tabIndex={-1}>
              <p>
                <strong>{uiMessage('alignment.object-forms.644')}</strong>
              </p>
              <ul>
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {children}
          <div className="dialog-actions">
            <button type="button" onClick={requestClose}>
              {uiMessage('account.account-dialogs.20')}
            </button>
            <button className="primary-button" type="submit" aria-disabled={busy}>
              {busy ? uiMessage('account.conflicts-page.133') : submitLabel}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export interface FormDialogProps<Initial, Preset = never> {
  readonly open: boolean;
  readonly mode: 'create' | 'edit';
  /** The object being edited (edit mode). */
  readonly initial?: Initial;
  /** Relationships a new object starts with (create mode). */
  readonly preset?: Preset;
  readonly runner: CommandRunner;
  readonly onClose: () => void;
  /** Called after the command committed, with the created or edited id. */
  readonly onSaved?: (id: string, receipt: CommandReceipt | null) => void;
}

/* ───────────────────────── Axis ───────────────────────── */

type AxisField = 'title' | 'purpose' | 'color';
const axisFields: readonly AxisField[] = ['title', 'purpose', 'color'];

export type AxisFormInitial = Pick<
  AxisSummary,
  'id' | 'localRevision' | 'title' | 'purpose' | 'color' | 'icon'
>;

export function AxisFormDialog({
  initial,
  mode,
  onClose,
  onSaved,
  open,
  runner,
}: FormDialogProps<AxisFormInitial>): ReactNode {
  const alignment = useAlignment();
  const id = useId();
  const editing = mode === 'edit' ? initial : undefined;
  const state = useDialogForm<
    { title: string; purpose: string; color: string; icon: string },
    AxisField
  >(open, () => ({
    title: editing?.title ?? '',
    purpose: editing?.purpose ?? '',
    color: editing?.color ?? '',
    icon: editing?.icon ?? '',
  }));
  const fieldId = (field: AxisField): string => `${id}-${field}`;
  const { submit, summaryRef } = useFormSubmit(runner, state, fieldId, onClose, onSaved);
  const save = (): Promise<boolean> => {
    const { form } = state;
    return submit({
      order: axisFields,
      problems: {
        title: titleProblem(form.title, alignmentFieldLimits.axisTitle),
        purpose: optionalTextProblem(form.purpose, 'purpose', alignmentFieldLimits.longText),
      },
      success:
        editing === undefined
          ? uiMessage('alignment.axis-overview.450')
          : uiMessage('alignment.object-forms.645'),
      editingId: editing?.id,
      command: () => {
        const input: AxisInput = {
          title: form.title.trim(),
          ...optional('purpose', form.purpose),
          ...(form.color === '' ? {} : { color: form.color }),
          // Editing replaces the stored icon, so the current choice is always sent.
          ...(form.icon === '' ? {} : { icon: form.icon }),
        };
        return editing === undefined
          ? alignment.createAxis(input)
          : alignment.editAxis(
              { kind: 'axis', id: editing.id, revision: editing.localRevision },
              input,
            );
      },
    });
  };
  return (
    <FormDialog
      open={open}
      eyebrow={uiMessage('actions-ui.251')}
      title={
        editing === undefined
          ? uiMessage('alignment.object-forms.646')
          : uiMessage('alignment.object-forms.647')
      }
      submitLabel={
        editing === undefined
          ? uiMessage('alignment.object-forms.648')
          : uiMessage('actions-ui.297')
      }
      busy={runner.busy}
      dirty={state.dirty}
      messages={problemList(axisFields, state.problems)}
      failure={state.failure}
      summaryRef={summaryRef}
      save={save}
      onClose={onClose}
    >
      <TextField
        field={{
          id: fieldId('title'),
          label: uiMessage('alignment.object-forms.649'),
          hint: uiMessage('alignment.object-forms.650', {
            value0: number(alignmentFieldLimits.axisTitle),
          }),
          problem: state.problems.title,
        }}
        maxLength={alignmentFieldLimits.axisTitle}
        value={state.form.title}
        onChange={(value) => state.set('title', value)}
      />
      <TextField
        field={{
          id: fieldId('purpose'),
          label: uiMessage('alignment.axis-detail.413'),
          hint: uiMessage('alignment.object-forms.651'),
          problem: state.problems.purpose,
        }}
        maxLength={alignmentFieldLimits.longText}
        multiline
        value={state.form.purpose}
        onChange={(value) => state.set('purpose', value)}
      />
      <SelectField
        field={{
          id: fieldId('color'),
          label: uiMessage('alignment.axis-detail.415'),
          hint: uiMessage('alignment.object-forms.652'),
          problem: state.problems.color,
        }}
        value={state.form.color}
        options={[
          { value: '', label: uiMessage('alignment.object-forms.653') },
          ...axisColorTokens.map((entry) => ({ value: entry.token, label: entry.label })),
        ]}
        onChange={(value) => state.set('color', value)}
      />
      <AxisIconField
        idPrefix={id}
        title={state.form.title}
        value={state.form.icon}
        current={editing?.icon}
        onChange={(value) => state.set('icon', value)}
      />
    </FormDialog>
  );
}

/**
 * Icon choice for an Axis: "No icon" or one of the catalog icons, each with its picture. An icon
 * name this version does not know stays selectable as the current icon, so saving never drops it.
 */
function AxisIconField({
  current,
  idPrefix,
  onChange,
  title,
  value,
}: {
  readonly current: string | undefined;
  readonly idPrefix: string;
  readonly onChange: (value: string) => void;
  readonly title: string;
  readonly value: string;
}): ReactNode {
  const hintId = `${idPrefix}-icon-hint`;
  const options: readonly { readonly value: string; readonly label: string }[] = [
    { value: '', label: uiMessage('alignment.object-forms.654') },
    ...axisIcons.map((entry) => ({ value: entry.name, label: entry.label })),
    ...(current !== undefined && axisIconEntry(current) === undefined
      ? [{ value: current, label: uiMessage('alignment.object-forms.655') }]
      : []),
  ];
  return (
    <fieldset className="choice-fieldset axis-icon-choices" aria-describedby={hintId}>
      <legend>{uiMessage('alignment.axis-detail.416')}</legend>
      <p id={hintId} className="field-help">
        {uiMessage('alignment.object-forms.656')}
      </p>
      {options.map((option) => (
        <label key={option.value} className="radio-option axis-icon-option">
          <input
            type="radio"
            name={`${idPrefix}-icon`}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <AxisIcon
            {...(option.value === '' ? {} : { icon: option.value })}
            title={title === '' ? uiMessage('actions-ui.251') : title}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/* ───────────────────────── Outcome ───────────────────────── */

type OutcomeField = 'title' | 'successDefinition' | 'axisId' | 'targetStart' | 'targetEnd';
const outcomeFields: readonly OutcomeField[] = [
  'title',
  'successDefinition',
  'axisId',
  'targetStart',
  'targetEnd',
];

export type OutcomeFormInitial = Pick<
  OutcomeItem,
  'id' | 'localRevision' | 'title' | 'successDefinition' | 'targetStart' | 'targetEnd'
>;
export interface OutcomeFormPreset {
  /** Create the Outcome inside this Axis. */
  readonly axisId?: string;
}

export function OutcomeFormDialog({
  initial,
  mode,
  onClose,
  onSaved,
  open,
  preset,
  runner,
}: FormDialogProps<OutcomeFormInitial, OutcomeFormPreset>): ReactNode {
  const alignment = useAlignment();
  const id = useId();
  const editing = mode === 'edit' ? initial : undefined;
  const axes = useChoices(open, 'axis', editing === undefined);
  const state = useDialogForm<
    {
      title: string;
      successDefinition: string;
      axisId: string;
      targetStart: string;
      targetEnd: string;
    },
    OutcomeField
  >(open, () => ({
    title: editing?.title ?? '',
    successDefinition: editing?.successDefinition ?? '',
    axisId: editing === undefined ? (preset?.axisId ?? '') : '',
    targetStart: editing?.targetStart ?? '',
    targetEnd: editing?.targetEnd ?? '',
  }));
  const fieldId = (field: OutcomeField): string => `${id}-${field}`;
  const { submit, summaryRef } = useFormSubmit(runner, state, fieldId, onClose, onSaved);
  const save = (): Promise<boolean> => {
    const { form } = state;
    return submit({
      order: outcomeFields,
      problems: {
        title: titleProblem(form.title, alignmentFieldLimits.outcomeTitle),
        successDefinition: requiredTextProblem(
          form.successDefinition,
          uiMessage('alignment.object-forms.657'),
          alignmentFieldLimits.longText,
        ),
        ...targetProblems(form.targetStart, form.targetEnd),
      },
      success:
        editing === undefined
          ? uiMessage('alignment.axis-detail.438')
          : uiMessage('alignment.object-forms.658'),
      editingId: editing?.id,
      command: () => {
        const fields = {
          title: form.title.trim(),
          successDefinition: form.successDefinition.trim(),
          ...optional('targetStart', form.targetStart),
          ...optional('targetEnd', form.targetEnd),
        };
        return editing === undefined
          ? alignment.createOutcome({ ...fields, ...optional('axisId', form.axisId) })
          : alignment.editOutcome(
              { kind: 'outcome', id: editing.id, revision: editing.localRevision },
              fields,
            );
      },
    });
  };
  return (
    <FormDialog
      open={open}
      eyebrow={uiMessage('alignment.milestone-detail.607')}
      title={
        editing === undefined
          ? uiMessage('alignment.link-dialogs.596')
          : uiMessage('alignment.object-forms.659')
      }
      submitLabel={
        editing === undefined
          ? uiMessage('alignment.object-forms.660')
          : uiMessage('actions-ui.297')
      }
      busy={runner.busy}
      dirty={state.dirty}
      messages={problemList(outcomeFields, state.problems)}
      failure={state.failure}
      summaryRef={summaryRef}
      save={save}
      onClose={onClose}
    >
      <TextField
        field={{
          id: fieldId('title'),
          label: uiMessage('alignment.object-forms.649'),
          hint: uiMessage('alignment.object-forms.650', {
            value0: number(alignmentFieldLimits.outcomeTitle),
          }),
          problem: state.problems.title,
        }}
        maxLength={alignmentFieldLimits.outcomeTitle}
        value={state.form.title}
        onChange={(value) => state.set('title', value)}
      />
      <TextField
        field={{
          id: fieldId('successDefinition'),
          label: uiMessage('alignment.object-forms.661'),
          hint: uiMessage('alignment.object-forms.662'),
          problem: state.problems.successDefinition,
        }}
        maxLength={alignmentFieldLimits.longText}
        multiline
        value={state.form.successDefinition}
        onChange={(value) => state.set('successDefinition', value)}
      />
      {editing === undefined && (
        <SelectField
          field={{
            id: fieldId('axisId'),
            label: uiMessage('actions-ui.251'),
            hint:
              axes.status === 'error'
                ? uiMessage('alignment.object-forms.663')
                : uiMessage('alignment.object-forms.664'),
            problem: state.problems.axisId,
          }}
          value={state.form.axisId}
          options={choiceOptions(
            uiMessage('alignment.alignment-page.385'),
            axes.choices,
            state.form.axisId,
          )}
          onChange={(value) => state.set('axisId', value)}
        />
      )}
      <TargetFields
        idPrefix={id}
        start={state.form.targetStart}
        end={state.form.targetEnd}
        problems={state.problems}
        onStart={(value) => state.set('targetStart', value)}
        onEnd={(value) => state.set('targetEnd', value)}
      />
    </FormDialog>
  );
}

/* ───────────────────────── Project ───────────────────────── */

type ProjectField =
  | 'title'
  | 'desiredResult'
  | 'description'
  | 'notes'
  | 'axisId'
  | 'primaryOutcomeId'
  | 'state'
  | 'targetStart'
  | 'targetEnd';
const projectFields: readonly ProjectField[] = [
  'title',
  'desiredResult',
  'description',
  'notes',
  'axisId',
  'primaryOutcomeId',
  'state',
  'targetStart',
  'targetEnd',
];

export type ProjectFormInitial = Pick<
  ProjectItem,
  'id' | 'localRevision' | 'title' | 'state' | 'desiredResult' | 'targetStart' | 'targetEnd'
> & { readonly description?: string; readonly notes?: string };
export interface ProjectFormPreset {
  readonly axisId?: string;
  readonly primaryOutcomeId?: string;
}

export function ProjectFormDialog({
  initial,
  mode,
  onClose,
  onSaved,
  open,
  preset,
  runner,
}: FormDialogProps<ProjectFormInitial, ProjectFormPreset>): ReactNode {
  const alignment = useAlignment();
  const id = useId();
  const editing = mode === 'edit' ? initial : undefined;
  const axes = useChoices(open, 'axis', editing === undefined);
  const outcomes = useChoices(open, 'outcome', editing === undefined);
  const state = useDialogForm<
    {
      title: string;
      desiredResult: string;
      description: string;
      notes: string;
      axisId: string;
      primaryOutcomeId: string;
      state: 'idea' | 'active';
      targetStart: string;
      targetEnd: string;
    },
    ProjectField
  >(open, () => ({
    title: editing?.title ?? '',
    desiredResult: editing?.desiredResult ?? '',
    description: editing?.description ?? '',
    notes: editing?.notes ?? '',
    axisId: editing === undefined ? (preset?.axisId ?? '') : '',
    primaryOutcomeId: editing === undefined ? (preset?.primaryOutcomeId ?? '') : '',
    state: 'idea',
    targetStart: editing?.targetStart ?? '',
    targetEnd: editing?.targetEnd ?? '',
  }));
  const fieldId = (field: ProjectField): string => `${id}-${field}`;
  const { submit, summaryRef } = useFormSubmit(runner, state, fieldId, onClose, onSaved);
  // Only an idea can be without a desired result (a Project keeps one once it leaves `idea`).
  const needsResult =
    editing === undefined
      ? state.form.state === 'active'
      : editing.state !== 'idea' && editing.state !== 'archived';
  const save = (): Promise<boolean> => {
    const { form } = state;
    return submit({
      order: projectFields,
      problems: {
        title: titleProblem(form.title, alignmentFieldLimits.projectTitle),
        desiredResult:
          needsResult && form.desiredResult.trim() === ''
            ? editing === undefined
              ? uiMessage('alignment.object-forms.665')
              : uiMessage('alignment.object-forms.666')
            : optionalTextProblem(
                form.desiredResult,
                uiMessage('alignment.object-forms.667'),
                alignmentFieldLimits.longText,
              ),
        description: optionalTextProblem(
          form.description,
          'description',
          alignmentFieldLimits.longText,
        ),
        notes: optionalTextProblem(form.notes, 'notes', alignmentFieldLimits.projectNotes),
        ...targetProblems(form.targetStart, form.targetEnd),
      },
      success:
        editing === undefined
          ? uiMessage('alignment.axis-detail.439')
          : uiMessage('alignment.object-forms.668'),
      editingId: editing?.id,
      command: () => {
        const fields = {
          title: form.title.trim(),
          ...optional('desiredResult', form.desiredResult),
          ...optional('description', form.description),
          ...optional('notes', form.notes),
          ...optional('targetStart', form.targetStart),
          ...optional('targetEnd', form.targetEnd),
        };
        return editing === undefined
          ? alignment.createProject({
              ...fields,
              ...optional('axisId', form.axisId),
              ...optional('primaryOutcomeId', form.primaryOutcomeId),
              state: form.state,
            })
          : alignment.editProject(
              { kind: 'project', id: editing.id, revision: editing.localRevision },
              fields,
            );
      },
    });
  };
  const stateName = `${id}-state`;
  return (
    <FormDialog
      open={open}
      eyebrow={uiMessage('actions-ui.254')}
      title={
        editing === undefined
          ? uiMessage('alignment.object-forms.669')
          : uiMessage('alignment.object-forms.670')
      }
      submitLabel={
        editing === undefined
          ? uiMessage('alignment.object-forms.671')
          : uiMessage('actions-ui.297')
      }
      busy={runner.busy}
      dirty={state.dirty}
      messages={problemList(projectFields, state.problems)}
      failure={state.failure}
      summaryRef={summaryRef}
      save={save}
      onClose={onClose}
    >
      <TextField
        field={{
          id: fieldId('title'),
          label: uiMessage('alignment.object-forms.649'),
          hint: uiMessage('alignment.object-forms.650', {
            value0: number(alignmentFieldLimits.projectTitle),
          }),
          problem: state.problems.title,
        }}
        maxLength={alignmentFieldLimits.projectTitle}
        value={state.form.title}
        onChange={(value) => state.set('title', value)}
      />
      <TextField
        field={{
          id: fieldId('desiredResult'),
          label: uiMessage('alignment.object-forms.672'),
          hint: needsResult
            ? uiMessage('alignment.object-forms.673')
            : uiMessage('alignment.object-forms.674'),
          problem: state.problems.desiredResult,
        }}
        maxLength={alignmentFieldLimits.longText}
        multiline
        rows={2}
        value={state.form.desiredResult}
        onChange={(value) => state.set('desiredResult', value)}
      />
      {editing === undefined && (
        <fieldset className="choice-fieldset">
          <legend>{uiMessage('alignment.object-forms.675')}</legend>
          <label className="radio-option">
            <input
              type="radio"
              name={stateName}
              value="idea"
              checked={state.form.state === 'idea'}
              onChange={() => state.set('state', 'idea')}
            />
            <span>{uiMessage('alignment.object-forms.676')}</span>
          </label>
          <label className="radio-option">
            <input
              type="radio"
              name={stateName}
              value="active"
              checked={state.form.state === 'active'}
              onChange={() => state.set('state', 'active')}
            />
            <span>{uiMessage('alignment.object-forms.677')}</span>
          </label>
        </fieldset>
      )}
      <TextField
        field={{
          id: fieldId('description'),
          label: uiMessage('alignment.object-forms.678'),
          hint: uiMessage('alignment.object-forms.664'),
          problem: state.problems.description,
        }}
        maxLength={alignmentFieldLimits.longText}
        multiline
        rows={2}
        value={state.form.description}
        onChange={(value) => state.set('description', value)}
      />
      <TextField
        field={{
          id: fieldId('notes'),
          label: uiMessage('alignment.object-forms.679'),
          hint: uiMessage('alignment.object-forms.680', {
            value0: number(alignmentFieldLimits.projectNotes),
          }),
          problem: state.problems.notes,
        }}
        maxLength={alignmentFieldLimits.projectNotes}
        multiline
        value={state.form.notes}
        onChange={(value) => state.set('notes', value)}
      />
      {editing === undefined && (
        <>
          <SelectField
            field={{
              id: fieldId('axisId'),
              label: uiMessage('actions-ui.251'),
              hint:
                axes.status === 'error'
                  ? uiMessage('alignment.object-forms.663')
                  : uiMessage('alignment.object-forms.664'),
              problem: state.problems.axisId,
            }}
            value={state.form.axisId}
            options={choiceOptions(
              uiMessage('alignment.alignment-page.385'),
              axes.choices,
              state.form.axisId,
            )}
            onChange={(value) => state.set('axisId', value)}
          />
          <SelectField
            field={{
              id: fieldId('primaryOutcomeId'),
              label: uiMessage('alignment.object-forms.681'),
              hint:
                outcomes.status === 'error'
                  ? uiMessage('alignment.object-forms.682')
                  : uiMessage('alignment.object-forms.683'),
              problem: state.problems.primaryOutcomeId,
            }}
            value={state.form.primaryOutcomeId}
            options={choiceOptions(
              uiMessage('alignment.object-forms.684'),
              outcomes.choices,
              state.form.primaryOutcomeId,
            )}
            onChange={(value) => state.set('primaryOutcomeId', value)}
          />
        </>
      )}
      <TargetFields
        idPrefix={id}
        start={state.form.targetStart}
        end={state.form.targetEnd}
        problems={state.problems}
        onStart={(value) => state.set('targetStart', value)}
        onEnd={(value) => state.set('targetEnd', value)}
      />
    </FormDialog>
  );
}

/* ───────────────────────── Milestone ───────────────────────── */

type MilestoneField = 'outcomeId' | 'title' | 'measurableCheckpoint' | 'targetStart' | 'targetEnd';
const milestoneFields: readonly MilestoneField[] = [
  'outcomeId',
  'title',
  'measurableCheckpoint',
  'targetStart',
  'targetEnd',
];

export type MilestoneFormInitial = Pick<
  MilestoneItem,
  'id' | 'localRevision' | 'title' | 'measurableCheckpoint' | 'targetStart' | 'targetEnd'
>;
export interface MilestoneFormPreset {
  /** The Outcome that owns the new Milestone. Without it the form offers a choice. */
  readonly outcomeId: string;
  readonly outcomeTitle?: string;
}

export function MilestoneFormDialog({
  initial,
  mode,
  onClose,
  onSaved,
  open,
  preset,
  runner,
}: FormDialogProps<MilestoneFormInitial, MilestoneFormPreset>): ReactNode {
  const alignment = useAlignment();
  const id = useId();
  const editing = mode === 'edit' ? initial : undefined;
  const choosing = editing === undefined && preset === undefined;
  const outcomes = useChoices(open, 'outcome', choosing);
  const state = useDialogForm<
    {
      outcomeId: string;
      title: string;
      measurableCheckpoint: string;
      targetStart: string;
      targetEnd: string;
    },
    MilestoneField
  >(open, () => ({
    outcomeId: preset?.outcomeId ?? '',
    title: editing?.title ?? '',
    measurableCheckpoint: editing?.measurableCheckpoint ?? '',
    targetStart: editing?.targetStart ?? '',
    targetEnd: editing?.targetEnd ?? '',
  }));
  const fieldId = (field: MilestoneField): string => `${id}-${field}`;
  const { submit, summaryRef } = useFormSubmit(runner, state, fieldId, onClose, onSaved);
  const save = (): Promise<boolean> => {
    const { form } = state;
    return submit({
      order: milestoneFields,
      problems: {
        outcomeId:
          editing === undefined && form.outcomeId === ''
            ? uiMessage('alignment.object-forms.685')
            : undefined,
        title: titleProblem(form.title, alignmentFieldLimits.milestoneTitle),
        measurableCheckpoint: requiredTextProblem(
          form.measurableCheckpoint,
          uiMessage('alignment.object-forms.686'),
          alignmentFieldLimits.longText,
        ),
        ...targetProblems(form.targetStart, form.targetEnd),
      },
      success:
        editing === undefined
          ? uiMessage('alignment.object-forms.687')
          : uiMessage('alignment.object-forms.688'),
      editingId: editing?.id,
      command: () => {
        const fields = {
          title: form.title.trim(),
          measurableCheckpoint: form.measurableCheckpoint.trim(),
          ...optional('targetStart', form.targetStart),
          ...optional('targetEnd', form.targetEnd),
        };
        return editing === undefined
          ? alignment.createMilestone({ outcomeId: form.outcomeId, ...fields })
          : alignment.editMilestone(
              { kind: 'milestone', id: editing.id, revision: editing.localRevision },
              fields,
            );
      },
    });
  };
  return (
    <FormDialog
      open={open}
      eyebrow={uiMessage('actions-ui.276')}
      title={
        editing === undefined
          ? uiMessage('alignment.object-forms.689')
          : uiMessage('alignment.object-forms.690')
      }
      submitLabel={
        editing === undefined
          ? uiMessage('alignment.object-forms.691')
          : uiMessage('actions-ui.297')
      }
      busy={runner.busy}
      dirty={state.dirty}
      messages={problemList(milestoneFields, state.problems)}
      failure={state.failure}
      summaryRef={summaryRef}
      save={save}
      onClose={onClose}
    >
      {choosing ? (
        <SelectField
          field={{
            id: fieldId('outcomeId'),
            label: uiMessage('alignment.milestone-detail.607'),
            hint:
              outcomes.status === 'error'
                ? uiMessage('alignment.link-dialogs.594')
                : uiMessage('alignment.object-forms.692'),
            problem: state.problems.outcomeId,
          }}
          value={state.form.outcomeId}
          options={choiceOptions(
            uiMessage('alignment.link-dialogs.597'),
            outcomes.choices,
            state.form.outcomeId,
          )}
          onChange={(value) => state.set('outcomeId', value)}
        />
      ) : (
        editing === undefined &&
        preset?.outcomeTitle !== undefined && (
          <p className="field-help">
            {uiMessage('alignment.object-forms.693', { value0: preset.outcomeTitle })}
          </p>
        )
      )}
      <TextField
        field={{
          id: fieldId('title'),
          label: uiMessage('alignment.object-forms.649'),
          hint: uiMessage('alignment.object-forms.650', {
            value0: number(alignmentFieldLimits.milestoneTitle),
          }),
          problem: state.problems.title,
        }}
        maxLength={alignmentFieldLimits.milestoneTitle}
        value={state.form.title}
        onChange={(value) => state.set('title', value)}
      />
      <TextField
        field={{
          id: fieldId('measurableCheckpoint'),
          label: uiMessage('alignment.object-forms.694'),
          hint: uiMessage('alignment.object-forms.695'),
          problem: state.problems.measurableCheckpoint,
        }}
        maxLength={alignmentFieldLimits.longText}
        multiline
        rows={2}
        value={state.form.measurableCheckpoint}
        onChange={(value) => state.set('measurableCheckpoint', value)}
      />
      <TargetFields
        idPrefix={id}
        start={state.form.targetStart}
        end={state.form.targetEnd}
        problems={state.problems}
        onStart={(value) => state.set('targetStart', value)}
        onEnd={(value) => state.set('targetEnd', value)}
      />
    </FormDialog>
  );
}

/* ───────────────────────── Progress ───────────────────────── */

type ProgressMode = OutcomeProgressInput['mode'];

const progressModes: readonly { readonly mode: ProgressMode; readonly label: string }[] = [
  { mode: 'none', label: uiMessage('alignment.object-forms.696') },
  { mode: 'manual', label: uiMessage('alignment.object-forms.697') },
  { mode: 'milestone_derived', label: uiMessage('alignment.object-forms.698') },
];

/**
 * How an Outcome's progress is shown: no percentage, a manual whole-number percentage, or a count
 * of completed Milestones. Progress never changes the Outcome's state. Read-only when archived.
 */
export function ProgressEditor({
  outcome,
  runner,
}: {
  readonly outcome: OutcomeItem;
  readonly runner: CommandRunner;
}): ReactNode {
  const alignment = useAlignment();
  const id = useId();
  const headingId = `${id}-heading`;
  const inputId = `${id}-percentage`;
  const hintId = `${id}-percentage-hint`;
  const problemId = `${id}-problem`;
  const input = useRef<HTMLInputElement>(null);
  const storedMode = outcome.progress.mode;
  const storedPercentage =
    outcome.progress.mode === 'manual' ? String(outcome.progress.percentage) : '';
  const stored = `${outcome.id}:${String(outcome.localRevision)}:${storedMode}:${storedPercentage}`;
  const [draft, setDraft] = useState<{
    readonly stored: string;
    readonly mode: ProgressMode;
    readonly percentage: string;
    readonly problem: string | null;
  }>({ stored, mode: storedMode, percentage: storedPercentage, problem: null });
  let current = draft;
  if (draft.stored !== stored) {
    // A saved change, an undo, or another edit replaced the stored value: show it.
    current = { stored, mode: storedMode, percentage: storedPercentage, problem: null };
    setDraft(current);
  }
  const archived = outcome.state === 'archived';
  const dirty =
    !archived &&
    (current.mode !== storedMode ||
      (current.mode === 'manual' && current.percentage.trim() !== storedPercentage));
  const save = async (): Promise<boolean> => {
    if (runner.busy) return false;
    if (!dirty) return true;
    let progress: OutcomeProgressInput;
    if (current.mode === 'manual') {
      const text = current.percentage.trim();
      const value = Number(text);
      if (!/^\d{1,3}$/u.test(text) || value > 100) {
        setDraft({ ...current, problem: uiMessage('alignment.object-forms.699') });
        input.current?.focus();
        return false;
      }
      progress = { mode: 'manual', percentage: value };
    } else {
      progress = { mode: current.mode };
    }
    setDraft({ ...current, problem: null });
    const result = await runForReceipt(
      runner,
      () =>
        alignment.setOutcomeProgress(
          { kind: 'outcome', id: outcome.id, revision: outcome.localRevision },
          progress,
        ),
      uiMessage('alignment.object-forms.700'),
    );
    if (!result.ok) {
      setDraft((previous) => ({ ...previous, problem: result.message }));
      if (current.mode === 'manual') input.current?.focus();
      return false;
    }
    return true;
  };
  const { dialog } = useUnsavedGuard(dirty, save);
  return (
    <section className="progress-editor" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('alignment.alignment-page.409')}</h2>
      <p className="progress-current">
        {progressText(outcome.progress, outcome.canceledMilestones)}
      </p>
      {!archived && (
        <form
          className="plan-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {current.problem !== null && (
            <p id={problemId} className="validation-summary" role="alert">
              {current.problem}
            </p>
          )}
          <fieldset className="choice-fieldset">
            <legend>{uiMessage('alignment.object-forms.701')}</legend>
            {progressModes.map((option) => (
              <label className="radio-option" key={option.mode}>
                <input
                  type="radio"
                  name={`${id}-mode`}
                  value={option.mode}
                  checked={current.mode === option.mode}
                  onChange={() => setDraft({ ...current, mode: option.mode, problem: null })}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          {current.mode === 'manual' && (
            <div className="form-field progress-percentage">
              <label htmlFor={inputId}>{uiMessage('alignment.object-forms.702')}</label>
              <p id={hintId} className="field-help">
                {uiMessage('alignment.object-forms.703')}
              </p>
              <input
                ref={input}
                id={inputId}
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={1}
                value={current.percentage}
                aria-invalid={current.problem !== null}
                aria-describedby={current.problem === null ? hintId : `${hintId} ${problemId}`}
                onChange={(event) => setDraft({ ...current, percentage: event.target.value })}
              />
            </div>
          )}
          {current.mode === 'milestone_derived' && (
            <p className="field-help">{uiMessage('alignment.object-forms.704')}</p>
          )}
          <div className="detail-actions">
            <button type="submit" aria-disabled={runner.busy}>
              {uiMessage('alignment.object-forms.705')}
            </button>
          </div>
        </form>
      )}
      {dialog}
    </section>
  );
}
