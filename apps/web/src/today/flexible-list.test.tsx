// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ActionApplication, PlanningApplication, TodayView } from '@yelaxis/application';

import { installDialogPolyfill, receipt } from '../plan/__fixtures__/c1-planning-fake';
import { fakeToday, todayPlanning, todayTree } from './__fixtures__/today-fake';
import {
  callBank,
  fakeActions,
  populatedView,
  readArticle,
  sendInvoice,
  todaySettings,
} from './__fixtures__/today-view-fixtures';
import { TodayRoute } from './today-page';

beforeAll(() => {
  installDialogPolyfill();
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
});

afterEach(() => cleanup());

function setup(
  views: readonly TodayView[],
  options: {
    readonly planning?: Partial<PlanningApplication>;
    readonly actions?: Partial<ActionApplication>;
  } = {},
) {
  const getToday = vi.fn<(date: string) => Promise<TodayView>>();
  for (const view of views.slice(0, -1)) getToday.mockResolvedValueOnce(view);
  getToday.mockResolvedValue(views.at(-1) ?? populatedView());
  const reorderFlexible = vi.fn(() => Promise.resolve(receipt('undo-reorder')));
  const planningUndo = vi.fn(() => Promise.resolve(receipt('undo-3')));
  const unplace = vi.fn(() => Promise.resolve(receipt()));
  const transition = vi.fn(() => Promise.resolve(receipt('undo-actions')));
  const actionsUndo = vi.fn(() => Promise.resolve(receipt('undo-2')));
  const today = fakeToday({ getToday, reorderFlexible });
  const planning = todayPlanning({
    getCapacitySettings: vi.fn(() => Promise.resolve(todaySettings)),
    undo: planningUndo,
    unplace,
    ...options.planning,
  });
  const actions = fakeActions({ transition, undo: actionsUndo, ...options.actions });
  render(
    todayTree(today, <TodayRoute defaultsConfirmed onResumeSetup={() => undefined} />, {
      planning,
      actions,
    }),
  );
  return {
    reorderFlexible,
    planningUndo,
    unplace,
    transition,
    actionsUndo,
    getToday,
    user: userEvent.setup(),
  };
}

const flexibleList = () => screen.findByRole('list', { name: /^Flexible Actions for / });
const titlesIn = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((item) => within(item).getAllByRole('link')[0]?.textContent);

describe('Today flexible Actions', () => {
  it('lists open Actions in the person’s order with named controls', async () => {
    setup([populatedView()]);
    const list = await flexibleList();
    expect(list).toHaveAccessibleName('Flexible Actions for Monday, September 28, 2026');
    expect(titlesIn(list)).toEqual(['Call the bank', 'Read article']);
    for (const name of [
      'Complete Call the bank',
      'Schedule… Call the bank',
      'Move Call the bank up',
      'Move Call the bank down',
    ])
      expect(within(list).getByRole('button', { name })).toBeVisible();
    // WCAG 2.5.3: each visible label is part of its accessible name (speech input).
    for (const button of within(list).getAllByRole('button')) {
      const visible = Array.from(button.childNodes)
        .filter((node) => !(node instanceof HTMLElement && node.getAttribute('aria-hidden')))
        .map((node) => node.textContent)
        .join('')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase();
      const name = (
        button.getAttribute('aria-label') ?? button.textContent.replace(/\s+/gu, ' ').trim()
      ).toLowerCase();
      if (!(button.parentElement?.closest('details:not([open])') ?? null))
        expect(name).toContain(visible);
    }
    // Estimate and in-progress facts are words, not colors.
    expect(within(list).getByText('Estimate 15 minutes')).toBeVisible();
    expect(within(list).getByText('In progress')).toBeVisible();
  });

  it('completes through the Actions facade, and Undo uses the Actions undo', async () => {
    const { actionsUndo, planningUndo, transition, user } = setup([
      populatedView(),
      populatedView({
        flexible: { open: [readArticle], done: [sendInvoice, { ...callBank, state: 'completed' }] },
      }),
    ]);
    const list = await flexibleList();
    await user.click(within(list).getByRole('button', { name: 'Complete Call the bank' }));
    expect(transition).toHaveBeenCalledWith(callBank.id, 3, 'completed');
    expect(await screen.findByText('Call the bank completed.')).toBeInTheDocument();
    expect(await screen.findByText('Done today (2)')).toBeVisible();
    // The Action left the open list: focus moves to the page heading, never the body.
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(actionsUndo).toHaveBeenCalledWith('undo-actions');
    expect(planningUndo).not.toHaveBeenCalled();
  });

  it('moves an Action by keyboard, announces its position, and keeps focus on the button', async () => {
    const { planningUndo, reorderFlexible, user } = setup([
      populatedView(),
      populatedView({ flexible: { open: [readArticle, callBank], done: [sendInvoice] } }),
    ]);
    const list = await flexibleList();
    const up = within(list).getByRole('button', { name: 'Move Call the bank up' });
    expect(up).toHaveAttribute('aria-disabled', 'true');
    await user.click(up);
    expect(reorderFlexible).not.toHaveBeenCalled();
    expect(within(list).getByRole('button', { name: 'Move Read article down' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    within(list).getByRole('button', { name: 'Move Call the bank down' }).focus();
    await user.keyboard('{Enter}');
    expect(reorderFlexible).toHaveBeenCalledWith({
      date: '2026-09-28',
      placementId: callBank.placement?.id,
      revision: 2,
      direction: 'down',
    });
    expect(await screen.findByText('Call the bank moved to position 2 of 2.')).toBeInTheDocument();
    await waitFor(() => expect(titlesIn(list)).toEqual(['Read article', 'Call the bank']));
    expect(within(list).getByRole('button', { name: 'Move Call the bank down' })).toHaveFocus();
    // The reorder is a planning command: its Undo is the default planning undo.
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(planningUndo).toHaveBeenCalledWith('undo-reorder');
  });

  it('never pulls focus back to a Move button once the person moved on by keyboard', async () => {
    const { user } = setup([
      populatedView(),
      populatedView({ flexible: { open: [readArticle, callBank], done: [sendInvoice] } }),
      populatedView({
        flexible: { open: [callBank], done: [sendInvoice, { ...readArticle, state: 'completed' }] },
      }),
    ]);
    const list = await flexibleList();
    within(list).getByRole('button', { name: 'Move Call the bank down' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(titlesIn(list)).toEqual(['Read article', 'Call the bank']));
    expect(within(list).getByRole('button', { name: 'Move Call the bank down' })).toHaveFocus();
    // Straight on, by keyboard only: complete the other row, which then leaves the list.
    const other = within(list).getByRole('button', { name: 'Complete Read article' });
    for (let press = 0; press < 12 && document.activeElement !== other; press += 1)
      await user.tab({ shift: true });
    expect(other).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(titlesIn(list)).toEqual(['Call the bank']));
    // The focused control went away: focus lands on the heading, not on an older Move button.
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  });

  it('opens Schedule and Move to with the day, and removes from the day by command', async () => {
    const { unplace, user } = setup([populatedView()]);
    const list = await flexibleList();
    await user.click(within(list).getByRole('button', { name: 'Schedule… Call the bank' }));
    expect(
      await screen.findByRole('dialog', { name: 'Schedule “Call the bank”' }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    const row = within(list).getAllByRole('listitem')[0] as HTMLElement;
    await user.click(within(row).getByText('More options'));
    await user.click(within(row).getByRole('button', { name: 'Move to… Call the bank' }));
    const place = await screen.findByRole('dialog', { name: 'Place “Call the bank”' });
    expect(place).toBeVisible();
    // Each choice and its field keep distinct ids, so every label names the right control.
    for (const [choice, field, type] of [
      ['A specific date', 'Date', 'date'],
      ['A week', 'Any date in the week', 'date'],
    ] as const) {
      await user.click(within(place).getByRole('radio', { name: choice }));
      expect(within(place).getByLabelText(field)).toHaveAttribute('type', type);
    }
    await user.click(within(place).getByRole('radio', { name: 'A month' }));
    expect(within(place).getByLabelText('Month').tagName).toBe('SELECT');
    await user.keyboard('{Escape}');
    await user.click(within(row).getByRole('button', { name: 'Remove from day Call the bank' }));
    expect(unplace).toHaveBeenCalledWith({
      target: { kind: 'action', id: callBank.id, revision: 3 },
    });
    expect(within(row).getByRole('link', { name: 'Focus mode Call the bank' })).toHaveAttribute(
      'href',
      `/focus/${callBank.id}`,
    );
  });

  it('keeps finished Actions in a Done group with Reopen', async () => {
    const { transition, user } = setup([populatedView()]);
    await flexibleList();
    const summary = screen.getByText('Done today (1)');
    await user.click(summary);
    const done = screen.getByRole('list', { name: 'Done on Monday, September 28, 2026' });
    expect(within(done).getByRole('link', { name: 'Send invoice' })).toBeVisible();
    expect(within(done).getByText('Completed')).toBeVisible();
    await user.click(within(done).getByRole('button', { name: 'Reopen Send invoice' }));
    expect(transition).toHaveBeenCalledWith(sendInvoice.id, 3, 'planned');
    expect(await screen.findByText('Send invoice reopened.')).toBeInTheDocument();
  });

  it('says so when no flexible Action is open', async () => {
    setup([populatedView({ flexible: { open: [], done: [sendInvoice] } })]);
    expect(await screen.findByText('No open flexible Actions on this day.')).toBeVisible();
    expect(screen.queryByRole('list', { name: /^Flexible Actions for / })).toBeNull();
  });
});
