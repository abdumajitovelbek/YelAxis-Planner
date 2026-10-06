import { afterEach, expect, it } from 'vitest';

import type { SearchRequest } from '@yelaxis/application';
import type { OwnerId, UUID } from '@yelaxis/domain';

import { SqliteSearchQueries } from '../../search/sqlite-search-queries';
import { checkDatabaseHealth } from '../health';
import { NodeSqliteDriver } from '../testing/node-driver.node';
import { schemaMigrations } from './index';
import { defineMigration, runMigrations } from './migration';
import { searchRowStorageMigration } from './019_search_row_storage';

const at = '2026-10-05T09:00:00.000Z';
const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
const other = '10000000-0000-4000-8000-000000000002' as OwnerId;
const id = (kind: number, n = 1) =>
  `${String(kind)}000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID;
const drivers: NodeSqliteDriver[] = [];

afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.close();
});

async function fixture() {
  const driver = new NodeSqliteDriver(':memory:');
  drivers.push(driver);
  await runMigrations(
    driver,
    schemaMigrations.filter((migration) => migration.version <= 18),
    () => at,
  );
  const insert = async (table: string, row: Record<string, string | number | null>) => {
    const values = { created_at: at, updated_at: at, ...row };
    await driver.run(
      `INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values)
        .map(() => '?')
        .join(',')})`,
      Object.values(values),
    );
  };
  for (const identity of [owner, other])
    await insert('planning_identities', { id: identity, identity_kind: 'local' });
  await insert('profiles', {
    id: id(11),
    owner_id: owner,
    planning_time_zone: 'UTC',
    week_start: 'monday',
  });
  await insert('axes', {
    id: id(12),
    owner_id: owner,
    title: 'Synthetic recovery Axis',
    purpose: 'Steady pace',
    state: 'active',
    sort_key: 'a',
  });
  await insert('projects', {
    id: id(14),
    owner_id: owner,
    axis_id: id(12),
    title: 'Synthetic recovery Project',
    desired_result: 'Exact retained outcome',
    notes: 'Exact retained project prose',
    state: 'active',
    sort_key: 'a',
  });
  await insert('actions', {
    id: id(16),
    owner_id: owner,
    axis_id: id(12),
    project_id: id(14),
    title: 'Synthetic CAFÉ—СЛОН recovery',
    note_text: 'Synthetic long retained prose. '.repeat(250),
    state: 'inbox',
    due_date: '2026-10-09',
    sort_key: 'a',
  });
  await insert('actions', {
    id: id(16, 2),
    owner_id: owner,
    title: 'Synthetic archived recovery',
    state: 'archived',
    state_before_archive: 'inbox',
    archived_at: at,
    sort_key: 'b',
  });
  await insert('actions', {
    id: id(16, 3),
    owner_id: owner,
    title: 'Synthetic deleted recovery',
    state: 'inbox',
    deleted_at: at,
    sort_key: 'c',
  });
  await insert('notes', {
    id: id(17),
    owner_id: owner,
    axis_id: id(12),
    project_id: id(14),
    title: 'Synthetic recovery Note',
    body: 'Exact raw **prose** <synthetic>',
    state: 'active',
    sort_key: 'a',
  });
  await insert('notes', {
    id: id(17, 2),
    owner_id: other,
    title: 'Synthetic other owner recovery',
    body: 'Separate retained prose',
    state: 'active',
    sort_key: 'a',
  });
  await insert('review_checkpoints', {
    id: id(19),
    owner_id: owner,
    profile_id: id(11),
    review_type: 'weekly',
    period_key: '2026-10-05',
    period_start_date: '2026-10-05',
    period_end_date: '2026-10-11',
    week_start: 'monday',
    notes: 'Synthetic recovery reflections',
    state: 'draft',
  });
  await insert('review_items', {
    id: id(20),
    owner_id: owner,
    review_id: id(19),
    target_kind: 'action',
    action_id: id(16),
    decision: 'carry',
    decision_note: 'Synthetic recovery decision',
    sort_key: 'a',
  });
  await insert('planning_placements', {
    id: id(21),
    owner_id: owner,
    action_id: id(16),
    horizon: 'day',
    period_key: '2026-10-05',
    period_start_date: '2026-10-05',
    period_end_date: '2026-10-05',
    sort_key: 'a',
  });
  return driver;
}

async function canonicalRows(driver: NodeSqliteDriver) {
  const tables = await driver.all<{ name: string }>(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('_schema_migrations', 'search_documents', 'search_tokens') ORDER BY name;`,
  );
  const rows: Record<string, readonly object[]> = {};
  for (const table of tables) rows[table.name] = await driver.all(`SELECT * FROM "${table.name}";`);
  return rows;
}

async function derivedRows(driver: NodeSqliteDriver) {
  return {
    documents: await driver.all('SELECT * FROM search_documents ORDER BY owner_id,kind,entity_id;'),
    tokens: await driver.all('SELECT * FROM search_tokens ORDER BY owner_id,token,kind,entity_id;'),
  };
}

async function searchResults(driver: NodeSqliteDriver) {
  const queries = new SqliteSearchQueries(driver);
  const requests: SearchRequest[] = [
    { text: 'recovery', archive: 'exclude', dateBasis: 'updated' },
    { text: 'cafe\u0301 сло', archive: 'exclude', dateBasis: 'updated' },
    { text: 'recovery', archive: 'only', dateBasis: 'updated' },
    { text: 'recovery', archive: 'include', dateBasis: 'updated', kind: 'review_decision' },
    {
      text: 'recovery',
      archive: 'exclude',
      dateBasis: 'updated',
      axisId: id(12),
      projectId: id(14),
    },
  ];
  const results = [];
  for (const request of requests) results.push(await queries.search(owner, request, 40));
  return {
    results,
    other: await queries.search(other, requests[0] as SearchRequest, 40),
    detail: await queries.detail(owner, 'action', id(16)),
    inaccessible: await queries.detail(owner, 'note', id(17, 2)),
    deleted: await queries.detail(owner, 'action', id(16, 3)),
  };
}

it('upgrades v18 Search storage without changing canonical rows, derived fields, results, triggers or earlier checksums', async () => {
  const driver = await fixture();
  const canonical = await canonicalRows(driver);
  const derived = await derivedRows(driver);
  const results = await searchResults(driver);
  const ledger = await driver.all('SELECT * FROM _schema_migrations ORDER BY version;');
  const unchangedSchema = await driver.all(
    `SELECT type,name,sql FROM sqlite_schema
      WHERE name NOT IN ('search_documents', 'sqlite_autoindex_search_documents_1') ORDER BY name;`,
  );
  const sourceSchema = await driver.all(
    `SELECT type,name,sql FROM sqlite_schema WHERE
      name LIKE 'idx_search_%' OR name LIKE 'trg_search_%' OR name = 'search_source_documents'
      ORDER BY name;`,
  );
  const upgrade = await runMigrations(driver, schemaMigrations, () => at);
  expect(upgrade).toEqual({ fromVersion: 18, toVersion: 19, appliedVersions: [19] });
  expect(await canonicalRows(driver)).toEqual(canonical);
  expect(await derivedRows(driver)).toEqual(derived);
  expect(await searchResults(driver)).toEqual(results);
  expect(
    await driver.all(
      `SELECT type,name,sql FROM sqlite_schema
        WHERE name NOT IN ('search_documents', 'sqlite_autoindex_search_documents_1') ORDER BY name;`,
    ),
  ).toEqual(unchangedSchema);
  expect(
    await driver.all('SELECT * FROM _schema_migrations WHERE version <= 18 ORDER BY version;'),
  ).toEqual(ledger);
  expect(
    await driver.all(
      `SELECT type,name,sql FROM sqlite_schema WHERE
      name LIKE 'idx_search_%' OR name LIKE 'trg_search_%' OR name = 'search_source_documents'
      ORDER BY name;`,
    ),
  ).toEqual(sourceSchema);
  const schema = await driver.get<{ sql: string }>(
    "SELECT sql FROM sqlite_schema WHERE name='search_documents';",
  );
  expect(schema?.sql).not.toContain('WITHOUT ROWID');
  expect(schema?.sql).toContain('UNIQUE(owner_id, kind, entity_id)');
  expect(schema?.sql).toContain('STRICT');
  const keyPlan = await driver.all<{ detail: string }>(
    'EXPLAIN QUERY PLAN SELECT owner_id,kind,entity_id FROM search_documents WHERE owner_id=? AND kind=? AND entity_id=?;',
    [owner, 'action', id(16)],
  );
  expect(
    keyPlan.some((row) =>
      row.detail.includes('COVERING INDEX sqlite_autoindex_search_documents_1'),
    ),
  ).toBe(true);
  expect(await checkDatabaseHealth(driver)).toEqual({
    integrityCheck: 'ok',
    foreignKeyViolations: [],
  });
  expect((await runMigrations(driver, schemaMigrations, () => at)).appliedVersions).toEqual([]);
  expect(
    await driver.all("SELECT name FROM sqlite_temp_schema WHERE name LIKE 'yelaxis_search_%';"),
  ).toEqual([]);
});

it('enforces the identical composite parent key and token relationship with foreign keys enabled', async () => {
  const driver = await fixture();
  await runMigrations(driver, schemaMigrations, () => at);
  expect(await driver.get('PRAGMA foreign_keys;')).toEqual({ foreign_keys: 1 });
  const canonical = await canonicalRows(driver);
  await expect(
    driver.run(
      'INSERT INTO search_documents SELECT * FROM search_documents WHERE owner_id=? AND kind=? AND entity_id=?;',
      [owner, 'action', id(16)],
    ),
  ).rejects.toThrow('UNIQUE constraint failed');
  await expect(
    driver.run('INSERT INTO search_tokens(owner_id,token,kind,entity_id) VALUES(?,?,?,?);', [
      other,
      'owner-mismatch',
      'action',
      id(16),
    ]),
  ).rejects.toThrow('FOREIGN KEY constraint failed');
  await driver.run('DELETE FROM search_documents WHERE owner_id=? AND kind=? AND entity_id=?;', [
    owner,
    'action',
    id(16),
  ]);
  expect(
    await driver.all('SELECT * FROM search_tokens WHERE owner_id=? AND kind=? AND entity_id=?;', [
      owner,
      'action',
      id(16),
    ]),
  ).toEqual([]);
  expect(await canonicalRows(driver)).toEqual(canonical);
  expect(await new SqliteSearchQueries(driver).detail(other, 'note', id(17, 2))).not.toBeNull();
  expect(await checkDatabaseHealth(driver)).toEqual({
    integrityCheck: 'ok',
    foreignKeyViolations: [],
  });
});

it('retains normal search trigger updates, deduplicated tokens, owner isolation and cascade deletion after rebuilding', async () => {
  const driver = await fixture();
  await runMigrations(driver, schemaMigrations, () => at);
  await driver.run('UPDATE actions SET title=?,note_text=? WHERE id=?;', [
    'Replacement replacement',
    'Echo echo CAFÉ cafe\u0301',
    id(16),
  ]);
  const queries = new SqliteSearchQueries(driver);
  expect(
    (
      await queries.search(
        owner,
        { text: 'echo café', archive: 'exclude', dateBasis: 'updated' },
        40,
      )
    ).items.map((row) => row.id),
  ).toEqual([id(16)]);
  expect(
    await driver.all(
      'SELECT token FROM search_tokens WHERE owner_id=? AND kind=? AND entity_id=? ORDER BY token;',
      [owner, 'action', id(16)],
    ),
  ).toEqual([{ token: 'café' }, { token: 'echo' }, { token: 'replacement' }]);
  await driver.run('UPDATE actions SET deleted_at=? WHERE id=?;', [at, id(16)]);
  expect(
    await driver.all('SELECT * FROM search_tokens WHERE owner_id=? AND kind=? AND entity_id=?;', [
      owner,
      'action',
      id(16),
    ]),
  ).toEqual([]);
  expect(
    (
      await queries.search(
        other,
        { text: 'recovery', archive: 'exclude', dateBasis: 'updated' },
        40,
      )
    ).items.map((row) => row.id),
  ).toEqual([id(17, 2)]);
  await driver.run('UPDATE actions SET deleted_at=NULL WHERE id=?;', [id(16)]);
  expect(await queries.detail(owner, 'action', id(16))).not.toBeNull();
  expect(await checkDatabaseHealth(driver)).toEqual({
    integrityCheck: 'ok',
    foreignKeyViolations: [],
  });
});

it('detects an inherited broken canonical relationship and rolls the entire v19 rebuild back', async () => {
  const driver = await fixture();
  await driver.executeScript('PRAGMA foreign_keys = OFF;');
  await driver.run('UPDATE projects SET axis_id=? WHERE id=?;', [id(12, 99), id(14)]);
  const canonical = await canonicalRows(driver);
  const derived = await derivedRows(driver);
  const oldSchema = await driver.all('SELECT type,name,sql FROM sqlite_schema ORDER BY name;');
  expect((await checkDatabaseHealth(driver)).foreignKeyViolations).not.toEqual([]);
  await expect(runMigrations(driver, schemaMigrations, () => at)).rejects.toMatchObject({
    code: 'foreign_key_check_failed',
  });
  expect(await driver.get('PRAGMA user_version;')).toEqual({ user_version: 18 });
  expect(await canonicalRows(driver)).toEqual(canonical);
  expect(await derivedRows(driver)).toEqual(derived);
  expect(await driver.all('SELECT type,name,sql FROM sqlite_schema ORDER BY name;')).toEqual(
    oldSchema,
  );
  expect((await checkDatabaseHealth(driver)).foreignKeyViolations).not.toEqual([]);
});

it('rejects an orphaned Search token instead of silently dropping it during the v19 rebuild', async () => {
  const driver = await fixture();
  await driver.executeScript('PRAGMA foreign_keys = OFF;');
  await driver.run('INSERT INTO search_tokens(owner_id,token,kind,entity_id) VALUES(?,?,?,?);', [
    owner,
    'synthetic-orphan',
    'action',
    id(16, 99),
  ]);
  const derived = await derivedRows(driver);
  await expect(runMigrations(driver, schemaMigrations, () => at)).rejects.toMatchObject({
    code: 'migration_apply_failed',
  });
  expect(await derivedRows(driver)).toEqual(derived);
  expect(await driver.get('PRAGMA user_version;')).toEqual({ user_version: 18 });
  expect((await checkDatabaseHealth(driver)).foreignKeyViolations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ table: 'search_tokens', parent: 'search_documents' }),
    ]),
  );
});

it('rolls back interrupted v19 DDL and derived data atomically while preserving full health', async () => {
  const driver = await fixture();
  const canonical = await canonicalRows(driver);
  const derived = await derivedRows(driver);
  const schema = await driver.all('SELECT type,name,sql FROM sqlite_schema ORDER BY name;');
  const failing = defineMigration(
    19,
    searchRowStorageMigration.name,
    `${searchRowStorageMigration.sql}\nSELECT * FROM synthetic_missing_table;`,
  );
  await expect(
    runMigrations(driver, [...schemaMigrations.slice(0, 18), failing], () => at),
  ).rejects.toMatchObject({ code: 'migration_apply_failed' });
  expect(await driver.get('PRAGMA user_version;')).toEqual({ user_version: 18 });
  expect(await canonicalRows(driver)).toEqual(canonical);
  expect(await derivedRows(driver)).toEqual(derived);
  expect(await driver.all('SELECT type,name,sql FROM sqlite_schema ORDER BY name;')).toEqual(
    schema,
  );
  expect(await checkDatabaseHealth(driver)).toEqual({
    integrityCheck: 'ok',
    foreignKeyViolations: [],
  });
  expect(
    await driver.all("SELECT name FROM sqlite_temp_schema WHERE name LIKE 'yelaxis_search_%';"),
  ).toEqual([]);
});
