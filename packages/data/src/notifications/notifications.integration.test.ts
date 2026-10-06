import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createNotificationApplication,
  createPlanningApplication,
  createSerialQueue,
  type NotificationPayload,
  type NotificationPermissionStatus,
  type NotificationReceipt,
} from '@yelaxis/application';
import type { CalendarDate, Instant, OwnerId, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSqliteApplicationAdapters } from '../application/sqlite-adapters';
import { SqlitePlanningQueries } from '../queries/planning-queries';
import { notificationsMigration } from '../sqlite/migrations/017_notifications';
import { schemaMigrations } from '../sqlite/migrations/index';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { SqliteNotificationStore } from './sqlite-notification-store';

const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
const other = '10000000-0000-4000-8000-000000000002' as OwnerId;
const start = '2026-10-03T09:00:00.000Z' as Instant;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-notifications-'));
  directories.push(directory);
  const path = join(directory, 'plan.sqlite');
  let driver = new NodeSqliteDriver(path);
  let now = start;
  const migrate = async () => {
    await runMigrations(driver, schemaMigrations, () => now);
    if (!schemaMigrations.some((migration) => migration.version === 17))
      await driver.executeScript(notificationsMigration.sql);
  };
  await migrate();
  for (const [index, identity] of [owner, other].entries()) {
    await driver.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at) VALUES (?, 'local', ?, ?);`,
      [identity, now, now],
    );
    await driver.run(
      `INSERT INTO profiles (id, owner_id, planning_time_zone, week_start, time_format, created_at, updated_at) VALUES (?, ?, 'UTC', 'monday', '24_hour', ?, ?);`,
      [`11000000-0000-4000-8000-00000000000${String(index + 1)}`, identity, now, now],
    );
  }
  const notifications = {
    permission: (): NotificationPermissionStatus => 'granted',
    requestPermission: vi.fn((): Promise<NotificationPermissionStatus> =>
      Promise.resolve('granted'),
    ),
    show: vi.fn((_payload: NotificationPayload, _onOpen: () => void) => {
      void _payload;
      void _onOpen;
      return Promise.resolve('delivered' as const);
    }),
    closeAll: vi.fn(),
  };
  const build = (identity = owner) => {
    const store = new SqliteNotificationStore(driver);
    const adapters = createSqliteApplicationAdapters(driver, { ownerId: identity });
    const queue = createSerialQueue();
    let counter = 20;
    return {
      store,
      app: createNotificationApplication({
        store,
        notifications,
        identity: adapters.identityContext,
        clock: { now: () => now },
        queue,
        navigate: vi.fn(),
      }),
      planning: createPlanningApplication(
        {
          ...adapters,
          ids: {
            next: () => `97000000-0000-4000-8000-${String(counter++).padStart(12, '0')}` as UUID,
          },
          clock: { now: () => now },
          projections: { notifyCommitted() {} },
        },
        new SqlitePlanningQueries(driver),
        { queue },
      ),
    };
  };
  async function action(index = 1, identity = owner, due = now) {
    const id = `16000000-0000-4000-8000-${String(index).padStart(12, '0')}` as UUID;
    const reminderId = `21000000-0000-4000-8000-${String(index).padStart(12, '0')}` as UUID;
    await driver.run(
      `INSERT INTO actions (id, owner_id, title, state, sort_key, capture_origin, created_at, updated_at) VALUES (?, ?, ?, 'scheduled', ?, 'plan', ?, ?);`,
      [id, identity, `Synthetic ${String(index)}`, String(index).padStart(15, '0'), now, now],
    );
    await driver.run(
      `INSERT INTO reminders (id, owner_id, action_id, schedule_kind, remind_at_utc, time_zone, state, created_at, updated_at) VALUES (?, ?, ?, 'at', ?, 'UTC', 'scheduled', ?, ?);`,
      [reminderId, identity, id, due, now, now],
    );
    return { id, reminderId, reminderRevision: 1, occurrenceKey: '' };
  }
  return {
    get driver() {
      return driver;
    },
    build,
    action,
    notifications,
    setNow(value: Instant) {
      now = value;
    },
    async restart() {
      await driver.close();
      driver = new NodeSqliteDriver(path);
      return build();
    },
  };
}

describe('owner-scoped device notifications over real SQLite', () => {
  it('does not open a durable transaction for an empty reminder poll', async () => {
    const f = await fixture();
    const { app, store } = f.build();
    const transaction = vi.spyOn(store, 'transaction');
    await app.reconcile();
    await app.reconcile();
    expect(transaction).not.toHaveBeenCalled();
    expect(await f.driver.all('SELECT * FROM notification_receipts;')).toEqual([]);
    await f.driver.close();
  });
  it('quarantines corrupt device receipts without hiding later valid rows or changing canonical data', async () => {
    const f = await fixture();
    for (let n = 1; n <= 54; n++) await f.action(n);
    const { app } = f.build();
    await app.reconcile();
    await app.reconcile();
    const canonical = await f.driver.all('SELECT * FROM actions;');
    const definitions = await f.driver.all('SELECT * FROM reminders;');
    await f.driver.run(
      "UPDATE notification_receipts SET due_at = 'invalid-synthetic-instant' WHERE reminder_id NOT IN (?, ?);",
      ['21000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000054'],
    );
    const original = await f.driver.all('SELECT * FROM notification_receipts;');
    const view = await app.getView();
    expect(view.items).toHaveLength(2);
    expect(view).toHaveProperty('quarantinedReceiptCount', 52);
    expect(view.nextPage).toBeNull();
    await app.reconcile();
    expect(f.notifications.show).not.toHaveBeenCalled();
    expect(await f.driver.all('SELECT * FROM notification_receipts;')).toEqual(original);
    expect(await f.driver.all('SELECT * FROM actions;')).toEqual(canonical);
    expect(await f.driver.all('SELECT * FROM reminders;')).toEqual(definitions);
    const restarted = await f.restart();
    expect(await restarted.app.getView()).toHaveProperty('quarantinedReceiptCount', 52);
    expect((await f.build(other).app.getView()).items).toEqual([]);
    expect(await f.build(other).app.getView()).toHaveProperty('quarantinedReceiptCount', 0);
    await f.driver.close();
  });
  it('quarantines malformed read/observed timestamps while keeping normal planning usable', async () => {
    const f = await fixture();
    const key = await f.action();
    const { app, planning } = f.build();
    await app.reconcile();
    await f.driver.run(
      "UPDATE notification_receipts SET read_at = 'invalid-synthetic-instant' WHERE owner_id = ?;",
      [owner],
    );
    expect((await app.getView()).items).toEqual([]);
    expect(await app.getView()).toHaveProperty('quarantinedReceiptCount', 1);
    expect(await planning.getDayPlan('2026-10-03')).toBeDefined();
    expect(await f.driver.get('SELECT id FROM actions WHERE id = ?;', [key.id])).toBeDefined();
    await f.driver.close();
  });
  it('deduplicates through restart and retains canonical definitions unchanged', async () => {
    const f = await fixture();
    const key = await f.action();
    const { app } = f.build();
    const before = await f.driver.all('SELECT * FROM reminders;');
    await app.setPreferences({ alertsEnabled: true, privacyMode: true });
    await app.reconcile();
    const restarted = await f.restart();
    await restarted.app.reconcile();
    expect(f.notifications.show).toHaveBeenCalledTimes(1);
    expect(await f.driver.all('SELECT * FROM reminders;')).toEqual(before);
    expect((await restarted.app.getView()).items[0]).toMatchObject({
      reminderId: key.reminderId,
      reminderRevision: 1,
      occurrenceKey: '',
      deliveryStatus: 'delivered',
      readAt: null,
    });
    await restarted.app.markRead(key);
    expect((await restarted.app.getView()).items[0]?.readAt).toBe(start);
    await restarted.app.dismiss(key);
    expect((await restarted.app.getView()).items).toHaveLength(0);
    await f.driver.close();
  });
  it('keeps missed reminders after reopening without a storm of OS alerts', async () => {
    const f = await fixture();
    await f.action(1, owner, '2026-10-02T09:00:00.000Z' as Instant);
    const { app } = f.build();
    await app.setPreferences({ alertsEnabled: true, privacyMode: true });
    await app.reconcile();
    expect((await app.getView()).items[0]?.deliveryStatus).toBe('missed');
    expect(f.notifications.show).not.toHaveBeenCalled();
    await f.driver.close();
  });
  it('keeps owners isolated in centre, preferences and explicit read/dismiss writes', async () => {
    const f = await fixture();
    const a = await f.action();
    const b = await f.action(2, other);
    const local = f.build();
    const second = f.build(other);
    await local.app.reconcile();
    await second.app.reconcile();
    await local.app.markRead(b);
    await local.app.dismiss(b);
    expect((await local.app.getView()).items.map((row) => row.reminderId)).toEqual([a.reminderId]);
    expect((await second.app.getView()).items[0]?.readAt).toBeNull();
    await local.app.setPreferences({
      alertsEnabled: true,
      privacyMode: false,
      confirmTitleExposure: true,
    });
    expect((await second.app.getView()).preferences).toEqual({
      alertsEnabled: false,
      privacyMode: true,
    });
    await f.driver.close();
  });
  it('suppresses finished/canceled/archived targets and missing safe links without writing definitions', async () => {
    const f = await fixture();
    const key = await f.action();
    const { app } = f.build();
    await app.reconcile();
    await f.driver.run(`UPDATE actions SET state = 'completed', completed_at = ? WHERE id = ?;`, [
      start,
      key.id,
    ]);
    expect(await app.openTarget(key)).toBeNull();
    expect((await app.getView()).items[0]?.href).toBeNull();
    expect((await app.getView()).items[0]?.title).toBe('Reminder no longer available');
    await app.reconcile();
    expect(f.notifications.show).not.toHaveBeenCalled();
    expect(
      await f.driver.get<{ state: string }>('SELECT state FROM reminders WHERE id = ?;', [
        key.reminderId,
      ]),
    ).toEqual({ state: 'scheduled' });
    await f.driver.close();
  });
  it('bounds due/centre queries and traverses all receipts in stable pages', async () => {
    const f = await fixture();
    for (let index = 1; index <= 55; index += 1) await f.action(index);
    const { app } = f.build();
    await app.reconcile();
    expect((await app.getView()).items).toHaveLength(50);
    await app.reconcile();
    const page = await app.getView();
    expect(page.items).toHaveLength(50);
    expect(page.nextPage).not.toBeNull();
    const next = await app.getView(page.nextPage);
    expect(next.items).toHaveLength(5);
    expect(next.nextPage).toBeNull();
    expect(new Set([...page.items, ...next.items].map((item) => item.reminderId)).size).toBe(55);
    await f.driver.close();
  });
  it('rolls back failed receipt transactions and never copies planning content', async () => {
    const f = await fixture();
    const key = await f.action();
    const { store } = f.build();
    const receipt: NotificationReceipt = {
      ...key,
      dueAt: start,
      observedAt: start,
      deliveryStatus: 'centre',
      readAt: null,
      dismissedAt: null,
    };
    await expect(
      store.transaction(async (transaction) => {
        await transaction.claim(owner, receipt);
        throw new Error('simulated local persistence failure');
      }),
    ).rejects.toThrow('persistence');
    expect(await store.listCentre(owner, null, 50)).toEqual([]);
    await store.transaction((transaction) => transaction.claim(owner, receipt));
    const rows = await f.driver.all<Record<string, unknown>>(
      'SELECT * FROM notification_receipts;',
    );
    expect(JSON.stringify(rows)).not.toContain('Synthetic');
    await f.driver.close();
  });
  it('resolves every later timed Routine occurrence and deduplicates after restart', async () => {
    const f = await fixture();
    f.setNow('2026-10-03T08:00:00.000Z' as Instant);
    const { app, planning } = f.build();
    const created = await planning.createRoutine({
      title: 'Synthetic daily routine',
      rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-10-03' },
      schedulingMode: {
        kind: 'time_specific',
        wallTime: '09:00',
        durationMinutes: 30,
        zonePolicy: { kind: 'follow_profile' },
        gapPolicy: 'shift_forward',
        overlapPolicy: 'earlier_offset',
      },
      reminder: { minutesBefore: 0 },
    });
    expect(created.ok).toBe(true);
    await app.setPreferences({ alertsEnabled: true, privacyMode: true });
    f.setNow(start);
    await app.reconcile();
    expect(f.notifications.show).toHaveBeenCalledTimes(1);
    const first = (await app.getView()).items[0];
    expect(first?.occurrenceKey).not.toBe('');
    const next = await f.restart();
    f.setNow('2026-10-04T09:00:00.000Z' as Instant);
    await next.app.reconcile();
    expect(f.notifications.show).toHaveBeenCalledTimes(2);
    await next.app.reconcile();
    expect(f.notifications.show).toHaveBeenCalledTimes(2);
    const items = (await next.app.getView()).items;
    expect(items).toHaveLength(2);
    expect(items[0]?.occurrenceKey).not.toBe(first?.occurrenceKey);
    await f.driver.close();
  });
  it('suppresses completed/skipped Routine occurrences while retaining later occurrences', async () => {
    const f = await fixture();
    f.setNow('2026-10-03T08:00:00.000Z' as Instant);
    const { app, planning } = f.build();
    const created = await planning.createRoutine({
      title: 'Synthetic routine with completed occurrence',
      rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-10-03' },
      schedulingMode: {
        kind: 'time_specific',
        wallTime: '09:00',
        durationMinutes: 30,
        zonePolicy: { kind: 'follow_profile' },
        gapPolicy: 'shift_forward',
        overlapPolicy: 'earlier_offset',
      },
      reminder: { minutesBefore: 0 },
    });
    if (!created.ok) throw new Error('Synthetic routine could not be created.');
    const routineId = created.value.canonical.find((row) => row.ref.type === 'routine')?.ref.id;
    if (routineId === undefined) throw new Error('Routine ID unavailable.');
    expect(
      (
        await planning.completeOccurrence({
          occurrence: {
            routineId,
            generation: 1,
            period: { kind: 'date', date: '2026-10-03' as CalendarDate },
          },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await planning.skipOccurrence({
          occurrence: {
            routineId,
            generation: 1,
            period: { kind: 'date', date: '2026-10-04' as CalendarDate },
          },
        })
      ).ok,
    ).toBe(true);
    await app.setPreferences({ alertsEnabled: true, privacyMode: true });
    f.setNow(start);
    await app.reconcile();
    expect(f.notifications.show).not.toHaveBeenCalled();
    f.setNow('2026-10-04T09:00:00.000Z' as Instant);
    await app.reconcile();
    expect(f.notifications.show).not.toHaveBeenCalled();
    f.setNow('2026-10-05T09:00:00.000Z' as Instant);
    await app.reconcile();
    expect(f.notifications.show).toHaveBeenCalledOnce();
    expect((await app.getView()).items).toHaveLength(1);
    await f.driver.close();
  });
  it('allows explicit reminder rescheduling with a new revision, never retries an old claim', async () => {
    const f = await fixture();
    const key = await f.action();
    const { app } = f.build();
    await app.setPreferences({ alertsEnabled: true, privacyMode: true });
    await app.reconcile();
    await f.driver.run(
      'UPDATE reminders SET local_revision = local_revision + 1, remind_at_utc = ? WHERE id = ?;',
      ['2026-10-03T10:00:00.000Z', key.reminderId],
    );
    await app.reconcile();
    expect(f.notifications.show).toHaveBeenCalledOnce();
    f.setNow('2026-10-03T10:00:00.000Z' as Instant);
    await app.reconcile();
    expect(f.notifications.show).toHaveBeenCalledTimes(2);
    const rows = await f.driver.all<{ reminder_revision: number }>(
      'SELECT reminder_revision FROM notification_receipts ORDER BY reminder_revision;',
    );
    expect(rows).toEqual([{ reminder_revision: 1 }, { reminder_revision: 2 }]);
    await f.driver.close();
  });
  it('resolves Time Block and saved Review targets safely, then suppresses their finished states', async () => {
    const f = await fixture();
    const { app, planning } = f.build();
    const created = await planning.createCustomBlock({
      title: 'Synthetic fixed block',
      date: '2026-10-03',
      startTime: '10:00',
      durationMinutes: 30,
      overlapAcknowledged: false,
    });
    if (!created.ok) throw new Error('Synthetic block could not be created.');
    const blockId = created.value.canonical.find((row) => row.ref.type === 'time_block')?.ref.id;
    if (blockId === undefined) throw new Error('Synthetic block ID unavailable.');
    expect(
      (
        await planning.setTimeBlockReminder({
          blockId,
          revision: 1,
          reminder: { kind: 'at', date: '2026-10-03', time: '09:00' },
        })
      ).ok,
    ).toBe(true);
    const reviewId = '20000000-0000-4000-8000-000000000001';
    const reviewReminderId = '21000000-0000-4000-8000-000000000199';
    await f.driver.run(
      `INSERT INTO review_checkpoints (id, owner_id, profile_id, review_type, period_key, period_start_date, period_end_date, state, created_at, updated_at)
      VALUES (?, ?, '11000000-0000-4000-8000-000000000001', 'daily', '2026-10-03', '2026-10-03', '2026-10-03', 'draft', ?, ?);`,
      [reviewId, owner, start, start],
    );
    await f.driver.run(
      `INSERT INTO reminders (id, owner_id, review_id, schedule_kind, remind_at_utc, time_zone, state, created_at, updated_at) VALUES (?, ?, ?, 'at', ?, 'UTC', 'scheduled', ?, ?);`,
      [reviewReminderId, owner, reviewId, start, start, start],
    );
    await app.reconcile();
    const items = (await app.getView()).items;
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.title === 'Synthetic fixed block')?.href).toBe(
      '/plan/day/2026-10-03',
    );
    expect(items.find((item) => item.title === 'daily review')?.href).toBe('/end-day/2026-10-03');
    await f.driver.run(`UPDATE time_blocks SET state = 'completed' WHERE id = ?;`, [blockId]);
    await f.driver.run(
      `UPDATE review_checkpoints SET state = 'completed', completed_at = ? WHERE id = ?;`,
      [start, reviewId],
    );
    expect((await app.getView()).items.every((item) => item.href === null)).toBe(true);
    expect(await f.driver.all<{ state: string }>('SELECT state FROM reminders;')).toEqual([
      { state: 'scheduled' },
      { state: 'scheduled' },
    ]);
    await f.driver.close();
  });
});
