import { message as uiMessage } from '../messages';
/**
 * Shared parts of the weekly, monthly, and yearly review forms: decision
 * radio groups for Outcomes, Milestones, and Projects, bounded text fields, the notes with their
 * questions, and the Finish review / Save for later / Skip this review actions with the unsaved-
 * changes guard. Every group starts at "Decide later", which changes nothing, and only decisions the
 * object's current state allows are offered. React keeps only the unsaved choices.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { Bounded, ReviewInput, ReviewObjectRow, ReviewView } from '@yelaxis/application';
import {
  reviewLimits,
  reviewObjectState,
  transitionLifecycle,
  type LifecycleState,
  type ReviewDecisionKind,
  type ReviewType,
} from '@yelaxis/domain';

import { stateLabel } from '../alignment/labels';
import { Modal } from '../plan/modal';
import { milestonePath, outcomePath, projectPath } from '../plan/routes';
import { targetWindowText } from '../plan/theme-editor';
import { useUnsavedGuard } from '../plan/unsaved-guard';
import {
  characterCountText,
  objectDecisionWords,
  reviewQuestions,
  type ReviewObjectKind,
} from './review-text';

import './review.css';

/* ───────────────────────── Commands ───────────────────────── */

export type ReviewCommandKind = 'finish' | 'save' | 'skip' | 'undo';

/** The page's review commands, run through its one command runner. */
export interface ReviewCommands {
  /** A command is running or the view is being re-read after one. */
  readonly busy: boolean;
  readonly running: ReviewCommandKind | null;
  /** The application's refusal of the last command, in its own calm words. */
  readonly error: string | null;
  finish(input: ReviewInput): Promise<boolean>;
  save(input: ReviewInput): Promise<boolean>;
  skip(): Promise<boolean>;
}

/** A form's input, or the reason it cannot be sent yet (nothing is sent then). */
export type BuiltInput = { readonly input: ReviewInput } | { readonly problem: string };

/* ───────────────────────── Decisions ───────────────────────── */

/** A decision group's value: "later" is Decide later, which records and changes nothing. */
export type ObjectChoice = 'later' | ReviewDecisionKind;

/**
 * Whether the object's current state allows a decision. `continue` changes nothing and is always
 * allowed; the others use the normal transition rules, so a paused Project is never offered Pause.
 */
export function decisionAvailable(
  kind: ReviewObjectKind,
  state: string,
  decision: ReviewDecisionKind,
): boolean {
  const target = reviewObjectState(kind, decision);
  if (!target.ok) return false;
  if (target.value === null) return true;
  return transitionLifecycle({
    entityType: kind,
    current: { state: state as LifecycleState },
    to: target.value as LifecycleState,
  }).ok;
}

/** "Decide later" and every decision the review offers for this object in its current state. */
export function objectChoices(
  kind: ReviewObjectKind,
  state: string,
  offered?: readonly ReviewDecisionKind[],
): readonly (readonly [ObjectChoice, string])[] {
  return [
    ['later', uiMessage('review.review-form.1940')],
    ...objectDecisionWords[kind].filter(
      ([decision]) =>
        (offered === undefined || offered.includes(decision)) &&
        decisionAvailable(kind, state, decision),
    ),
  ];
}

/** One radio choice per option inside a fieldset whose legend names the group. */
export function ChoiceGroup<Value extends string>({
  children,
  describedBy,
  legend,
  name,
  onChange,
  options,
  value,
}: {
  readonly legend: string;
  readonly name: string;
  readonly options: readonly (readonly [Value, string])[];
  readonly value: Value;
  readonly onChange: (value: Value) => void;
  readonly describedBy?: string;
  /** Facts shown between the legend and the choices. */
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <fieldset
      className="review-fieldset"
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
    >
      <legend>{legend}</legend>
      {children}
      <div className="review-choices">
        {options.map(([option, label]) => (
          <label key={option} className="review-choice">
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const objectPath = (row: ReviewObjectRow): string =>
  row.kind === 'outcome'
    ? outcomePath(row.id)
    : row.kind === 'milestone'
      ? milestonePath(row.id)
      : projectPath(row.id);

/** The state, Axis or parent Outcome, and target window of an object, in words. */
export function objectFacts(row: ReviewObjectRow): string {
  const parts = [stateLabel(row.kind, row.state)];
  if (row.context !== undefined)
    parts.push(row.kind === 'milestone' ? `Outcome: ${row.context}` : `Axis: ${row.context}`);
  if (row.targetStart !== undefined || row.targetEnd !== undefined)
    parts.push(targetWindowText(row.targetStart, row.targetEnd));
  return parts.join(' · ');
}

/** One object with its decision group and a link to its page. */
export function ObjectDecision({
  choice,
  extra,
  kind,
  offered,
  onChoice,
  row,
}: {
  readonly kind: ReviewObjectKind;
  readonly row: ReviewObjectRow;
  readonly choice: ObjectChoice;
  readonly onChoice: (choice: ObjectChoice) => void;
  readonly offered?: readonly ReviewDecisionKind[];
  /** More facts under the state line, such as a Project's next Action. */
  readonly extra?: string;
}): ReactNode {
  const id = useId();
  const factsId = `${id}-facts`;
  const extraId = `${id}-extra`;
  return (
    <li className="review-item">
      <ChoiceGroup
        legend={row.title}
        name={`${id}-choice`}
        options={objectChoices(kind, row.state, offered)}
        value={choice}
        onChange={onChoice}
        describedBy={extra === undefined ? factsId : `${factsId} ${extraId}`}
      >
        <p id={factsId} className="review-facts">
          {objectFacts(row)}
        </p>
        {extra !== undefined && (
          <p id={extraId} className="review-facts">
            {extra}
          </p>
        )}
      </ChoiceGroup>
      <Link
        className="review-item-link"
        to={objectPath(row)}
        aria-label={uiMessage('review.review-form.1941', { value0: row.title })}
      >
        {uiMessage('review.review-form.1942')}
      </Link>
    </li>
  );
}

/** A titled list of objects with decisions, or a calm empty line. */
export function ObjectDecisionSection({
  choices,
  empty,
  help,
  kind,
  offered,
  onChoice,
  rows,
  title,
}: {
  readonly title: string;
  readonly help: string;
  readonly empty: string;
  readonly kind: ReviewObjectKind;
  readonly rows: Bounded<ReviewObjectRow>;
  readonly choices: Readonly<Record<string, ObjectChoice>>;
  readonly onChoice: (id: string, choice: ObjectChoice) => void;
  readonly offered?: readonly ReviewDecisionKind[];
}): ReactNode {
  const headingId = useId();
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {rows.items.length === 0 ? (
        <p className="quiet-empty">{empty}</p>
      ) : (
        <>
          <p className="field-help">{help}</p>
          <ul className="review-items" aria-label={title}>
            {rows.items.map((row) => (
              <ObjectDecision
                key={row.id}
                kind={kind}
                row={row}
                choice={choices[row.id] ?? 'later'}
                onChoice={(choice) => onChoice(row.id, choice)}
                {...(offered === undefined ? {} : { offered })}
              />
            ))}
          </ul>
          {rows.total > rows.items.length && (
            <p className="field-help">
              {uiMessage('review.review-form.1943', {
                value0: String(rows.items.length),
                value1: String(rows.total),
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Saved object decisions of one kind, by id, for a resumed draft. */
export function savedObjectChoices(
  view: ReviewView,
  kind: ReviewObjectKind,
  offered: readonly ReviewDecisionKind[],
): Readonly<Record<string, ObjectChoice>> {
  const choices: Record<string, ObjectChoice> = {};
  for (const item of view.saved?.items ?? [])
    if (item.target.kind === kind && offered.includes(item.decision))
      choices[item.target.id] = item.decision;
  return choices;
}

/** The chosen decisions as command input: "Decide later" is simply not listed. */
export function objectDecisionInput(
  rows: Bounded<ReviewObjectRow>,
  choices: Readonly<Record<string, ObjectChoice>>,
): { readonly id: string; readonly revision: number; readonly decision: ReviewDecisionKind }[] {
  return rows.items.flatMap((row) => {
    const choice = choices[row.id];
    return choice === undefined || choice === 'later'
      ? []
      : [{ id: row.id, revision: row.localRevision, decision: choice }];
  });
}

/**
 * Two sets of decisions save the same: only the listed objects' decisions are sent, and "Decide
 * later" is not (a saved decision about an object no longer listed is dropped by the next Save).
 */
export function sameChoices(
  rows: Bounded<{ readonly id: string }>,
  left: Readonly<Record<string, ObjectChoice>>,
  right: Readonly<Record<string, ObjectChoice>>,
): boolean {
  return rows.items.every((row) => (left[row.id] ?? 'later') === (right[row.id] ?? 'later'));
}

/* ───────────────────────── Text ───────────────────────── */

/**
 * A labelled text area with its limit stated. Longer text is kept exactly as written and refused
 * on Finish or Save (never cut short); the count says how far over it is.
 */
export function BoundedTextField({
  describedBy,
  help,
  label,
  limit,
  onChange,
  rows = 4,
  value,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly limit: number;
  readonly help?: string;
  /** Other descriptions, such as the questions shown as prompts. */
  readonly describedBy?: string;
  readonly rows?: number;
}): ReactNode {
  const id = useId();
  const helpId = `${id}-help`;
  const countId = `${id}-count`;
  const over = value.length > limit;
  const described = [
    ...(describedBy === undefined ? [] : [describedBy]),
    ...(help === undefined ? [] : [helpId]),
    countId,
  ].join(' ');
  return (
    <div className="review-field">
      <label htmlFor={id}>{label}</label>
      {help !== undefined && (
        <p id={helpId} className="field-help">
          {help}
        </p>
      )}
      <textarea
        id={id}
        rows={rows}
        value={value}
        aria-invalid={over ? true : undefined}
        aria-describedby={described}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={countId} className={over ? 'field-help review-count over' : 'field-help review-count'}>
        {over
          ? uiMessage('review.review-form.1944', {
              value0: characterCountText(value.length, limit),
              value1: (value.length - limit).toLocaleString('en-US'),
            })
          : characterCountText(value.length, limit)}
      </p>
    </div>
  );
}

/** The review's notes, with the product questions shown as prompts (never scored). */
export function NotesSection({
  onChange,
  type,
  value,
}: {
  readonly type: Exclude<ReviewType, 'daily'>;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const headingId = useId();
  const promptsId = useId();
  const title =
    type === 'yearly'
      ? uiMessage('review.review-form.1945')
      : uiMessage('alignment.object-forms.679');
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <div id={promptsId} className="review-prompts">
        <p>{uiMessage('review.review-form.1946')}</p>
        <ul>
          {reviewQuestions[type].map((question) => (
            <li key={question}>{question}</li>
          ))}
        </ul>
      </div>
      <BoundedTextField
        label={`${title} (optional)`}
        value={value}
        onChange={onChange}
        limit={reviewLimits.notes}
        rows={type === 'yearly' ? 8 : 5}
        describedBy={promptsId}
      />
    </section>
  );
}

/** The notes as input: blank notes are left out. Longer than the limit is refused. */
export function notesProblem(notes: string, label: string): string | null {
  return notes.length > reviewLimits.notes
    ? uiMessage('review.review-form.1947', {
        value0: label,
        value1: reviewLimits.notes.toLocaleString('en-US'),
      })
    : null;
}

/* ───────────────────────── The form ───────────────────────── */

interface Problem {
  readonly text: string;
  readonly key: number;
}

/**
 * What the form held and had read when its last command succeeded, until the page reads the review
 * again. Each value is compared by identity: a form replaces its choices on every change, and the
 * page replaces the saved review on every read.
 */
interface SettledCommand {
  readonly draft: unknown;
  readonly saved: unknown;
}

/**
 * Whether the form still shows exactly what its last successful command sent, and the page has not
 * read the review again since. Finish and Save then saved these choices, and a Skip without saving
 * discarded them on purpose, so nothing is unsaved, even though the comparison with the saved review
 * still sees the previous save: the page shows a command's result a moment before its re-read
 * arrives, and a reload or a link in that moment must not ask to save again.
 */
function isSettled(settled: SettledCommand | null, draft: unknown, saved: unknown): boolean {
  return settled !== null && settled.draft === draft && settled.saved === saved;
}

/**
 * The review form: its sections, then any refusal, then Finish review (the form's submit), Save for
 * later, and Skip this review. Leaving with unsaved changes asks first (Save saves a draft). Skip
 * with unsaved changes asks first too, because skipping keeps only what was saved.
 */
export function ReviewFormFrame({
  build,
  children,
  commands,
  dirty,
  draft,
  saved,
  skipped,
}: {
  readonly commands: ReviewCommands;
  readonly build: () => BuiltInput;
  /** The choices differ from the saved review as the page last read it. */
  readonly dirty: boolean;
  /** The form's current choices: a new value whenever a choice changes. */
  readonly draft: unknown;
  /** The saved review as the page last read it: a new value whenever it is read again. */
  readonly saved: unknown;
  /** The review is skipped: it can be finished or saved again, not skipped again. */
  readonly skipped: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const [problem, setProblemState] = useState<Problem | null>(null);
  const [errorFocus, setErrorFocus] = useState(0);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [settled, setSettled] = useState<SettledCommand | null>(null);
  const unsaved = dirty && !isSettled(settled, draft, saved);
  const problemRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const setProblem = (text: string | null): void =>
    setProblemState((current) => (text === null ? null : { text, key: (current?.key ?? 0) + 1 }));
  // A refusal moves focus to its reason once it is rendered.
  useEffect(() => {
    if (problem !== null) problemRef.current?.focus();
  }, [problem]);
  useEffect(() => {
    if (errorFocus > 0) errorRef.current?.focus();
  }, [errorFocus]);

  const send = async (kind: 'finish' | 'save'): Promise<boolean> => {
    if (commands.busy) return false;
    const built = build();
    if ('problem' in built) {
      setProblem(built.problem);
      return false;
    }
    setProblem(null);
    const sent: SettledCommand = { draft, saved };
    const done =
      kind === 'finish' ? await commands.finish(built.input) : await commands.save(built.input);
    if (done) setSettled(sent);
    else setErrorFocus((value) => value + 1);
    return done;
  };
  const skip = async (): Promise<void> => {
    setConfirmSkip(false);
    if (commands.busy) return;
    setProblem(null);
    const sent: SettledCommand = { draft, saved };
    const done = await commands.skip();
    if (done) setSettled(sent);
    else setErrorFocus((value) => value + 1);
  };
  const guard = useUnsavedGuard(unsaved, () => send('save'));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void send('finish');
  };

  return (
    <>
      <form className="review-form" noValidate onSubmit={submit}>
        {children}
        {problem !== null && (
          <p
            key={problem.key}
            ref={problemRef}
            className="validation-summary"
            role="alert"
            tabIndex={-1}
          >
            {problem.text}
          </p>
        )}
        {commands.error !== null && (
          <p ref={errorRef} className="validation-summary" role="alert" tabIndex={-1}>
            {commands.error}
          </p>
        )}
        <div className="review-actions">
          <button
            type="submit"
            className="primary-button"
            aria-disabled={commands.busy ? true : undefined}
          >
            {commands.running === 'finish'
              ? uiMessage('review.review-form.1948')
              : uiMessage('review.review-form.1949')}
          </button>
          <button
            type="button"
            aria-disabled={commands.busy ? true : undefined}
            onClick={() => void send('save')}
          >
            {commands.running === 'save'
              ? uiMessage('account.conflicts-page.133')
              : uiMessage('review.review-form.1950')}
          </button>
          {!skipped && (
            <button
              type="button"
              aria-disabled={commands.busy ? true : undefined}
              onClick={() => {
                if (commands.busy) return;
                if (unsaved) setConfirmSkip(true);
                else void skip();
              }}
            >
              {uiMessage('review.review-form.1951')}
            </button>
          )}
        </div>
        <p className="field-help">{uiMessage('review.review-form.1952')}</p>
      </form>
      {guard.dialog}
      <Modal
        open={confirmSkip}
        eyebrow={uiMessage('plan.occurrence-controls.1243')}
        title={uiMessage('review.review-form.1953')}
        onClose={() => setConfirmSkip(false)}
      >
        <p>{uiMessage('review.review-form.1954')}</p>
        <div className="dialog-actions">
          <button type="button" data-autofocus onClick={() => setConfirmSkip(false)}>
            {uiMessage('plan.unsaved-guard.1889')}
          </button>
          <button type="button" className="primary-button" onClick={() => void skip()}>
            {uiMessage('review.review-form.1955')}
          </button>
        </div>
      </Modal>
    </>
  );
}
