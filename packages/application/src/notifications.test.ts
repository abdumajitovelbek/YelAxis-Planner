import type { Instant, OwnerId, UUID } from '@yelaxis/domain';
import { describe, expect, it, vi } from 'vitest';

import { createNotificationApplication } from './notifications';
import type {
  NotificationCandidate,
  NotificationPayload,
  NotificationPreferences,
  NotificationReceipt,
  NotificationStorePort,
  NotificationTransaction,
} from './notifications-contracts';
import { createSerialQueue } from './planning-kit';

const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
const now = '2026-10-03T09:00:00.000Z' as Instant;
const candidate: NotificationCandidate = {
  reminderId: '21000000-0000-4000-8000-000000000001' as UUID,
  reminderRevision: 1,
  occurrenceKey: '',
  dueAt: now,
  title: 'Synthetic private title',
  href: '/actions/16000000-0000-4000-8000-000000000001',
};
function fixture() {
  let preferences: NotificationPreferences = { alertsEnabled: false, privacyMode: true };
  const receipts = new Map<string, NotificationReceipt>();
  let permitted: 'default' | 'granted' | 'denied' = 'granted';
  let activeOwner: OwnerId = owner;
  let available = true;
  const transaction: NotificationTransaction = {
    setPreferences(_owner, value) {
      preferences = value;
      return Promise.resolve();
    },
    claim(_owner, receipt) {
      const key = `${receipt.reminderId}:${receipt.reminderRevision}:${receipt.occurrenceKey}`;
      if (receipts.has(key)) return Promise.resolve(false);
      receipts.set(key, receipt);
      return Promise.resolve(true);
    },
    setDeliveryStatus(_owner, key, deliveryStatus) {
      const id = `${key.reminderId}:${key.reminderRevision}:${key.occurrenceKey}`;
      const current = receipts.get(id);
      if (current !== undefined) receipts.set(id, { ...current, deliveryStatus });
      return Promise.resolve();
    },
    async markRead() {},
    async dismiss() {},
    async setRoutineCursor() {},
  };
  const store: NotificationStorePort = {
    transaction: async (work) => work(transaction),
    getPreferences: () => Promise.resolve(preferences),
    listDue: () => Promise.resolve(available ? [candidate] : []),
    listRoutines: () => Promise.resolve([]),
    getPlanningZone: vi.fn(),
    getMaterialized: vi.fn(),
    listCentre: () =>
      Promise.resolve(
        [...receipts.values()].map((receipt) => ({
          ...receipt,
          title: candidate.title,
          href: candidate.href,
        })),
      ),
    resolve: () => Promise.resolve(available ? candidate : null),
  };
  const notifications = {
    permission: () => permitted,
    requestPermission: vi.fn(() => Promise.resolve(permitted)),
    show: vi.fn((_payload: NotificationPayload, _onOpen: () => void) => {
      void _payload;
      void _onOpen;
      return Promise.resolve('delivered' as const);
    }),
    closeAll: vi.fn(),
  };
  const navigate = vi.fn();
  const queue = createSerialQueue();
  const app = createNotificationApplication({
    store,
    notifications,
    clock: { now: () => now },
    queue,
    identity: {
      getActiveIdentity: () => Promise.resolve({ ownerId: activeOwner, syncEnabled: false }),
    },
    navigate,
  });
  return {
    app,
    queue,
    store,
    notifications,
    receipts,
    navigate,
    grant: (value: typeof permitted) => {
      permitted = value;
    },
    switchOwner: () => {
      activeOwner = '10000000-0000-4000-8000-000000000002' as OwnerId;
    },
    finish: () => {
      available = false;
    },
  };
}

describe('open-app notification application', () => {
  it('defaults to centre-only generic privacy without asking permission', async () => {
    const f = fixture();
    await f.app.reconcile();
    expect(f.receipts.size).toBe(1);
    expect([...f.receipts.values()][0]?.deliveryStatus).toBe('centre');
    expect(f.notifications.requestPermission).not.toHaveBeenCalled();
    expect(f.notifications.show).not.toHaveBeenCalled();
  });
  it('persists a dedupe claim before generic dispatch and never dispatches twice', async () => {
    const f = fixture();
    await f.app.setPreferences({ alertsEnabled: true, privacyMode: true });
    f.notifications.show.mockImplementationOnce((payload) => {
      expect(f.receipts.size).toBe(1);
      expect(payload.title).toBe('YelAxis Planner reminder');
      expect(payload.body).not.toContain(candidate.title);
      return Promise.resolve('delivered' as const);
    });
    await f.app.reconcile();
    await f.app.reconcile();
    expect(f.notifications.show).toHaveBeenCalledTimes(1);
    expect([...f.receipts.values()][0]?.deliveryStatus).toBe('delivered');
  });
  it('refuses sensitive title exposure without explicit confirmation and validates extra input', async () => {
    const f = fixture();
    await expect(f.app.setPreferences({ alertsEnabled: true, privacyMode: false })).rejects.toThrow(
      'preview',
    );
    await expect(
      f.app.setPreferences({ alertsEnabled: false, privacyMode: true, other: true }),
    ).rejects.toThrow();
    await f.app.setPreferences({
      alertsEnabled: true,
      privacyMode: false,
      confirmTitleExposure: true,
    });
    await f.app.reconcile();
    expect(f.notifications.show.mock.calls[0]?.[0]?.body).toBe(candidate.title);
  });
  it('denied permission and delivery failure leave centre receipts and targets intact', async () => {
    const f = fixture();
    f.grant('denied');
    await expect(f.app.setPreferences({ alertsEnabled: true, privacyMode: true })).rejects.toThrow(
      'permission',
    );
    await f.app.reconcile();
    expect(f.receipts.size).toBe(1);
    expect(f.notifications.show).not.toHaveBeenCalled();
    const fail = fixture();
    await fail.app.setPreferences({ alertsEnabled: true, privacyMode: true });
    fail.notifications.show.mockRejectedValueOnce(new Error('adapter failure'));
    await fail.app.reconcile();
    expect([...fail.receipts.values()][0]?.deliveryStatus).toBe('failed');
    expect((await fail.app.getView()).items).toHaveLength(1);
  });
  it('suppresses finished targets and closes outstanding objects on stop/identity change', async () => {
    const f = fixture();
    f.finish();
    await f.app.reconcile();
    expect(f.receipts.size).toBe(0);
    expect(await f.app.openTarget(candidate)).toBeNull();
    const switched = fixture();
    await switched.app.getView();
    switched.switchOwner();
    await expect(switched.app.reconcile()).rejects.toThrow('closed');
    expect(switched.notifications.closeAll).toHaveBeenCalled();
    switched.app.stop();
    await expect(switched.app.reconcile()).rejects.toThrow('closed');
  });
  it('reports local reconciliation failures safely and recovers on an explicit retry', async () => {
    const f = fixture();
    const original = f.store.transaction.bind(f.store);
    f.store.transaction = () => Promise.reject(new Error('synthetic private failure'));
    await expect(f.app.reconcile()).rejects.toThrow('Due reminders could not be refreshed');
    expect((await f.app.getView()).reconciliationError).not.toContain('private failure');
    expect(f.notifications.show).not.toHaveBeenCalled();
    f.store.transaction = original;
    await f.app.reconcile();
    expect((await f.app.getView()).reconciliationError).toBeNull();
  });
  it('calls the permission port immediately from the gesture and only enables on a grant', async () => {
    const f = fixture();
    f.grant('denied');
    const result = f.app.requestPermission();
    expect(f.notifications.requestPermission).toHaveBeenCalledOnce();
    expect(await result).toBe('denied');
    expect((await f.app.getView()).preferences.alertsEnabled).toBe(false);
  });
  it('leaves the shared planning queue available during OS waits and keeps the durable claim unique', async () => {
    const f = fixture();
    await f.app.setPreferences({ alertsEnabled: true, privacyMode: true });
    let release: ((value: 'delivered') => void) | undefined;
    const pending = new Promise<'delivered'>((resolve) => {
      release = resolve;
    });
    f.notifications.show.mockReturnValueOnce(pending);
    const first = f.app.reconcile();
    await vi.waitFor(() => expect(f.notifications.show).toHaveBeenCalledOnce());
    // This normal queue command completes while show() remains unresolved.
    const planningCommand = await f.queue.run(() => Promise.resolve('planning committed'));
    expect(planningCommand).toBe('planning committed');
    await f.app.reconcile();
    expect(f.notifications.show).toHaveBeenCalledOnce();
    const lateOpen = f.notifications.show.mock.calls[0]?.[1];
    f.switchOwner();
    await expect(f.app.getView()).rejects.toThrow('closed');
    lateOpen?.();
    expect(f.navigate).not.toHaveBeenCalled();
    release?.('delivered');
    await first;
    expect(f.notifications.closeAll).toHaveBeenCalled();
    expect(f.receipts.size).toBe(1);
  });
});
