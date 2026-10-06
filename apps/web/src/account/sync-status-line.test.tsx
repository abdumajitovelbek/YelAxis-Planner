// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AccountProvider } from './account-context';
import { AccountSettingsSection } from './account-settings';
import type { SyncStatus } from './account-service';
import { SyncStatusLine, TodaySyncLine } from './sync-status-line';
import {
  fakeAccount,
  fakeConflicts,
  fakeSync,
  testEmail,
  type FakeSync,
} from './__fixtures__/account-fakes';

afterEach(() => cleanup());

function renderWith(
  element: ReactNode,
  status: Partial<SyncStatus> = {},
  options: { readonly configured?: boolean } = {},
): FakeSync {
  const sync = fakeSync(status);
  render(
    <AccountProvider
      account={fakeAccount({ configured: options.configured ?? true })}
      sync={sync.controller}
      conflicts={fakeConflicts()}
    >
      <MemoryRouter>{element}</MemoryRouter>
    </AccountProvider>,
  );
  return sync;
}

const signedIn = (overrides: Partial<SyncStatus>): Partial<SyncStatus> => ({
  account: { email: testEmail },
  ...overrides,
});

/** Neither line may interrupt: no live region, alert, or dialog around it. */
function expectQuiet(element: HTMLElement): void {
  expect(element.closest('[aria-live], [role="status"], [role="alert"], dialog')).toBeNull();
}

describe('SyncStatusLine (app frame)', () => {
  it('shows nothing for a local-only identity, without accounts, or without the provider', () => {
    renderWith(<SyncStatusLine />);
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    renderWith(<SyncStatusLine />, {}, { configured: false });
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    render(
      <MemoryRouter>
        <SyncStatusLine />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows a short state in words with a link to Account, and follows changes quietly', () => {
    const sync = renderWith(<SyncStatusLine />, signedIn({ state: 'synced' }));
    const link = screen.getByRole('link', { name: 'Account' });
    expect(link).toHaveAttribute('href', '/account');
    const line = link.closest('p') as HTMLElement;
    expect(line).toHaveTextContent('Synced · Account');
    expectQuiet(line);
    const cases: readonly (readonly [Partial<SyncStatus>, string])[] = [
      [{ state: 'signing_in' }, 'Signing in…'],
      [
        { state: 'first_upload', firstUpload: { uploaded: 2, total: 9 } },
        'Uploading this plan: 2 of 9',
      ],
      [{ state: 'syncing' }, 'Syncing…'],
      [{ state: 'queued_offline', pendingChanges: 2 }, 'Offline: 2 changes waiting'],
      [{ state: 'needs_attention', openConflicts: 1 }, 'Sync needs attention'],
      [{ state: 'auth_expired' }, 'Sign in again to sync'],
      [{ state: 'server_unavailable' }, 'Sync server unavailable'],
      [{ state: 'deletion_pending' }, 'Account deletion pending'],
    ];
    for (const [next, text] of cases) {
      act(() => sync.set(next));
      expect(screen.getByRole('link', { name: 'Account' }).closest('p')).toHaveTextContent(
        `${text} · Account`,
      );
    }
    act(() => sync.set({ state: 'local_only' }));
    expect(screen.queryByRole('link', { name: 'Account' })).toBeNull();
  });

  it('subscribes once and unsubscribes when it leaves', () => {
    const sync = renderWith(<SyncStatusLine />, signedIn({ state: 'synced' }));
    expect(sync.listeners()).toBe(1);
    cleanup();
    expect(sync.listeners()).toBe(0);
  });
});

describe('TodaySyncLine', () => {
  it('stays silent while nothing waits', () => {
    const sync = renderWith(<TodaySyncLine />, signedIn({ state: 'synced' }));
    expect(screen.queryByRole('link')).toBeNull();
    for (const state of ['syncing', 'signing_in', 'first_upload', 'local_only'] as const) {
      act(() => sync.set({ state, pendingChanges: 4 }));
      expect(screen.queryByRole('link')).toBeNull();
    }
    act(() => sync.set({ state: 'queued_offline', pendingChanges: 0 }));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows one quiet line with a link when something waits or needs an action', () => {
    const sync = renderWith(
      <TodaySyncLine />,
      signedIn({ state: 'queued_offline', pendingChanges: 2 }),
    );
    const offline = screen.getByRole('link', { name: 'Open Account' });
    expect(offline.closest('p')).toHaveTextContent(
      '2 changes wait to sync. They are saved on this device. Open Account',
    );
    expectQuiet(offline);
    act(() => sync.set({ state: 'needs_attention', openConflicts: 1 }));
    expect(screen.getByRole('link', { name: 'Review conflicts' })).toHaveAttribute(
      'href',
      '/account/conflicts',
    );
    expect(screen.getByText('Sync needs your choice on 1 conflict.')).toBeVisible();
    act(() => sync.set({ state: 'auth_expired', openConflicts: 0 }));
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/account');
    act(() => sync.set({ state: 'server_unavailable' }));
    expect(
      screen.getByText(
        'Sync is paused because the server cannot be reached. Your changes are saved on this device.',
      ),
    ).toBeVisible();
    act(() => sync.set({ state: 'deletion_pending' }));
    expect(screen.getByText('Account deletion is pending.')).toBeVisible();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});

describe('AccountSettingsSection', () => {
  it('links Settings to Account in every build, with the state in words', () => {
    renderWith(<AccountSettingsSection />, {}, { configured: false });
    expect(screen.getByRole('heading', { level: 2, name: 'Account and sync' })).toBeVisible();
    expect(
      screen.getByText(
        'Account sync is not available in this build. Your plan stays on this device.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Account' })).toHaveAttribute('href', '/account');
    cleanup();
    const sync = renderWith(<AccountSettingsSection />);
    expect(
      screen.getByText(
        'Optional. Sign in to sync your plan between browsers. Your local plan keeps working without an account.',
      ),
    ).toBeVisible();
    act(() => sync.set(signedIn({ state: 'synced' })));
    expect(screen.getByText(`Signed in as ${testEmail}. Synced.`)).toBeVisible();
    act(() => sync.set({ state: 'syncing' }));
    expect(screen.getByText(`Signed in as ${testEmail}. Syncing…`)).toBeVisible();
  });
});
