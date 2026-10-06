// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PlanningApplication, ReviewApplication, TodayView } from '@yelaxis/application';
import type { CalendarDate, DayCapacity } from '@yelaxis/domain';

import { AccountProvider } from '../account/account-context';
import {
  fakeAccount,
  fakeConflicts,
  fakeSync,
  type FakeSync,
} from '../account/__fixtures__/account-fakes';
import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import {
  fakeReviews,
  monthlyPeriod,
  reviewCheckpoint,
  weeklyPeriod,
  yearlyPeriod,
} from '../review/__fixtures__/review-fake';
import type { NowSource } from './clock-context';
import { fakeToday, todayPlanning, todayTree, todayView } from './__fixtures__/today-fake';
import {
  nextDay,
  populatedView,
  reportBlock,
  todaySettings,
} from './__fixtures__/today-view-fixtures';
import { TodayRoute } from './today-page';

const scrollTo = vi.fn();

beforeAll(() => {
  installDialogPolyfill();
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
});

afterEach(() => cleanup());

const settled = (overrides: Partial<PlanningApplication> = {}) =>
  todayPlanning({ getCapacitySettings: vi.fn(() => Promise.resolve(todaySettings)), ...overrides });

function renderToday(
  getToday: (date: string) => Promise<TodayView>,
  options: {
    readonly path?: string;
    readonly name?: string;
    readonly planning?: PlanningApplication;
    readonly now?: NowSource;
    readonly defaultsConfirmed?: boolean;
    readonly reviews?: ReviewApplication;
    /** account sync: the account provider with this sync status. */
    readonly sync?: FakeSync;
  } = {},
) {
  const read = vi.fn(getToday);
  const today = fakeToday({ getToday: read });
  const tree = todayTree(
    today,
    <TodayRoute
      {...(options.name === undefined ? {} : { preferredName: options.name })}
      defaultsConfirmed={options.defaultsConfirmed ?? true}
      onResumeSetup={() => undefined}
    />,
    {
      path: options.path ?? '/',
      planning: options.planning ?? settled(),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.reviews === undefined ? {} : { reviews: options.reviews }),
    },
  );
  render(
    options.sync === undefined ? (
      tree
    ) : (
      <AccountProvider
        account={fakeAccount()}
        sync={options.sync.controller}
        conflicts={fakeConflicts()}
      >
        {tree}
      </AccountProvider>
    ),
  );
  return { getToday: read, user: userEvent.setup() };
}

const byDate =
  (overrides: Partial<TodayView> = {}) =>
  (date: string) =>
    Promise.resolve(populatedView({ date: date as CalendarDate, ...overrides }));
const h1 = () => screen.getAllByRole('heading', { level: 1 });
const location = () => screen.getByTestId('location').textContent;
const forbidden = /\b(streak|score|grade|productivity|behind|failed|missed|penalty|lost|AI)\b/iu;

describe('Today: live today', () => {
  it('greets calmly and names the planning date, with or without a name', async () => {
    const { getToday } = renderToday(byDate());
    expect(
      await screen.findByRole('heading', { level: 1, name: 'A useful day starts here.' }),
    ).toBeVisible();
    expect(h1()).toHaveLength(1);
    expect(screen.getByText('Today · Monday, September 28, 2026')).toBeVisible();
    expect(getToday).toHaveBeenCalledWith('2026-09-28');
    cleanup();
    renderToday(byDate(), { name: 'Sam' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sam, start with one clear action.' }),
    ).toBeVisible();
  });

  it('offers day navigation with Today current, and links to Plan and End day', async () => {
    renderToday(byDate());
    await screen.findByRole('heading', { level: 1, name: 'A useful day starts here.' });
    const nav = screen.getByRole('navigation', { name: 'Day' });
    expect(within(nav).getByRole('link', { name: 'Previous day' })).toHaveAttribute(
      'href',
      '/?date=2026-09-27',
    );
    expect(within(nav).getByRole('link', { name: 'Today' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Next day' })).toHaveAttribute(
      'href',
      '/?date=2026-09-29',
    );
    expect(screen.getByRole('link', { name: 'Open this day in Plan' })).toHaveAttribute(
      'href',
      '/plan/day/2026-09-28',
    );
    expect(screen.getByRole('link', { name: 'End day…' })).toHaveAttribute(
      'href',
      '/end-day/2026-09-28',
    );
    expect(screen.getAllByRole('link', { name: 'End day…' })).toHaveLength(1);
    expect(
      screen.getByText('When you are ready, End day looks at what is done and what is still open.'),
    ).toBeVisible();
  });

  it('shows the populated day in reading order with the current time', async () => {
    renderToday(byDate());
    await screen.findByRole('heading', { level: 1, name: 'A useful day starts here.' });
    // Reading order (the focus strip's own heading, when it has one, comes first).
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((item) => item.textContent)
      .filter((text) => text !== 'Focus');
    expect(headings).toEqual(['Overlaps', 'Timeline', 'Flexible', 'Routines', 'End of day']);
    expect(screen.getByText('1 overlap to review')).toBeVisible();
    expect(screen.getByText(/^Now 09:00/u)).toBeVisible();
    expect(screen.getByTestId('timeline-now')).toHaveAttribute('aria-hidden', 'true');
    const timeline = screen.getByRole('list', {
      name: 'Timed plan for Monday, September 28, 2026',
    });
    expect(within(timeline).getByRole('link', { name: 'Write report' })).toBeVisible();
    // Today's own choices sit in the block's Options, beside the planning controls.
    expect(within(timeline).getByRole('link', { name: 'Focus mode Write report' })).toHaveAttribute(
      'href',
      `/focus/${reportBlock.target.kind === 'action' ? reportBlock.target.actionId : ''}`,
    );
    expect(document.body.textContent).not.toMatch(forbidden);
  });

  it('describes an overloaded day in words and offers to review it in Plan', async () => {
    const capacity: DayCapacity = {
      date: '2026-09-28' as CalendarDate,
      plannedMinutes: 600,
      availability: { status: 'known', minutes: 480, basis: 'windows' },
      overByMinutes: 120,
    };
    renderToday(byDate({ timeline: { ...populatedView().timeline, capacity } }));
    expect(
      await screen.findByText(
        '10 hours planned of 8 hours available. This is 2 hours more than the time you made available.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review this day in Plan' })).toHaveAttribute(
      'href',
      '/plan/day/2026-09-28',
    );
  });

  it('shows an intentionally empty day calmly with Choose focus', async () => {
    renderToday((date) => Promise.resolve(todayView({ date: date as CalendarDate })));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Your day is clear.' }),
    ).toBeVisible();
    expect(screen.getByText('Choose one focus item or leave space intentionally.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Choose focus…' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Timeline' })).toBeNull();
    expect(screen.getByRole('link', { name: 'End day…' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Review this day in Plan' })).toBeNull();
  });

  it('keeps every control enabled offline (the shell banner says so)', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    renderToday(byDate());
    await screen.findByRole('heading', { level: 1, name: 'A useful day starts here.' });
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(5);
    for (const button of buttons) expect(button).toBeEnabled();
    online.mockRestore();
  });
});

describe('Today: selected dates', () => {
  it('shows a chosen date with a banner and never marks it as today', async () => {
    const { getToday } = renderToday(byDate(), { path: `/?date=${nextDay}` });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tuesday, September 29, 2026' }),
    ).toBeVisible();
    expect(getToday).toHaveBeenCalledWith('2026-09-29');
    expect(screen.getByText('Tomorrow · Tuesday, September 29, 2026')).toBeVisible();
    expect(screen.getByText('You are viewing Tuesday, September 29, 2026.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to today' })).toHaveAttribute('href', '/');
    const nav = screen.getByRole('navigation', { name: 'Day' });
    expect(within(nav).getByRole('link', { name: 'Previous day' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Today' })).not.toHaveAttribute('aria-current');
    // No current-time marker and no End day for a later day.
    expect(screen.queryByTestId('timeline-now')).toBeNull();
    expect(screen.queryByRole('link', { name: 'End day…' })).toBeNull();
  });

  it('names earlier days and offers End day for them', async () => {
    renderToday(byDate(), { path: '/?date=2026-09-27' });
    await screen.findByRole('heading', { level: 1, name: 'Sunday, September 27, 2026' });
    expect(screen.getByText('Yesterday · Sunday, September 27, 2026')).toBeVisible();
    expect(screen.getByRole('link', { name: 'End day…' })).toHaveAttribute(
      'href',
      '/end-day/2026-09-27',
    );
    cleanup();
    renderToday(byDate(), { path: '/?date=2026-09-20' });
    expect(await screen.findByText('Earlier day · Sunday, September 20, 2026')).toBeVisible();
    cleanup();
    renderToday(byDate(), { path: '/?date=2026-10-20' });
    expect(await screen.findByText('Later day · Tuesday, October 20, 2026')).toBeVisible();
  });

  it('keeps an empty earlier day read-only', async () => {
    renderToday((date) => Promise.resolve(todayView({ date: date as CalendarDate })), {
      path: '/?date=2026-09-27',
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Nothing is planned for this day.' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Choose focus…' })).toBeNull();
  });

  it('moves between days with links and back to the live today', async () => {
    const { getToday, user } = renderToday(byDate());
    await screen.findByRole('heading', { level: 1, name: 'A useful day starts here.' });
    await user.click(screen.getByRole('link', { name: 'Next day' }));
    expect(location()).toBe('/?date=2026-09-29');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tuesday, September 29, 2026' }),
    ).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Back to today' }));
    expect(location()).toBe('/');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'A useful day starts here.' }),
    ).toBeVisible();
    expect(getToday.mock.calls.map(([date]) => date)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-28',
    ]);
  });

  it('moves focus to the heading when the control that had it leaves with the old day', async () => {
    const { user } = renderToday(byDate(), { path: `/?date=${nextDay}` });
    await screen.findByRole('heading', { level: 1, name: 'Tuesday, September 29, 2026' });
    await user.click(screen.getByRole('link', { name: 'Back to today' }));
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'A useful day starts here.',
    });
    await waitFor(() => expect(heading).toHaveFocus());
    // A day link that stays keeps its focus.
    await user.click(screen.getByRole('link', { name: 'Next day' }));
    await screen.findByRole('heading', { level: 1, name: 'Tuesday, September 29, 2026' });
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(screen.getByRole('link', { name: 'Next day' })).toHaveFocus();
  });

  it('moves focus to the heading without waiting for an animation frame', async () => {
    // Headless Firefox can hold frames back: the day-change focus must not depend on one.
    const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    try {
      const { user } = renderToday(byDate(), { path: `/?date=${nextDay}` });
      await screen.findByRole('heading', { level: 1, name: 'Tuesday, September 29, 2026' });
      await user.click(screen.getByRole('link', { name: 'Back to today' }));
      const heading = await screen.findByRole('heading', {
        level: 1,
        name: 'A useful day starts here.',
      });
      await waitFor(() => expect(heading).toHaveFocus());
    } finally {
      frames.mockRestore();
    }
  });

  it('opens a newly chosen day at the top of the page', async () => {
    const { user } = renderToday(byDate());
    await screen.findByRole('heading', { level: 1, name: 'A useful day starts here.' });
    scrollTo.mockClear();
    await user.click(screen.getByRole('link', { name: 'Previous day' }));
    await screen.findByRole('heading', { level: 1, name: 'Sunday, September 27, 2026' });
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('explains an unreadable day link without reading the plan', async () => {
    const { getToday } = renderToday(byDate(), { path: '/?date=2026-02-30' });
    expect(
      await screen.findByText('This day link could not be read. Your plan is unchanged.'),
    ).toBeVisible();
    expect(h1()).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Open today' })).toHaveAttribute('href', '/');
    expect(getToday).not.toHaveBeenCalled();
  });
});

describe('Today: loading, errors, and setup', () => {
  it('asks to finish setup without a second Resume setup button', () => {
    renderToday(byDate(), { defaultsConfirmed: false });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Finish setup to open Today.' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Resume setup' })).toBeNull();
    expect(screen.getByText(/Choose Resume setup above to continue\./u)).toBeVisible();
  });

  it('waits for the planning zone, then for the day', async () => {
    let resolveSettings: (value: typeof todaySettings) => void = () => undefined;
    const planning = todayPlanning({
      getCapacitySettings: vi.fn(
        () =>
          new Promise<typeof todaySettings>((resolve) => {
            resolveSettings = resolve;
          }),
      ),
    });
    renderToday(() => new Promise<never>(() => undefined), { planning });
    expect(screen.getByRole('heading', { level: 1, name: 'Opening today…' })).toBeVisible();
    expect(screen.getByRole('article')).toHaveAttribute('aria-busy', 'true');
    act(() => resolveSettings(todaySettings));
    // The zone is known: the day itself is still being read.
    expect(await screen.findByRole('navigation', { name: 'Day' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Opening today…' })).toBeVisible();
    expect(screen.getByRole('article')).toHaveAttribute('aria-busy', 'true');
    expect(h1()).toHaveLength(1);
  });

  it('reports a failed read calmly and tries again', async () => {
    const getToday = vi
      .fn<(date: string) => Promise<TodayView>>()
      .mockRejectedValueOnce(new Error('worker'))
      .mockImplementation(byDate());
    const { user } = renderToday(getToday);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Today could not be read. Your local plan was not changed.');
    expect(within(alert).getByRole('link', { name: 'Open this day in Plan' })).toHaveAttribute(
      'href',
      '/plan/day/2026-09-28',
    );
    expect(h1()).toHaveLength(1);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Timeline' })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Today: the day changes', () => {
  it('rolls the live today over at midnight, announced once, without a loading state', async () => {
    let clock = Date.parse('2026-09-28T23:59:30.000Z');
    const { getToday } = renderToday(byDate(), { now: () => clock });
    await screen.findByRole('heading', { name: 'Timeline' });
    expect(screen.getByText('Today · Monday, September 28, 2026')).toBeVisible();
    clock = Date.parse('2026-09-29T00:00:30.000Z');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(
      await screen.findByText('A new day started. Today now shows Tuesday, September 29, 2026.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Today · Tuesday, September 29, 2026')).toBeVisible(),
    );
    expect(screen.queryByRole('heading', { name: 'Opening today…' })).toBeNull();
    expect(getToday.mock.calls.map(([date]) => date)).toEqual(['2026-09-28', '2026-09-29']);
    expect(location()).toBe('/');
    expect(screen.getByText(/^Now 00:00/u)).toBeVisible();
  });

  it('never says a new day started when the date moves back (clock or zone change)', async () => {
    let clock = Date.parse('2026-09-29T00:00:30.000Z');
    const { getToday } = renderToday(byDate(), { now: () => clock });
    await screen.findByRole('heading', { name: 'Timeline' });
    expect(screen.getByText('Today · Tuesday, September 29, 2026')).toBeVisible();
    clock = Date.parse('2026-09-28T23:59:30.000Z');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() =>
      expect(screen.getByText('Today · Monday, September 28, 2026')).toBeVisible(),
    );
    expect(getToday.mock.calls.map(([date]) => date)).toEqual(['2026-09-29', '2026-09-28']);
    expect(screen.queryByText(/A new day started/u)).toBeNull();
    expect(screen.getByText('Today now shows Monday, September 28, 2026.')).toBeInTheDocument();
  });

  it('moves focus to the heading at midnight only if the focused control went away', async () => {
    let clock = Date.parse('2026-09-28T23:59:30.000Z');
    renderToday(
      (date) =>
        Promise.resolve(
          date === '2026-09-28'
            ? populatedView()
            : populatedView({
                date: date as CalendarDate,
                flexible: { open: [], done: [] },
              }),
        ),
      { now: () => clock },
    );
    const complete = await screen.findByRole('button', { name: 'Complete Call the bank' });
    complete.focus();
    clock = Date.parse('2026-09-29T00:00:30.000Z');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await screen.findByText('No open flexible Actions on this day.');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  });

  it('keeps a selected date across midnight and only re-reads it', async () => {
    let clock = Date.parse('2026-09-28T23:59:30.000Z');
    const { getToday } = renderToday(byDate(), { path: '/?date=2026-09-28', now: () => clock });
    await screen.findByRole('heading', { level: 1, name: 'Monday, September 28, 2026' });
    expect(screen.getByText(/^Now 23:59/u)).toBeVisible();
    clock = Date.parse('2026-09-29T00:00:30.000Z');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() =>
      expect(screen.getByText('Yesterday · Monday, September 28, 2026')).toBeVisible(),
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Monday, September 28, 2026' }),
    ).toBeVisible();
    expect(screen.queryByText(/A new day started/u)).toBeNull();
    expect(screen.queryByTestId('timeline-now')).toBeNull();
    await waitFor(() =>
      expect(getToday.mock.calls.map(([date]) => date)).toEqual(['2026-09-28', '2026-09-28']),
    );
  });
});

describe('Today: review notice', () => {
  const notice = (due: Parameters<typeof reviewCheckpoint>[] = []) => {
    const getNotice = vi.fn<ReviewApplication['getNotice']>(() =>
      Promise.resolve({ due: due.map((args) => reviewCheckpoint(...args)) }),
    );
    return { getNotice, reviews: fakeReviews({ getNotice }) };
  };

  it('shows one quiet line with a link when a review is ready, never a dialog or an announcement', async () => {
    const { getNotice, reviews } = notice([[weeklyPeriod, 'ended', 'not_started']]);
    renderToday(byDate(), { reviews });
    const text = await screen.findByText('Your weekly review is ready.');
    const line = text.closest('p');
    expect(line).not.toBeNull();
    expect(within(line as HTMLElement).getByRole('link', { name: 'Open Review' })).toHaveAttribute(
      'href',
      '/review',
    );
    // In the header, and never live, alerting, or blocking.
    expect(text.closest('header')).not.toBeNull();
    expect(text.closest('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('link', { name: 'End day…' })).toBeVisible();
    expect(getNotice).toHaveBeenCalledTimes(1);
  });

  it('names every review that is ready in one line', async () => {
    renderToday(byDate(), {
      reviews: notice([
        [weeklyPeriod, 'ended', 'draft'],
        [monthlyPeriod, 'due', 'not_started'],
      ]).reviews,
    });
    expect(await screen.findByText('Your weekly and monthly reviews are ready.')).toBeVisible();
    cleanup();
    renderToday(byDate(), {
      reviews: notice([
        [weeklyPeriod, 'ended', 'draft'],
        [monthlyPeriod, 'due', 'not_started'],
        [yearlyPeriod, 'due', 'not_started'],
      ]).reviews,
    });
    expect(
      await screen.findByText('Your weekly, monthly, and yearly reviews are ready.'),
    ).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'Open Review' })).toHaveLength(1);
  });

  it('says nothing when no review is ready, when it cannot be read, or without Reviews', async () => {
    const { getNotice, reviews } = notice([]);
    renderToday(byDate(), { reviews });
    await screen.findByRole('heading', { level: 1, name: 'A useful day starts here.' });
    await waitFor(() => expect(getNotice).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Open Review' })).toBeNull();
    cleanup();
    renderToday(byDate(), {
      reviews: fakeReviews({ getNotice: vi.fn(() => Promise.reject(new Error('worker'))) }),
    });
    await screen.findByRole('heading', { level: 1, name: 'A useful day starts here.' });
    expect(screen.queryByText(/review is ready/u)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
    renderToday(byDate());
    await screen.findByRole('heading', { level: 1, name: 'A useful day starts here.' });
    expect(screen.queryByRole('link', { name: 'Open Review' })).toBeNull();
  });
});

describe('Today: sync line ', () => {
  const account = { email: 'sam@example.test' } as const;

  it('shows one quiet line in the header when changes wait, never a dialog or an announcement', async () => {
    const sync = fakeSync({ state: 'queued_offline', account, pendingChanges: 2 });
    renderToday(byDate(), { sync });
    const text = await screen.findByText('2 changes wait to sync. They are saved on this device.');
    const line = text.closest('p') as HTMLElement;
    expect(within(line).getByRole('link', { name: 'Open Account' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(text.closest('header')).not.toBeNull();
    expect(text.closest('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('link', { name: 'End day…' })).toBeVisible();
    expect(line.textContent).not.toMatch(forbidden);
  });

  it('links conflicts to their list and an ended session to Sign in again', async () => {
    const sync = fakeSync({ state: 'needs_attention', account, openConflicts: 2 });
    renderToday(byDate(), { sync });
    expect(await screen.findByText('Sync needs your choice on 2 conflicts.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review conflicts' })).toHaveAttribute(
      'href',
      '/account/conflicts',
    );
    act(() => sync.set({ state: 'auth_expired', openConflicts: 0 }));
    expect(
      screen.getByText('Your session ended. Your changes are saved on this device.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/account');
    act(() => sync.set({ state: 'server_unavailable' }));
    expect(
      screen.getByText(
        'Sync is paused because the server cannot be reached. Your changes are saved on this device.',
      ),
    ).toBeVisible();
    act(() => sync.set({ state: 'deletion_pending' }));
    expect(screen.getByText('Account deletion is pending.')).toBeVisible();
  });

  it('says nothing when synced, syncing, local only, or without accounts', async () => {
    const sync = fakeSync({ state: 'synced', account });
    const { getToday } = renderToday(byDate(), { sync });
    await screen.findByRole('heading', { name: 'Timeline' });
    expect(screen.queryByRole('link', { name: 'Open Account' })).toBeNull();
    for (const state of ['syncing', 'first_upload', 'signing_in', 'local_only'] as const) {
      act(() => sync.set({ state, pendingChanges: 3 }));
      expect(screen.queryByText(/to sync|Sync |session|deletion/u)).toBeNull();
    }
    act(() => sync.set({ state: 'queued_offline', pendingChanges: 0 }));
    expect(screen.queryByRole('link', { name: 'Open Account' })).toBeNull();
    // The line follows the status without reading the day again.
    act(() => sync.set({ state: 'queued_offline', pendingChanges: 1 }));
    expect(screen.getByText('1 change waits to sync. It is saved on this device.')).toBeVisible();
    expect(getToday).toHaveBeenCalledTimes(1);
    cleanup();
    renderToday(byDate());
    await screen.findByRole('heading', { name: 'Timeline' });
    expect(screen.queryByRole('link', { name: 'Open Account' })).toBeNull();
  });

  it('never blocks: every control stays enabled beside a sync line', async () => {
    const sync = fakeSync({ state: 'server_unavailable', account, pendingChanges: 4 });
    renderToday(byDate(), { sync });
    await screen.findByText(
      'Sync is paused because the server cannot be reached. Your changes are saved on this device.',
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(5);
    for (const button of buttons) expect(button).toBeEnabled();
  });
});
