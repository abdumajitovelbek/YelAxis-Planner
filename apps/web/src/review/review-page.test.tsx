// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ApplicationResult,
  CommandReceipt,
  PlanningApplication,
  ReviewApplication,
  ReviewInput,
  ReviewItemTargetView,
  ReviewListKey,
  ReviewView,
  SavedReview,
  SavedReviewItem,
} from '@yelaxis/application';
import type { CalendarDate, Instant, UUID } from '@yelaxis/domain';

import { installDialogPolyfill, receipt, weekPlan } from '../plan/__fixtures__/c1-planning-fake';
import { focusActionItem } from '../today/__fixtures__/today-fake';
import {
  betaReady,
  brief,
  course,
  fakeReminderCommands,
  fakeReviews,
  firstDayChoices,
  firstRace,
  halfMarathon,
  health,
  monthlyContextWithoutTheme,
  monthlyView,
  objectRow,
  outline,
  pausedOutcome,
  pausedProject,
  reminderView,
  reviewAction,
  reviewId,
  reviewPeriod,
  reviewPlanning,
  reviewTree,
  savedItem,
  savedReview,
  shed,
  weeklyContext,
  weeklyView,
  work,
  yearlyContextWithoutDirection,
  yearlyView,
} from './__fixtures__/review-fake';
import { ReviewPeriodPage } from './review-page';

beforeAll(() => installDialogPolyfill());
afterEach(() => cleanup());

const target = (
  kind: 'axis' | 'outcome' | 'milestone' | 'project' | 'action',
  id: string,
  title: string,
): ReviewItemTargetView => ({ kind, id: id as UUID, title, state: 'active' });

/** The saved review the application would keep for a Save of `input`. */
function mirror(view: ReviewView, input: ReviewInput): SavedReview {
  const items: SavedReviewItem[] = [];
  // A list named as empty is kept as cleared; an omitted one is left to the plan.
  const clearedLists: ReviewListKey[] = [];
  if (input.type === 'weekly') {
    if (input.commitments?.length === 0) clearedLists.push('commitments');
    if (input.firstDayFocus?.length === 0) clearedLists.push('first_day_focus');
  }
  if (input.type === 'weekly' && view.type === 'weekly' && view.context !== null) {
    const context = view.context;
    const title = (id: string): string =>
      context.commitmentCandidates.items.find((candidate) => candidate.id === id)?.title ??
      context.projects.items.find((project) => project.id === id)?.title ??
      context.axes.items.find((axis) => axis.id === id)?.title ??
      '';
    for (const project of input.projects)
      items.push(savedItem(target('project', project.id, title(project.id)), project.decision));
    for (const note of input.axisNotes)
      items.push(
        savedItem(target('axis', note.axisId, title(note.axisId)), 'note', { note: note.note }),
      );
    (input.commitments ?? []).forEach((commitment, index) =>
      items.push(
        savedItem(target(commitment.kind, commitment.id, title(commitment.id)), 'commit', {
          position: index + 1,
        }),
      ),
    );
    (input.firstDayFocus ?? []).forEach((focus, index) => {
      if (focus.kind === 'action')
        items.push(
          savedItem(target('action', focus.actionId, title(focus.actionId)), 'focus', {
            position: index + 1,
          }),
        );
    });
  }
  return savedReview({
    state: 'draft',
    localRevision: (view.saved?.localRevision ?? 0) + 1,
    items,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(clearedLists.length === 0 ? {} : { clearedLists }),
    // Saving never changes the review's reminder.
    ...(view.saved?.reminder === undefined ? {} : { reminder: view.saved.reminder }),
  });
}

function renderReview(
  options: {
    readonly path?: string;
    readonly view?: ReviewView | null;
    readonly reviews?: Partial<ReviewApplication>;
    readonly planning?: Partial<PlanningApplication>;
    /**
     * Hold every read of the review after the first until `release()`, like a slow worker: the
     * page shows a command's result before it has read the saved review again.
     */
    readonly holdRereads?: boolean;
  } = {},
) {
  // The fake keeps one review like the application: Finish, Save, and Skip change it; Undo restores.
  let view: ReviewView | null = options.view === undefined ? weeklyView() : options.view;
  let before = view;
  const change = (next: ReviewView | null, undoId?: string): ApplicationResult<CommandReceipt> => {
    before = view;
    view = next;
    return receipt(undoId);
  };
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getReview = vi.fn<ReviewApplication['getReview']>(async () => {
    const current = view;
    if (options.holdRereads === true && getReview.mock.calls.length > 1) await held;
    return current;
  });
  const finishReview = vi.fn<ReviewApplication['finishReview']>(() =>
    Promise.resolve(
      change(
        view === null
          ? null
          : {
              ...view,
              saved: savedReview({
                state: 'completed',
                completedAt: '2026-09-30T19:00:00.000Z' as Instant,
                // Finishing never changes the review's reminder.
                ...(view.saved?.reminder === undefined ? {} : { reminder: view.saved.reminder }),
              }),
              editable: false,
              context: null,
            },
      ),
    ),
  );
  const saveReview = vi.fn<ReviewApplication['saveReview']>((input) =>
    Promise.resolve(change(view === null ? null : { ...view, saved: mirror(view, input) })),
  );
  const skipReview = vi.fn<ReviewApplication['skipReview']>(() =>
    Promise.resolve(
      change(
        view === null
          ? null
          : { ...view, saved: savedReview({ ...(view.saved ?? {}), state: 'skipped' }) },
      ),
    ),
  );
  const undo = vi.fn<PlanningApplication['undo']>(() => {
    view = before;
    return Promise.resolve(receipt());
  });
  const reminders = fakeReminderCommands({
    get: () => view?.saved ?? null,
    change: (saved, undoId) => change(view === null ? null : { ...view, saved }, undoId),
  });
  const reviews = fakeReviews({
    getReview,
    finishReview,
    saveReview,
    skipReview,
    ...reminders,
    ...options.reviews,
  });
  const planning = reviewPlanning({ undo, ...options.planning });
  render(
    reviewTree(reviews, <ReviewPeriodPage />, {
      path: options.path ?? '/review/weekly/2026-09-21',
      route: '/review/:type/:key',
      planning,
      extraRoutes: (
        <>
          <Route path="/review" element={<h1>Review overview</h1>} />
          <Route path="/end-day/:date" element={<h1>End day page</h1>} />
          <Route path="/inbox" element={<h1>Inbox page</h1>} />
        </>
      ),
    }),
  );
  return {
    getReview,
    finishReview,
    saveReview,
    skipReview,
    setReviewReminder: reminders.setReviewReminder,
    turnOffReviewReminder: reminders.turnOffReviewReminder,
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
const radioLabels = (name: string) =>
  within(group(name))
    .getAllByRole('radio')
    .map((radio) => radio.closest('label')?.textContent);
const section = (name: string) =>
  screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;
const location = () => screen.getByTestId('location').textContent;
const finishButton = () => screen.getByRole('button', { name: 'Finish review' });
const h2s = () =>
  screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);

describe('Review page: routes and states', () => {
  it('opens End Day for a daily review', async () => {
    const { getReview } = renderReview({ path: '/review/daily/2026-09-29' });
    expect(await screen.findByRole('heading', { level: 1, name: 'End day page' })).toBeVisible();
    expect(location()).toBe('/end-day/2026-09-29');
    expect(getReview).not.toHaveBeenCalled();
  });

  it.each([
    '/review/quarterly/2026',
    '/review/weekly/2026-13-40',
    '/review/monthly/2026-9',
    '/review/yearly/26',
    '/review/daily/2026-02-30',
  ])('shows a calm not-found state for %s without reading anything', (path) => {
    const { getReview } = renderReview({ path });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', { level: 1, name: 'This review is not available' }),
    ).toBeVisible();
    expect(
      screen.getByText('This review link could not be read. Your plan is unchanged.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to Review' })).toHaveAttribute('href', '/review');
    expect(getReview).not.toHaveBeenCalled();
  });

  it('shows not found when the application has no such review', async () => {
    const { getReview } = renderReview({ view: null });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This review is not available' }),
    ).toBeVisible();
    expect(getReview).toHaveBeenCalledWith('weekly', '2026-09-21');
  });

  it('opens with a loading state and reports a failed read calmly', async () => {
    let calls = 0;
    const getReview = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('worker')) : Promise.resolve(weeklyView());
    });
    const { user } = renderReview({ reviews: { getReview } });
    expect(screen.getByRole('status')).toHaveTextContent('Opening this review…');
    expect(screen.getByRole('heading', { level: 1, name: 'Weekly review' })).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This review could not be read. Your local plan was not changed.',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Looking back' })).toBeVisible();
  });

  it('says a period that has not started has nothing to review yet', async () => {
    const future = reviewPeriod('weekly', '2026-10-05');
    renderReview({
      path: '/review/weekly/2026-10-05',
      view: weeklyView({
        period: future,
        due: 'not_due',
        reviewable: false,
        editable: false,
        context: null,
        currentCheckpoint: reviewPeriod('weekly', '2026-09-21'),
      }),
    });
    expect(await screen.findByText('This period has not started yet.')).toBeVisible();
    expect(screen.getByText('Week of October 5–11')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the current weekly review' })).toHaveAttribute(
      'href',
      '/review/weekly/2026-09-21',
    );
    expect(screen.queryByRole('button', { name: 'Finish review' })).toBeNull();
  });

  it('explains a week that no longer starts on the first weekday', async () => {
    const sundayWeek = reviewPeriod('weekly', '2026-09-20');
    renderReview({
      path: '/review/weekly/2026-09-20',
      view: weeklyView({
        period: sundayWeek,
        aligned: false,
        editable: false,
        context: null,
        currentCheckpoint: reviewPeriod('weekly', '2026-09-21'),
      }),
    });
    expect(
      await screen.findByText(
        'This week starts on Sunday. Your weeks now start on Monday, so weekly reviews look at weeks that start on Monday. Nothing was saved for this week.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the current weekly review' })).toHaveAttribute(
      'href',
      '/review/weekly/2026-09-21',
    );
    expect(screen.queryByRole('button', { name: 'Finish review' })).toBeNull();
    // A week that is never offered has no status or due line of its own.
    expect(screen.queryByText('Not started · Ready when you are')).toBeNull();
  });

  it('points a draft of another period to the current review and keeps it editable', async () => {
    const earlier = reviewPeriod('weekly', '2026-09-14');
    renderReview({
      path: '/review/weekly/2026-09-14',
      view: weeklyView({
        period: earlier,
        saved: savedReview(),
        currentCheckpoint: reviewPeriod('weekly', '2026-09-21'),
      }),
    });
    expect(
      await screen.findByText(
        'This review is for the week of September 14–20. The current weekly review is for the week of September 21–27.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the current weekly review' })).toHaveAttribute(
      'href',
      '/review/weekly/2026-09-21',
    );
    expect(finishButton()).toBeVisible();
    expect(screen.getByText('Saved for later · Ready when you are')).toBeVisible();
  });

  it('shows a finished review read-only, naming deleted objects', async () => {
    const finished = savedReview({
      state: 'completed',
      notes: 'A steady week.',
      completedAt: '2026-09-27T18:30:00.000Z' as Instant,
      items: [
        savedItem(target('project', course.id, course.title), 'continue'),
        savedItem({ kind: 'deleted' }, 'pause'),
        savedItem(target('axis', health.id, health.title), 'note', { note: 'Morning walks.' }),
        savedItem(target('action', brief.id, brief.title), 'commit', { position: 2 }),
        savedItem({ kind: 'deleted' }, 'commit', { position: 1 }),
        savedItem(target('action', outline.id, outline.title), 'focus', { position: 1 }),
      ],
    });
    const { finishReview } = renderReview({
      view: weeklyView({ saved: finished, editable: false, context: null }),
    });
    expect(
      await screen.findByText(
        'Finished Sunday, September 27, 2026 at 18:30. Its decisions are kept here.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Done')).toBeVisible();
    expect(h2s()).toEqual([
      'Notes',
      'What supported each Axis',
      'Decisions',
      'Commitments',
      'Focus',
    ]);
    expect(within(section('Notes')).getByText('A steady week.')).toBeVisible();
    expect(
      within(section('Decisions'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([`${course.title} · Continued`, 'Deleted object · Paused']);
    expect(
      within(section('What supported each Axis'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['HealthMorning walks.']);
    expect(
      within(section('Commitments'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Deleted object', brief.title]);
    expect(within(section('Focus')).getByText(outline.title)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Review' })).toHaveAttribute('href', '/review');
    expect(screen.queryByRole('button', { name: 'Finish review' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(finishReview).not.toHaveBeenCalled();
  });

  it('shows a finished monthly theme and yearly direction', async () => {
    renderReview({
      path: '/review/monthly/2026-09',
      view: monthlyView({
        saved: savedReview({ state: 'completed', themeText: 'Rest and repair' }),
        editable: false,
        context: null,
      }),
    });
    expect(await screen.findByText('Theme chosen: Rest and repair')).toBeVisible();
    expect(screen.getByText('This review is finished. Its decisions are kept here.')).toBeVisible();
    expect(screen.getByText('Everything was left to decide later.')).toBeVisible();
    cleanup();
    renderReview({
      path: '/review/yearly/2026',
      view: yearlyView({
        saved: savedReview({
          state: 'completed',
          direction: { choice: 'new', text: 'Grow slowly.' },
        }),
        editable: false,
        context: null,
      }),
    });
    expect(await screen.findByText('New direction: Grow slowly.')).toBeVisible();
    expect(screen.getByText('No retrospective was written.')).toBeVisible();
  });

  it('says when a finished or skipped review cleared the commitments or the focus', async () => {
    renderReview({
      view: weeklyView({
        saved: savedReview({
          state: 'completed',
          clearedLists: ['commitments', 'first_day_focus'],
        }),
        editable: false,
        context: null,
      }),
    });
    expect(
      await within(await screen.findByRole('region', { name: 'Commitments' })).findByText(
        'The week’s commitments were cleared.',
      ),
    ).toBeVisible();
    expect(within(section('Focus')).getByText('The first day’s focus was cleared.')).toBeVisible();
    cleanup();
    renderReview({
      view: weeklyView({
        saved: savedReview({ state: 'skipped', clearedLists: ['commitments'] }),
      }),
    });
    expect(
      await within(await screen.findByRole('region', { name: 'Commitments' })).findByText(
        'Saved choice: clear the week’s commitments.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Focus' })).toBeNull();
  });

  it('opens a skipped review read-only; Resume review brings back its choices', async () => {
    const skipped = savedReview({
      state: 'skipped',
      localRevision: 8,
      items: [savedItem(target('project', shed.id, shed.title), 'pause')],
    });
    const { finishReview, user } = renderReview({ view: weeklyView({ saved: skipped }) });
    expect(
      await screen.findByText(
        'You skipped this review. Nothing in your plan was changed, and the choices you saved are kept.',
      ),
    ).toBeVisible();
    expect(
      within(section('Decisions'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([`${shed.title} · Pause`]);
    expect(screen.queryByRole('button', { name: 'Finish review' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Resume review' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Weekly review' })).toHaveFocus();
    expect(within(group(shed.title)).getByRole('radio', { name: 'Pause' })).toBeChecked();
    // A skipped review can be finished or saved again, not skipped again.
    expect(screen.queryByRole('button', { name: 'Skip this review' })).toBeNull();
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview.mock.calls[0]?.[0]).toMatchObject({
      revision: 8,
      projects: [{ id: shed.id, revision: 7, decision: 'pause' }],
    });
  });
});

describe('Review page: weekly review', () => {
  it('shows the week, the Inbox, Projects, Axes, the week ahead, commitments, focus, and notes', async () => {
    const getWeekPlan = vi.fn<PlanningApplication['getWeekPlan']>(() =>
      Promise.resolve(weekPlan()),
    );
    renderReview({ planning: { getWeekPlan } });
    expect(await screen.findByRole('heading', { level: 2, name: 'Looking back' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Weekly review' })).toBeVisible();
    expect(screen.getByText('Week of September 21–27')).toBeVisible();
    expect(screen.getByText('Not started · Ready when you are')).toBeVisible();
    expect(screen.getByRole('link', { name: '← Review' })).toHaveAttribute('href', '/review');
    expect(h2s()).toEqual([
      'Looking back',
      'Inbox',
      'Projects',
      'Axes',
      'This week',
      'Commitments',
      'Focus for Wednesday, September 30',
      'Notes',
    ]);

    const back = section('Looking back');
    expect(within(back).getByRole('heading', { level: 3, name: 'Done (1)' })).toBeVisible();
    expect(within(back).getByRole('heading', { level: 3, name: 'Still open (2)' })).toBeVisible();
    expect(
      within(back).getByRole('list', { name: 'Done in the week of September 21–27' }),
    ).toHaveTextContent('Send the invoice');
    expect(
      within(back).getAllByRole('list', { name: 'Still open from the week of September 21–27' })[0]
        ?.textContent,
    ).toBe(`${outline.title}Call the venue · In Inbox`);
    expect(within(back).getByText('Routine occurrences: 4 completed, 1 skipped.')).toBeVisible();
    expect(
      within(back).getByRole('link', { name: 'Carry unfinished work in Plan' }),
    ).toHaveAttribute('href', '/plan/week/2026-09-28');

    const inbox = section('Inbox');
    expect(within(inbox).getByText('3 Actions are in your Inbox.')).toBeVisible();
    expect(within(inbox).getByRole('link', { name: 'Open Inbox' })).toHaveAttribute(
      'href',
      '/inbox',
    );

    expect(radioLabels(course.title)).toEqual(['Decide later', 'Continue', 'Pause']);
    expect(within(group(course.title)).getByRole('radio', { name: 'Decide later' })).toBeChecked();
    expect(group(course.title)).toHaveAccessibleDescription(
      `Active · Axis: Work Next Action: ${brief.title}`,
    );
    expect(group(shed.title)).toHaveAccessibleDescription('Blocked No next Action');
    expect(screen.getByRole('link', { name: `Open details for ${course.title}` })).toHaveAttribute(
      'href',
      `/projects/${course.id}`,
    );

    const healthNote = screen.getByRole('textbox', { name: 'What supported Health?' });
    expect(healthNote).toHaveAccessibleDescription('0 of 2,000 characters');
    expect(screen.getByRole('textbox', { name: `What supported ${work.title}?` })).toHaveValue('');

    const week = section('This week');
    expect(within(week).getByText('Week of September 28 – October 4')).toBeVisible();
    expect(
      await within(week).findByText(
        '8 hours planned. Available time is defined for 1 of 7 days (8 hours).',
      ),
    ).toBeVisible();
    expect(getWeekPlan).toHaveBeenCalledWith('2026-09-28');
    expect(
      within(within(week).getByRole('list', { name: 'Fixed work this week' })).getByRole(
        'listitem',
      ),
    ).toHaveTextContent('Dentist · Tue, Sep 29 09:00 – 10:00 · Hard commitment');
    expect(within(week).getByRole('link', { name: 'Place fixed work in Plan' })).toHaveAttribute(
      'href',
      '/plan/week/2026-09-28',
    );

    const commitments = section('Commitments');
    expect(
      within(commitments).getByText(
        'Choose up to three commitments for the week of September 28 – October 4, in your order. Nothing is chosen for you.',
      ),
    ).toBeVisible();
    // Only the Week's current commitment starts chosen; nothing else is preselected.
    expect(within(commitments).getByRole('checkbox', { name: outline.title })).toBeChecked();
    for (const name of [brief.title, course.title, shed.title, betaReady.title])
      expect(within(commitments).getByRole('checkbox', { name })).not.toBeChecked();
    expect(within(commitments).getByText('1 of 3 chosen')).toBeVisible();

    const focus = section('Focus for Wednesday, September 30');
    expect(within(focus).getByRole('checkbox', { name: outline.title })).not.toBeChecked();
    expect(within(focus).getByText('No focus chosen.')).toBeVisible();

    const notes = section('Notes');
    expect(
      within(notes)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['What supported each Axis?', 'What was unrealistic?', 'What is fixed next week?']);
    expect(
      within(notes).getByRole('textbox', { name: 'Notes (optional)' }),
    ).toHaveAccessibleDescription(
      'Questions you might answer: What supported each Axis? What was unrealistic? What is fixed next week? 0 of 10,000 characters',
    );
    for (const name of ['Finish review', 'Save for later', 'Skip this review'])
      expect(screen.getByRole('button', { name })).toBeVisible();
  });

  it('finishes with every decision in one command, then offers Undo', async () => {
    const { finishReview, undo, user } = renderReview();
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(within(group(course.title)).getByRole('radio', { name: 'Continue' }));
    await user.click(within(group(shed.title)).getByRole('radio', { name: 'Pause' }));
    await user.type(
      screen.getByRole('textbox', { name: 'What supported Health?' }),
      'Morning walks',
    );
    const commitments = section('Commitments');
    await user.click(within(commitments).getByRole('checkbox', { name: brief.title }));
    await user.click(within(commitments).getByRole('checkbox', { name: betaReady.title }));
    expect(within(commitments).getByText('3 of 3 chosen')).toBeVisible();
    const blocked = within(commitments).getByRole('checkbox', { name: course.title });
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(blocked).toHaveAccessibleDescription(
      'Project · Active Three commitments chosen. Clear one to choose another.',
    );
    await user.click(blocked);
    expect(blocked).not.toBeChecked();
    // Reorder from the keyboard.
    const up = within(commitments).getByRole('button', { name: `Move ${betaReady.title} up` });
    up.focus();
    await user.keyboard('{Enter}');
    expect(
      within(within(commitments).getByRole('list', { name: 'Commitment order' }))
        .getAllByRole('listitem')
        .map(
          (item) => within(item).getByText(/./u, { selector: '.focus-order-title' }).textContent,
        ),
    ).toEqual([outline.title, betaReady.title, brief.title]);
    await waitFor(() =>
      expect(
        within(commitments).getByRole('button', { name: `Move ${betaReady.title} up` }),
      ).toHaveFocus(),
    );
    await user.click(
      within(section('Focus for Wednesday, September 30')).getByRole('checkbox', {
        name: brief.title,
      }),
    );
    await user.type(screen.getByRole('textbox', { name: 'Notes (optional)' }), 'Too much travel.');
    await user.click(finishButton());

    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview).toHaveBeenCalledWith({
      type: 'weekly',
      periodKey: '2026-09-21',
      notes: 'Too much travel.',
      projects: [
        { id: course.id, revision: 4, decision: 'continue' },
        { id: shed.id, revision: 7, decision: 'pause' },
      ],
      axisNotes: [{ axisId: health.id, note: 'Morning walks' }],
      commitments: [
        { kind: 'action', id: outline.id },
        { kind: 'milestone', id: betaReady.id },
        { kind: 'action', id: brief.id },
      ],
      firstDayFocus: [{ kind: 'action', actionId: brief.id }],
    });
    expect(await screen.findByText('Review finished.')).toBeVisible();
    // The page re-read the review: it is history now.
    expect(await screen.findByText(/^Finished Wednesday, September 30, 2026/u)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Finish review' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Weekly review' })).toHaveFocus(),
    );

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('undo-1'));
    expect(
      await screen.findByText('Undone. Your plan and this review are back as they were.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Finish review' })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Weekly review' })).toHaveFocus(),
    );
  });

  it('finishes with nothing chosen: commitments and focus stay as they are', async () => {
    const { finishReview, user } = renderReview();
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview.mock.calls[0]?.[0]).toEqual({
      type: 'weekly',
      periodKey: '2026-09-21',
      projects: [],
      axisNotes: [],
    });
  });

  it('saves for later without applying anything; nothing is left unsaved', async () => {
    const { finishReview, saveReview, user } = renderReview();
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(within(group(shed.title)).getByRole('radio', { name: 'Pause' }));
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
    expect(saveReview).toHaveBeenCalledWith({
      type: 'weekly',
      periodKey: '2026-09-21',
      projects: [{ id: shed.id, revision: 7, decision: 'pause' }],
      axisNotes: [],
    });
    expect(finishReview).not.toHaveBeenCalled();
    expect(await screen.findByText('Saved. You can resume this review from Review.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    await screen.findByText('Saved for later · Ready when you are');
    expect(within(group(shed.title)).getByRole('radio', { name: 'Pause' })).toBeChecked();
    await user.click(screen.getByRole('link', { name: '← Review' }));
    await waitFor(() => expect(location()).toBe('/review'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resumes a saved draft with every choice and sends its revision', async () => {
    const draft = savedReview({
      localRevision: 5,
      notes: 'Half done.',
      items: [
        savedItem(target('project', shed.id, shed.title), 'pause'),
        savedItem(target('axis', health.id, health.title), 'note', { note: 'Walks.' }),
        savedItem(target('action', outline.id, outline.title), 'commit', { position: 2 }),
        savedItem(target('action', brief.id, brief.title), 'commit', { position: 1 }),
        savedItem(target('action', outline.id, outline.title), 'focus', { position: 1 }),
      ],
    });
    const { finishReview, user } = renderReview({ view: weeklyView({ saved: draft }) });
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    expect(within(group(shed.title)).getByRole('radio', { name: 'Pause' })).toBeChecked();
    expect(within(group(course.title)).getByRole('radio', { name: 'Decide later' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'What supported Health?' })).toHaveValue('Walks.');
    expect(screen.getByRole('textbox', { name: 'Notes (optional)' })).toHaveValue('Half done.');
    const commitments = section('Commitments');
    expect(
      within(within(commitments).getByRole('list', { name: 'Commitment order' }))
        .getAllByRole('listitem')
        .map(
          (item) => within(item).getByText(/./u, { selector: '.focus-order-title' }).textContent,
        ),
    ).toEqual([brief.title, outline.title]);
    const focus = section('Focus for Wednesday, September 30');
    expect(within(focus).getByRole('checkbox', { name: outline.title })).toBeChecked();

    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview).toHaveBeenCalledWith({
      type: 'weekly',
      periodKey: '2026-09-21',
      revision: 5,
      notes: 'Half done.',
      projects: [{ id: shed.id, revision: 7, decision: 'pause' }],
      axisNotes: [{ axisId: health.id, note: 'Walks.' }],
      commitments: [
        { kind: 'action', id: brief.id },
        { kind: 'action', id: outline.id },
      ],
      firstDayFocus: [{ kind: 'action', actionId: outline.id }],
    });
  });

  /** The plan commits the week to the outline and focuses the first day on it. */
  const plannedWeek = () =>
    weeklyContext({
      firstDayFocus: firstDayChoices({ current: [focusActionItem(outline)] }),
    });

  it('resumes a draft that emptied the commitments and the focus with empty lists', async () => {
    const draft = savedReview({
      localRevision: 4,
      clearedLists: ['commitments', 'first_day_focus'],
    });
    const { finishReview, user } = renderReview({
      view: weeklyView({ saved: draft, context: plannedWeek() }),
    });
    const commitments = await screen.findByRole('region', { name: 'Commitments' });
    // The plan still has them; the draft keeps them cleared, as it was saved.
    expect(within(commitments).getByText('No commitments chosen.')).toBeVisible();
    expect(within(commitments).getByRole('checkbox', { name: outline.title })).not.toBeChecked();
    const focus = section('Focus for Wednesday, September 30');
    expect(within(focus).getByRole('checkbox', { name: outline.title })).not.toBeChecked();
    expect(within(focus).queryByRole('button', { name: `Remove ${outline.title}` })).toBeNull();

    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview).toHaveBeenCalledWith({
      type: 'weekly',
      periodKey: '2026-09-21',
      revision: 4,
      projects: [],
      axisNotes: [],
      commitments: [],
      firstDayFocus: [],
    });
  });

  it('counts a resumed cleared list as saved: leaving asks nothing', async () => {
    const { user } = renderReview({
      view: weeklyView({
        saved: savedReview({ clearedLists: ['commitments', 'first_day_focus'] }),
        context: plannedWeek(),
      }),
    });
    await screen.findByRole('region', { name: 'Commitments' });
    await user.click(screen.getByRole('link', { name: '← Review' }));
    await waitFor(() => expect(location()).toBe('/review'));
    expect(screen.queryByRole('dialog', { name: 'Save your changes before leaving?' })).toBeNull();
  });

  it('follows the plan again for a list chosen as the plan has it', async () => {
    // Only the commitments were cleared; the focus follows the plan.
    const { saveReview, user } = renderReview({
      view: weeklyView({
        saved: savedReview({ localRevision: 2, clearedLists: ['commitments'] }),
        context: plannedWeek(),
      }),
    });
    const focus = await screen.findByRole('region', { name: 'Focus for Wednesday, September 30' });
    expect(within(focus).getByRole('checkbox', { name: outline.title })).toBeChecked();
    const commitments = section('Commitments');
    await user.click(within(commitments).getByRole('checkbox', { name: outline.title }));
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
    // Choosing what the plan already has sends nothing, so the cleared list is forgotten.
    expect(saveReview).toHaveBeenCalledWith({
      type: 'weekly',
      periodKey: '2026-09-21',
      revision: 2,
      projects: [],
      axisNotes: [],
    });
  });

  it('skips without applying anything, with Undo', async () => {
    const { finishReview, saveReview, skipReview, undo, user } = renderReview();
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(screen.getByRole('button', { name: 'Skip this review' }));
    await waitFor(() =>
      expect(skipReview).toHaveBeenCalledWith({ type: 'weekly', periodKey: '2026-09-21' }),
    );
    expect(finishReview).not.toHaveBeenCalled();
    expect(saveReview).not.toHaveBeenCalled();
    expect(await screen.findByText('Review skipped.')).toBeVisible();
    expect(
      await screen.findByText(
        'You skipped this review. Nothing in your plan was changed, and the choices you saved are kept.',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('undo-1'));
    expect(await screen.findByRole('button', { name: 'Skip this review' })).toBeVisible();
  });

  it('asks before skipping with unsaved changes', async () => {
    const { skipReview, user } = renderReview();
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(within(group(shed.title)).getByRole('radio', { name: 'Pause' }));
    await user.click(screen.getByRole('button', { name: 'Skip this review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Skip this review?' });
    expect(dialog).toHaveTextContent(
      'Your unsaved changes will not be kept. Skipping changes nothing in your plan, and you can undo it.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Continue editing' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(skipReview).not.toHaveBeenCalled();
    expect(within(group(shed.title)).getByRole('radio', { name: 'Pause' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Skip this review' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Skip without saving',
      }),
    );
    await waitFor(() => expect(skipReview).toHaveBeenCalledTimes(1));
  });

  it('shows the application’s refusal calmly and keeps every choice', async () => {
    const refused: ApplicationResult<CommandReceipt> = {
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: {
          code: 'invalid_value',
          message: 'This plan changed. Review it again.',
          details: { reason: 'review_stale' },
        },
      },
    };
    const { user } = renderReview({
      reviews: { finishReview: vi.fn(() => Promise.resolve(refused)) },
    });
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(within(group(shed.title)).getByRole('radio', { name: 'Pause' }));
    await user.click(finishButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This plan changed. Review it again.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(within(group(shed.title)).getByRole('radio', { name: 'Pause' })).toBeChecked();
    expect(screen.queryByText('Review finished.')).toBeNull();
  });

  it('refuses a note over its limit without cutting it or sending anything', async () => {
    const { finishReview, user } = renderReview();
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    const note = screen.getByRole('textbox', { name: 'What supported Health?' });
    fireEvent.change(note, { target: { value: 'y'.repeat(2_001) } });
    expect(note).toHaveAttribute('aria-invalid', 'true');
    await user.click(finishButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The note about Health is over the 2,000-character limit. Shorten it to continue; nothing was saved.',
    );
    expect(note).toHaveValue('y'.repeat(2_001));
    expect(finishReview).not.toHaveBeenCalled();
  });

  it('asks before leaving with unsaved choices', async () => {
    const { user } = renderReview();
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(within(group(course.title)).getByRole('radio', { name: 'Continue' }));
    await user.click(screen.getByRole('link', { name: 'Open Inbox' }));
    expect(
      await screen.findByRole('dialog', { name: 'Save your changes before leaving?' }),
    ).toBeVisible();
    expect(location()).toBe('/review/weekly/2026-09-21');
  });

  it('chooses at most three focus items for the first day, in order, never ranked', async () => {
    const extra = [reviewAction(5, 'Pack the bag'), reviewAction(6, 'Water the plants')];
    const base = firstDayChoices();
    const choices = firstDayChoices({
      candidates: [
        ...base.candidates,
        ...extra.map((action) => ({
          kind: 'action' as const,
          key: `action:${action.id}` as (typeof base.candidates)[number]['key'],
          target: { kind: 'action' as const, actionId: action.id },
          source: 'week' as const,
          action,
          selected: false,
        })),
      ],
      weekTotal: 4,
    });
    const { finishReview, user } = renderReview({
      view: weeklyView({ context: weeklyContext({ firstDayFocus: choices }) }),
    });
    const focus = await screen.findByRole('region', {
      name: 'Focus for Wednesday, September 30',
    });
    // Plan order, nothing preselected.
    expect(
      within(focus)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual([outline.title, brief.title, 'Pack the bag', 'Water the plants']);
    for (const box of within(focus).getAllByRole('checkbox')) expect(box).not.toBeChecked();
    for (const name of ['Water the plants', outline.title, 'Pack the bag'])
      await user.click(within(focus).getByRole('checkbox', { name }));
    expect(within(focus).getByText('3 of 3 chosen')).toBeVisible();
    const fourth = within(focus).getByRole('checkbox', { name: brief.title });
    expect(fourth).toHaveAttribute('aria-disabled', 'true');
    await user.click(fourth);
    expect(fourth).not.toBeChecked();
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview.mock.calls[0]?.[0]).toMatchObject({
      firstDayFocus: [
        { kind: 'action', actionId: extra[1]?.id },
        { kind: 'action', actionId: outline.id },
        { kind: 'action', actionId: extra[0]?.id },
      ],
    });
  });

  it('says calmly when the week is empty', async () => {
    renderReview({
      view: weeklyView({
        context: weeklyContext({
          done: { items: [], total: 0 },
          open: { items: [], total: 0 },
          routines: { completed: 0, skipped: 0 },
          inboxCount: 0,
          projects: { items: [], total: 0 },
          axes: { items: [], total: 0 },
          commitments: [],
          commitmentCandidates: { items: [], total: 0 },
        }),
      }),
    });
    expect(await screen.findByText('Nothing was marked done this week.')).toBeVisible();
    expect(screen.getByText('Nothing planned for this week is still open.')).toBeVisible();
    expect(
      screen.getByText('No routine occurrences were marked done or skipped this week.'),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Carry unfinished work in Plan' })).toBeNull();
    expect(screen.getByText('Your Inbox is empty.')).toBeVisible();
    expect(screen.getByText('No Projects are active or blocked.')).toBeVisible();
    expect(screen.getByText('No active Axes.')).toBeVisible();
    expect(screen.getByText('No commitments chosen.')).toBeVisible();
  });

  it('uses calm, neutral words only', async () => {
    renderReview();
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    const text = document.body.textContent;
    for (const word of [
      /streak/iu,
      /score/iu,
      /grade/iu,
      /overdue/iu,
      /behind/iu,
      /failed/iu,
      /missed/iu,
      /\bAI\b/u,
      /%/u,
      /recommend/iu,
      /suggest/iu,
    ])
      expect(text).not.toMatch(word);
  });
});

describe('Review page: monthly review', () => {
  it('offers only the decisions each object’s state allows, and the month’s theme', async () => {
    renderReview({ path: '/review/monthly/2026-09', view: monthlyView() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Monthly review' })).toBeVisible();
    expect(screen.getByText('September 2026')).toBeVisible();
    expect(screen.getByText('Not started · Due today')).toBeVisible();
    expect(h2s()).toEqual([
      'Outcomes',
      'Milestones',
      'Projects',
      'Theme for October 2026',
      'Notes',
    ]);
    expect(radioLabels(halfMarathon.title)).toEqual([
      'Decide later',
      'Continue',
      'Pause',
      'Achieved',
      'Abandon',
      'Archive',
    ]);
    // A paused Outcome or Project is never offered Pause again.
    expect(radioLabels(pausedOutcome.title)).toEqual([
      'Decide later',
      'Continue',
      'Achieved',
      'Abandon',
      'Archive',
    ]);
    expect(radioLabels(firstRace.title)).toEqual([
      'Decide later',
      'Continue',
      'Complete',
      'Cancel',
      'Archive',
    ]);
    expect(group(firstRace.title)).toHaveAccessibleDescription(
      'Active · Outcome: Run a half marathon · Target by Oct 18, 2026',
    );
    expect(radioLabels('Launch the course')).toEqual([
      'Decide later',
      'Continue',
      'Pause',
      'Complete',
      'Archive',
    ]);
    expect(radioLabels(pausedProject.title)).toEqual([
      'Decide later',
      'Continue',
      'Complete',
      'Archive',
    ]);
    expect(
      screen.getByRole('link', { name: `Open details for ${firstRace.title}` }),
    ).toHaveAttribute('href', `/milestones/${firstRace.id}`);
    const theme = section('Theme for October 2026');
    expect(within(theme).getByText('Current theme: Steady training')).toBeVisible();
    expect(
      within(theme).getByRole('textbox', { name: 'New theme (optional)' }),
    ).toHaveAccessibleDescription('Leave blank to keep the current theme. 0 of 2,000 characters');
    expect(within(theme).getByRole('link', { name: 'Open October 2026 in Plan' })).toHaveAttribute(
      'href',
      '/plan/month/2026-10-01',
    );
    expect(
      within(section('Notes'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Which outcomes moved?', 'What changed?', 'What should pause or stop?']);
  });

  it('finishes with the exact decisions; a blank theme leaves the theme as it is', async () => {
    const { finishReview, user } = renderReview({
      path: '/review/monthly/2026-09',
      view: monthlyView(),
    });
    await screen.findByRole('heading', { level: 2, name: 'Outcomes' });
    await user.click(within(group(halfMarathon.title)).getByRole('radio', { name: 'Achieved' }));
    await user.click(within(group(pausedOutcome.title)).getByRole('radio', { name: 'Abandon' }));
    await user.click(within(group(firstRace.title)).getByRole('radio', { name: 'Complete' }));
    await user.click(within(group(pausedProject.title)).getByRole('radio', { name: 'Archive' }));
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview).toHaveBeenCalledWith({
      type: 'monthly',
      periodKey: '2026-09',
      outcomes: [
        { id: halfMarathon.id, revision: 4, decision: 'complete' },
        { id: pausedOutcome.id, revision: 4, decision: 'cancel' },
      ],
      milestones: [{ id: firstRace.id, revision: 4, decision: 'complete' }],
      projects: [{ id: pausedProject.id, revision: 4, decision: 'archive' }],
    });
  });

  it('saves the monthly choices for later with the exact input', async () => {
    const { finishReview, saveReview, user } = renderReview({
      path: '/review/monthly/2026-09',
      view: monthlyView({ saved: savedReview({ localRevision: 3 }) }),
    });
    await screen.findByRole('heading', { level: 2, name: 'Outcomes' });
    await user.click(within(group(halfMarathon.title)).getByRole('radio', { name: 'Pause' }));
    await user.click(within(group('Launch the course')).getByRole('radio', { name: 'Continue' }));
    await user.type(screen.getByRole('textbox', { name: 'Notes (optional)' }), 'Moved slowly.');
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
    expect(saveReview).toHaveBeenCalledWith({
      type: 'monthly',
      periodKey: '2026-09',
      revision: 3,
      notes: 'Moved slowly.',
      outcomes: [{ id: halfMarathon.id, revision: 4, decision: 'pause' }],
      milestones: [],
      projects: [{ id: course.id, revision: 4, decision: 'continue' }],
    });
    expect(finishReview).not.toHaveBeenCalled();
    expect(await screen.findByText('Saved. You can resume this review from Review.')).toBeVisible();
  });

  it('sets a new theme, and resumes a saved theme and decisions', async () => {
    const { finishReview, user } = renderReview({
      path: '/review/monthly/2026-09',
      view: monthlyView({ context: monthlyContextWithoutTheme() }),
    });
    await screen.findByRole('heading', { level: 2, name: 'Outcomes' });
    const theme = section('Theme for October 2026');
    expect(within(theme).getByText('No theme is set for October 2026.')).toBeVisible();
    await user.type(
      within(theme).getByRole('textbox', { name: 'New theme (optional)' }),
      '  Rest and repair  ',
    );
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview.mock.calls[0]?.[0]).toMatchObject({ theme: 'Rest and repair' });
    cleanup();

    const resumed = renderReview({
      path: '/review/monthly/2026-09',
      view: monthlyView({
        saved: savedReview({
          localRevision: 2,
          themeText: 'Slow down',
          items: [savedItem(target('outcome', halfMarathon.id, halfMarathon.title), 'pause')],
        }),
      }),
    });
    await screen.findByRole('heading', { level: 2, name: 'Outcomes' });
    expect(within(group(halfMarathon.title)).getByRole('radio', { name: 'Pause' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'New theme (optional)' })).toHaveValue('Slow down');
    await resumed.user.click(finishButton());
    await waitFor(() => expect(resumed.finishReview).toHaveBeenCalledTimes(1));
    expect(resumed.finishReview.mock.calls[0]?.[0]).toMatchObject({
      revision: 2,
      outcomes: [{ id: halfMarathon.id, revision: 4, decision: 'pause' }],
      theme: 'Slow down',
    });
  });
});

describe('Review page: yearly review', () => {
  it('shows the retrospective, Outcomes, this year’s direction, and the direction choice', async () => {
    renderReview({ path: '/review/yearly/2026', view: yearlyView() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Yearly review' })).toBeVisible();
    expect(screen.getByText('Not started · Due Thursday, December 31')).toBeVisible();
    expect(h2s()).toEqual(['Retrospective', 'Outcomes', 'Direction']);
    expect(
      within(section('Retrospective'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['What mattered?', 'What should continue?', 'Which direction is now outdated?']);
    expect(screen.getByRole('textbox', { name: 'Retrospective (optional)' })).toHaveValue('');
    const direction = section('Direction');
    expect(
      within(direction).getByRole('heading', { level: 3, name: 'This year’s direction (2026)' }),
    ).toBeVisible();
    expect(within(direction).getByText('Build a calm, healthy rhythm.')).toBeVisible();
    expect(radioLabels('What happens to this direction in 2027?')).toEqual([
      'Decide later',
      'Continue this direction',
      'Write a new direction',
      'This direction is outdated',
    ]);
    expect(
      within(group('What happens to this direction in 2027?')).getByRole('radio', {
        name: 'Decide later',
      }),
    ).toBeChecked();
  });

  it('asks for a new direction’s text, then finishes with it', async () => {
    const { finishReview, user } = renderReview({
      path: '/review/yearly/2026',
      view: yearlyView(),
    });
    await screen.findByRole('heading', { level: 2, name: 'Direction' });
    await user.type(
      screen.getByRole('textbox', { name: 'Retrospective (optional)' }),
      'A good year.',
    );
    await user.click(within(group(halfMarathon.title)).getByRole('radio', { name: 'Continue' }));
    await user.click(screen.getByRole('radio', { name: 'Write a new direction' }));
    await user.click(finishButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Write the new direction, or choose another option.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(finishReview).not.toHaveBeenCalled();
    await user.type(
      screen.getByRole('textbox', { name: 'New direction for 2027' }),
      'Grow slowly.',
    );
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview).toHaveBeenCalledWith({
      type: 'yearly',
      periodKey: '2026',
      notes: 'A good year.',
      outcomes: [{ id: halfMarathon.id, revision: 4, decision: 'continue' }],
      direction: { choice: 'new', text: 'Grow slowly.' },
    });
  });

  it('records an outdated direction, and resumes a saved choice', async () => {
    const { finishReview, user } = renderReview({
      path: '/review/yearly/2026',
      view: yearlyView(),
    });
    await screen.findByRole('heading', { level: 2, name: 'Direction' });
    await user.click(screen.getByRole('radio', { name: 'This direction is outdated' }));
    expect(
      screen.getByText(
        'This records that the direction is no longer current. It changes nothing else in your plan.',
      ),
    ).toBeVisible();
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(finishReview.mock.calls[0]?.[0]).toEqual({
      type: 'yearly',
      periodKey: '2026',
      outcomes: [],
      direction: { choice: 'outdated' },
    });
    cleanup();

    renderReview({
      path: '/review/yearly/2026',
      view: yearlyView({
        saved: savedReview({ direction: { choice: 'new', text: 'Rest more.' } }),
      }),
    });
    expect(await screen.findByRole('radio', { name: 'Write a new direction' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'New direction for 2027' })).toHaveValue(
      'Rest more.',
    );
  });

  it('skips the yearly review with its saved revision, and Undo brings it back', async () => {
    const { skipReview, undo, user } = renderReview({
      path: '/review/yearly/2026',
      view: yearlyView({ saved: savedReview({ localRevision: 9 }) }),
    });
    await screen.findByRole('heading', { level: 2, name: 'Direction' });
    await user.click(screen.getByRole('button', { name: 'Skip this review' }));
    await waitFor(() =>
      expect(skipReview).toHaveBeenCalledWith({ type: 'yearly', periodKey: '2026', revision: 9 }),
    );
    expect(await screen.findByText('Review skipped.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('undo-1'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Direction' })).toBeVisible();
    expect(
      await screen.findByText('Undone. Your plan and this review are back as they were.'),
    ).toBeVisible();
  });

  it('offers only a new direction when this year has none', async () => {
    renderReview({
      path: '/review/yearly/2026',
      view: yearlyView({ context: yearlyContextWithoutDirection() }),
    });
    expect(await screen.findByText('No direction was written for 2026.')).toBeVisible();
    expect(radioLabels('What happens to this direction in 2027?')).toEqual([
      'Decide later',
      'Write a new direction',
    ]);
  });

  it('names a past year’s direction by its year, never as this year’s', async () => {
    renderReview({
      path: '/review/yearly/2026',
      view: yearlyView({ today: '2027-01-04' as CalendarDate, due: 'ended' }),
    });
    const direction = await screen.findByRole('region', { name: 'Direction' });
    expect(
      within(direction).getByRole('heading', { level: 3, name: 'Direction for 2026' }),
    ).toBeVisible();
    expect(within(direction).queryByText(/This year’s direction/u)).toBeNull();
  });

  it('shows a resumed review read-only again once it is skipped again', async () => {
    const { saveReview, skipReview, user } = renderReview({
      path: '/review/yearly/2026',
      view: yearlyView({ saved: savedReview({ state: 'skipped', localRevision: 8 }) }),
    });
    await user.click(await screen.findByRole('button', { name: 'Resume review' }));
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole('button', { name: 'Skip this review' }));
    await waitFor(() =>
      expect(skipReview).toHaveBeenCalledWith({ type: 'yearly', periodKey: '2026', revision: 9 }),
    );
    expect(await screen.findByText('Review skipped.')).toBeVisible();
    expect(
      await screen.findByText(
        'You skipped this review. Nothing in your plan was changed, and the choices you saved are kept.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume review' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Finish review' })).toBeNull();
  });
});

describe('Review page: Save for later leaves nothing unsaved', () => {
  type Rendered = ReturnType<typeof renderReview>;

  /** Save for later, wait until the saved review is read again, then leave by the back link. */
  async function saveThenLeave({ saveReview, user }: Rendered): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Saved. You can resume this review from Review.')).toBeVisible();
    await screen.findByText(/^Saved for later · /u);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save for later' })).not.toHaveAttribute(
        'aria-disabled',
      ),
    );
    await user.click(screen.getByRole('link', { name: '← Review' }));
    expect(screen.queryByRole('dialog', { name: 'Save your changes before leaving?' })).toBeNull();
    await waitFor(() => expect(location()).toBe('/review'));
  }

  it.each([
    ['weekly', '/review/weekly/2026-09-21', weeklyView, 'Notes (optional)'],
    ['monthly', '/review/monthly/2026-09', monthlyView, 'Notes (optional)'],
    ['yearly', '/review/yearly/2026', yearlyView, 'Retrospective (optional)'],
  ] as const)(
    'from the moment a %s save succeeds, before the review is read again',
    async (_type, path, view, label) => {
      const { release, saveReview, user } = renderReview({
        path,
        view: view(),
        holdRereads: true,
      });
      await user.type(await screen.findByRole('textbox', { name: label }), 'Calm.');
      expect(unloadAsks()).toBe(true);
      await user.click(screen.getByRole('button', { name: 'Save for later' }));
      await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
      expect(
        await screen.findByText('Saved. You can resume this review from Review.'),
      ).toBeVisible();
      // The saved review has not been read again yet, and nothing counts as unsaved.
      expect(unloadAsks()).toBe(false);
      await user.click(screen.getByRole('link', { name: '← Review' }));
      expect(
        screen.queryByRole('dialog', { name: 'Save your changes before leaving?' }),
      ).toBeNull();
      await waitFor(() => expect(location()).toBe('/review'));
      release();
    },
  );

  it('until a change after the save, which is unsaved again', async () => {
    const { release, user } = renderReview({ holdRereads: true });
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(within(group(shed.title)).getByRole('radio', { name: 'Pause' }));
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    await screen.findByText('Saved. You can resume this review from Review.');
    expect(unloadAsks()).toBe(false);
    await user.click(within(group(course.title)).getByRole('radio', { name: 'Continue' }));
    expect(unloadAsks()).toBe(true);
    release();
    await screen.findByText(/^Saved for later · /u);
    expect(unloadAsks()).toBe(true);
  });

  it('once Finish succeeds, before the finished review is read again', async () => {
    const { finishReview, release, user } = renderReview({ holdRereads: true });
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(within(group(shed.title)).getByRole('radio', { name: 'Pause' }));
    expect(unloadAsks()).toBe(true);
    await user.click(finishButton());
    await waitFor(() => expect(finishReview).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Review finished.')).toBeVisible();
    expect(unloadAsks()).toBe(false);
    release();
    expect(await screen.findByText(/^Finished Wednesday, September 30, 2026/u)).toBeVisible();
    expect(unloadAsks()).toBe(false);
  });

  it('once a Skip without saving succeeds, before the skipped review is read again', async () => {
    const { release, skipReview, user } = renderReview({ holdRereads: true });
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(within(group(shed.title)).getByRole('radio', { name: 'Pause' }));
    await user.click(screen.getByRole('button', { name: 'Skip this review' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Skip without saving',
      }),
    );
    await waitFor(() => expect(skipReview).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Review skipped.')).toBeVisible();
    expect(unloadAsks()).toBe(false);
    release();
    expect(
      await screen.findByText(
        'You skipped this review. Nothing in your plan was changed, and the choices you saved are kept.',
      ),
    ).toBeVisible();
    expect(unloadAsks()).toBe(false);
  });

  it('after clearing the week’s commitments', async () => {
    const rendered = renderReview();
    const commitments = await screen.findByRole('region', { name: 'Commitments' });
    await rendered.user.click(
      within(commitments).getByRole('button', { name: `Remove ${outline.title}` }),
    );
    await saveThenLeave(rendered);
    expect(rendered.saveReview.mock.calls[0]?.[0]).toMatchObject({ commitments: [] });
  });

  it('after clearing the first day’s focus', async () => {
    const rendered = renderReview({
      view: weeklyView({
        context: weeklyContext({
          firstDayFocus: firstDayChoices({ current: [focusActionItem(outline)] }),
        }),
      }),
    });
    const focus = await screen.findByRole('region', {
      name: 'Focus for Wednesday, September 30',
    });
    await rendered.user.click(
      within(focus).getByRole('button', { name: `Remove ${outline.title}` }),
    );
    await saveThenLeave(rendered);
    expect(rendered.saveReview.mock.calls[0]?.[0]).toMatchObject({ firstDayFocus: [] });
  });

  it.each([
    ['weekly', '/review/weekly/2026-09-21', weeklyView, 'Notes (optional)'],
    ['monthly', '/review/monthly/2026-09', monthlyView, 'Notes (optional)'],
    ['yearly', '/review/yearly/2026', yearlyView, 'Retrospective (optional)'],
  ] as const)('after %s notes of only spaces', async (_type, path, view, label) => {
    const rendered = renderReview({ path, view: view() });
    await rendered.user.type(await screen.findByRole('textbox', { name: label }), '   ');
    await saveThenLeave(rendered);
    expect(rendered.saveReview.mock.calls[0]?.[0]).not.toHaveProperty('notes');
  });

  it('after a saved decision about a Project that is no longer listed', async () => {
    const rendered = renderReview({
      view: weeklyView({
        saved: savedReview({
          items: [savedItem(target('project', pausedProject.id, pausedProject.title), 'pause')],
        }),
      }),
    });
    await rendered.user.type(
      await screen.findByRole('textbox', { name: 'Notes (optional)' }),
      'Calm.',
    );
    await saveThenLeave(rendered);
    expect(rendered.saveReview.mock.calls[0]?.[0]).toMatchObject({ projects: [], notes: 'Calm.' });
  });

  it('after a saved monthly decision about an Outcome that is no longer listed', async () => {
    const finished = objectRow('outcome', 65, 'Write a novel', { state: 'achieved' });
    const rendered = renderReview({
      path: '/review/monthly/2026-09',
      view: monthlyView({
        saved: savedReview({
          items: [savedItem(target('outcome', finished.id, finished.title), 'pause')],
        }),
      }),
    });
    await rendered.user.type(
      await screen.findByRole('textbox', { name: 'Notes (optional)' }),
      'Calm.',
    );
    await saveThenLeave(rendered);
    expect(rendered.saveReview.mock.calls[0]?.[0]).toMatchObject({ outcomes: [], notes: 'Calm.' });
  });
});

describe('Review page: Remind me to finish', () => {
  const reminderRegion = () => screen.findByRole('region', { name: 'Reminder' });
  const setTime = (region: HTMLElement, value: string) =>
    fireEvent.change(within(region).getByLabelText('Reminder time'), { target: { value } });

  it('offers no reminder before the review is saved, then a calm form for the draft', async () => {
    const { saveReview, user } = renderReview();
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    expect(screen.queryByRole('region', { name: 'Reminder' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));

    const region = await reminderRegion();
    expect(
      within(region).getByText('Set, change, or turn off the reminder saved for this review.'),
    ).toBeVisible();
    const fieldset = within(region).getByRole('group', {
      name: 'Remind me to finish this review',
    });
    expect(fieldset).toHaveAccessibleDescription(
      'Reminders are saved on this device. Enable browser alerts in Settings for delivery while YelAxis Planner is open; reminders due while it is closed appear in Notifications after reopening.',
    );
    // A new reminder starts on today's date; the time is the person's to choose.
    expect(within(fieldset).getByLabelText('Reminder date')).toHaveValue('2026-09-30');
    expect(within(fieldset).getByLabelText('Reminder time')).toHaveValue('');
    expect(within(fieldset).getByLabelText('Reminder time')).toHaveAccessibleDescription(
      'Times are in your planning time zone, UTC.',
    );
    expect(within(region).getByRole('button', { name: 'Save reminder' })).toBeVisible();
    expect(within(region).queryByRole('button', { name: 'Turn off reminder' })).toBeNull();
    // It follows the review form, outside it.
    expect(region.closest('form')).toBeNull();
    expect(
      finishButton().compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each([
    ['monthly', '/review/monthly/2026-09', monthlyView],
    ['yearly', '/review/yearly/2026', yearlyView],
  ] as const)('offers the reminder on a saved %s draft', async (_type, path, view) => {
    renderReview({ path, view: view({ saved: savedReview() }) });
    const region = await reminderRegion();
    expect(
      within(region).getByRole('group', { name: 'Remind me to finish this review' }),
    ).toBeVisible();
  });

  it('saves a reminder with Enter in its fields, never finishing the review, with Undo', async () => {
    const { finishReview, setReviewReminder, undo, user } = renderReview({
      view: weeklyView({ saved: savedReview({ localRevision: 5 }) }),
    });
    const region = await reminderRegion();
    fireEvent.change(within(region).getByLabelText('Reminder date'), {
      target: { value: '2026-10-02' },
    });
    setTime(region, '18:00');
    within(region).getByLabelText('Reminder time').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(setReviewReminder).toHaveBeenCalledTimes(1));
    expect(setReviewReminder).toHaveBeenCalledWith({
      reviewId: reviewId(501),
      revision: 5,
      reminder: { date: '2026-10-02', time: '18:00' },
    });
    expect(finishReview).not.toHaveBeenCalled();
    const status = await within(region).findByText('Reminder saved.');
    await waitFor(() => expect(status).toHaveFocus());
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(
      await within(region).findByText('Saved reminder: Friday, October 2, 2026 at 18:00.'),
    ).toBeVisible();
    expect(within(region).getByRole('button', { name: 'Turn off reminder' })).toBeVisible();

    await user.click(within(region).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('undo-reminder'));
    const undone = await within(region).findByText('Undone. The reminder is back as it was.');
    await waitFor(() => expect(undone).toHaveFocus());
    await waitFor(() => expect(within(region).queryByText(/^Saved reminder:/u)).toBeNull());
    expect(within(region).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('changes a saved reminder and turns it off, passing the shown reminder’s revision', async () => {
    const saved = savedReview({
      localRevision: 4,
      reminder: reminderView('2026-10-02', '18:00', { localRevision: 2 }),
    });
    const { setReviewReminder, turnOffReviewReminder, user } = renderReview({
      view: weeklyView({ saved }),
    });
    const region = await reminderRegion();
    expect(
      within(region).getByText('Saved reminder: Friday, October 2, 2026 at 18:00.'),
    ).toBeVisible();
    expect(within(region).getByLabelText('Reminder date')).toHaveValue('2026-10-02');
    expect(within(region).getByLabelText('Reminder time')).toHaveValue('18:00');

    setTime(region, '07:30');
    await user.click(within(region).getByRole('button', { name: 'Save reminder' }));
    await waitFor(() =>
      expect(setReviewReminder).toHaveBeenCalledWith({
        reviewId: reviewId(501),
        revision: 4,
        reminderRevision: 2,
        reminder: { date: '2026-10-02', time: '07:30' },
      }),
    );
    expect(
      await within(region).findByText('Saved reminder: Friday, October 2, 2026 at 07:30.'),
    ).toBeVisible();

    await user.click(within(region).getByRole('button', { name: 'Turn off reminder' }));
    await waitFor(() =>
      expect(turnOffReviewReminder).toHaveBeenCalledWith({
        reviewId: reviewId(501),
        reminderRevision: 3,
      }),
    );
    const status = await within(region).findByText('Reminder turned off.');
    await waitFor(() => expect(status).toHaveFocus());
    await waitFor(() =>
      expect(within(region).queryByRole('button', { name: 'Turn off reminder' })).toBeNull(),
    );
    expect(within(region).getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('saves nothing when the chosen time is the saved one', async () => {
    const { setReviewReminder, user } = renderReview({
      view: weeklyView({
        saved: savedReview({ reminder: reminderView('2026-10-02', '18:00') }),
      }),
    });
    const region = await reminderRegion();
    await user.click(within(region).getByRole('button', { name: 'Save reminder' }));
    const status = await within(region).findByText('The reminder is already set for that time.');
    await waitFor(() => expect(status).toHaveFocus());
    expect(setReviewReminder).not.toHaveBeenCalled();
    expect(within(region).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('refuses a missing date or time next to its field and sends nothing', async () => {
    const { setReviewReminder, user } = renderReview({
      view: weeklyView({ saved: savedReview() }),
    });
    const region = await reminderRegion();
    const date = within(region).getByLabelText('Reminder date');
    const time = within(region).getByLabelText('Reminder time');
    fireEvent.change(date, { target: { value: '' } });
    await user.click(within(region).getByRole('button', { name: 'Save reminder' }));
    expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(date).toHaveAccessibleDescription(
      'Times are in your planning time zone, UTC. Choose a date for the reminder.',
    );
    expect(time).toHaveAttribute('aria-invalid', 'true');
    expect(time).toHaveAccessibleDescription(
      'Times are in your planning time zone, UTC. Choose a time for the reminder.',
    );
    expect(date).toHaveFocus();
    expect(setReviewReminder).not.toHaveBeenCalled();

    fireEvent.change(date, { target: { value: '2026-10-02' } });
    await user.click(within(region).getByRole('button', { name: 'Save reminder' }));
    expect(date).not.toHaveAttribute('aria-invalid');
    expect(time).toHaveFocus();
    expect(setReviewReminder).not.toHaveBeenCalled();
  });

  it('shows the application’s refusal calmly next to the reminder', async () => {
    const refused: ApplicationResult<CommandReceipt> = {
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: {
          code: 'invalid_value',
          message: 'Only a saved draft or a skipped review can get a reminder.',
          details: { reason: 'reminder_review_not_open' },
        },
      },
    };
    const { user } = renderReview({
      view: weeklyView({ saved: savedReview() }),
      reviews: { setReviewReminder: vi.fn(() => Promise.resolve(refused)) },
    });
    const region = await reminderRegion();
    setTime(region, '18:00');
    await user.click(within(region).getByRole('button', { name: 'Save reminder' }));
    const alert = await within(region).findByRole('alert');
    expect(alert).toHaveTextContent('Only a saved draft or a skipped review can get a reminder.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(within(region).queryByText('Reminder saved.')).toBeNull();
    // The review form shows no refusal of its own.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('shows a finished review’s reminder with only Turn off reminder, before Back to Review', async () => {
    const finished = savedReview({
      state: 'completed',
      completedAt: '2026-09-27T18:30:00.000Z' as Instant,
      reminder: reminderView('2026-10-02', '18:00', { localRevision: 2 }),
    });
    const { turnOffReviewReminder, undo, user } = renderReview({
      view: weeklyView({ saved: finished, editable: false, context: null }),
    });
    const region = await reminderRegion();
    expect(
      within(region).getByText('Saved reminder: Friday, October 2, 2026 at 18:00.'),
    ).toBeVisible();
    expect(
      within(region).getByText(
        'This review is finished. Its reminder stays saved until you turn it off.',
      ),
    ).toBeVisible();
    expect(
      within(region).getByText(
        'Reminders are saved on this device. Enable browser alerts in Settings for delivery while YelAxis Planner is open; reminders due while it is closed appear in Notifications after reopening.',
      ),
    ).toBeVisible();
    expect(region.textContent).not.toMatch(
      /\b(streak|score|grade|behind|failed|missed|penalty|lost)\b/iu,
    );
    expect(within(region).queryByLabelText('Reminder date')).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Save reminder' })).toBeNull();
    expect(
      region.compareDocumentPosition(screen.getByRole('link', { name: 'Back to Review' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(within(region).getByRole('button', { name: 'Turn off reminder' }));
    await waitFor(() =>
      expect(turnOffReviewReminder).toHaveBeenCalledWith({
        reviewId: reviewId(501),
        reminderRevision: 2,
      }),
    );
    expect(await within(region).findByText('Reminder turned off.')).toBeVisible();
    expect(await within(region).findByText('No reminder is saved.')).toBeVisible();
    await user.click(within(region).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('undo-reminder-off'));
    expect(
      await within(region).findByText('Saved reminder: Friday, October 2, 2026 at 18:00.'),
    ).toBeVisible();
  });

  it('shows no Reminder section for a finished review without one', async () => {
    renderReview({
      view: weeklyView({
        saved: savedReview({ state: 'completed' }),
        editable: false,
        context: null,
      }),
    });
    await screen.findByRole('heading', { level: 2, name: 'Decisions' });
    expect(screen.queryByRole('region', { name: 'Reminder' })).toBeNull();
  });

  it('offers only the reminder command’s Undo once a reminder command has run', async () => {
    // Skip creates the review; its Undo would archive the review and strand a reminder.
    const { skipReview, undo, user } = renderReview();
    await screen.findByRole('heading', { level: 2, name: 'Looking back' });
    await user.click(screen.getByRole('button', { name: 'Skip this review' }));
    await waitFor(() => expect(skipReview).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Review skipped.')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);

    const region = await reminderRegion();
    setTime(region, '18:00');
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
    // The skip stays as it is: its Undo is not offered again.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(
      screen.getByText(
        'You skipped this review. Nothing in your plan was changed, and the choices you saved are kept.',
      ),
    ).toBeVisible();
  });

  it('ends the reminder’s result and Undo when a review command runs', async () => {
    const { saveReview, user } = renderReview({ view: weeklyView({ saved: savedReview() }) });
    const region = await reminderRegion();
    setTime(region, '18:00');
    await user.click(within(region).getByRole('button', { name: 'Save reminder' }));
    expect(await within(region).findByText('Reminder saved.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Notes (optional)' }), 'Calm.');
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Saved. You can resume this review from Review.')).toBeVisible();
    expect(within(region).queryByText('Reminder saved.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    // Saving kept the reminder.
    expect(
      within(await reminderRegion()).getByText(/^Saved reminder: Wednesday, September 30, 2026/u),
    ).toBeVisible();
  });
});
