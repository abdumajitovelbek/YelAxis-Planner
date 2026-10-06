import { message as uiMessage } from '../messages';
/**
 * End Day (`/end-day/:date`,): the daily review. A short look back at
 * one planning date on or before today. It lists what is done and what is still open, lets the
 * person choose what happens to each open item (every item starts at "Decide later", which changes
 * nothing), drafts the carry date's focus, and takes an optional energy label and note. Nothing
 * changes until "Finish review", which runs one command with one Undo; "Save for later" keeps the
 * choices as a draft to resume, and "Skip this review" applies nothing. A finished day shows its
 * review read-only.
 *
 * The page renders query results only and re-queries after every command; React keeps only the
 * unsaved choices.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type {
  BlockRow,
  DailyReviewInput,
  EndDayActionDecision,
  EndDayInput,
  EndDayItemView,
  EndDayView,
  FocusCandidate,
  FocusItemView,
  OccurrenceEntry,
  OccurrenceTargetInput,
  PlacementPeriodInput,
  PlanProfile,
  ReviewView,
  SavedReview,
} from '@yelaxis/application';
import {
  focusTargetKey,
  isFocusableActionState,
  reviewLimits,
  type ActionState,
  type CalendarDate,
  type EnergyLabel,
} from '@yelaxis/domain';

import {
  formatDate,
  formatInstantTime,
  formatMonth,
  formatPeriod,
  formatWallTime,
  formatWeekRange,
} from '../plan/format';
import {
  RunnerAnnouncement,
  useCommandRunner,
  usePlanning,
  usePlanQuery,
  useReviewApplication,
  useTodayApplication,
} from '../plan/planning-context';
import { actionPath } from '../plan/routes';
import {
  isCalendarDate,
  monthKeyOf,
  shiftMonths,
  useFocusRescue,
  weekDatesFor,
} from '../plan/timeline';
import { useUnsavedGuard } from '../plan/unsaved-guard';
import {
  focusDraftFromSaved,
  hasText,
  isClearedList,
  itemsBySlot,
  sameKeys,
  sameOccurrence,
  sameStoredKeys,
  storedKeys,
  storedText,
} from '../review/review-draft';
import { BoundedTextField } from '../review/review-form';
import { ReviewReminderSection } from '../review/review-reminder';
import { energyWord, finishedText } from '../review/review-text';
import { DecisionList, OrderedTargets } from '../review/saved-review';
import { FocusDraftEditor, type FocusDraftItem } from './focus-strip';

import './end-day.css';

/* ───────────────────────── Text ───────────────────────── */

/** "Tuesday, September 29": the weekday and date End Day names its carry date with. */
export function dayName(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

const count = (value: number, singular: string, plural: string): string =>
  `${String(value)} ${value === 1 ? singular : plural}`;

function blockTime(block: BlockRow, profile: PlanProfile): string {
  const zone = profile.planningTimeZone;
  return `${formatInstantTime(block.startsAt, zone, profile.timeFormat)}–${formatInstantTime(
    block.endsAt,
    zone,
    profile.timeFormat,
  )}`;
}

function occurrenceTime(entry: OccurrenceEntry, profile: PlanProfile): string {
  switch (entry.timing.kind) {
    case 'timed':
      return `${formatInstantTime(
        entry.timing.startsAt,
        profile.planningTimeZone,
        profile.timeFormat,
      )}–${formatInstantTime(entry.timing.endsAt, profile.planningTimeZone, profile.timeFormat)}`;
    case 'flexible':
      return uiMessage('plan.routine-form.1445');
    case 'dst_skipped':
      return uiMessage('today.end-day.2144', {
        value0: formatWallTime(entry.timing.wallTime, profile.timeFormat),
      });
    case 'weekly_count':
      return uiMessage('plan.plan-month.1315');
  }
}

const stateText: Partial<Record<ActionState, string>> = {
  inbox: uiMessage('review.weekly-review.2032'),
  in_progress: uiMessage('plan.scheduling-dialogs.1621'),
};

type ActionItem = Extract<EndDayItemView, { readonly kind: 'action' }>;

/** An open Action with a planned time on another day gets no choice here. */
const scheduledElsewhere = (item: ActionItem): boolean =>
  item.source !== 'scheduled' && item.block !== undefined;

function itemTitle(item: EndDayItemView): string {
  return item.kind === 'action' ? item.action.title : item.occurrence.ref.routineTitle;
}

function itemKey(item: EndDayItemView): string {
  return item.kind === 'action'
    ? `action:${item.action.id}`
    : `occurrence:${item.occurrence.ref.occurrenceId}`;
}

function openFacts(item: EndDayItemView, profile: PlanProfile): string {
  if (item.kind === 'routine_occurrence')
    return uiMessage('today.choose-focus-dialog.2125', {
      value0: occurrenceTime(item.occurrence, profile),
    });
  const parts: string[] = [];
  if (item.source === 'scheduled' && item.block !== undefined)
    parts.push(uiMessage('today.end-day.2145', { value0: blockTime(item.block, profile) }));
  else if (item.source === 'flexible') parts.push(uiMessage('today.end-day.2146'));
  else parts.push(uiMessage('today.end-day.2147'));
  const placement = item.action.placement;
  if (item.source === 'focus' && placement !== undefined)
    parts.push(`Placed: ${formatPeriod(placement.period)}`);
  const state = stateText[item.action.state];
  if (state !== undefined) parts.push(state);
  if (item.action.projectTitle !== undefined) parts.push(`Project: ${item.action.projectTitle}`);
  return parts.join(' · ');
}

function doneFacts(item: EndDayItemView, profile: PlanProfile): string {
  if (item.kind === 'routine_occurrence') return 'Routine · Completed';
  return item.block === undefined
    ? uiMessage('plan.plan-month.1324')
    : uiMessage('today.end-day.2148', { value0: blockTime(item.block, profile) });
}

/* ───────────────────────── Choices ───────────────────────── */

type Choice = 'later' | 'carry' | 'move' | 'complete' | 'cancel' | 'skip';
type MoveHorizon = 'day' | 'week' | 'month';

interface MoveFields {
  readonly horizon: MoveHorizon;
  /** The day, or any date in the week. */
  readonly date: string;
  /** `YYYY-MM`. */
  readonly month: string;
}

type Destination =
  { readonly period: PlacementPeriodInput; readonly text: string } | { readonly error: string };

/** Where a Move goes, stated before anything is applied; never into the past. */
function destination(fields: MoveFields, view: EndDayView): Destination {
  const today = view.today;
  if (fields.horizon === 'month') {
    if (!/^\d{4}-\d{2}$/u.test(fields.month)) return { error: uiMessage('today.end-day.2149') };
    if (fields.month < monthKeyOf(today)) return { error: uiMessage('today.end-day.2150') };
    return {
      period: { kind: 'month', date: `${fields.month}-01` },
      text: uiMessage('today.end-day.2151', { value0: formatMonth(fields.month) }),
    };
  }
  if (!isCalendarDate(fields.date)) return { error: uiMessage('alignment.detail-parts.460') };
  if (fields.horizon === 'day') {
    if (fields.date < today) return { error: uiMessage('today.end-day.2152') };
    return {
      period: { kind: 'day', date: fields.date },
      text: uiMessage('today.end-day.2151', { value0: formatDate(fields.date, 'long') }),
    };
  }
  const week = weekDatesFor(fields.date, view.profile.weekStart);
  const start = week[0];
  const end = week[6];
  if (start === undefined || end === undefined)
    return { error: uiMessage('alignment.detail-parts.460') };
  if (end < today) return { error: uiMessage('today.end-day.2153') };
  return {
    period: { kind: 'week', date: fields.date },
    text: uiMessage('today.end-day.2154', { value0: formatWeekRange({ start, end }) }),
  };
}

function occurrenceTarget(entry: OccurrenceEntry): OccurrenceTargetInput {
  const ref = entry.ref;
  return {
    routineId: ref.routineId,
    generation: ref.generation,
    period: ref.period,
    ...(ref.materialized && ref.localRevision !== undefined ? { revision: ref.localRevision } : {}),
  };
}

const draftOf = (item: FocusItemView): FocusDraftItem => ({
  key: item.key,
  label: item.kind === 'action' ? item.action.title : item.routineTitle,
  target: item.target,
});

const sameDraft = (left: readonly FocusDraftItem[], right: readonly FocusDraftItem[]): boolean =>
  left.length === right.length && left.every((item, index) => item.key === right[index]?.key);

/** End Day's choices as the review sends them; Finish adds the carry date. */
type EndDayChoices = Omit<EndDayInput, 'date' | 'carryTo'>;

/** What the finished review did, as calm counts (never a score or a ratio). */
function summaryLines(input: EndDayChoices, carryDate: string): readonly string[] {
  const actions = (kind: EndDayActionDecision['kind']) =>
    input.actions.filter((item) => item.decision.kind === kind).length;
  const occurrences = (kind: 'complete' | 'skip') =>
    input.occurrences.filter((item) => item.decision.kind === kind).length;
  const carryTo = dayName(carryDate);
  const counts: readonly (readonly [number, string])[] = [
    [actions('carry'), uiMessage('today.end-day.2155', { value0: carryTo })],
    [actions('move'), 'moved'],
    [actions('complete'), 'completed'],
    [actions('cancel'), 'canceled'],
  ];
  const lines = counts
    .filter(([value]) => value !== 0)
    .map(
      ([value, text]) =>
        `${count(value, uiMessage('actions-ui.282'), uiMessage('alignment.project-detail.758'))} ${text}.`,
    );
  if (occurrences('complete') > 0)
    lines.push(
      uiMessage('today.end-day.2156', {
        value0: count(occurrences('complete'), 'routine occurrence', 'routine occurrences'),
      }),
    );
  if (occurrences('skip') > 0)
    lines.push(
      uiMessage('today.end-day.2157', {
        value0: count(occurrences('skip'), 'routine occurrence', 'routine occurrences'),
      }),
    );
  if (input.nextFocus !== undefined)
    lines.push(
      input.nextFocus.length === 0
        ? uiMessage('today.end-day.2158', { value0: carryTo })
        : uiMessage('today.end-day.2159', {
            value0: carryTo,
            value1: count(input.nextFocus.length, 'item', 'items'),
          }),
    );
  return lines;
}

/* ───────────────────────── The day's draft ───────────────────────── */

type DailyView = Extract<ReviewView, { readonly type: 'daily' }>;

/** Everything the person can change before finishing; saved as a draft by Save for later. */
interface DayDraft {
  readonly choices: Readonly<Record<string, Choice>>;
  readonly moves: Readonly<Record<string, MoveFields>>;
  /** null: untouched, so the draft follows the carry date's saved focus as it is re-read. */
  readonly focus: readonly FocusDraftItem[] | null;
  readonly energy: EnergyLabel | null;
  readonly note: string;
}

function moveFieldsOf(period: PlacementPeriodInput, view: EndDayView): MoveFields {
  switch (period.kind) {
    case 'week':
      return { horizon: 'week', date: period.date, month: monthKeyOf(view.carryTo) };
    case 'month':
      return { horizon: 'month', date: view.carryTo, month: period.date.slice(0, 7) };
    case 'day':
    case 'year':
      return { horizon: 'day', date: period.date, month: monthKeyOf(period.date) };
  }
}

/** The choices the form starts from: a saved (or skipped) review's, or Decide later for all. */
function dayDraftFrom(saved: SavedReview | null, view: EndDayView): DayDraft {
  const choices: Record<string, Choice> = {};
  const moves: Record<string, MoveFields> = {};
  for (const item of itemsBySlot(saved?.items ?? []).state) {
    const target = item.target;
    if (target.kind === 'action') {
      const key = `action:${target.id}`;
      if (item.decision === 'carry' || item.decision === 'complete' || item.decision === 'cancel')
        choices[key] = item.decision;
      else if (item.decision === 'move' && item.period !== undefined) {
        choices[key] = 'move';
        moves[key] = moveFieldsOf(item.period, view);
      }
    } else if (
      target.kind === 'routine_occurrence' &&
      (item.decision === 'complete' || item.decision === 'skip')
    ) {
      const open = view.open.items.find(
        (entry) =>
          entry.kind === 'routine_occurrence' &&
          sameOccurrence(occurrenceTarget(entry.occurrence), target.occurrence),
      );
      if (open !== undefined) choices[itemKey(open)] = item.decision;
    }
  }
  return {
    choices,
    moves,
    // Saved focus items, or no items when the draft cleared the focus, or (null) the plan's.
    focus: focusDraftFromSaved(saved, 'next_focus', view.nextFocus),
    energy: saved?.energy ?? null,
    note: saved?.notes ?? '',
  };
}

/** A Move's period as the review keeps it: a Week by its first day, whichever day named it. */
function storedPeriodKey(period: PlacementPeriodInput, view: EndDayView): string {
  const date =
    period.kind === 'week'
      ? (weekDatesFor(period.date, view.profile.weekStart)[0] ?? period.date)
      : period.date;
  return `${period.kind}:${date}`;
}

/**
 * Whether two drafts would save the same review (Decide later and untouched focus included), so a
 * Save always leaves nothing unsaved (see `storedKeys` and `storedText`).
 */
function sameDayDraft(left: DayDraft, right: DayDraft, view: EndDayView): boolean {
  const defaultMove: MoveFields = {
    horizon: 'day',
    date: view.carryTo,
    month: monthKeyOf(view.carryTo),
  };
  const decisions = (draft: DayDraft): string[] =>
    view.open.items.flatMap((item) => {
      // An Action planned on another day gets no choice here, so none is ever saved for it.
      if (item.kind === 'action' && scheduledElsewhere(item)) return [];
      const key = itemKey(item);
      const choice = draft.choices[key] ?? 'later';
      if (choice === 'later') return [];
      if (choice !== 'move') return [`${key}:${choice}`];
      const target = destination(draft.moves[key] ?? defaultMove, view);
      return [
        `${key}:move:${'period' in target ? storedPeriodKey(target.period, view) : 'invalid'}`,
      ];
    });
  const baseline = view.nextFocus.current.map(draftOf);
  const planFocus = baseline.map((item) => item.key);
  const focus = (draft: DayDraft): readonly string[] | null =>
    storedKeys(
      (draft.focus ?? baseline).map((item) => item.key),
      planFocus,
    );
  return (
    sameKeys(decisions(left), decisions(right)) &&
    sameStoredKeys(focus(left), focus(right)) &&
    left.energy === right.energy &&
    storedText(left.note) === storedText(right.note)
  );
}

/* ───────────────────────── Page ───────────────────────── */

export function EndDayPage(): ReactNode {
  const { date = '' } = useParams();
  if (!isCalendarDate(date))
    return (
      <EndDayFrame eyebrow={uiMessage('app.782')}>
        <p className="page-message">{uiMessage('today.end-day.2160')}</p>
        <BackToToday />
      </EndDayFrame>
    );
  return <EndDayLoader key={date} date={date as CalendarDate} />;
}

function EndDayFrame({
  busy = false,
  children,
  eyebrow,
  heading,
}: {
  readonly busy?: boolean;
  readonly children: ReactNode;
  readonly eyebrow: string;
  readonly heading?: RefObject<HTMLHeadingElement | null>;
}): ReactNode {
  return (
    <article className="end-day" aria-labelledby="end-day-title" aria-busy={busy}>
      <header className="end-day-header">
        <p className="eyebrow">{eyebrow}</p>
        <h1 id="end-day-title" ref={heading} tabIndex={-1}>
          {uiMessage('today.end-day.2161')}
        </h1>
      </header>
      {children}
    </article>
  );
}

function BackToToday(): ReactNode {
  return (
    <Link className="primary-button inline-button" to="/">
      {uiMessage('today.end-day.2162')}
    </Link>
  );
}

type Running = 'finish' | 'save' | 'skip' | 'undo';

/** The day's review commands, run through the page's one command runner. */
interface DayCommands {
  /** A command is running or the day is being re-read after one. */
  readonly busy: boolean;
  readonly running: Running | null;
  readonly error: string | null;
  finish(input: DailyReviewInput, lines: readonly string[]): Promise<boolean>;
  save(input: DailyReviewInput): Promise<boolean>;
  skip(): Promise<boolean>;
}

type DayResult =
  | { readonly kind: 'finished'; readonly lines: readonly string[]; readonly key: number }
  | { readonly kind: 'saved' | 'skipped'; readonly key: number };

interface DayData {
  readonly endDay: EndDayView;
  readonly review: DailyView | null;
}

function EndDayLoader({ date }: { readonly date: CalendarDate }): ReactNode {
  const today = useTodayApplication();
  const reviews = useReviewApplication();
  const planning = usePlanning();
  const { state, reload } = usePlanQuery<DayData>(async () => {
    const [endDay, review] = await Promise.all([
      today.getEndDay(date),
      reviews.getReview('daily', date),
    ]);
    return { endDay, review: review?.type === 'daily' ? review : null };
  }, [date]);
  const runner = useCommandRunner();
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusRescue(heading, runner, state.status === 'ready' ? state.data : null);
  // Each result gets a new key, so a summary that reads like the last one is still a new status
  // message and is announced again.
  const [result, setResult] = useState<DayResult | null>(null);
  const results = useRef(0);
  const [undone, setUndone] = useState(false);
  const [running, setRunning] = useState<Running | null>(null);
  // Counts the page's own commands, so the Reminder section ends its result and Undo on each.
  const [pageCommands, setPageCommands] = useState(0);
  const eyebrow = formatDate(date, 'long');
  const busy = runner.busy || (state.status === 'ready' && state.refreshing);

  const run = async (
    kind: Running,
    operation: Parameters<typeof runner.run>[0],
    success = '',
  ): Promise<boolean> => {
    if (busy) return false;
    setPageCommands((count) => count + 1);
    setRunning(kind);
    setUndone(false);
    const succeeded = await runner.run(operation, success);
    setRunning(null);
    return succeeded;
  };
  const show = (
    next:
      | { readonly kind: 'finished'; readonly lines: readonly string[] }
      | { readonly kind: 'saved' | 'skipped' },
  ): void => {
    results.current += 1;
    const key = results.current;
    setResult(next.kind === 'finished' ? { ...next, key } : { kind: next.kind, key });
  };
  const review = state.status === 'ready' ? state.data.review : null;
  const savedNow = review?.saved ?? null;
  const revision = savedNow === null ? {} : { revision: savedNow.localRevision };
  // The visible result below is the status announcement, so the runner announces nothing.
  const commands: DayCommands = {
    busy,
    running,
    error: runner.error,
    finish: async (input, lines) => {
      setResult(null);
      const done = await run('finish', () => reviews.finishReview(input));
      if (done) show({ kind: 'finished', lines });
      return done;
    },
    save: async (input) => {
      setResult(null);
      const done = await run('save', () => reviews.saveReview(input));
      if (done) show({ kind: 'saved' });
      return done;
    },
    skip: async () => {
      setResult(null);
      const done = await run('skip', () =>
        reviews.skipReview({ type: 'daily', periodKey: date, ...revision }),
      );
      if (done) show({ kind: 'skipped' });
      return done;
    },
  };
  const undo = async (): Promise<void> => {
    const undoId = runner.undoId;
    if (undoId === null) return;
    const reverted = await run(
      'undo',
      () => planning.undo(undoId),
      uiMessage('today.end-day.2163'),
    );
    if (reverted) {
      setResult(null);
      setUndone(true);
    }
  };
  // A reminder command is the last command now: the review command's result and Undo end. (Undo
  // of the command that created the review would archive it and leave its reminder out of reach.)
  const reminderCommand = (): void => {
    setResult(null);
    setUndone(false);
    runner.dismissUndo();
  };

  if (state.status === 'loading')
    return (
      <EndDayFrame eyebrow={eyebrow} heading={heading} busy>
        <p className="page-message" role="status">
          {uiMessage('today.end-day.2164')}
        </p>
      </EndDayFrame>
    );
  if (state.status === 'error')
    return (
      <EndDayFrame eyebrow={eyebrow} heading={heading}>
        <div className="validation-summary" role="alert">
          <p>{uiMessage('today.end-day.2165')}</p>
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
        <BackToToday />
      </EndDayFrame>
    );
  const view = state.data.endDay;
  if (!view.available)
    return (
      <EndDayFrame eyebrow={eyebrow} heading={heading}>
        <p className="page-message">{uiMessage('today.end-day.2166')}</p>
        <BackToToday />
      </EndDayFrame>
    );
  const saved = savedNow;
  // The saved review's "Remind me to finish" reminder; outside the End Day form, so
  // Enter in its fields never finishes the review.
  const reminder =
    saved === null ? null : (
      <ReviewReminderSection
        saved={saved}
        profile={view.profile}
        today={view.today}
        pageBusy={busy}
        resetKey={pageCommands}
        onCommand={reminderCommand}
      />
    );
  return (
    <EndDayFrame eyebrow={eyebrow} heading={heading} busy={state.refreshing}>
      <RunnerAnnouncement runner={runner} />
      {saved?.state === 'completed' ? (
        <CompletedDay view={view} saved={saved} reminder={reminder} />
      ) : (
        <>
          <EndDayForm view={view} saved={saved} commands={commands} />
          {reminder}
        </>
      )}
      <div className="end-day-result">
        <div role="status">
          {result !== null && (
            <div key={result.key} className="end-day-summary">
              <p className="end-day-summary-title">
                {result.kind === 'finished'
                  ? uiMessage('review.review-page.1982')
                  : result.kind === 'saved'
                    ? uiMessage('review.review-page.1983')
                    : uiMessage('review.review-page.1984')}
              </p>
              {result.kind === 'finished' && result.lines.length > 0 && (
                <ul>
                  {result.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {result !== null && result.kind !== 'saved' && runner.undoId !== null && (
          <div className="end-day-actions">
            <button
              type="button"
              aria-disabled={busy ? true : undefined}
              onClick={() => void undo()}
            >
              {uiMessage('actions-ui.236')}
            </button>
          </div>
        )}
        {undone && <p className="end-day-note">{uiMessage('today.end-day.2163')}</p>}
        {saved?.state === 'completed' && runner.error !== null && (
          <p className="validation-summary" role="alert">
            {runner.error}
          </p>
        )}
      </div>
    </EndDayFrame>
  );
}

/* ───────────────────────── A finished day ───────────────────────── */

/** The day's finished review, read-only: energy, note, decisions, and the focus chosen. */
function CompletedDay({
  reminder,
  saved,
  view,
}: {
  readonly view: EndDayView;
  readonly saved: SavedReview;
  /**
   * The review's Reminder section, shown after its choices while a reminder is saved (or the result
   * of turning it off is showing).
   */
  readonly reminder: ReactNode;
}): ReactNode {
  const idBase = useId();
  const slots = itemsBySlot(saved.items);
  const day = formatDate(view.date, 'long');
  return (
    <>
      <p className="end-day-intro">
        {saved.completedAt === undefined
          ? uiMessage('today.end-day.2167')
          : uiMessage('today.end-day.2168', {
              value0: finishedText(saved.completedAt, view.profile),
            })}
      </p>
      <section className="end-day-section" aria-labelledby={`${idBase}-energy`}>
        <h2 id={`${idBase}-energy`}>{uiMessage('actions-ui.337')}</h2>
        <p>
          {saved.energy === undefined ? uiMessage('today.end-day.2169') : energyWord(saved.energy)}
        </p>
      </section>
      <section className="end-day-section" aria-labelledby={`${idBase}-note`}>
        <h2 id={`${idBase}-note`}>{uiMessage('plan.routines.1606')}</h2>
        {saved.notes === undefined ? (
          <p className="quiet-empty">{uiMessage('today.end-day.2170')}</p>
        ) : (
          <p className="review-quote">{saved.notes}</p>
        )}
      </section>
      <section className="end-day-section" aria-labelledby={`${idBase}-decisions`}>
        <h2 id={`${idBase}-decisions`}>{uiMessage('review.saved-review.2017')}</h2>
        {slots.state.length === 0 ? (
          <p className="quiet-empty">{uiMessage('review.saved-review.2018')}</p>
        ) : (
          <DecisionList
            items={slots.state}
            applied
            label={uiMessage('today.end-day.2171', { value0: day })}
            profile={view.profile}
            today={view.today}
          />
        )}
      </section>
      <section className="end-day-section" aria-labelledby={`${idBase}-focus`}>
        <h2 id={`${idBase}-focus`}>{uiMessage('today.end-day.2172')}</h2>
        {slots.focus.length === 0 ? (
          <p className="quiet-empty">
            {isClearedList(saved, 'next_focus')
              ? uiMessage('today.end-day.2173')
              : uiMessage('today.end-day.2174')}
          </p>
        ) : (
          <OrderedTargets items={slots.focus} label={uiMessage('today.end-day.2172')} />
        )}
      </section>
      {reminder}
      <p>
        <BackToToday />
      </p>
    </>
  );
}

/* ───────────────────────── The form ───────────────────────── */

interface Announcement {
  readonly text: string;
  readonly key: number;
}

const energyOptions: readonly (readonly [EnergyLabel | 'none', string])[] = [
  ['none', uiMessage('today.end-day.2169')],
  ['low', uiMessage('actions-ui.339')],
  ['medium', uiMessage('actions-ui.340')],
  ['high', uiMessage('actions-ui.341')],
  ['focused', uiMessage('actions-ui.342')],
];

function EndDayForm({
  commands,
  saved,
  view,
}: {
  readonly view: EndDayView;
  readonly saved: SavedReview | null;
  readonly commands: DayCommands;
}): ReactNode {
  const today = useTodayApplication();
  const navigate = useNavigate();
  const idBase = useId();
  // A saved or skipped review's choices come back as they were saved.
  const [initial] = useState(() => dayDraftFrom(saved, view));
  const [choices, setChoices] = useState<Readonly<Record<string, Choice>>>(initial.choices);
  const [moves, setMoves] = useState<Readonly<Record<string, MoveFields>>>(initial.moves);
  const [draft, setDraft] = useState<readonly FocusDraftItem[] | null>(initial.focus);
  const [energy, setEnergy] = useState<EnergyLabel | null>(initial.energy);
  const [note, setNote] = useState(initial.note);
  const [problem, setProblemState] = useState<Announcement | null>(null);
  const [errorFocus, setErrorFocus] = useState(0);
  const [announcement, setAnnouncement] = useState<Announcement>({ text: '', key: 0 });
  // What the last successful Finish or Save sent, and the review it had read: the page shows the
  // result a moment before it reads the day again (like the review form's `isSettled`).
  const [settled, setSettled] = useState<{
    readonly parts: readonly unknown[];
    readonly saved: SavedReview | null;
  } | null>(null);
  const problemRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // Every choice the form holds; each part is replaced whenever it changes.
  const parts: readonly unknown[] = [choices, moves, draft, energy, note];
  // The form still shows exactly what that command sent, and the day has not been read again.
  const sentAsShown =
    settled !== null &&
    settled.saved === saved &&
    settled.parts.every((part, index) => part === parts[index]);

  const announce = (text: string): void =>
    setAnnouncement((current) => ({ text, key: current.key + 1 }));
  const setProblem = (text: string | null): void =>
    setProblemState((current) => (text === null ? null : { text, key: (current?.key ?? 0) + 1 }));
  // A refused Finish or Save moves focus to its reason once the alert is rendered (after commit).
  useEffect(() => {
    if (problem !== null) problemRef.current?.focus();
  }, [problem]);
  useEffect(() => {
    if (errorFocus > 0) errorRef.current?.focus();
  }, [errorFocus]);
  const choiceOf = (item: EndDayItemView): Choice => choices[itemKey(item)] ?? 'later';
  const defaultMove: MoveFields = {
    horizon: 'day',
    date: view.carryTo,
    month: monthKeyOf(view.carryTo),
  };
  const moveOf = (item: EndDayItemView): MoveFields => moves[itemKey(item)] ?? defaultMove;

  const items = view.open.items;
  const decidable = items.filter(
    (item): item is ActionItem => item.kind === 'action' && !scheduledElsewhere(item),
  );
  const baseline = view.nextFocus.current.map(draftOf);
  const focusValue = draft ?? baseline;
  const focusChanged = draft !== null && !sameDraft(draft, baseline);
  // Unsaved: anything different from what is saved now (re-read after every command). From the
  // moment a Finish or Save succeeds until the day is read again, the choices it sent are saved.
  const dirty =
    !sentAsShown &&
    !sameDayDraft({ choices, moves, focus: draft, energy, note }, dayDraftFrom(saved, view), view);
  const carryName = dayName(view.carryTo);
  const skipped = saved?.state === 'skipped';

  // Actions carried or moved to the carry date can be chosen as its focus before they are there.
  const known = new Set<string>(view.nextFocus.candidates.map((candidate) => candidate.key));
  const extraCandidates: FocusCandidate[] = [];
  for (const item of decidable) {
    const choice = choiceOf(item);
    let source: 'flexible' | 'week' | null = choice === 'carry' ? 'flexible' : null;
    if (choice === 'move') {
      const target = destination(moveOf(item), view);
      if ('period' in target) {
        const period = target.period;
        if (period.kind === 'day' && period.date === view.carryTo) source = 'flexible';
        const week = weekDatesFor(period.date, view.profile.weekStart);
        if (period.kind === 'week' && week.includes(view.carryTo)) source = 'week';
      }
    }
    const key = focusTargetKey({ kind: 'action', actionId: item.action.id });
    if (source === null || known.has(key)) continue;
    extraCandidates.push({
      kind: 'action',
      key,
      target: { kind: 'action', actionId: item.action.id },
      source,
      action: item.action,
      selected: false,
    });
  }

  const build = (): { readonly choices: EndDayChoices } | { readonly problem: string } => {
    const actions: EndDayInput['actions'][number][] = [];
    const occurrences: EndDayInput['occurrences'][number][] = [];
    const resolving = new Map<string, string>();
    for (const item of items) {
      const choice = choiceOf(item);
      if (choice === 'later') continue;
      if (item.kind === 'routine_occurrence') {
        if (choice === 'complete' || choice === 'skip')
          occurrences.push({
            occurrence: occurrenceTarget(item.occurrence),
            decision: { kind: choice },
          });
        continue;
      }
      if (scheduledElsewhere(item)) continue;
      let decision: EndDayActionDecision;
      if (choice === 'move') {
        const target = destination(moveOf(item), view);
        if ('error' in target)
          return {
            problem: uiMessage('today.end-day.2175', {
              value0: item.action.title,
              value1: target.error,
            }),
          };
        decision = { kind: 'move', period: target.period };
      } else if (choice === 'carry' || choice === 'complete' || choice === 'cancel') {
        decision = { kind: choice };
        if (choice !== 'carry')
          resolving.set(
            item.action.id,
            choice === 'complete'
              ? uiMessage('actions-ui.257')
              : uiMessage('account.account-dialogs.20'),
          );
      } else continue;
      actions.push({
        actionId: item.action.id,
        revision: item.action.localRevision,
        decision,
      });
    }
    if (focusChanged) {
      if (focusValue.length > 3) return { problem: uiMessage('review.weekly-review.2027') };
      for (const item of focusValue) {
        const choice = item.target.kind === 'action' ? resolving.get(item.target.actionId) : null;
        if (choice !== undefined && choice !== null)
          return {
            problem: uiMessage('today.end-day.2176', {
              value0: item.label,
              value1: choice,
              value2: carryName,
            }),
          };
      }
    }
    if (note.length > reviewLimits.notes)
      return {
        problem: uiMessage('today.end-day.2177', {
          value0: reviewLimits.notes.toLocaleString('en-US'),
        }),
      };
    return {
      choices: {
        actions,
        occurrences,
        ...(focusChanged ? { nextFocus: focusValue.map((item) => item.target) } : {}),
      },
    };
  };

  const reviewInput = (endDay: DailyReviewInput['endDay']): DailyReviewInput => ({
    type: 'daily',
    periodKey: view.date,
    ...(saved === null ? {} : { revision: saved.localRevision }),
    ...(hasText(note) ? { notes: note } : {}),
    ...(energy === null ? {} : { energy }),
    endDay,
  });

  const send = async (kind: 'finish' | 'save'): Promise<boolean> => {
    if (commands.busy) return false;
    const built = build();
    if ('problem' in built) {
      setProblem(built.problem);
      return false;
    }
    setProblem(null);
    const sent = { parts, saved };
    const done =
      kind === 'finish'
        ? await commands.finish(
            reviewInput({ ...built.choices, carryTo: view.carryTo }),
            summaryLines(built.choices, view.carryTo),
          )
        : await commands.save(reviewInput(built.choices));
    if (done) setSettled(sent);
    else setErrorFocus((value) => value + 1);
    return done;
  };

  // Skip keeps only what was saved: choices not saved before it stay unsaved, before and after the
  // day is read again, so a Skip settles nothing.
  const skip = async (): Promise<void> => {
    if (commands.busy) return;
    setProblem(null);
    const done = await commands.skip();
    if (!done) setErrorFocus((value) => value + 1);
  };

  const guard = useUnsavedGuard(dirty, () => send('save'));

  const setChoice = (item: EndDayItemView, choice: Choice): void => {
    setChoices((current) => ({ ...current, [itemKey(item)]: choice }));
  };

  const carryAll = (): void => {
    setChoices((current) => ({
      ...current,
      ...Object.fromEntries(decidable.map((item) => [itemKey(item), 'carry' as const])),
    }));
    announce(
      uiMessage('today.end-day.2178', { value0: count(decidable.length, 'Action', 'Actions') }),
    );
  };

  const adoptDayFocus = async (): Promise<void> => {
    let current: readonly FocusItemView[];
    try {
      current = (await today.getFocusChoices(view.date)).current;
    } catch {
      setProblem(uiMessage('today.end-day.2179'));
      return;
    }
    const resolving = new Set(
      decidable
        .filter((item) => choiceOf(item) === 'complete' || choiceOf(item) === 'cancel')
        .map((item) => item.action.id),
    );
    const unfinished = current.filter((item) => {
      if (item.kind === 'action')
        return isFocusableActionState(item.action.state) && !resolving.has(item.action.id);
      // A dated occurrence belongs to its own day; only a weekly count can carry over.
      const period = item.occurrence?.ref.period;
      return (
        item.occurrence?.state === 'planned' &&
        period?.kind === 'week' &&
        period.start <= view.carryTo &&
        view.carryTo <= period.end
      );
    });
    if (unfinished.length === 0) {
      announce(uiMessage('today.end-day.2180'));
      return;
    }
    setDraft(unfinished.slice(0, 3).map(draftOf));
    announce(
      uiMessage('today.end-day.2181', {
        value0: carryName,
        value1: count(Math.min(unfinished.length, 3), 'unfinished item', 'unfinished items'),
      }),
    );
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void send('finish');
  };

  const truncated = view.open.total > items.length;
  const doneHeading = `${idBase}-done`;
  const openHeading = `${idBase}-open`;
  const energyHeading = `${idBase}-energy`;
  const focusHeading = `${idBase}-focus`;

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {announcement.text === '' ? null : <span key={announcement.key}>{announcement.text}</span>}
      </p>
      <p className="end-day-intro">{uiMessage('today.end-day.2182')}</p>
      {skipped && <p className="end-day-note">{uiMessage('today.end-day.2183')}</p>}

      <section className="end-day-section" aria-labelledby={doneHeading}>
        <h2 id={doneHeading}>{uiMessage('today.end-day.2184')}</h2>
        {view.completed.length === 0 ? (
          <p className="quiet-empty">{uiMessage('today.end-day.2185')}</p>
        ) : (
          <ul
            className="end-day-done"
            aria-label={uiMessage('today.end-day.2186', { value0: formatDate(view.date, 'long') })}
          >
            {view.completed.map((item) => (
              <li key={itemKey(item)}>
                <span className="end-day-done-title">
                  {item.kind === 'action' ? (
                    <Link to={actionPath(item.action.id)}>{itemTitle(item)}</Link>
                  ) : (
                    itemTitle(item)
                  )}
                </span>
                <span className="end-day-facts">{doneFacts(item, view.profile)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form className="end-day-form" noValidate onSubmit={submit}>
        <section className="end-day-section" aria-labelledby={openHeading}>
          <h2 id={openHeading}>{uiMessage('today.end-day.2187')}</h2>
          {items.length === 0 ? (
            <p className="quiet-empty">{uiMessage('today.end-day.2188')}</p>
          ) : (
            <p className="field-help">{uiMessage('today.end-day.2189')}</p>
          )}
          {truncated && (
            <p className="end-day-note">
              {uiMessage('actions-ui.320')}
              {items.length}
              {uiMessage('actions-ui.321')}
              {view.open.total}
              {uiMessage('today.end-day.2190')}
            </p>
          )}
          {decidable.length > 0 && (
            <button type="button" className="end-day-carry-all" onClick={carryAll}>
              {uiMessage('today.end-day.2191')}
              {carryName}
            </button>
          )}
          {items.length > 0 && (
            <ul
              className="end-day-items"
              aria-label={uiMessage('today.end-day.2192', {
                value0: formatDate(view.date, 'long'),
              })}
            >
              {items.map((item, index) => (
                <OpenItem
                  key={itemKey(item)}
                  id={`${idBase}-item-${String(index)}`}
                  item={item}
                  view={view}
                  choice={choiceOf(item)}
                  move={moveOf(item)}
                  onChoice={(choice) => setChoice(item, choice)}
                  onMove={(fields) =>
                    setMoves((current) => ({ ...current, [itemKey(item)]: fields }))
                  }
                />
              ))}
            </ul>
          )}
        </section>

        <section className="end-day-section" aria-labelledby={energyHeading}>
          <h2 id={energyHeading}>{uiMessage('today.end-day.2193')}</h2>
          <fieldset className="end-day-fieldset">
            <legend>{uiMessage('today.end-day.2194')}</legend>
            <div className="end-day-choices">
              {energyOptions.map(([value, label]) => (
                <label key={value} className="end-day-choice">
                  <input
                    type="radio"
                    name={`${idBase}-energy`}
                    value={value}
                    checked={(energy ?? 'none') === value}
                    onChange={() => setEnergy(value === 'none' ? null : value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <BoundedTextField
            label={uiMessage('today.end-day.2195')}
            value={note}
            onChange={setNote}
            limit={reviewLimits.notes}
            rows={3}
          />
        </section>

        <section className="end-day-section" aria-labelledby={focusHeading}>
          <h2 id={focusHeading}>
            {uiMessage('today.end-day.2196')}
            {carryName}
          </h2>
          <p className="field-help">
            {uiMessage('today.end-day.2197')}
            {carryName}
            {uiMessage('today.end-day.2198')}
          </p>
          <div>
            <button type="button" onClick={() => void adoptDayFocus()}>
              {view.date === view.today
                ? uiMessage('today.end-day.2199')
                : uiMessage('today.end-day.2200', { value0: dayName(view.date) })}
            </button>
          </div>
          <FocusDraftEditor
            choices={view.nextFocus}
            value={focusValue}
            onChange={setDraft}
            extraCandidates={extraCandidates}
            idPrefix={`${idBase}-focus-draft`}
          />
          {focusChanged && <p className="field-help">{uiMessage('today.end-day.2201')}</p>}
        </section>

        {problem !== null && (
          <p ref={problemRef} className="validation-summary" role="alert" tabIndex={-1}>
            {problem.text}
          </p>
        )}
        {commands.error !== null && (
          <p ref={errorRef} className="validation-summary" role="alert" tabIndex={-1}>
            {commands.error}
          </p>
        )}
        <div className="end-day-actions">
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
              onClick={() => void skip()}
            >
              {uiMessage('review.review-form.1951')}
            </button>
          )}
          <button type="button" onClick={() => void navigate('/')}>
            {uiMessage('today.end-day.2202')}
          </button>
        </div>
      </form>
      {guard.dialog}
    </>
  );
}

/* ───────────────────────── One open item ───────────────────────── */

function OpenItem({
  choice,
  id,
  item,
  move,
  onChoice,
  onMove,
  view,
}: {
  readonly id: string;
  readonly item: EndDayItemView;
  readonly view: EndDayView;
  readonly choice: Choice;
  readonly move: MoveFields;
  readonly onChoice: (choice: Choice) => void;
  readonly onMove: (fields: MoveFields) => void;
}): ReactNode {
  const title = itemTitle(item);
  const factsId = `${id}-facts`;
  const helpId = `${id}-help`;
  if (item.kind === 'action' && scheduledElsewhere(item))
    return (
      <li className="end-day-item">
        <p className="end-day-item-title">{title}</p>
        <p className="end-day-facts">{openFacts(item, view.profile)}</p>
        <p className="end-day-note">{uiMessage('today.end-day.2203')}</p>
        <Link
          to={actionPath(item.action.id)}
          aria-label={uiMessage('review.review-form.1941', { value0: title })}
        >
          {uiMessage('review.review-form.1942')}
        </Link>
      </li>
    );
  const scheduledBlock =
    item.kind === 'action' && item.source === 'scheduled' ? item.block : undefined;
  const options: readonly (readonly [Choice, string])[] =
    item.kind === 'action'
      ? [
          ['later', uiMessage('review.review-form.1940')],
          ['carry', uiMessage('today.end-day.2204', { value0: dayName(view.carryTo) })],
          ['move', uiMessage('today.end-day.2205')],
          ['complete', uiMessage('actions-ui.257')],
          ['cancel', uiMessage('account.account-dialogs.20')],
        ]
      : [
          ['later', uiMessage('review.review-form.1940')],
          ['complete', uiMessage('actions-ui.257')],
          ['skip', uiMessage('plan.occurrence-controls.1243')],
        ];
  return (
    <li className="end-day-item">
      <fieldset
        className="end-day-fieldset"
        aria-describedby={scheduledBlock === undefined ? factsId : `${factsId} ${helpId}`}
      >
        <legend>{title}</legend>
        <p id={factsId} className="end-day-facts">
          {openFacts(item, view.profile)}
        </p>
        {scheduledBlock !== undefined && (
          <p id={helpId} className="field-help">
            {uiMessage('today.end-day.2206')}
            {blockTime(scheduledBlock, view.profile)}
            {uiMessage('today.end-day.2207')}
          </p>
        )}
        <div className="end-day-choices">
          {options.map(([value, label]) => (
            <label key={value} className="end-day-choice">
              <input
                type="radio"
                name={`${id}-choice`}
                value={value}
                checked={choice === value}
                onChange={() => onChoice(value)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {choice === 'move' && item.kind === 'action' && (
          <MoveChoice id={id} title={title} view={view} fields={move} onChange={onMove} />
        )}
      </fieldset>
    </li>
  );
}

function MoveChoice({
  fields,
  id,
  onChange,
  title,
  view,
}: {
  readonly id: string;
  readonly title: string;
  readonly view: EndDayView;
  readonly fields: MoveFields;
  readonly onChange: (fields: MoveFields) => void;
}): ReactNode {
  const target = destination(fields, view);
  const destinationId = `${id}-destination`;
  const invalid = 'error' in target;
  const months = Array.from({ length: 13 }, (_, index) =>
    monthKeyOf(shiftMonths(`${monthKeyOf(view.today)}-01`, index)),
  );
  const horizons: readonly (readonly [MoveHorizon, string])[] = [
    ['day', 'A day'],
    ['week', 'A week'],
    ['month', 'A month'],
  ];
  return (
    <fieldset className="end-day-move">
      <legend>
        {uiMessage('today.end-day.2208')}
        {title}
        {uiMessage('today.end-day.2209')}
      </legend>
      <div className="end-day-choices">
        {horizons.map(([value, label]) => (
          <label key={value} className="end-day-choice">
            <input
              type="radio"
              name={`${id}-horizon`}
              value={value}
              checked={fields.horizon === value}
              onChange={() => onChange({ ...fields, horizon: value })}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {fields.horizon === 'month' ? (
        <label className="end-day-field" htmlFor={`${id}-month`}>
          {uiMessage('actions-ui.249')}
          <select
            id={`${id}-month`}
            value={fields.month}
            aria-describedby={destinationId}
            aria-invalid={invalid}
            onChange={(event) => onChange({ ...fields, month: event.target.value })}
          >
            {months.map((month) => (
              <option key={month} value={month}>
                {formatMonth(month)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="end-day-field" htmlFor={`${id}-date`}>
          {fields.horizon === 'day'
            ? uiMessage('actions-ui.274')
            : uiMessage('alignment.detail-parts.464')}
          <input
            id={`${id}-date`}
            type="date"
            min={view.today}
            value={fields.date}
            aria-describedby={destinationId}
            aria-invalid={invalid}
            onChange={(event) => onChange({ ...fields, date: event.target.value })}
          />
        </label>
      )}
      <p
        id={destinationId}
        className={invalid ? 'end-day-destination invalid' : 'end-day-destination'}
      >
        {'error' in target ? target.error : target.text}
      </p>
    </fieldset>
  );
}
