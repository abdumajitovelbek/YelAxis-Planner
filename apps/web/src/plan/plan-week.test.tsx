// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CalendarDate } from '@yelaxis/domain';

import {
  dentist,
  fakePlanning,
  installDialogPolyfill,
  readArticle,
  receipt,
  renderTree,
  weekPlan,
} from './__fixtures__/c1-planning-fake';
import { WeekView } from './plan-week';

beforeAll(() => {
  installDialogPolyfill();
});

afterEach(() => cleanup());

const weekDate = '2026-09-29' as CalendarDate;

function renderWeek(
  planning = fakePlanning({ getWeekPlan: vi.fn().mockResolvedValue(weekPlan()) }),
) {
  render(renderTree(planning, <WeekView date={weekDate} />));
  return planning;
}

describe('Week view', () => {
  it('orders the week from reality to backlog with neutral capacity and overlap text', async () => {
    renderWeek();
    const title = await screen.findByRole('heading', { level: 1 });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(title).toHaveTextContent('Sep 28');
    expect(
      screen.getByText(/Available time is defined for 1 of 7 days/u, { selector: 'span' }),
    ).toBeVisible();
    expect(screen.getByText('1 overlap to review · 1 overlap kept')).toBeVisible();
    expect(screen.queryByText(/%/u)).not.toBeInTheDocument();

    const order = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(order).toEqual([
      'Fixed commitments',
      'Overlaps',
      'Schedule',
      'Carry forward',
      'This week',
      'Backlog',
    ]);

    const tuesday = screen.getByRole('region', { name: /Tue, Sep 29/u });
    expect(within(tuesday).getByRole('link', { name: 'Tue, Sep 29' })).toHaveAttribute(
      'href',
      '/plan/day/2026-09-29',
    );
    expect(within(tuesday).getByText('Available 09:00–17:00')).toBeVisible();
    expect(within(tuesday).getByText(/2 h 30 min planned of 8 h available/u)).toBeVisible();
    expect(within(tuesday).getByText('Overlaps Dentist')).toBeVisible();
    expect(within(tuesday).getByText('Hard commitment')).toBeVisible();

    const monday = screen.getByRole('region', { name: /Mon, Sep 28/u });
    expect(within(monday).getByText(/available time not defined/u)).toBeVisible();
    expect(within(monday).queryByText(/free/iu)).not.toBeInTheDocument();

    const wednesday = screen.getByRole('region', { name: /Wed, Sep 30/u });
    expect(within(wednesday).getAllByText('Overlap kept').length).toBeGreaterThan(0);

    const friday = screen.getByRole('region', { name: /Fri, Oct 2/u });
    expect(within(friday).getByText(/continues after midnight/u)).toBeVisible();
    const saturday = screen.getByRole('region', { name: /Sat, Oct 3/u });
    expect(within(saturday).getByText(/From the previous day/u)).toBeVisible();

    expect(screen.getByText('A small set is easier to keep.')).toBeVisible();
    expect(screen.getByText(/3 unplaced Actions, showing 1/u)).toBeVisible();
    expect(screen.getByText('1 of 2 this week')).toBeVisible();
  });

  it('keeps an overlap only after explicit confirmation and offers undo', async () => {
    const keepOverlap = vi.fn().mockResolvedValue(receipt('undo-keep'));
    const undo = vi.fn().mockResolvedValue(receipt());
    const getWeekPlan = vi.fn().mockResolvedValue(weekPlan());
    renderWeek(
      fakePlanning({
        getWeekPlan,
        keepOverlap,
        undo,
      }),
    );
    const user = userEvent.setup();
    const overlaps = await screen.findByRole('region', { name: 'Overlaps' });
    await user.click(within(overlaps).getByRole('button', { name: /Keep overlap/u }));
    const dialog = await screen.findByRole('dialog', { name: 'Keep this overlap?' });
    expect(keepOverlap).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Keep overlap' }));

    await waitFor(() =>
      expect(keepOverlap).toHaveBeenCalledWith({
        first: { kind: 'block', blockId: 'block-dentist', revision: 2 },
        second: { kind: 'block', blockId: 'block-report', revision: 2 },
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('undo-keep'));
    expect(getWeekPlan.mock.calls.length).toBeGreaterThan(1);
  });

  it('offers explicit Move, Shorten, and Cancel choices for each side of an overlap', async () => {
    renderWeek();
    const user = userEvent.setup();
    const overlaps = await screen.findByRole('region', { name: 'Overlaps' });
    expect(within(overlaps).getByRole('button', { name: 'Move… Dentist' })).toBeVisible();
    expect(within(overlaps).getByRole('button', { name: 'Shorten… Write report' })).toBeVisible();
    await user.click(within(overlaps).getByRole('button', { name: 'Cancel commitment… Dentist' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this commitment?' });
    expect(within(dialog).getByText(/This cancels the commitment/u)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
  });

  it('requires an explicit duration and Keep-overlap choice before scheduling', async () => {
    const resolveLocalInterval = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        startsAt: '2026-09-29T09:15:00.000Z',
        endsAt: '2026-09-29T09:45:00.000Z',
        localStart: '09:15',
        localEnd: '09:45',
        localEndDate: '2026-09-29',
        utcOffset: '+00:00',
        overlaps: [{ key: dentist.key, title: 'Dentist' }],
      },
    });
    const scheduleAction = vi.fn().mockResolvedValue(receipt());
    renderWeek(
      fakePlanning({
        getWeekPlan: vi.fn().mockResolvedValue(weekPlan()),
        resolveLocalInterval,
        scheduleAction,
      }),
    );
    const user = userEvent.setup();
    const backlog = await screen.findByRole('region', { name: 'Backlog' });
    await user.click(within(backlog).getByRole('button', { name: 'Schedule… Read article' }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule “Read article”' });
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-09-29');
    const duration = within(dialog).getByLabelText(/Duration \(minutes\)/u);
    expect(duration).toHaveValue(30);
    expect(within(dialog).getByText(/Prefilled from the estimate/u)).toBeVisible();

    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '09:15' } });
    expect(await within(dialog).findByText('This time overlaps:')).toBeVisible();
    expect(within(dialog).getByText('Dentist')).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Keep this overlap');
    expect(scheduleAction).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('checkbox', { name: /Keep this overlap/u }));
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    await waitFor(() =>
      expect(scheduleAction).toHaveBeenCalledWith({
        date: '2026-09-29',
        startTime: '09:15',
        durationMinutes: 30,
        actionId: readArticle.id,
        revision: readArticle.localRevision,
        overlapAcknowledged: true,
      }),
    );
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('moves selected carry-forward Actions only to the chosen destination', async () => {
    const carryForward = vi.fn().mockResolvedValue(receipt());
    renderWeek(fakePlanning({ getWeekPlan: vi.fn().mockResolvedValue(weekPlan()), carryForward }));
    const user = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'Carry forward' });
    const move = within(section).getByRole('button', { name: 'Move to this week' });
    expect(move).toBeDisabled();
    await user.click(within(section).getByRole('checkbox', { name: /Select all/u }));
    await user.selectOptions(within(section).getByLabelText('Move to'), '2026-09-29');
    await user.click(within(section).getByRole('button', { name: 'Move to Tue, Sep 29' }));
    await waitFor(() =>
      expect(carryForward).toHaveBeenCalledWith({
        actions: [
          { id: 'action-old', revision: 3 },
          { id: 'action-draft', revision: 3 },
        ],
        period: { kind: 'day', date: '2026-09-29' },
      }),
    );
  });

  it('places a Backlog Action on a stated day with the keyboard alternative to dragging', async () => {
    const place = vi.fn().mockResolvedValue(receipt());
    renderWeek(fakePlanning({ getWeekPlan: vi.fn().mockResolvedValue(weekPlan()), place }));
    const user = userEvent.setup();
    const backlog = await screen.findByRole('region', { name: 'Backlog' });
    await user.click(within(backlog).getByRole('button', { name: 'Place on a day… Read article' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place “Read article”' });
    await user.selectOptions(within(dialog).getByLabelText('Day'), '2026-10-01');
    expect(within(dialog).getByText(/will be placed on Thursday, October 1, 2026/u)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Place' }));
    await waitFor(() =>
      expect(place).toHaveBeenCalledWith({
        target: { kind: 'action', id: 'action-read', revision: 3 },
        period: { kind: 'day', date: '2026-10-01' },
      }),
    );
  });

  it('asks before placing an Action dropped onto a day', async () => {
    const place = vi.fn().mockResolvedValue(receipt());
    renderWeek(fakePlanning({ getWeekPlan: vi.fn().mockResolvedValue(weekPlan()), place }));
    const wednesday = await screen.findByRole('region', { name: /Wed, Sep 30/u });
    const data = new Map<string, string>([['application/x-yelaxis-action', 'action-read']]);
    const dataTransfer = {
      types: ['application/x-yelaxis-action'],
      getData: (type: string) => data.get(type) ?? '',
      setData: (type: string, value: string) => data.set(type, value),
      dropEffect: 'none',
      effectAllowed: 'all',
    };
    fireEvent.dragOver(wednesday, { dataTransfer });
    fireEvent.drop(wednesday, { dataTransfer });
    const dialog = await screen.findByRole('dialog', { name: 'Place on Wed, Sep 30?' });
    expect(place).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Place on Wed, Sep 30' }));
    await waitFor(() =>
      expect(place).toHaveBeenCalledWith({
        target: { kind: 'action', id: 'action-read', revision: 3 },
        period: { kind: 'day', date: '2026-09-30' },
      }),
    );
  });

  it('shows loading, then a calm error with Try again that recovers', async () => {
    const getWeekPlan = vi
      .fn()
      .mockRejectedValueOnce(new Error('worker unavailable'))
      .mockResolvedValue(weekPlan());
    renderWeek(fakePlanning({ getWeekPlan }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading this week');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your local plan was not changed');
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Schedule' })).toBeVisible();
  });

  it('renders calm empty states for an empty week', async () => {
    const empty = weekPlan({
      fixed: [],
      conflicts: [],
      carryForward: { items: [], total: 0 },
      weekActions: [],
      weekObjects: [],
      weekCommitments: [],
      weeklyCounts: [],
      backlog: { items: [], total: 0 },
      days: weekPlan().days.map((day) => ({
        ...day,
        timed: [],
        flexibleActions: [],
        flexibleOccurrences: [],
      })),
    });
    renderWeek(fakePlanning({ getWeekPlan: vi.fn().mockResolvedValue(empty) }));
    expect(await screen.findByText('No fixed commitments this week.')).toBeVisible();
    expect(screen.getAllByText('Nothing planned.')).toHaveLength(7);
    expect(screen.getByText('No overlaps to review.')).toBeVisible();
    expect(screen.getByText('Nothing to carry forward.')).toBeVisible();
    expect(screen.getByText('No unplaced Actions.')).toBeVisible();
  });

  it('saves the week as a template and links to the template list', async () => {
    const saveWeekAsTemplate = vi.fn().mockResolvedValue(receipt());
    renderWeek(
      fakePlanning({ getWeekPlan: vi.fn().mockResolvedValue(weekPlan()), saveWeekAsTemplate }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Save week as template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save week as template' });
    await user.click(within(dialog).getByRole('button', { name: 'Save template' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a template name');
    await user.type(within(dialog).getByLabelText('Template name'), 'Regular week');
    await user.click(within(dialog).getByRole('button', { name: 'Save template' }));
    await waitFor(() =>
      expect(saveWeekAsTemplate).toHaveBeenCalledWith({
        weekDate: '2026-09-28',
        title: 'Regular week',
      }),
    );
    expect(await screen.findByRole('link', { name: 'Open templates' })).toHaveAttribute(
      'href',
      '/plan/templates',
    );
  });
});
