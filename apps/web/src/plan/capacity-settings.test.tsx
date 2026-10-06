// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ActionApplication,
  ApplicationResult,
  CapacitySettings,
  CommandReceipt,
  PlanningApplication,
} from '@yelaxis/application';
import type { IanaTimeZone, Instant, UUID, WallTime, Weekday } from '@yelaxis/domain';

import {
  CapacitySettingsPage,
  parseLimit,
  validateAvailabilityDraft,
  windowLines,
} from './capacity-settings';
import { PlanningProvider } from './planning-context';

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

afterEach(() => cleanup());

const id = (suffix: string): UUID => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}` as UUID;
const w = (value: string): WallTime => value as WallTime;
const profile = {
  profileId: id('1'),
  planningTimeZone: 'Europe/Berlin' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
} as const;
const workdays: readonly Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

function settings(overrides: Partial<CapacitySettings> = {}): CapacitySettings {
  return {
    profile,
    availability: [
      {
        id: id('11'),
        localRevision: 3,
        strength: 'soft',
        label: 'Work hours',
        windows: [
          ...workdays.map((weekday) => ({ weekday, start: w('09:00'), end: w('17:00') })),
          { weekday: 'monday', start: w('18:00'), end: w('19:00') },
        ],
      },
    ],
    weekCap: { id: id('13'), localRevision: 1, minutes: 2400 },
    rules: { windows: [], caps: [] },
    ...overrides,
  };
}

function renderSettings(planning: PlanningApplication) {
  return render(
    <PlanningProvider planning={planning} actions={stubActions()}>
      <MemoryRouter initialEntries={['/plan/availability']}>
        <Routes>
          <Route path="/plan/availability" element={<CapacitySettingsPage />} />
          <Route path="*" element={<p>Elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </PlanningProvider>,
  );
}

describe('Availability and capacity settings', () => {
  it('explains capacity, lists availability by weekday, and summarizes known days', async () => {
    renderSettings(fakePlanning({ getCapacitySettings: vi.fn().mockResolvedValue(settings()) }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Availability and capacity' }),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByText(
        /Days without defined availability stay unknown and are never treated as free/u,
      ),
    ).toBeVisible();
    expect(screen.getByText('Available time is defined for 5 of 7 weekdays.')).toBeVisible();

    const windows = screen.getByRole('list', { name: 'Work hours windows' });
    const lines = within(windows).getAllByRole('listitem');
    expect(lines[0]).toHaveTextContent('Mon 09:00–17:00, 18:00–19:00');
    expect(lines[4]).toHaveTextContent('Fri 09:00–17:00');
    expect(screen.getByText('Soft')).toBeVisible();
    expect(screen.getByText('Current week limit: 40 hours.')).toBeVisible();
    expect(screen.getByText('No day limit set.')).toBeVisible();
    expect(screen.queryByText(/%/u)).not.toBeInTheDocument();
  });

  it('shows an empty state and a recoverable error', async () => {
    const user = userEvent.setup();
    const getCapacitySettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(settings({ availability: [] }));
    renderSettings(fakePlanning({ getCapacitySettings }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No availability is defined yet/u)).toBeVisible();
    expect(screen.getByText('Available time is defined for 0 of 7 weekdays.')).toBeVisible();
  });

  it('validates and adds availability with several windows and an explicit strength', async () => {
    const user = userEvent.setup();
    const addAvailability = vi.fn().mockResolvedValue(receipt());
    renderSettings(
      fakePlanning({
        getCapacitySettings: vi.fn().mockResolvedValue(settings({ availability: [] })),
        addAvailability,
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Add availability' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Add availability' })).toHaveFocus(),
    );
    await user.click(screen.getByRole('button', { name: 'Save availability' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Choose how firm this availability is.');
    expect(alert).toHaveTextContent('The time window needs at least one day.');
    expect(alert).toHaveTextContent('The time window needs a start and end time.');
    expect(addAvailability).not.toHaveBeenCalled();

    const first = screen.getByRole('group', { name: 'Time window' });
    await user.click(within(first).getByRole('checkbox', { name: 'Monday' }));
    await user.click(within(first).getByRole('checkbox', { name: 'Wednesday' }));
    await user.type(within(first).getByLabelText('Start'), '09:00');
    await user.type(within(first).getByLabelText('End'), '12:00');

    await user.click(screen.getByRole('button', { name: 'Add another time window' }));
    const second = screen.getByRole('group', { name: 'Time window 2' });
    await user.click(within(second).getByRole('checkbox', { name: 'Saturday' }));
    await user.type(within(second).getByLabelText('Start'), '14:00');
    await user.type(within(second).getByLabelText('End'), '13:00');
    await user.click(screen.getByRole('radio', { name: /Hard/u }));
    await user.click(screen.getByRole('button', { name: 'Save availability' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Time window 2 must end after it starts, within the same day.',
    );
    expect(within(second).getByLabelText('End')).toHaveAttribute('aria-invalid', 'true');

    await user.clear(within(second).getByLabelText('End'));
    await user.type(within(second).getByLabelText('End'), '16:30');
    await user.click(screen.getByRole('button', { name: 'Save availability' }));
    expect(addAvailability).toHaveBeenCalledWith({
      strength: 'hard',
      windows: [
        { weekday: 'monday', start: '09:00', end: '12:00' },
        { weekday: 'wednesday', start: '09:00', end: '12:00' },
        { weekday: 'saturday', start: '14:00', end: '16:30' },
      ],
    });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Add availability' })).not.toBeInTheDocument(),
    );
  });

  it('edits and archives availability with undo', async () => {
    const user = userEvent.setup();
    const editAvailability = vi.fn().mockResolvedValue(receipt());
    const archiveConstraint = vi
      .fn()
      .mockResolvedValue(receipt('90000000-0000-4000-8000-000000000002'));
    const undo = vi.fn().mockResolvedValue(receipt());
    renderSettings(
      fakePlanning({
        getCapacitySettings: vi.fn().mockResolvedValue(settings()),
        editAvailability,
        archiveConstraint,
        undo,
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Edit Work hours' }));
    const first = screen.getByRole('group', { name: 'Time window 1' });
    expect(within(first).getByRole('checkbox', { name: 'Friday' })).toBeChecked();
    expect(within(first).getByLabelText('Start')).toHaveValue('09:00');
    expect(screen.getByRole('radio', { name: /Soft/u })).toBeChecked();
    await user.click(within(first).getByRole('checkbox', { name: 'Friday' }));
    await user.click(screen.getByRole('button', { name: 'Save availability' }));
    expect(editAvailability).toHaveBeenCalledWith({
      constraintId: id('11'),
      revision: 3,
      strength: 'soft',
      windows: [
        { weekday: 'monday', start: '09:00', end: '17:00' },
        { weekday: 'tuesday', start: '09:00', end: '17:00' },
        { weekday: 'wednesday', start: '09:00', end: '17:00' },
        { weekday: 'thursday', start: '09:00', end: '17:00' },
        { weekday: 'monday', start: '18:00', end: '19:00' },
      ],
    });

    await user.click(await screen.findByRole('button', { name: 'Archive Work hours' }));
    expect(archiveConstraint).toHaveBeenCalledWith({ constraintId: id('11'), revision: 3 });
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledWith('90000000-0000-4000-8000-000000000002');
  });

  it('sets, validates, and clears day and week limits', async () => {
    const user = userEvent.setup();
    const setCapacityCap = vi.fn().mockResolvedValue(receipt());
    renderSettings(
      fakePlanning({ getCapacitySettings: vi.fn().mockResolvedValue(settings()), setCapacityCap }),
    );

    const day = await screen.findByRole('group', { name: 'Day limit' });
    await user.type(within(day).getByRole('spinbutton', { name: 'Hours' }), '7');
    await user.type(within(day).getByRole('spinbutton', { name: 'Minutes' }), '75');
    await user.click(within(day).getByRole('button', { name: 'Set day limit' }));
    expect(await within(day).findByRole('alert')).toHaveTextContent(
      'Minutes must be between 0 and 59.',
    );
    expect(setCapacityCap).not.toHaveBeenCalled();

    await user.clear(within(day).getByRole('spinbutton', { name: 'Minutes' }));
    await user.type(within(day).getByRole('spinbutton', { name: 'Minutes' }), '30');
    await user.click(within(day).getByRole('button', { name: 'Set day limit' }));
    expect(setCapacityCap).toHaveBeenCalledWith({ period: 'day', minutes: 450 });

    const week = screen.getByRole('group', { name: 'Week limit' });
    expect(within(week).getByRole('spinbutton', { name: 'Hours' })).toHaveValue(40);
    await user.click(within(week).getByRole('button', { name: 'Clear week limit' }));
    expect(setCapacityCap).toHaveBeenCalledWith({ period: 'week', minutes: null });
  });

  it('guards unsaved limit edits before leaving', async () => {
    const user = userEvent.setup();
    const setCapacityCap = vi.fn().mockResolvedValue(receipt());
    render(
      <PlanningProvider
        planning={fakePlanning({
          getCapacitySettings: vi.fn().mockResolvedValue(settings()),
          setCapacityCap,
        })}
        actions={stubActions()}
      >
        <MemoryRouter initialEntries={['/plan/availability']}>
          <Routes>
            <Route
              path="/plan/availability"
              element={
                <>
                  <a href="/plan/week/2026-08-10">Week</a>
                  <CapacitySettingsPage />
                </>
              }
            />
            <Route path="*" element={<p>Elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </PlanningProvider>,
    );
    const day = await screen.findByRole('group', { name: 'Day limit' });
    await user.type(within(day).getByRole('spinbutton', { name: 'Hours' }), '6');
    await user.click(screen.getByRole('link', { name: 'Week' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save your changes before leaving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(setCapacityCap).toHaveBeenCalledWith({ period: 'day', minutes: 360 });
    expect(await screen.findByText('Elsewhere')).toBeVisible();
  });
});

describe('Availability and capacity settings: guarded edits and feedback', () => {
  const twoSets = (): CapacitySettings =>
    settings({
      availability: [
        {
          id: id('11'),
          localRevision: 3,
          strength: 'soft',
          windows: [{ weekday: 'monday', start: w('09:00'), end: w('12:00') }],
        },
        {
          id: id('12'),
          localRevision: 1,
          strength: 'hard',
          windows: [{ weekday: 'tuesday', start: w('13:00'), end: w('17:00') }],
        },
      ],
    });

  it('keeps one editor open at a time so switching sets never discards an edit', async () => {
    const user = userEvent.setup();
    renderSettings(fakePlanning({ getCapacitySettings: vi.fn().mockResolvedValue(twoSets()) }));

    await user.click(await screen.findByRole('button', { name: 'Edit Availability 1' }));
    const row = screen.getByRole('group', { name: 'Time window' });
    await user.click(within(row).getByRole('checkbox', { name: 'Wednesday' }));
    const other = screen.getByRole('button', { name: 'Edit Availability 2' });
    expect(other).toBeDisabled();
    expect(other).toHaveAccessibleDescription(
      'Save or cancel the open edit before editing another availability set.',
    );
    expect(
      within(screen.getByRole('group', { name: 'Time window' })).getByRole('checkbox', {
        name: 'Wednesday',
      }),
    ).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Edit Availability 2' }));
    const replaced = screen.getByRole('group', { name: 'Time window' });
    expect(within(replaced).getByRole('checkbox', { name: 'Tuesday' })).toBeChecked();
    expect(within(replaced).getByLabelText('Start')).toHaveValue('13:00');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens an editor without asking about unrelated unsaved limit edits', async () => {
    const user = userEvent.setup();
    renderSettings(fakePlanning({ getCapacitySettings: vi.fn().mockResolvedValue(twoSets()) }));

    const dayLimit = await screen.findByRole('group', { name: 'Day limit' });
    await user.type(within(dayLimit).getByLabelText('Hours'), '5');
    await user.click(screen.getByRole('button', { name: 'Edit Availability 1' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Time window' })).toBeInTheDocument();
    expect(within(dayLimit).getByLabelText('Hours')).toHaveValue(5);
  });

  it('resyncs a limit field after Undo and does not report unsaved changes', async () => {
    const user = userEvent.setup();
    const base = settings();
    const noLimits: CapacitySettings = {
      profile: base.profile,
      availability: base.availability,
      rules: base.rules,
    };
    let current = noLimits;
    const getCapacitySettings = vi.fn(() => Promise.resolve(current));
    const setCapacityCap = vi.fn(() => {
      current = { ...noLimits, dayCap: { id: id('14'), localRevision: 1, minutes: 480 } };
      return Promise.resolve(receipt());
    });
    const undo = vi.fn(() => {
      current = noLimits;
      return Promise.resolve(receipt());
    });
    render(
      <PlanningProvider
        planning={fakePlanning({ getCapacitySettings, setCapacityCap, undo })}
        actions={stubActions()}
      >
        <MemoryRouter initialEntries={['/plan/availability']}>
          <Routes>
            <Route
              path="/plan/availability"
              element={
                <>
                  <Link to="/plan/week/2026-08-10">Week</Link>
                  <CapacitySettingsPage />
                </>
              }
            />
            <Route path="*" element={<p>Elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </PlanningProvider>,
    );

    const day = await screen.findByRole('group', { name: 'Day limit' });
    await user.type(within(day).getByRole('spinbutton', { name: 'Hours' }), '8');
    await user.click(within(day).getByRole('button', { name: 'Set day limit' }));
    expect(await within(day).findByText('Current day limit: 8 hours.')).toBeVisible();

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await within(day).findByText('No day limit set.')).toBeVisible();
    await waitFor(() =>
      expect(within(day).getByRole('spinbutton', { name: 'Hours' })).toHaveValue(null),
    );
    await user.click(screen.getByRole('link', { name: 'Week' }));
    expect(await screen.findByText('Elsewhere')).toBeVisible();
    expect(
      screen.queryByRole('dialog', { name: 'Save your changes before leaving?' }),
    ).not.toBeInTheDocument();
  });

  it('accepts 00:00 as an end of midnight and shows it as 24:00', async () => {
    const user = userEvent.setup();
    const addAvailability = vi.fn().mockResolvedValue(receipt());
    renderSettings(
      fakePlanning({
        getCapacitySettings: vi.fn().mockResolvedValue(
          settings({
            availability: [
              {
                id: id('11'),
                localRevision: 1,
                strength: 'soft',
                windows: [{ weekday: 'friday', start: w('18:00'), end: w('00:00') }],
              },
            ],
          }),
        ),
        addAvailability,
      }),
    );

    expect(
      within(await screen.findByRole('list', { name: 'Availability 1 windows' })).getByRole(
        'listitem',
      ),
    ).toHaveTextContent('Fri 18:00–24:00');

    await user.click(screen.getByRole('button', { name: 'Add availability' }));
    const row = screen.getByRole('group', { name: 'Time window' });
    await user.click(within(row).getByRole('checkbox', { name: 'Saturday' }));
    await user.type(within(row).getByLabelText('Start'), '20:00');
    await user.type(within(row).getByLabelText('End'), '00:00');
    await user.click(screen.getByRole('radio', { name: /Soft/u }));
    await user.click(screen.getByRole('button', { name: 'Save availability' }));
    expect(addAvailability).toHaveBeenCalledWith({
      strength: 'soft',
      windows: [{ weekday: 'saturday', start: '20:00', end: '00:00' }],
    });
  });

  it('announces each saved change once, even when the message repeats', async () => {
    const user = userEvent.setup();
    const setCapacityCap = vi.fn().mockResolvedValue(receipt());
    const { container } = renderSettings(
      fakePlanning({ getCapacitySettings: vi.fn().mockResolvedValue(settings()), setCapacityCap }),
    );

    const day = await screen.findByRole('group', { name: 'Day limit' });
    await user.type(within(day).getByRole('spinbutton', { name: 'Hours' }), '6');
    await user.click(within(day).getByRole('button', { name: 'Set day limit' }));
    await screen.findByRole('button', { name: 'Undo' });
    const region = container.querySelector('[aria-live="polite"].sr-only');
    expect(region).toHaveTextContent('Day limit set.');
    const first = region?.firstElementChild;
    expect(first).not.toBeNull();

    await user.click(within(day).getByRole('button', { name: 'Set day limit' }));
    await waitFor(() => expect(setCapacityCap).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(region?.firstElementChild).not.toBe(first));
    expect(region).toHaveTextContent('Day limit set.');

    // The undo bar shows a visible confirmation but is not a second live region.
    const undoBar = screen.getByRole('button', { name: 'Undo' }).closest('.undo-bar');
    expect(undoBar).toHaveTextContent('Change saved.');
    expect(undoBar).not.toHaveAttribute('role');
    expect(undoBar).not.toHaveAttribute('aria-live');
  });
});

describe('Availability helpers', () => {
  it('groups windows by weekday in the profile week order', () => {
    expect(
      windowLines(
        [
          { weekday: 'sunday', start: w('10:00'), end: w('12:00') },
          { weekday: 'monday', start: w('13:00'), end: w('14:00') },
          { weekday: 'monday', start: w('08:00'), end: w('09:00') },
        ],
        { ...profile, weekStart: 'sunday' },
      ),
    ).toEqual(['Sun 10:00–12:00', 'Mon 08:00–09:00, 13:00–14:00']);
  });

  it('accepts 00:00 as a midnight end only after a later start', () => {
    expect(
      validateAvailabilityDraft('soft', [{ days: ['monday'], start: '18:00', end: '00:00' }]),
    ).toEqual({
      ok: true,
      input: { strength: 'soft', windows: [{ weekday: 'monday', start: '18:00', end: '00:00' }] },
    });
    expect(
      validateAvailabilityDraft('soft', [{ days: ['monday'], start: '00:00', end: '00:00' }]).ok,
    ).toBe(false);
    expect(
      windowLines([{ weekday: 'monday', start: w('20:00'), end: w('00:00') }], {
        ...profile,
        timeFormat: '12_hour',
      }),
    ).toEqual(['Mon 8:00 PM–midnight']);
  });

  it('never invents a strength and rejects backwards windows', () => {
    expect(
      validateAvailabilityDraft('', [{ days: ['monday'], start: '09:00', end: '10:00' }]).ok,
    ).toBe(false);
    expect(
      validateAvailabilityDraft('soft', [{ days: ['monday'], start: '10:00', end: '10:00' }]).ok,
    ).toBe(false);
  });

  it('parses limits conservatively', () => {
    expect(parseLimit('8', '', 'day')).toEqual({ ok: true, minutes: 480 });
    expect(parseLimit('', '', 'day').ok).toBe(false);
    expect(parseLimit('25', '0', 'day').ok).toBe(false);
    expect(parseLimit('169', '0', 'week').ok).toBe(false);
    expect(parseLimit('1.5', '0', 'week').ok).toBe(false);
  });
});

/* ───────────── Typed fakes ───────────── */

const planningMethods: Readonly<Record<keyof PlanningApplication, true>> = {
  getDayPlan: true,
  getWeekPlan: true,
  getMonthPlan: true,
  getYearPlan: true,
  getMilestoneChain: true,
  resolveLocalInterval: true,
  listRoutines: true,
  getRoutine: true,
  previewRoutine: true,
  listTemplates: true,
  getTemplate: true,
  previewTemplate: true,
  getCapacitySettings: true,
  listAxes: true,
  listProjects: true,
  createCustomBlock: true,
  scheduleAction: true,
  moveBlock: true,
  shortenBlock: true,
  setBlockState: true,
  keepOverlap: true,
  createCommitment: true,
  place: true,
  unplace: true,
  carryForward: true,
  reorderPlacement: true,
  addWeekCommitment: true,
  removeWeekCommitment: true,
  createRoutine: true,
  repeatAfterAction: true,
  editRoutineDetails: true,
  editRoutineThisAndFuture: true,
  pauseRoutine: true,
  resumeRoutine: true,
  archiveRoutine: true,
  restoreRoutine: true,
  completeOccurrence: true,
  skipOccurrence: true,
  reopenOccurrence: true,
  editOccurrence: true,
  applyTemplate: true,
  duplicateTemplate: true,
  saveTemplate: true,
  archiveTemplate: true,
  restoreTemplate: true,
  saveWeekAsTemplate: true,
  addAvailability: true,
  editAvailability: true,
  archiveConstraint: true,
  setCapacityCap: true,
  setMonthTheme: true,
  clearMonthTheme: true,
  setYearDirection: true,
  clearYearDirection: true,
  previewPlanningZoneChange: true,
  changePlanningZone: true,
  getTimeBlockReminder: true,
  setTimeBlockReminder: true,
  turnOffTimeBlockReminder: true,
  setRoutineReminder: true,
  turnOffRoutineReminder: true,
  undo: true,
};

/** Every PlanningApplication method is present; any call not overridden rejects. */
function fakePlanning(overrides: Partial<PlanningApplication>): PlanningApplication {
  const unused = (name: string) => () =>
    Promise.reject(new Error(`Unexpected planning call: ${name}`));
  const base = Object.fromEntries(
    Object.keys(planningMethods).map((name) => [name, unused(name)]),
  ) as unknown as PlanningApplication;
  return { ...base, ...overrides };
}

function stubActions(): ActionApplication {
  const unused = () => Promise.reject(new Error('Unexpected Action application call'));
  return {
    newCaptureIntent: () => {
      throw new Error('Unexpected capture intent');
    },
    capture: unused,
    listInbox: unused,
    listAllInbox: unused,
    getAction: unused,
    listAxes: unused,
    listProjects: unused,
    edit: unused,
    triage: unused,
    transition: unused,
    reorder: unused,
    bulk: unused,
    undo: unused,
    deletePermanently: unused,
    listMilestones: unused,
  };
}

function receipt(
  undoId = '90000000-0000-4000-8000-000000000001',
): ApplicationResult<CommandReceipt> {
  return {
    ok: true,
    value: {
      commandId: '91000000-0000-4000-8000-000000000001' as UUID,
      ownerId: '92000000-0000-4000-8000-000000000001' as UUID,
      actor: 'user',
      acceptedAt: '2026-08-12T10:00:00Z' as Instant,
      canonical: [],
      eventIds: [],
      undo: { available: true, undoId: undoId as UUID },
      sync: { queued: false },
    },
  };
}
