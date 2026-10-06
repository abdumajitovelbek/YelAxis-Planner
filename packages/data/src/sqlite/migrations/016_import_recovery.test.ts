import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeSqliteDriver } from '../testing/node-driver.node';
import { schemaMigrations } from './index';
import { runMigrations } from './migration';
import { importRecoveryMigration } from './016_import_recovery';

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const at = '2026-10-03T00:00:00.000Z';
const owner = 'cc000000-0000-4000-8000-000000000001';

describe('migration 16 durable import preview and retained recovery backups', () => {
  it('upgrades without changing canonical rows and retains journal and backup across restart', async () => {
    const path = await mkdtemp(join(tmpdir(), 'yelaxis-import-migration-'));
    paths.push(path);
    const file = join(path, 'plan.sqlite');
    let driver = new NodeSqliteDriver(file);
    await runMigrations(
      driver,
      schemaMigrations.filter((source) => source.version < 16),
      () => at,
    );
    await driver.run(
      "INSERT INTO planning_identities (id, identity_kind, created_at, updated_at) VALUES (?, 'local', ?, ?);",
      [owner, at, at],
    );
    await driver.run(
      "INSERT INTO actions (id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at) VALUES (?, ?, 'Preserved', 'planned', 'plan', 'a', ?, ?);",
      ['cc000000-0000-4000-8000-000000000002', owner, at, at],
    );
    const before = await driver.all('SELECT * FROM actions;');
    await runMigrations(
      driver,
      [...schemaMigrations.filter((source) => source.version < 16), importRecoveryMigration],
      () => at,
    );
    expect(await driver.all('SELECT * FROM actions;')).toEqual(before);
    await driver.run(
      'INSERT INTO import_journal (id, owner_id, bundle_json, mode, decisions_json, remap_json, destination_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
      [
        'cc000000-0000-4000-8000-000000000003',
        owner,
        '{}',
        'merge',
        '[]',
        '{}',
        'a'.repeat(64),
        at,
        at,
      ],
    );
    await driver.run(
      'INSERT INTO import_recovery_backups (id, owner_id, bundle_json, data_sha256, record_count, verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
      ['cc000000-0000-4000-8000-000000000004', owner, '{}', 'a'.repeat(64), 1, at, at, at],
    );
    await driver.close();
    driver = new NodeSqliteDriver(file);
    expect(
      await driver.get('SELECT mode FROM import_journal WHERE owner_id = ?;', [owner]),
    ).toEqual({ mode: 'merge' });
    expect(
      await driver.get('SELECT record_count FROM import_recovery_backups WHERE owner_id = ?;', [
        owner,
      ]),
    ).toEqual({ record_count: 1 });
    await expect(
      driver.run('DELETE FROM planning_identities WHERE id = ?;', [owner]),
    ).rejects.toThrow();
    await driver.close();
  });
});
