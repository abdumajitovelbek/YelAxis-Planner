// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserNotifications } from './browser-notifications';

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn((): Promise<NotificationPermission> =>
    Promise.resolve('granted'),
  );
  static handles: FakeNotification[] = [];
  readonly listeners = new Map<string, () => void>();
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    FakeNotification.handles.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string) {
    this.listeners.get(type)?.();
  }
}
afterEach(() => {
  vi.useRealTimers();
  FakeNotification.permission = 'default';
  FakeNotification.handles = [];
  FakeNotification.requestPermission.mockClear();
});
const payload = {
  title: 'YelAxis Planner reminder',
  body: 'A reminder is due. Open YelAxis Planner to view it.',
  tag: 'synthetic',
};
describe('open-page browser notifications adapter', () => {
  it('never asks permission during construction, query or denied dispatch', async () => {
    const adapter = new BrowserNotifications({
      Notification: FakeNotification,
      secure: true,
      focus: vi.fn(),
    });
    expect(adapter.permission()).toBe('default');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    FakeNotification.permission = 'denied';
    expect(await adapter.show(payload, vi.fn())).toBe('failed');
    expect(await adapter.requestPermission()).toBe('denied');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });
  it('requires secure supported API and asks only through explicit request', async () => {
    const absent = new BrowserNotifications({ secure: true, focus: vi.fn() });
    expect(absent.permission()).toBe('unsupported');
    const insecure = new BrowserNotifications({
      Notification: FakeNotification,
      secure: false,
      focus: vi.fn(),
    });
    expect(await insecure.requestPermission()).toBe('unsupported');
    const adapter = new BrowserNotifications({
      Notification: FakeNotification,
      secure: true,
      focus: vi.fn(),
    });
    expect(await adapter.requestPermission()).toBe('granted');
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
  it('dispatches exact preview content, confirms platform show, focuses safely on click', async () => {
    FakeNotification.permission = 'granted';
    const focus = vi.fn();
    const onOpen = vi.fn();
    const adapter = new BrowserNotifications({
      Notification: FakeNotification,
      secure: true,
      focus,
    });
    const result = adapter.show(payload, onOpen);
    const handle = FakeNotification.handles[0];
    expect(handle?.title).toBe(payload.title);
    expect(handle?.options).toEqual({ body: payload.body, tag: payload.tag, silent: true });
    handle?.emit('show');
    expect(await result).toBe('delivered');
    handle?.emit('click');
    expect(focus).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });
  it('fails on platform error or timeout without any service worker data', async () => {
    FakeNotification.permission = 'granted';
    vi.useFakeTimers();
    const adapter = new BrowserNotifications({
      Notification: FakeNotification,
      secure: true,
      focus: vi.fn(),
    });
    const failed = adapter.show(payload, vi.fn());
    FakeNotification.handles[0]?.emit('error');
    expect(await failed).toBe('failed');
    const timed = adapter.show(payload, vi.fn());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await timed).toBe('failed');
  });
  it('closes account objects and suppresses late clicks after stop', async () => {
    FakeNotification.permission = 'granted';
    const onOpen = vi.fn();
    const adapter = new BrowserNotifications({
      Notification: FakeNotification,
      secure: true,
      focus: vi.fn(),
    });
    const result = adapter.show(payload, onOpen);
    const handle = FakeNotification.handles[0];
    adapter.closeAll();
    expect(await result).toBe('failed');
    handle?.emit('click');
    expect(onOpen).not.toHaveBeenCalled();
    expect(handle?.close).toHaveBeenCalled();
  });
});
