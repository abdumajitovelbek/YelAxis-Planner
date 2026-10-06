// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ActionApplication,
  ApplicationResult,
  CapacitySettings,
  CommandReceipt,
  OccurrenceEntry,
  PlanProfile,
  PlanningApplication,
  ReminderView,
  RoutineDetail,
  RoutineGenerationDocument,
  RoutinePreviewEntry,
  RoutineSummary,
} from '@yelaxis/application';
import type {
  CalendarDate,
  CommandId,
  IanaTimeZone,
  Instant,
  OwnerId,
  RoutineOccurrenceKey,
  UUID,
  WallTime,
} from '@yelaxis/domain';

import { PlanningProvider } from './planning-context';
import {
  buildRoutineInput,
  buildRoutineReminder,
  describeRule,
  describeScheduling,
  emptyRoutineForm,
} from './routine-form';
import { RoutineDetailPage, RoutinesPage } from './routines';

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

const date = (value: string): CalendarDate => value as CalendarDate;
const profile: PlanProfile = {
  profileId: '30000000-0000-4000-8000-000000000001' as UUID,
  planningTimeZone: 'America/New_York' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
const settings: CapacitySettings = {
  profile,
  availability: [],
  rules: {} as CapacitySettings['rules'],
};

const daily: RoutineGenerationDocument = {
  generation: 1,
  rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: date('2026-09-01') },
  schedulingMode: { kind: 'day_flexible' },
};
const weeklyTimed: RoutineGenerationDocument = {
  generation: 2,
  rule: {
    version: 1,
    kind: 'weekly_days',
    intervalWeeks: 1,
    weekdays: ['monday', 'thursday'],
    startsOn: date('2026-09-20'),
  },
  schedulingMode: {
    kind: 'time_specific',
    wallTime: '07:30' as WallTime,
    durationMinutes: 30,
    zonePolicy: { kind: 'follow_profile' },
    gapPolicy: 'shift_forward',
    overlapPolicy: 'earlier_offset',
  },
};

const walk: RoutineSummary = {
  id: '40000000-0000-4000-8000-000000000001' as UUID,
  localRevision: 3,
  title: 'Morning walk',
  state: 'active',
  generations: [daily],
  current: daily,
};
const stretch: RoutineSummary = {
  id: '40000000-0000-4000-8000-000000000002' as UUID,
  localRevision: 5,
  title: 'Stretch',
  state: 'paused',
  pauseEffectiveOn: date('2026-10-01'),
  generations: [daily],
  current: daily,
};

function receipt(type: 'routine' | 'template' = 'routine'): ApplicationResult<CommandReceipt> {
  return {
    ok: true,
    value: {
      commandId: '10000000-0000-4000-8000-000000000009' as CommandId,
      ownerId: '50000000-0000-4000-8000-000000000001' as OwnerId,
      actor: 'user',
      acceptedAt: '2026-09-27T12:00:00.000Z' as Instant,
      canonical: [
        {
          ref: {
            type,
            id: '40000000-0000-4000-8000-000000000099' as UUID,
            ownerId: '50000000-0000-4000-8000-000000000001' as OwnerId,
          },
          localRevision: 1,
        },
      ],
      eventIds: [],
      undo: { available: true, undoId: '60000000-0000-4000-8000-000000000001' as UUID },
      sync: { queued: false },
    },
  };
}

const planningMethods: Record<keyof PlanningApplication, true> = {
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

function fakePlanning(overrides: Partial<PlanningApplication> = {}): PlanningApplication {
  const base = Object.fromEntries(
    Object.keys(planningMethods).map((name) => [
      name,
      () => Promise.reject(new Error(`Unexpected planning call: ${name}`)),
    ]),
  ) as unknown as PlanningApplication;
  return {
    ...base,
    getCapacitySettings: () => Promise.resolve(settings),
    listProjects: () => Promise.resolve([]),
    listAxes: () => Promise.resolve([]),
    previewRoutine: () => Promise.resolve({ ok: true, value: [] }),
    ...overrides,
  };
}

function stubActions(): ActionApplication {
  const unused = () => Promise.reject(new Error('Unexpected Action application call'));
  return {
    newCaptureIntent: unused as unknown as ActionApplication['newCaptureIntent'],
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

function renderWith(planning: PlanningApplication, element: ReactNode, path = '/plan/routines') {
  return render(
    <PlanningProvider planning={planning} actions={stubActions()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/plan/routines" element={element} />
          <Route path="/plan/routines/:routineId" element={element} />
        </Routes>
      </MemoryRouter>
    </PlanningProvider>,
  );
}

const previewEntries: readonly RoutinePreviewEntry[] = [
  {
    date: date('2026-10-01'),
    period: { kind: 'date', date: date('2026-10-01') },
    timing: { kind: 'flexible' },
  },
  {
    date: date('2026-11-01'),
    period: { kind: 'date', date: date('2026-11-01') },
    timing: {
      kind: 'timed',
      startsAt: '2026-11-01T05:30:00Z' as Instant,
      endsAt: '2026-11-01T06:00:00Z' as Instant,
    },
    localStart: '01:30' as WallTime,
    dstNote: 'repeated_earlier',
  },
];

describe('Routine words', () => {
  it('states rules and scheduling in plain words', () => {
    expect(describeRule(daily.rule)).toMatch(/^Every day, starting /u);
    expect(describeRule(weeklyTimed.rule)).toMatch(/^Every week on Monday and Thursday/u);
    expect(
      describeRule({
        version: 1,
        kind: 'monthly_day',
        intervalMonths: 1,
        dayOfMonth: 31,
        missingDayPolicy: 'skip',
        startsOn: date('2026-01-31'),
        endsOn: date('2026-12-31'),
      }),
    ).toMatch(/Every month on day 31; months without that day are skipped, starting .*, ending /u);
    expect(
      describeRule({
        version: 1,
        kind: 'weekly_count',
        targetCount: 3,
        weekStart: 'sunday',
        startsOn: date('2026-09-27'),
      }),
    ).toMatch(/^3 times per week, weeks starting Sunday/u);
    expect(describeScheduling(weeklyTimed.schedulingMode)).toBe(
      'At 07:30 for 30 minutes, in your planning time zone',
    );
    expect(describeScheduling({ kind: 'day_flexible' })).toBe('Any time that day');
  });
});

describe('Routines page', () => {
  it('lists active and paused routines with their pattern and state', async () => {
    const listRoutines = vi.fn().mockResolvedValue([walk, stretch]);
    renderWith(fakePlanning({ listRoutines }), <RoutinesPage />);

    expect(await screen.findByRole('link', { name: 'Morning walk' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const paused = screen.getByRole('region', { name: 'Paused routines' });
    expect(within(paused).getByText(/Paused from/u)).toBeVisible();
    expect(screen.getByRole('region', { name: 'Active routines' })).toHaveTextContent(
      'Every day, starting',
    );
    expect(listRoutines).toHaveBeenCalledWith({ includeArchived: false });

    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Show archived routines' }));
    await waitFor(() => expect(listRoutines).toHaveBeenLastCalledWith({ includeArchived: true }));
  });

  it('shows a calm empty state and a recoverable error state', async () => {
    const listRoutines = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce([]);
    renderWith(fakePlanning({ listRoutines }), <RoutinesPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'No routines yet.' })).toBeVisible();
  });

  it('validates in words, previews occurrences, and creates a routine with undo', async () => {
    const createRoutine = vi.fn().mockResolvedValue(receipt());
    const previewRoutine = vi.fn().mockResolvedValue({ ok: true, value: previewEntries });
    renderWith(
      fakePlanning({ listRoutines: () => Promise.resolve([]), createRoutine, previewRoutine }),
      <RoutinesPage />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New routine' }));
    const dialog = await screen.findByRole('dialog', { name: 'New routine' });
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: /Title/u })).toHaveFocus(),
    );
    await user.type(within(dialog).getByRole('textbox', { name: /Title/u }), 'Gym');
    await user.click(within(dialog).getByRole('radio', { name: 'On selected weekdays' }));
    for (const checkbox of within(dialog).getAllByRole('checkbox')) {
      if ((checkbox as HTMLInputElement).checked) await user.click(checkbox);
    }
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Choose at least one weekday.',
    );
    expect(within(dialog).getByRole('textbox', { name: /Title/u })).toHaveValue('Gym');
    expect(createRoutine).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('checkbox', { name: 'Tuesday' }));
    await user.click(within(dialog).getByRole('radio', { name: 'At a set time' }));
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '07:30' } });
    await user.type(within(dialog).getByRole('spinbutton', { name: /Duration/u }), '45');
    fireEvent.change(within(dialog).getByLabelText('Starts on'), {
      target: { value: '2026-10-01' },
    });

    const preview = await within(dialog).findByRole('region', { name: 'Next occurrences' });
    expect(await within(preview).findByText(/the first one is used/u)).toBeVisible();
    expect(within(preview).getByText(/01:30 to .*America\/New York/u)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toEqual({
      title: 'Gym',
      rule: {
        version: 1,
        kind: 'weekly_days',
        intervalWeeks: 1,
        weekdays: ['tuesday'],
        startsOn: '2026-10-01',
      },
      schedulingMode: {
        kind: 'time_specific',
        wallTime: '07:30',
        durationMinutes: 45,
        zonePolicy: { kind: 'follow_profile' },
        gapPolicy: 'shift_forward',
        overlapPolicy: 'earlier_offset',
      },
    });
    expect(await screen.findByText('Routine created.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New routine' })).not.toBeInTheDocument(),
    );
  });

  it('reports an end date before the start and a pattern with no upcoming dates', async () => {
    renderWith(fakePlanning({ listRoutines: () => Promise.resolve([]) }), <RoutinesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New routine' }));
    const dialog = await screen.findByRole('dialog', { name: 'New routine' });
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: /Title/u })).toHaveFocus(),
    );
    expect(
      await within(dialog).findByText(/This pattern has no upcoming dates/u),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Starts on'), {
      target: { value: '2026-10-10' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Ends on/u), {
      target: { value: '2026-10-01' },
    });
    await user.type(within(dialog).getByRole('textbox', { name: /Title/u }), 'Read');
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The end date is before the start date',
    );
    expect(within(dialog).getByLabelText(/Ends on/u)).toHaveValue('2026-10-01');
  });

  it('builds a monthly rule with the last-day policy and a fixed time zone', async () => {
    const createRoutine = vi.fn().mockResolvedValue(receipt());
    renderWith(
      fakePlanning({ listRoutines: () => Promise.resolve([]), createRoutine }),
      <RoutinesPage />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New routine' }));
    const dialog = await screen.findByRole('dialog', { name: 'New routine' });
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: /Title/u })).toHaveFocus(),
    );
    await user.type(within(dialog).getByRole('textbox', { name: /Title/u }), 'Pay rent');
    await user.click(within(dialog).getByRole('radio', { name: 'Monthly on a day' }));
    const day = within(dialog).getByRole('spinbutton', { name: /Day of the month/u });
    await user.clear(day);
    await user.type(day, '31');
    await user.click(within(dialog).getByRole('radio', { name: 'Use the last day of the month' }));
    fireEvent.change(within(dialog).getByLabelText('Starts on'), {
      target: { value: '2026-10-31' },
    });
    await user.click(within(dialog).getByRole('radio', { name: 'At a set time' }));
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '09:00' } });
    await user.type(within(dialog).getByRole('spinbutton', { name: /Duration/u }), '15');
    await user.click(within(dialog).getByRole('radio', { name: 'Keep a fixed time zone' }));
    await user.type(within(dialog).getByRole('searchbox', { name: /Find a time zone/u }), 'Berlin');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Fixed time zone' }),
      'Europe/Berlin',
    );
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'If the time is skipped by a clock change' }),
      'skip',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      rule: {
        kind: 'monthly_day',
        dayOfMonth: 31,
        intervalMonths: 1,
        missingDayPolicy: 'last_day',
        startsOn: '2026-10-31',
      },
      schedulingMode: {
        kind: 'time_specific',
        zonePolicy: { kind: 'fixed_zone', timeZone: 'Europe/Berlin' },
        gapPolicy: 'skip',
        overlapPolicy: 'earlier_offset',
      },
    });
  });

  it('keeps the dialog open and shows command errors in words', async () => {
    const createRoutine = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: {
          code: 'invalid_value',
          message: 'The routine is invalid.',
          details: { reason: 'weekly_count_is_day_flexible' },
        },
      },
    });
    renderWith(
      fakePlanning({ listRoutines: () => Promise.resolve([]), createRoutine }),
      <RoutinesPage />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New routine' }));
    const dialog = await screen.findByRole('dialog', { name: 'New routine' });
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: /Title/u })).toHaveFocus(),
    );
    await user.type(within(dialog).getByRole('textbox', { name: /Title/u }), 'Swim');
    await user.click(within(dialog).getByRole('radio', { name: 'A number of times per week' }));
    expect(within(dialog).getByRole('radio', { name: 'At a set time' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('cannot have a set time');
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      rule: { kind: 'weekly_count', targetCount: 3, weekStart: 'monday' },
      schedulingMode: { kind: 'day_flexible' },
    });
    expect(within(dialog).getByRole('textbox', { name: /Title/u })).toHaveValue('Swim');
  });
});

function occurrence(
  day: string,
  state: OccurrenceEntry['state'],
  extra: Partial<OccurrenceEntry> = {},
): OccurrenceEntry {
  return {
    ref: {
      routineId: walk.id,
      routineTitle: 'Morning walk',
      occurrenceId: `70000000-0000-4000-8000-0000000${day.replaceAll('-', '').slice(2)}` as UUID,
      logicalKey: `key:${day}` as RoutineOccurrenceKey,
      generation: 2,
      period: { kind: 'date', date: date(day) },
      materialized: state !== 'planned',
    },
    state,
    date: date(day),
    moved: false,
    timing: { kind: 'flexible' },
    ...extra,
  };
}

const detail: RoutineDetail = {
  routine: {
    ...walk,
    description: 'Before breakfast.',
    generations: [{ ...daily, rule: { ...daily.rule, endsOn: date('2026-09-19') } }, weeklyTimed],
    current: weeklyTimed,
    defaults: {
      id: '80000000-0000-4000-8000-000000000001' as UUID,
      localRevision: 1,
      routineId: walk.id,
      generation: 2,
      estimateMinutes: 30,
      energy: 'low',
      projectTitle: 'Health',
    },
  },
  profile,
  today: date('2026-09-27'),
  upcoming: [
    occurrence('2026-09-28', 'planned', {
      timing: {
        kind: 'timed',
        startsAt: '2026-09-28T11:30:00Z' as Instant,
        endsAt: '2026-09-28T12:00:00Z' as Instant,
      },
    }),
  ],
  history: [occurrence('2026-09-24', 'completed'), occurrence('2026-09-21', 'skipped')],
};

describe('Routine detail', () => {
  it('shows generations, defaults, upcoming, and neutral history', async () => {
    renderWith(
      fakePlanning({ getRoutine: () => Promise.resolve(detail) }),
      <RoutineDetailPage />,
      `/plan/routines/${walk.id}`,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Morning walk' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText(/Changed from/u)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Earlier patterns' })).toBeVisible();
    expect(screen.getByText('Health')).toBeVisible();
    const upcoming = screen.getByRole('region', { name: 'Upcoming' });
    expect(within(upcoming).getByText(/07:30 to 08:00 \(America\/New York\)/u)).toBeVisible();
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getByText('Completed')).toBeVisible();
    expect(within(history).getByText('Skipped')).toBeVisible();
    expect(history.textContent ?? '').not.toMatch(/streak|%/iu);
  });

  it('pauses from a chosen date and explains that nothing is deleted or backfilled', async () => {
    const pauseRoutine = vi.fn().mockResolvedValue(receipt());
    renderWith(
      fakePlanning({ getRoutine: () => Promise.resolve(detail), pauseRoutine }),
      <RoutineDetailPage />,
      `/plan/routines/${walk.id}`,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pause…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pause routine' });
    expect(dialog).toHaveAccessibleDescription(/Nothing is deleted.*not added back/u);
    fireEvent.change(within(dialog).getByLabelText(/Pause from/u), {
      target: { value: '2026-10-05' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Pause routine' }));
    await waitFor(() =>
      expect(pauseRoutine).toHaveBeenCalledWith({
        routineId: walk.id,
        revision: 3,
        pauseOn: '2026-10-05',
      }),
    );
    expect(await screen.findByText('Routine paused.')).toBeInTheDocument();
  });

  it('changes this and future from the chosen date with the new pattern', async () => {
    const editRoutineThisAndFuture = vi.fn().mockResolvedValue(receipt());
    renderWith(
      fakePlanning({ getRoutine: () => Promise.resolve(detail), editRoutineThisAndFuture }),
      <RoutineDetailPage />,
      `/plan/routines/${walk.id}`,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change this and future…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Change this and future occurrences',
    });
    expect(dialog).toHaveAccessibleDescription(/completed history stay unchanged/u);
    const start = within(dialog).getByLabelText('First date the change applies');
    expect(start).toHaveValue('2026-09-27');
    fireEvent.change(start, { target: { value: '2026-10-05' } });
    await user.click(within(dialog).getByRole('radio', { name: 'Any time that day' }));
    await user.click(within(dialog).getByRole('button', { name: 'Apply from this date' }));
    await waitFor(() => expect(editRoutineThisAndFuture).toHaveBeenCalledTimes(1));
    expect(editRoutineThisAndFuture.mock.calls[0]?.[0]).toMatchObject({
      routineId: walk.id,
      revision: 3,
      selectedOn: '2026-10-05',
      rule: { kind: 'weekly_days', weekdays: ['monday', 'thursday'], startsOn: '2026-10-05' },
      schedulingMode: { kind: 'day_flexible' },
      defaults: { estimateMinutes: 30, energy: 'low' },
    });
  });

  it('shows a calm unavailable state for a missing routine', async () => {
    renderWith(
      fakePlanning({ getRoutine: () => Promise.resolve(null) }),
      <RoutineDetailPage />,
      '/plan/routines/missing',
    );
    expect(
      await screen.findByRole('heading', { name: 'This routine is unavailable.' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Return to Routines' })).toBeVisible();
  });
});

/* ───────────────────────── Reminders ───────────────────────── */

const scheduledReminder: ReminderView = {
  reminderId: '90000000-0000-4000-8000-000000000001' as UUID,
  localRevision: 2,
  kind: 'relative',
  remindAt: '2026-09-28T11:15:00.000Z' as Instant,
  timeZone: 'America/New_York' as IanaTimeZone,
  date: date('2026-09-28'),
  time: '07:15' as WallTime,
  minutesBefore: 15,
};

const withReminder: RoutineDetail = { ...detail, reminder: scheduledReminder };

async function openNewRoutine(planning: PlanningApplication): Promise<HTMLElement> {
  renderWith(planning, <RoutinesPage />);
  await userEvent.setup().click(await screen.findByRole('button', { name: 'New routine' }));
  const dialog = await screen.findByRole('dialog', { name: 'New routine' });
  await waitFor(() =>
    expect(within(dialog).getByRole('textbox', { name: /Title/u })).toHaveFocus(),
  );
  return dialog;
}

describe('Routine reminders', () => {
  it('offers a reminder only for a routine at a set time and creates both in one command', async () => {
    const createRoutine = vi.fn().mockResolvedValue(receipt());
    const dialog = await openNewRoutine(
      fakePlanning({ listRoutines: () => Promise.resolve([]), createRoutine }),
    );
    const user = userEvent.setup();
    expect(within(dialog).queryByRole('group', { name: 'Reminder' })).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: /Title/u }), 'Run');
    await user.click(within(dialog).getByRole('radio', { name: 'At a set time' }));
    const group = within(dialog).getByRole('group', { name: 'Reminder' });
    expect(group).toHaveAccessibleDescription(
      'Reminders are saved on this device. Enable browser alerts in Settings for delivery while YelAxis Planner is open; reminders due while it is closed appear in Notifications after reopening.',
    );
    expect(within(group).getByRole('radio', { name: 'Off' })).toBeChecked();
    expect(within(group).queryByRole('spinbutton')).toBeNull();
    await user.click(within(group).getByRole('radio', { name: 'Before each occurrence' }));
    const minutes = within(group).getByRole('spinbutton', {
      name: /Minutes before each occurrence/u,
    });
    expect(minutes).toHaveValue(15);
    await user.clear(minutes);
    await user.type(minutes, '20');
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '06:30' } });
    await user.type(within(dialog).getByRole('spinbutton', { name: /Duration/u }), '30');
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      title: 'Run',
      schedulingMode: { kind: 'time_specific', wallTime: '06:30', durationMinutes: 30 },
      reminder: { minutesBefore: 20 },
    });
    expect(await screen.findByText('Routine and reminder saved.')).toBeInTheDocument();

    // Any time that day, or a number of times per week, has no reminder to offer.
    cleanup();
    const again = await openNewRoutine(
      fakePlanning({ listRoutines: () => Promise.resolve([]), createRoutine }),
    );
    await user.click(within(again).getByRole('radio', { name: 'At a set time' }));
    expect(within(again).getByRole('group', { name: 'Reminder' })).toBeVisible();
    await user.click(within(again).getByRole('radio', { name: 'A number of times per week' }));
    expect(within(again).queryByRole('group', { name: 'Reminder' })).toBeNull();
  });

  it('ties a reminder minutes error to its field and creates nothing', async () => {
    const createRoutine = vi.fn().mockResolvedValue(receipt());
    const dialog = await openNewRoutine(
      fakePlanning({ listRoutines: () => Promise.resolve([]), createRoutine }),
    );
    const user = userEvent.setup();
    await user.type(within(dialog).getByRole('textbox', { name: /Title/u }), 'Run');
    await user.click(within(dialog).getByRole('radio', { name: 'At a set time' }));
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '06:30' } });
    await user.type(within(dialog).getByRole('spinbutton', { name: /Duration/u }), '30');
    await user.click(within(dialog).getByRole('radio', { name: 'Before each occurrence' }));
    const minutes = within(dialog).getByRole('spinbutton', { name: /Minutes before each/u });
    await user.clear(minutes);
    await user.type(minutes, '10081');
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Reminder: enter a whole number of minutes from 0 to 10,080 (7 days).',
    );
    expect(minutes).toHaveAttribute('aria-invalid', 'true');
    expect(minutes).toHaveAccessibleDescription(/Reminder: enter a whole number of minutes/u);
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it('shows the reminder on the detail and sets, replaces, and turns it off', async () => {
    const setRoutineReminder = vi.fn().mockResolvedValue(receipt());
    const turnOffRoutineReminder = vi.fn().mockResolvedValue(receipt());
    const getRoutine = vi
      .fn()
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(withReminder)
      .mockResolvedValue(withReminder);
    renderWith(
      fakePlanning({ getRoutine, setRoutineReminder, turnOffRoutineReminder }),
      <RoutineDetailPage />,
      `/plan/routines/${walk.id}`,
    );
    const section = await screen.findByRole('region', { name: 'Reminder' });
    expect(section).toHaveTextContent('Off');
    expect(section).toHaveTextContent(
      'Reminders are saved on this device. Enable browser alerts in Settings for delivery while YelAxis Planner is open; reminders due while it is closed appear in Notifications after reopening.',
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reminder…' }));
    let dialog = await screen.findByRole('dialog', { name: 'Routine reminder' });
    // Nothing promises that a reminder will reach the person: manual planning delivers none.
    expect(dialog).toHaveAccessibleDescription(
      'Set, change, or turn off the reminder saved for each occurrence of this routine.',
    );
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: 'Off' })).toHaveFocus());
    await user.click(within(dialog).getByRole('radio', { name: 'Before each occurrence' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    await waitFor(() =>
      expect(setRoutineReminder).toHaveBeenCalledWith({
        routineId: walk.id,
        revision: 3,
        reminder: { minutesBefore: 15 },
      }),
    );
    expect(await screen.findByText('Reminder saved.')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Reminder' })).toHaveTextContent(
      '15 minutes before each occurrence',
    );

    await user.click(screen.getByRole('button', { name: 'Reminder…' }));
    dialog = await screen.findByRole('dialog', { name: 'Routine reminder' });
    const minutes = within(dialog).getByRole('spinbutton', { name: /Minutes before each/u });
    expect(minutes).toHaveValue(15);
    await user.clear(minutes);
    await user.type(minutes, '45');
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    await waitFor(() =>
      expect(setRoutineReminder).toHaveBeenLastCalledWith({
        routineId: walk.id,
        revision: 3,
        reminderRevision: 2,
        reminder: { minutesBefore: 45 },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Reminder…' }));
    dialog = await screen.findByRole('dialog', { name: 'Routine reminder' });
    await user.click(within(dialog).getByRole('radio', { name: 'Off' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    await waitFor(() =>
      expect(turnOffRoutineReminder).toHaveBeenCalledWith({
        routineId: walk.id,
        reminderRevision: 2,
      }),
    );
    expect(await screen.findByText('Reminder turned off.')).toBeInTheDocument();
  });

  it('states in the archive confirmation that the reminder will be turned off', async () => {
    const archiveRoutine = vi.fn().mockResolvedValue(receipt());
    renderWith(
      fakePlanning({ getRoutine: () => Promise.resolve(withReminder), archiveRoutine }),
      <RoutineDetailPage />,
      `/plan/routines/${walk.id}`,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Archive…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive this routine?' });
    expect(dialog).toHaveTextContent(
      'Its reminder (15 minutes before each occurrence) will be turned off. Restoring the routine later does not turn the reminder back on.',
    );
    expect(archiveRoutine).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(archiveRoutine).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Archive…' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Archive this routine?' })).getByRole(
        'button',
        { name: 'Archive routine' },
      ),
    );
    await waitFor(() =>
      expect(archiveRoutine).toHaveBeenCalledWith({ routineId: walk.id, revision: 3 }),
    );
    expect(await screen.findByText('Routine archived. Its reminder is off.')).toBeInTheDocument();
  });

  it('archives a routine without a reminder at once, and hides Reminder… when none can be set', async () => {
    const archiveRoutine = vi.fn().mockResolvedValue(receipt());
    const flexibleDetail: RoutineDetail = {
      ...detail,
      routine: { ...detail.routine, generations: [daily], current: daily },
    };
    renderWith(
      fakePlanning({ getRoutine: () => Promise.resolve(flexibleDetail), archiveRoutine }),
      <RoutineDetailPage />,
      `/plan/routines/${walk.id}`,
    );
    await screen.findByRole('heading', { level: 1, name: 'Morning walk' });
    expect(screen.queryByRole('button', { name: 'Reminder…' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(archiveRoutine).toHaveBeenCalledWith({ routineId: walk.id, revision: 3 }),
    );
    expect(await screen.findByText('Routine archived.')).toBeInTheDocument();
  });
});

describe('Routine reminder input', () => {
  it.each([
    ['off', '15', { ok: true, value: undefined }],
    ['before', '0', { ok: true, value: { minutesBefore: 0 } }],
    ['before', '10080', { ok: true, value: { minutesBefore: 10_080 } }],
    ['before', ' 45 ', { ok: true, value: { minutesBefore: 45 } }],
    ['before', '10081', { ok: false }],
    ['before', '-5', { ok: false }],
    ['before', '7.5', { ok: false }],
    ['before', '', { ok: false }],
  ] as const)('%s with %j minutes builds %j', (choice, minutes, expected) => {
    expect(buildRoutineReminder(choice, minutes)).toMatchObject(expected);
  });

  it('sends a reminder only when asked for and only for a routine at a set time', () => {
    const timed = {
      ...emptyRoutineForm('2026-10-01'),
      title: 'Run',
      timing: 'time_specific' as const,
      wallTime: '06:30',
      durationMinutes: '30',
      reminder: 'before' as const,
      reminderMinutes: '20',
    };
    expect(buildRoutineInput(timed, 'monday', { includeReminder: true })).toMatchObject({
      ok: true,
      value: { reminder: { minutesBefore: 20 } },
    });
    expect(buildRoutineInput(timed, 'monday')).toMatchObject({ ok: true });
    expect(buildRoutineInput(timed, 'monday')).not.toHaveProperty('value.reminder');
    expect(
      buildRoutineInput({ ...timed, timing: 'day_flexible' }, 'monday', { includeReminder: true }),
    ).not.toHaveProperty('value.reminder');
    expect(
      buildRoutineInput({ ...timed, pattern: 'weekly_count' }, 'monday', {
        includeReminder: true,
      }),
    ).not.toHaveProperty('value.reminder');
  });
});
