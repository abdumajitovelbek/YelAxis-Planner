// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, type InitialEntry } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ActionApplication,
  FocusSessionView,
  PlanningApplication,
  TodayApplication,
} from '@yelaxis/application';
import type { CalendarDate } from '@yelaxis/domain';

import { installDialogPolyfill, receipt } from '../plan/__fixtures__/c1-planning-fake';
import { PlanningProvider } from '../plan/planning-context';
import {
  focusActions,
  scheduledEntry,
  twelveHourProfile,
  mockOf,
} from './__fixtures__/focus-fixtures';
import {
  TodayLocationProbe,
  fakeToday,
  fixedNow,
  focusSession,
  todayAction,
  todayId,
  todayPlanning,
} from './__fixtures__/today-fake';
import { ClockContext, type NowSource } from './clock-context';
import { FocusPage, isFocusModeLinkState } from './focus-mode';
import { timeUpMessage } from './focus-timer';

beforeEach(() => installDialogPolyfill());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
});

const outline = todayAction(todayId(1), 'Draft the outline', {
  estimateMinutes: 45,
  projectTitle: 'Garden plan',
  axisTitle: 'Home',
  due: { kind: 'date', date: '2026-09-27' as CalendarDate },
});
const path = `/focus/${outline.id}`;
const { block } = scheduledEntry(outline, '14:00', '15:00');

function tree(
  today: TodayApplication,
  options: {
    readonly entries?: readonly InitialEntry[];
    readonly index?: number;
    readonly actions?: ActionApplication;
    readonly planning?: PlanningApplication;
    readonly now?: NowSource;
  } = {},
): ReactNode {
  return (
    <ClockContext.Provider value={options.now ?? fixedNow}>
      <PlanningProvider
        planning={options.planning ?? todayPlanning()}
        actions={options.actions ?? focusActions()}
        today={today}
      >
        <MemoryRouter
          initialEntries={[...(options.entries ?? [path])]}
          {...(options.index === undefined ? {} : { initialIndex: options.index })}
        >
          <Routes>
            <Route path="/focus/:actionId" element={<FocusPage />} />
            <Route path="*" element={<p>Another page</p>} />
          </Routes>
          <TodayLocationProbe />
        </MemoryRouter>
      </PlanningProvider>
    </ClockContext.Provider>
  );
}

const session = (overrides: Partial<FocusSessionView> = {}): FocusSessionView =>
  focusSession({ profile: twelveHourProfile, action: outline, ...overrides });

const sessionToday = (value: FocusSessionView | null) =>
  fakeToday({ getFocusSession: vi.fn(() => Promise.resolve(value)) });

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });

describe('FocusPage states', () => {
  it('opens calmly while loading', () => {
    render(tree(fakeToday({ getFocusSession: vi.fn(() => new Promise<never>(() => undefined)) })));
    expect(screen.getByRole('heading', { level: 1, name: 'Opening focus…' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('says an unknown or malformed Action is unavailable', async () => {
    const today = sessionToday(null);
    render(tree(today, { entries: ['/focus/not-an-id'] }));
    // The label contract's exact heading, like alignment "This Outcome is unavailable".
    expect(await heading('This Action is unavailable')).toBeVisible();
    expect(mockOf(today, 'getFocusSession')).toHaveBeenCalledWith('not-an-id');
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/');
  });

  it('offers a retry when the Action cannot be read', async () => {
    const getFocusSession = vi
      .fn<TodayApplication['getFocusSession']>()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(session());
    render(tree(fakeToday({ getFocusSession })));
    expect(await heading('Focus mode could not open.')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This Action could not be read. Your local plan was not changed.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await heading('Draft the outline')).toBeVisible();
  });

  it.each([
    ['completed', 'This Action is completed.'],
    ['canceled', 'This Action is canceled.'],
    ['archived', 'This Action is archived.'],
  ] as const)('shows a %s Action with its state and no timer', async (state, text) => {
    render(tree(sessionToday(session({ action: { ...outline, state } }))));
    expect(await heading('Draft the outline')).toBeVisible();
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Action details' })).toHaveAttribute(
      'href',
      `/actions/${outline.id}`,
    );
    expect(screen.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('heading', { name: 'Timer (optional)' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Complete/u })).toBeNull();
  });
});

describe('FocusPage', () => {
  it('shows one Action with its context in words', async () => {
    const next = { actionId: todayId(2), title: 'Call the printer' };
    render(
      tree(
        sessionToday(
          session({
            action: { ...outline, note: 'Start with the opening scene.' },
            overdue: true,
            plannedBlock: block,
            todayFocus: { selectionId: todayId(701), position: 1, next },
          }),
        ),
      ),
    );
    expect(await heading('Draft the outline')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Focus', { selector: '.eyebrow' })).toBeVisible();
    const facts = document.querySelector('dl.focus-facts');
    if (facts === null) throw new Error('No facts.');
    const pairs = [...facts.querySelectorAll('div')].map((row) => [
      row.querySelector('dt')?.textContent,
      row.querySelector('dd')?.textContent,
    ]);
    expect(pairs).toEqual([
      ['State', 'Planned'],
      ['Project', 'Garden plan'],
      ['Axis', 'Home'],
      ['Estimate', '45 minutes'],
      ['Due', 'Sunday, September 27, 2026 · The due date has passed.'],
      ['Planned time', 'Today, 2:00 PM–3:00 PM'],
      ['Note', 'Start with the opening scene.'],
    ]);
    expect(screen.getByRole('link', { name: 'Next focus item: Call the printer' })).toHaveAttribute(
      'href',
      `/focus/${todayId(2)}`,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Timer (optional)' })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Estimate (45 minutes)' })).toBeVisible();
    expect(screen.getByRole('radio', { name: '25 minutes' })).toBeChecked();
    expect(screen.getByRole('timer')).toHaveTextContent('25:00 remaining');
    expect(document.body.textContent).not.toMatch(/missed|behind|failed|streak|score|late/iu);
  });

  it('completes an Action without a planned time with the Actions undo', async () => {
    const actions = focusActions();
    const planning = todayPlanning();
    const getFocusSession = vi
      .fn<TodayApplication['getFocusSession']>()
      .mockResolvedValueOnce(session())
      .mockResolvedValue(session({ action: { ...outline, state: 'completed' } }));
    render(tree(fakeToday({ getFocusSession }), { actions, planning }));
    await heading('Draft the outline');
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(mockOf(actions, 'transition')).toHaveBeenCalledWith(outline.id, 1, 'completed');
    expect(await screen.findByText('This Action is completed.')).toBeVisible();
    expect(screen.getByText('Draft the outline completed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mockOf(actions, 'undo')).toHaveBeenCalledWith('undo-action'));
    expect(mockOf(planning, 'undo')).not.toHaveBeenCalled();
  });

  it('after Complete, moves focus to the title and still offers Next focus item and Exit focus', async () => {
    const next = { actionId: todayId(2), title: 'Call the printer' };
    const todayFocus = { selectionId: todayId(701), position: 1, next };
    const getFocusSession = vi
      .fn<TodayApplication['getFocusSession']>()
      .mockResolvedValueOnce(session({ todayFocus }))
      .mockResolvedValue(session({ action: { ...outline, state: 'completed' }, todayFocus }));
    const actions = focusActions();
    render(
      tree(fakeToday({ getFocusSession }), {
        entries: [
          '/?date=2026-09-29',
          { pathname: path, state: { returnTo: '/?date=2026-09-29' } },
        ],
        index: 1,
        actions,
      }),
    );
    const title = await heading('Draft the outline');
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(await screen.findByText('This Action is completed.')).toBeVisible();
    // The pressed Complete button left with the change: focus lands on the title.
    await waitFor(() => expect(title).toHaveFocus());
    expect(screen.getByRole('link', { name: 'Next focus item: Call the printer' })).toHaveAttribute(
      'href',
      `/focus/${todayId(2)}`,
    );
    expect(screen.queryByRole('link', { name: 'Back to Today' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Exit focus' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/?date=2026-09-29');
    expect(mockOf(actions, 'transition')).toHaveBeenCalledTimes(1);
  });

  it('asks how to complete an Action with a planned time and states each consequence', async () => {
    const setBlockState = vi.fn(() => Promise.resolve(receipt('undo-block')));
    const planning = todayPlanning({ setBlockState });
    const actions = focusActions();
    render(tree(sessionToday(session({ plannedBlock: block })), { actions, planning }));
    await heading('Draft the outline');
    await userEvent.click(screen.getByRole('button', { name: 'Complete…' }));
    const dialog = screen.getByRole('dialog', { name: 'Complete Draft the outline?' });
    expect(within(dialog).getByText('Its planned time: Today, 2:00 PM–3:00 PM.')).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: 'Complete Action only' }),
    ).toHaveAccessibleDescription('Its time block stays planned.');
    expect(
      within(dialog).getByRole('button', { name: 'Complete Action and its time block' }),
    ).toHaveAccessibleDescription('The time block is marked completed too.');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Complete Action and its time block' }),
    );
    expect(setBlockState).toHaveBeenCalledWith({
      blockId: block.id,
      revision: block.localRevision,
      to: 'completed',
      alsoCompleteAction: true,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockOf(actions, 'transition')).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Complete…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Complete Action only' }));
    expect(mockOf(actions, 'transition')).toHaveBeenCalledWith(outline.id, 1, 'completed');
    expect(setBlockState).toHaveBeenCalledTimes(1);
  });

  it('cancels the complete dialog without a command', async () => {
    const planning = todayPlanning();
    const actions = focusActions();
    render(tree(sessionToday(session({ plannedBlock: block })), { actions, planning }));
    await heading('Draft the outline');
    await userEvent.click(screen.getByRole('button', { name: 'Complete…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockOf(actions, 'transition')).not.toHaveBeenCalled();
    expect(mockOf(planning, 'setBlockState')).not.toHaveBeenCalled();
  });

  it('exits back to the opening view without asking or writing anything', async () => {
    const today = sessionToday(session());
    const actions = focusActions();
    const planning = todayPlanning();
    render(
      tree(today, {
        entries: [
          '/?date=2026-09-29',
          { pathname: path, state: { returnTo: '/?date=2026-09-29' } },
        ],
        index: 1,
        actions,
        planning,
      }),
    );
    await heading('Draft the outline');
    await userEvent.click(screen.getByRole('button', { name: 'Exit focus' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/?date=2026-09-29');
    expect(screen.queryByRole('dialog')).toBeNull();
    for (const [name, method] of Object.entries(today))
      if (name !== 'getFocusSession') expect(method).not.toHaveBeenCalled();
    expect(mockOf(actions, 'transition')).not.toHaveBeenCalled();
    expect(mockOf(planning, 'undo')).not.toHaveBeenCalled();
  });

  it('exits a direct link to Today', async () => {
    render(tree(sessionToday(session())));
    await heading('Draft the outline');
    await userEvent.click(screen.getByRole('button', { name: 'Exit focus' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/u);
  });

  it('has no Escape shortcut and no leave prompt', async () => {
    const listeners = vi.spyOn(window, 'addEventListener');
    render(tree(sessionToday(session())));
    await heading('Draft the outline');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('location')).toHaveTextContent(path);
    expect(listeners.mock.calls.map(([type]) => type)).not.toContain('beforeunload');
    listeners.mockRestore();
  });

  it('recognizes in-app Focus mode navigation state', () => {
    expect(isFocusModeLinkState({ returnTo: '/' })).toBe(true);
    expect(isFocusModeLinkState({ returnTo: 'https://example.invalid/' })).toBe(false);
    expect(isFocusModeLinkState(null)).toBe(false);
    expect(isFocusModeLinkState('/')).toBe(false);
  });
});

describe('FocusPage timer', () => {
  const start = Date.parse('2026-09-28T09:00:00.000Z');
  const minutes = (value: number) => value * 60_000;
  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const setVisibility = (value: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };

  async function openWithFakeClock(value: FocusSessionView = session()) {
    const today = sessionToday(value);
    const actions = focusActions();
    const planning = todayPlanning();
    render(tree(today, { actions, planning, now: () => Date.now() }));
    await heading('Draft the outline');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: start });
    return { today, actions, planning };
  }

  it('runs from timestamps, pauses, keeps time while hidden, and says time is up once', async () => {
    const { actions, planning, today } = await openWithFakeClock();
    const timer = () => screen.getByRole('timer');
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }));
    expect(screen.getByText('Timer started.')).toBeInTheDocument();
    expect(timer()).toHaveTextContent('25:00 remaining');
    // Each redraw lands just after the timer's whole second.
    advance(minutes(10) + 10);
    expect(timer()).toHaveTextContent('15:00 remaining');
    // The length cannot change while the timer runs.
    expect(screen.getByRole('radio', { name: '50 minutes' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Pause timer' }));
    expect(screen.getByText('Timer paused.')).toBeInTheDocument();
    advance(minutes(5));
    expect(timer()).toHaveTextContent('15:00 remaining');

    fireEvent.click(screen.getByRole('button', { name: 'Resume timer' }));
    expect(screen.getByText('Timer resumed.')).toBeInTheDocument();
    setVisibility('hidden');
    advance(minutes(16));
    // Nothing redraws while the page is hidden.
    expect(timer()).toHaveTextContent('15:00 remaining');
    setVisibility('visible');
    expect(timer()).toHaveTextContent('00:00 remaining');
    expect(screen.getAllByText(timeUpMessage)).toHaveLength(1);
    advance(minutes(1));
    expect(screen.getAllByText(timeUpMessage)).toHaveLength(1);

    // Time is up two minutes ago: the added minutes count from the press, as the reading says.
    fireEvent.click(screen.getByRole('button', { name: 'Add 5 minutes' }));
    expect(timer()).toHaveTextContent('05:00 remaining');
    const added = screen.getByText('5 minutes added.');
    // A second press says it again: the status line replaces its text node for every press.
    fireEvent.click(screen.getByRole('button', { name: 'Add 5 minutes' }));
    expect(timer()).toHaveTextContent('10:00 remaining');
    expect(screen.getAllByText('5 minutes added.')).toHaveLength(1);
    expect(screen.getByText('5 minutes added.')).not.toBe(added);

    const reset = screen.getByRole('button', { name: 'Reset timer' });
    reset.focus();
    fireEvent.click(reset);
    expect(screen.getByText('Timer reset.')).toBeInTheDocument();
    expect(timer()).toHaveTextContent('25:00 remaining');
    expect(screen.getByRole('button', { name: 'Start timer' })).toHaveFocus();

    // The timer never reads or writes the plan.
    for (const [name, method] of Object.entries(today))
      if (name !== 'getFocusSession') expect(method).not.toHaveBeenCalled();
    expect(mockOf(today, 'getFocusSession')).toHaveBeenCalledTimes(1);
    expect(mockOf(actions, 'transition')).not.toHaveBeenCalled();
    expect(mockOf(planning, 'setBlockState')).not.toHaveBeenCalled();
    expect(mockOf(planning, 'undo')).not.toHaveBeenCalled();
  });

  it('counts up without a time limit and uses the estimate as a length', async () => {
    await openWithFakeClock();
    fireEvent.click(screen.getByRole('radio', { name: 'No time limit' }));
    expect(screen.getByRole('timer')).toHaveTextContent('00:00 elapsed');
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }));
    advance(minutes(3) + 20_010);
    expect(screen.getByRole('timer')).toHaveTextContent('03:20 elapsed');
    expect(screen.queryByRole('button', { name: 'Add 5 minutes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset timer' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Estimate (45 minutes)' }));
    expect(screen.getByRole('timer')).toHaveTextContent('45:00 remaining');
  });

  it('asks for a custom length of 1 to 240 minutes before starting', async () => {
    await openWithFakeClock();
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    const input = screen.getByRole('spinbutton', { name: 'Custom length in minutes' });
    expect(screen.getByRole('timer')).toHaveTextContent('No length chosen yet');
    fireEvent.change(input, { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter whole minutes from 1 to 240.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Start timer' })).toBeVisible();
    fireEvent.change(input, { target: { value: '40' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }));
    expect(screen.getByRole('timer')).toHaveTextContent('40:00 remaining');
  });
});
