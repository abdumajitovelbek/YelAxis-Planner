import { message as uiMessage } from '../messages';
import type { NotificationApplication } from '@yelaxis/application';
import { createContext, useContext, useEffect, type ReactNode } from 'react';

import { planChangedEvent } from '../plan/planning-context';

const Context = createContext<NotificationApplication | null>(null);
export const notificationsChangedEvent = 'yelaxis:notifications-changed';
export function notifyNotificationsChanged(): void {
  window.dispatchEvent(new Event(notificationsChangedEvent));
}
export function useNotifications(): NotificationApplication {
  const application = useContext(Context);
  if (application === null) throw new Error(uiMessage('notifications.notification-context.975'));
  return application;
}
export function NotificationProvider({
  application,
  children,
}: {
  readonly application: NotificationApplication;
  readonly children: ReactNode;
}): ReactNode {
  useEffect(() => {
    let alive = true;
    let pending = false;
    const reconcile = (): void => {
      if (!alive || pending || document.visibilityState === 'hidden') return;
      pending = true;
      void application
        .reconcile()
        .then(
          () => {
            if (alive) notifyNotificationsChanged();
          },
          () => {
            // The centre's query gives a recoverable error. A timer never alters reminder definitions.
            if (alive) notifyNotificationsChanged();
          },
        )
        .finally(() => {
          pending = false;
        });
    };
    reconcile();
    const timer = window.setInterval(reconcile, 15_000);
    window.addEventListener('focus', reconcile);
    document.addEventListener('visibilitychange', reconcile);
    window.addEventListener(planChangedEvent, reconcile);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', reconcile);
      document.removeEventListener('visibilitychange', reconcile);
      window.removeEventListener(planChangedEvent, reconcile);
      application.stop();
    };
  }, [application]);
  return <Context.Provider value={application}>{children}</Context.Provider>;
}
