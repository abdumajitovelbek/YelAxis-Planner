import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { schemaMigrations } from './index';
import { runMigrations } from './migration';
import { NodeSqliteDriver } from '../testing/node-driver.node';

it('upgrades v17 by adding overlap indexes without changing canonical rows or earlier checksums', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-release-indexes-'));
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  try {
    const old = schemaMigrations.filter((migration) => migration.version <= 17);
    await runMigrations(driver, old, () => '2026-10-04T09:00:00.000Z');
    await driver.executeScript(
      "INSERT INTO planning_identities(id,identity_kind,created_at,updated_at) VALUES('10000000-0000-4000-8000-000000000001','local','2026-10-04T09:00:00.000Z','2026-10-04T09:00:00.000Z');",
    );
    const before = await driver.all('SELECT * FROM planning_identities');
    const ledger = await driver.all('SELECT * FROM _schema_migrations ORDER BY version');
    await runMigrations(driver, schemaMigrations.slice(0, 18), () => '2026-10-04T09:00:00.000Z');
    expect(await driver.all('SELECT * FROM planning_identities')).toEqual(before);
    expect(
      (await driver.all('SELECT * FROM _schema_migrations ORDER BY version')).slice(0, 17),
    ).toEqual(ledger);
    expect(await driver.get('PRAGMA user_version')).toEqual({ user_version: 18 });
    const indexes = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type='index' AND name IN ('idx_time_blocks_overlap_end','idx_placements_overlap_end','idx_week_selections_overlap_end','idx_routine_occurrences_overlap_end')",
    );
    expect(indexes.map((row) => row.name).sort()).toEqual([
      'idx_placements_overlap_end',
      'idx_routine_occurrences_overlap_end',
      'idx_time_blocks_overlap_end',
      'idx_week_selections_overlap_end',
    ]);
  } finally {
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
});
