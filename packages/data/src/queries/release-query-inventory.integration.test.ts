import { expect, it, vi } from 'vitest';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { planningQuerySql } from './planning-queries';
import { todayQuerySql } from './today-queries';
import { reviewQuerySql } from './review-queries';
import {
  listActionBlockHistory,
  listInboxActions,
  listOutboxDispatchPage,
  listTimeBlocksInWindow,
} from './core-queries';
import type { SqliteParameter } from '../sqlite/driver';
import { syncSql } from '../sync/sync-sql';

const owner = '10000000-0000-4000-8000-000000000001';

it('inventories every Plan/Today read: owner predicates, bounded pages or unique/count lookups, and indexed access', async () => {
  const driver = new NodeSqliteDriver(':memory:');
  try {
    await runMigrations(driver, schemaMigrations, () => '2026-10-04T09:00:00.000Z');
    for (const [surface, statements] of [
      ['Plan', planningQuerySql],
      ['Today', todayQuerySql],
      ['Review', flatten(reviewQuerySql)],
    ] as const) {
      for (const [name, sql] of Object.entries(statements)) {
        const label = `${surface}.${name}`;
        expect(sql, label).toMatch(/owner_id\s*=\s*\?/u);
        expect(sql, label).toMatch(/LIMIT (?:\d+|\?)|COUNT\(\*\)|\bid\s*=\s*\?/u);
        const parameters = Array.from({ length: (sql.match(/\?/gu) ?? []).length }, () => owner);
        const plans = await driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters);
        const plan = plans.map((row) => row.detail).join('\n');
        expect(plan, label).toMatch(
          /SEARCH .+ USING (?:INDEX|COVERING INDEX|INTEGER PRIMARY KEY)/u,
        );
        expect(plan, label).not.toMatch(
          /\bSCAN (?:actions|time_blocks|planning_placements|week_selections|routine_occurrences|profiles|a|b|p|w|o|r)\b/u,
        );
      }
    }
    // History and sync's acknowledged cursor keep their existing owner/unique/index boundaries.
    const checkpoint = await driver.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${syncSql.readCheckpoint}`,
      [owner, owner],
    );
    expect(checkpoint.map((row) => row.detail).join(' ')).toMatch(
      /sqlite_autoindex_sync_checkpoints_\d|idx_sync_checkpoints_cursor/u,
    );
  } finally {
    await driver.close();
  }
});

it('inventories first/cursor Inbox, time-window/history and outbox pages without full table scans', async () => {
  const driver = new NodeSqliteDriver(':memory:');
  try {
    await runMigrations(driver, schemaMigrations, () => '2026-10-04T09:00:00.000Z');
    const captured: { sql: string; parameters: readonly SqliteParameter[] }[] = [];
    const original = driver.all.bind(driver);
    vi.spyOn(driver, 'all').mockImplementation(async (sql, parameters = []) => {
      captured.push({ sql, parameters });
      return original(sql, parameters);
    });
    for (const after of [undefined, { sortKey: 'a', id: owner }])
      await listInboxActions(driver, {
        ownerId: owner,
        limit: 50,
        ...(after === undefined ? {} : { after }),
      });
    for (const after of [undefined, { startsAtUtc: '2026-10-04T00:00:00.000Z', id: owner }]) {
      await listTimeBlocksInWindow(driver, {
        ownerId: owner,
        startsBeforeUtc: '2026-10-05T00:00:00.000Z',
        endsAfterUtc: '2026-10-04T00:00:00.000Z',
        limit: 50,
        ...(after === undefined ? {} : { after }),
      });
      await listActionBlockHistory(driver, {
        ownerId: owner,
        actionId: owner,
        limit: 50,
        ...(after === undefined ? {} : { before: after }),
      });
    }
    for (const after of [undefined, { mutationGroupId: owner, sequence: 1, id: owner }])
      await listOutboxDispatchPage(driver, {
        ownerId: owner,
        readyAt: '2026-10-04T09:00:00.000Z',
        limit: 50,
        ...(after === undefined ? {} : { after }),
      });
    expect(captured).toHaveLength(8);
    for (const { sql, parameters } of captured) {
      expect(sql).toMatch(/LIMIT \?/u);
      const plans = await original<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters);
      const plan = plans.map((row) => row.detail).join(' ');
      expect(plan).toMatch(/SEARCH .+ USING (?:INDEX|COVERING INDEX)/u);
      expect(plan).not.toMatch(/\bSCAN (?:actions|time_blocks|sync_outbox)\b/u);
    }
  } finally {
    vi.restoreAllMocks();
    await driver.close();
  }
});

function flatten(input: Readonly<Record<string, unknown>>, prefix = ''): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      typeof value === 'string'
        ? [[prefix + key, value]]
        : Object.entries(flatten(value as Readonly<Record<string, unknown>>, prefix + key + '.')),
    ),
  );
}
