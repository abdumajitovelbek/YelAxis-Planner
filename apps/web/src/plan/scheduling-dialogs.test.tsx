// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ApplicationResult,
  CommandReceipt,
  PlanningApplication,
  ReminderView,
} from '@yelaxis/application';
import type { CalendarDate, IanaTimeZone, Instant, UUID, WallTime } from '@yelaxis/domain';

import {
  fakePlanning,
  installDialogPolyfill,
  profile,
  receipt,
  renderTree,
  report,
} from './__fixtures__/c1-planning-fake';
import { CommandFeedback, useCommandRunner } from './planning-context';
import {
  BlockStateControls,
  PlanDialogs,
  blockReminderDraft,
  isBlockEntry,
  reminderSavedCopy,
  validateBlockReminder,
  type BlockEntry,
  type DialogRequest,
} from './scheduling-dialogs';

beforeAll(() => {
  installDialogPolyfill();
});

afterEach(() => cleanup());

if (!isBlockEntry(report)) throw new Error('The report fixture is a block entry.');
/** Write report: a planned Action block on Tuesday 2026-09-29, 09:30-11:00 (UTC), revision 2. */
const entry: BlockEntry = report;

const view = (overrides: Partial<ReminderView> = {}): ReminderView => ({
  reminderId: 'reminder-1' as UUID,
  localRevision: 3,
  kind: 'relative',
  remindAt: '2026-09-29T09:15:00.000Z' as Instant,
  timeZone: 'UTC' as IanaTimeZone,
  date: '2026-09-29' as CalendarDate,
  time: '09:15' as WallTime,
  minutesBefore: 15,
  ...overrides,
});

/** The block's controls and every plan dialog, as a Plan or Today view hosts them. */
function Harness({ initial = null }: { readonly initial?: DialogRequest | null }): ReactNode {
  const runner = useCommandRunner();
  const [request, setRequest] = useState<DialogRequest | null>(initial);
  return (
    <>
      <CommandFeedback runner={runner} />
      <BlockStateControls entry={entry} onRequest={setRequest} runner={runner} />
      <PlanDialogs
        profile={profile}
        request={request}
        runner={runner}
        viewDate="2026-09-29"
        onClose={() => setRequest(null)}
      />
    </>
  );
}

function renderHarness(overrides: Partial<PlanningApplication>): PlanningApplication {
  const planning = fakePlanning(overrides);
  render(renderTree(planning, <Harness />));
  return planning;
}

async function openReminder(): Promise<HTMLElement> {
  await userEvent.setup().click(screen.getByRole('button', { name: 'Reminder… Write report' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reminder for “Write report”' });
  await within(dialog).findByRole('group', { name: 'Reminder' });
  return dialog;
}

const rejection = (message: string): ApplicationResult<CommandReceipt> => ({
  ok: false,
  error: {
    code: 'domain_rejected',
    domainError: { code: 'invalid_transition', message, details: { reason: 'x' } },
  },
});

describe('block reminder words and checks', () => {
  it('opens on the block’s reminder, or Off with the block’s own date and start', () => {
    expect(blockReminderDraft(entry, null, 'UTC')).toEqual({
      choice: 'off',
      date: '2026-09-29',
      time: '09:30',
      minutes: '15',
    });
    expect(blockReminderDraft(entry, view({ minutesBefore: 45 }), 'UTC')).toMatchObject({
      choice: 'relative',
      minutes: '45',
    });
    // A set time is read in the planning zone, even if it was chosen in another one.
    expect(
      blockReminderDraft(
        entry,
        view({
          kind: 'at',
          remindAt: '2026-09-29T05:00:00.000Z' as Instant,
          timeZone: 'Asia/Tashkent' as IanaTimeZone,
          date: '2026-09-29' as CalendarDate,
          time: '10:00' as WallTime,
        }),
        'America/New_York',
      ),
    ).toMatchObject({ choice: 'at', date: '2026-09-29', time: '01:00' });
  });

  it.each([
    [{ choice: 'off' }, {}, null],
    [
      { choice: 'at', date: '2026-09-29', time: '08:00' },
      {},
      { kind: 'at', date: '2026-09-29', time: '08:00' },
    ],
    [
      { choice: 'at', date: '', time: '08:00' },
      { date: 'Choose a date for the reminder.' },
      undefined,
    ],
    [
      { choice: 'at', date: '2026-02-30', time: '' },
      { date: 'Choose a date for the reminder.', time: 'Choose a time for the reminder.' },
      undefined,
    ],
    [{ choice: 'relative', minutes: '0' }, {}, { kind: 'relative', minutesBefore: 0 }],
    [{ choice: 'relative', minutes: '10080' }, {}, { kind: 'relative', minutesBefore: 10_080 }],
    [
      { choice: 'relative', minutes: '10081' },
      { minutes: 'Enter whole minutes from 0 to 10,080 (7 days).' },
      undefined,
    ],
    [
      { choice: 'relative', minutes: '2.5' },
      { minutes: 'Enter whole minutes from 0 to 10,080 (7 days).' },
      undefined,
    ],
    [
      { choice: 'relative', minutes: '' },
      { minutes: 'Enter whole minutes from 0 to 10,080 (7 days).' },
      undefined,
    ],
  ] as const)('checks %j', (change, errors, input) => {
    const result = validateBlockReminder({
      date: '2026-09-29',
      time: '09:30',
      minutes: '15',
      ...change,
    });
    expect(result.errors).toEqual(errors);
    expect(result.input).toEqual(input);
  });
});

describe('block reminder dialog', () => {
  it('sets a reminder before the start, saying it is saved and not yet delivered', async () => {
    const getTimeBlockReminder = vi.fn().mockResolvedValue(null);
    const setTimeBlockReminder = vi.fn().mockResolvedValue(receipt());
    renderHarness({ getTimeBlockReminder, setTimeBlockReminder });
    const dialog = await openReminder();
    expect(getTimeBlockReminder).toHaveBeenCalledWith('block-report');
    // Nothing promises that a reminder will reach the person: manual planning delivers none.
    expect(dialog).toHaveAccessibleDescription(
      'Set, change, or turn off the reminder saved for this time block.',
    );
    const group = within(dialog).getByRole('group', { name: 'Reminder' });
    expect(group).toHaveAccessibleDescription(reminderSavedCopy);
    expect(within(group).getByRole('radio', { name: 'Off' })).toBeChecked();
    await waitFor(() => expect(within(group).getByRole('radio', { name: 'Off' })).toHaveFocus());
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('name')),
    ).toEqual(['block-reminder-choice', 'block-reminder-choice', 'block-reminder-choice']);

    const user = userEvent.setup();
    await user.click(within(group).getByRole('radio', { name: 'Before the start' }));
    const minutes = within(group).getByRole('spinbutton', { name: /Minutes before the start/u });
    expect(minutes).toHaveValue(15);
    expect(minutes).toHaveAccessibleDescription(/0 to 10,080 \(7 days\)\. The block starts/u);
    await user.clear(minutes);
    await user.type(minutes, '30');
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    await waitFor(() =>
      expect(setTimeBlockReminder).toHaveBeenCalledWith({
        blockId: 'block-report',
        revision: 2,
        reminder: { kind: 'relative', minutesBefore: 30 },
      }),
    );
    expect(await screen.findByText('Reminder saved.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('replaces a reminder with one at a chosen time, naming the shown revision', async () => {
    const setTimeBlockReminder = vi.fn().mockResolvedValue(receipt());
    renderHarness({
      getTimeBlockReminder: vi.fn().mockResolvedValue(view()),
      setTimeBlockReminder,
    });
    const dialog = await openReminder();
    const group = within(dialog).getByRole('group', { name: 'Reminder' });
    expect(within(group).getByRole('radio', { name: 'Before the start' })).toBeChecked();
    expect(within(group).getByRole('spinbutton', { name: /Minutes before/u })).toHaveValue(15);

    const user = userEvent.setup();
    await user.click(within(group).getByRole('radio', { name: 'At a time' }));
    fireEvent.change(within(group).getByLabelText('Reminder date'), {
      target: { value: '2026-09-28' },
    });
    fireEvent.change(within(group).getByLabelText('Reminder time'), {
      target: { value: '20:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    await waitFor(() =>
      expect(setTimeBlockReminder).toHaveBeenCalledWith({
        blockId: 'block-report',
        revision: 2,
        reminderRevision: 3,
        reminder: { kind: 'at', date: '2026-09-28', time: '20:00' },
      }),
    );
  });

  it('turns a reminder off, and closes without a command when nothing changed', async () => {
    const turnOffTimeBlockReminder = vi.fn().mockResolvedValue(receipt());
    const setTimeBlockReminder = vi.fn();
    renderHarness({
      getTimeBlockReminder: vi.fn().mockResolvedValue(view()),
      turnOffTimeBlockReminder,
      setTimeBlockReminder,
    });
    const user = userEvent.setup();
    let dialog = await openReminder();
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(setTimeBlockReminder).not.toHaveBeenCalled();

    dialog = await openReminder();
    await user.click(within(dialog).getByRole('radio', { name: 'Off' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    await waitFor(() =>
      expect(turnOffTimeBlockReminder).toHaveBeenCalledWith({
        blockId: 'block-report',
        reminderRevision: 3,
      }),
    );
    expect(await screen.findByText('Reminder turned off.')).toBeInTheDocument();
  });

  it('ties each error to its field and saves nothing until it is fixed', async () => {
    const setTimeBlockReminder = vi.fn().mockResolvedValue(receipt());
    renderHarness({
      getTimeBlockReminder: vi.fn().mockResolvedValue(null),
      setTimeBlockReminder,
    });
    const dialog = await openReminder();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('radio', { name: 'Before the start' }));
    const minutes = within(dialog).getByRole('spinbutton', { name: /Minutes before/u });
    await user.clear(minutes);
    await user.type(minutes, '10081');
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Enter whole minutes from 0 to 10,080 (7 days).',
    );
    expect(minutes).toHaveAttribute('aria-invalid', 'true');
    expect(minutes).toHaveAccessibleDescription(/Enter whole minutes from 0 to 10,080/u);
    expect(setTimeBlockReminder).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('radio', { name: 'At a time' }));
    const time = within(dialog).getByLabelText('Reminder time');
    fireEvent.change(time, { target: { value: '' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    expect(time).toHaveAttribute('aria-invalid', 'true');
    expect(time).toHaveAccessibleDescription('Choose a time for the reminder.');
    expect(within(dialog).getByLabelText('Reminder date')).toHaveAttribute('aria-invalid', 'false');
    expect(setTimeBlockReminder).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the reason when the command is refused', async () => {
    renderHarness({
      getTimeBlockReminder: vi.fn().mockResolvedValue(null),
      setTimeBlockReminder: vi
        .fn()
        .mockResolvedValue(rejection('Only a planned time block can get a reminder.')),
    });
    const dialog = await openReminder();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('radio', { name: 'Before the start' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save reminder' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Only a planned time block can get a reminder.',
    );
    expect(screen.getByRole('dialog', { name: 'Reminder for “Write report”' })).toBeVisible();
  });

  it('shows a recoverable error when the reminder cannot be read', async () => {
    const getTimeBlockReminder = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce(view());
    renderHarness({ getTimeBlockReminder });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reminder… Write report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reminder for “Write report”' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The reminder could not be read. Nothing was changed.',
    );
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByRole('radio', { name: 'Before the start' })).toBeChecked();
    expect(getTimeBlockReminder).toHaveBeenCalledTimes(2);
  });

  it('works from the keyboard alone', async () => {
    const setTimeBlockReminder = vi.fn().mockResolvedValue(receipt());
    renderHarness({
      getTimeBlockReminder: vi.fn().mockResolvedValue(null),
      setTimeBlockReminder,
    });
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Reminder… Write report' }).focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Reminder for “Write report”' });
    const off = await within(dialog).findByRole('radio', { name: 'Off' });
    await waitFor(() => expect(off).toHaveFocus());
    // Arrow keys move through the native radio group: Off, At a time, Before the start.
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(within(dialog).getByRole('radio', { name: 'Before the start' })).toBeChecked();
    await user.tab();
    expect(within(dialog).getByRole('spinbutton', { name: /Minutes before/u })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(setTimeBlockReminder).toHaveBeenCalledWith(
        expect.objectContaining({ reminder: { kind: 'relative', minutesBefore: 15 } }),
      ),
    );
  });
});

describe('block controls and move dialogs', () => {
  it('offers Reminder… for a planned block only', () => {
    const planning = fakePlanning();
    const { rerender } = render(renderTree(planning, <ControlsOnly blockEntry={entry} />));
    expect(screen.getByRole('button', { name: 'Reminder… Write report' })).toBeVisible();
    rerender(
      renderTree(
        planning,
        <ControlsOnly
          blockEntry={{
            ...entry,
            state: 'completed',
            block: { ...entry.block, state: 'completed' },
          }}
        />,
      ),
    );
    expect(screen.queryByRole('button', { name: /Reminder…/u })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reopen Write report' })).toBeVisible();
  });

  it('says a reminder moves with a moved or shortened block', async () => {
    render(renderTree(fakePlanning(), <Harness initial={{ kind: 'move', entry }} />));
    expect(
      await screen.findByText(/If this block has a reminder, it moves with it\./u),
    ).toBeVisible();
    cleanup();
    render(renderTree(fakePlanning(), <Harness initial={{ kind: 'shorten', entry }} />));
    expect(
      await screen.findByText('If this block has a reminder, it stays with the shorter block.'),
    ).toBeVisible();
  });
});

function ControlsOnly({ blockEntry }: { readonly blockEntry: BlockEntry }): ReactNode {
  const runner = useCommandRunner();
  return <BlockStateControls entry={blockEntry} onRequest={() => undefined} runner={runner} />;
}
