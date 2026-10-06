// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapacitySettings, PlanningApplication } from '@yelaxis/application';
import type { IanaTimeZone } from '@yelaxis/domain';

import {
  LocationProbe,
  dayPlan,
  fakePlanning,
  installDialogPolyfill,
  profile,
  stubActions,
  weekPlan,
} from './__fixtures__/c1-planning-fake';
import { browserToday } from './format';
import { PlanningProvider } from './planning-context';
import { adjacentDate, PlanRoutes } from './plan-shell';
import { lastHorizonKey } from './routes';

let scrollTo: ReturnType<typeof vi.fn>;

beforeAll(() => {
  installDialogPolyfill();
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  scrollTo = vi.fn((x: number, y: number) => {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: y + x * 0 });
  });
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});

afterEach(() => cleanup());

function BackButton(): ReactNode {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      Test back
    </button>
  );
}

function renderShell(path: string, planning: PlanningApplication = defaultPlanning()): void {
  render(
    <PlanningProvider planning={planning} actions={stubActions}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/plan/*" element={<PlanRoutes />} />
          <Route path="*" element={<p>Elsewhere</p>} />
        </Routes>
        <LocationProbe />
        <BackButton />
      </MemoryRouter>
    </PlanningProvider>,
  );
}

function defaultPlanning(): PlanningApplication {
  return fakePlanning({
    getWeekPlan: vi.fn().mockResolvedValue(weekPlan()),
    getDayPlan: vi.fn().mockResolvedValue(dayPlan()),
  });
}

describe('Plan shell', () => {
  it('opens the last horizon used in this browser for today', async () => {
    window.localStorage.setItem(lastHorizonKey, 'day');
    const getDayPlan = vi.fn().mockResolvedValue(dayPlan());
    renderShell('/plan', fakePlanning({ getDayPlan }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(`/plan/day/${browserToday()}`),
    );
    await waitFor(() => expect(getDayPlan).toHaveBeenCalledWith(browserToday()));
  });

  it('defaults to the Week horizon and ignores an unknown stored value', async () => {
    window.localStorage.setItem(lastHorizonKey, 'decade');
    renderShell('/plan');
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(`/plan/week/${browserToday()}`),
    );
  });

  it('shows a calm state for an invalid horizon or date', () => {
    renderShell('/plan/week/2026-02-30');
    expect(
      screen.getByRole('heading', { level: 1, name: 'This plan link is not valid' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the current week' })).toHaveAttribute(
      'href',
      `/plan/week/${browserToday()}`,
    );
    cleanup();
    renderShell('/plan/decade/2026-09-29');
    expect(screen.getByRole('heading', { name: 'This plan link is not valid' })).toBeVisible();
  });

  it('switches horizons keeping the date and marks the active horizon', async () => {
    const user = userEvent.setup();
    renderShell('/plan/week/2026-09-29');
    const horizons = screen.getByRole('navigation', { name: 'Horizon' });
    expect(within(horizons).getByRole('link', { name: 'Week' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(horizons).getByRole('link', { name: 'Year' })).toHaveAttribute(
      'href',
      '/plan/year/2026-09-29',
    );
    const period = screen.getByRole('navigation', { name: 'Period' });
    expect(within(period).getByRole('link', { name: 'Previous week' })).toHaveAttribute(
      'href',
      '/plan/week/2026-09-22',
    );
    expect(within(period).getByRole('link', { name: 'Next week' })).toHaveAttribute(
      'href',
      '/plan/week/2026-10-06',
    );
    expect(within(period).getByRole('link', { name: 'Today' })).toHaveAttribute(
      'href',
      `/plan/week/${browserToday()}`,
    );
    const tools = screen.getByRole('navigation', { name: 'Planning tools' });
    expect(within(tools).getByRole('link', { name: 'Availability' })).toHaveAttribute(
      'href',
      '/plan/availability',
    );

    await user.click(within(horizons).getByRole('link', { name: 'Day' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/plan/day/2026-09-29');
    expect(window.localStorage.getItem(lastHorizonKey)).toBe('day');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('September 29');
  });

  it('goes to a chosen date in the current horizon', async () => {
    const user = userEvent.setup();
    renderShell('/plan/day/2026-09-29');
    const input = screen.getByLabelText('Go to date');
    await user.clear(input);
    await user.type(input, '2026-12-24');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/plan/day/2026-12-24');
  });

  it('restores the scroll position when returning with Back', async () => {
    const user = userEvent.setup();
    renderShell('/plan/week/2026-09-29');
    await screen.findByRole('heading', { name: 'Schedule' });
    act(() => {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 });
      window.dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => expect(Object.values(sessionStorageSnapshot())).toContain('640'));
    await user.click(screen.getByRole('link', { name: 'Next week' }));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    await user.click(screen.getByRole('button', { name: 'Test back' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/plan/week/2026-09-29');
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith(0, 640));
  });
});

function capacitySettings(planningTimeZone: string): CapacitySettings {
  return {
    profile: { ...profile, planningTimeZone: planningTimeZone as IanaTimeZone },
    availability: [],
    rules: { windows: [], caps: [] },
  };
}

describe('Plan shell: planning-zone today', () => {
  afterEach(() => vi.useRealTimers());

  /** A planning zone whose date differs from the browser's date at the faked instant. */
  function zoneAheadOrBehind(): { readonly zone: string; readonly today: string } {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T23:30:00Z'));
    return browserToday() === '2026-09-28'
      ? { zone: 'Pacific/Pago_Pago', today: '2026-09-27' }
      : { zone: 'Pacific/Kiritimati', today: '2026-09-28' };
  }

  it('opens /plan on today in the Profile planning zone, not the browser date', async () => {
    const { today, zone } = zoneAheadOrBehind();
    renderShell(
      '/plan',
      fakePlanning({
        getCapacitySettings: vi.fn().mockResolvedValue(capacitySettings(zone)),
        getWeekPlan: vi.fn().mockResolvedValue(weekPlan()),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(`/plan/week/${today}`),
    );
    const period = await screen.findByRole('navigation', { name: 'Period' });
    await waitFor(() =>
      expect(within(period).getByRole('link', { name: 'Today' })).toHaveAttribute(
        'href',
        `/plan/week/${today}`,
      ),
    );
  });

  it('starts the tool pages on the planning-zone today', async () => {
    const { today, zone } = zoneAheadOrBehind();
    renderShell(
      '/plan/availability',
      fakePlanning({
        getCapacitySettings: vi.fn().mockResolvedValue(capacitySettings(zone)),
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('Go to date')).toHaveValue(today));
  });
});

describe('Plan shell: unsaved changes', () => {
  it('asks before Go to date leaves a page with unsaved edits', async () => {
    const user = userEvent.setup();
    const getWeekPlan = vi.fn().mockResolvedValue(weekPlan());
    renderShell(
      '/plan/availability',
      fakePlanning({
        getCapacitySettings: vi.fn().mockResolvedValue(capacitySettings('UTC')),
        getWeekPlan,
      }),
    );
    const day = await screen.findByRole('group', { name: 'Day limit' });
    await user.type(within(day).getByRole('spinbutton', { name: 'Hours' }), '6');

    const input = screen.getByLabelText('Go to date');
    await user.clear(input);
    await user.type(input, '2026-11-03');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes before leaving?',
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/plan/availability');

    await user.click(within(dialog).getByRole('button', { name: 'Continue editing' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/plan/availability');
    expect(within(day).getByRole('spinbutton', { name: 'Hours' })).toHaveValue(6);

    await user.click(screen.getByRole('button', { name: 'Go' }));
    await user.click(
      within(
        await screen.findByRole('dialog', { name: 'Save your changes before leaving?' }),
      ).getByRole('button', { name: 'Discard' }),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/plan/week/2026-11-03');
  });

  it('goes to a date directly when nothing is unsaved', async () => {
    const user = userEvent.setup();
    renderShell(
      '/plan/availability',
      fakePlanning({
        getCapacitySettings: vi.fn().mockResolvedValue(capacitySettings('UTC')),
        getWeekPlan: vi.fn().mockResolvedValue(weekPlan()),
      }),
    );
    await screen.findByRole('group', { name: 'Day limit' });
    const input = screen.getByLabelText('Go to date');
    await user.clear(input);
    await user.type(input, '2026-11-03');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/plan/week/2026-11-03');
    expect(
      screen.queryByRole('dialog', { name: 'Save your changes before leaving?' }),
    ).not.toBeInTheDocument();
  });
});

function sessionStorageSnapshot(): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const key = window.sessionStorage.key(index);
    if (key !== null) values[key] = window.sessionStorage.getItem(key) ?? '';
  }
  return values;
}

describe('adjacentDate', () => {
  it('moves by the horizon and keeps a valid day of month', () => {
    expect(adjacentDate('day', '2026-03-01', -1)).toBe('2026-02-28');
    expect(adjacentDate('week', '2026-12-29', 1)).toBe('2027-01-05');
    expect(adjacentDate('month', '2026-01-31', 1)).toBe('2026-02-28');
    expect(adjacentDate('month', '2026-03-31', -1)).toBe('2026-02-28');
    expect(adjacentDate('year', '2028-02-29', 1)).toBe('2029-02-28');
  });
});
