import { describe, expect, it } from 'vitest';

import { NodeSqliteDriver } from '../testing/node-driver.node';
import { notificationsMigration } from './017_notifications';
import { schemaMigrations } from './index';
import { runMigrations } from './migration';

const owner = '10000000-0000-4000-8000-000000000001';
const reminder = '21000000-0000-4000-8000-000000000001';
const now = '2026-10-03T09:00:00.000Z';

describe('device notification migration', () => {
  it('preserves canonical rows and adds restrictive owner-scoped operational data', async () => {
    const driver = new NodeSqliteDriver(':memory:');
    try {
      await runMigrations(
        driver,
        schemaMigrations.filter((migration) => migration.version < 17),
        () => now,
      );
      await driver.run(
        `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at) VALUES (?, 'local', ?, ?);`,
        [owner, now, now],
      );
      const before = await driver.all<object>('SELECT * FROM planning_identities;');
      await runMigrations(
        driver,
        [...schemaMigrations.filter((migration) => migration.version < 17), notificationsMigration],
        () => now,
      );
      expect(await driver.all<object>('SELECT * FROM planning_identities;')).toEqual(before);
      await driver.run(`INSERT INTO notification_preferences VALUES (?, 0, 1, ?);`, [owner, now]);
      await expect(
        driver.run(`INSERT INTO notification_preferences VALUES (?, 1, 0, ?);`, ['unknown', now]),
      ).rejects.toThrow();
      await expect(
        driver.run(`UPDATE notification_preferences SET alerts_enabled = 2;`),
      ).rejects.toThrow();
      await driver.run(
        `INSERT INTO notification_receipts (owner_id, reminder_id, reminder_revision, occurrence_key, due_at, observed_at, delivery_status) VALUES (?, ?, 1, '', ?, ?, 'missed');`,
        [owner, reminder, now, now],
      );
      await expect(
        driver.run(
          `INSERT INTO notification_receipts (owner_id, reminder_id, reminder_revision, occurrence_key, due_at, observed_at, delivery_status) VALUES (?, ?, 1, '', ?, ?, 'failed');`,
          [owner, reminder, now, now],
        ),
      ).rejects.toThrow();
      expect(await driver.all('PRAGMA foreign_key_check;')).toEqual([]);
      const plan = await driver.all<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT * FROM notification_receipts WHERE owner_id = ? AND dismissed_at IS NULL ORDER BY observed_at DESC, reminder_id DESC LIMIT 51;',
        [owner],
      );
      expect(plan.map((row) => row.detail).join(' ')).toContain('idx_notification_centre');
    } finally {
      await driver.close();
    }
  });
});
