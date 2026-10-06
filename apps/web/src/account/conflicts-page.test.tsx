// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import type { AccountResult, ConflictService, ConflictSummaryView } from './account-service';
import {
  accountTree,
  conflictDetail,
  conflictId,
  conflictSummary,
  done,
  fakeAccount,
  fakeConflicts,
  fakeSync,
  refused,
  testEmail,
} from './__fixtures__/account-fakes';
import { formatSyncTime } from './sync-text';

beforeAll(installDialogPolyfill);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderConflicts(path: string, conflicts: Partial<ConflictService>) {
  const service = fakeConflicts(conflicts);
  const sync = fakeSync({
    state: 'needs_attention',
    account: { email: testEmail },
    openConflicts: 1,
  });
  render(accountTree({ path, account: fakeAccount(), sync, conflicts: service }));
  return { conflicts: service, sync, user: userEvent.setup() };
}

const location = () => screen.getByTestId('location').textContent;
const h1s = () => screen.getAllByRole('heading', { level: 1 });

describe('Conflicts list', () => {
  it('lists each open conflict with its kind in words and a link to it', async () => {
    const items: readonly ConflictSummaryView[] = [
      conflictSummary(),
      conflictSummary({
        conflictId: conflictId(2),
        kind: 'delete_versus_edit',
        kindLabel: 'Outcome',
        title: 'Run a half marathon',
      }),
    ];
    renderConflicts('/account/conflicts', { list: vi.fn(() => Promise.resolve(items)) });
    expect(screen.getByRole('heading', { level: 1, name: 'Conflicts' })).toBeVisible();
    expect(screen.getByText('Opening conflicts…')).toBeVisible();
    const list = await screen.findByRole('list', { name: 'Open conflicts' });
    expect(h1s()).toHaveLength(1);
    expect(
      screen.getByText(
        'A conflict means a record changed on this device and on the other device in different ways. Nothing is overwritten until you choose, and other changes keep syncing.',
      ),
    ).toBeVisible();
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: 'Draft the outline' }),
    ).toHaveAttribute('href', `/account/conflicts/${conflictId(1)}`);
    expect(
      within(rows[0] as HTMLElement).getByText(
        'Action · Changed on this device and on the other device.',
      ),
    ).toBeVisible();
    expect(
      within(rows[0] as HTMLElement).getByText(
        `Found ${formatSyncTime('2026-10-01T09:30:00.000Z') ?? ''}.`,
      ),
    ).toBeVisible();
    expect(
      within(rows[1] as HTMLElement).getByText(
        'Outcome · Deleted on this device and edited on the other device.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Account' })).toHaveAttribute(
      'href',
      '/account',
    );
  });

  it('says calmly when nothing needs a choice, and offers Try again after a failed read', async () => {
    const list = vi
      .fn<ConflictService['list']>()
      .mockRejectedValueOnce(new Error('worker'))
      .mockResolvedValueOnce([]);
    const { user } = renderConflicts('/account/conflicts', { list });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Conflicts could not be read. Your plan was not changed.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    // The button goes while the list loads again: focus stays on the page's heading.
    const heading = screen.getByRole('heading', { level: 1, name: 'Conflicts' });
    expect(heading).toHaveFocus();
    expect(await screen.findByText('No conflicts need your choice.')).toBeVisible();
    expect(heading).toHaveFocus();
  });

  it('reads the list again when the number of open conflicts changes', async () => {
    const list = vi
      .fn<ConflictService['list']>()
      .mockResolvedValueOnce([conflictSummary()])
      .mockResolvedValueOnce([]);
    const { sync } = renderConflicts('/account/conflicts', { list });
    await screen.findByRole('link', { name: 'Draft the outline' });
    act(() => sync.set({ openConflicts: 0, state: 'synced' }));
    expect(await screen.findByText('No conflicts need your choice.')).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('Conflict detail', () => {
  it('compares this device, the other device, and before in a table', async () => {
    renderConflicts(`/account/conflicts/${conflictId(1)}`, {
      get: vi.fn(() => Promise.resolve(conflictDetail())),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Draft the outline' }),
    ).toBeVisible();
    expect(h1s()).toHaveLength(1);
    expect(screen.getByText('Conflict · Action')).toBeVisible();
    expect(
      screen.getByText(
        'Changed on this device and on the other device. Nothing changes until you choose.',
      ),
    ).toBeVisible();
    const table = screen.getByRole('table', { name: 'Versions of Draft the outline' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Detail', 'This device', 'The other device', 'Before']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ['Draft the outline', 'Outline the draft', 'Draft outline'],
      ['Oct 3, 2026', 'Not set', 'Oct 2, 2026'],
    ]);
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Title', 'Due date']);
    // The table scrolls inside a named region a keyboard can reach.
    expect(screen.getByRole('region', { name: 'Versions of Draft the outline' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Keep this device’s version',
      'Keep the other version',
      'Merge details',
    ]);
    expect(
      screen.getByRole('button', { name: 'Keep the other version' }),
    ).toHaveAccessibleDescription(
      'The other version is kept here too. The change made on this device is not used.',
    );
  });

  it('resolves with a choice, then returns to the list with a status that receives focus', async () => {
    const resolve = vi.fn<ConflictService['resolve']>(() => Promise.resolve(done));
    const list = vi.fn<ConflictService['list']>(() => Promise.resolve([]));
    const { user } = renderConflicts(`/account/conflicts/${conflictId(1)}`, {
      get: vi.fn(() => Promise.resolve(conflictDetail())),
      resolve,
      list,
    });
    await user.click(await screen.findByRole('button', { name: 'Keep this device’s version' }));
    expect(resolve).toHaveBeenCalledWith(conflictId(1), { choice: 'keep_local' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Conflicts' })).toBeVisible();
    expect(location()).toBe('/account/conflicts');
    const message = await screen.findByText(
      'Conflict resolved for Draft the outline: kept this device’s version.',
    );
    await waitFor(() => expect(message).toHaveFocus());
    expect(message.closest('[role="status"]')).not.toBeNull();
    expect(await screen.findByText('No conflicts need your choice.')).toBeVisible();
  });

  it('keeps the other version through the keyboard', async () => {
    const resolve = vi.fn<ConflictService['resolve']>(() => Promise.resolve(done));
    const { user } = renderConflicts(`/account/conflicts/${conflictId(1)}`, {
      get: vi.fn(() => Promise.resolve(conflictDetail())),
      resolve,
      list: vi.fn(() => Promise.resolve([])),
    });
    const button = await screen.findByRole('button', { name: 'Keep the other version' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(resolve).toHaveBeenCalledWith(conflictId(1), { choice: 'keep_remote' });
    expect(
      await screen.findByText('Conflict resolved for Draft the outline: kept the other version.'),
    ).toBeVisible();
  });

  it('offers Keep it deleted and Restore the edited version for delete versus edit', async () => {
    const resolve = vi.fn<ConflictService['resolve']>(() => Promise.resolve(done));
    const { user } = renderConflicts(`/account/conflicts/${conflictId(3)}`, {
      get: vi.fn(() =>
        Promise.resolve(
          conflictDetail({
            conflictId: conflictId(3),
            kind: 'delete_versus_edit',
            title: 'Call the bank',
            fields: [
              { field: 'title', label: 'Title', base: 'Call bank', remote: 'Call the bank' },
            ],
            choices: ['keep_deleted', 'restore_edited'],
          }),
        ),
      ),
      resolve,
      list: vi.fn(() => Promise.resolve([])),
    });
    await screen.findByRole('heading', { level: 1, name: 'Call the bank' });
    expect(
      screen.getByText(
        'Deleted on this device and edited on the other device. Nothing changes until you choose.',
      ),
    ).toBeVisible();
    const row = screen.getByRole('rowheader', { name: 'Title' }).closest('tr') as HTMLElement;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['Deleted', 'Call the bank', 'Call bank']);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Keep it deleted',
      'Restore the edited version',
    ]);
    await user.click(screen.getByRole('button', { name: 'Restore the edited version' }));
    expect(resolve).toHaveBeenCalledWith(conflictId(3), { choice: 'restore_edited' });
    expect(
      await screen.findByText('Conflict resolved for Call the bank: restored the edited version.'),
    ).toBeVisible();
  });

  it('merges details with a version chosen for every detail', async () => {
    const resolve = vi.fn<ConflictService['resolve']>(() => Promise.resolve(done));
    const { user } = renderConflicts(`/account/conflicts/${conflictId(1)}`, {
      get: vi.fn(() => Promise.resolve(conflictDetail())),
      resolve,
      list: vi.fn(() => Promise.resolve([])),
    });
    await user.click(await screen.findByRole('button', { name: 'Merge details' }));
    const heading = screen.getByRole('heading', { level: 2, name: 'Merge details' });
    await waitFor(() => expect(heading).toHaveFocus());
    const merge = screen.getByRole('form', { name: 'Merge details' });
    const title = within(merge).getByRole('group', { name: 'Title' });
    const due = within(merge).getByRole('group', { name: 'Due date' });
    expect(
      within(title)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['This device: Draft the outline', 'The other device: Outline the draft']);
    expect(
      within(due)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['This device: Oct 3, 2026', 'The other device: Not set']);
    // Nothing is chosen for the person: each detail needs a choice.
    await user.click(within(merge).getByRole('button', { name: 'Save merged version' }));
    expect(resolve).not.toHaveBeenCalled();
    expect(title).toHaveAccessibleDescription('Choose a version of Title.');
    expect(due).toHaveAccessibleDescription('Choose a version of Due date.');
    const firstTitle = within(title).getByRole('radio', { name: 'This device: Draft the outline' });
    await waitFor(() => expect(firstTitle).toHaveFocus());
    // The keyboard chooses: arrow keys move within a detail's two versions.
    await user.keyboard('{ArrowDown}');
    expect(
      within(title).getByRole('radio', { name: 'The other device: Outline the draft' }),
    ).toBeChecked();
    expect(title).not.toHaveAccessibleDescription();
    await user.click(within(due).getByRole('radio', { name: 'This device: Oct 3, 2026' }));
    await user.click(within(merge).getByRole('button', { name: 'Save merged version' }));
    expect(resolve).toHaveBeenCalledWith(conflictId(1), {
      choice: 'merge',
      fields: { title: 'remote', due: 'local' },
    });
    expect(
      await screen.findByText('Conflict resolved for Draft the outline: saved the merged version.'),
    ).toBeVisible();
  });

  it('Cancel merge returns to the choices with focus on Merge details', async () => {
    const { user } = renderConflicts(`/account/conflicts/${conflictId(1)}`, {
      get: vi.fn(() => Promise.resolve(conflictDetail())),
    });
    await user.click(await screen.findByRole('button', { name: 'Merge details' }));
    await user.click(screen.getByRole('button', { name: 'Cancel merge' }));
    const button = screen.getByRole('button', { name: 'Merge details' });
    await waitFor(() => expect(button).toHaveFocus());
    expect(screen.queryByRole('form', { name: 'Merge details' })).toBeNull();
  });

  it('keeps the conflict open with the reason when a choice is refused', async () => {
    let settle: (value: AccountResult) => void = () => undefined;
    const resolve = vi.fn<ConflictService['resolve']>(
      () =>
        new Promise((resolveWith) => {
          settle = resolveWith;
        }),
    );
    const { user } = renderConflicts(`/account/conflicts/${conflictId(1)}`, {
      get: vi.fn(() => Promise.resolve(conflictDetail())),
      resolve,
    });
    await user.click(await screen.findByRole('button', { name: 'Keep the other version' }));
    const busy = screen.getByRole('button', { name: 'Saving…' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    for (const button of screen.getAllByRole('button'))
      expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Keep this device’s version' }));
    expect(resolve).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle(
        refused(
          'superseded',
          'This record changed again on the other device. The latest versions are shown; choose again.',
        ),
      );
      await Promise.resolve();
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This record changed again on the other device. The latest versions are shown; choose again.',
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(location()).toBe(`/account/conflicts/${conflictId(1)}`);
  });

  it('says calmly when a change is still on its way, and the choice can be made again later', async () => {
    const resolve = vi
      .fn<ConflictService['resolve']>()
      .mockResolvedValueOnce(
        refused(
          'not_ready',
          'A change to this item is still on its way to your account. Try again after the next sync.',
        ),
      )
      .mockResolvedValueOnce(done);
    const { user } = renderConflicts(`/account/conflicts/${conflictId(1)}`, {
      get: vi.fn(() => Promise.resolve(conflictDetail())),
      resolve,
    });
    await user.click(await screen.findByRole('button', { name: 'Keep this device’s version' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'A change to this item is still on its way to your account. Try again after the next sync.',
    );
    await waitFor(() => expect(alert).toHaveFocus());
    // Nothing is chosen for the person; the same choice works once the change has arrived.
    const keep = screen.getByRole('button', { name: 'Keep this device’s version' });
    expect(keep).not.toHaveAttribute('aria-disabled');
    await user.click(keep);
    expect(resolve).toHaveBeenLastCalledWith(conflictId(1), { choice: 'keep_local' });
    expect(await screen.findByText(/^Conflict resolved for Draft the outline/u)).toBeVisible();
  });

  it('says calmly when a conflict is not open, and when it cannot be read', async () => {
    renderConflicts(`/account/conflicts/${conflictId(9)}`, {
      get: vi.fn(() => Promise.resolve(null)),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This conflict is not open' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'It may have been resolved already, or the link is incomplete. Your plan was not changed.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to conflicts' })).toHaveAttribute(
      'href',
      '/account/conflicts',
    );
    cleanup();
    const get = vi
      .fn<ConflictService['get']>()
      .mockRejectedValueOnce(new Error('worker'))
      .mockResolvedValueOnce(conflictDetail());
    const { user } = renderConflicts(`/account/conflicts/${conflictId(1)}`, { get });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This conflict could not be read. Your plan was not changed.');
    const heading = screen.getByRole('heading', { level: 1, name: 'Conflict' });
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    // Focus moves to the page's heading, which stays the same element as the conflict arrives.
    expect(heading).toHaveFocus();
    expect(await screen.findByRole('heading', { level: 1, name: 'Draft the outline' })).toBe(
      heading,
    );
    expect(heading).toHaveFocus();
  });

  it('shows an unknown account path calmly', () => {
    renderConflicts('/account/elsewhere', {});
    expect(
      screen.getByRole('heading', { level: 1, name: 'This page is not available' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Account' })).toHaveAttribute('href', '/account');
  });
});
