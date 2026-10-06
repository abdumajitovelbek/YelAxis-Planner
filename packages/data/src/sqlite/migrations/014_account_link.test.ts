import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeSqliteDriver } from '../testing/node-driver.node';
import { schemaMigrations } from './index';
import { runMigrations } from './migration';

const at = '2026-10-01T00:00:00.000Z';
const appliedAt = () => at;
const temporaryDirectories: string[] = [];

async function openTemporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-data-migration-14-'));
  temporaryDirectories.push(directory);
  return new NodeSqliteDriver(join(directory, 'plan.sqlite'));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type Value = string | number | null;

function inserter(driver: NodeSqliteDriver) {
  return async (table: string, row: Record<string, Value>) => {
    const values = { created_at: at, updated_at: at, ...row };
    const columns = Object.keys(values);
    await driver.run(
      `INSERT INTO ${table} (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')});`,
      Object.values(values),
    );
  };
}

describe('migration 14 (account link)', () => {
  const local = '10000000-0000-4000-8000-000000000001';
  const account = '10000000-0000-4000-8000-000000000002';
  const subject = '1f000000-0000-4000-8000-000000000001';
  const profile = '11000000-0000-4000-8000-000000000001';
  const action = '16000000-0000-4000-8000-000000000001';
  const replica = '1f000000-0000-4000-8000-000000000002';

  /** A version-13 database with a local and an account identity and their sync bookkeeping. */
  async function openVersionThirteen() {
    const driver = await openTemporaryDatabase();
    await runMigrations(driver, schemaMigrations.slice(0, 13), appliedAt);
    const insert = inserter(driver);
    await insert('planning_identities', { id: local, identity_kind: 'local', deleted_at: at });
    await insert('planning_identities', {
      id: account,
      identity_kind: 'account',
      account_subject_id: subject,
      replica_id: replica,
    });
    await insert('profiles', {
      id: profile,
      owner_id: account,
      planning_time_zone: 'UTC',
      week_start: 'monday',
      time_format: '24_hour',
    });
    await insert('actions', {
      id: action,
      owner_id: account,
      title: 'Synthetic Action',
      state: 'planned',
      capture_origin: 'plan',
      sort_key: 'a',
    });
    await insert('sync_outbox', {
      id: '1f000000-0000-4000-8000-000000000003',
      owner_id: account,
      operation_id: '1f000000-0000-4000-8000-000000000003',
      mutation_group_id: '1f000000-0000-4000-8000-000000000004',
      command_id: '1f000000-0000-4000-8000-000000000005',
      actor: 'user',
      sequence: 0,
      entity_type: 'action',
      entity_id: action,
      operation_kind: 'create',
      document_schema_version: 1,
      document_payload_json: '{"title":"Synthetic Action"}',
      base_server_revision: 0,
      state: 'pending',
    });
    await insert('sync_checkpoints', {
      id: '1f000000-0000-4000-8000-000000000006',
      owner_id: account,
      replica_id: replica,
      server_cursor: '42',
      last_success_at: at,
    });
    await insert('account_deletion_state', {
      id: '1f000000-0000-4000-8000-000000000007',
      owner_id: account,
      state: 'none',
    });
    return driver;
  }

  const identityColumns = `id, identity_kind, account_subject_id, replica_id, created_at,
    updated_at, local_revision, server_revision, deleted_at`;
  const deletionColumns = `id, owner_id, request_id, state, requested_at, confirmed_at,
    recoverable_error_code, created_at, updated_at, local_revision, server_revision, deleted_at`;

  it('upgrades a version-13 database, keeping every identity and sync row and value', async () => {
    const driver = await openVersionThirteen();
    const snapshot = async () => ({
      identities: await driver.all<object>(
        `SELECT ${identityColumns} FROM planning_identities ORDER BY id;`,
      ),
      deletion: await driver.all<object>(
        `SELECT ${deletionColumns} FROM account_deletion_state ORDER BY id;`,
      ),
      profiles: await driver.all<object>('SELECT * FROM profiles ORDER BY id;'),
      actions: await driver.all<object>('SELECT * FROM actions ORDER BY id;'),
      outbox: await driver.all<object>('SELECT * FROM sync_outbox ORDER BY id;'),
      checkpoints: await driver.all<object>('SELECT * FROM sync_checkpoints ORDER BY id;'),
    });
    const before = await snapshot();
    expect(before.identities).toHaveLength(2);

    await expect(runMigrations(driver, schemaMigrations, appliedAt)).resolves.toEqual({
      fromVersion: 13,
      toVersion: 19,
      appliedVersions: [14, 15, 16, 17, 18, 19],
    });
    await expect(snapshot()).resolves.toEqual(before);
    // No existing identity is linking: the new columns are empty for every row.
    const empty = {
      link_id: null,
      link_source_identity_id: null,
      link_source_profile_id: null,
      link_started_at: null,
      linked_at: null,
    };
    await expect(
      driver.all<object>(
        `SELECT id, link_id, link_source_identity_id, link_source_profile_id, link_started_at,
                linked_at
         FROM planning_identities ORDER BY id;`,
      ),
    ).resolves.toEqual([
      { id: local, ...empty },
      { id: account, ...empty },
    ]);
    await expect(
      driver.all<object>('SELECT local_copy_choice FROM account_deletion_state;'),
    ).resolves.toEqual([{ local_copy_choice: null }]);
    await expect(
      driver.get<object>('SELECT COUNT(*) AS count FROM account_link_backups;'),
    ).resolves.toEqual({ count: 0 });
    const indexes = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?) ORDER BY name;",
      ['idx_account_link_backups_owner', 'idx_sync_outbox_command'],
    );
    expect(indexes.map(({ name }) => name)).toEqual([
      'idx_account_link_backups_owner',
      'idx_sync_outbox_command',
    ]);

    await expect(driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await expect(driver.get<object>('PRAGMA integrity_check;')).resolves.toEqual({
      integrity_check: 'ok',
    });
    // Reopening applies nothing more.
    await expect(runMigrations(driver, schemaMigrations, appliedAt)).resolves.toEqual({
      fromVersion: 19,
      toVersion: 19,
      appliedVersions: [],
    });
    await driver.close();
  });

  it('installs fresh with link columns only on account identities, a start for every link', async () => {
    const driver = await openTemporaryDatabase();
    await expect(runMigrations(driver, schemaMigrations, appliedAt)).resolves.toMatchObject({
      fromVersion: 0,
      toVersion: 19,
    });
    const insert = inserter(driver);
    const linkId = '1f000000-0000-4000-8000-000000000010';

    await insert('planning_identities', { id: local, identity_kind: 'local' });
    // A local identity never links.
    await expect(
      driver.run('UPDATE planning_identities SET linked_at = ? WHERE id = ?;', [at, local]),
    ).rejects.toThrow();
    await expect(
      driver.run('UPDATE planning_identities SET link_id = ?, link_started_at = ? WHERE id = ?;', [
        linkId,
        at,
        local,
      ]),
    ).rejects.toThrow();
    await expect(
      driver.run('UPDATE planning_identities SET link_source_profile_id = ? WHERE id = ?;', [
        profile,
        local,
      ]),
    ).rejects.toThrow();
    // A link id needs its start, and a source identity or Profile needs a link.
    await expect(
      insert('planning_identities', {
        id: account,
        identity_kind: 'account',
        account_subject_id: subject,
        link_id: linkId,
      }),
    ).rejects.toThrow();
    await expect(
      insert('planning_identities', {
        id: account,
        identity_kind: 'account',
        account_subject_id: subject,
        link_source_identity_id: local,
      }),
    ).rejects.toThrow();
    await expect(
      insert('planning_identities', {
        id: account,
        identity_kind: 'account',
        account_subject_id: subject,
        linked_at: at,
        link_source_profile_id: profile,
      }),
    ).rejects.toThrow();
    // A link remembers the local Profile id it replaced with the account's Profile id.
    await insert('planning_identities', {
      id: account,
      identity_kind: 'account',
      account_subject_id: subject,
      replica_id: replica,
      link_id: linkId,
      link_source_identity_id: local,
      link_source_profile_id: profile,
      link_started_at: at,
    });
    await driver.run('UPDATE planning_identities SET linked_at = ? WHERE id = ?;', [at, account]);
    await expect(
      driver.get<object>(
        `SELECT link_source_identity_id, link_source_profile_id
         FROM planning_identities WHERE id = ?;`,
        [account],
      ),
    ).resolves.toEqual({ link_source_identity_id: local, link_source_profile_id: profile });
    // A replica opened for an account without a local plan is linked from its creation.
    await insert('planning_identities', {
      id: '10000000-0000-4000-8000-000000000003',
      identity_kind: 'account',
      account_subject_id: '1f000000-0000-4000-8000-000000000012',
      linked_at: at,
    });

    const deletion = (choice: Value) =>
      insert('account_deletion_state', {
        id: '1f000000-0000-4000-8000-000000000013',
        owner_id: account,
        state: 'requested',
        local_copy_choice: choice,
      });
    await expect(deletion('maybe')).rejects.toThrow();
    await deletion('keep');

    const backup = (row: Record<string, Value>) =>
      insert('account_link_backups', {
        id: '1f000000-0000-4000-8000-000000000014',
        owner_id: account,
        data_sha256: 'a'.repeat(64),
        record_count: 2,
        sync_was_pending: 0,
        bundle_json: '{"format":"yelaxis.backup"}',
        verified_at: at,
        ...row,
      });
    await expect(backup({ data_sha256: 'short' })).rejects.toThrow();
    await expect(backup({ bundle_json: '{not json' })).rejects.toThrow();
    await expect(backup({ sync_was_pending: 2 })).rejects.toThrow();
    await expect(backup({ record_count: -1 })).rejects.toThrow();
    await expect(backup({ owner_id: '10000000-0000-4000-8000-0000000000ff' })).rejects.toThrow();
    await backup({});

    // The initial upload groups of a link are found through their command id.
    const plan = await driver.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) FROM sync_outbox WHERE owner_id = ? AND command_id = ?;`,
      [account, linkId],
    );
    expect(plan.map(({ detail }) => detail).join('\n')).toContain('idx_sync_outbox_command');
    await expect(driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await driver.close();
  });
});
