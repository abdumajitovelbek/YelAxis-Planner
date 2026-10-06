// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingApplication, OnboardingState } from '@yelaxis/application';
import { emptyOnboardingDraft } from '@yelaxis/domain';

import { OnboardingJourney } from '../onboarding-ui';
import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import { AccountProvider } from './account-context';
import { AccountNoticeBanner } from './account-notice';
import type { AccountNotices, AccountService } from './account-service';
import { accountOutcomes } from './sync-text';
import {
  done,
  exportFile,
  fakeAccount,
  fakeConflicts,
  fakeNotices,
  fakeSync,
  installDownloadStubs,
  mockOf,
  ok,
  refused,
  testEmail,
  testPassword,
  uploadPreview,
} from './__fixtures__/account-fakes';

beforeAll(installDialogPolyfill);
beforeEach(() => {
  installDownloadStubs();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const welcome: OnboardingState = {
  ownerId: 'owner-1' as OnboardingState['ownerId'],
  profileId: 'profile-1' as OnboardingState['profileId'],
  profileRevision: 1,
  status: 'not_started',
  step: 'welcome',
  completedSteps: [],
  skippedSteps: [],
  handbook: { status: 'not_started', lesson: 0, completedLessons: [] },
  draft: emptyOnboardingDraft(),
  artifacts: { axisIds: [], commitments: [] },
  today: { date: '', weekStartDate: '', weekEndDate: '', axes: [], commitments: [] },
};

function renderWelcome(
  options: {
    readonly account?: AccountService | null;
    readonly provider?: boolean;
    /** Held outcomes, shown above the journey as the app does. */
    readonly notices?: AccountNotices;
  } = {},
) {
  const execute = vi.fn<OnboardingApplication['execute']>(() =>
    Promise.resolve({ ok: true, value: welcome }),
  );
  const application: OnboardingApplication = {
    initialize: vi.fn(() => Promise.resolve(welcome)),
    load: vi.fn(() => Promise.resolve(welcome)),
    execute,
  };
  const journey = (
    <OnboardingJourney
      application={application}
      online
      state={welcome}
      updateState={() => undefined}
      onLeave={() => undefined}
    />
  );
  const account = options.account ?? fakeAccount();
  const sync = fakeSync();
  const tree: ReactNode =
    options.provider === false ? (
      journey
    ) : options.notices !== undefined ? (
      <AccountProvider
        account={account}
        sync={sync.controller}
        conflicts={fakeConflicts()}
        notices={options.notices}
      >
        <AccountNoticeBanner />
        {journey}
      </AccountProvider>
    ) : (
      <AccountProvider account={account} sync={sync.controller} conflicts={fakeConflicts()}>
        {journey}
      </AccountProvider>
    );
  render(<MemoryRouter>{tree}</MemoryRouter>);
  return { execute, account, sync, user: userEvent.setup() };
}

const optionalLine =
  'Sync is optional. Sign in to sync your plan between browsers, or start locally and sign in later from Settings.';
const unavailableLine =
  'Account sync is not available in this build. Your plan stays on this device.';
const dialog = () => screen.getByRole('dialog');

describe('Welcome: accounts', () => {
  it('offers Sign in next to Start locally and says sync is optional', () => {
    renderWelcome();
    const start = screen.getByRole('button', { name: 'Start locally' });
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    expect(signIn.parentElement).toBe(start.parentElement);
    expect(signIn).toHaveAttribute('type', 'button');
    expect(screen.getByText(optionalLine)).toBeVisible();
    expect(screen.getByText(/No account required\./u)).toBeVisible();
    expect(screen.queryByText(/arrive later/u)).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('says above setup what an account operation did, focused after the journey’s heading', async () => {
    // Deleting the account with this device's copy opened a fresh local plan at setup.
    const held = fakeNotices();
    held.announce(accountOutcomes.deletedWithCopy);
    renderWelcome({ notices: held.notices });
    const region = screen.getByRole('region', { name: 'Account notice' });
    const text = within(region).getByText(accountOutcomes.deletedWithCopy);
    await waitFor(() => expect(text).toHaveFocus());
    // Reading goes on into setup from there.
    expect(region.compareDocumentPosition(screen.getByRole('main'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(held.notices.current()).toBeNull();
  });

  it('says honestly when this build has no accounts, without a Sign in button', () => {
    renderWelcome({ account: fakeAccount({ configured: false }) });
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByText(unavailableLine)).toBeVisible();
    cleanup();
    renderWelcome({ provider: false });
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByText(unavailableLine)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start locally' })).toBeEnabled();
  });

  it('still starts locally with Start locally', async () => {
    const { account, execute, user } = renderWelcome();
    await user.click(screen.getByRole('button', { name: 'Start locally' }));
    expect(execute).toHaveBeenCalledWith({ kind: 'start', draft: welcome.draft });
    expect(mockOf(account, 'signIn')).not.toHaveBeenCalled();
  });

  it('signs in from a dialog and returns focus to Sign in when it closes', async () => {
    const signIn = vi.fn<AccountService['signIn']>(() =>
      Promise.resolve(ok({ kind: 'opened_account' })),
    );
    const { execute, user } = renderWelcome({ account: fakeAccount({ signIn }) });
    const opener = screen.getByRole('button', { name: 'Sign in' });
    await user.click(opener);
    expect(dialog()).toHaveAccessibleName('Sign in');
    // The welcome step is a form: the dialog and its own form are never nested inside it.
    expect(dialog().closest('form')).toBeNull();
    const form = within(dialog()).getByRole('form', { name: 'Sign in' });
    const email = within(form).getByLabelText('Email');
    expect(email).toHaveFocus();
    expect(
      within(dialog()).getByText(
        'Sync is optional. Your local plan keeps working without an account, and nothing is uploaded until you choose.',
      ),
    ).toBeVisible();
    await user.type(email, testEmail);
    await user.type(within(form).getByLabelText('Password'), testPassword);
    await user.keyboard('{Enter}');
    expect(signIn).toHaveBeenCalledWith(testEmail, testPassword);
    const message = await within(dialog()).findByText(
      `Signed in as ${testEmail}. Your account’s plan is open.`,
    );
    await waitFor(() => expect(message).toHaveFocus());
    expect(dialog()).toHaveAccessibleName('Signed in');
    await user.click(within(dialog()).getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(execute).not.toHaveBeenCalled();
  });

  it('switches between Sign in and Create account in the dialog', async () => {
    const signUp = vi.fn<AccountService['signUp']>(() =>
      Promise.resolve(ok({ kind: 'opened_account' })),
    );
    const { user } = renderWelcome({ account: fakeAccount({ signUp }) });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(within(dialog()).getByText('No account yet?')).toBeVisible();
    await user.click(within(dialog()).getByRole('button', { name: 'Create account instead' }));
    expect(dialog()).toHaveAccessibleName('Create account');
    const form = within(dialog()).getByRole('form', { name: 'Create account' });
    await waitFor(() => expect(within(form).getByLabelText('Email')).toHaveFocus());
    await user.type(within(form).getByLabelText('Email'), testEmail);
    await user.type(within(form).getByLabelText('Password'), testPassword);
    await user.click(within(form).getByRole('button', { name: 'Create account' }));
    expect(signUp).toHaveBeenCalledWith(testEmail, testPassword);
    expect(
      await within(dialog()).findByText(`Signed in as ${testEmail}. Your account’s plan is open.`),
    ).toBeVisible();
    // Opening again starts at Sign in.
    await user.click(within(dialog()).getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(dialog()).toHaveAccessibleName('Sign in');
    await user.click(within(dialog()).getByRole('button', { name: 'Create account instead' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Sign in instead' }));
    expect(dialog()).toHaveAccessibleName('Sign in');
  });

  it('shows the first-upload choice, then the upload with its backup', async () => {
    const { account, user } = renderWelcome({
      account: fakeAccount({
        signIn: vi.fn(() =>
          Promise.resolve(ok({ kind: 'choose_first_upload' as const, preview: uploadPreview() })),
        ),
        startFirstUpload: vi.fn(() => Promise.resolve(done)),
        latestBackup: vi.fn(() => Promise.resolve(exportFile({ fileName: 'backup.json' }))),
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const form = within(dialog()).getByRole('form', { name: 'Sign in' });
    await user.type(within(form).getByLabelText('Email'), testEmail);
    await user.type(within(form).getByLabelText('Password'), testPassword);
    await user.click(within(form).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(dialog()).toHaveAccessibleName('Upload this plan to your account?'));
    const intro = within(dialog()).getByText(
      `Signed in as ${testEmail}. This device already has a plan. Nothing is uploaded until you choose.`,
    );
    await waitFor(() => expect(intro).toHaveFocus());
    expect(
      within(dialog())
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['On this device', 'In your account', 'Sensitive Context', 'Backup first']);
    await user.click(within(dialog()).getByRole('button', { name: 'Upload this plan' }));
    expect(mockOf(account, 'startFirstUpload')).toHaveBeenCalledTimes(1);
    const message = await within(dialog()).findByText(
      'Backup made. This plan is uploading to your account.',
    );
    await waitFor(() => expect(message).toHaveFocus());
    expect(dialog()).toHaveAccessibleName('Uploading this plan');
    expect(
      await within(dialog()).findByRole('link', { name: 'Download the backup' }),
    ).toHaveAttribute('download', 'backup.json');
    expect(within(dialog()).getByRole('button', { name: 'Cancel upload' })).toBeVisible();
    await user.click(within(dialog()).getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps this plan on this device from the choice', async () => {
    const { account, user } = renderWelcome({
      account: fakeAccount({
        signIn: vi.fn(() =>
          Promise.resolve(ok({ kind: 'choose_first_upload' as const, preview: uploadPreview() })),
        ),
        declineFirstUpload: vi.fn(() => Promise.resolve(done)),
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const form = within(dialog()).getByRole('form', { name: 'Sign in' });
    await user.type(within(form).getByLabelText('Email'), testEmail);
    await user.type(within(form).getByLabelText('Password'), testPassword);
    await user.click(within(form).getByRole('button', { name: 'Sign in' }));
    await user.click(
      await within(dialog()).findByRole('button', { name: 'Keep this plan on this device' }),
    );
    expect(
      await within(dialog()).findByText(
        'This plan stays on this device, unchanged. Your account’s own plan is open.',
      ),
    ).toBeVisible();
    expect(dialog()).toHaveAccessibleName('This plan stays on this device');
    expect(mockOf(account, 'startFirstUpload')).not.toHaveBeenCalled();
  });

  async function reachChoice(account: Partial<AccountService>) {
    const rendered = renderWelcome({
      account: fakeAccount({
        signIn: vi.fn(() =>
          Promise.resolve(ok({ kind: 'choose_first_upload' as const, preview: uploadPreview() })),
        ),
        ...account,
      }),
    });
    await rendered.user.click(screen.getByRole('button', { name: 'Sign in' }));
    const form = within(dialog()).getByRole('form', { name: 'Sign in' });
    await rendered.user.type(within(form).getByLabelText('Email'), testEmail);
    await rendered.user.type(within(form).getByLabelText('Password'), testPassword);
    await rendered.user.click(within(form).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(dialog()).toHaveAccessibleName('Upload this plan to your account?'));
    return rendered;
  }

  it('backs out at the choice with Cancel sign-in, keeping the local plan as it was', async () => {
    const cancelFirstUpload = vi.fn(() => Promise.resolve(done));
    const { account, execute, user } = await reachChoice({ cancelFirstUpload });
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel sign-in' }));
    const message = await within(dialog()).findByText(
      'Sign-in canceled. Nothing was uploaded, and this plan stays on this device.',
    );
    await waitFor(() => expect(message).toHaveFocus());
    expect(dialog()).toHaveAccessibleName('Sign-in canceled');
    expect(cancelFirstUpload).toHaveBeenCalledTimes(1);
    expect(mockOf(account, 'startFirstUpload')).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Opening again starts at the sign-in form: no choice waits any more.
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(dialog()).toHaveAccessibleName('Sign in');
    expect(execute).not.toHaveBeenCalled();
  });

  it('closing the dialog while the choice waits cancels the sign-in', async () => {
    const cancelFirstUpload = vi.fn(() => Promise.resolve(done));
    const { account, user } = await reachChoice({ cancelFirstUpload });
    const opener = screen.getByRole('button', { name: 'Sign in' });
    fireEvent(dialog(), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cancelFirstUpload).toHaveBeenCalledTimes(1);
    expect(mockOf(account, 'startFirstUpload')).not.toHaveBeenCalled();
    expect(mockOf(account, 'declineFirstUpload')).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
    await user.click(opener);
    expect(dialog()).toHaveAccessibleName('Sign in');
  });

  it('closing the dialog while a choice is under way lets it finish', async () => {
    let finish = (): void => undefined;
    const startFirstUpload = vi.fn(
      () =>
        new Promise<typeof done>((resolve) => {
          finish = () => resolve(done);
        }),
    );
    const cancelFirstUpload = vi.fn(() => Promise.resolve(done));
    const { user } = await reachChoice({
      startFirstUpload,
      cancelFirstUpload,
      latestBackup: vi.fn(() => Promise.resolve(null)),
    });
    await user.click(within(dialog()).getByRole('button', { name: 'Upload this plan' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cancelFirstUpload).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(startFirstUpload).toHaveBeenCalledTimes(1));
  });

  it('a failed sign-in or closing the dialog leaves the local plan unchanged', async () => {
    const { execute, user } = renderWelcome({
      account: fakeAccount({
        signIn: vi.fn(() =>
          Promise.resolve(refused('invalid_credentials', 'That email and password do not match.')),
        ),
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const form = within(dialog()).getByRole('form', { name: 'Sign in' });
    await user.type(within(form).getByLabelText('Email'), testEmail);
    await user.type(within(form).getByLabelText('Password'), testPassword);
    await user.click(within(form).getByRole('button', { name: 'Sign in' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'That email and password do not match.',
    );
    fireEvent(dialog(), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start locally' })).toBeEnabled();
    expect(execute).not.toHaveBeenCalled();
  });
});
