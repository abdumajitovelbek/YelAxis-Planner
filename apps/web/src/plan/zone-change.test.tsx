// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CapacitySettings,
  PlanningApplication,
  PlanningZoneChangePreview,
} from '@yelaxis/application';
import type { CalendarDate, IanaTimeZone, Instant, UUID, WallTime } from '@yelaxis/domain';

import {
  fakePlanning,
  installDialogPolyfill,
  receipt,
  renderTree,
} from './__fixtures__/c1-planning-fake';
import { ZoneChangeNotice, zoneKeptKey } from './zone-change';

const newYork = 'America/New_York' as IanaTimeZone;
const london = 'Europe/London' as IanaTimeZone;

beforeAll(() => {
  installDialogPolyfill();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).resolvedOptions(),
    timeZone: london,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const settings = (zone: IanaTimeZone): CapacitySettings => ({
  profile: {
    profileId: 'profile-1' as UUID,
    planningTimeZone: zone,
    weekStart: 'monday',
    timeFormat: '24_hour',
  },
  availability: [],
  rules: { windows: [], caps: [] },
});

const preview: PlanningZoneChangePreview = {
  from: newYork,
  to: london,
  window: { start: '2026-09-28' as CalendarDate, end: '2026-10-25' as CalendarDate },
  profileRevision: 3,
  dateOnlyRoutineCount: 1,
  routines: [
    {
      routineId: 'routine-pages' as UUID,
      title: 'Morning pages',
      policy: { kind: 'follow_profile' },
      occurrences: [
        {
          date: '2026-09-29' as CalendarDate,
          instantChanges: true,
          before: {
            kind: 'timed',
            startsAt: '2026-09-29T11:00:00.000Z' as Instant,
            wallTime: '07:00' as WallTime,
            timeZone: newYork,
            localDate: '2026-09-29' as CalendarDate,
            localTime: '12:00' as WallTime,
          },
          after: {
            kind: 'timed',
            startsAt: '2026-09-29T06:00:00.000Z' as Instant,
            wallTime: '07:00' as WallTime,
            timeZone: london,
            localDate: '2026-09-29' as CalendarDate,
            localTime: '07:00' as WallTime,
          },
        },
      ],
    },
    {
      routineId: 'routine-call' as UUID,
      title: 'Call home',
      policy: { kind: 'fixed_zone', timeZone: newYork },
      occurrences: [
        {
          date: '2026-09-30' as CalendarDate,
          instantChanges: false,
          before: {
            kind: 'timed',
            startsAt: '2026-09-30T22:00:00.000Z' as Instant,
            wallTime: '18:00' as WallTime,
            timeZone: newYork,
            localDate: '2026-09-30' as CalendarDate,
            localTime: '23:00' as WallTime,
          },
          after: {
            kind: 'timed',
            startsAt: '2026-09-30T22:00:00.000Z' as Instant,
            wallTime: '18:00' as WallTime,
            timeZone: newYork,
            localDate: '2026-09-30' as CalendarDate,
            localTime: '23:00' as WallTime,
          },
        },
      ],
    },
  ],
};

function renderNotice(overrides: Partial<PlanningApplication>): void {
  render(renderTree(fakePlanning(overrides), <ZoneChangeNotice />));
}

describe('Device-zone change notice', () => {
  it('stays hidden when the device uses the planning zone', async () => {
    const getCapacitySettings = vi.fn().mockResolvedValue(settings(london));
    renderNotice({ getCapacitySettings });
    await waitFor(() => expect(getCapacitySettings).toHaveBeenCalled());
    expect(screen.queryByText(/Your device is set to/u)).not.toBeInTheDocument();
  });

  it('keeps the planning zone for this device zone without writing anything', async () => {
    const changePlanningZone = vi.fn();
    renderNotice({
      getCapacitySettings: vi.fn().mockResolvedValue(settings(newYork)),
      changePlanningZone,
    });
    expect(
      await screen.findByText(
        'Your device is set to Europe/London. Your plan uses America/New York.',
      ),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Keep America/New York' }));
    expect(screen.queryByText(/Your device is set to/u)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(zoneKeptKey(london))).toBe(newYork);
    expect(changePlanningZone).not.toHaveBeenCalled();
  });

  it('previews what would move and changes nothing on Cancel', async () => {
    const previewPlanningZoneChange = vi.fn().mockResolvedValue({ ok: true, value: preview });
    const changePlanningZone = vi.fn();
    renderNotice({
      getCapacitySettings: vi.fn().mockResolvedValue(settings(newYork)),
      previewPlanningZoneChange,
      changePlanningZone,
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Review a change to Europe/London…' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change the planning zone?' });
    const list = await within(dialog).findByRole('list', { name: 'Upcoming Routine times' });
    expect(within(list).getByText('Morning pages')).toBeVisible();
    expect(within(list).getByText(/07:00 stays 07:00, now in Europe\/London/u)).toBeVisible();
    expect(
      within(list).getByText(/18:00 America\/New York time, which is 23:00 in Europe\/London/u),
    ).toBeVisible();
    expect(within(dialog).getByText('1 other Routine keeps its dates.')).toBeVisible();
    expect(previewPlanningZoneChange).toHaveBeenCalledWith(london);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog).not.toBeVisible());
    expect(changePlanningZone).not.toHaveBeenCalled();
    expect(screen.getByText(/Your device is set to/u)).toBeVisible();
  });

  it('changes the planning zone only on the explicit choice, with Undo', async () => {
    const getCapacitySettings = vi
      .fn()
      .mockResolvedValueOnce(settings(newYork))
      .mockResolvedValue(settings(london));
    const changePlanningZone = vi.fn().mockResolvedValue(receipt());
    renderNotice({
      getCapacitySettings,
      previewPlanningZoneChange: vi.fn().mockResolvedValue({ ok: true, value: preview }),
      changePlanningZone,
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Review a change to Europe/London…' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change the planning zone?' });
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'Change to Europe/London' }),
    );
    expect(changePlanningZone).toHaveBeenCalledWith({ zone: london, revision: 3 });
    await waitFor(() =>
      expect(screen.queryByText(/Your device is set to/u)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
    expect(screen.getByText('Planning time zone changed to Europe/London.')).toBeInTheDocument();
  });

  it('says calmly when the preview cannot be calculated', async () => {
    renderNotice({
      getCapacitySettings: vi.fn().mockResolvedValue(settings(newYork)),
      previewPlanningZoneChange: vi.fn().mockRejectedValue(new Error('offline storage')),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Review a change to Europe/London…' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change the planning zone?' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The change could not be previewed. Nothing was changed.',
    );
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
