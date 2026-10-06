import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeSqliteDriver } from '../testing/node-driver.node';
import { schemaMigrations } from './index';
import { defineMigration, runMigrations } from './migration';

const appliedAt = () => '2026-07-23T00:00:00.000Z';
const temporaryDirectories: string[] = [];

async function openTemporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-data-migration-'));
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

const firstMigration = defineMigration(
  1,
  'first',
  'CREATE TABLE first_record (id TEXT PRIMARY KEY) STRICT;',
);
const secondMigration = defineMigration(
  2,
  'second',
  'CREATE TABLE second_record (id TEXT PRIMARY KEY) STRICT;',
);

describe('runMigrations', () => {
  it.each(schemaMigrations)(
    'preserves the prior schema and data after a failure in released migration $version',
    async (migration) => {
      const directory = await mkdtemp(join(tmpdir(), 'yelaxis-release-migration-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'plan.sqlite');
      let driver = new NodeSqliteDriver(path);
      try {
        const prior = schemaMigrations.slice(0, migration.version - 1);
        await runMigrations(driver, prior, appliedAt);
        await driver.executeScript(`
          CREATE TABLE release_recovery_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          INSERT INTO release_recovery_probe VALUES ('synthetic', 'preserve');
        `);
        const schema = () =>
          driver.all<{ name: string; type: string; sql: string | null }>(
            `SELECT name, type, sql FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;`,
          );
        const ledger = () =>
          driver.all<object>('SELECT * FROM _schema_migrations ORDER BY version;');
        const schemaBefore = await schema();
        const ledgerBefore = await ledger();
        const failed = defineMigration(
          migration.version,
          migration.name,
          `${migration.sql}\nINSERT INTO nonexistent_release_failure_table VALUES (1);`,
        );
        await expect(runMigrations(driver, [...prior, failed], appliedAt)).rejects.toMatchObject({
          code: 'migration_apply_failed',
        });
        await driver.close();
        driver = new NodeSqliteDriver(path);
        expect(await schema()).toEqual(schemaBefore);
        expect(await ledger()).toEqual(ledgerBefore);
        expect(await driver.get<{ user_version: number }>('PRAGMA user_version;')).toEqual({
          user_version: migration.version - 1,
        });
        expect(await driver.all<object>('SELECT * FROM release_recovery_probe;')).toEqual([
          { id: 'synthetic', value: 'preserve' },
        ]);
        expect(await driver.all<object>('PRAGMA foreign_key_check;')).toEqual([]);
        expect(await driver.get<{ integrity_check: string }>('PRAGMA integrity_check;')).toEqual({
          integrity_check: 'ok',
        });
        await expect(
          runMigrations(driver, [...prior, migration], appliedAt),
        ).resolves.toMatchObject({ appliedVersions: [migration.version] });
      } finally {
        await driver.close();
      }
    },
  );

  it('keeps the released migration source checksums stable', () => {
    expect(
      schemaMigrations
        .slice(0, 18)
        .map(({ version, name, checksum }) => ({ version, name, checksum })),
    ).toEqual([
      { version: 1, name: 'identity_profile', checksum: 'fnv1a64:8aaed4ec3583a170' },
      { version: 2, name: 'planning_entities', checksum: 'fnv1a64:4badcd6859b09276' },
      { version: 3, name: 'relationships_placements', checksum: 'fnv1a64:2e094f25e374129e' },
      { version: 4, name: 'routines_schedule', checksum: 'fnv1a64:320982a1d7a3c835' },
      { version: 5, name: 'review_audit_operations', checksum: 'fnv1a64:e74e552bb97c6cb0' },
      { version: 6, name: 'indexes_guards', checksum: 'fnv1a64:afc674dc1176f5c0' },
      { version: 7, name: 'onboarding_progress', checksum: 'fnv1a64:456e57894adb4bbe' },
      { version: 8, name: 'actions_inbox', checksum: 'fnv1a64:8a683c3fbf03f7fb' },
      { version: 9, name: 'horizons_scheduling', checksum: 'fnv1a64:cd0a7bac9bcbb675' },
      { version: 10, name: 'alignment', checksum: 'fnv1a64:bfe3012c31757b08' },
      { version: 11, name: 'reviews', checksum: 'fnv1a64:12f20a9efbfbf28d' },
      { version: 12, name: 'reminder_targets', checksum: 'fnv1a64:0a3c87ebab8a545a' },
      { version: 13, name: 'review_cleared_lists', checksum: 'fnv1a64:2430da901f38d29c' },
      { version: 14, name: 'account_link', checksum: 'fnv1a64:9244b25d82b32916' },
      { version: 15, name: 'search', checksum: 'fnv1a64:7d9fb794858cb04c' },
      { version: 16, name: 'import_recovery', checksum: 'fnv1a64:9234ae045f8e3528' },
      { version: 17, name: 'notifications', checksum: 'fnv1a64:e7b0e0b8f3092bbc' },
      { version: 18, name: 'release_query_indexes', checksum: 'fnv1a64:e413fd76d4588f53' },
    ]);
  });

  it('applies fresh ordered migrations and is idempotent on reapply', async () => {
    const driver = await openTemporaryDatabase();

    await expect(
      runMigrations(driver, [firstMigration, secondMigration], appliedAt),
    ).resolves.toEqual({ fromVersion: 0, toVersion: 2, appliedVersions: [1, 2] });
    await expect(
      runMigrations(driver, [firstMigration, secondMigration], appliedAt),
    ).resolves.toEqual({ fromVersion: 2, toVersion: 2, appliedVersions: [] });
    await expect(driver.get<{ user_version: number }>('PRAGMA user_version;')).resolves.toEqual({
      user_version: 2,
    });

    await driver.close();
  });

  it('rejects an applied migration whose checksum no longer matches', async () => {
    const driver = await openTemporaryDatabase();
    await runMigrations(driver, [firstMigration], appliedAt);
    await driver.run('UPDATE _schema_migrations SET checksum = ? WHERE version = ?;', [
      'tampered',
      1,
    ]);

    await expect(runMigrations(driver, [firstMigration], appliedAt)).rejects.toMatchObject({
      code: 'migration_checksum_mismatch',
    });

    await driver.close();
  });

  it.each(['COMMIT', 'END', 'END /* comment-separated */ TRANSACTION'])(
    'rejects %s migration source before touching the database',
    async (transactionControl) => {
      const driver = await openTemporaryDatabase();
      const escapingMigration = defineMigration(
        1,
        'escaping',
        `CREATE TABLE escaped (id TEXT PRIMARY KEY) STRICT; ${transactionControl};`,
      );

      await expect(runMigrations(driver, [escapingMigration], appliedAt)).rejects.toMatchObject({
        code: 'invalid_migration_set',
      });
      await expect(
        driver.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name IN ('escaped', '_schema_migrations');`,
        ),
      ).resolves.toEqual({ count: 0 });
      await driver.close();
    },
  );

  it('leaves a newer unsupported database without a migration ledger', async () => {
    const driver = await openTemporaryDatabase();
    await driver.executeScript(`
      CREATE TABLE existing_record (id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 999;
    `);
    const schemaBefore = await driver.all<{ name: string; type: string; sql: string | null }>(
      `SELECT name, type, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;`,
    );

    await expect(runMigrations(driver, [firstMigration], appliedAt)).rejects.toMatchObject({
      code: 'database_version_too_new',
    });
    await expect(
      driver.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = '_schema_migrations';`,
      ),
    ).resolves.toEqual({ count: 0 });
    await expect(
      driver.all<{ name: string; type: string; sql: string | null }>(
        `SELECT name, type, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;`,
      ),
    ).resolves.toEqual(schemaBefore);
    await expect(driver.get<{ user_version: number }>('PRAGMA user_version;')).resolves.toEqual({
      user_version: 999,
    });
    await driver.close();
  });

  it('rolls back every statement and version marker from a failed migration', async () => {
    const driver = await openTemporaryDatabase();
    const failingMigration = defineMigration(
      2,
      'failing',
      `
        CREATE TABLE should_rollback (id TEXT PRIMARY KEY) STRICT;
        INSERT INTO table_that_does_not_exist (id) VALUES ('failure');
      `,
    );

    await expect(
      runMigrations(driver, [firstMigration, failingMigration], appliedAt),
    ).rejects.toMatchObject({ code: 'migration_apply_failed' });
    await expect(driver.get<{ user_version: number }>('PRAGMA user_version;')).resolves.toEqual({
      user_version: 1,
    });
    await expect(
      driver.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?;",
        ['should_rollback'],
      ),
    ).resolves.toEqual({ count: 0 });

    await driver.close();
  });

  it('rolls back a deferred ownership violation found by foreign_key_check', async () => {
    const driver = await openTemporaryDatabase();
    const relationalMigration = defineMigration(
      1,
      'relational',
      `
        CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE RESTRICT
        ) STRICT;
      `,
    );
    const violatingMigration = defineMigration(
      2,
      'violating',
      `
        PRAGMA defer_foreign_keys = ON;
        INSERT INTO child (id, parent_id) VALUES ('child', 'missing-parent');
      `,
    );

    await expect(
      runMigrations(driver, [relationalMigration, violatingMigration], appliedAt),
    ).rejects.toMatchObject({ code: 'foreign_key_check_failed' });
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM child;'),
    ).resolves.toEqual({ count: 0 });

    await driver.close();
  });

  it('upgrades a version-six Profile without changing existing planning data', async () => {
    const driver = await openTemporaryDatabase();
    await runMigrations(driver, schemaMigrations.slice(0, 6), appliedAt);
    await driver.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
       VALUES (?, 'local', ?, ?);`,
      ['owner-before-onboarding', appliedAt(), appliedAt()],
    );
    await driver.run(
      `INSERT INTO profiles (id, owner_id, preferred_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?);`,
      [
        'profile-before-onboarding',
        'owner-before-onboarding',
        'Synthetic',
        appliedAt(),
        appliedAt(),
      ],
    );

    await expect(runMigrations(driver, schemaMigrations, appliedAt)).resolves.toEqual({
      fromVersion: 6,
      toVersion: 19,
      appliedVersions: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    });
    await expect(
      driver.get<{
        preferred_name: string;
        onboarding_status: string;
        onboarding_step: string;
        handbook_status: string;
      }>(
        'SELECT preferred_name, onboarding_status, onboarding_step, handbook_status FROM profiles;',
      ),
    ).resolves.toEqual({
      preferred_name: 'Synthetic',
      onboarding_status: 'not_started',
      onboarding_step: 'welcome',
      handbook_status: 'not_started',
    });
    await driver.close();
  });

  it('upgrades a onboarding database and enforces Action energy and one scheduled reminder', async () => {
    const driver = await openTemporaryDatabase();
    await runMigrations(driver, schemaMigrations.slice(0, 7), appliedAt);
    const owner = '10000000-0000-4000-8000-000000000001';
    const action = '20000000-0000-4000-8000-000000000001';
    await driver.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
       VALUES (?, 'local', ?, ?);`,
      [owner, appliedAt(), appliedAt()],
    );
    await driver.run(
      `INSERT INTO actions (
         id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at
       ) VALUES (?, ?, 'onboarding Action', 'inbox', 'onboarding', 'a', ?, ?);`,
      [action, owner, appliedAt(), appliedAt()],
    );

    await expect(runMigrations(driver, schemaMigrations, appliedAt)).resolves.toEqual({
      fromVersion: 7,
      toVersion: 19,
      appliedVersions: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    });
    await expect(
      driver.run('UPDATE actions SET energy = ? WHERE owner_id = ? AND id = ?;', [
        'unbounded',
        owner,
        action,
      ]),
    ).rejects.toThrow();
    await driver.run(
      `INSERT INTO reminders (
         id, owner_id, action_id, schedule_kind, remind_at_utc, time_zone, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'at', ?, 'UTC', 'scheduled', ?, ?);`,
      [
        '30000000-0000-4000-8000-000000000001',
        owner,
        action,
        appliedAt(),
        appliedAt(),
        appliedAt(),
      ],
    );
    await expect(
      driver.run(
        `INSERT INTO reminders (
           id, owner_id, action_id, schedule_kind, remind_at_utc, time_zone, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'at', ?, 'UTC', 'scheduled', ?, ?);`,
        [
          '30000000-0000-4000-8000-000000000002',
          owner,
          action,
          appliedAt(),
          appliedAt(),
          appliedAt(),
        ],
      ),
    ).rejects.toThrow();
    await expect(
      driver.run(
        `INSERT INTO reminders (
           id, owner_id, action_id, schedule_kind, remind_at_utc, offset_minutes, time_zone, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'relative', ?, -10081, 'UTC', 'canceled', ?, ?);`,
        [
          '30000000-0000-4000-8000-000000000003',
          owner,
          action,
          appliedAt(),
          appliedAt(),
          appliedAt(),
        ],
      ),
    ).rejects.toThrow();
    await driver.close();
  });

  it('upgrades a Action database to the planning read model without rewriting planning data', async () => {
    const driver = await openTemporaryDatabase();
    await runMigrations(driver, schemaMigrations.slice(0, 8), appliedAt);
    const owner = '10000000-0000-4000-8000-000000000001';
    const profile = '11000000-0000-4000-8000-000000000001';
    const action = '20000000-0000-4000-8000-000000000001';
    await driver.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
       VALUES (?, 'local', ?, ?);`,
      [owner, appliedAt(), appliedAt()],
    );
    await driver.run(
      `INSERT INTO profiles (id, owner_id, planning_time_zone, week_start, time_format,
         created_at, updated_at)
       VALUES (?, ?, 'UTC', 'monday', '24_hour', ?, ?);`,
      [profile, owner, appliedAt(), appliedAt()],
    );
    await driver.run(
      `INSERT INTO actions (
         id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at
       ) VALUES (?, ?, 'Action', 'planned', 'inbox', 'a', ?, ?);`,
      [action, owner, appliedAt(), appliedAt()],
    );
    await driver.run(
      `INSERT INTO month_themes (id, owner_id, profile_id, period_key, theme_text, created_at,
         updated_at)
       VALUES ('theme-1', ?, ?, '2026-08', 'Steady', ?, ?);`,
      [owner, profile, appliedAt(), appliedAt()],
    );
    const before = await driver.all<object>(
      'SELECT id, title, state, sort_key, local_revision, updated_at FROM actions ORDER BY id;',
    );

    await expect(runMigrations(driver, schemaMigrations.slice(0, 9), appliedAt)).resolves.toEqual({
      fromVersion: 8,
      toVersion: 9,
      appliedVersions: [9],
    });
    await expect(
      driver.all<object>(
        'SELECT id, title, state, sort_key, local_revision, updated_at FROM actions ORDER BY id;',
      ),
    ).resolves.toEqual(before);
    await expect(
      driver.get<{ theme_text: string }>('SELECT theme_text FROM month_themes;'),
    ).resolves.toEqual({ theme_text: 'Steady' });
    const indexes = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name;",
    );
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'idx_actions_planning_state',
        'idx_week_selections_period',
        'idx_routine_occurrences_history',
        'idx_routine_occurrences_override_date',
        'idx_constraints_kind',
        'idx_templates_title',
        'idx_outcomes_target_end',
        'idx_milestones_target_end',
        'idx_projects_target_end',
      ]),
    );

    await expect(
      driver.run('UPDATE month_themes SET theme_text = ? WHERE id = ?;', [
        'x'.repeat(2_001),
        'theme-1',
      ]),
    ).rejects.toThrow();
    await driver.run('UPDATE month_themes SET theme_text = ? WHERE id = ?;', [
      'x'.repeat(2_000),
      'theme-1',
    ]);
    await expect(
      driver.run(
        `INSERT INTO year_directions (id, owner_id, profile_id, period_key, direction_text,
           created_at, updated_at)
         VALUES ('direction-1', ?, ?, '2026', ?, ?, ?);`,
        [owner, profile, 'y'.repeat(2_001), appliedAt(), appliedAt()],
      ),
    ).rejects.toThrow();

    const plan = await driver.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT id FROM actions
       WHERE owner_id = ? AND state IN ('planned', 'in_progress') AND archived_at IS NULL
         AND deleted_at IS NULL
       ORDER BY sort_key, id;`,
      [owner],
    );
    expect(plan.map(({ detail }) => detail).join('\n')).toContain('idx_actions_planning_state');
    const inboxPlan = await driver.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT id FROM actions
       WHERE owner_id = ? AND state = 'inbox' AND archived_at IS NULL AND deleted_at IS NULL
       ORDER BY sort_key, id;`,
      [owner],
    );
    expect(inboxPlan.map(({ detail }) => detail).join('\n')).toContain('idx_actions_inbox_order');
    await driver.close();
  });

  it('upgrades a planning database to the alignment indexes without rewriting planning data', async () => {
    const driver = await openTemporaryDatabase();
    await runMigrations(driver, schemaMigrations.slice(0, 9), appliedAt);
    const at = appliedAt();
    const owner = '10000000-0000-4000-8000-000000000001';
    const profile = '11000000-0000-4000-8000-000000000001';
    const axis = '12000000-0000-4000-8000-000000000001';
    const outcome = '13000000-0000-4000-8000-000000000001';
    const project = '14000000-0000-4000-8000-000000000001';
    const milestone = '15000000-0000-4000-8000-000000000001';
    const action = '16000000-0000-4000-8000-000000000001';
    const insert = async (table: string, row: Record<string, string | number | null>) => {
      const values = { created_at: at, updated_at: at, ...row };
      const columns = Object.keys(values);
      await driver.run(
        `INSERT INTO ${table} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')});`,
        Object.values(values),
      );
    };
    await insert('planning_identities', { id: owner, identity_kind: 'local' });
    await insert('profiles', {
      id: profile,
      owner_id: owner,
      planning_time_zone: 'UTC',
      week_start: 'monday',
      time_format: '24_hour',
    });
    // Longer than the alignment command cap (80): persisted rows are never capped by the database.
    await insert('axes', {
      id: axis,
      owner_id: owner,
      title: 'A'.repeat(300),
      state: 'active',
      sort_key: 'onboarding-01',
    });
    await insert('outcomes', {
      id: outcome,
      owner_id: owner,
      axis_id: axis,
      title: 'Outcome',
      success_definition: 'Done',
      state: 'active',
      progress_mode: 'milestone_derived',
      sort_key: 'onboarding-01',
    });
    await insert('projects', {
      id: project,
      owner_id: owner,
      axis_id: axis,
      title: 'Project',
      state: 'idea',
      sort_key: 'a',
    });
    await insert('milestones', {
      id: milestone,
      owner_id: owner,
      outcome_id: outcome,
      title: 'Milestone',
      measurable_checkpoint: 'Measured',
      state: 'active',
      sort_key: 'a',
    });
    await insert('actions', {
      id: action,
      owner_id: owner,
      project_id: project,
      title: 'Action',
      state: 'planned',
      sort_key: 'a',
    });
    await insert('notes', {
      id: '17000000-0000-4000-8000-000000000001',
      owner_id: owner,
      axis_id: axis,
      project_id: project,
      body: 'Note',
      state: 'active',
      sort_key: 'a',
    });
    await insert('milestone_actions', {
      id: '18000000-0000-4000-8000-000000000001',
      owner_id: owner,
      milestone_id: milestone,
      action_id: action,
      deleted_at: at,
    });
    await insert('milestone_projects', {
      id: '18000000-0000-4000-8000-000000000002',
      owner_id: owner,
      milestone_id: milestone,
      project_id: project,
    });
    await insert('planning_placements', {
      id: '19000000-0000-4000-8000-000000000001',
      owner_id: owner,
      outcome_id: outcome,
      horizon: 'year',
      period_key: '2026',
      period_start_date: '2026-01-01',
      period_end_date: '2026-12-31',
      sort_key: 'a',
      archived_at: at,
    });
    await insert('week_selections', {
      id: '1a000000-0000-4000-8000-000000000001',
      owner_id: owner,
      profile_id: profile,
      milestone_id: milestone,
      period_start_date: '2026-07-20',
      period_end_date: '2026-07-26',
      week_start: 'monday',
      sort_key: 'a',
    });
    await insert('review_checkpoints', {
      id: '1b000000-0000-4000-8000-000000000001',
      owner_id: owner,
      profile_id: profile,
      review_type: 'monthly',
      period_key: '2026-07',
      period_start_date: '2026-07-01',
      period_end_date: '2026-07-31',
      state: 'draft',
    });
    await insert('review_items', {
      id: '1b000000-0000-4000-8000-000000000002',
      owner_id: owner,
      review_id: '1b000000-0000-4000-8000-000000000001',
      project_id: project,
      decision: 'continue',
      sort_key: 'a',
    });
    const tables = [
      'axes',
      'outcomes',
      'projects',
      'milestones',
      'actions',
      'notes',
      'milestone_actions',
      'milestone_projects',
      'planning_placements',
      'week_selections',
      'review_items',
    ];
    const snapshot = async () => {
      const rows: Record<string, object[]> = {};
      for (const table of tables) {
        rows[table] = await driver.all<object>(`SELECT * FROM ${table} ORDER BY id;`);
      }
      return rows;
    };
    const triggers = async () =>
      driver.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name;",
      );
    const before = await snapshot();
    const triggersBefore = await triggers();

    await expect(runMigrations(driver, schemaMigrations.slice(0, 10), appliedAt)).resolves.toEqual({
      fromVersion: 9,
      toVersion: 10,
      appliedVersions: [10],
    });
    await expect(snapshot()).resolves.toEqual(before);
    await expect(triggers()).resolves.toEqual(triggersBefore);
    const indexes = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name;",
    );
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'idx_axes_order',
        'idx_outcomes_order',
        'idx_projects_order',
        'idx_notes_axis',
        'idx_placements_outcome_all',
        'idx_placements_project_all',
        'idx_placements_milestone_all',
        'idx_week_selections_project',
        'idx_week_selections_milestone',
        'idx_review_items_outcome',
        'idx_review_items_project',
        'idx_review_items_milestone',
      ]),
    );

    // No text trigger: an existing longer row can still be archived and restored.
    await driver.run(
      `UPDATE axes SET state = 'archived', state_before_archive = 'active', archived_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ?;`,
      [at, owner, axis],
    );
    await expect(
      driver.get<{ state: string; title_length: number }>(
        'SELECT state, length(title) AS title_length FROM axes WHERE id = ?;',
        [axis],
      ),
    ).resolves.toEqual({ state: 'archived', title_length: 300 });

    const explain = async (sql: string, parameters: readonly (string | number)[]) =>
      (await driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters))
        .map(({ detail }) => detail)
        .join('\n');
    await expect(
      explain(
        `SELECT id FROM planning_placements WHERE owner_id = ? AND outcome_id = ? ORDER BY id;`,
        [owner, outcome],
      ),
    ).resolves.toContain('idx_placements_outcome_all');
    await expect(
      explain(`SELECT id FROM week_selections WHERE owner_id = ? AND milestone_id = ?;`, [
        owner,
        milestone,
      ]),
    ).resolves.toContain('idx_week_selections_milestone');
    await expect(
      explain(`SELECT COUNT(*) FROM review_items WHERE owner_id = ? AND project_id = ?;`, [
        owner,
        project,
      ]),
    ).resolves.toContain('idx_review_items_project');
    await expect(
      explain(`SELECT COUNT(*) FROM notes WHERE owner_id = ? AND axis_id = ?;`, [owner, axis]),
    ).resolves.toContain('idx_notes_axis');
    // The Action and planning plans keep their own indexes.
    await expect(
      explain(
        `SELECT id FROM actions
         WHERE owner_id = ? AND state = 'inbox' AND archived_at IS NULL AND deleted_at IS NULL
         ORDER BY sort_key, id;`,
        [owner],
      ),
    ).resolves.toContain('idx_actions_inbox_order');
    await expect(
      explain(
        `SELECT id FROM actions
         WHERE owner_id = ? AND state IN ('planned', 'in_progress') AND archived_at IS NULL
           AND deleted_at IS NULL
         ORDER BY sort_key, id;`,
        [owner],
      ),
    ).resolves.toContain('idx_actions_planning_state');
    await expect(driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await driver.close();
  });
});

describe('migration 11 (reviews)', () => {
  const at = appliedAt();
  const owner = '10000000-0000-4000-8000-000000000001';
  const other = '10000000-0000-4000-8000-000000000002';
  const profile = '11000000-0000-4000-8000-000000000001';
  const axis = '12000000-0000-4000-8000-000000000001';
  const otherAxis = '12000000-0000-4000-8000-000000000002';
  const outcome = '13000000-0000-4000-8000-000000000001';
  const project = '14000000-0000-4000-8000-000000000001';
  const milestone = '15000000-0000-4000-8000-000000000001';
  const action = '16000000-0000-4000-8000-000000000001';
  const routine = '17000000-0000-4000-8000-000000000001';
  const commitment = '18000000-0000-4000-8000-000000000001';
  const review = (index: number) => `1b000000-0000-4000-8000-00000000000${String(index)}`;
  const item = (index: number) => `1c000000-0000-4000-8000-00000000000${String(index)}`;

  type Value = string | number | null;

  /** A version-10 (Today and Focus) database with every pre-review shape and each legacy target kind. */
  async function openVersionTen() {
    const driver = await openTemporaryDatabase();
    await runMigrations(driver, schemaMigrations.slice(0, 10), appliedAt);
    const insert = async (table: string, row: Record<string, Value>) => {
      const values = { created_at: at, updated_at: at, ...row };
      const columns = Object.keys(values);
      await driver.run(
        `INSERT INTO ${table} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')});`,
        Object.values(values),
      );
    };
    await insert('planning_identities', { id: owner, identity_kind: 'local' });
    await insert('planning_identities', { id: other, identity_kind: 'local' });
    await insert('profiles', {
      id: profile,
      owner_id: owner,
      planning_time_zone: 'UTC',
      week_start: 'monday',
      time_format: '24_hour',
    });
    await insert('axes', {
      id: axis,
      owner_id: owner,
      title: 'Axis',
      state: 'active',
      sort_key: 'a',
    });
    await insert('axes', {
      id: otherAxis,
      owner_id: other,
      title: 'Other axis',
      state: 'active',
      sort_key: 'a',
    });
    await insert('outcomes', {
      id: outcome,
      owner_id: owner,
      axis_id: axis,
      title: 'Outcome',
      success_definition: 'Done',
      state: 'active',
      progress_mode: 'none',
      sort_key: 'a',
    });
    await insert('projects', {
      id: project,
      owner_id: owner,
      axis_id: axis,
      title: 'Project',
      state: 'active',
      desired_result: 'Result',
      sort_key: 'a',
    });
    await insert('milestones', {
      id: milestone,
      owner_id: owner,
      outcome_id: outcome,
      title: 'Milestone',
      measurable_checkpoint: 'Measured',
      state: 'active',
      sort_key: 'a',
    });
    await insert('actions', {
      id: action,
      owner_id: owner,
      project_id: project,
      title: 'Action',
      state: 'planned',
      sort_key: 'a',
    });
    await insert('routines', {
      id: routine,
      owner_id: owner,
      title: 'Routine',
      state: 'active',
      sort_key: 'a',
    });
    await insert('commitments', {
      id: commitment,
      owner_id: owner,
      title: 'Commitment',
      strength: 'soft',
      state: 'planned',
    });
    const checkpoint = (index: number, row: Record<string, Value>) =>
      insert('review_checkpoints', {
        id: review(index),
        owner_id: owner,
        profile_id: profile,
        ...row,
      });
    await checkpoint(1, {
      review_type: 'daily',
      period_key: '2026-07-20',
      period_start_date: '2026-07-20',
      period_end_date: '2026-07-20',
      notes: 'A calm day',
      energy: 'low',
      state: 'draft',
    });
    await checkpoint(2, {
      review_type: 'weekly',
      period_key: '2026-07-13',
      period_start_date: '2026-07-13',
      period_end_date: '2026-07-19',
      week_start: 'monday',
      state: 'completed',
      completed_at: at,
      local_revision: 4,
      server_revision: 2,
      client_updated_at: at,
      device_id: 'device-a',
      base_snapshot_hash: 'hash-a',
    });
    await checkpoint(3, {
      review_type: 'monthly',
      period_key: '2026-06',
      period_start_date: '2026-06-01',
      period_end_date: '2026-06-30',
      state: 'archived',
      state_before_archive: 'draft',
      archived_at: at,
    });
    await checkpoint(4, {
      review_type: 'yearly',
      period_key: '2025',
      period_start_date: '2025-01-01',
      period_end_date: '2025-12-31',
      state: 'skipped',
    });
    // Legacy rows could hold any energy text on any review type; they are kept as they are.
    await checkpoint(5, {
      review_type: 'weekly',
      period_key: '2026-07-06',
      period_start_date: '2026-07-06',
      period_end_date: '2026-07-12',
      week_start: 'monday',
      energy: 'steady',
      state: 'draft',
    });
    const reviewItem = (index: number, reviewIndex: number, row: Record<string, Value>) =>
      insert('review_items', {
        id: item(index),
        owner_id: owner,
        review_id: review(reviewIndex),
        sort_key: `k${String(index)}`,
        ...row,
      });
    await reviewItem(1, 1, { action_id: action, decision: 'carry' });
    await reviewItem(2, 1, { action_id: action, decision: 'complete', decision_note: 'Early' });
    await reviewItem(3, 2, {
      project_id: project,
      decision: 'continue',
      local_revision: 3,
      server_revision: 2,
      client_updated_at: at,
      device_id: 'device-a',
      base_snapshot_hash: 'hash-b',
    });
    await reviewItem(4, 2, { milestone_id: milestone, decision: 'focus' });
    await reviewItem(5, 3, { outcome_id: outcome, decision: 'pause' });
    await reviewItem(6, 3, { routine_id: routine, decision: 'focus' });
    await reviewItem(7, 4, { commitment_id: commitment, decision: 'cancel' });
    await reviewItem(8, 4, { outcome_id: outcome, decision: 'archive', deleted_at: at });
    return { driver, insert };
  }

  const legacyItemColumns = `id, owner_id, review_id, outcome_id, milestone_id, project_id,
    action_id, routine_id, commitment_id, decision, decision_note, sort_key, created_at,
    updated_at, local_revision, server_revision, deleted_at, client_updated_at, device_id,
    base_snapshot_hash`;
  const legacyReviewColumns = `id, owner_id, profile_id, review_type, period_key,
    period_start_date, period_end_date, week_start, notes, energy, state, state_before_archive,
    completed_at, archived_at, created_at, updated_at, local_revision, server_revision,
    deleted_at, client_updated_at, device_id, base_snapshot_hash`;
  const planningTables = [
    'axes',
    'outcomes',
    'projects',
    'milestones',
    'actions',
    'routines',
    'commitments',
    'profiles',
  ];

  it('upgrades a Today and Focus database, copying every review row and value', async () => {
    const { driver } = await openVersionTen();
    const snapshot = async () => {
      const rows: Record<string, object[]> = {
        review_items: await driver.all<object>(
          `SELECT ${legacyItemColumns} FROM review_items ORDER BY id;`,
        ),
        review_checkpoints: await driver.all<object>(
          `SELECT ${legacyReviewColumns} FROM review_checkpoints ORDER BY id;`,
        ),
      };
      for (const table of planningTables) {
        rows[table] = await driver.all<object>(`SELECT * FROM ${table} ORDER BY id;`);
      }
      return rows;
    };
    const before = await snapshot();
    expect(before['review_items']).toHaveLength(8);
    expect(before['review_checkpoints']).toHaveLength(5);

    await expect(runMigrations(driver, schemaMigrations.slice(0, 11), appliedAt)).resolves.toEqual({
      fromVersion: 10,
      toVersion: 11,
      appliedVersions: [11],
    });
    await expect(snapshot()).resolves.toEqual(before);
    await expect(
      driver.all<object>(
        `SELECT id, target_kind, axis_id, target_deleted_at, detail_json, archived_at
         FROM review_items ORDER BY id;`,
      ),
    ).resolves.toEqual(
      (
        [
          [1, 'action'],
          [2, 'action'],
          [3, 'project'],
          [4, 'milestone'],
          [5, 'outcome'],
          [6, 'routine'],
          [7, 'commitment'],
          [8, 'outcome'],
        ] as const
      ).map(([index, kind]) => ({
        id: item(index),
        target_kind: kind,
        axis_id: null,
        target_deleted_at: null,
        detail_json: null,
        archived_at: null,
      })),
    );
    await expect(
      driver.all<object>(
        `SELECT DISTINCT theme_text, direction_choice, direction_text FROM review_checkpoints;`,
      ),
    ).resolves.toEqual([{ theme_text: null, direction_choice: null, direction_text: null }]);

    const names = async (type: string) =>
      (
        await driver.all<{ name: string }>(
          'SELECT name FROM sqlite_master WHERE type = ? ORDER BY name;',
          [type],
        )
      ).map(({ name }) => name);
    expect(await names('index')).toEqual(
      expect.arrayContaining([
        'idx_review_items_review',
        'idx_review_items_outcome',
        'idx_review_items_project',
        'idx_review_items_milestone',
        'idx_review_items_action',
        'idx_review_items_axis',
        'idx_review_items_routine',
        'idx_review_history',
        'idx_review_history_all',
        'idx_review_drafts',
        'uq_active_review_period',
        'idx_milestones_order',
      ]),
    );
    expect(await names('table')).not.toContain('review_items_rebuilt');
    expect(await names('trigger')).toEqual(
      expect.arrayContaining([
        'trg_review_checkpoints_fields_insert',
        'trg_review_checkpoints_fields_update',
      ]),
    );

    const explain = async (sql: string, parameters: readonly string[]) =>
      (await driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters))
        .map(({ detail }) => detail)
        .join('\n');
    for (const [column, index, target] of [
      ['outcome_id', 'idx_review_items_outcome', outcome],
      ['project_id', 'idx_review_items_project', project],
      ['milestone_id', 'idx_review_items_milestone', milestone],
      ['action_id', 'idx_review_items_action', action],
      ['axis_id', 'idx_review_items_axis', axis],
      ['routine_id', 'idx_review_items_routine', routine],
    ] as const) {
      await expect(
        explain(`SELECT COUNT(*) FROM review_items WHERE owner_id = ? AND ${column} = ?;`, [
          owner,
          target,
        ]),
      ).resolves.toContain(index);
    }
    await expect(
      explain(
        `SELECT id FROM review_items WHERE owner_id = ? AND review_id = ? AND deleted_at IS NULL
         ORDER BY sort_key, id;`,
        [owner, review(1)],
      ),
    ).resolves.toContain('idx_review_items_review');

    await expect(driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await expect(driver.get<object>('PRAGMA integrity_check;')).resolves.toEqual({
      integrity_check: 'ok',
    });
    // Reopening applies nothing more.
    await expect(runMigrations(driver, schemaMigrations.slice(0, 11), appliedAt)).resolves.toEqual({
      fromVersion: 11,
      toVersion: 11,
      appliedVersions: [],
    });
    await driver.close();
  });

  it('enforces review fields by type without blocking changes to existing rows', async () => {
    const { driver, insert } = await openVersionTen();
    await runMigrations(driver, schemaMigrations, appliedAt);
    let next = 10;
    const checkpoint = (row: Record<string, Value>) => {
      next += 1;
      return insert('review_checkpoints', {
        id: `1d000000-0000-4000-8000-0000000000${String(next)}`,
        owner_id: owner,
        profile_id: profile,
        state: 'draft',
        ...row,
      });
    };
    const day = (date: string, row: Record<string, Value> = {}) =>
      checkpoint({
        review_type: 'daily',
        period_key: date,
        period_start_date: date,
        period_end_date: date,
        ...row,
      });
    const week = (start: string, end: string, row: Record<string, Value> = {}) =>
      checkpoint({
        review_type: 'weekly',
        period_key: start,
        period_start_date: start,
        period_end_date: end,
        week_start: 'monday',
        ...row,
      });
    const month = (key: string, end: string, row: Record<string, Value> = {}) =>
      checkpoint({
        review_type: 'monthly',
        period_key: key,
        period_start_date: `${key}-01`,
        period_end_date: end,
        ...row,
      });
    const year = (key: string, row: Record<string, Value> = {}) =>
      checkpoint({
        review_type: 'yearly',
        period_key: key,
        period_start_date: `${key}-01-01`,
        period_end_date: `${key}-12-31`,
        ...row,
      });

    // Energy: daily only, from the domain set.
    await expect(week('2026-08-03', '2026-08-09', { energy: 'low' })).rejects.toThrow();
    await expect(day('2026-08-01', { energy: 'tired' })).rejects.toThrow();
    await day('2026-08-02', { energy: 'focused' });
    await expect(
      driver.run('UPDATE review_checkpoints SET energy = ? WHERE id = ?;', ['tired', review(1)]),
    ).rejects.toThrow();
    await expect(
      driver.run(
        `UPDATE review_checkpoints SET review_type = 'weekly', week_start = 'monday',
           period_end_date = '2026-07-26'
         WHERE id = ?;`,
        [review(1)],
      ),
    ).rejects.toThrow();

    // Theme: monthly only.
    await expect(day('2026-08-03', { theme_text: 'Steady' })).rejects.toThrow();
    await month('2026-08', '2026-08-31', { theme_text: 'Steady' });

    // Direction: yearly only; text exactly when the choice is `new`.
    await expect(
      month('2026-09', '2026-09-30', { direction_choice: 'continue' }),
    ).rejects.toThrow();
    await expect(year('2026', { direction_choice: 'someday' })).rejects.toThrow();
    await expect(
      year('2026', { direction_choice: 'continue', direction_text: 'Kept' }),
    ).rejects.toThrow();
    await expect(year('2026', { direction_text: 'Unchosen' })).rejects.toThrow();
    await expect(year('2026', { direction_choice: 'new' })).rejects.toThrow();
    await year('2026', { direction_choice: 'new', direction_text: 'A new direction' });
    await year('2024', { direction_choice: 'outdated' });
    await expect(
      driver.run(
        `UPDATE review_checkpoints SET direction_choice = 'continue'
         WHERE owner_id = ? AND review_type = 'yearly' AND period_key = '2026';`,
        [owner],
      ),
    ).rejects.toThrow();

    // Not a text cap: long text is stored (caps live on command input and the codecs).
    await day('2026-08-04', { notes: 'n'.repeat(20_000) });

    // A legacy row with legacy energy can still be archived and edited.
    await driver.run(
      `UPDATE review_checkpoints SET state = 'archived', state_before_archive = 'draft',
         archived_at = ?, notes = ?, local_revision = local_revision + 1
       WHERE id = ?;`,
      [at, 'Kept', review(5)],
    );
    await expect(
      driver.get('SELECT energy, state FROM review_checkpoints WHERE id = ?;', [review(5)]),
    ).resolves.toEqual({ energy: 'steady', state: 'archived' });
    await driver.close();
  });

  it('enforces one typed target, a cleared-target marker, decisions, and JSON details', async () => {
    const { driver, insert } = await openVersionTen();
    await runMigrations(driver, schemaMigrations, appliedAt);
    let next = 20;
    const reviewItem = (row: Record<string, Value>) => {
      next += 1;
      return insert('review_items', {
        id: `1e000000-0000-4000-8000-0000000000${String(next)}`,
        owner_id: owner,
        review_id: review(2),
        sort_key: `s${String(next)}`,
        ...row,
      });
    };

    for (const decision of ['move', 'skip', 'commit', 'note']) {
      await reviewItem({ target_kind: 'action', action_id: action, decision });
    }
    await expect(
      reviewItem({ target_kind: 'action', action_id: action, decision: 'defer' }),
    ).rejects.toThrow();
    await expect(
      reviewItem({ target_kind: 'someday', action_id: action, decision: 'focus' }),
    ).rejects.toThrow();
    await expect(reviewItem({ action_id: action, decision: 'focus' })).rejects.toThrow();

    // The one non-null target column must match the kind.
    await expect(
      reviewItem({ target_kind: 'action', project_id: project, decision: 'commit' }),
    ).rejects.toThrow();
    await expect(
      reviewItem({ target_kind: 'routine_occurrence', action_id: action, decision: 'focus' }),
    ).rejects.toThrow();
    await expect(
      reviewItem({
        target_kind: 'action',
        action_id: action,
        project_id: project,
        decision: 'commit',
      }),
    ).rejects.toThrow();
    await expect(reviewItem({ target_kind: 'axis', decision: 'note' })).rejects.toThrow();
    await reviewItem({
      target_kind: 'axis',
      axis_id: axis,
      decision: 'note',
      decision_note: 'Walks',
    });
    await reviewItem({
      target_kind: 'routine_occurrence',
      routine_id: routine,
      decision: 'focus',
      detail_json:
        '{"v":1,"occurrence":{"generation":1,"period":{"kind":"date","date":"2026-07-14"}}}',
    });
    // Owner-scoped references: another identity's Axis is never a target.
    await expect(
      reviewItem({ target_kind: 'axis', axis_id: otherAxis, decision: 'note' }),
    ).rejects.toThrow();

    // A cleared (permanently deleted) target keeps the decision with no reference.
    await reviewItem({ target_kind: 'project', target_deleted_at: at, decision: 'continue' });
    await expect(
      reviewItem({
        target_kind: 'project',
        project_id: project,
        target_deleted_at: at,
        decision: 'continue',
      }),
    ).rejects.toThrow();

    await expect(
      reviewItem({ target_kind: 'action', action_id: action, decision: 'move', detail_json: '{' }),
    ).rejects.toThrow();
    await expect(driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await driver.close();
  });
});

describe('migration 12 (reminder targets)', () => {
  const at = appliedAt();
  const owner = '10000000-0000-4000-8000-000000000001';
  const other = '10000000-0000-4000-8000-000000000002';
  const profile = '11000000-0000-4000-8000-000000000001';
  const otherProfile = '11000000-0000-4000-8000-000000000002';
  const action = '16000000-0000-4000-8000-000000000001';
  const block = (index: number) => `19000000-0000-4000-8000-00000000000${String(index)}`;
  const routine = (index: number) => `17000000-0000-4000-8000-00000000000${String(index)}`;
  const review = (index: number) => `1b000000-0000-4000-8000-00000000000${String(index)}`;
  const reminder = (index: number) =>
    `1d000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`;

  type Value = string | number | null;

  /** A version-11 (reviews) database with reminders of every target kind and state. */
  async function openVersionEleven() {
    const driver = await openTemporaryDatabase();
    await runMigrations(driver, schemaMigrations.slice(0, 11), appliedAt);
    const insert = async (table: string, row: Record<string, Value>) => {
      const values = { created_at: at, updated_at: at, ...row };
      const columns = Object.keys(values);
      await driver.run(
        `INSERT INTO ${table} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')});`,
        Object.values(values),
      );
    };
    for (const [identity, profileId] of [
      [owner, profile],
      [other, otherProfile],
    ] as const) {
      await insert('planning_identities', { id: identity, identity_kind: 'local' });
      await insert('profiles', {
        id: profileId,
        owner_id: identity,
        planning_time_zone: 'UTC',
        week_start: 'monday',
        time_format: '24_hour',
      });
    }
    await insert('actions', {
      id: action,
      owner_id: owner,
      title: 'Synthetic Action',
      state: 'scheduled',
      capture_origin: 'plan',
      sort_key: 'a',
    });
    for (const index of [1, 2]) {
      await insert('time_blocks', {
        id: block(index),
        owner_id: owner,
        custom_title: `Block ${String(index)}`,
        starts_at_utc: `2026-10-0${String(index)}T09:00:00.000Z`,
        ends_at_utc: `2026-10-0${String(index)}T10:00:00.000Z`,
        time_zone: 'UTC',
        state: 'planned',
      });
      await insert('routines', {
        id: routine(index),
        owner_id: owner,
        title: `Routine ${String(index)}`,
        state: 'active',
        sort_key: String(index),
      });
      await insert('review_checkpoints', {
        id: review(index),
        owner_id: owner,
        profile_id: profile,
        review_type: 'monthly',
        period_key: `2026-0${String(index + 7)}`,
        period_start_date: `2026-0${String(index + 7)}-01`,
        period_end_date: `2026-0${String(index + 7)}-28`,
        state: 'draft',
      });
    }
    const remind = (index: number, target: Record<string, Value>, state = 'scheduled') =>
      insert('reminders', {
        id: reminder(index),
        owner_id: owner,
        schedule_kind: 'relative',
        remind_at_utc: '2026-10-01T08:45:00.000Z',
        offset_minutes: -15,
        time_zone: 'UTC',
        state,
        ...target,
      });
    await remind(1, { action_id: action });
    await remind(2, { action_id: action }, 'canceled');
    await remind(3, { time_block_id: block(1) });
    await remind(4, { time_block_id: block(1) }, 'canceled');
    await remind(5, { routine_id: routine(1) });
    await remind(6, { review_id: review(1) }, 'delivered');
    await remind(7, { review_id: review(1) });
    return { driver, remind };
  }

  it('upgrades a version-11 database, keeping every reminder row and value', async () => {
    const { driver } = await openVersionEleven();
    const snapshot = () => driver.all<object>('SELECT * FROM reminders ORDER BY id;');
    const before = await snapshot();
    expect(before).toHaveLength(7);

    await expect(runMigrations(driver, schemaMigrations.slice(0, 12), appliedAt)).resolves.toEqual({
      fromVersion: 11,
      toVersion: 12,
      appliedVersions: [12],
    });
    await expect(snapshot()).resolves.toEqual(before);

    const indexes = (
      await driver.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reminders'
         ORDER BY name;`,
      )
    ).map(({ name }) => name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'uq_scheduled_action_reminder',
        'uq_scheduled_time_block_reminder',
        'uq_scheduled_routine_reminder',
        'uq_scheduled_review_reminder',
        'idx_reminders_action',
        'idx_reminders_time_block',
        'idx_reminders_routine',
        'idx_reminders_review',
        'idx_reminders_due',
      ]),
    );

    const explain = async (sql: string, parameters: readonly string[]) =>
      (await driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters))
        .map(({ detail }) => detail)
        .join('\n');
    for (const [column, index, target] of [
      ['time_block_id', 'idx_reminders_time_block', block(1)],
      ['routine_id', 'idx_reminders_routine', routine(1)],
      ['review_id', 'idx_reminders_review', review(1)],
    ] as const) {
      await expect(
        explain(
          `SELECT id FROM reminders
           WHERE owner_id = ? AND ${column} = ? AND deleted_at IS NULL;`,
          [owner, target],
        ),
      ).resolves.toContain(index);
    }
    // The partial unique indexes can answer "the scheduled reminder of this target" on their own.
    for (const [column, index, target] of [
      ['time_block_id', 'uq_scheduled_time_block_reminder', block(1)],
      ['routine_id', 'uq_scheduled_routine_reminder', routine(1)],
      ['review_id', 'uq_scheduled_review_reminder', review(1)],
    ] as const) {
      await expect(
        explain(
          `SELECT id FROM reminders INDEXED BY ${index}
           WHERE owner_id = ? AND ${column} = ? AND state = 'scheduled' AND deleted_at IS NULL;`,
          [owner, target],
        ),
      ).resolves.toContain(index);
    }

    await expect(driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await expect(driver.get<object>('PRAGMA integrity_check;')).resolves.toEqual({
      integrity_check: 'ok',
    });
    // Reopening applies nothing more.
    await expect(runMigrations(driver, schemaMigrations.slice(0, 12), appliedAt)).resolves.toEqual({
      fromVersion: 12,
      toVersion: 12,
      appliedVersions: [],
    });
    await driver.close();
  });

  it('allows one scheduled reminder per Time Block, Routine, and review, and any number off', async () => {
    const { driver, remind } = await openVersionEleven();
    await runMigrations(driver, schemaMigrations, appliedAt);

    // A second scheduled reminder for the same target is refused, for each target kind.
    await expect(remind(10, { time_block_id: block(1) })).rejects.toThrow();
    await expect(remind(11, { routine_id: routine(1) })).rejects.toThrow();
    await expect(remind(12, { review_id: review(1) })).rejects.toThrow();
    await expect(remind(13, { action_id: action })).rejects.toThrow();

    // Reminders that are off or delivered never count, and other targets are independent.
    await remind(14, { time_block_id: block(1) }, 'canceled');
    await remind(15, { routine_id: routine(1) }, 'canceled');
    await remind(16, { review_id: review(1) }, 'canceled');
    await remind(17, { routine_id: routine(2) });
    await remind(18, { review_id: review(2) });

    // Turning the scheduled one off frees the target for another one, and only one.
    await driver.run(`UPDATE reminders SET state = 'canceled' WHERE id = ?;`, [reminder(3)]);
    await driver.run(`UPDATE reminders SET state = 'scheduled' WHERE id = ?;`, [reminder(4)]);
    await expect(
      driver.run(`UPDATE reminders SET state = 'scheduled' WHERE id = ?;`, [reminder(14)]),
    ).rejects.toThrow();

    // A scheduled reminder follows a superseding block by changing its target in place, but never
    // onto a block that already has a scheduled reminder.
    await driver.run(`UPDATE reminders SET time_block_id = ? WHERE id = ?;`, [
      block(2),
      reminder(4),
    ]);
    await remind(19, { time_block_id: block(1) });
    await expect(
      driver.run(`UPDATE reminders SET time_block_id = ? WHERE id = ?;`, [block(2), reminder(19)]),
    ).rejects.toThrow();

    // Exactly one target per reminder, and only a target of the same identity.
    await expect(
      remind(20, { time_block_id: block(2), routine_id: routine(2) }, 'canceled'),
    ).rejects.toThrow();
    await expect(
      driver.run(
        `INSERT INTO reminders (id, owner_id, routine_id, schedule_kind, remind_at_utc,
           time_zone, state, created_at, updated_at)
         VALUES (?, ?, ?, 'at', ?, 'UTC', 'scheduled', ?, ?);`,
        [reminder(21), other, routine(2), at, at, at],
      ),
    ).rejects.toThrow();
    await expect(driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await driver.close();
  });
});

describe('migration 13 (review cleared lists)', () => {
  const at = appliedAt();
  const owner = '10000000-0000-4000-8000-000000000001';
  const profile = '11000000-0000-4000-8000-000000000001';
  const action = '16000000-0000-4000-8000-000000000001';
  const review = (index: number) => `1b000000-0000-4000-8000-00000000000${String(index)}`;
  const item = (index: number) => `1e000000-0000-4000-8000-00000000000${String(index)}`;
  const reminder = '1d000000-0000-4000-8000-000000000001';

  type Value = string | number | null;

  /** A version-12 database with a review of every type and state, items, and a reminder. */
  async function openVersionTwelve() {
    const driver = await openTemporaryDatabase();
    await runMigrations(driver, schemaMigrations.slice(0, 12), appliedAt);
    const insert = async (table: string, row: Record<string, Value>) => {
      const values = { created_at: at, updated_at: at, ...row };
      const columns = Object.keys(values);
      await driver.run(
        `INSERT INTO ${table} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')});`,
        Object.values(values),
      );
    };
    await insert('planning_identities', { id: owner, identity_kind: 'local' });
    await insert('profiles', {
      id: profile,
      owner_id: owner,
      planning_time_zone: 'UTC',
      week_start: 'monday',
      time_format: '24_hour',
    });
    await insert('actions', {
      id: action,
      owner_id: owner,
      title: 'Synthetic Action',
      state: 'planned',
      capture_origin: 'plan',
      sort_key: 'a',
    });
    const checkpoint = (index: number, row: Record<string, Value>) =>
      insert('review_checkpoints', {
        id: review(index),
        owner_id: owner,
        profile_id: profile,
        state: 'draft',
        ...row,
      });
    await checkpoint(1, {
      review_type: 'daily',
      period_key: '2026-09-28',
      period_start_date: '2026-09-28',
      period_end_date: '2026-09-28',
      notes: 'A steady day',
      energy: 'medium',
    });
    await checkpoint(2, {
      review_type: 'weekly',
      period_key: '2026-09-21',
      period_start_date: '2026-09-21',
      period_end_date: '2026-09-27',
      week_start: 'monday',
      state: 'completed',
      completed_at: at,
    });
    await checkpoint(3, {
      review_type: 'monthly',
      period_key: '2026-08',
      period_start_date: '2026-08-01',
      period_end_date: '2026-08-31',
      theme_text: 'Fewer, better things',
      state: 'skipped',
    });
    await checkpoint(4, {
      review_type: 'yearly',
      period_key: '2025',
      period_start_date: '2025-01-01',
      period_end_date: '2025-12-31',
      direction_choice: 'new',
      direction_text: 'Build calmly',
      state: 'archived',
      state_before_archive: 'draft',
      archived_at: at,
    });
    for (const [index, reviewIndex, decision] of [
      [1, 1, 'carry'],
      [2, 1, 'focus'],
      [3, 2, 'commit'],
    ] as const) {
      await insert('review_items', {
        id: item(index),
        owner_id: owner,
        review_id: review(reviewIndex),
        target_kind: 'action',
        action_id: action,
        decision,
        sort_key: String(index),
      });
    }
    await insert('reminders', {
      id: reminder,
      owner_id: owner,
      review_id: review(1),
      schedule_kind: 'at',
      remind_at_utc: '2026-09-28T18:00:00.000Z',
      time_zone: 'UTC',
      state: 'scheduled',
    });
    return { driver, insert };
  }

  const reviewColumns = `id, owner_id, profile_id, review_type, period_key, period_start_date,
    period_end_date, week_start, notes, energy, theme_text, direction_choice, direction_text,
    state, state_before_archive, completed_at, archived_at, created_at, updated_at,
    local_revision, server_revision, deleted_at, client_updated_at, device_id,
    base_snapshot_hash`;

  it('upgrades a version-12 database, keeping every review row and value', async () => {
    const { driver } = await openVersionTwelve();
    const snapshot = async () => ({
      reviews: await driver.all<object>(
        `SELECT ${reviewColumns} FROM review_checkpoints ORDER BY id;`,
      ),
      items: await driver.all<object>('SELECT * FROM review_items ORDER BY id;'),
      reminders: await driver.all<object>('SELECT * FROM reminders ORDER BY id;'),
    });
    const before = await snapshot();
    expect(before.reviews).toHaveLength(4);
    expect(before.items).toHaveLength(3);
    expect(before.reminders).toHaveLength(1);

    await expect(runMigrations(driver, schemaMigrations.slice(0, 13), appliedAt)).resolves.toEqual({
      fromVersion: 12,
      toVersion: 13,
      appliedVersions: [13],
    });
    await expect(snapshot()).resolves.toEqual(before);
    // Every existing review clears no list.
    await expect(
      driver.all<object>('SELECT DISTINCT cleared_lists_json FROM review_checkpoints;'),
    ).resolves.toEqual([{ cleared_lists_json: null }]);
    const column = (
      await driver.all<{ name: string; type: string; notnull: number; dflt_value: unknown }>(
        'PRAGMA table_info(review_checkpoints);',
      )
    ).find(({ name }) => name === 'cleared_lists_json');
    expect(column).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });

    await expect(driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await expect(driver.get<object>('PRAGMA integrity_check;')).resolves.toEqual({
      integrity_check: 'ok',
    });
    // Reopening applies nothing more.
    await expect(runMigrations(driver, schemaMigrations.slice(0, 13), appliedAt)).resolves.toEqual({
      fromVersion: 13,
      toVersion: 13,
      appliedVersions: [],
    });
    await driver.close();
  });

  it('stores only valid JSON, and leaves which lists a review may clear to the codec', async () => {
    const { driver, insert } = await openVersionTwelve();
    await runMigrations(driver, schemaMigrations, appliedAt);
    const setCleared = (index: number, value: Value) =>
      driver.run('UPDATE review_checkpoints SET cleared_lists_json = ? WHERE id = ?;', [
        value,
        review(index),
      ]);
    /** A weekly draft of the week that starts on Monday 2026-09-14. */
    const newWeek = (cleared: Value) =>
      insert('review_checkpoints', {
        id: review(5),
        owner_id: owner,
        profile_id: profile,
        review_type: 'weekly',
        period_key: '2026-09-14',
        period_start_date: '2026-09-14',
        period_end_date: '2026-09-20',
        week_start: 'monday',
        state: 'draft',
        cleared_lists_json: cleared,
      });

    await setCleared(2, '["commitments","first_day_focus"]');
    await setCleared(1, '["next_focus"]');
    await setCleared(1, null);
    await expect(setCleared(2, '["commitments"')).rejects.toThrow();
    await expect(setCleared(2, 'commitments')).rejects.toThrow();
    await expect(newWeek('{not json}')).rejects.toThrow();
    await newWeek('["first_day_focus"]');
    await expect(
      driver.all<object>(
        `SELECT id, cleared_lists_json FROM review_checkpoints
         WHERE cleared_lists_json IS NOT NULL ORDER BY id;`,
      ),
    ).resolves.toEqual([
      { id: review(2), cleared_lists_json: '["commitments","first_day_focus"]' },
      { id: review(5), cleared_lists_json: '["first_day_focus"]' },
    ]);
    // An existing row can still be changed in every other way, as before.
    await driver.run(
      `UPDATE review_checkpoints SET notes = ?, local_revision = local_revision + 1 WHERE id = ?;`,
      ['Changed later', review(3)],
    );
    await expect(driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await driver.close();
  });
});
