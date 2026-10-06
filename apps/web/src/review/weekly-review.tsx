import { message as uiMessage } from '../messages';
/**
 * The weekly review form: the reviewed week plan-scoped like End Day,
 * the Inbox, active and blocked Projects (Continue or Pause), what supported each Axis, the planning
 * Week's capacity and fixed work, up to three commitments, and the first day's focus. Nothing is
 * ranked or chosen for the person; decisions stay drafts until Finish review.
 */
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type {
  ActionSummary,
  Bounded,
  FocusTargetInput,
  ReviewView,
  WeekSelectionRow,
  WeeklyReviewContext,
  WeeklyReviewInput,
} from '@yelaxis/application';
import { dayFocusLimit, reviewLimits, type ReviewDecisionKind } from '@yelaxis/domain';

import { CapacitySummary } from '../plan/capacity-summary';
import { formatDate } from '../plan/format';
import { usePlanning, usePlanQuery } from '../plan/planning-context';
import { actionPath, planPath, projectPath } from '../plan/routes';
import { entryKindLabel, entryTimeText } from '../plan/timeline';
import { FocusDraftEditor, focusDraftOf, type FocusDraftItem } from '../today/choose-focus-dialog';
import {
  commitmentDetail,
  commitmentKey,
  CommitmentsEditor,
  type CommitmentChoice,
} from './commitments-editor';
import {
  focusDraftFromSaved,
  hasText,
  isClearedList,
  itemsBySlot,
  sameKeys,
  sameStoredKeys,
  storedKeys,
  storedText,
} from './review-draft';
import {
  BoundedTextField,
  ChoiceGroup,
  NotesSection,
  notesProblem,
  objectChoices,
  objectFacts,
  sameChoices,
  savedObjectChoices,
  type BuiltInput,
  type ObjectChoice,
  type ReviewCommands,
  ReviewFormFrame,
} from './review-form';
import { dayWords, weekRangeWords } from './review-text';

type WeeklyView = Extract<ReviewView, { readonly type: 'weekly' }>;

const projectDecisions: readonly ReviewDecisionKind[] = ['continue', 'pause'];

interface WeeklyDraft {
  readonly notes: string;
  readonly projects: Readonly<Record<string, ObjectChoice>>;
  readonly axisNotes: Readonly<Record<string, string>>;
  readonly commitments: readonly CommitmentChoice[];
  readonly focus: readonly FocusDraftItem[];
}

const selectionChoice = (row: WeekSelectionRow): CommitmentChoice => ({
  kind: row.target.kind,
  id: row.target.id,
  title: row.target.title,
  detail: commitmentDetail(row.target.kind, row.target.state),
});

/**
 * The choices a form starts from: the saved draft, or the plan as it is (nothing preselected). Each
 * ordered list starts from its saved items if any, else from no items when the draft cleared it,
 * else from the plan's current list.
 */
function draftFrom(view: WeeklyView, context: WeeklyReviewContext): WeeklyDraft {
  const items = view.saved?.items ?? [];
  const slots = itemsBySlot(items);
  const axisNotes: Record<string, string> = {};
  for (const item of slots.note)
    if (item.target.kind === 'axis' && item.note !== undefined)
      axisNotes[item.target.id] = item.note;
  const savedCommitments = slots.commit.flatMap((item): CommitmentChoice[] => {
    const target = item.target;
    return target.kind === 'action' || target.kind === 'project' || target.kind === 'milestone'
      ? [{ kind: target.kind, id: target.id, title: target.title }]
      : [];
  });
  return {
    notes: view.saved?.notes ?? '',
    projects: savedObjectChoices(view, 'project', projectDecisions),
    axisNotes,
    commitments:
      slots.commit.length > 0
        ? savedCommitments
        : isClearedList(view.saved, 'commitments')
          ? []
          : context.commitments.map(selectionChoice),
    focus:
      focusDraftFromSaved(view.saved, 'first_day_focus', context.firstDayFocus) ??
      focusDraftOf(context.firstDayFocus),
  };
}

/** Whether two drafts would save the same review (see `storedKeys` and `storedText`). */
function sameDraft(context: WeeklyReviewContext, left: WeeklyDraft, right: WeeklyDraft): boolean {
  const planCommitments = context.commitments.map((row) => commitmentKey(selectionChoice(row)));
  const planFocus = context.firstDayFocus.current.map((item) => item.key);
  const commitments = (draft: WeeklyDraft) =>
    storedKeys(draft.commitments.map(commitmentKey), planCommitments);
  const focus = (draft: WeeklyDraft) =>
    storedKeys(
      draft.focus.map((item) => item.key),
      planFocus,
    );
  const axisNote = (draft: WeeklyDraft, axisId: string): string =>
    storedText(draft.axisNotes[axisId] ?? '');
  return (
    storedText(left.notes) === storedText(right.notes) &&
    sameChoices(context.projects, left.projects, right.projects) &&
    context.axes.items.every((axis) => axisNote(left, axis.id) === axisNote(right, axis.id)) &&
    sameStoredKeys(commitments(left), commitments(right)) &&
    sameStoredKeys(focus(left), focus(right))
  );
}

function buildInput(
  view: WeeklyView,
  context: WeeklyReviewContext,
  draft: WeeklyDraft,
): BuiltInput {
  const notes = notesProblem(draft.notes, uiMessage('review.monthly-review.1924'));
  if (notes !== null) return { problem: notes };
  for (const axis of context.axes.items) {
    const note = draft.axisNotes[axis.id] ?? '';
    if (note.length > reviewLimits.itemNote)
      return {
        problem: uiMessage('review.weekly-review.2025', {
          value0: axis.title,
          value1: reviewLimits.itemNote.toLocaleString('en-US'),
        }),
      };
  }
  if (draft.commitments.length > reviewLimits.commitments)
    return { problem: uiMessage('review.weekly-review.2026') };
  if (draft.focus.length > dayFocusLimit)
    return { problem: uiMessage('review.weekly-review.2027') };
  const projects = context.projects.items.flatMap((row) => {
    const choice = draft.projects[row.id];
    return choice === undefined || choice === 'later'
      ? []
      : [{ id: row.id, revision: row.localRevision, decision: choice }];
  });
  const axisNotes = context.axes.items.flatMap((axis) => {
    const note = draft.axisNotes[axis.id] ?? '';
    return hasText(note) ? [{ axisId: axis.id, note }] : [];
  });
  const commitmentsChanged = !sameKeys(
    draft.commitments.map(commitmentKey),
    context.commitments.map((row) => commitmentKey(selectionChoice(row))),
  );
  const focusChanged = !sameKeys(
    draft.focus.map((item) => item.key),
    context.firstDayFocus.current.map((item) => item.key),
  );
  const firstDayFocus: FocusTargetInput[] = draft.focus.map((item) => item.target);
  const input: WeeklyReviewInput = {
    type: 'weekly',
    periodKey: view.period.key,
    ...(view.saved === null ? {} : { revision: view.saved.localRevision }),
    ...(hasText(draft.notes) ? { notes: draft.notes } : {}),
    projects,
    axisNotes,
    ...(commitmentsChanged
      ? { commitments: draft.commitments.map(({ id, kind }) => ({ kind, id })) }
      : {}),
    ...(focusChanged ? { firstDayFocus } : {}),
  };
  return { input };
}

export function WeeklyReviewForm({
  commands,
  context,
  view,
}: {
  readonly view: WeeklyView;
  readonly context: WeeklyReviewContext;
  readonly commands: ReviewCommands;
}): ReactNode {
  const idBase = useId();
  const [draft, setDraft] = useState(() => draftFrom(view, context));
  // What is saved now (re-read after every command), so Save leaves nothing unsaved.
  const dirty = !sameDraft(context, draft, draftFrom(view, context));
  const update = (change: Partial<WeeklyDraft>): void =>
    setDraft((current) => ({ ...current, ...change }));
  const weekWords = weekRangeWords(
    context.planningWeek.start,
    context.planningWeek.end,
    view.today,
  );
  const firstDay = dayWords(context.firstDayFocus.date);
  return (
    <ReviewFormFrame
      commands={commands}
      build={() => buildInput(view, context, draft)}
      dirty={dirty}
      draft={draft}
      saved={view.saved}
      skipped={view.saved?.state === 'skipped'}
    >
      <p className="review-intro">{uiMessage('review.weekly-review.2028')}</p>
      <LookBack view={view} context={context} />
      <InboxSection count={context.inboxCount} />
      <ProjectsSection
        context={context}
        choices={draft.projects}
        onChoice={(id, choice) => update({ projects: { ...draft.projects, [id]: choice } })}
      />
      <AxesSection
        context={context}
        notes={draft.axisNotes}
        onNote={(id, note) => update({ axisNotes: { ...draft.axisNotes, [id]: note } })}
      />
      <WeekAhead view={view} context={context} />
      <section className="review-section" aria-labelledby={`${idBase}-commitments`}>
        <h2 id={`${idBase}-commitments`}>{uiMessage('plan.plan-month.1321')}</h2>
        <p className="field-help">
          {uiMessage('review.weekly-review.2029', { value0: weekWords })}
        </p>
        <CommitmentsEditor
          candidates={context.commitmentCandidates}
          value={draft.commitments}
          onChange={(commitments) => update({ commitments })}
          idPrefix={`${idBase}-commitment`}
        />
      </section>
      <section className="review-section" aria-labelledby={`${idBase}-focus`}>
        <h2 id={`${idBase}-focus`}>
          {uiMessage('review.weekly-review.2030', { value0: firstDay })}
        </h2>
        <p className="field-help">{uiMessage('review.weekly-review.2031', { value0: firstDay })}</p>
        <FocusDraftEditor
          choices={context.firstDayFocus}
          value={draft.focus}
          onChange={(focus) => update({ focus })}
          idPrefix={`${idBase}-focus-draft`}
        />
      </section>
      <NotesSection type="weekly" value={draft.notes} onChange={(notes) => update({ notes })} />
    </ReviewFormFrame>
  );
}

/* ───────────────────────── Sections ───────────────────────── */

const openStateWords: Partial<Record<ActionSummary['state'], string>> = {
  inbox: uiMessage('review.weekly-review.2032'),
  in_progress: uiMessage('plan.scheduling-dialogs.1621'),
  scheduled: uiMessage('plan.theme-editor.1865'),
};

function ActionList({
  actions,
  empty,
  label,
  open,
}: {
  readonly actions: Bounded<ActionSummary>;
  readonly label: string;
  readonly empty: string;
  readonly open: boolean;
}): ReactNode {
  if (actions.items.length === 0) return <p className="quiet-empty">{empty}</p>;
  return (
    <>
      <ul className="review-plain-list" aria-label={label}>
        {actions.items.map((action) => {
          const state = open ? openStateWords[action.state] : undefined;
          return (
            <li key={action.id}>
              <Link to={actionPath(action.id)}>{action.title}</Link>
              {state !== undefined && <span className="review-facts">{` · ${state}`}</span>}
            </li>
          );
        })}
      </ul>
      {actions.total > actions.items.length && (
        <p className="field-help">
          {uiMessage('review.review-overview.1964', {
            value0: String(actions.items.length),
            value1: String(actions.total),
          })}
        </p>
      )}
    </>
  );
}

function LookBack({
  context,
  view,
}: {
  readonly view: WeeklyView;
  readonly context: WeeklyReviewContext;
}): ReactNode {
  const headingId = useId();
  const week = weekRangeWords(view.period.start, view.period.end, view.today);
  const { completed, skipped } = context.routines;
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('review.weekly-review.2033')}</h2>
      <div className="review-columns">
        <div>
          <h3>{uiMessage('review.weekly-review.2034', { value0: String(context.done.total) })}</h3>
          <ActionList
            actions={context.done}
            label={uiMessage('review.weekly-review.2035', { value0: week })}
            empty={uiMessage('review.weekly-review.2036')}
            open={false}
          />
        </div>
        <div>
          <h3>{uiMessage('review.weekly-review.2037', { value0: String(context.open.total) })}</h3>
          <ActionList
            actions={context.open}
            label={uiMessage('review.weekly-review.2038', { value0: week })}
            empty={uiMessage('review.weekly-review.2039')}
            open
          />
        </div>
      </div>
      <p>
        {completed === 0 && skipped === 0
          ? uiMessage('review.weekly-review.2040')
          : uiMessage('review.weekly-review.2041', {
              value0: String(completed),
              value1: String(skipped),
            })}
      </p>
      {context.open.total > 0 && (
        <p>
          <Link to={planPath('week', context.planningWeek.start)}>
            {uiMessage('review.weekly-review.2042')}
          </Link>
        </p>
      )}
    </section>
  );
}

function InboxSection({ count }: { readonly count: number }): ReactNode {
  const headingId = useId();
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('actions-ui.230')}</h2>
      <p>
        {count === 0
          ? uiMessage('review.weekly-review.2043')
          : uiMessage('review.weekly-review.2044', {
              value0: String(count),
              value1:
                count === 1
                  ? uiMessage('review.weekly-review.2479')
                  : uiMessage('review.weekly-review.2480'),
            })}
      </p>
      <p>
        <Link to="/inbox">{uiMessage('review.weekly-review.2045')}</Link>
      </p>
    </section>
  );
}

function ProjectsSection({
  choices,
  context,
  onChoice,
}: {
  readonly context: WeeklyReviewContext;
  readonly choices: Readonly<Record<string, ObjectChoice>>;
  readonly onChoice: (id: string, choice: ObjectChoice) => void;
}): ReactNode {
  const headingId = useId();
  const idBase = useId();
  const { items, total } = context.projects;
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('alignment.axis-detail.429')}</h2>
      {items.length === 0 ? (
        <p className="quiet-empty">{uiMessage('review.weekly-review.2046')}</p>
      ) : (
        <>
          <p className="field-help">{uiMessage('review.weekly-review.2047')}</p>
          <ul className="review-items" aria-label={uiMessage('alignment.axis-detail.429')}>
            {items.map((project, index) => {
              const id = `${idBase}-${String(index)}`;
              return (
                <li key={project.id} className="review-item">
                  <ChoiceGroup
                    legend={project.title}
                    name={`${id}-choice`}
                    options={objectChoices('project', project.state, projectDecisions)}
                    value={choices[project.id] ?? 'later'}
                    onChange={(choice) => onChoice(project.id, choice)}
                    describedBy={uiMessage('review.weekly-review.2048', { value0: id, value1: id })}
                  >
                    <p id={`${id}-facts`} className="review-facts">
                      {objectFacts(project)}
                    </p>
                    <p id={`${id}-next`} className="review-facts">
                      {project.nextAction === undefined
                        ? uiMessage('review.weekly-review.2049')
                        : uiMessage('review.weekly-review.2050', {
                            value0: project.nextAction.title,
                          })}
                    </p>
                  </ChoiceGroup>
                  <Link
                    className="review-item-link"
                    to={projectPath(project.id)}
                    aria-label={uiMessage('review.review-form.1941', { value0: project.title })}
                  >
                    {uiMessage('review.review-form.1942')}
                  </Link>
                </li>
              );
            })}
          </ul>
          {total > items.length && (
            <p className="field-help">
              {uiMessage('review.review-form.1943', {
                value0: String(items.length),
                value1: String(total),
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function AxesSection({
  context,
  notes,
  onNote,
}: {
  readonly context: WeeklyReviewContext;
  readonly notes: Readonly<Record<string, string>>;
  readonly onNote: (axisId: string, note: string) => void;
}): ReactNode {
  const headingId = useId();
  const { items, total } = context.axes;
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('alignment.alignment-page.384')}</h2>
      {items.length === 0 ? (
        <p className="quiet-empty">{uiMessage('review.weekly-review.2051')}</p>
      ) : (
        <>
          <p className="field-help">{uiMessage('review.weekly-review.2052')}</p>
          {items.map((axis) => (
            <BoundedTextField
              key={axis.id}
              label={uiMessage('review.weekly-review.2053', { value0: axis.title })}
              value={notes[axis.id] ?? ''}
              onChange={(note) => onNote(axis.id, note)}
              limit={reviewLimits.itemNote}
              rows={2}
            />
          ))}
          {total > items.length && (
            <p className="field-help">
              {uiMessage('review.weekly-review.2054', {
                value0: String(items.length),
                value1: String(total),
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** The planning Week's capacity and fixed work, read from the planning Week plan. */
function WeekAhead({
  context,
  view,
}: {
  readonly view: WeeklyView;
  readonly context: WeeklyReviewContext;
}): ReactNode {
  const planning = usePlanning();
  const headingId = useId();
  const week = context.planningWeek;
  const { state, reload } = usePlanQuery(() => planning.getWeekPlan(week.start), [week.start]);
  const current = week.start <= view.today && view.today <= week.end;
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {current ? uiMessage('plan.plan-month.1315') : uiMessage('review.weekly-review.2055')}
      </h2>
      <p>
        {uiMessage('plan.plan-month.1314', {
          value0: weekRangeWords(week.start, week.end, view.today),
        })}
      </p>
      {state.status === 'loading' && <p role="status">{uiMessage('review.weekly-review.2056')}</p>}
      {state.status === 'error' && (
        <div className="validation-summary" role="alert">
          <p>{uiMessage('review.weekly-review.2057')}</p>
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <h3>{uiMessage('review.weekly-review.2058')}</h3>
          <CapacitySummary capacity={state.data.capacity} />
          <h3>{uiMessage('review.weekly-review.2059')}</h3>
          {state.data.fixed.length === 0 ? (
            <p className="quiet-empty">{uiMessage('review.weekly-review.2060')}</p>
          ) : (
            <ul className="review-plain-list" aria-label={uiMessage('review.weekly-review.2061')}>
              {state.data.fixed.map((entry) => (
                <li key={entry.key}>
                  <span className="review-plain-title">{entry.title}</span>
                  <span className="review-facts">
                    {` · ${formatDate(entry.localDate, 'weekday')} ${entryTimeText(
                      entry,
                      entry.localDate,
                      state.data.profile.timeFormat,
                    )} · ${entryKindLabel(entry)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p>
        <Link to={planPath('week', week.start)}>{uiMessage('review.weekly-review.2062')}</Link>
      </p>
    </section>
  );
}
