// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ActionApplication,
  ApplicationResult,
  CommandReceipt,
  PlanningApplication,
  YearPlan,
} from '@yelaxis/application';
import type { CalendarDate, IanaTimeZone, Instant, MonthKey, UUID, YearKey } from '@yelaxis/domain';

import { PlanningProvider } from './planning-context';
import { YearView, yearLayoutKey } from './plan-year';

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

beforeEach(() => window.localStorage.removeItem(yearLayoutKey));
afterEach(() => cleanup());

const d = (value: string): CalendarDate => value as CalendarDate;
const id = (suffix: string): UUID => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}` as UUID;

function yearPlan(overrides: Partial<YearPlan> = {}): YearPlan {
  return {
    profile: {
      profileId: id('1'),
      planningTimeZone: 'Europe/Berlin' as IanaTimeZone,
      weekStart: 'monday',
      timeFormat: '24_hour',
    },
    today: d('2026-08-12'),
    year: '2026' as YearKey,
    months: Array.from({ length: 12 }, (_, index) => {
      const month = `2026-${String(index + 1).padStart(2, '0')}` as MonthKey;
      return {
        month,
        milestoneCount: index === 7 ? 2 : 0,
        outcomeCount: index === 7 ? 1 : 0,
        ...(index === 7
          ? { theme: { id: id('81'), localRevision: 1, month, text: 'Finish drafts' } }
          : {}),
      };
    }),
    outcomes: [
      {
        id: id('31'),
        title: 'Finish the manuscript',
        successDefinition: 'With the editor',
        state: 'active',
        localRevision: 1,
        progress: { mode: 'manual', percentage: 40 },
      },
      {
        id: id('32'),
        title: 'Run a half marathon',
        successDefinition: 'Cross the line',
        state: 'active',
        localRevision: 1,
        progress: { mode: 'milestone_derived', completed: 2, total: 5 },
        targetEnd: d('2026-10-04'),
      },
      {
        id: id('33'),
        title: 'Learn to sail',
        successDefinition: 'Sail solo',
        state: 'active',
        localRevision: 1,
        progress: { mode: 'none' },
      },
    ],
    milestones: [
      {
        id: id('21'),
        title: 'Draft chapter two',
        measurableCheckpoint: 'Full draft',
        state: 'active',
        localRevision: 1,
        outcomeId: id('31'),
        outcomeTitle: 'Finish the manuscript',
        targetEnd: d('2026-08-28'),
      },
    ],
    importantDates: [
      { date: d('2026-10-04'), kind: 'outcome_target', id: id('32'), title: 'Run a half marathon' },
      { date: d('2026-08-28'), kind: 'milestone_target', id: id('21'), title: 'Draft chapter two' },
    ],
    ...overrides,
  };
}

function LocationProbe(): ReactNode {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderYear(planning: PlanningApplication, entry = '/plan/year/2026-08-12') {
  return render(
    <PlanningProvider planning={planning} actions={stubActions()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/plan/year/:date"
            element={
              <>
                <YearView date={d('2026-08-12')} />
                <LocationProbe />
              </>
            }
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </PlanningProvider>,
  );
}

describe('Year horizon', () => {
  it('shows quarters, read-only Outcome progress, important dates, and no daily Actions', async () => {
    const getYearPlan = vi.fn().mockResolvedValue(yearPlan());
    renderYear(fakePlanning({ getYearPlan }));

    expect(await screen.findByRole('heading', { level: 1, name: '2026' })).toBeVisible();
    expect(getYearPlan).toHaveBeenCalledWith('2026');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Quarters' })).toBeChecked();
    for (const quarter of ['Q1', 'Q2', 'Q3', 'Q4'])
      expect(screen.getByRole('list', { name: `Months in ${quarter}` })).toBeVisible();

    const q3 = screen.getByRole('list', { name: 'Months in Q3' });
    const august = within(q3).getByRole('link', { name: 'August 2026' });
    expect(august).toHaveAttribute('href', '/plan/month/2026-08-01');
    expect(within(q3).getByText('Finish drafts')).toBeVisible();
    expect(within(q3).getByText('2 milestones, 1 outcome')).toBeVisible();

    const outcomes = screen.getByRole('list', { name: 'Active outcomes this year' });
    expect(within(outcomes).getByText('Progress: 40% (set manually)')).toBeVisible();
    expect(within(outcomes).getByText('Progress: 2 of 5 milestones completed')).toBeVisible();
    expect(within(outcomes).getByText('Progress: No progress measure')).toBeVisible();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();

    const dates = within(
      screen.getByRole('list', { name: 'Important dates this year' }),
    ).getAllByRole('listitem');
    expect(dates[0]).toHaveTextContent('Milestone target');
    expect(
      within(dates[0] as HTMLElement).getByRole('link', { name: 'Draft chapter two' }),
    ).toHaveAttribute('href', `/milestones/${id('21')}`);
    expect(dates[1]).toHaveTextContent('Outcome target');
    expect(screen.getByText('Daily actions stay in Week and Day.')).toBeVisible();
  });

  it('switches to twelve months and keeps the choice in the URL and locally', async () => {
    const user = userEvent.setup();
    renderYear(fakePlanning({ getYearPlan: vi.fn().mockResolvedValue(yearPlan()) }));
    await user.click(await screen.findByRole('radio', { name: 'Months' }));
    expect(screen.getByRole('radio', { name: 'Months' })).toBeChecked();
    const months = screen.getByRole('list', { name: 'Months in 2026' });
    expect(within(months).getAllByRole('listitem')).toHaveLength(12);
    expect(screen.queryByRole('list', { name: 'Months in Q1' })).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/plan/year/2026-08-12?view=months');
    expect(window.localStorage.getItem(yearLayoutKey)).toBe('months');
  });

  it('reads the layout from the URL', async () => {
    renderYear(
      fakePlanning({ getYearPlan: vi.fn().mockResolvedValue(yearPlan()) }),
      '/plan/year/2026-08-12?view=months',
    );
    expect(await screen.findByRole('list', { name: 'Months in 2026' })).toBeVisible();
  });

  it('renders empty sections and a recoverable error', async () => {
    const user = userEvent.setup();
    const getYearPlan = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(yearPlan({ outcomes: [], milestones: [], importantDates: [] }));
    renderYear(fakePlanning({ getYearPlan }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No outcomes placed in or targeting this year.')).toBeVisible();
    expect(screen.getByText('No milestones placed or due this year.')).toBeVisible();
    expect(screen.getByText('No target dates fall in this year.')).toBeVisible();
  });

  it('sets and clears the Year direction as plain text', async () => {
    const user = userEvent.setup();
    let direction: string | undefined = 'Build calm routines';
    const getYearPlan = vi.fn(() =>
      Promise.resolve(
        yearPlan(
          direction === undefined
            ? {}
            : {
                direction: {
                  id: id('91'),
                  localRevision: 1,
                  year: '2026' as YearKey,
                  text: direction,
                },
              },
        ),
      ),
    );
    const setYearDirection = vi.fn((input: { year: string; text: string }) => {
      direction = input.text;
      return Promise.resolve(receipt());
    });
    const clearYearDirection = vi.fn(() => {
      direction = undefined;
      return Promise.resolve(receipt());
    });
    renderYear(fakePlanning({ getYearPlan, setYearDirection, clearYearDirection }));

    expect(await screen.findByText('Build calm routines')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Edit direction' }));
    const field = screen.getByRole('textbox', { name: 'Year direction for 2026' });
    expect(field).toHaveValue('Build calm routines');
    expect(field).toHaveAttribute('maxlength', '2000');
    await user.clear(field);
    await user.type(field, 'Write more, rush less');
    await user.click(screen.getByRole('button', { name: 'Save direction' }));
    expect(setYearDirection).toHaveBeenCalledWith({ year: '2026', text: 'Write more, rush less' });
    expect(await screen.findByText('Write more, rush less')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clear direction' }));
    expect(clearYearDirection).toHaveBeenCalledWith({ year: '2026' });
    expect(await screen.findByText('No direction set for 2026. It is optional.')).toBeVisible();
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
