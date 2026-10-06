// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, Route } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ApplicationResult,
  CommandReceipt,
  DailyReviewInput,
  EndDayView,
  PlacementPeriodInput,
  PlanningApplication,
  ReviewApplication,
  ReviewInput,
  ReviewItemTargetView,
  SavedReview,
  SavedReviewItem,
  TodayApplication,
} from '@yelaxis/application';
import type { CalendarDate, EnergyLabel, Instant, UUID } from '@yelaxis/domain';

import { installDialogPolyfill, receipt } from '../plan/__fixtures__/c1-planning-fake';
import { weekDatesFor } from '../plan/timeline';
import {
  dailyReviewView,
  fakeReminderCommands,
  fakeReviews,
  reminderView,
  reviewId,
  savedItem,
  savedReview,
} from '../review/__fixtures__/review-fake';
import {
  actionCandidate,
  draftEditor,
  elsewhereItem,
  flexibleItem,
  focusItem,
  invoice,
  invoiceDone,
  notes,
  outline,
  report,
  resetDraftEditor,
  scheduledItem,
  stretchDone,
  venue,
  walk,
  walkItem,
} from './__fixtures__/end-day-fixtures';
import {
  endDayView,
  fakeToday,
  focusActionItem,
  focusChoices,
  todayAction,
  todayId,
  todayPlanning,
  todayTree,
} from './__fixtures__/today-fake';
import { EndDayPage } from './end-day';

vi.mock(
  './focus-strip',
  async () => (await import('./__fixtures__/end-day-fixtures')).focusStripStandIns,
);

beforeAll(() => installDialogPolyfill());
afterEach(() => {
  cleanup();
  resetDraftEditor();
});

const tomorrow = '2026-09-29' as CalendarDate;
const carryLabel = 'Carry to Tuesday, September 29';
const kept = todayAction(todayId(20), 'Book the room');
const plannedTomorrow = todayAction(todayId(21), 'Print the handouts');

function populated(overrides: Partial<EndDayView> = {}): EndDayView {
  return endDayView({
    completed: [invoiceDone, stretchDone],
    open: { items: [scheduledItem, flexibleItem, focusItem, elsewhereItem, walkItem], total: 5 },
    nextFocus: focusChoices({
      date: tomorrow,
      current: [focusActionItem(kept)],
      candidates: [actionCandidate(kept, 'flexible', true), actionCandidate(plannedTomorrow)],
    }),
    ...overrides,
  });
}

const walkTarget: ReviewItemTargetView = {
  kind: 'routine_occurrence',
  routineId: walk.ref.routineId,
  routineTitle: walk.ref.routineTitle,
  occurrence: { routineId: walk.ref.routineId, generation: 1, period: walk.ref.period },
};

const actionTarget = (action: { id: string; title: string }): ReviewItemTargetView => ({
  kind: 'action',
  id: action.id as UUID,
  title: action.title,
  state: 'planned',
});

/** The review the application would keep for a Save or Finish of `input`. */
function savedFrom(
  input: DailyReviewInput,
  state: SavedReview['state'],
  view: EndDayView,
): SavedReview {
  const titles = new Map<string, string>([
    ...view.open.items.flatMap((item) =>
      item.kind === 'action' ? [[item.action.id, item.action.title] as const] : [],
    ),
    [kept.id, kept.title],
    [plannedTomorrow.id, plannedTomorrow.title],
  ]);
  // The application stores a Week by its first day, whichever day of it was chosen.
  const stored = (period: PlacementPeriodInput): PlacementPeriodInput =>
    period.kind === 'week'
      ? { kind: 'week', date: weekDatesFor(period.date, view.profile.weekStart)[0] ?? period.date }
      : period;
  const items: SavedReviewItem[] = [
    ...input.endDay.actions.map((action) =>
      savedItem(
        actionTarget({ id: action.actionId, title: titles.get(action.actionId) ?? '' }),
        action.decision.kind,
        action.decision.kind === 'move' ? { period: stored(action.decision.period) } : {},
      ),
    ),
    ...input.endDay.occurrences.map((entry) => savedItem(walkTarget, entry.decision.kind)),
    ...(input.endDay.nextFocus ?? []).flatMap((target, index) =>
      target.kind === 'action'
        ? [
            savedItem(
              actionTarget({ id: target.actionId, title: titles.get(target.actionId) ?? '' }),
              'focus',
              { position: index + 1 },
            ),
          ]
        : [],
    ),
  ];
  return savedReview({
    state,
    items,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.energy === undefined ? {} : { energy: input.energy as EnergyLabel }),
    // A focus named as empty is kept as cleared; an omitted one is left to the plan.
    ...(input.endDay.nextFocus?.length === 0 ? { clearedLists: ['next_focus' as const] } : {}),
    ...(state === 'completed' ? { completedAt: '2026-09-28T21:40:00.000Z' as Instant } : {}),
  });
}

function renderEndDay(
  options: {
    readonly view?: EndDayView;
    readonly saved?: SavedReview | null;
    readonly today?: Partial<TodayApplication>;
    readonly reviews?: Partial<ReviewApplication>;
    readonly planning?: Partial<PlanningApplication>;
    readonly path?: string;
    /**
     * Hold every read of the review after the first until `release()`, like a slow worker: the
     * page shows a command's result before it has read the saved review again.
     */
    readonly holdRereads?: boolean;
  } = {},
) {
  const view = options.view ?? populated();
  // The fake keeps one review like the application: Finish, Save, and Skip change it; Undo restores.
  let saved: SavedReview | null = options.saved ?? null;
  let before: SavedReview | null = saved;
  const change = (next: SavedReview | null, undoId?: string): ApplicationResult<CommandReceipt> => {
    before = saved;
    saved = next;
    return receipt(undoId);
  };
  /** Save and Finish never change the review's reminder. */
  const keepReminder = (next: SavedReview): SavedReview =>
    saved?.reminder === undefined ? next : { ...next, reminder: saved.reminder };
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getEndDay = vi.fn<TodayApplication['getEndDay']>(() => Promise.resolve(view));
  const getReview = vi.fn<ReviewApplication['getReview']>(async () => {
    const current = saved;
    if (options.holdRereads === true && getReview.mock.calls.length > 1) await held;
    return dailyReviewView(view, current);
  });
  const finishReview = vi.fn<ReviewApplication['finishReview']>((input: ReviewInput) =>
    Promise.resolve(
      change(input.type === 'daily' ? keepReminder(savedFrom(input, 'completed', view)) : saved),
    ),
  );
  const saveReview = vi.fn<ReviewApplication['saveReview']>((input: ReviewInput) =>
    Promise.resolve(
      change(input.type === 'daily' ? keepReminder(savedFrom(input, 'draft', view)) : saved),
    ),
  );
  const skipReview = vi.fn<ReviewApplication['skipReview']>(() =>
    Promise.resolve(change(savedReview({ ...(saved ?? {}), state: 'skipped' }))),
  );
  const undo = vi.fn<PlanningApplication['undo']>(() => {
    saved = before;
    return Promise.resolve(receipt());
  });
  const applyEndDay = vi.fn<TodayApplication['applyEndDay']>(() => Promise.resolve(receipt()));
  const today = fakeToday({ getEndDay, applyEndDay, ...options.today });
  const reminders = fakeReminderCommands({ get: () => saved, change });
  const reviews = fakeReviews({
    getReview,
    finishReview,
    saveReview,
    skipReview,
    ...reminders,
    ...options.reviews,
  });
  const planning = todayPlanning({ undo, ...options.planning });
  render(
    todayTree(
      today,
      <>
        <Link to="/">Today</Link>
        <EndDayPage />
      </>,
      {
        path: options.path ?? '/end-day/2026-09-28',
        route: '/end-day/:date',
        planning,
        reviews,
        extraRoutes: <Route path="/" element={<h1>Today page</h1>} />,
      },
    ),
  );
  return {
    getEndDay,
    getReview,
    finishReview,
    saveReview,
    skipReview,
    setReviewReminder: reminders.setReviewReminder,
    turnOffReviewReminder: reminders.turnOffReviewReminder,
    applyEndDay,
    undo,
    release,
    user: userEvent.setup(),
  };
}

/** Whether reloading or closing the page now would ask to leave (the unsaved-changes guard). */
function unloadAsks(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const group = (name: string) => screen.getByRole('group', { name });
const choose = async (user: ReturnType<typeof userEvent.setup>, item: string, option: string) =>
  user.click(within(group(item)).getByRole('radio', { name: option }));
const location = () => screen.getByTestId('location').textContent;
const finishButton = () => screen.getByRole('button', { name: 'Finish review' });

describe('EndDayPage', () => {
  it('shows the day’s Done and Still open lists with every item at Decide later', async () => {
    const { applyEndDay, finishReview, getEndDay, getReview } = renderEndDay();
    expect(screen.getByRole('status')).toHaveTextContent('Opening End day…');
    expect(await screen.findByRole('group', { name: report.title })).toBeVisible();
    expect(getEndDay).toHaveBeenCalledWith('2026-09-28');
    expect(getReview).toHaveBeenCalledWith('daily', '2026-09-28');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'End day' })).toBeVisible();
    expect(screen.getByText('Monday, September 28, 2026')).toBeVisible();
    expect(
      screen.getByText(/Nothing changes until you finish the review\.$/u, { selector: 'p' }),
    ).toBeVisible();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Done', 'Still open', 'Energy and note', 'Focus for Tuesday, September 29']);

    const done = screen.getByRole('list', { name: 'Done on Monday, September 28, 2026' });
    expect(within(done).getByRole('link', { name: invoice.title })).toHaveAttribute(
      'href',
      `/actions/${invoice.id}`,
    );
    expect(within(done).getByText('Routine · Completed')).toBeVisible();

    const open = screen.getByRole('list', { name: 'Still open on Monday, September 28, 2026' });
    expect(within(open).getAllByRole('listitem')).toHaveLength(5);
    for (const title of [report.title, outline.title, venue.title]) {
      const item = group(title);
      expect(within(item).getByRole('radio', { name: 'Decide later' })).toBeChecked();
      expect(
        within(item)
          .getAllByRole('radio')
          .map((radio) => radio.closest('label')?.textContent),
      ).toEqual(['Decide later', carryLabel, 'Move to…', 'Complete', 'Cancel']);
    }
    expect(
      within(group('Evening walk'))
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Decide later', 'Complete', 'Skip']);
    expect(within(group(report.title)).getByText('Planned 14:00–15:00')).toBeVisible();
    expect(group(report.title)).toHaveAccessibleDescription(
      'Planned 14:00–15:00 Carrying or moving marks its 14:00–15:00 time block skipped. Complete or Cancel also completes or cancels that time block.',
    );
    expect(within(group(outline.title)).getByText('Placed on this day')).toBeVisible();
    expect(within(group(venue.title)).getByText('In this day’s focus · In Inbox')).toBeVisible();
    // A planned time on another day gets no choice here.
    expect(screen.queryByRole('group', { name: notes.title })).toBeNull();
    const elsewhere = within(open).getByText(notes.title).closest('li');
    expect(elsewhere).not.toBeNull();
    expect(
      within(elsewhere as HTMLElement).getByText(
        'This Action has a planned time on another day. Change it from that day.',
      ),
    ).toBeVisible();
    expect(
      within(elsewhere as HTMLElement).getByRole('link', {
        name: `Open details for ${notes.title}`,
      }),
    ).toHaveAttribute('href', `/actions/${notes.id}`);

    // The daily review's energy and note start empty; energy is a label, never a measure.
    const energy = group('How was your energy?');
    expect(
      within(energy)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Not noted', 'Low', 'Medium', 'High', 'Focused']);
    expect(within(energy).getByRole('radio', { name: 'Not noted' })).toBeChecked();
    const note = screen.getByRole('textbox', { name: 'Note (optional)' });
    expect(note).toHaveValue('');
    expect(note).toHaveAccessibleDescription('0 of 10,000 characters');
    for (const name of ['Finish review', 'Save for later', 'Skip this review'])
      expect(screen.getByRole('button', { name })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Apply choices' })).toBeNull();
    expect(finishReview).not.toHaveBeenCalled();
    expect(applyEndDay).not.toHaveBeenCalled();
  });

  it('finishes the review in one command and shows a summary with Undo', async () => {
    const { applyEndDay, finishReview, getEndDay, undo, user } = renderEndDay();
    await screen.findByRole('group', { name: report.title });
    await choose(user, report.title, 'Complete');
    await choose(user, outline.title, carryLabel);
    await choose(user, venue.title, 'Move to…');
    await user.click(within(group(venue.title)).getByRole('radio', { name: 'A week' }));
    fireEvent.change(within(group(venue.title)).getByLabelText('Any date in the week'), {
      target: { value: '2026-10-07' },
    });
    expect(within(group(venue.title)).getByText('Moves to the week of Oct 5 – Oct 11, 2026.'));
    await choose(user, 'Evening walk', 'Skip');
    await user.click(finishButton());

    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview).toHaveBeenCalledWith({
      type: 'daily',
      periodKey: '2026-09-28',
      endDay: {
        carryTo: tomorrow,
        actions: [
          { actionId: report.id, revision: 4, decision: { kind: 'complete' } },
          { actionId: outline.id, revision: 2, decision: { kind: 'carry' } },
          {
            actionId: venue.id,
            revision: 1,
            decision: { kind: 'move', period: { kind: 'week', date: '2026-10-07' } },
          },
        ],
        occurrences: [
          {
            occurrence: { routineId: walk.ref.routineId, generation: 1, period: walk.ref.period },
            decision: { kind: 'skip' },
          },
        ],
      },
    });
    expect(applyEndDay).not.toHaveBeenCalled();
    const summary = await screen.findByText('Review finished.');
    const status = summary.closest('[role="status"]');
    expect(status).not.toBeNull();
    expect(
      within(status as HTMLElement)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '1 Action carried to Tuesday, September 29.',
      '1 Action moved.',
      '1 Action completed.',
      '1 routine occurrence skipped.',
    ]);
    // The page re-read the day: the finished review is shown read-only.
    await waitFor(() => expect(getEndDay).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { level: 2, name: 'Decisions' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Finish review' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/');

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('undo-1'));
    // Announced once by the runner, and shown as plain (not live) text.
    expect(
      await screen.findByText('Your End day choices were undone.', { selector: '.end-day-note' }),
    ).toBeVisible();
    expect(screen.queryByText('Review finished.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'End day' })).toHaveFocus(),
    );
    // The review is open again, and every choice starts again at Decide later.
    expect(
      await within(await screen.findByRole('group', { name: outline.title })).findByRole('radio', {
        name: 'Decide later',
      }),
    ).toBeChecked();
  });

  it('announces a second summary even when it reads the same as the first', async () => {
    const { finishReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await choose(user, outline.title, carryLabel);
    await user.click(finishButton());
    const first = (await screen.findByText('Review finished.')).closest('.end-day-summary');
    expect(first).not.toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await screen.findByText('Your End day choices were undone.', { selector: '.end-day-note' });

    await choose(user, outline.title, carryLabel);
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(2));
    // The status region's content is replaced, so the same summary is announced once more.
    await waitFor(() =>
      expect(screen.getByText('Review finished.').closest('.end-day-summary')).not.toBe(first),
    );
    expect(screen.getByText('Review finished.').closest('[role="status"]')).toHaveTextContent(
      'Review finished.1 Action carried to Tuesday, September 29.',
    );
  });

  it('records the energy label and the note with the review', async () => {
    const { finishReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await user.click(within(group('How was your energy?')).getByRole('radio', { name: 'Medium' }));
    await user.type(screen.getByRole('textbox', { name: 'Note (optional)' }), 'A calm, slow day.');
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).toHaveAccessibleDescription(
      '17 of 10,000 characters',
    );
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview).toHaveBeenCalledWith({
      type: 'daily',
      periodKey: '2026-09-28',
      notes: 'A calm, slow day.',
      energy: 'medium',
      endDay: { carryTo: tomorrow, actions: [], occurrences: [] },
    });
    // The finished day shows them read-only.
    expect(await screen.findByRole('heading', { level: 2, name: 'Energy' })).toBeVisible();
    expect(screen.getByText('Medium')).toBeVisible();
    expect(screen.getByText('A calm, slow day.')).toBeVisible();
  });

  it('finishes with nothing chosen: every item stays as it is', async () => {
    const { finishReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview.mock.calls[0]?.[0]).toEqual({
      type: 'daily',
      periodKey: '2026-09-28',
      endDay: { carryTo: tomorrow, actions: [], occurrences: [] },
    });
    expect(await screen.findByText('Everything was left to decide later.')).toBeVisible();
  });

  it('saves the choices for later without applying anything, and says where to resume', async () => {
    const { finishReview, saveReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await choose(user, outline.title, carryLabel);
    await user.click(within(group('How was your energy?')).getByRole('radio', { name: 'High' }));
    await user.type(screen.getByRole('textbox', { name: 'Note (optional)' }), 'Good call.');
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
    // Save never names a carry date and applies nothing.
    expect(saveReview).toHaveBeenCalledWith({
      type: 'daily',
      periodKey: '2026-09-28',
      notes: 'Good call.',
      energy: 'high',
      endDay: {
        actions: [{ actionId: outline.id, revision: 2, decision: { kind: 'carry' } }],
        occurrences: [],
      },
    });
    expect(finishReview).not.toHaveBeenCalled();
    expect(await screen.findByText('Saved. You can resume this review from Review.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    // The form keeps the saved choices, and nothing is left unsaved: leaving asks nothing.
    expect(within(group(outline.title)).getByRole('radio', { name: carryLabel })).toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save for later' })).not.toHaveAttribute(
        'aria-disabled',
      ),
    );
    await user.click(screen.getByRole('link', { name: 'Today' }));
    await waitFor(() => expect(location()).toBe('/'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resumes a saved draft with every choice as it was saved', async () => {
    const draft = savedReview({
      localRevision: 6,
      energy: 'low',
      notes: 'Long day.',
      items: [
        savedItem(actionTarget(outline), 'carry'),
        savedItem(actionTarget(venue), 'move', {
          period: { kind: 'week', date: '2026-10-07' },
        }),
        savedItem(walkTarget, 'complete'),
        savedItem(actionTarget(plannedTomorrow), 'focus', { position: 1 }),
        savedItem(actionTarget(outline), 'focus', { position: 2 }),
      ],
    });
    const { finishReview, user } = renderEndDay({ saved: draft });
    await screen.findByRole('group', { name: outline.title });
    expect(within(group(outline.title)).getByRole('radio', { name: carryLabel })).toBeChecked();
    expect(within(group(venue.title)).getByRole('radio', { name: 'Move to…' })).toBeChecked();
    expect(within(group(venue.title)).getByRole('radio', { name: 'A week' })).toBeChecked();
    expect(within(group(venue.title)).getByLabelText('Any date in the week')).toHaveValue(
      '2026-10-07',
    );
    expect(within(group('Evening walk')).getByRole('radio', { name: 'Complete' })).toBeChecked();
    expect(within(group(report.title)).getByRole('radio', { name: 'Decide later' })).toBeChecked();
    expect(within(group('How was your energy?')).getByRole('radio', { name: 'Low' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).toHaveValue('Long day.');
    expect(draftEditor.props?.value.map((item) => item.label)).toEqual([
      plannedTomorrow.title,
      outline.title,
    ]);

    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview).toHaveBeenCalledWith({
      type: 'daily',
      periodKey: '2026-09-28',
      revision: 6,
      notes: 'Long day.',
      energy: 'low',
      endDay: {
        carryTo: tomorrow,
        actions: [
          { actionId: outline.id, revision: 2, decision: { kind: 'carry' } },
          {
            actionId: venue.id,
            revision: 1,
            decision: { kind: 'move', period: { kind: 'week', date: '2026-10-07' } },
          },
        ],
        occurrences: [
          {
            occurrence: { routineId: walk.ref.routineId, generation: 1, period: walk.ref.period },
            decision: { kind: 'complete' },
          },
        ],
        nextFocus: [
          { kind: 'action', actionId: plannedTomorrow.id },
          { kind: 'action', actionId: outline.id },
        ],
      },
    });
  });

  it('resumes a draft that emptied the next day’s focus with an empty focus', async () => {
    const draft = savedReview({
      localRevision: 3,
      clearedLists: ['next_focus'],
      items: [savedItem(actionTarget(outline), 'carry')],
    });
    const { finishReview, user } = renderEndDay({ saved: draft });
    await screen.findByRole('group', { name: outline.title });
    // Tuesday still has its focus in the plan, but the draft keeps it cleared, as it was saved.
    expect(draftEditor.props?.value).toEqual([]);
    expect(screen.getByRole('list', { name: 'Focus draft' })).toBeEmptyDOMElement();

    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview).toHaveBeenCalledWith({
      type: 'daily',
      periodKey: '2026-09-28',
      revision: 3,
      endDay: {
        carryTo: tomorrow,
        actions: [{ actionId: outline.id, revision: 2, decision: { kind: 'carry' } }],
        occurrences: [],
        nextFocus: [],
      },
    });
    expect(await screen.findByText('Focus for Tuesday, September 29 cleared.')).toBeVisible();
  });

  it('counts a resumed cleared focus as saved: leaving asks nothing', async () => {
    const { user } = renderEndDay({ saved: savedReview({ clearedLists: ['next_focus'] }) });
    await screen.findByRole('group', { name: outline.title });
    await user.click(screen.getByRole('link', { name: 'Today' }));
    await waitFor(() => expect(location()).toBe('/'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('skips the review without applying anything, with Undo', async () => {
    const { finishReview, saveReview, skipReview, undo, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await user.click(screen.getByRole('button', { name: 'Skip this review' }));
    await waitFor(() =>
      expect(skipReview).toHaveBeenCalledWith({ type: 'daily', periodKey: '2026-09-28' }),
    );
    expect(finishReview).not.toHaveBeenCalled();
    expect(saveReview).not.toHaveBeenCalled();
    expect(await screen.findByText('Review skipped.')).toBeVisible();
    // A skipped review can still be finished or saved, but not skipped again.
    expect(
      await screen.findByText(
        'You skipped this review, and nothing was changed. You can still finish it, or save your choices for later.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Skip this review' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'End day' })).toHaveFocus(),
    );
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('undo-1'));
    expect(await screen.findByRole('button', { name: 'Skip this review' })).toBeVisible();
  });

  it('finishes a skipped review with its kept choices and its revision', async () => {
    const skipped = savedReview({
      state: 'skipped',
      localRevision: 4,
      items: [savedItem(actionTarget(outline), 'cancel')],
    });
    const { finishReview, user } = renderEndDay({ saved: skipped });
    await screen.findByRole('group', { name: outline.title });
    expect(within(group(outline.title)).getByRole('radio', { name: 'Cancel' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Skip this review' })).toBeNull();
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview.mock.calls[0]?.[0]).toMatchObject({
      revision: 4,
      endDay: { actions: [{ actionId: outline.id, revision: 2, decision: { kind: 'cancel' } }] },
    });
  });

  it('shows a finished day read-only, including a deleted object', async () => {
    const finished = savedReview({
      state: 'completed',
      energy: 'focused',
      notes: 'Wrapped up early.',
      completedAt: '2026-09-28T21:40:00.000Z' as Instant,
      items: [
        savedItem(actionTarget(outline), 'carry'),
        savedItem(actionTarget(venue), 'move', { period: { kind: 'month', date: '2026-10-01' } }),
        savedItem({ kind: 'deleted' }, 'complete'),
        savedItem(walkTarget, 'skip'),
        savedItem(actionTarget(plannedTomorrow), 'focus', { position: 1 }),
      ],
    });
    const { finishReview } = renderEndDay({ saved: finished });
    expect(await screen.findByRole('heading', { level: 2, name: 'Decisions' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByText('Finished Monday, September 28, 2026 at 21:40. Its choices are kept here.'),
    ).toBeVisible();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Energy', 'Note', 'Decisions', 'Focus chosen']);
    expect(screen.getByText('Focused')).toBeVisible();
    expect(screen.getByText('Wrapped up early.')).toBeVisible();
    expect(
      within(screen.getByRole('list', { name: 'Decisions for Monday, September 28, 2026' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      `${outline.title} · Carried`,
      `${venue.title} · Moved to October 2026`,
      'Deleted object · Completed',
      'Evening walk · Skipped',
    ]);
    expect(
      within(screen.getByRole('list', { name: 'Focus chosen' })).getByText(plannedTomorrow.title),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: 'Finish review' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(finishReview).not.toHaveBeenCalled();
  });

  it('says when a finished day cleared the next day’s focus', async () => {
    renderEndDay({
      saved: savedReview({ state: 'completed', clearedLists: ['next_focus'] }),
    });
    const focus = (await screen.findByRole('heading', { level: 2, name: 'Focus chosen' })).closest(
      'section',
    );
    expect(focus).not.toBeNull();
    expect(
      within(focus as HTMLElement).getByText('The next day’s focus was cleared.'),
    ).toBeVisible();
  });

  it('refuses a focus draft of more than three items before sending anything', async () => {
    const { finishReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await choose(user, outline.title, carryLabel);
    await choose(user, venue.title, carryLabel);
    for (const title of [plannedTomorrow.title, outline.title, venue.title])
      await user.click(screen.getByRole('button', { name: `Choose ${title}` }));
    expect(draftEditor.props?.value).toHaveLength(4);
    await user.click(finishButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'A day’s focus holds up to three items. Remove one to choose another.',
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(finishReview).not.toHaveBeenCalled();
  });

  it('refuses a note over its limit without cutting it or sending anything', async () => {
    const { finishReview, saveReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    const note = screen.getByRole('textbox', { name: 'Note (optional)' });
    fireEvent.change(note, { target: { value: 'x'.repeat(10_001) } });
    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(note).toHaveAccessibleDescription(
      '10,001 of 10,000 characters. Shorten it by 1 to save.',
    );
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The note is over the 10,000-character limit. Shorten it to continue; nothing was saved.',
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(note).toHaveValue('x'.repeat(10_001));
    expect(saveReview).not.toHaveBeenCalled();
    expect(finishReview).not.toHaveBeenCalled();
  });

  it('sets every open Action to carry, says so, and saves nothing', async () => {
    const { finishReview, user } = renderEndDay();
    await screen.findByRole('group', { name: report.title });
    await user.click(
      screen.getByRole('button', { name: 'Carry all open Actions to Tuesday, September 29' }),
    );
    for (const title of [report.title, outline.title, venue.title])
      expect(within(group(title)).getByRole('radio', { name: carryLabel })).toBeChecked();
    expect(
      within(group('Evening walk')).getByRole('radio', { name: 'Decide later' }),
    ).toBeChecked();
    expect(screen.getByText('3 Actions set to carry. Nothing is saved yet.')).toBeInTheDocument();
    expect(finishReview).not.toHaveBeenCalled();
  });

  it('works from the keyboard: choose with Space, finish with Enter', async () => {
    const { finishReview, user } = renderEndDay();
    await screen.findByRole('group', { name: report.title });
    const carry = within(group(outline.title)).getByRole('radio', { name: carryLabel });
    carry.focus();
    await user.keyboard(' ');
    expect(carry).toBeChecked();
    const energy = within(group('How was your energy?')).getByRole('radio', { name: 'Low' });
    energy.focus();
    await user.keyboard(' ');
    expect(energy).toBeChecked();
    finishButton().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview.mock.calls[0]?.[0]).toMatchObject({ energy: 'low' });
  });

  it('states where a move goes before finishing and refuses the past', async () => {
    const { finishReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await choose(user, outline.title, 'Move to…');
    const item = group(outline.title);
    expect(within(item).getByRole('group', { name: `Move “${outline.title}” to` })).toBeVisible();
    expect(within(item).getByRole('radio', { name: 'A day' })).toBeChecked();
    const date = within(item).getByLabelText('Date');
    expect(date).toHaveValue('2026-09-29');
    expect(date).toHaveAccessibleDescription('Moves to Tuesday, September 29, 2026.');
    fireEvent.change(date, { target: { value: '2026-09-20' } });
    expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(date).toHaveAccessibleDescription('Choose today or a later day.');
    await user.click(within(item).getByRole('radio', { name: 'A month' }));
    const month = within(item).getByLabelText('Month');
    expect(within(month).getAllByRole('option')[0]).toHaveTextContent('September 2026');
    expect(month).toHaveAccessibleDescription('Moves to September 2026.');
    await user.click(within(item).getByRole('radio', { name: 'A day' }));

    await user.click(finishButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      `Choose where to move “${outline.title}”. Choose today or a later day.`,
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(finishReview).not.toHaveBeenCalled();
  });

  it('saves the next day’s focus draft with the choices, offering carried Actions', async () => {
    const { finishReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    expect(draftEditor.props?.choices.date).toBe(tomorrow);
    expect(draftEditor.props?.value.map((item) => item.label)).toEqual([kept.title]);
    expect(draftEditor.props?.extraCandidates).toEqual([]);
    expect(screen.getByRole('button', { name: 'Choose Print the handouts' })).toBeVisible();
    expect(screen.queryByRole('button', { name: `Choose ${outline.title}` })).toBeNull();

    await choose(user, outline.title, carryLabel);
    await user.click(screen.getByRole('button', { name: `Choose ${outline.title}` }));
    expect(
      within(screen.getByRole('list', { name: 'Focus draft' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([kept.title, outline.title]);
    expect(screen.getByText('Focus changes are saved when you finish the review.')).toBeVisible();
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    const input = finishReview.mock.calls[0]?.[0];
    expect(input?.type === 'daily' ? input.endDay.nextFocus : null).toEqual([
      { kind: 'action', actionId: kept.id },
      { kind: 'action', actionId: outline.id },
    ]);
    expect(
      await screen.findByText('Focus for Tuesday, September 29 set to 2 items.'),
    ).toBeVisible();
  });

  it('refuses focus on an Action set to Complete or Cancel before sending anything', async () => {
    const view = populated({
      nextFocus: focusChoices({
        date: tomorrow,
        current: [focusActionItem(outline)],
        candidates: [actionCandidate(plannedTomorrow)],
      }),
    });
    const { finishReview, user } = renderEndDay({ view });
    await screen.findByRole('group', { name: outline.title });
    await user.click(screen.getByRole('button', { name: 'Choose Print the handouts' }));
    await choose(user, outline.title, 'Complete');
    await user.click(finishButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `“${outline.title}” is set to Complete, so it cannot be focus for Tuesday, September 29. Remove it from the focus or choose another option.`,
    );
    expect(finishReview).not.toHaveBeenCalled();
  });

  it('uses the day’s unfinished focus as the draft, leaving out finished and resolved items', async () => {
    const getFocusChoices = vi.fn(() =>
      Promise.resolve(
        focusChoices({
          current: [
            focusActionItem(outline, { position: 1 }),
            focusActionItem(invoice, { position: 2 }),
            focusActionItem(report, { position: 3 }),
          ],
        }),
      ),
    );
    const { user } = renderEndDay({ today: { getFocusChoices } });
    await screen.findByRole('group', { name: report.title });
    await choose(user, report.title, 'Cancel');
    await user.click(screen.getByRole('button', { name: 'Use today’s unfinished focus' }));
    expect(getFocusChoices).toHaveBeenCalledWith('2026-09-28');
    await waitFor(() =>
      expect(draftEditor.props?.value.map((item) => item.label)).toEqual([outline.title]),
    );
    expect(
      screen.getByText(
        'Focus for Tuesday, September 29 set to 1 unfinished item from this day. Nothing is saved yet.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps every choice and shows the reason when finishing is refused', async () => {
    const refused: ApplicationResult<CommandReceipt> = {
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: {
          code: 'invalid_value',
          message: 'The day changed. Review your choices again.',
          details: { reason: 'end_day_day_changed' },
        },
      },
    };
    const { user } = renderEndDay({
      reviews: { finishReview: vi.fn(() => Promise.resolve(refused)) },
    });
    await screen.findByRole('group', { name: outline.title });
    await choose(user, outline.title, carryLabel);
    await user.click(within(group('How was your energy?')).getByRole('radio', { name: 'High' }));
    await user.click(finishButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The day changed. Review your choices again.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(within(group(outline.title)).getByRole('radio', { name: carryLabel })).toBeChecked();
    expect(
      within(group('How was your energy?')).getByRole('radio', { name: 'High' }),
    ).toBeChecked();
    expect(screen.queryByText('Review finished.')).toBeNull();
  });

  it('asks before leaving with unsaved choices; Continue editing keeps them', async () => {
    const { finishReview, saveReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await choose(user, outline.title, carryLabel);
    await user.click(screen.getByRole('link', { name: 'Today' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save your changes before leaving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Continue editing' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(location()).toBe('/end-day/2026-09-28');
    expect(within(group(outline.title)).getByRole('radio', { name: carryLabel })).toBeChecked();

    await user.click(screen.getByRole('link', { name: 'Today' }));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(location()).toBe('/'));
    expect(finishReview).not.toHaveBeenCalled();
    expect(saveReview).not.toHaveBeenCalled();
  });

  it('asks before leaving with only a note typed', async () => {
    const { user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await user.type(screen.getByRole('textbox', { name: 'Note (optional)' }), 'Tired.');
    await user.click(screen.getByRole('link', { name: 'Today' }));
    expect(
      await screen.findByRole('dialog', { name: 'Save your changes before leaving?' }),
    ).toBeVisible();
  });

  it('Save in the leave question saves the review for later, then leaves', async () => {
    const { finishReview, saveReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await choose(user, outline.title, carryLabel);
    await user.click(screen.getByRole('link', { name: 'Today' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(location()).toBe('/'));
    expect(saveReview).toHaveBeenCalledTimes(1);
    expect(finishReview).not.toHaveBeenCalled();
  });

  describe('Save for later leaves nothing unsaved', () => {
    type Rendered = ReturnType<typeof renderEndDay>;

    /** Save for later, wait until the saved review is read again, then leave by a link. */
    async function saveThenLeave({ saveReview, user }: Rendered): Promise<void> {
      await user.click(screen.getByRole('button', { name: 'Save for later' }));
      await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
      expect(
        await screen.findByText('Saved. You can resume this review from Review.'),
      ).toBeVisible();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save for later' })).not.toHaveAttribute(
          'aria-disabled',
        ),
      );
      await user.click(screen.getByRole('link', { name: 'Today' }));
      expect(
        screen.queryByRole('dialog', { name: 'Save your changes before leaving?' }),
      ).toBeNull();
      await waitFor(() => expect(location()).toBe('/'));
    }

    it('after a move to a week named by a day other than its first', async () => {
      const rendered = renderEndDay();
      await screen.findByRole('group', { name: outline.title });
      await choose(rendered.user, outline.title, 'Move to…');
      await rendered.user.click(
        within(group(outline.title)).getByRole('radio', { name: 'A week' }),
      );
      // The carry date, a Tuesday, names the week that starts on Monday, September 28.
      expect(within(group(outline.title)).getByLabelText('Any date in the week')).toHaveValue(
        '2026-09-29',
      );
      await saveThenLeave(rendered);
    });

    it('after clearing the next day’s focus', async () => {
      const rendered = renderEndDay();
      await screen.findByRole('group', { name: outline.title });
      await rendered.user.click(screen.getByRole('button', { name: 'Clear the focus draft' }));
      await saveThenLeave(rendered);
      const input = rendered.saveReview.mock.calls[0]?.[0];
      expect(input?.type === 'daily' ? input.endDay.nextFocus : null).toEqual([]);
    });

    it('after a note of only spaces', async () => {
      const rendered = renderEndDay();
      await screen.findByRole('group', { name: outline.title });
      await rendered.user.type(screen.getByRole('textbox', { name: 'Note (optional)' }), '   ');
      await saveThenLeave(rendered);
      expect(rendered.saveReview.mock.calls[0]?.[0]).not.toHaveProperty('notes');
    });

    it('from the moment the save succeeds, before the day is read again', async () => {
      const { release, saveReview, user } = renderEndDay({ holdRereads: true });
      await screen.findByRole('group', { name: outline.title });
      await user.click(within(group('How was your energy?')).getByRole('radio', { name: 'High' }));
      expect(unloadAsks()).toBe(true);
      await user.click(screen.getByRole('button', { name: 'Save for later' }));
      await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
      expect(
        await screen.findByText('Saved. You can resume this review from Review.'),
      ).toBeVisible();
      // The saved review has not been read again yet, and nothing counts as unsaved.
      expect(unloadAsks()).toBe(false);
      await user.click(screen.getByRole('link', { name: 'Today' }));
      expect(
        screen.queryByRole('dialog', { name: 'Save your changes before leaving?' }),
      ).toBeNull();
      await waitFor(() => expect(location()).toBe('/'));
      release();
    });

    it('until a change after the save, which is unsaved again', async () => {
      const { release, user } = renderEndDay({ holdRereads: true });
      await screen.findByRole('group', { name: outline.title });
      await user.click(within(group('How was your energy?')).getByRole('radio', { name: 'High' }));
      await user.click(screen.getByRole('button', { name: 'Save for later' }));
      await screen.findByText('Saved. You can resume this review from Review.');
      expect(unloadAsks()).toBe(false);
      await user.click(within(group('How was your energy?')).getByRole('radio', { name: 'Low' }));
      expect(unloadAsks()).toBe(true);
      release();
      // Read again, the saved review says High, so Low is still unsaved.
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save for later' })).not.toHaveAttribute(
          'aria-disabled',
        ),
      );
      expect(unloadAsks()).toBe(true);
      await user.click(within(group('How was your energy?')).getByRole('radio', { name: 'High' }));
      expect(unloadAsks()).toBe(false);
    });

    it('once Finish succeeds, before the finished day is read again', async () => {
      const { finishReview, release, user } = renderEndDay({ holdRereads: true });
      await screen.findByRole('group', { name: outline.title });
      await choose(user, outline.title, carryLabel);
      expect(unloadAsks()).toBe(true);
      await user.click(finishButton());
      await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('Review finished.')).toBeVisible();
      expect(unloadAsks()).toBe(false);
      release();
      expect(await screen.findByRole('heading', { level: 2, name: 'Decisions' })).toBeVisible();
      expect(unloadAsks()).toBe(false);
    });

    it('after a saved choice for an Action now planned on another day', async () => {
      const rendered = renderEndDay({
        saved: savedReview({ items: [savedItem(actionTarget(notes), 'carry')] }),
      });
      await screen.findByRole('group', { name: outline.title });
      await rendered.user.type(screen.getByRole('textbox', { name: 'Note (optional)' }), 'Done.');
      await saveThenLeave(rendered);
      const input = rendered.saveReview.mock.calls[0]?.[0];
      expect(input?.type === 'daily' ? input.endDay.actions : null).toEqual([]);
    });
  });

  it('leaves without changes, without a question or a command', async () => {
    const { finishReview, saveReview, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    await choose(user, outline.title, carryLabel);
    await user.click(screen.getByRole('button', { name: 'Leave without changes' }));
    await waitFor(() => expect(location()).toBe('/'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(finishReview).not.toHaveBeenCalled();
    expect(saveReview).not.toHaveBeenCalled();
  });

  it('says when nothing is done or open, and when only some open items are shown', async () => {
    renderEndDay({
      view: populated({ completed: [], open: { items: [flexibleItem], total: 230 } }),
    });
    expect(await screen.findByText('Nothing was marked done for this day.')).toBeVisible();
    expect(
      screen.getByText('Showing 1 of 230. The rest stay as they are; you can change them in Plan.'),
    ).toBeVisible();
    cleanup();
    renderEndDay({ view: populated({ open: { items: [], total: 0 } }) });
    expect(await screen.findByText('Nothing is still open for this day.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Carry all/u })).toBeNull();
    expect(finishButton()).toBeVisible();
  });

  it('is not available for a later day and changes nothing', async () => {
    const { finishReview } = renderEndDay({
      path: '/end-day/2026-09-29',
      view: endDayView({ date: tomorrow, available: false, carryTo: tomorrow }),
    });
    expect(
      await screen.findByText('End day is available for today or earlier days.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: 'Finish review' })).toBeNull();
    expect(screen.queryByText(/Carry to/u)).toBeNull();
    expect(finishReview).not.toHaveBeenCalled();
  });

  it('refuses an unreadable day link without reading anything', () => {
    const { getEndDay, getReview } = renderEndDay({ path: '/end-day/2026-02-30' });
    expect(
      screen.getByText('This day link could not be read. Your plan is unchanged.'),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(getEndDay).not.toHaveBeenCalled();
    expect(getReview).not.toHaveBeenCalled();
  });

  it('shows a calm error when the day cannot be read, and tries again', async () => {
    let calls = 0;
    const getEndDay = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('worker')) : Promise.resolve(populated());
    });
    const { user } = renderEndDay({ today: { getEndDay } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'End day could not be read. Your local plan was not changed.',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('group', { name: report.title })).toBeVisible();
  });

  it('uses calm, neutral words only', async () => {
    const { user } = renderEndDay();
    await screen.findByRole('group', { name: report.title });
    await user.click(
      screen.getByRole('button', { name: 'Carry all open Actions to Tuesday, September 29' }),
    );
    await user.click(finishButton());
    await screen.findByText('Review finished.');
    const text = document.body.textContent;
    for (const word of [
      /streak/iu,
      /score/iu,
      /grade/iu,
      /productiv/iu,
      /behind/iu,
      /failed/iu,
      /missed/iu,
      /penalt/iu,
      /\blost\b/iu,
      /\bAI\b/u,
      /%/u,
    ])
      expect(text).not.toMatch(word);
  });
});

describe('End day: Remind me to finish', () => {
  const reminderRegion = () => screen.findByRole('region', { name: 'Reminder' });
  const setTime = (region: HTMLElement, value: string) =>
    fireEvent.change(within(region).getByLabelText('Reminder time'), { target: { value } });

  it('offers a reminder for a saved draft of the day and saves it with Enter, with Undo', async () => {
    const { finishReview, setReviewReminder, undo, user } = renderEndDay({
      saved: savedReview({ localRevision: 6 }),
    });
    const region = await reminderRegion();
    // After the End Day form and outside it, before the day's results.
    expect(region.closest('form')).toBeNull();
    expect(
      finishButton().compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const fieldset = within(region).getByRole('group', {
      name: 'Remind me to finish this review',
    });
    expect(fieldset).toHaveAccessibleDescription(
      'Reminders are saved on this device. Enable browser alerts in Settings for delivery while YelAxis Planner is open; reminders due while it is closed appear in Notifications after reopening.',
    );
    expect(within(fieldset).getByLabelText('Reminder date')).toHaveValue('2026-09-28');

    setTime(region, '21:30');
    within(region).getByLabelText('Reminder time').focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(setReviewReminder).toHaveBeenCalledWith({
        reviewId: reviewId(501),
        revision: 6,
        reminder: { date: '2026-09-28', time: '21:30' },
      }),
    );
    expect(finishReview).not.toHaveBeenCalled();
    const status = await within(region).findByText('Reminder saved.');
    await waitFor(() => expect(status).toHaveFocus());
    expect(
      await within(region).findByText('Saved reminder: Monday, September 28, 2026 at 21:30.'),
    ).toBeVisible();
    await user.click(within(region).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('undo-reminder'));
    expect(
      await within(region).findByText('Undone. The reminder is back as it was.'),
    ).toBeVisible();
  });

  it('offers only the reminder command’s Undo once a reminder command has run', async () => {
    // Skip creates the day's review; its Undo would archive the review and strand a reminder.
    const { skipReview, undo, user } = renderEndDay();
    await screen.findByRole('group', { name: outline.title });
    expect(screen.queryByRole('region', { name: 'Reminder' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Skip this review' }));
    await waitFor(() => expect(skipReview).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Review skipped.')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);

    const region = await reminderRegion();
    setTime(region, '21:30');
    await user.click(within(region).getByRole('button', { name: 'Save reminder' }));
    expect(await within(region).findByText('Reminder saved.')).toBeVisible();
    expect(screen.queryByText('Review skipped.')).toBeNull();
    const undos = screen.getAllByRole('button', { name: 'Undo' });
    expect(undos).toHaveLength(1);
    await user.click(undos[0] as HTMLElement);
    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
    expect(undo).toHaveBeenCalledWith('undo-reminder');
    expect(
      await within(region).findByText('Undone. The reminder is back as it was.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('turns off a finished day’s reminder, offering nothing else to change', async () => {
    const finished = savedReview({
      state: 'completed',
      completedAt: '2026-09-28T21:40:00.000Z' as Instant,
      reminder: reminderView('2026-09-28', '21:00', { localRevision: 4 }),
    });
    const { turnOffReviewReminder, user } = renderEndDay({ saved: finished });
    const region = await reminderRegion();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Energy', 'Note', 'Decisions', 'Focus chosen', 'Reminder']);
    expect(
      within(region).getByText('Saved reminder: Monday, September 28, 2026 at 21:00.'),
    ).toBeVisible();
    expect(within(region).queryByLabelText('Reminder date')).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Save reminder' })).toBeNull();
    expect(
      region.compareDocumentPosition(screen.getByRole('link', { name: 'Back to Today' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(within(region).getByRole('button', { name: 'Turn off reminder' }));
    await waitFor(() =>
      expect(turnOffReviewReminder).toHaveBeenCalledWith({
        reviewId: reviewId(501),
        reminderRevision: 4,
      }),
    );
    const status = await within(region).findByText('Reminder turned off.');
    await waitFor(() => expect(status).toHaveFocus());
    expect(await within(region).findByText('No reminder is saved.')).toBeVisible();
    expect(within(region).getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('keeps the day’s choices unsaved while a reminder is saved', async () => {
    const { setReviewReminder, user } = renderEndDay({ saved: savedReview() });
    await screen.findByRole('group', { name: outline.title });
    await choose(user, outline.title, carryLabel);
    const region = await reminderRegion();
    setTime(region, '21:30');
    await user.click(within(region).getByRole('button', { name: 'Save reminder' }));
    await waitFor(() => expect(setReviewReminder).toHaveBeenCalledTimes(1));
    expect(await within(region).findByText('Reminder saved.')).toBeVisible();
    // The reminder changed nothing in the day's choices: the carry is kept and still unsaved.
    expect(within(group(outline.title)).getByRole('radio', { name: carryLabel })).toBeChecked();
    expect(unloadAsks()).toBe(true);
  });
});
