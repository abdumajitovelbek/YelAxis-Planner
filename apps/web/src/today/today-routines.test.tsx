// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PlanningApplication, TodayView } from '@yelaxis/application';

import { installDialogPolyfill, receipt } from '../plan/__fixtures__/c1-planning-fake';
import { fakeToday, todayPlanning, todayTree } from './__fixtures__/today-fake';
import {
  callBank,
  populatedView,
  stretch,
  swim,
  todaySettings,
} from './__fixtures__/today-view-fixtures';
import { TodayRoute } from './today-page';

beforeAll(() => {
  installDialogPolyfill();
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
});

afterEach(() => cleanup());

function renderRoutines(view: TodayView, overrides: Partial<PlanningApplication> = {}) {
  const planning = todayPlanning({
    getCapacitySettings: vi.fn(() => Promise.resolve(todaySettings)),
    ...overrides,
  });
  render(
    todayTree(
      fakeToday({ getToday: vi.fn(() => Promise.resolve(view)) }),
      <TodayRoute defaultsConfirmed onResumeSetup={() => undefined} />,
      { planning },
    ),
  );
  return { user: userEvent.setup() };
}

const section = async () =>
  (await screen.findByRole('heading', { level: 2, name: 'Routines' })).closest(
    'section',
  ) as HTMLElement;

describe('Today Routines', () => {
  it('lists the day’s Routines with compact controls and this week’s counts', async () => {
    const completeOccurrence = vi.fn(() => Promise.resolve(receipt()));
    const skipOccurrence = vi.fn(() => Promise.resolve(receipt()));
    const { user } = renderRoutines(populatedView(), { completeOccurrence, skipOccurrence });
    const routines = await section();
    const day = within(routines).getByRole('list', {
      name: 'Routines for Monday, September 28, 2026',
    });
    expect(within(day).getByText('Stretch', { selector: '.routine-title' })).toBeVisible();
    expect(within(day).getByText('Planned')).toBeVisible();
    expect(within(day).getByRole('link', { name: 'Details Stretch' })).toBeVisible();
    // Editing an occurrence stays in the Plan views.
    expect(within(routines).queryByRole('button', { name: /Edit this occurrence/u })).toBeNull();
    await user.click(within(day).getByRole('button', { name: 'Complete Stretch' }));
    expect(completeOccurrence).toHaveBeenCalledWith({
      occurrence: { routineId: stretch.ref.routineId, generation: 1, period: stretch.ref.period },
    });
    expect(await screen.findByText('Occurrence completed.')).toBeInTheDocument();
    await user.click(within(day).getByRole('button', { name: 'Skip Stretch' }));
    expect(skipOccurrence).toHaveBeenCalledOnce();

    expect(within(routines).getByRole('heading', { level: 3, name: 'This week' })).toBeVisible();
    const week = within(routines).getByRole('list', { name: 'This week' });
    expect(within(week).getByText('1 of 2 this week')).toBeVisible();
    expect(within(week).getByRole('button', { name: 'Log one Swim' })).toBeVisible();
    expect(swim.timing.kind).toBe('weekly_count');
  });

  it('shows a skipped occurrence as a neutral state, never a warning', async () => {
    renderRoutines(
      populatedView({
        routines: { day: [{ ...stretch, state: 'skipped' }], week: [] },
      }),
    );
    const routines = await section();
    expect(within(routines).getByText('Skipped')).toBeVisible();
    expect(within(routines).getByRole('button', { name: 'Reopen Stretch' })).toBeVisible();
    expect(routines.textContent).not.toMatch(/missed|streak|failed|behind/iu);
    expect(within(routines).queryByRole('heading', { name: 'This week' })).toBeNull();
  });

  it('says when there are no other Routines on the day', async () => {
    renderRoutines(
      populatedView({
        flexible: { open: [callBank], done: [] },
        routines: { day: [], week: [] },
      }),
    );
    const routines = await section();
    expect(within(routines).getByText('No other Routines on this day.')).toBeVisible();
    expect(within(routines).getByText('Routines at a set time are on the timeline.')).toBeVisible();
  });
});
