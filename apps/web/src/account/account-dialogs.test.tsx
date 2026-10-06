// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import type { AccountResult, AccountService, SignOutFacts, SyncStatus } from './account-service';
import {
  accountTree,
  deletionPreview,
  done,
  exportFile,
  fakeAccount,
  fakeSync,
  installDownloadStubs,
  ok,
  refused,
  testEmail,
  testPassword,
  type DownloadStubs,
  type FakeSync,
} from './__fixtures__/account-fakes';
import { formatSyncTime } from './sync-text';

let downloads: DownloadStubs;

beforeAll(installDialogPolyfill);
beforeEach(() => {
  downloads = installDownloadStubs();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSignedIn(account: Partial<AccountService>, status: Partial<SyncStatus> = {}) {
  const service = fakeAccount(account);
  const sync = fakeSync({ state: 'synced', account: { email: testEmail }, ...status });
  render(accountTree({ account: service, sync }));
  return { account: service, sync, user: userEvent.setup() };
}

const facts = (overrides: Partial<SignOutFacts> = {}): SignOutFacts => ({
  pendingChanges: 0,
  openConflicts: 0,
  ...overrides,
});
const dialog = () => screen.getByRole('dialog');
/** The page result, not a dialog's own status region. */
const pageResult = (text: string) =>
  screen.findByText(text, { selector: '.account-page > .account-status-region > p' });

describe('Sign out', () => {
  it('shows what waits, offers the export first, and asks for an acknowledgement', async () => {
    const lastSyncedAt = '2026-10-01T07:45:00.000Z';
    const signOut = vi.fn(() => Promise.resolve(done));
    const { user } = renderSignedIn({
      signOutFacts: vi.fn(() =>
        Promise.resolve(facts({ pendingChanges: 3, openConflicts: 1, lastSyncedAt })),
      ),
      signOut,
      exportAccount: vi.fn(() => Promise.resolve(ok(exportFile()))),
    });
    const opener = screen.getByRole('button', { name: 'Sign out' });
    await user.click(opener);
    expect(dialog()).toHaveAccessibleName('Sign out of this account?');
    const lead = within(dialog()).getByText(
      'Signing out locks this account’s plan on this device and opens your local plan. Sign in again to reopen it.',
    );
    expect(lead).toHaveFocus();
    expect(
      await within(dialog()).findByText(
        '3 changes have not synced, and 1 conflict waits for your choice. They stay only on this device until you sign in to this account again.',
      ),
    ).toBeVisible();
    expect(
      within(dialog()).getByText('Changes not yet synced').nextElementSibling,
    ).toHaveTextContent('3');
    expect(within(dialog()).getByText('Conflicts to resolve').nextElementSibling).toHaveTextContent(
      '1',
    );
    expect(within(dialog()).getByText('Last synced').nextElementSibling).toHaveTextContent(
      formatSyncTime(lastSyncedAt) ?? '',
    );
    // Export first, inside the dialog.
    await user.click(within(dialog()).getByRole('button', { name: 'Export account data' }));
    expect(
      await within(dialog()).findByText('Exported 15 records to yelaxis-account-2026-10-01.json.'),
    ).toBeVisible();
    expect(downloads.clicks).toHaveLength(1);
    // Signing out with waiting changes needs the acknowledgement.
    await user.click(within(dialog()).getByRole('button', { name: 'Sign out' }));
    const acknowledgement = within(dialog()).getByRole('checkbox', {
      name: 'I understand. Sign out with changes waiting on this device.',
    });
    await waitFor(() => expect(acknowledgement).toHaveFocus());
    expect(acknowledgement).toHaveAccessibleDescription(
      'To sign out now, confirm that waiting changes stay on this device.',
    );
    expect(signOut).not.toHaveBeenCalled();
    await user.keyboard(' ');
    expect(acknowledgement).toBeChecked();
    await user.click(within(dialog()).getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
    const message = await pageResult('Signed out. Your local plan is open.');
    await waitFor(() => expect(message).toHaveFocus());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('signs out at once when nothing waits', async () => {
    const signOut = vi.fn(() => Promise.resolve(done));
    const { user } = renderSignedIn({
      signOutFacts: vi.fn(() => Promise.resolve(facts())),
      signOut,
    });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await within(dialog()).findByText('Nothing waits to sync.')).toBeVisible();
    expect(within(dialog()).getByText('Last synced').nextElementSibling).toHaveTextContent(
      'Not yet',
    );
    expect(within(dialog()).queryByRole('checkbox')).toBeNull();
    await user.click(within(dialog()).getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(await pageResult('Signed out. Your local plan is open.')).toBeVisible();
  });

  it('still asks for the acknowledgement when what waits cannot be checked', async () => {
    const signOutFacts = vi
      .fn<AccountService['signOutFacts']>()
      .mockRejectedValueOnce(new Error('worker'))
      // The service could not read the facts either: unknown, never "nothing waits".
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(facts());
    const signOut = vi.fn(() => Promise.resolve(done));
    const { user } = renderSignedIn({ signOutFacts, signOut });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await within(dialog()).findByText('What waits to sync could not be checked.'),
    ).toBeVisible();
    expect(
      within(dialog()).getByText(
        'Changes that have not synced stay only on this device until you sign in to this account again.',
      ),
    ).toBeVisible();
    expect(within(dialog()).getByRole('checkbox')).toBeVisible();
    // Check again: the button goes while the facts load, and focus stays on the dialog's lead.
    const lead = within(dialog()).getByText(/^Signing out locks this account’s plan/u);
    await user.click(within(dialog()).getByRole('button', { name: 'Check again' }));
    expect(lead).toHaveFocus();
    expect(
      await within(dialog()).findByText('What waits to sync could not be checked.'),
    ).toBeVisible();
    await user.click(within(dialog()).getByRole('button', { name: 'Sign out' }));
    expect(signOut).not.toHaveBeenCalled();
    await waitFor(() => expect(within(dialog()).getByRole('checkbox')).toHaveFocus());
    await user.click(within(dialog()).getByRole('button', { name: 'Check again' }));
    expect(lead).toHaveFocus();
    expect(await within(dialog()).findByText('Nothing waits to sync.')).toBeVisible();
    expect(within(dialog()).queryByRole('checkbox')).toBeNull();
    expect(signOutFacts).toHaveBeenCalledTimes(3);
  });

  it('keeps a refusal in the dialog, and Cancel or Escape close it without signing out', async () => {
    const signOut = vi.fn(() =>
      Promise.resolve(refused('busy', 'Signing out is not possible right now. Try again.')),
    );
    const { user } = renderSignedIn({
      signOutFacts: vi.fn(() => Promise.resolve(facts())),
      signOut,
    });
    const opener = screen.getByRole('button', { name: 'Sign out' });
    await user.click(opener);
    await within(dialog()).findByText('Nothing waits to sync.');
    await user.click(within(dialog()).getByRole('button', { name: 'Sign out' }));
    const alert = await within(dialog()).findByRole('alert');
    expect(alert).toHaveTextContent('Signing out is not possible right now. Try again.');
    await waitFor(() => expect(alert).toHaveFocus());
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    // Escape reaches the dialog as its cancel event.
    await user.click(opener);
    fireEvent(dialog(), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe('Remove this account from this device', () => {
  it('keeps this device’s copy by default, with what waits, the export, and its acknowledgement', async () => {
    const lastSyncedAt = '2026-10-01T07:45:00.000Z';
    const removeFromDevice = vi.fn<AccountService['removeFromDevice']>(() => Promise.resolve(done));
    const { user } = renderSignedIn({
      signOutFacts: vi.fn(() =>
        Promise.resolve(facts({ pendingChanges: 2, openConflicts: 1, lastSyncedAt })),
      ),
      removeFromDevice,
    });
    await user.click(screen.getByRole('button', { name: 'Remove this account from this device' }));
    expect(dialog()).toHaveAccessibleName('Remove this account from this device?');
    const group = within(dialog()).getByRole('group', {
      name: 'This device’s copy of the account’s plan',
    });
    const keep = within(group).getByRole('radio', { name: 'Keep this device’s copy' });
    expect(keep).toBeChecked();
    expect(keep).toHaveAccessibleDescription(
      'It stays on this device, locked until you sign in to this account again.',
    );
    expect(
      within(group).getByRole('radio', { name: 'Delete this device’s copy' }),
    ).toHaveAccessibleDescription(
      'The copy on this device is deleted. Your account’s data in the cloud stays.',
    );
    // The same facts and export as signing out: keeping the copy is signing out of it.
    expect(
      await within(dialog()).findByText(
        '2 changes have not synced, and 1 conflict waits for your choice. They stay only on this device until you sign in to this account again.',
      ),
    ).toBeVisible();
    expect(
      within(dialog()).getByText('Changes not yet synced').nextElementSibling,
    ).toHaveTextContent('2');
    expect(within(dialog()).getByText('Last synced').nextElementSibling).toHaveTextContent(
      formatSyncTime(lastSyncedAt) ?? '',
    );
    expect(within(dialog()).getByRole('button', { name: 'Export account data' })).toBeVisible();
    // With changes waiting, removing needs the same acknowledgement.
    await user.click(within(dialog()).getByRole('button', { name: 'Remove from this device' }));
    expect(removeFromDevice).not.toHaveBeenCalled();
    const acknowledgement = within(dialog()).getByRole('checkbox', {
      name: 'I understand. Remove this account with changes waiting on this device.',
    });
    await waitFor(() => expect(acknowledgement).toHaveFocus());
    expect(acknowledgement).toHaveAccessibleDescription(
      'To remove the account now, confirm that waiting changes stay on this device.',
    );
    await user.keyboard(' ');
    await user.click(within(dialog()).getByRole('button', { name: 'Remove from this device' }));
    expect(removeFromDevice).toHaveBeenCalledWith({
      deleteLocalCopy: false,
      acceptUnsyncedLoss: false,
    });
    const message = await pageResult(
      'This account was removed from this device. Its copy stays here, locked until you sign in again.',
    );
    await waitFor(() => expect(message).toHaveFocus());
  });

  it('keeps the copy without an acknowledgement when nothing waits', async () => {
    const removeFromDevice = vi.fn<AccountService['removeFromDevice']>(() => Promise.resolve(done));
    const { user } = renderSignedIn({
      signOutFacts: vi.fn(() => Promise.resolve(facts())),
      removeFromDevice,
    });
    await user.click(screen.getByRole('button', { name: 'Remove this account from this device' }));
    expect(await within(dialog()).findByText('Nothing waits to sync.')).toBeVisible();
    expect(within(dialog()).queryByRole('checkbox')).toBeNull();
    await user.click(within(dialog()).getByRole('button', { name: 'Remove from this device' }));
    expect(removeFromDevice).toHaveBeenCalledWith({
      deleteLocalCopy: false,
      acceptUnsyncedLoss: false,
    });
  });

  it('reads again and asks for the acknowledgement when unsynced changes arrive meanwhile', async () => {
    const signOutFacts = vi
      .fn<AccountService['signOutFacts']>()
      .mockResolvedValueOnce(facts())
      .mockResolvedValueOnce(facts({ pendingChanges: 1 }));
    const removeFromDevice = vi
      .fn<AccountService['removeFromDevice']>()
      .mockResolvedValueOnce(
        refused(
          'unsynced_changes',
          'Some changes have not reached your account yet. Export them first, or confirm that they can be lost.',
        ),
      )
      .mockResolvedValueOnce(done);
    const { user } = renderSignedIn({ signOutFacts, removeFromDevice });
    await user.click(screen.getByRole('button', { name: 'Remove this account from this device' }));
    await user.click(within(dialog()).getByRole('radio', { name: 'Delete this device’s copy' }));
    expect(
      await within(dialog()).findByText('Nothing on this device waits to sync.'),
    ).toBeVisible();
    await user.click(within(dialog()).getByRole('button', { name: 'Remove from this device' }));
    const alert = await within(dialog()).findByRole('alert');
    expect(alert).toHaveTextContent(/^Some changes have not reached your account yet\./u);
    await waitFor(() => expect(alert).toHaveFocus());
    // Not a dead end: the facts are read again and the acknowledgement appears.
    const acknowledgement = await within(dialog()).findByRole('checkbox', {
      name: 'Delete this copy with 1 change that has not synced',
    });
    expect(signOutFacts).toHaveBeenCalledTimes(2);
    expect(
      within(dialog()).getByText(
        '1 change on this device has not synced. Deleting this copy deletes it too. Export first to keep a copy.',
      ),
    ).toBeVisible();
    await user.click(acknowledgement);
    await user.click(within(dialog()).getByRole('button', { name: 'Remove from this device' }));
    expect(removeFromDevice).toHaveBeenLastCalledWith({
      deleteLocalCopy: true,
      acceptUnsyncedLoss: true,
    });
  });

  it('Cancel closes without removing anything and returns focus', async () => {
    const removeFromDevice = vi.fn<AccountService['removeFromDevice']>(() => Promise.resolve(done));
    const { user } = renderSignedIn({
      signOutFacts: vi.fn(() => Promise.resolve(facts({ pendingChanges: 1 }))),
      removeFromDevice,
    });
    const opener = screen.getByRole('button', { name: 'Remove this account from this device' });
    await user.click(opener);
    await user.click(within(dialog()).getByRole('radio', { name: 'Delete this device’s copy' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(removeFromDevice).not.toHaveBeenCalled();
    // Opening again starts from the safe default.
    await user.click(opener);
    expect(within(dialog()).getByRole('radio', { name: 'Keep this device’s copy' })).toBeChecked();
  });

  it('deleting the copy with unsynced changes offers the export and needs an acknowledgement', async () => {
    const removeFromDevice = vi.fn<AccountService['removeFromDevice']>(() => Promise.resolve(done));
    const { user } = renderSignedIn({
      signOutFacts: vi.fn(() => Promise.resolve(facts({ pendingChanges: 2 }))),
      removeFromDevice,
      exportAccount: vi.fn(() => Promise.resolve(ok(exportFile({ syncWasPending: true })))),
    });
    await user.click(screen.getByRole('button', { name: 'Remove this account from this device' }));
    // Reading starts at the consequences; Tab reaches the choice, arrow keys move within it.
    expect(
      within(dialog()).getByText(
        'This signs you out of this account in this browser. Your account and its data in the cloud stay, and you can sign in again later.',
      ),
    ).toHaveFocus();
    await within(dialog()).findByText('Changes not yet synced');
    const keep = within(dialog()).getByRole('radio', { name: 'Keep this device’s copy' });
    await user.tab();
    expect(keep).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(
      within(dialog()).getByRole('radio', { name: 'Delete this device’s copy' }),
    ).toBeChecked();
    expect(
      await within(dialog()).findByText(
        '2 changes on this device have not synced. Deleting this copy deletes them too. Export first to keep a copy.',
      ),
    ).toBeVisible();
    const remove = within(dialog()).getByRole('button', { name: 'Remove from this device' });
    expect(remove).toHaveClass('destructive-button');
    await user.click(remove);
    const acknowledgement = within(dialog()).getByRole('checkbox', {
      name: 'Delete this copy with 2 changes that have not synced',
    });
    await waitFor(() => expect(acknowledgement).toHaveFocus());
    expect(acknowledgement).toHaveAccessibleDescription(
      'Confirm that changes that have not synced are deleted, or keep this device’s copy.',
    );
    expect(removeFromDevice).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole('button', { name: 'Export account data' }));
    expect(
      await within(dialog()).findByText(
        'Exported 15 records to yelaxis-account-2026-10-01.json. It includes changes that have not synced yet.',
      ),
    ).toBeVisible();
    await user.click(acknowledgement);
    await user.click(remove);
    expect(removeFromDevice).toHaveBeenCalledWith({
      deleteLocalCopy: true,
      acceptUnsyncedLoss: true,
    });
    expect(
      await pageResult(
        'This account was removed from this device, and this device’s copy was deleted. Your account’s data in the cloud stays.',
      ),
    ).toBeVisible();
  });

  it('deletes the copy without an acknowledgement when nothing waits', async () => {
    const removeFromDevice = vi.fn<AccountService['removeFromDevice']>(() => Promise.resolve(done));
    const { user } = renderSignedIn({
      signOutFacts: vi.fn(() => Promise.resolve(facts())),
      removeFromDevice,
    });
    await user.click(screen.getByRole('button', { name: 'Remove this account from this device' }));
    await user.click(within(dialog()).getByRole('radio', { name: 'Delete this device’s copy' }));
    expect(
      await within(dialog()).findByText('Nothing on this device waits to sync.'),
    ).toBeVisible();
    await user.click(within(dialog()).getByRole('button', { name: 'Remove from this device' }));
    expect(removeFromDevice).toHaveBeenCalledWith({
      deleteLocalCopy: true,
      acceptUnsyncedLoss: false,
    });
  });

  it('asks for the acknowledgement when what waits cannot be checked, and shows a refusal', async () => {
    const removeFromDevice = vi.fn(() =>
      Promise.resolve(refused('locked', 'This account’s copy is in use. Try again.')),
    );
    const { user } = renderSignedIn({
      signOutFacts: vi.fn(() => Promise.reject(new Error('worker'))),
      removeFromDevice,
    });
    await user.click(screen.getByRole('button', { name: 'Remove this account from this device' }));
    // Unknown counts as waiting for either choice.
    expect(
      await within(dialog()).findByRole('checkbox', {
        name: 'I understand. Remove this account with changes waiting on this device.',
      }),
    ).toBeVisible();
    await user.click(within(dialog()).getByRole('radio', { name: 'Delete this device’s copy' }));
    expect(
      within(dialog()).getByText(
        'Changes on this device may not have synced. Any change that has not synced is deleted with this copy. Export first to keep a copy.',
      ),
    ).toBeVisible();
    const acknowledgement = await within(dialog()).findByRole('checkbox', {
      name: 'Delete this copy even if some changes have not synced',
    });
    await user.click(acknowledgement);
    await user.click(within(dialog()).getByRole('button', { name: 'Remove from this device' }));
    const alert = await within(dialog()).findByRole('alert');
    expect(alert).toHaveTextContent('This account’s copy is in use. Try again.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(dialog()).toBeVisible();
  });
});

describe('Delete account', () => {
  async function openDelete(account: Partial<AccountService>, status: Partial<SyncStatus> = {}) {
    const rendered = renderSignedIn(
      { deletionPreview: vi.fn(() => Promise.resolve(ok(deletionPreview()))), ...account },
      status,
    );
    await rendered.user.click(screen.getByRole('button', { name: 'Delete account' }));
    await within(dialog()).findByLabelText('Password');
    return rendered;
  }

  it('shows every scope, deletes this device’s copy by default, and asks for the password and email', async () => {
    const deleteAccount = vi.fn<AccountService['deleteAccount']>(() => Promise.resolve(done));
    const { user } = await openDelete({
      deleteAccount,
      deletionPreview: vi.fn(() => Promise.resolve(ok(deletionPreview({ pendingChanges: 2 })))),
    });
    expect(dialog()).toHaveAccessibleName('Delete your account?');
    const scope = within(dialog());
    // Focus stayed on the lead while the preview loaded, and is still there now.
    expect(scope.getByText('Deleting your account cannot be undone.')).toHaveFocus();
    expect(scope.getByText('This is what it covers.')).toBeVisible();
    expect(scope.getAllByRole('heading', { level: 3 }).map((item) => item.textContent)).toEqual([
      'Cloud data and sign-in account',
      'This device’s copy',
      'Exports outside the app',
      'Provider backups',
    ]);
    expect(
      scope.getByText(
        `Deleted: your account’s planning data in the cloud (42 records) and the sign-in account ${testEmail}.`,
      ),
    ).toBeVisible();
    expect(
      within(scope.getByRole('list', { name: 'Records in the cloud' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Actions: 40', 'Reviews: 2']);
    expect(scope.getByText('41 records on this device. Deleted unless you keep it.')).toBeVisible();
    expect(
      scope.getByText(
        '2 changes on this device have not synced. They are not sent to the account, and they stay only if you keep this device’s copy.',
      ),
    ).toBeVisible();
    expect(
      scope.getByRole('checkbox', { name: 'Keep this device’s copy as a local plan' }),
    ).not.toBeChecked();
    expect(
      scope.getByText(
        'Files you exported or downloaded stay where you saved them. YelAxis Planner cannot delete them; remove them yourself if you no longer want them.',
      ),
    ).toBeVisible();
    expect(
      scope.getByText('The test service this build uses keeps no backups of account data.'),
    ).toBeVisible();
    expect(scope.getByRole('button', { name: 'Export account data' })).toBeVisible();
    // Both fields are required, checked in words, and tied to their errors.
    await user.click(scope.getByRole('button', { name: 'Delete account' }));
    const password = scope.getByLabelText('Password');
    const typed = scope.getByLabelText('Type your account email to confirm');
    expect(password).toHaveAccessibleDescription(
      'Enter your password again to confirm it is you. Enter your password.',
    );
    expect(typed).toHaveAccessibleDescription(
      `Account email: ${testEmail} Type your account email to confirm.`,
    );
    await waitFor(() => expect(password).toHaveFocus());
    await user.type(password, testPassword);
    await user.type(typed, 'someone@example.test');
    await user.click(scope.getByRole('button', { name: 'Delete account' }));
    expect(typed).toHaveAccessibleDescription(
      `Account email: ${testEmail} Type the account email exactly as shown.`,
    );
    await waitFor(() => expect(typed).toHaveFocus());
    expect(deleteAccount).not.toHaveBeenCalled();
    // A check in words keeps the typed password; only a sent attempt clears it.
    expect(password).toHaveValue(testPassword);
    await user.clear(typed);
    await user.type(typed, ` ${testEmail.toUpperCase()} `);
    await user.keyboard('{Enter}');
    expect(deleteAccount).toHaveBeenCalledWith({ password: testPassword, keepLocalCopy: false });
    const message = await pageResult('Your account was deleted, and this device’s copy with it.');
    await waitFor(() => expect(message).toHaveFocus());
    expect(document.body.innerHTML).not.toContain(testPassword);
  });

  it('keeps this device’s copy as a local plan when chosen', async () => {
    const deleteAccount = vi.fn<AccountService['deleteAccount']>(() => Promise.resolve(done));
    const { user } = await openDelete({ deleteAccount });
    const scope = within(dialog());
    await user.click(
      scope.getByRole('checkbox', { name: 'Keep this device’s copy as a local plan' }),
    );
    await user.type(scope.getByLabelText('Password'), testPassword);
    await user.type(scope.getByLabelText('Type your account email to confirm'), testEmail);
    await user.click(scope.getByRole('button', { name: 'Delete account' }));
    expect(deleteAccount).toHaveBeenCalledWith({ password: testPassword, keepLocalCopy: true });
    expect(
      await pageResult('Your account was deleted. This device’s copy is now a local plan.'),
    ).toBeVisible();
  });

  it('keeps a wrong password on the password field and clears it', async () => {
    const { user } = await openDelete({
      deleteAccount: vi.fn(() =>
        Promise.resolve(refused('invalid_credentials', 'That password is not correct.')),
      ),
    });
    const scope = within(dialog());
    const password = scope.getByLabelText('Password');
    await user.type(scope.getByLabelText('Type your account email to confirm'), testEmail);
    await user.type(password, testPassword);
    // Sent with Enter from the password field: focus does not move, so the refusal is announced.
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(password).toHaveAccessibleDescription(
        'Enter your password again to confirm it is you. That password is not correct.',
      ),
    );
    expect(password).toHaveFocus();
    expect(scope.getByRole('alert')).toHaveTextContent('That password is not correct.');
    expect(password).toHaveValue('');
    expect(dialog()).toBeVisible();
  });

  it('a recoverable failure becomes deletion pending, and its alert takes focus once the dialog closed', async () => {
    // A modal dialog makes the rest of the page inert: focus outside it does nothing until it
    // closes (jsdom does not model this, so focus is refused here as a browser refuses it).
    const focus = Reflect.get(HTMLElement.prototype, 'focus');
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      const open = document.querySelector('dialog[open]');
      if (open !== null && !open.contains(this)) return;
      focus.call(this, options);
    });
    // The service moves the status to deletion pending before it answers.
    const box: { sync: FakeSync | null } = { sync: null };
    const deleteAccount = vi.fn((): Promise<AccountResult> => {
      box.sync?.set({ state: 'deletion_pending' });
      return Promise.resolve(
        refused(
          'unavailable',
          'The account could not be deleted right now. Your plan on this device is kept; try again.',
        ),
      );
    });
    const rendered = await openDelete({ deleteAccount });
    box.sync = rendered.sync;
    const scope = within(dialog());
    await rendered.user.type(scope.getByLabelText('Password'), testPassword);
    await rendered.user.type(scope.getByLabelText('Type your account email to confirm'), testEmail);
    await act(async () => {
      await rendered.user.click(scope.getByRole('button', { name: 'Delete account' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Account deletion is pending' }),
    ).toBeVisible();
    // The dialog's opener (Delete account) is gone with the danger zone.
    expect(screen.queryByRole('button', { name: 'Delete account' })).toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'The account could not be deleted right now. Your plan on this device is kept; try again.',
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Retry deletion' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel deletion' })).toBeVisible();
  });

  it('says what is known about provider backups for the service this build uses', async () => {
    await openDelete({}, {});
    expect(
      within(dialog()).getByText(
        'The test service this build uses keeps no backups of account data.',
      ),
    ).toBeVisible();
    cleanup();
    // Any other service: no claim before its retention is documented.
    await openDelete({ localTestService: false });
    expect(within(dialog()).queryByText(/keeps no backups/u)).toBeNull();
    expect(
      within(dialog()).getByText(
        'Whether the account service this build uses keeps backups of account data, and for how long, is not documented here yet. YelAxis Planner cannot delete such backups.',
      ),
    ).toBeVisible();
  });

  it('offers Try again when the preview cannot be loaded, and Cancel closes', async () => {
    const preview = vi
      .fn<AccountService['deletionPreview']>()
      .mockResolvedValueOnce(
        refused('offline', 'You are offline. Deleting the account needs a connection.'),
      )
      .mockResolvedValueOnce(ok(deletionPreview()));
    const { user } = renderSignedIn({ deletionPreview: preview });
    const opener = screen.getByRole('button', { name: 'Delete account' });
    await user.click(opener);
    const alert = await within(dialog()).findByRole('alert');
    expect(alert).toHaveTextContent('You are offline. Deleting the account needs a connection.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    // The button goes while the preview loads again; focus stays on the dialog's lead.
    const lead = within(dialog()).getByText(/^(Checking what deleting|Deleting your account)/u);
    expect(lead).toHaveFocus();
    expect(await within(dialog()).findByLabelText('Password')).toBeVisible();
    expect(lead).toHaveFocus();
    expect(lead).toHaveTextContent('Deleting your account cannot be undone.');
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});
