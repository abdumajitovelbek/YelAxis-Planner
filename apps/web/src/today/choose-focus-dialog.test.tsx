// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ApplicationResult,
  CommandReceipt,
  FocusCandidate,
  FocusChoices,
  TodayApplication,
} from '@yelaxis/application';
import type { CalendarDate } from '@yelaxis/domain';

import { installDialogPolyfill, receipt } from '../plan/__fixtures__/c1-planning-fake';
import {
  WithRunner,
  actionCandidate,
  dayOccurrence,
  occurrenceCandidate,
  scheduledEntry,
  twelveHourProfile,
  mockOf,
} from './__fixtures__/focus-fixtures';
import {
  fakeToday,
  focusActionItem,
  focusChoices,
  focusOccurrenceItem,
  todayAction,
  todayId,
  todayTree,
} from './__fixtures__/today-fake';
import {
  ChooseFocusDialog,
  FocusDraftEditor,
  focusDraftOf,
  focusLimitReason,
  type FocusDraftItem,
} from './choose-focus-dialog';

beforeEach(() => installDialogPolyfill());
afterEach(() => cleanup());

const date = '2026-09-28' as CalendarDate;
const call = todayAction(todayId(11), 'Call the printer', { state: 'scheduled' });
const outline = todayAction(todayId(12), 'Draft the outline');
const tidy = todayAction(todayId(13), 'Tidy the desk', { state: 'in_progress' });
const review = todayAction(todayId(14), 'Review the budget');
const stretch = dayOccurrence('Stretch', 3);
const { block: callBlock } = scheduledEntry(call, '14:00', '15:00');

const candidates: readonly FocusCandidate[] = [
  actionCandidate(call, 'scheduled', { block: callBlock }),
  actionCandidate(outline, 'flexible'),
  actionCandidate(tidy, 'flexible'),
  occurrenceCandidate(stretch),
  actionCandidate(review, 'week'),
];

const choicesWith = (overrides: Partial<FocusChoices> = {}): FocusChoices =>
  focusChoices({ profile: twelveHourProfile, candidates, ...overrides });

function Dialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <WithRunner>
      {(runner) => (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <ChooseFocusDialog
            open={open}
            date={date}
            runner={runner}
            onClose={() => {
              setOpen(false);
              onClose();
            }}
          />
        </>
      )}
    </WithRunner>
  );
}

function renderDialog(today: TodayApplication, onClose = vi.fn()) {
  render(todayTree(today, <Dialog onClose={onClose} />));
  return onClose;
}

const loaded = (choices: FocusChoices = choicesWith()) =>
  fakeToday({ getFocusChoices: vi.fn(() => Promise.resolve(choices)) });

const orderList = () => screen.getByRole('list', { name: 'Order' });
const orderTitles = () =>
  within(orderList())
    .getAllByRole('listitem')
    .map((row) => row.querySelector('.focus-order-title')?.textContent);

describe('ChooseFocusDialog', () => {
  it('loads the date’s choices grouped in plan order with nothing preselected', async () => {
    const today = loaded();
    renderDialog(today);
    const dialog = screen.getByRole('dialog', {
      name: 'Choose focus for Monday, September 28, 2026',
    });
    expect(within(dialog).getByText('Loading focus choices…')).toBeInTheDocument();
    await within(dialog).findByRole('group', { name: 'Scheduled' });
    expect(mockOf(today, 'getFocusChoices')).toHaveBeenCalledWith(date);
    expect(
      within(dialog)
        .getAllByRole('group')
        .map((group) => group.querySelector('legend')?.textContent),
    ).toEqual(['Scheduled', 'Flexible', 'Routines', 'This week']);
    for (const box of within(dialog).getAllByRole('checkbox')) expect(box).not.toBeChecked();
    expect(within(dialog).getByText('0 of 3 chosen')).toBeVisible();
    expect(within(dialog).getByText('No focus chosen.')).toBeVisible();
    const described = (name: string, description: string) =>
      expect(within(dialog).getByRole('checkbox', { name })).toHaveAccessibleDescription(
        description,
      );
    described('Call the printer', 'Scheduled 2:00 PM–3:00 PM');
    described('Draft the outline', 'Flexible');
    described('Tidy the desk', 'Flexible · In progress');
    described('Stretch', 'Routine · Planned');
    described('Review the budget', 'This week');
    // Focus moves to the first choice once the choices load.
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: /Call the printer/u })).toHaveFocus(),
    );
    expect(dialog.textContent).not.toMatch(/suggest|recommend/iu);
  });

  it('limits the choice to three, saying why the others are unavailable', async () => {
    const user = userEvent.setup();
    renderDialog(loaded());
    await screen.findByRole('group', { name: 'Scheduled' });
    await user.click(screen.getByRole('checkbox', { name: /Draft the outline/u }));
    await user.click(screen.getByRole('checkbox', { name: /Call the printer/u }));
    await user.click(screen.getByRole('checkbox', { name: /Stretch/u }));
    expect(screen.getByText('3 of 3 chosen')).toBeVisible();
    const fourth = screen.getByRole('checkbox', { name: /Review the budget/u });
    expect(fourth).toHaveAttribute('aria-disabled', 'true');
    expect(fourth).toHaveAccessibleDescription(`This week ${focusLimitReason}`);
    await user.click(fourth);
    expect(fourth).not.toBeChecked();
    expect(orderTitles()).toEqual(['Draft the outline', 'Call the printer', 'Stretch']);
    // Clearing one frees the others again.
    await user.click(screen.getByRole('checkbox', { name: /Stretch/u }));
    expect(fourth).not.toHaveAttribute('aria-disabled');
  });

  it('orders the choice with buttons and keeps keyboard focus on the moved item', async () => {
    const user = userEvent.setup();
    renderDialog(loaded());
    await screen.findByRole('group', { name: 'Scheduled' });
    await user.click(screen.getByRole('checkbox', { name: /Draft the outline/u }));
    await user.click(screen.getByRole('checkbox', { name: /Call the printer/u }));
    await user.click(screen.getByRole('checkbox', { name: /Stretch/u }));
    screen.getByRole('button', { name: 'Move Draft the outline down' }).focus();
    await user.keyboard('{Enter}');
    expect(orderTitles()).toEqual(['Call the printer', 'Draft the outline', 'Stretch']);
    expect(screen.getByRole('button', { name: 'Move Draft the outline down' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(orderTitles()).toEqual(['Call the printer', 'Stretch', 'Draft the outline']);
    // At the end of the list focus moves to the sibling button.
    expect(screen.getByRole('button', { name: 'Move Draft the outline up' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Remove Stretch' }));
    expect(orderTitles()).toEqual(['Call the printer', 'Draft the outline']);
    expect(screen.getByRole('button', { name: 'Remove Draft the outline' })).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: /Stretch/u })).not.toBeChecked();
  });

  it('saves the whole choice in one command with one Undo', async () => {
    const setDayFocus = vi.fn(() => Promise.resolve(receipt('undo-focus')));
    const today = fakeToday({
      getFocusChoices: vi.fn(() => Promise.resolve(choicesWith())),
      setDayFocus,
    });
    const onClose = renderDialog(today);
    const user = userEvent.setup();
    await screen.findByRole('group', { name: 'Scheduled' });
    await user.click(screen.getByRole('checkbox', { name: /Stretch/u }));
    await user.click(screen.getByRole('checkbox', { name: /Draft the outline/u }));
    await user.click(screen.getByRole('button', { name: 'Save focus' }));
    expect(setDayFocus).toHaveBeenCalledTimes(1);
    expect(setDayFocus).toHaveBeenCalledWith({
      date,
      items: [
        {
          kind: 'routine_occurrence',
          occurrence: {
            routineId: stretch.ref.routineId,
            generation: 1,
            period: stretch.ref.period,
          },
        },
        { kind: 'action', actionId: outline.id },
      ],
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(
      await screen.findByText('Focus saved for Monday, September 28, 2026.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('starts from the current focus and keeps a changed item unless the person removes it', async () => {
    const setDayFocus = vi.fn(() => Promise.resolve(receipt()));
    const changed = focusOccurrenceItem(dayOccurrence('Journal', 4), { position: 2, stale: true });
    const choices = choicesWith({
      current: [focusActionItem(outline, { position: 1 }), changed],
      candidates: candidates.map((candidate) =>
        candidate.key === actionCandidate(outline, 'flexible').key
          ? { ...candidate, selected: true }
          : candidate,
      ),
    });
    const today = fakeToday({
      getFocusChoices: vi.fn(() => Promise.resolve(choices)),
      setDayFocus,
    });
    renderDialog(today);
    const user = userEvent.setup();
    await screen.findByRole('group', { name: 'Scheduled' });
    expect(screen.getByRole('checkbox', { name: /Draft the outline/u })).toBeChecked();
    expect(orderTitles()).toEqual(['Draft the outline', 'Journal']);
    expect(within(orderList()).getByText('This routine occurrence changed.')).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: /Review the budget/u }));
    await user.click(screen.getByRole('button', { name: 'Save focus' }));
    expect(setDayFocus).toHaveBeenCalledWith({
      date,
      items: [
        { kind: 'action', actionId: outline.id },
        changed.target,
        { kind: 'action', actionId: review.id },
      ],
    });
  });

  it('closes without writing when nothing changed, and Cancel never writes', async () => {
    const choices = choicesWith({ current: [focusActionItem(outline, { position: 1 })] });
    const today = fakeToday({ getFocusChoices: vi.fn(() => Promise.resolve(choices)) });
    const onClose = renderDialog(today);
    const user = userEvent.setup();
    await screen.findByRole('group', { name: 'Scheduled' });
    await user.click(screen.getByRole('button', { name: 'Save focus' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('group', { name: 'Scheduled' });
    await user.click(screen.getByRole('checkbox', { name: /Stretch/u }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(mockOf(today, 'setDayFocus')).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the error when saving fails', async () => {
    const failure: ApplicationResult<CommandReceipt> = {
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: {
          code: 'selection_limit',
          message: "A day's focus holds up to three items. Remove one to choose another.",
        },
      },
    };
    const today = fakeToday({
      getFocusChoices: vi.fn(() => Promise.resolve(choicesWith())),
      setDayFocus: vi.fn(() => Promise.resolve(failure)),
    });
    const onClose = renderDialog(today);
    const user = userEvent.setup();
    await screen.findByRole('group', { name: 'Scheduled' });
    await user.click(screen.getByRole('checkbox', { name: /Stretch/u }));
    await user.click(screen.getByRole('button', { name: 'Save focus' }));
    const dialog = screen.getByRole('dialog');
    expect(
      await within(dialog).findByText(
        "A day's focus holds up to three items. Remove one to choose another.",
      ),
    ).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: /Stretch/u })).toBeChecked();
  });

  it('offers a retry when the choices cannot be read', async () => {
    const getFocusChoices = vi
      .fn<TodayApplication['getFocusChoices']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(choicesWith());
    renderDialog(fakeToday({ getFocusChoices }));
    expect(
      await screen.findByText('Focus choices could not be read. Your plan was not changed.'),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('group', { name: 'Scheduled' })).toBeVisible();
    expect(getFocusChoices).toHaveBeenCalledTimes(2);
  });

  it('is read-only for an earlier day', async () => {
    const today = loaded(choicesWith({ editable: false }));
    renderDialog(today);
    expect(await screen.findByText('Focus for an earlier day is kept as it was.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save focus' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says so when the week group is cut at its limit', async () => {
    renderDialog(loaded(choicesWith({ weekTotal: 52 })));
    expect(await screen.findByText('Showing 1 of 52 Actions planned for this week.')).toBeVisible();
  });

  it('keeps the date it opened with when the page’s day changes (rollover)', async () => {
    const setDayFocus = vi.fn(() => Promise.resolve(receipt('undo-focus')));
    const getFocusChoices = vi.fn((day: string) =>
      Promise.resolve(choicesWith({ date: day as CalendarDate })),
    );
    const today = fakeToday({ getFocusChoices, setDayFocus });
    function Rollover(): ReactNode {
      const [day, setDay] = useState(date);
      const [open, setOpen] = useState(true);
      return (
        <WithRunner>
          {(runner) => (
            <>
              <button type="button" onClick={() => setDay('2026-09-29' as CalendarDate)}>
                Next day
              </button>
              <button type="button" onClick={() => setOpen(true)}>
                Open
              </button>
              <ChooseFocusDialog
                open={open}
                date={day}
                runner={runner}
                onClose={() => setOpen(false)}
              />
            </>
          )}
        </WithRunner>
      );
    }
    render(todayTree(today, <Rollover />));
    const user = userEvent.setup();
    await screen.findByRole('group', { name: 'Scheduled' });
    await user.click(screen.getByRole('checkbox', { name: /Draft the outline/u }));
    // The live page moves to the next day while the dialog is open (a click stands in for it).
    fireEvent.click(screen.getByRole('button', { name: 'Next day', hidden: true }));
    expect(
      screen.getByRole('dialog', { name: 'Choose focus for Monday, September 28, 2026' }),
    ).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Draft the outline/u })).toBeChecked();
    expect(getFocusChoices).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Save focus' }));
    expect(setDayFocus).toHaveBeenCalledWith({
      date,
      items: [{ kind: 'action', actionId: outline.id }],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Opened again, it uses the page's new day.
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(
      await screen.findByRole('dialog', { name: 'Choose focus for Tuesday, September 29, 2026' }),
    ).toBeVisible();
    expect(getFocusChoices).toHaveBeenLastCalledWith('2026-09-29');
  });

  it('explains an empty day', async () => {
    renderDialog(loaded(choicesWith({ candidates: [] })));
    expect(
      await screen.findByText(
        'Nothing is planned for this day yet. Place Actions on the day in Plan to choose them here.',
      ),
    ).toBeVisible();
  });
});

describe('FocusDraftEditor', () => {
  function Editor({
    extra,
    initial,
    onChange,
  }: {
    readonly extra?: readonly FocusCandidate[];
    readonly initial: readonly FocusDraftItem[];
    readonly onChange: (value: readonly FocusDraftItem[]) => void;
  }): ReactNode {
    const [value, setValue] = useState(initial);
    return (
      <FocusDraftEditor
        choices={choicesWith()}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        {...(extra === undefined ? {} : { extraCandidates: extra })}
        idPrefix="end-day-focus"
      />
    );
  }

  it('adds extra candidates to their group once and reports every change', async () => {
    const onChange = vi.fn();
    const carried = todayAction(todayId(20), 'Carried Action');
    render(
      todayTree(
        fakeToday(),
        <Editor
          initial={[]}
          onChange={onChange}
          extra={[actionCandidate(carried, 'flexible'), actionCandidate(outline, 'flexible')]}
        />,
      ),
    );
    const flexible = screen.getByRole('group', { name: 'Flexible' });
    expect(
      within(flexible)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(['Draft the outline', 'Tidy the desk', 'Carried Action']);
    await userEvent.click(within(flexible).getByRole('checkbox', { name: /Carried Action/u }));
    expect(onChange).toHaveBeenLastCalledWith([
      {
        key: actionCandidate(carried, 'flexible').key,
        label: 'Carried Action',
        target: { kind: 'action', actionId: carried.id },
      },
    ]);
    expect(
      document.getElementById(`end-day-focus-choice-${actionCandidate(carried, 'flexible').key}`),
    ).not.toBeNull();
  });

  it('builds a draft from the current focus in the person’s order', () => {
    const current = [
      focusActionItem(tidy, { position: 1 }),
      focusActionItem(outline, { position: 2 }),
    ];
    expect(focusDraftOf(choicesWith({ current }))).toEqual(
      current.map((item) => ({
        key: item.key,
        label: item.kind === 'action' ? item.action.title : '',
        target: item.target,
      })),
    );
  });
});
