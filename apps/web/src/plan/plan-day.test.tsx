// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PlanningApplication } from '@yelaxis/application';
import type { CalendarDate } from '@yelaxis/domain';

import {
  dayPlan,
  fakePlanning,
  installDialogPolyfill,
  occurrence,
  receipt,
  renderTree,
  swim,
} from './__fixtures__/c1-planning-fake';
import { OccurrenceControls } from './occurrence-controls';
import { DayView } from './plan-day';
import { layoutEntries } from './timeline';

beforeAll(() => {
  installDialogPolyfill();
});

afterEach(() => cleanup());

const tuesday = '2026-09-29' as CalendarDate;

function renderDay(
  overrides: Partial<PlanningApplication> = {},
  plan = dayPlan(),
): PlanningApplication {
  const planning = fakePlanning({ getDayPlan: vi.fn().mockResolvedValue(plan), ...overrides });
  render(renderTree(planning, <DayView date={tuesday} />));
  return planning;
}

function dragData(actionId: string) {
  const data = new Map<string, string>([['application/x-yelaxis-action', actionId]]);
  return {
    types: ['application/x-yelaxis-action'],
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => data.set(type, value),
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}

describe('Day view', () => {
  it('shows a semantic timeline, the flexible list, and the Backlog', async () => {
    renderDay();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tuesday, September 29, 2026' }),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const timeline = screen.getByRole('list', {
      name: 'Timed plan for Tuesday, September 29, 2026',
    });
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('09:00 – 10:00');
    expect(items[0]).toHaveTextContent('Dentist');
    expect(items[1]).toHaveTextContent('Overlaps Dentist');
    expect(screen.getByRole('button', { name: 'Show hours before 06:00' })).toBeVisible();

    const flexible = screen.getByRole('region', { name: 'Flexible' });
    expect(within(flexible).getByRole('link', { name: 'Call the bank' })).toHaveAttribute(
      'href',
      '/actions/action-bank',
    );
    expect(within(flexible).getByText('Stretch', { selector: 'p' })).toBeVisible();
    expect(within(flexible).getByText('1 of 2 this week')).toBeVisible();
    const backlog = screen.getByRole('region', { name: 'Backlog' });
    expect(within(backlog).getByText('2 unplaced Actions.')).toBeVisible();
    expect(screen.getByText(/2 hours 30 minutes planned of 8 hours available/u)).toBeVisible();
  });

  it('completes an Action block without completing the Action unless asked', async () => {
    const setBlockState = vi.fn().mockResolvedValue(receipt());
    renderDay({ setBlockState });
    const user = userEvent.setup();
    const timeline = await screen.findByRole('list', { name: /Timed plan/u });
    const summary = timeline.querySelectorAll('summary')[1];
    if (summary === undefined) throw new Error('missing options');
    await user.click(summary);
    await user.click(within(timeline).getByRole('button', { name: 'Complete… Write report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Complete this time block' });
    const also = within(dialog).getByRole('checkbox', { name: /Also complete the Action/u });
    expect(also).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Complete time block' }));
    await waitFor(() =>
      expect(setBlockState).toHaveBeenCalledWith({
        blockId: 'block-report',
        revision: 2,
        to: 'completed',
        alsoCompleteAction: false,
      }),
    );
  });

  it('warns that canceling a Commitment block cancels the commitment', async () => {
    const setBlockState = vi.fn().mockResolvedValue(receipt());
    renderDay({ setBlockState });
    const user = userEvent.setup();
    const timeline = await screen.findByRole('list', { name: /Timed plan/u });
    const summary = timeline.querySelector('summary');
    if (summary === null) throw new Error('missing options');
    await user.click(summary);
    await user.click(within(timeline).getByRole('button', { name: 'Cancel commitment… Dentist' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this commitment?' });
    expect(within(dialog).getByText('This cancels the commitment “Dentist”.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel commitment' }));
    await waitFor(() =>
      expect(setBlockState).toHaveBeenCalledWith({
        blockId: 'block-dentist',
        revision: 2,
        to: 'canceled',
      }),
    );
  });

  it('opens Schedule with the dropped start time and still asks for the duration', async () => {
    const resolveLocalInterval = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        startsAt: '2026-09-29T14:30:00.000Z',
        endsAt: '2026-09-29T15:15:00.000Z',
        localStart: '14:30',
        localEnd: '15:15',
        localEndDate: '2026-09-29',
        utcOffset: '+00:00',
        overlaps: [],
      },
    });
    const scheduleAction = vi.fn().mockResolvedValue(receipt());
    renderDay({ resolveLocalInterval, scheduleAction });
    const timeline = await screen.findByRole('list', { name: /Timed plan/u });
    const hour = timeline.querySelectorAll('li[aria-hidden="true"]')[8];
    if (hour === undefined) throw new Error('missing hour slot');
    fireEvent.dragOver(hour, { dataTransfer: dragData('action-trip') });
    fireEvent.drop(hour, { dataTransfer: dragData('action-trip'), clientY: 0 });

    const dialog = await screen.findByRole('dialog', { name: 'Schedule “Plan trip”' });
    expect(within(dialog).getByLabelText('Start time')).toHaveValue('14:00');
    const duration = within(dialog).getByLabelText(/Duration \(minutes\)/u);
    expect(duration).toHaveValue(null);
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a duration');
    expect(scheduleAction).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText('Start time'));
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '14:30' } });
    await user.type(duration, '45');
    expect(await within(dialog).findByText(/14:30 – 15:15/u)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    await waitFor(() =>
      expect(scheduleAction).toHaveBeenCalledWith({
        date: '2026-09-29',
        startTime: '14:30',
        durationMinutes: 45,
        actionId: 'action-trip',
        revision: 3,
        overlapAcknowledged: false,
      }),
    );
  });

  it('explains clock-change adjustments before scheduling', async () => {
    const resolveLocalInterval = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        startsAt: '2026-03-29T01:30:00.000Z',
        endsAt: '2026-03-29T02:00:00.000Z',
        localStart: '03:30',
        localEnd: '04:00',
        localEndDate: '2026-09-29',
        utcOffset: '+02:00',
        adjustment: 'dst_gap_shifted',
        overlaps: [],
      },
    });
    renderDay({ resolveLocalInterval });
    const user = userEvent.setup();
    const backlog = await screen.findByRole('region', { name: 'Backlog' });
    await user.click(within(backlog).getByRole('button', { name: 'Schedule… Read article' }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule “Read article”' });
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '02:30' } });
    expect(
      await within(dialog).findByText('02:30 does not exist on this date; it will start at 03:30.'),
    ).toBeVisible();
  });

  it('places a Backlog Action on this day directly with a named button', async () => {
    const place = vi.fn().mockResolvedValue(receipt());
    renderDay({ place });
    const backlog = await screen.findByRole('region', { name: 'Backlog' });
    await userEvent
      .setup()
      .click(within(backlog).getByRole('button', { name: 'Place on this day Read article' }));
    await waitFor(() =>
      expect(place).toHaveBeenCalledWith({
        target: { kind: 'action', id: 'action-read', revision: 3 },
        period: { kind: 'day', date: '2026-09-29' },
      }),
    );
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('shows an empty timeline and reveals earlier hours on request', async () => {
    const plan = dayPlan();
    renderDay({}, { ...plan, day: { ...plan.day, timed: [] }, conflicts: [] });
    expect(await screen.findByText('Nothing is scheduled at a time on this day.')).toBeVisible();
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: 'Show hours before 06:00' });
    expect(screen.queryByText('03:00')).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByText('03:00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide hours before 06:00' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('Occurrence controls', () => {
  it('completes and skips a projected occurrence without a revision', async () => {
    const completeOccurrence = vi.fn().mockResolvedValue(receipt());
    const skipOccurrence = vi.fn().mockResolvedValue(receipt());
    renderDay({ completeOccurrence, skipOccurrence });
    const flexible = await screen.findByRole('region', { name: 'Flexible' });
    const user = userEvent.setup();
    await user.click(within(flexible).getByRole('button', { name: 'Complete Stretch' }));
    await waitFor(() =>
      expect(completeOccurrence).toHaveBeenCalledWith({
        occurrence: {
          routineId: 'routine-stretch',
          generation: 1,
          period: { kind: 'date', date: '2026-10-01' },
        },
      }),
    );
    await user.click(within(flexible).getByRole('button', { name: 'Skip Stretch' }));
    await waitFor(() => expect(skipOccurrence).toHaveBeenCalledTimes(1));
    expect(within(flexible).getByRole('link', { name: 'Routine details Stretch' })).toHaveAttribute(
      'href',
      '/plan/routines/routine-stretch',
    );
  });

  it('asks before recording an extra weekly completion', async () => {
    const completeOccurrence = vi.fn().mockResolvedValue(receipt());
    const reopenOccurrence = vi.fn().mockResolvedValue(receipt());
    const met = { ...swim, completedCount: 2 };
    const plan = dayPlan({ weeklyCounts: [met] });
    renderDay({ completeOccurrence, reopenOccurrence }, plan);
    const user = userEvent.setup();
    const flexible = await screen.findByRole('region', { name: 'Flexible' });
    expect(within(flexible).getByText('2 of 2 this week')).toBeVisible();
    await user.click(within(flexible).getByRole('button', { name: 'Log one Swim' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record an extra completion?' });
    expect(completeOccurrence).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Record extra completion' }));
    await waitFor(() =>
      expect(completeOccurrence).toHaveBeenCalledWith({
        occurrence: expect.objectContaining({ routineId: 'routine-swim' }) as unknown,
        confirmExtra: true,
      }),
    );
    await user.click(within(flexible).getByRole('button', { name: 'Undo last Swim' }));
    await waitFor(() => expect(reopenOccurrence).toHaveBeenCalledTimes(1));
  });

  it('edits one occurrence with an explicit time and duration together', async () => {
    const editOccurrence = vi.fn().mockResolvedValue(receipt());
    const resolveLocalInterval = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        startsAt: '2026-10-01T07:00:00.000Z',
        endsAt: '2026-10-01T07:20:00.000Z',
        localStart: '07:00',
        localEnd: '07:20',
        localEndDate: '2026-10-01',
        utcOffset: '+00:00',
        overlaps: [],
      },
    });
    renderDay({ editOccurrence, resolveLocalInterval });
    const user = userEvent.setup();
    const flexible = await screen.findByRole('region', { name: 'Flexible' });
    await user.click(
      within(flexible).getByRole('button', { name: 'Edit this occurrence… Stretch' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit this occurrence' });
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '07:00' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save this occurrence' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a duration');
    await user.type(within(dialog).getByLabelText('Duration (minutes)'), '20');
    expect(await within(dialog).findByText(/07:00 – 07:20/u)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Save this occurrence' }));
    await waitFor(() =>
      expect(editOccurrence).toHaveBeenCalledWith({
        occurrence: {
          routineId: 'routine-stretch',
          generation: 1,
          period: { kind: 'date', date: '2026-10-01' },
        },
        date: '2026-10-01',
        startTime: '07:00',
        durationMinutes: 20,
        overlapAcknowledged: false,
      }),
    );
  });

  it('renders read-only status without planning services', () => {
    render(
      <MemoryRouter>
        <OccurrenceControls
          entry={occurrence({
            occurrenceId: 'occ-read',
            routineId: 'routine-read',
            title: 'Read',
            day: '2026-10-01',
            timing: { kind: 'flexible' },
            state: 'skipped',
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Skipped')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('Timeline layout', () => {
  it('places overlapping entries in side-by-side lanes and clips cross-midnight entries', () => {
    const plan = dayPlan();
    const placed = layoutEntries(plan.day.timed, '2026-09-29');
    expect(placed.map((item) => [item.entry.title, item.lane, item.lanes])).toEqual([
      ['Dentist', 0, 2],
      ['Write report', 1, 2],
    ]);
  });
});
