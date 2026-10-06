import { countMessage, message as uiMessage } from '../messages';
import type { NotificationKey, NotificationView } from '@yelaxis/application';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import {
  notifyNotificationsChanged,
  notificationsChangedEvent,
  useNotifications,
} from './notification-context';

export const notificationDeliveryDisclosure = uiMessage('notifications.notifications-page.976');
export function useNotificationView(before: NotificationKey | null = null) {
  const application = useNotifications();
  const [view, setView] = useState<NotificationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const load = useCallback(async (): Promise<void> => {
    const ticket = ++generation.current;
    try {
      const result = await application.getView(before);
      if (alive.current && ticket === generation.current) {
        setView(result);
        setError(null);
      }
    } catch {
      if (alive.current && ticket === generation.current)
        setError(uiMessage('notifications.notifications-page.977'));
    }
  }, [application, before]);
  useEffect(() => {
    alive.current = true;
    setView(null);
    let live = true;
    const refresh = (): void => {
      if (live) void load();
    };
    refresh();
    window.addEventListener(notificationsChangedEvent, refresh);
    return () => {
      live = false;
      alive.current = false;
      generation.current += 1;
      window.removeEventListener(notificationsChangedEvent, refresh);
    };
  }, [load]);
  const run = async (operation: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await load();
      notifyNotificationsChanged();
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : uiMessage('notifications.notifications-page.978'),
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { application, view, error, busy, load, run };
}

export function NotificationsPage(): ReactNode {
  const [before, setBefore] = useState<NotificationKey | null>(null);
  const { application, view, error, busy, load, run } = useNotificationView(before);
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const complete = async (operation: () => Promise<void>, message: string): Promise<void> => {
    if (await run(operation)) {
      setAnnouncement(message);
      heading.current?.focus();
    }
  };
  return (
    <section className="plan-page notifications-page" aria-labelledby="notifications-heading">
      <h1 id="notifications-heading" ref={heading} tabIndex={-1}>
        {uiMessage('app.785')}
      </h1>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      <p>{notificationDeliveryDisclosure}</p>
      <p>
        <Link to="/settings">{uiMessage('notifications.notifications-page.979')}</Link>
      </p>
      {error !== null && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void load()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      )}
      {view === null && error === null && (
        <p role="status">{uiMessage('notifications.notifications-page.980')}</p>
      )}
      {view !== null && (
        <>
          {(view.quarantinedReceiptCount ?? 0) > 0 && (
            <p role="status">
              {countMessage(
                view.quarantinedReceiptCount ?? 0,
                'notifications.quarantined.one',
                'notifications.quarantined.other',
              )}
            </p>
          )}
          {view.reconciliationError !== null && (
            <div role="alert">
              <p>{view.reconciliationError}</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => application.reconcile())}
              >
                {uiMessage('notifications.notifications-page.981')}
              </button>
            </div>
          )}
          {view.items.length === 0 && <p>{uiMessage('notifications.notifications-page.982')}</p>}
          <ul className="notification-list">
            {view.items.map((item) => (
              <li key={`${item.reminderId}:${String(item.reminderRevision)}:${item.occurrenceKey}`}>
                <h2>{item.title}</h2>
                <p>
                  {uiMessage('notifications.notifications-page.983')}
                  <time dateTime={item.dueAt}>{new Date(item.dueAt).toLocaleString()}</time>.{' '}
                  {item.readAt === null
                    ? uiMessage('notifications.notifications-page.984')
                    : uiMessage('notifications.notifications-page.985')}
                </p>
                <p>
                  {item.deliveryStatus === 'missed'
                    ? uiMessage('notifications.notifications-page.986')
                    : item.deliveryStatus === 'failed' || item.deliveryStatus === 'attempting'
                      ? uiMessage('notifications.notifications-page.987')
                      : item.deliveryStatus === 'delivered'
                        ? uiMessage('notifications.notifications-page.988')
                        : uiMessage('notifications.notifications-page.989')}
                </p>
                {item.href !== null ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const href = await application.openTarget(item);
                        if (href === null)
                          throw new Error(uiMessage('notifications.notifications-page.990'));
                        await navigate(href);
                      })
                    }
                  >
                    {uiMessage('notifications.notifications-page.991')}
                    {item.title}
                  </button>
                ) : (
                  <p>
                    {uiMessage('notifications.notifications-page.992')}{' '}
                    <Link to="/">{uiMessage('notifications.notifications-page.993')}</Link>
                  </p>
                )}
                {item.readAt === null && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void complete(
                        () => application.markRead(item),
                        uiMessage('notifications.notifications-page.994'),
                      )
                    }
                  >
                    {uiMessage('notifications.notifications-page.995')}
                    {item.title}
                    {uiMessage('notifications.notifications-page.996')}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void complete(
                      () => application.dismiss(item),
                      uiMessage('notifications.notifications-page.997'),
                    )
                  }
                >
                  {uiMessage('notifications.notifications-page.998')}
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
          <nav aria-label={uiMessage('notifications.notifications-page.999')}>
            {before !== null && (
              <button type="button" disabled={busy} onClick={() => setBefore(null)}>
                {uiMessage('notifications.notifications-page.1000')}
              </button>
            )}
            {view.nextPage !== null && (
              <button type="button" disabled={busy} onClick={() => setBefore(view.nextPage)}>
                {uiMessage('notifications.notifications-page.1001')}
              </button>
            )}
          </nav>
        </>
      )}
    </section>
  );
}

export function NotificationSettings(): ReactNode {
  const { application, view, error, busy, load, run } = useNotificationView();
  const [showTitlePreview, setShowTitlePreview] = useState(false);
  return (
    <section className="notification-settings" aria-labelledby="notification-settings-heading">
      <h2 id="notification-settings-heading">
        {uiMessage('notifications.notifications-page.1002')}
      </h2>
      <p>{notificationDeliveryDisclosure}</p>
      <p>{uiMessage('notifications.notifications-page.1003')}</p>
      <p>
        <Link to="/notifications">{uiMessage('notifications.notifications-page.1004')}</Link>
      </p>
      {error !== null && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void load()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      )}
      {view === null && error === null && (
        <p role="status">{uiMessage('notifications.notifications-page.1005')}</p>
      )}
      {view !== null && (
        <>
          <p>
            {uiMessage('notifications.notifications-page.1006')}
            {view.permission}
            {uiMessage('notifications.notifications-page.1007')}{' '}
            {view.preferences.alertsEnabled
              ? uiMessage('notifications.notifications-page.2458')
              : uiMessage('notifications.notifications-page.2459')}
            .
          </p>
          {view.permission === 'default' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => application.requestPermission())}
            >
              {uiMessage('notifications.notifications-page.1008')}
            </button>
          )}
          {(view.permission === 'granted' || view.preferences.alertsEnabled) && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  application.setPreferences({
                    ...view.preferences,
                    alertsEnabled: !view.preferences.alertsEnabled,
                  }),
                )
              }
            >
              {view.preferences.alertsEnabled
                ? uiMessage('notifications.notifications-page.1009')
                : uiMessage('notifications.notifications-page.1010')}
            </button>
          )}
          {view.permission === 'denied' && (
            <p>{uiMessage('notifications.notifications-page.1011')}</p>
          )}
          {view.permission === 'unsupported' && (
            <p>{uiMessage('notifications.notifications-page.1012')}</p>
          )}
          <p>
            {uiMessage('notifications.notifications-page.1013')}
            <strong>{uiMessage('notifications.notifications-page.1014')}</strong> —{' '}
            {view.preferences.privacyMode
              ? uiMessage('notifications.notifications-page.1015')
              : uiMessage('notifications.notifications-page.1016')}
          </p>
          {view.preferences.privacyMode ? (
            <button type="button" disabled={busy} onClick={() => setShowTitlePreview(true)}>
              {uiMessage('notifications.notifications-page.1017')}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  application.setPreferences({ ...view.preferences, privacyMode: true }),
                )
              }
            >
              {uiMessage('notifications.notifications-page.1018')}
            </button>
          )}
          {showTitlePreview && view.preferences.privacyMode && (
            <div
              className="notification-privacy-preview"
              role="group"
              aria-labelledby="notification-privacy-heading"
            >
              <h3 id="notification-privacy-heading">
                {uiMessage('notifications.notifications-page.1019')}
              </h3>
              <p>
                {uiMessage('notifications.notifications-page.1020')}
                <strong>{uiMessage('notifications.notifications-page.1014')}</strong>
                {uiMessage('notifications.notifications-page.1021')}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await application.setPreferences({
                      ...view.preferences,
                      privacyMode: false,
                      confirmTitleExposure: true,
                    });
                    setShowTitlePreview(false);
                  })
                }
              >
                {uiMessage('notifications.notifications-page.1022')}
              </button>
              <button type="button" disabled={busy} onClick={() => setShowTitlePreview(false)}>
                {uiMessage('notifications.notifications-page.1023')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
