import type {
  NotificationPayload,
  NotificationPermissionStatus,
  NotificationsPort,
} from '@yelaxis/application';

interface BrowserNotificationHandle {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}
interface BrowserNotificationConstructor {
  new (title: string, options?: NotificationOptions): BrowserNotificationHandle;
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}
export interface BrowserNotificationsEnvironment {
  readonly Notification?: BrowserNotificationConstructor;
  readonly secure: boolean;
  readonly focus: () => void;
}

/** Open-page Notifications API only: no service worker payloads, push, or provider credentials. */
export class BrowserNotifications implements NotificationsPort {
  readonly #open = new Map<BrowserNotificationHandle, () => void>();
  readonly #environment: BrowserNotificationsEnvironment;
  constructor(environment?: BrowserNotificationsEnvironment) {
    this.#environment = environment ?? {
      ...(typeof Notification === 'undefined' ? {} : { Notification }),
      secure: window.isSecureContext,
      focus: () => window.focus(),
    };
  }
  permission(): NotificationPermissionStatus {
    return !this.#environment.secure || this.#environment.Notification === undefined
      ? 'unsupported'
      : this.#environment.Notification.permission;
  }
  async requestPermission(): Promise<NotificationPermissionStatus> {
    if (this.permission() === 'unsupported') return 'unsupported';
    if (this.permission() !== 'default') return this.permission();
    try {
      return (await this.#environment.Notification?.requestPermission()) ?? 'unsupported';
    } catch {
      return this.permission();
    }
  }
  show(payload: NotificationPayload, onOpen: () => void): Promise<'delivered' | 'failed'> {
    if (this.permission() !== 'granted' || this.#environment.Notification === undefined)
      return Promise.resolve('failed');
    try {
      const handle = new this.#environment.Notification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        silent: true,
      });
      return new Promise((resolve) => {
        let settled = false;
        const settle = (status: 'delivered' | 'failed'): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(status);
        };
        const timeout = setTimeout(() => {
          handle.close();
          this.#open.delete(handle);
          settle('failed');
        }, 2_000);
        this.#open.set(handle, () => settle('failed'));
        handle.addEventListener('show', () => settle('delivered'));
        handle.addEventListener('error', () => {
          handle.close();
          this.#open.delete(handle);
          settle('failed');
        });
        handle.addEventListener('close', () => {
          this.#open.delete(handle);
          settle('failed');
        });
        handle.addEventListener('click', () => {
          // closeAll removes stale account objects and disables their late queued click handlers.
          if (!this.#open.has(handle)) return;
          this.#environment.focus();
          handle.close();
          this.#open.delete(handle);
          onOpen();
        });
      });
    } catch {
      return Promise.resolve('failed');
    }
  }
  closeAll(): void {
    const open = [...this.#open.entries()];
    this.#open.clear();
    for (const [handle, settle] of open) {
      settle();
      handle.close();
    }
  }
}
