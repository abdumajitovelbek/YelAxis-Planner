// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import type {
  AccountResult,
  AccountService,
  ConflictService,
  SignInOutcome,
  SyncStatus,
} from './account-service';
import {
  accountTree,
  done,
  exportFile,
  fakeAccount,
  fakeConflicts,
  fakeSync,
  installDownloadStubs,
  mockOf,
  ok,
  refused,
  setOnline,
  statusOf,
  testEmail,
  testPassword,
  uploadPreview,
  type DownloadStubs,
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
  setOnline(true);
});

function renderAccount(
  options: {
    readonly path?: string;
    readonly account?: Partial<AccountService>;
    readonly status?: Partial<SyncStatus>;
    readonly conflicts?: Partial<ConflictService>;
  } = {},
) {
  const account = fakeAccount(options.account);
  const sync = fakeSync(options.status);
  const conflicts = fakeConflicts(options.conflicts);
  render(accountTree({ path: options.path ?? '/account', account, sync, conflicts }));
  return { account, sync, conflicts, user: userEvent.setup() };
}

const signedIn = (overrides: Partial<SyncStatus> = {}): Partial<SyncStatus> => ({
  state: 'synced',
  account: { email: testEmail },
  ...overrides,
});
const h1s = () => screen.getAllByRole('heading', { level: 1 });
const form = (name: 'Sign in' | 'Create account') => screen.getByRole('form', { name });
const status = () => screen.getAllByRole('status').find((item) => item.textContent !== '');

/** A promise the test settles by hand. */
function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('Account: a build without accounts', () => {
  it('says calmly that accounts are not available, on every account path', () => {
    renderAccount({ account: { configured: false } });
    expect(h1s()).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    expect(
      screen.getByText(
        'Account sync is not available in this build. Your plan stays on this device.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.queryByRole('form')).toBeNull();
    cleanup();
    renderAccount({ account: { configured: false }, path: '/account/conflicts' });
    expect(
      screen.getByText(
        'Account sync is not available in this build. Your plan stays on this device.',
      ),
    ).toBeVisible();
  });

  it('says the same without the account provider', () => {
    render(accountTree({ withoutProvider: true }));
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    expect(screen.getByText(/Account sync is not available in this build\./u)).toBeVisible();
  });
});

describe('Account: signed out', () => {
  it('offers Sign in and Create account with labelled fields and a calm explanation', () => {
    renderAccount();
    expect(h1s()).toHaveLength(1);
    expect(
      screen.getByText(
        'An account is optional. Signing in syncs your plan between the browsers where you use YelAxis Planner. Without one, your plan keeps working on this device.',
      ),
    ).toBeVisible();
    expect(screen.getByText(/nothing is uploaded before you choose/u)).toBeVisible();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Sign in', 'Create account']);
    for (const name of ['Sign in', 'Create account'] as const) {
      const scope = within(form(name));
      expect(scope.getByLabelText('Email')).toHaveAttribute('type', 'email');
      expect(scope.getByLabelText('Password')).toHaveAttribute('type', 'password');
      expect(scope.getByRole('button', { name })).toHaveAttribute('type', 'submit');
    }
    expect(within(form('Sign in')).getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    expect(within(form('Create account')).getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    // Input purposes are programmatic (WCAG 2.2 SC 1.3.5), so password managers find the fields.
    expect(within(form('Sign in')).getByLabelText('Email')).toHaveAttribute(
      'autocomplete',
      'username',
    );
    expect(within(form('Create account')).getByLabelText('Email')).toHaveAttribute(
      'autocomplete',
      'email',
    );
    // A form never sends its fields in a URL.
    expect(form('Sign in')).toHaveAttribute('method', 'post');
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('checks the fields in words, ties each error to its field, and focuses the first problem', async () => {
    const { account, user } = renderAccount();
    const scope = within(form('Sign in'));
    await user.click(scope.getByRole('button', { name: 'Sign in' }));
    const email = scope.getByLabelText('Email');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription('Enter your email address.');
    expect(scope.getByLabelText('Password')).toHaveAccessibleDescription('Enter your password.');
    await waitFor(() => expect(email).toHaveFocus());
    await user.type(email, 'sam at example');
    await user.click(scope.getByRole('button', { name: 'Sign in' }));
    expect(email).toHaveAccessibleDescription('Enter an email address like name@example.com.');
    await user.clear(email);
    await user.type(email, testEmail);
    await user.click(scope.getByRole('button', { name: 'Sign in' }));
    const password = scope.getByLabelText('Password');
    expect(email).not.toHaveAttribute('aria-invalid');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(password).toHaveFocus());
    expect(mockOf(account, 'signIn')).not.toHaveBeenCalled();
    // Create account asks to choose a password.
    const create = within(form('Create account'));
    await user.type(create.getByLabelText('Email'), testEmail);
    await user.click(create.getByRole('button', { name: 'Create account' }));
    expect(create.getByLabelText('Password')).toHaveAccessibleDescription('Choose a password.');
    expect(mockOf(account, 'signUp')).not.toHaveBeenCalled();
  });

  it('signs in with the keyboard and reports the open account, never keeping the password', async () => {
    const signIn = deferred<AccountResult<SignInOutcome>>();
    const { account, sync, user } = renderAccount({
      account: { signIn: vi.fn(() => signIn.promise) },
    });
    const scope = within(form('Sign in'));
    await user.type(scope.getByLabelText('Email'), `  ${testEmail} `);
    await user.type(scope.getByLabelText('Password'), testPassword);
    await user.keyboard('{Enter}');
    expect(mockOf(account, 'signIn')).toHaveBeenCalledWith(testEmail, testPassword);
    const busy = scope.getByRole('button', { name: 'Signing in…' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    await user.click(busy);
    expect(mockOf(account, 'signIn')).toHaveBeenCalledTimes(1);
    await act(async () => {
      signIn.resolve(ok({ kind: 'opened_account' }));
      await signIn.promise;
    });
    const message = await screen.findByText(
      `Signed in as ${testEmail}. Your account’s plan is open.`,
    );
    await waitFor(() => expect(message).toHaveFocus());
    expect(scope.getByLabelText('Password')).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(testPassword);
    expect(screen.getByTestId('location')).toHaveTextContent('/account');
    // The account's plan opens: the page follows the status.
    act(() => sync.set(signedIn()));
    expect(screen.getByText(`Signed in as ${testEmail}.`)).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Sign in' })).toBeNull();
    expect(message).toBeInTheDocument();
  });

  it('shows a refusal on the field it belongs to, or for the whole form', async () => {
    const signIn = vi
      .fn<AccountService['signIn']>()
      .mockResolvedValueOnce(
        refused('invalid_credentials', 'That email and password do not match.'),
      )
      .mockResolvedValueOnce(refused('invalid_email', 'That email address cannot be used.'));
    const signUp = vi
      .fn<AccountService['signUp']>()
      .mockResolvedValue(refused('weak_password', 'Choose a longer password.'));
    const { user } = renderAccount({ account: { signIn, signUp } });
    const scope = within(form('Sign in'));
    await user.type(scope.getByLabelText('Email'), testEmail);
    await user.type(scope.getByLabelText('Password'), testPassword);
    await user.click(scope.getByRole('button', { name: 'Sign in' }));
    const alert = await scope.findByRole('alert');
    expect(alert).toHaveTextContent('That email and password do not match.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(scope.getByLabelText('Password')).toHaveValue('');
    await user.type(scope.getByLabelText('Password'), testPassword);
    await user.click(scope.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(scope.getByLabelText('Email')).toHaveAccessibleDescription(
        'That email address cannot be used.',
      ),
    );
    expect(scope.getByLabelText('Email')).toHaveFocus();
    // An email refusal keeps the typed password.
    expect(scope.getByLabelText('Password')).toHaveValue(testPassword);
    // The refusal is announced as it appears, and it is the email field's own error.
    const emailAlert = scope.getByRole('alert');
    expect(emailAlert).toHaveTextContent('That email address cannot be used.');
    expect(scope.getByLabelText('Email')).toHaveAttribute('aria-describedby', emailAlert.id);
    const create = within(form('Create account'));
    await user.type(create.getByLabelText('Email'), testEmail);
    await user.type(create.getByLabelText('Password'), 'short');
    // Sent with Enter from the password field: focus stays there, so the alert speaks.
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(create.getByLabelText('Password')).toHaveAccessibleDescription(
        'Choose a longer password.',
      ),
    );
    expect(create.getByLabelText('Password')).toHaveFocus();
    expect(create.getByRole('alert')).toHaveTextContent('Choose a longer password.');
  });

  it('announces each submission’s field errors anew, even when they repeat', async () => {
    const { user } = renderAccount();
    const scope = within(form('Sign in'));
    await user.click(scope.getByRole('button', { name: 'Sign in' }));
    const first = scope.getAllByRole('alert');
    expect(first.map((item) => item.textContent)).toEqual([
      'Enter your email address.',
      'Enter your password.',
    ]);
    await user.keyboard('{Enter}');
    const again = scope.getAllByRole('alert');
    expect(again.map((item) => item.textContent)).toEqual([
      'Enter your email address.',
      'Enter your password.',
    ]);
    // New elements, so assistive technology announces them again.
    expect(again[0]).not.toBe(first[0]);
  });

  it('turns an unexpected failure into calm words that keep the local plan', async () => {
    const { user } = renderAccount({
      account: { signIn: vi.fn(() => Promise.reject(new Error('network'))) },
    });
    const scope = within(form('Sign in'));
    await user.type(scope.getByLabelText('Email'), testEmail);
    await user.type(scope.getByLabelText('Password'), testPassword);
    await user.click(scope.getByRole('button', { name: 'Sign in' }));
    expect(await scope.findByRole('alert')).toHaveTextContent(
      'Signing in did not finish. Your local plan was not changed; try again.',
    );
  });

  it('keeps the forms while a sign-in is in progress elsewhere', () => {
    renderAccount({ status: { state: 'signing_in' } });
    expect(form('Sign in')).toBeVisible();
    expect(form('Create account')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('says when offline that signing in needs a connection, and keeps the forms usable', () => {
    setOnline(false);
    renderAccount();
    expect(
      screen.getByText(
        'You are offline. Signing in needs a connection; your local plan keeps working.',
      ),
    ).toBeVisible();
    for (const button of screen.getAllByRole('button')) expect(button).toBeEnabled();
  });

  it('creates an account and opens the first-upload choice when this device has a plan', async () => {
    const signUp = vi.fn<AccountService['signUp']>(() =>
      Promise.resolve(ok({ kind: 'choose_first_upload', preview: uploadPreview() })),
    );
    const { user } = renderAccount({ account: { signUp } });
    const create = within(form('Create account'));
    await user.type(create.getByLabelText('Email'), testEmail);
    await user.type(create.getByLabelText('Password'), testPassword);
    await user.click(create.getByRole('button', { name: 'Create account' }));
    expect(signUp).toHaveBeenCalledWith(testEmail, testPassword);
    const question = await screen.findByRole('heading', {
      level: 2,
      name: 'Upload this plan to your account?',
    });
    await waitFor(() => expect(question).toHaveFocus());
    expect(screen.getByText(`Signed in as ${testEmail}.`)).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });
});

describe('Account: the first upload', () => {
  async function choose(preview = uploadPreview(), account: Partial<AccountService> = {}) {
    const rendered = renderAccount({
      account: {
        signIn: vi.fn(() => Promise.resolve(ok({ kind: 'choose_first_upload' as const, preview }))),
        ...account,
      },
    });
    const scope = within(form('Sign in'));
    await rendered.user.type(scope.getByLabelText('Email'), testEmail);
    await rendered.user.type(scope.getByLabelText('Password'), testPassword);
    await rendered.user.click(scope.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { level: 2, name: 'Upload this plan to your account?' });
    return rendered;
  }

  it('shows the counts by kind, an empty account, no sensitive entries, and the backup first', async () => {
    const { account } = await choose();
    expect(
      screen.getByText(
        `Signed in as ${testEmail}. This device already has a plan. Nothing is uploaded until you choose.`,
      ),
    ).toBeVisible();
    expect(screen.getByText('This plan has 15 records.')).toBeVisible();
    const counts = screen.getByRole('list', { name: 'Records on this device' });
    expect(
      within(counts)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Actions: 12', 'Outcomes: 2', 'Routines: 1']);
    expect(screen.getByText('Your account has no planning data yet.')).toBeVisible();
    expect(screen.getByText('No sensitive Context entries are included.')).toBeVisible();
    expect(
      screen.getByText(
        'Before anything is uploaded, YelAxis Planner makes a backup of this plan and checks it. You can download the backup once the upload starts.',
      ),
    ).toBeVisible();
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['On this device', 'In your account', 'Sensitive Context', 'Backup first']);
    expect(screen.getByRole('button', { name: 'Upload this plan' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Keep this plan on this device' })).toBeVisible();
    // Nothing starts before a choice.
    expect(mockOf(account, 'startFirstUpload')).not.toHaveBeenCalled();
    expect(mockOf(account, 'declineFirstUpload')).not.toHaveBeenCalled();
  });

  it('says when the account already has data and which sensitive entries upload', async () => {
    await choose(uploadPreview({ cloudRecordCount: 42, sensitiveContextCount: 2 }));
    expect(
      screen.getByText(
        'Your account already has 42 records. Uploading adds this plan’s records to them. If a record is in both and differs, you choose which version to keep.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        '2 sensitive Context entries are included. They upload with this plan and sync with your account.',
      ),
    ).toBeVisible();
  });

  it('makes the backup first, then shows progress, Cancel upload, and the backup link', async () => {
    const start = deferred<AccountResult>();
    const backup = exportFile({ fileName: 'yelaxis-backup-2026-10-01.json' });
    const { account, sync, user } = await choose(uploadPreview(), {
      startFirstUpload: vi.fn(() => start.promise),
      latestBackup: vi.fn(() => Promise.resolve(backup)),
    });
    await user.click(screen.getByRole('button', { name: 'Upload this plan' }));
    expect(screen.getByRole('button', { name: 'Making a backup…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await act(async () => {
      start.resolve(done);
      await start.promise;
    });
    const message = await screen.findByText('Backup made. This plan is uploading to your account.');
    await waitFor(() => expect(message).toHaveFocus());
    expect(mockOf(account, 'startFirstUpload')).toHaveBeenCalledTimes(1);
    // The status has not caught up yet: the upload already reads as started.
    expect(screen.getByRole('heading', { level: 2, name: 'Uploading this plan' })).toBeVisible();
    expect(screen.getByText('Starting the upload…')).toBeVisible();
    const link = await screen.findByRole('link', { name: 'Download the backup' });
    expect(link).toHaveAttribute('download', 'yelaxis-backup-2026-10-01.json');
    expect(link.getAttribute('href')).toMatch(/^blob:/u);
    expect(screen.getByText('(yelaxis-backup-2026-10-01.json, 15 records)')).toBeVisible();
    act(() =>
      sync.set(signedIn({ state: 'first_upload', firstUpload: { uploaded: 3, total: 15 } })),
    );
    const progress = screen.getByLabelText('Upload progress');
    expect(progress).toHaveAttribute('value', '3');
    expect(progress).toHaveAttribute('max', '15');
    expect(screen.getByText('3 of 15 records uploaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel upload' })).toBeVisible();
    expect(downloads.createObjectURL).toHaveBeenCalledWith(backup.blob);
  });

  it('Keep this plan on this device uploads nothing', async () => {
    const { account, user } = await choose(uploadPreview(), {
      declineFirstUpload: vi.fn(() => Promise.resolve(done)),
    });
    await user.click(screen.getByRole('button', { name: 'Keep this plan on this device' }));
    const message = await screen.findByText(
      'This plan stays on this device, unchanged. Your account’s own plan is open.',
    );
    await waitFor(() => expect(message).toHaveFocus());
    expect(mockOf(account, 'startFirstUpload')).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Upload this plan to your account?' })).toBeNull();
  });

  it('Cancel sign-in backs out at the choice, uploading nothing and keeping this plan', async () => {
    const cancelFirstUpload = vi
      .fn<AccountService['cancelFirstUpload']>()
      .mockResolvedValueOnce(refused('storage', 'This device’s plan could not be read.'))
      .mockResolvedValueOnce(done);
    const { account, user } = await choose(uploadPreview(), { cancelFirstUpload });
    const cancel = screen.getByRole('button', { name: 'Cancel sign-in' });
    expect(cancel).toHaveAccessibleDescription(
      'Cancel sign-in: you are signed out, nothing is uploaded, and this plan stays open exactly as it is.',
    );
    await user.click(cancel);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This device’s plan could not be read.');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Upload this plan to your account?' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    const message = await screen.findByText(
      'Sign-in canceled. Nothing was uploaded, and this plan stays on this device.',
    );
    await waitFor(() => expect(message).toHaveFocus());
    expect(cancelFirstUpload).toHaveBeenCalledTimes(2);
    expect(mockOf(account, 'startFirstUpload')).not.toHaveBeenCalled();
    expect(mockOf(account, 'declineFirstUpload')).not.toHaveBeenCalled();
    // Back to the forms: the local plan is open, as before signing in.
    expect(form('Sign in')).toBeVisible();
  });

  it('keeps the choice with the reason when the upload does not start', async () => {
    const { user } = await choose(uploadPreview(), {
      startFirstUpload: vi.fn(() =>
        Promise.resolve(
          refused('backup_unverified', 'The backup could not be checked. Nothing was uploaded.'),
        ),
      ),
    });
    await user.click(screen.getByRole('button', { name: 'Upload this plan' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The backup could not be checked. Nothing was uploaded.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Upload this plan' })).toBeVisible();
  });

  it('cancels a running upload and keeps every record, or says why it could not', async () => {
    const cancelFirstUpload = vi
      .fn<AccountService['cancelFirstUpload']>()
      .mockResolvedValueOnce(refused('linked', 'The upload already finished. Nothing changed.'))
      .mockResolvedValueOnce(done);
    const { user } = renderAccount({
      status: signedIn({ state: 'first_upload', firstUpload: { uploaded: 1, total: 4 } }),
      account: { cancelFirstUpload, latestBackup: vi.fn(() => Promise.resolve(null)) },
    });
    expect(
      screen.getByText(
        'Canceling keeps every record on this device, including changes made since the upload started.',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel upload' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The upload already finished. Nothing changed.');
    await user.click(screen.getByRole('button', { name: 'Cancel upload' }));
    const message = await screen.findByText(
      'Upload canceled. Every record of this plan stays on this device.',
    );
    await waitFor(() => expect(message).toHaveFocus());
    expect(screen.queryByRole('link', { name: 'Download the backup' })).toBeNull();
  });
});

describe('Account: signed in', () => {
  it('shows the account, the sync state in words, its facts, and the account actions', () => {
    const lastSyncedAt = '2026-10-01T08:15:00.000Z';
    renderAccount({ status: signedIn({ lastSyncedAt }) });
    expect(h1s()).toHaveLength(1);
    expect(screen.getByText(`Signed in as ${testEmail}.`)).toBeVisible();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Sync', 'Export', 'Sign out', 'This device', 'Delete account']);
    expect(screen.getByText('Everything on this device is synced.')).toBeVisible();
    const facts = screen.getByText('Changes waiting to sync').closest('dl');
    expect(facts).not.toBeNull();
    const terms = within(facts as HTMLElement)
      .getAllByRole('term')
      .map((term) => `${term.textContent ?? ''}: ${term.nextElementSibling?.textContent ?? ''}`);
    expect(terms).toEqual([
      'Changes waiting to sync: 0',
      'Conflicts to resolve: 0',
      `Last synced: ${formatSyncTime(lastSyncedAt) ?? ''}`,
    ]);
    expect(screen.queryByRole('link', { name: 'Review conflicts' })).toBeNull();
    for (const name of [
      'Sync now',
      'Export account data',
      'Sign out',
      'Remove this account from this device',
      'Delete account',
    ])
      expect(screen.getByRole('button', { name })).toBeEnabled();
  });

  it('explains waiting, outage, and attention states with the next safe action', () => {
    const nextAttemptAt = '2026-10-01T10:00:00.000Z';
    renderAccount({ status: signedIn({ state: 'queued_offline', pendingChanges: 3 }) });
    expect(
      screen.getByText(
        'You are offline. 3 changes are saved on this device and wait to sync until you are back online.',
      ),
    ).toBeVisible();
    cleanup();
    renderAccount({
      status: signedIn({ state: 'server_unavailable', pendingChanges: 1, nextAttemptAt }),
    });
    expect(
      screen.getByText(
        'The sync server cannot be reached right now. Your changes are saved on this device, and sync tries again later.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Next try').nextElementSibling).toHaveTextContent(
      formatSyncTime(nextAttemptAt) ?? '',
    );
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
    cleanup();
    renderAccount({
      status: signedIn({ state: 'needs_attention', openConflicts: 2, rejectedChanges: 1 }),
    });
    expect(
      screen.getByText(
        'Sync needs your attention: 2 conflicts need your choice, and 1 change could not be synced.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review conflicts' })).toHaveAttribute(
      'href',
      '/account/conflicts',
    );
    expect(screen.getByText('Changes not accepted').nextElementSibling).toHaveTextContent('1');
    const help =
      'Your account did not accept these changes. They stay on this device, and Export account data keeps a copy of them. You can try sending them again.';
    expect(screen.getByText(help)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try sending again' })).toHaveAccessibleDescription(
      help,
    );
    expect(screen.getByText('Last synced').nextElementSibling).toHaveTextContent('Not yet');
  });

  it('Try sending again retries the changes not accepted, and reports the state it ends in', async () => {
    const cycle = deferred<undefined>();
    const { sync, user } = renderAccount({
      status: signedIn({ state: 'needs_attention', rejectedChanges: 2 }),
    });
    sync.retryRejected.mockImplementation(() => cycle.promise);
    await user.click(screen.getByRole('button', { name: 'Try sending again' }));
    const busy = screen.getByRole('button', { name: 'Sending again…' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Sync now' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(busy);
    expect(sync.retryRejected).toHaveBeenCalledTimes(1);
    expect(sync.syncNow).not.toHaveBeenCalled();
    await act(async () => {
      sync.set({ state: 'synced', rejectedChanges: 0 });
      cycle.resolve(undefined);
      await cycle.promise;
    });
    const results = await screen.findAllByText('Everything on this device is synced.');
    const message = results.find((item) => item.classList.contains('account-result'));
    await waitFor(() => expect(message).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Try sending again' })).toBeNull();
  });

  it('keeps the upload’s progress, Cancel upload, and the backup beside what needs attention', async () => {
    const backup = exportFile({ fileName: 'yelaxis-backup-2026-10-01.json' });
    renderAccount({
      status: signedIn({
        state: 'needs_attention',
        openConflicts: 1,
        firstUpload: { uploaded: 2, total: 10 },
      }),
      account: { latestBackup: vi.fn(() => Promise.resolve(backup)) },
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Uploading this plan' })).toBeVisible();
    expect(screen.getByLabelText('Upload progress')).toHaveAttribute('value', '2');
    expect(screen.getByText('2 of 10 records uploaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel upload' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Download the backup' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review conflicts' })).toBeVisible();
    cleanup();
    // An ended session asks to sign in again, and the upload stays in view.
    renderAccount({
      status: signedIn({ state: 'auth_expired', firstUpload: { uploaded: 0, total: 10 } }),
      account: { latestBackup: vi.fn(() => Promise.resolve(null)) },
    });
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      'Sign in again',
      'Uploading this plan',
      'Sync',
      'Export',
      'Sign out',
      'This device',
      'Delete account',
    ]);
    expect(screen.getByRole('button', { name: 'Cancel upload' })).toBeVisible();
  });

  it('keeps the signed-in view while the open account signs in again', async () => {
    const reauthenticate = deferred<AccountResult>();
    const { sync, user } = renderAccount({
      status: signedIn({ state: 'auth_expired' }),
      account: { reauthenticate: vi.fn(() => reauthenticate.promise) },
    });
    const reauth = screen.getByRole('form', { name: 'Sign in again' });
    const password = within(reauth).getByLabelText('Password');
    await user.type(password, testPassword);
    await user.keyboard('{Enter}');
    // The account's coordinator reports a change meanwhile: the form and its request stay.
    act(() => sync.set({ pendingChanges: 3 }));
    await act(async () => {
      reauthenticate.resolve(refused('invalid_credentials', 'That password is not correct.'));
      await reauthenticate.promise;
    });
    expect(password).toBeInTheDocument();
    await waitFor(() =>
      expect(password).toHaveAccessibleDescription('That password is not correct.'),
    );
    // Sent with Enter from the field, the refusal is announced where focus already is.
    expect(within(reauth).getByRole('alert')).toHaveTextContent('That password is not correct.');
    expect(password).toHaveFocus();
  });

  it('never shows the sign-in forms while an account is open', () => {
    renderAccount({ status: signedIn({ state: 'signing_in' }) });
    expect(screen.queryByRole('form', { name: 'Sign in' })).toBeNull();
    expect(screen.getByText(`Signed in as ${testEmail}.`)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  it('Sync now runs one cycle and reports the state it ends in', async () => {
    const cycle = deferred<undefined>();
    const { sync, user } = renderAccount({ status: signedIn({ state: 'server_unavailable' }) });
    sync.syncNow.mockImplementation(() => cycle.promise);
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    const busy = screen.getByRole('button', { name: 'Syncing…' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    await user.click(busy);
    expect(sync.syncNow).toHaveBeenCalledTimes(1);
    await act(async () => {
      sync.set({ state: 'synced' });
      cycle.resolve(undefined);
      await cycle.promise;
    });
    const results = await screen.findAllByText('Everything on this device is synced.');
    const message = results.find((item) => item.classList.contains('account-result'));
    expect(message).toBeDefined();
    await waitFor(() => expect(message).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toHaveAttribute('aria-disabled');
  });

  it('asks to sign in again with the password only when the session ended', async () => {
    const reauthenticate = vi
      .fn<AccountService['reauthenticate']>()
      .mockResolvedValueOnce(refused('invalid_credentials', 'That password is not correct.'))
      .mockResolvedValueOnce(done);
    const { user } = renderAccount({
      status: signedIn({ state: 'auth_expired', pendingChanges: 2 }),
      account: { reauthenticate },
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Sign in again' })).toBeVisible();
    expect(
      screen.getByText(
        `Your session for ${testEmail} ended. Your plan keeps working on this device, and changes wait here until you sign in again.`,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    const reauth = screen.getByRole('form', { name: 'Sign in again' });
    const password = within(reauth).getByLabelText('Password');
    expect(within(reauth).queryByLabelText('Email')).toBeNull();
    await user.click(within(reauth).getByRole('button', { name: 'Sign in again' }));
    expect(password).toHaveAccessibleDescription('Enter your password.');
    await waitFor(() => expect(password).toHaveFocus());
    await user.type(password, testPassword);
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(password).toHaveAccessibleDescription('That password is not correct.'),
    );
    expect(password).toHaveValue('');
    await user.type(password, testPassword);
    await user.click(within(reauth).getByRole('button', { name: 'Sign in again' }));
    const message = await screen.findByText('Signed in again. Sync continues.');
    await waitFor(() => expect(message).toHaveFocus());
    expect(reauthenticate).toHaveBeenLastCalledWith(testPassword);
    expect(document.body.innerHTML).not.toContain(testPassword);
  });

  it('offers Retry with the password, and Cancel, while deletion is pending', async () => {
    const retryDeletion = vi
      .fn<AccountService['retryDeletion']>()
      .mockResolvedValueOnce(
        refused('unavailable', 'The account could not be deleted right now. Try again later.'),
      )
      .mockResolvedValueOnce(
        refused('wrong_password', 'That password is not right. Nothing was deleted.'),
      )
      .mockResolvedValueOnce(done);
    const cancelDeletion = vi.fn(() => Promise.resolve(done));
    const { user } = renderAccount({
      status: signedIn({ state: 'deletion_pending' }),
      account: { retryDeletion, cancelDeletion },
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Account deletion is pending' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    const pending = screen.getByRole('form', { name: 'Account deletion is pending' });
    const password = within(pending).getByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(password).toHaveAccessibleDescription(
      'To retry, enter your password again. It is not needed when your account was already deleted.',
    );
    await user.type(password, testPassword);
    await user.click(screen.getByRole('button', { name: 'Retry deletion' }));
    expect(retryDeletion).toHaveBeenLastCalledWith(testPassword);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The account could not be deleted right now. Try again later.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(password).toHaveValue('');
    // A wrong password, sent with Enter from the field, is announced and tied to the field.
    await user.type(password, 'not-the-password');
    await user.keyboard('{Enter}');
    const refusal = await within(pending).findByRole('alert');
    expect(refusal).toHaveTextContent('That password is not right. Nothing was deleted.');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAccessibleDescription(
      'To retry, enter your password again. It is not needed when your account was already deleted. That password is not right. Nothing was deleted.',
    );
    await waitFor(() => expect(password).toHaveFocus());
    expect(screen.getAllByRole('alert')).toEqual([refusal]);
    await user.type(password, testPassword);
    await user.click(screen.getByRole('button', { name: 'Retry deletion' }));
    const message = await screen.findByText('Your account was deleted.');
    await waitFor(() => expect(message).toHaveFocus());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.innerHTML).not.toContain(testPassword);
    await user.click(screen.getByRole('button', { name: 'Cancel deletion' }));
    expect(
      await screen.findByText('Account deletion canceled. Your account stays, and sync continues.'),
    ).toBeVisible();
    expect(cancelDeletion).toHaveBeenCalledTimes(1);
  });

  it('exports the account data as a download and says when changes had not synced', async () => {
    const file = exportFile({ syncWasPending: true });
    const exportAccount = vi
      .fn<AccountService['exportAccount']>()
      .mockResolvedValueOnce(ok(file))
      .mockResolvedValueOnce(refused('export_failed', 'The export could not be made. Try again.'));
    const { user } = renderAccount({ status: signedIn(), account: { exportAccount } });
    await user.click(screen.getByRole('button', { name: 'Export account data' }));
    const message = await screen.findByText(
      'Exported 15 records to yelaxis-account-2026-10-01.json. It includes changes that have not synced yet.',
    );
    await waitFor(() => expect(message).toHaveFocus());
    expect(downloads.createObjectURL).toHaveBeenCalledWith(file.blob);
    expect(downloads.clicks).toEqual([
      { href: 'blob:yelaxis-test/1', download: 'yelaxis-account-2026-10-01.json' },
    ]);
    // The temporary link is gone; nothing names the file's content.
    expect(document.querySelector('a[download="yelaxis-account-2026-10-01.json"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Export account data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The export could not be made. Try again.',
    );
    expect(screen.queryByText(/^Exported/u)).toBeNull();
  });

  it('follows status changes without reloading', () => {
    const { sync } = renderAccount({ status: signedIn() });
    expect(screen.getByText('Everything on this device is synced.')).toBeVisible();
    act(() => sync.set({ state: 'syncing' }));
    expect(screen.getByText('Syncing with your account now.')).toBeVisible();
    // The local plan opened (a local identity's status names no account).
    act(() => sync.replace(statusOf({ state: 'local_only' })));
    expect(form('Sign in')).toBeVisible();
    expect(status()).toBeUndefined();
  });
});
