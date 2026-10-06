// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ActionApplication,
  ApplicationResult,
  CommandReceipt,
  MonthPlan,
  PlanningApplication,
} from '@yelaxis/application';
import type {
  CalendarDate,
  IanaTimeZone,
  Instant,
  MonthKey,
  UUID,
  WallTime,
} from '@yelaxis/domain';

import { MonthView } from './plan-month';
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

const d = (value: string): CalendarDate => value as CalendarDate;
const id = (suffix: string): UUID => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}` as UUID;
const profile = {
  profileId: id('1'),
  planningTimeZone: 'Europe/Berlin' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
} as const;

function monthPlan(overrides: Partial<MonthPlan> = {}): MonthPlan {
  const week = (start: string, end: string) =>
    ({ kind: 'week', start: d(start), end: d(end), weekStart: 'monday' }) as const;
  return {
    profile,
    today: d('2026-08-12'),
    month: '2026-08' as MonthKey,
    range: { start: d('2026-08-01'), end: d('2026-08-31') },
    weeks: [
      {
        week: week('2026-08-10', '2026-08-16'),
        plannedMinutes: 750,
        commitmentCount: 3,
        milestoneCount: 2,
        summary: '12 hours 30 minutes planned, 3 commitments, 2 milestones',
      },
      {
        week: week('2026-08-17', '2026-08-23'),
        plannedMinutes: 0,
        commitmentCount: 0,
        milestoneCount: 0,
        summary: 'Nothing planned, 0 commitments, 0 milestones',
      },
    ],
    milestones: [
      {
        id: id('21'),
        title: 'Draft chapter two',
        measurableCheckpoint: 'Chapter two has a full draft',
        state: 'active',
        localRevision: 1,
        outcomeId: id('31'),
        outcomeTitle: 'Finish the manuscript',
        targetEnd: d('2026-08-28'),
      },
    ],
    commitments: [
      {
        key: `block:${id('41')}`,
        kind: 'commitment_block',
        title: 'Team offsite',
        startsAt: '2026-08-14T07:00:00Z' as Instant,
        endsAt: '2026-08-14T09:00:00Z' as Instant,
        timeZone: 'Europe/Berlin' as IanaTimeZone,
        localDate: d('2026-08-14'),
        localStart: '09:00' as WallTime,
        localEndDate: d('2026-08-14'),
        localEnd: '11:00' as WallTime,
        durationMinutes: 120,
        state: 'planned',
        overlapAcknowledged: false,
        conflictsWith: [],
        block: {
          id: id('41'),
          localRevision: 1,
          startsAt: '2026-08-14T07:00:00Z' as Instant,
          endsAt: '2026-08-14T09:00:00Z' as Instant,
          timeZone: 'Europe/Berlin' as IanaTimeZone,
          state: 'planned',
          overlapAcknowledged: false,
          target: {
            kind: 'commitment',
            commitmentId: id('42'),
            title: 'Team offsite',
            strength: 'hard',
            commitmentState: 'planned',
            commitmentRevision: 1,
          },
        },
      },
    ],
    projectTargets: [
      {
        id: id('51'),
        title: 'Garden shed',
        state: 'active',
        localRevision: 1,
        targetStart: d('2026-08-01'),
        targetEnd: d('2026-08-31'),
      },
    ],
    outcomes: [
      {
        id: id('31'),
        title: 'Finish the manuscript',
        successDefinition: 'The manuscript is with the editor',
        state: 'active',
        localRevision: 1,
        progress: { mode: 'manual', percentage: 40 },
      },
    ],
    monthActions: [
      {
        id: id('61'),
        title: 'Book the venue',
        state: 'planned',
        localRevision: 1,
        orderKey: 'a0',
        estimateMinutes: 30,
      },
    ],
    ...overrides,
  };
}

function LocationProbe(): React.ReactNode {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderMonth(planning: PlanningApplication) {
  return render(
    <PlanningProvider planning={planning} actions={stubActions()}>
      <MemoryRouter initialEntries={['/plan/month/2026-08-12']}>
        <Routes>
          <Route path="/plan/month/:date" element={<MonthView date={d('2026-08-12')} />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </PlanningProvider>,
  );
}

describe('Month horizon', () => {
  it('shows week density, milestones, commitments, targets, outcomes, and month Actions', async () => {
    const getMonthPlan = vi.fn().mockResolvedValue(monthPlan());
    renderMonth(fakePlanning({ getMonthPlan }));

    expect(await screen.findByRole('heading', { level: 1, name: 'August 2026' })).toBeVisible();
    expect(getMonthPlan).toHaveBeenCalledWith('2026-08');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    const weeks = screen.getByRole('list', { name: 'Weeks in this month' });
    const weekLink = within(weeks).getByRole('link', { name: /Week of Aug 10/u });
    expect(weekLink).toHaveAttribute('href', '/plan/week/2026-08-10');
    expect(
      within(weeks).getByText('12 hours 30 minutes planned, 3 commitments, 2 milestones'),
    ).toBeVisible();
    expect(within(weeks).getByText('This week')).toBeVisible();
    expect(screen.getByText('Selecting a week drills into its actual plan.')).toBeVisible();

    const milestones = screen.getByRole('list', { name: 'Milestones this month' });
    expect(within(milestones).getByRole('link', { name: 'Draft chapter two' })).toHaveAttribute(
      'href',
      `/milestones/${id('21')}`,
    );
    expect(within(milestones).getByText('Outcome: Finish the manuscript')).toBeVisible();

    const commitments = screen.getByRole('list', { name: 'Commitments this month' });
    expect(within(commitments).getByText('Team offsite')).toBeVisible();
    expect(within(commitments).getByText('Hard commitment')).toBeVisible();
    expect(within(commitments).getByText(/09:00–11:00/u)).toBeVisible();

    expect(
      within(screen.getByRole('list', { name: 'Project targets this month' })).getByText(
        'Garden shed',
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole('list', { name: 'Outcomes in this month' })).getByText(
        'Progress: 40% (set manually)',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Book the venue' })).toHaveAttribute(
      'href',
      `/actions/${id('61')}`,
    );
    // No daily-task grid and nothing to edit about progress.
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('opens the real Week plan from a week', async () => {
    const user = userEvent.setup();
    renderMonth(fakePlanning({ getMonthPlan: vi.fn().mockResolvedValue(monthPlan()) }));
    await user.click(await screen.findByRole('link', { name: /Week of Aug 10/u }));
    expect(screen.getByTestId('location')).toHaveTextContent('/plan/week/2026-08-10');
  });

  it('renders calm empty states for every section', async () => {
    renderMonth(
      fakePlanning({
        getMonthPlan: vi.fn().mockResolvedValue(
          monthPlan({
            weeks: [],
            milestones: [],
            commitments: [],
            projectTargets: [],
            outcomes: [],
            monthActions: [],
          }),
        ),
      }),
    );
    expect(await screen.findByText('No milestones placed or due this month.')).toBeVisible();
    expect(screen.getByText('No commitments this month.')).toBeVisible();
    expect(screen.getByText('No project targets placed or due this month.')).toBeVisible();
    expect(screen.getByText('No outcomes placed in or targeting this month.')).toBeVisible();
    expect(screen.getByText('No actions are placed on this month.')).toBeVisible();
    expect(screen.getByText('No theme set for August 2026. It is optional.')).toBeVisible();
  });

  it('shows loading, then a recoverable error with Try again', async () => {
    const user = userEvent.setup();
    const getMonthPlan = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(monthPlan());
    renderMonth(fakePlanning({ getMonthPlan }));
    expect(screen.getByRole('status')).toHaveTextContent('Opening this month…');
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Weeks in this month' })).toBeVisible();
    expect(getMonthPlan).toHaveBeenCalledTimes(2);
  });

  it('adds, validates, and clears a month theme with undo', async () => {
    const user = userEvent.setup();
    let theme: string | undefined;
    const getMonthPlan = vi.fn(() =>
      Promise.resolve(
        monthPlan(
          theme === undefined
            ? {}
            : {
                theme: {
                  id: id('71'),
                  localRevision: 1,
                  month: '2026-08' as MonthKey,
                  text: theme,
                },
              },
        ),
      ),
    );
    const setMonthTheme = vi.fn((input: { month: string; text: string }) => {
      theme = input.text;
      return Promise.resolve(receipt());
    });
    const clearMonthTheme = vi.fn(() => {
      theme = undefined;
      return Promise.resolve(receipt());
    });
    renderMonth(fakePlanning({ getMonthPlan, setMonthTheme, clearMonthTheme }));

    await user.click(await screen.findByRole('button', { name: 'Add a theme' }));
    const field = screen.getByRole('textbox', { name: 'Month theme for August 2026' });
    await waitFor(() => expect(field).toHaveFocus());
    await user.type(field, '   ');
    await user.click(screen.getByRole('button', { name: 'Save theme' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write a theme');
    expect(setMonthTheme).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, 'Rest and finish drafts');
    expect(screen.getByText('22 of 2,000 characters')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save theme' }));
    expect(setMonthTheme).toHaveBeenCalledWith({
      month: '2026-08',
      text: 'Rest and finish drafts',
    });
    expect(await screen.findByText('Rest and finish drafts')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
    expect(screen.queryByText(/%/u, { selector: '.theme-editor *' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear theme' }));
    expect(clearMonthTheme).toHaveBeenCalledWith({ month: '2026-08' });
    expect(await screen.findByText('No theme set for August 2026. It is optional.')).toBeVisible();
  });

  it('offers Save, Discard, or Continue editing before leaving an unsaved theme', async () => {
    const user = userEvent.setup();
    const setMonthTheme = vi.fn().mockResolvedValue(receipt());
    renderMonth(
      fakePlanning({ getMonthPlan: vi.fn().mockResolvedValue(monthPlan()), setMonthTheme }),
    );
    await user.click(await screen.findByRole('button', { name: 'Add a theme' }));
    await user.type(screen.getByRole('textbox', { name: /Month theme/u }), 'Focus on the book');
    await user.click(screen.getByRole('link', { name: /Week of Aug 10/u }));

    const dialog = await screen.findByRole('dialog', { name: 'Save your changes before leaving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Continue editing' }));
    expect(screen.queryByTestId('location')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Month theme/u })).toHaveValue('Focus on the book');

    await user.click(screen.getByRole('link', { name: /Week of Aug 10/u }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard' }),
    );
    expect(await screen.findByTestId('location')).toHaveTextContent('/plan/week/2026-08-10');
    expect(setMonthTheme).not.toHaveBeenCalled();
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
