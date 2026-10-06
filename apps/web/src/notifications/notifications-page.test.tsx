// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type {
  NotificationApplication,
  NotificationCentreItem,
  NotificationPreferences,
  NotificationView,
} from '@yelaxis/application';
import type { Instant, UUID } from '@yelaxis/domain';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationProvider } from './notification-context';
import { NotificationSettings, NotificationsPage } from './notifications-page';

afterEach(cleanup);
const item: NotificationCentreItem = {
  reminderId: '21000000-0000-4000-8000-000000000001' as UUID,
  reminderRevision: 1,
  occurrenceKey: '',
  dueAt: '2026-10-03T09:00:00.000Z' as Instant,
  observedAt: '2026-10-03T09:00:00.000Z' as Instant,
  deliveryStatus: 'missed',
  readAt: null,
  dismissedAt: null,
  title: 'Synthetic task',
  href: '/actions/16000000-0000-4000-8000-000000000001',
};
function fake() {
  let view: NotificationView = {
    preferences: { alertsEnabled: false, privacyMode: true },
    permission: 'default',
    items: [],
    nextPage: null,
    reconciliationError: null,
  };
  const application = {
    getView: vi.fn(() => Promise.resolve(view)),
    setPreferences: vi.fn((input: unknown) => {
      view = { ...view, preferences: input as NotificationPreferences };
      return Promise.resolve();
    }),
    requestPermission: vi.fn(() => {
      view = {
        ...view,
        permission: 'granted',
        preferences: { ...view.preferences, alertsEnabled: true },
      };
      return Promise.resolve('granted' as const);
    }),
    reconcile: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    markRead: vi.fn(() => {
      view = { ...view, items: view.items.map((row) => ({ ...row, readAt: item.dueAt })) };
      return Promise.resolve();
    }),
    dismiss: vi.fn(() => {
      view = { ...view, items: [] };
      return Promise.resolve();
    }),
    openTarget: vi.fn(() => Promise.resolve(item.href)),
  } satisfies NotificationApplication;
  return {
    application,
    setView(value: Partial<NotificationView>) {
      view = { ...view, ...value };
    },
  };
}
const tree = (application: NotificationApplication, settings = false) => (
  <MemoryRouter>
    <NotificationProvider application={application}>
      {settings ? <NotificationSettings /> : <NotificationsPage />}
    </NotificationProvider>
  </MemoryRouter>
);

describe('notification centre and explicit settings', () => {
  it('uses a singular reminder-record count without changing permissions', async () => {
    const f = fake();
    f.setView({ quarantinedReceiptCount: 1 });
    render(tree(f.application));
    expect(
      await screen.findByText(
        '1 saved reminder record cannot be displayed. The original record remains on this device. Your plan is unchanged.',
      ),
    ).toBeVisible();
    expect(f.application.requestPermission).not.toHaveBeenCalled();
  });
  it('discloses a quarantined-record count without private identifiers or additional commands', async () => {
    const f = fake();
    f.setView({ quarantinedReceiptCount: 2 });
    render(tree(f.application));
    expect(
      await screen.findByText(
        '2 saved reminder records cannot be displayed. The original records remain on this device. Your plan is unchanged.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(item.reminderId)).not.toBeInTheDocument();
    // The provider performs its normal initial reconciliation; the notice adds no command.
    expect(f.application.reconcile).toHaveBeenCalledTimes(1);
    expect(f.application.requestPermission).not.toHaveBeenCalled();
  });
  it('shows empty/offline recovery and the open-app delivery limit without requesting permission', async () => {
    const f = fake();
    render(tree(f.application));
    expect(
      await screen.findByText('No due reminders. Your plan remains available offline.'),
    ).toBeVisible();
    expect(screen.getByText(/Closing the app stops delivery/)).toBeVisible();
    expect(f.application.requestPermission).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Notification settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });
  it('requests permission only by the allow button and exposes denial recovery', async () => {
    const f = fake();
    const user = userEvent.setup();
    render(tree(f.application, true));
    await user.click(await screen.findByRole('button', { name: 'Allow browser alerts' }));
    expect(f.application.requestPermission).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: 'Turn off browser alerts' })).toBeVisible();
    cleanup();
    const denied = fake();
    denied.setView({ permission: 'denied' });
    render(tree(denied.application, true));
    expect(await screen.findByText(/Change this site's notification permission/)).toBeVisible();
    expect(denied.application.requestPermission).not.toHaveBeenCalled();
  });
  it('requires explicit preview and confirmation before showing planning titles', async () => {
    const f = fake();
    const user = userEvent.setup();
    render(tree(f.application, true));
    await user.click(
      await screen.findByRole('button', { name: 'Preview showing planning titles' }),
    );
    expect(screen.getByText(/Titles can appear on a shared or locked screen/)).toBeVisible();
    expect(f.application.setPreferences).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Keep generic text' }));
    expect(f.application.setPreferences).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Preview showing planning titles' }));
    await user.click(screen.getByRole('button', { name: 'Confirm showing planning titles' }));
    expect(f.application.setPreferences).toHaveBeenCalledWith({
      alertsEnabled: false,
      privacyMode: false,
      confirmTitleExposure: true,
    });
    expect(
      await screen.findByRole('button', { name: 'Use generic notification text' }),
    ).toBeVisible();
  });
  it('recovers missed reminders with explicit read and dismiss, returning focus to the heading', async () => {
    const f = fake();
    f.setView({ items: [item] });
    const user = userEvent.setup();
    render(tree(f.application));
    expect(await screen.findByText(/Due while YelAxis Planner was closed/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Mark Synthetic task as read' }));
    await waitFor(() => expect(f.application.markRead).toHaveBeenCalledWith(item));
    expect(await screen.findByText('Reminder marked as read.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notifications' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Dismiss Synthetic task' }));
    expect(
      await screen.findByText('No due reminders. Your plan remains available offline.'),
    ).toBeVisible();
    expect(f.application.dismiss).toHaveBeenCalledWith(
      expect.objectContaining({ reminderId: item.reminderId }),
    );
  });
  it('offers a safe route for removed targets and a retry for recoverable query failure', async () => {
    const f = fake();
    f.setView({ items: [{ ...item, title: 'Reminder no longer available', href: null }] });
    render(tree(f.application));
    expect(await screen.findByRole('link', { name: 'Return to Today' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(screen.queryByRole('button', { name: /Open Reminder/ })).not.toBeInTheDocument();
    cleanup();
    const failure = fake();
    failure.application.getView.mockRejectedValue(new Error('storage unavailable'));
    render(tree(failure.application));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your reminder definitions remain saved',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
