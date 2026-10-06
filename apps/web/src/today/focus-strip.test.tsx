// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Route, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FocusItemView, TodayApplication, TodayView } from '@yelaxis/application';
import type { CalendarDate } from '@yelaxis/domain';

import { installDialogPolyfill, receipt } from '../plan/__fixtures__/c1-planning-fake';
import type { RequestDialog } from '../plan/scheduling-dialogs';
import {
  WithRunner,
  dayOccurrence,
  focusActions,
  scheduledEntry,
  twelveHourProfile,
  weeklyOccurrence,
  mockOf,
} from './__fixtures__/focus-fixtures';
import {
  fakeToday,
  focusActionItem,
  focusOccurrenceItem,
  scheduledTiming,
  todayAction,
  todayId,
  todayPlanning,
  todayTree,
  todayView,
} from './__fixtures__/today-fake';
import {
  AddToFocusButton,
  ChooseFocusDialog,
  FocusDraftEditor,
  FocusStrip,
  alreadyInFocusReason,
  focusFullReason,
} from './focus-strip';

beforeEach(() => installDialogPolyfill());
afterEach(() => cleanup());

const outline = todayAction(todayId(1), 'Draft the outline');
const call = todayAction(todayId(2), 'Call the printer', { state: 'scheduled' });
const tidy = todayAction(todayId(3), 'Tidy the desk', { state: 'in_progress' });
const { entry: callEntry, block: callBlock } = scheduledEntry(call, '14:00', '15:00');
const stretch = dayOccurrence('Stretch', 1, { revision: 2 });

function populated(overrides: Partial<TodayView> = {}): TodayView {
  return todayView({
    profile: twelveHourProfile,
    focus: [
      focusActionItem(outline, { position: 1 }),
      focusActionItem(call, { position: 2, timing: scheduledTiming(callBlock) }),
      focusOccurrenceItem(stretch, { position: 3 }),
    ],
    timeline: {
      entries: [callEntry],
      conflicts: [],
      capacity: {
        date: '2026-09-28' as CalendarDate,
        plannedMinutes: 60,
        availability: { status: 'unknown' },
      },
      availability: [],
    },
    ...overrides,
  });
}

function Strip({
  onChoose = () => undefined,
  onRequest = () => undefined,
  view,
}: {
  readonly view: TodayView;
  readonly onRequest?: RequestDialog;
  readonly onChoose?: () => void;
}): ReactNode {
  return (
    <WithRunner>
      {(runner) => (
        <FocusStrip view={view} runner={runner} onRequest={onRequest} onChoose={onChoose} />
      )}
    </WithRunner>
  );
}

function renderStrip(
  view: TodayView,
  options: {
    readonly today?: TodayApplication;
    readonly onRequest?: RequestDialog;
    readonly onChoose?: () => void;
    readonly actions?: ReturnType<typeof focusActions>;
    readonly planning?: ReturnType<typeof todayPlanning>;
  } = {},
) {
  const today = options.today ?? fakeToday();
  const tree = (next: TodayView) =>
    todayTree(
      today,
      <Strip
        view={next}
        {...(options.onRequest === undefined ? {} : { onRequest: options.onRequest })}
        {...(options.onChoose === undefined ? {} : { onChoose: options.onChoose })}
      />,
      {
        ...(options.actions === undefined ? {} : { actions: options.actions }),
        ...(options.planning === undefined ? {} : { planning: options.planning }),
      },
    );
  const result = render(tree(view));
  return { today, rerender: (next: TodayView) => result.rerender(tree(next)) };
}

const item = (name: string) =>
  screen
    .getAllByRole('listitem')
    .find((element) => within(element).queryByRole('link', { name })) ??
  (() => {
    throw new Error(`No item ${name}`);
  })();

describe('FocusStrip', () => {
  it('lists the day’s focus in the person’s order with each state in words', () => {
    renderStrip(populated());
    expect(screen.getByRole('heading', { level: 2, name: 'Focus' })).toBeVisible();
    expect(
      screen.getByText('Up to three things you chose for this day. The order is yours.'),
    ).toBeVisible();
    const list = screen.getByRole('list', { name: 'Focus for Monday, September 28, 2026' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getAllByRole('link')[0]?.textContent)).toEqual([
      'Draft the outline',
      'Call the printer',
      'Stretch',
    ]);
    expect(within(rows[0] ?? list).getByText('1')).toBeVisible();
    expect(within(rows[0] ?? list).getByText('Flexible')).toBeVisible();
    expect(within(rows[1] ?? list).getByText('Scheduled 2:00 PM–3:00 PM')).toBeVisible();
    expect(within(rows[2] ?? list).getByText('Routine · Planned')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Draft the outline' })).toHaveAttribute(
      'href',
      `/actions/${outline.id}`,
    );
    expect(screen.getByRole('link', { name: 'Focus mode for Draft the outline' })).toHaveAttribute(
      'href',
      `/focus/${outline.id}`,
    );
    expect(screen.queryByRole('link', { name: /Focus mode for Stretch/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/suggest|recommend|score|streak|behind/iu);
  });

  it('shows an empty day calmly and opens Choose focus', async () => {
    const onChoose = vi.fn();
    renderStrip(todayView(), { onChoose });
    expect(screen.getByText('No focus chosen.')).toBeVisible();
    expect(screen.queryByRole('list')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Choose focus…' }));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it('keeps an earlier day’s focus read-only', () => {
    renderStrip(
      populated({ date: '2026-09-27' as CalendarDate, focusEditable: false, relation: 'past' }),
    );
    expect(screen.getByText('Focus for an earlier day is kept as it was.')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Remove from focus|Move|Complete|Choose/u }),
    ).toBeNull();
    expect(screen.getAllByRole('link', { name: /^Focus mode for/u })).toHaveLength(2);
  });

  it('says finished and changed items in words and offers only Remove for a changed occurrence', () => {
    const done = todayAction(todayId(4), 'Send the invoice', { state: 'completed' });
    const journal = focusOccurrenceItem(dayOccurrence('Journal', 2), { position: 3, stale: true });
    if (journal.kind !== 'routine_occurrence') throw new Error('Expected an occurrence item.');
    const archivedRoutine: FocusItemView = { ...journal, routineState: 'archived' };
    renderStrip(
      populated({
        focus: [
          focusActionItem(done, { position: 1, timing: { kind: 'elsewhere' } }),
          focusOccurrenceItem(stretch, { position: 2, stale: true }),
          archivedRoutine,
        ],
      }),
    );
    const finished = item('Send the invoice');
    expect(within(finished).getByText('Completed')).toBeVisible();
    expect(within(finished).queryByRole('button', { name: /^Complete/u })).toBeNull();
    expect(within(finished).queryByRole('link', { name: /Focus mode/u })).toBeNull();
    const changed = item('Stretch');
    expect(within(changed).getByText('This routine occurrence changed.')).toBeVisible();
    expect(within(changed).queryByRole('button', { name: /^Complete/u })).toBeNull();
    expect(
      within(changed).getByRole('button', { name: 'Remove from focus Stretch' }),
    ).toBeVisible();
    expect(within(item('Journal')).getByText('This Routine is archived.')).toBeVisible();
  });

  it('removes an item with one command and announces it', async () => {
    const today = fakeToday({ removeFocus: vi.fn(() => Promise.resolve(receipt('undo-remove'))) });
    renderStrip(populated(), { today });
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove from focus Call the printer' }),
    );
    expect(mockOf(today, 'removeFocus')).toHaveBeenCalledWith({
      selectionId: todayId(702),
      revision: 1,
    });
    expect(await screen.findByText('Call the printer removed from focus.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('reorders by keyboard, announces the position, and keeps focus on the moved item', async () => {
    const today = fakeToday({ reorderFocus: vi.fn(() => Promise.resolve(receipt('undo-move'))) });
    const view = populated();
    const { rerender } = renderStrip(view, { today });
    const user = userEvent.setup();
    const down = screen.getByRole('button', { name: 'Move Call the printer down' });
    down.focus();
    await user.keyboard('{Enter}');
    expect(mockOf(today, 'reorderFocus')).toHaveBeenCalledWith({
      selectionId: todayId(702),
      revision: 1,
      direction: 'down',
    });
    expect(
      await screen.findByText('Call the printer moved to position 3 of 3.'),
    ).toBeInTheDocument();
    // The re-queried view renders the new order; the moved item is now last, so focus goes to
    // its Move up button.
    const [first, second, third] = view.focus;
    if (first === undefined || second === undefined || third === undefined) throw new Error();
    rerender(
      populated({
        focus: [
          { ...first, position: 1 },
          { ...third, position: 2 },
          { ...second, position: 3, localRevision: 2 },
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move Call the printer up' })).toHaveFocus(),
    );
    expect(screen.getByRole('button', { name: 'Move Call the printer down' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('keeps the edge buttons focusable and does nothing when pressed', async () => {
    const today = fakeToday();
    renderStrip(populated(), { today });
    const up = screen.getByRole('button', { name: 'Move Draft the outline up' });
    expect(up).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(up);
    expect(mockOf(today, 'reorderFocus')).not.toHaveBeenCalled();
  });

  it('completes a flexible Action with the Actions undo', async () => {
    const actions = focusActions();
    const planning = todayPlanning();
    renderStrip(populated(), { actions, planning });
    await userEvent.click(screen.getByRole('button', { name: 'Complete Draft the outline' }));
    expect(mockOf(actions, 'transition')).toHaveBeenCalledWith(outline.id, 1, 'completed');
    expect(await screen.findByText('Draft the outline completed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mockOf(actions, 'undo')).toHaveBeenCalledWith('undo-action'));
    expect(mockOf(planning, 'undo')).not.toHaveBeenCalled();
  });

  it('opens the planning time block dialog for a scheduled focus Action', async () => {
    const onRequest = vi.fn();
    renderStrip(populated(), { onRequest });
    await userEvent.click(screen.getByRole('button', { name: 'Complete… Call the printer' }));
    expect(onRequest).toHaveBeenCalledWith({ kind: 'completeActionBlock', entry: callEntry });
  });

  it('leaves an Action scheduled on another day to Focus mode', () => {
    renderStrip(
      populated({ focus: [focusActionItem(call, { position: 1, timing: { kind: 'elsewhere' } })] }),
    );
    const row = item('Call the printer');
    expect(within(row).getByText('Scheduled on another day')).toBeVisible();
    expect(within(row).queryByRole('button', { name: /^Complete/u })).toBeNull();
    expect(
      within(row).getByRole('link', { name: 'Focus mode for Call the printer' }),
    ).toBeVisible();
  });

  it('completes a Routine Occurrence and logs one for a weekly count', async () => {
    const planning = todayPlanning({
      completeOccurrence: vi.fn(() => Promise.resolve(receipt('undo-occurrence'))),
    });
    const weekly = weeklyOccurrence('Swim', 1, 3);
    renderStrip(
      populated({
        focus: [
          focusOccurrenceItem(stretch, { position: 1 }),
          focusOccurrenceItem(weekly, { position: 2 }),
        ],
      }),
      { planning },
    );
    expect(within(item('Swim')).getByText('Routine · 1 of 3 this week')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Complete Stretch' }));
    expect(mockOf(planning, 'completeOccurrence')).toHaveBeenCalledWith({
      occurrence: {
        routineId: stretch.ref.routineId,
        generation: 1,
        period: stretch.ref.period,
        revision: 2,
      },
    });
    expect(await screen.findByText('Occurrence completed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Log one Swim' }));
    expect(mockOf(planning, 'completeOccurrence')).toHaveBeenCalledTimes(2);
  });

  it('opens Focus mode remembering the view it came from', async () => {
    function StateProbe(): ReactNode {
      const location = useLocation();
      return <p data-testid="focus-state">{JSON.stringify(location.state)}</p>;
    }
    const today = fakeToday();
    render(
      todayTree(today, <Strip view={populated()} />, {
        path: '/?date=2026-09-28',
        extraRoutes: <Route path="/focus/:actionId" element={<StateProbe />} />,
      }),
    );
    await userEvent.click(screen.getByRole('link', { name: 'Focus mode for Draft the outline' }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/focus/${outline.id}`);
    expect(screen.getByTestId('focus-state')).toHaveTextContent(
      JSON.stringify({ returnTo: '/?date=2026-09-28' }),
    );
  });

  it('shows in progress in words', () => {
    renderStrip(populated({ focus: [focusActionItem(tidy, { position: 1 })] }));
    expect(within(item('Tidy the desk')).getByText('In progress')).toBeVisible();
  });
});

describe('AddToFocusButton', () => {
  const target = { kind: 'action' as const, actionId: tidy.id };

  function renderButton(
    focus: readonly FocusItemView[],
    options: { readonly today?: TodayApplication; readonly editable?: boolean } = {},
  ) {
    const today = options.today ?? fakeToday();
    render(
      todayTree(
        today,
        <WithRunner>
          {(runner) => (
            <AddToFocusButton
              date={'2026-09-28' as CalendarDate}
              target={target}
              title="Tidy the desk"
              focus={focus}
              editable={options.editable ?? true}
              runner={runner}
            />
          )}
        </WithRunner>,
      ),
    );
    return today;
  }

  it('adds the item to the day’s focus in one command', async () => {
    const today = renderButton([], {
      today: fakeToday({ addFocus: vi.fn(() => Promise.resolve(receipt('undo-add'))) }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add to focus Tidy the desk' }));
    expect(mockOf(today, 'addFocus')).toHaveBeenCalledWith({ date: '2026-09-28', target });
    expect(await screen.findByText('Tidy the desk added to focus.')).toBeInTheDocument();
  });

  it('stays focusable and says why when the item is already chosen', async () => {
    const today = renderButton([focusActionItem(tidy, { position: 1 })]);
    const button = screen.getByRole('button', { name: 'Add to focus Tidy the desk' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(alreadyInFocusReason);
    button.focus();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(mockOf(today, 'addFocus')).not.toHaveBeenCalled();
  });

  it('says why when the day already holds three', async () => {
    const today = renderButton([
      focusActionItem(outline, { position: 1 }),
      focusActionItem(call, { position: 2 }),
      focusOccurrenceItem(stretch, { position: 3 }),
    ]);
    const button = screen.getByRole('button', { name: 'Add to focus Tidy the desk' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(focusFullReason);
    expect(screen.getByText(focusFullReason)).toBeVisible();
    await userEvent.click(button);
    expect(mockOf(today, 'addFocus')).not.toHaveBeenCalled();
  });

  it('recognizes a chosen Routine Occurrence by its Routine, generation, and date', () => {
    const today = fakeToday();
    render(
      todayTree(
        today,
        <WithRunner>
          {(runner) => (
            <AddToFocusButton
              date={'2026-09-28' as CalendarDate}
              target={{
                kind: 'routine_occurrence',
                occurrence: {
                  routineId: stretch.ref.routineId,
                  generation: 1,
                  period: stretch.ref.period,
                },
              }}
              title="Stretch"
              focus={[focusOccurrenceItem(stretch, { position: 1 })]}
              editable
              runner={runner}
            />
          )}
        </WithRunner>,
      ),
    );
    expect(
      screen.getByRole('button', { name: 'Add to focus Stretch' }),
    ).toHaveAccessibleDescription(alreadyInFocusReason);
  });

  it('shows nothing for an earlier day', () => {
    renderButton([], { editable: false });
    expect(screen.queryByRole('button', { name: /Add to focus/u })).toBeNull();
  });
});

describe('re-exports', () => {
  it('keeps the dialog and the draft editor available from the focus strip module', () => {
    expect(typeof ChooseFocusDialog).toBe('function');
    expect(typeof FocusDraftEditor).toBe('function');
  });
});
