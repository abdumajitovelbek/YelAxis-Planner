import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  listActionBlockHistory,
  listInboxActions,
  listOutboxDispatchPage,
  listTimeBlocksInWindow,
} from '../../queries/core-queries';
import { checkDatabaseHealth } from '../health';
import { schemaMigrations } from '../migrations';
import { runMigrations } from '../migrations/migration';
import { NodeSqliteDriver } from '../testing/node-driver.node';
import { schemaInventory } from './inventory';
import { actionCaptureOrigins } from './vocabulary';

const now = '2026-07-23T00:00:00.000Z';
const appliedAt = () => now;
const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-data-schema-'));
  temporaryDirectories.push(directory);
  return join(directory, 'plan.sqlite');
}

async function insertIdentity(driver: NodeSqliteDriver, ownerId: string): Promise<void> {
  await driver.run(
    `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
     VALUES (?, ?, ?, ?);`,
    [ownerId, 'local', now, now],
  );
}

async function insertAction(
  driver: NodeSqliteDriver,
  input: { id: string; ownerId: string; state?: string; axisId?: string; sortKey?: string },
): Promise<void> {
  await driver.run(
    `INSERT INTO actions (
       id, owner_id, title, state, axis_id, sort_key, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      input.id,
      input.ownerId,
      input.id,
      input.state ?? 'inbox',
      input.axisId ?? null,
      input.sortKey ?? input.id,
      now,
      now,
    ],
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('canonical SQLite schema', () => {
  it('migrates fresh, reopens intact, and reapplies without mutation', async () => {
    const path = await temporaryDatabasePath();
    const firstConnection = new NodeSqliteDriver(path);

    const fresh = await runMigrations(firstConnection, schemaMigrations, appliedAt);
    expect(fresh).toEqual({
      fromVersion: 0,
      toVersion: schemaMigrations.length,
      appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    });
    await insertIdentity(firstConnection, 'owner-a');
    await insertAction(firstConnection, { id: 'action-a', ownerId: 'owner-a' });
    await firstConnection.run(
      `INSERT INTO actions (
         id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      ['action-onboarding', 'owner-a', 'First-plan action', 'planned', 'onboarding', 'b', now, now],
    );
    await firstConnection.close();

    const reopened = new NodeSqliteDriver(path);
    await expect(runMigrations(reopened, schemaMigrations, appliedAt)).resolves.toEqual({
      fromVersion: 19,
      toVersion: 19,
      appliedVersions: [],
    });
    await expect(
      reopened.get<{ title: string; capture_origin: string }>(
        'SELECT title, capture_origin FROM actions WHERE id = ?;',
        ['action-a'],
      ),
    ).resolves.toEqual({ title: 'action-a', capture_origin: 'global_capture' });
    await expect(
      reopened.get<{ capture_origin: string }>('SELECT capture_origin FROM actions WHERE id = ?;', [
        'action-onboarding',
      ]),
    ).resolves.toEqual({ capture_origin: 'onboarding' });
    for (const [index, captureOrigin] of actionCaptureOrigins.entries()) {
      await reopened.run(
        `INSERT INTO actions (
           id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          `action-origin-${String(index)}`,
          'owner-a',
          'Origin fixture',
          'inbox',
          captureOrigin,
          `origin-${String(index)}`,
          now,
          now,
        ],
      );
    }
    await expect(
      reopened.run(
        `INSERT INTO actions (
           id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        ['action-origin-invalid', 'owner-a', 'Origin fixture', 'inbox', 'invalid', 'z', now, now],
      ),
    ).rejects.toThrow();
    await expect(
      reopened.run(
        `INSERT INTO actions (
           id, owner_id, title, state, sort_key, archived_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        ['action-invalid-archive', 'owner-a', 'Archive', 'archived', 'za', now, now, now],
      ),
    ).rejects.toThrow();
    await expect(
      reopened.run(
        `INSERT INTO actions (
           id, owner_id, title, state, sort_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
        ['action-invalid-completion', 'owner-a', 'Complete', 'completed', 'zb', now, now],
      ),
    ).rejects.toThrow();
    await expect(
      reopened.run(
        `INSERT INTO actions (
           id, owner_id, title, state, converted_to_type, converted_to_id, sort_key,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          'action-invalid-conversion',
          'owner-a',
          'Convert',
          'planned',
          'note',
          'note-a',
          'zc',
          now,
          now,
        ],
      ),
    ).rejects.toThrow();

    const tables = await reopened.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    for (const table of schemaInventory.tables) {
      expect(tables.map((row) => row.name)).toContain(table);
    }
    const indexes = await reopened.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name;",
    );
    for (const index of schemaInventory.indexes) {
      expect(indexes.map((row) => row.name)).toContain(index);
    }
    const actionColumns = await reopened.all<{ name: string }>('PRAGMA table_info(actions);');
    expect(actionColumns.map((row) => row.name)).toEqual(
      expect.arrayContaining(['client_updated_at', 'device_id', 'base_snapshot_hash']),
    );
    const reviewItemColumns = await reopened.all<{ name: string }>(
      'PRAGMA table_info(review_items);',
    );
    expect(reviewItemColumns.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'target_kind',
        'axis_id',
        'target_deleted_at',
        'detail_json',
        'archived_at',
        'client_updated_at',
        'device_id',
        'base_snapshot_hash',
      ]),
    );
    const reviewColumns = await reopened.all<{ name: string }>(
      'PRAGMA table_info(review_checkpoints);',
    );
    expect(reviewColumns.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'theme_text',
        'direction_choice',
        'direction_text',
        'cleared_lists_json',
      ]),
    );
    const profileColumns = await reopened.all<{ name: string }>('PRAGMA table_info(profiles);');
    expect(profileColumns.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'onboarding_status',
        'onboarding_step',
        'onboarding_draft_json',
        'onboarding_artifacts_json',
        'handbook_status',
      ]),
    );
    await expect(
      reopened.run(
        `INSERT INTO contexts (
           id, owner_id, category, context_key, value_text, source, sensitivity, strength,
           future_sharing_state, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          'context-invalid',
          'owner-a',
          'preferences',
          'planning-style',
          'private',
          'user',
          'normal',
          'soft',
          'shared',
          'active',
          now,
          now,
        ],
      ),
    ).rejects.toThrow();
    await expect(
      reopened.run(
        `INSERT INTO contexts (
           id, owner_id, category, context_key, value_text, source, sensitivity, strength,
           future_sharing_state, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          'context-overclassified',
          'owner-a',
          'preferences',
          'classification',
          'private',
          'user',
          'highly_sensitive',
          'soft',
          'not_shared',
          'active',
          now,
          now,
        ],
      ),
    ).rejects.toThrow();
    await reopened.run(
      `INSERT INTO reminders (
         id, owner_id, action_id, schedule_kind, remind_at_utc, offset_minutes,
         time_zone, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        'reminder-relative',
        'owner-a',
        'action-a',
        'relative',
        '2026-07-23T08:45:00.000Z',
        -15,
        'Asia/Tashkent',
        'scheduled',
        now,
        now,
      ],
    );
    await expect(
      reopened.get<{ schedule_kind: string; offset_minutes: number }>(
        'SELECT schedule_kind, offset_minutes FROM reminders WHERE id = ?;',
        ['reminder-relative'],
      ),
    ).resolves.toEqual({ schedule_kind: 'relative', offset_minutes: -15 });

    await expect(checkDatabaseHealth(reopened)).resolves.toEqual({
      foreignKeyViolations: [],
      integrityCheck: 'ok',
    });
    await expect(reopened.get<{ foreign_keys: number }>('PRAGMA foreign_keys;')).resolves.toEqual({
      foreign_keys: 1,
    });
    await reopened.close();
  });

  it('rejects cross-owner references and preserves non-cascading required parents', async () => {
    const driver = new NodeSqliteDriver(await temporaryDatabasePath());
    await runMigrations(driver, schemaMigrations, appliedAt);
    await insertIdentity(driver, 'owner-a');
    await insertIdentity(driver, 'owner-b');
    await driver.run(
      `INSERT INTO axes (id, owner_id, title, state, sort_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      ['axis-a', 'owner-a', 'Axis', 'active', 'a', now, now],
    );

    await expect(
      insertAction(driver, { id: 'action-b', ownerId: 'owner-b', axisId: 'axis-a' }),
    ).rejects.toThrow();
    await expect(
      driver.run(
        `INSERT INTO outcomes (
           id, owner_id, title, state, progress_mode, sort_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        ['outcome-undefined', 'owner-a', 'Outcome', 'active', 'none', 'a', now, now],
      ),
    ).rejects.toThrow();
    await driver.run(
      `INSERT INTO outcomes (
         id, owner_id, title, success_definition, state, progress_mode, sort_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      ['outcome-a', 'owner-a', 'Outcome', 'Success', 'active', 'none', 'a', now, now],
    );
    await expect(
      driver.run(
        `INSERT INTO milestones (
           id, owner_id, outcome_id, title, state, sort_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        ['milestone-undefined', 'owner-a', 'outcome-a', 'Milestone', 'active', 'a', now, now],
      ),
    ).rejects.toThrow();
    await driver.run(
      `INSERT INTO milestones (
         id, owner_id, outcome_id, title, measurable_checkpoint, state, sort_key, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      ['milestone-a', 'owner-a', 'outcome-a', 'Milestone', 'Measured', 'active', 'a', now, now],
    );
    await expect(driver.run('DELETE FROM outcomes WHERE id = ?;', ['outcome-a'])).rejects.toThrow();
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM outcomes WHERE id = ?;', [
        'outcome-a',
      ]),
    ).resolves.toEqual({ count: 1 });

    await expect(
      driver.run(
        `INSERT INTO projects (
           id, owner_id, primary_outcome_id, title, state, sort_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        ['project-undefined', 'owner-a', 'outcome-a', 'Project', 'active', 'a', now, now],
      ),
    ).rejects.toThrow();
    await driver.run(
      `INSERT INTO projects (
         id, owner_id, title, state, sort_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      ['project-idea', 'owner-a', 'Idea', 'idea', 'b', now, now],
    );
    await driver.run(
      `INSERT INTO projects (
         id, owner_id, primary_outcome_id, title, desired_result, state, sort_key, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      ['project-a', 'owner-a', 'outcome-a', 'Project', 'Result', 'active', 'a', now, now],
    );
    await expect(
      driver.run(
        `INSERT INTO project_secondary_outcomes (
           id, owner_id, project_id, outcome_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?);`,
        ['link-a', 'owner-a', 'project-a', 'outcome-a', now, now],
      ),
    ).rejects.toThrow();

    await driver.close();
  });

  it('enforces one active direct placement and one current Action block', async () => {
    const driver = new NodeSqliteDriver(await temporaryDatabasePath());
    await runMigrations(driver, schemaMigrations, appliedAt);
    await insertIdentity(driver, 'owner-a');
    await insertAction(driver, { id: 'action-a', ownerId: 'owner-a', state: 'planned' });

    const placementParameters = [
      'placement-a',
      'owner-a',
      'action-a',
      'day',
      '2026-07-23',
      '2026-07-23',
      '2026-07-23',
      'a',
      now,
      now,
    ] as const;
    await driver.run(
      `INSERT INTO planning_placements (
         id, owner_id, action_id, horizon, period_key, period_start_date, period_end_date,
         sort_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      placementParameters,
    );
    await expect(
      driver.run(
        `INSERT INTO planning_placements (
           id, owner_id, action_id, horizon, period_key, period_start_date, period_end_date,
           sort_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        ['placement-b', ...placementParameters.slice(1)],
      ),
    ).rejects.toThrow();

    await driver.run(
      `INSERT INTO time_blocks (
         id, owner_id, action_id, starts_at_utc, ends_at_utc, time_zone, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        'block-a',
        'owner-a',
        'action-a',
        '2026-07-23T09:00:00.000Z',
        '2026-07-23T10:00:00.000Z',
        'Asia/Tashkent',
        'planned',
        now,
        now,
      ],
    );
    await expect(
      driver.run(
        `INSERT INTO time_blocks (
           id, owner_id, action_id, starts_at_utc, ends_at_utc, time_zone, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          'block-b',
          'owner-a',
          'action-a',
          '2026-07-23T11:00:00.000Z',
          '2026-07-23T12:00:00.000Z',
          'Asia/Tashkent',
          'planned',
          now,
          now,
        ],
      ),
    ).rejects.toThrow();

    await driver.close();
  });

  it('bounds weekly-count occurrence progress while allowing multiple session blocks', async () => {
    const driver = new NodeSqliteDriver(await temporaryDatabasePath());
    await runMigrations(driver, schemaMigrations, appliedAt);
    await insertIdentity(driver, 'owner-a');
    await driver.run(
      `INSERT INTO routines (id, owner_id, title, state, sort_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      ['routine-a', 'owner-a', 'Routine', 'active', 'a', now, now],
    );
    await driver.run(
      `INSERT INTO routine_generations (
         id, owner_id, routine_id, generation, recurrence_schema_version,
         recurrence_payload_json, starts_on, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        'generation-1',
        'owner-a',
        'routine-a',
        1,
        1,
        '{"kind":"weekly_count","targetCount":2}',
        '2026-07-21',
        now,
        now,
      ],
    );
    await driver.run(
      `INSERT INTO routine_occurrences (
         id, owner_id, routine_id, generation, logical_period_key, occurrence_kind,
         state, target_count, completed_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        'occurrence-week',
        'owner-a',
        'routine-a',
        1,
        '2026-07-21/2026-07-27',
        'weekly_count',
        'planned',
        2,
        1,
        now,
        now,
      ],
    );
    await expect(
      driver.run(
        `INSERT INTO routine_occurrences (
           id, owner_id, routine_id, generation, logical_period_key, occurrence_kind,
           state, target_count, completed_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          'occurrence-invalid',
          'owner-a',
          'routine-a',
          1,
          '2026-07-28/2026-08-03',
          'weekly_count',
          'completed',
          2,
          1,
          now,
          now,
        ],
      ),
    ).rejects.toThrow();
    await expect(
      driver.run(
        `INSERT INTO routine_occurrences (
           id, owner_id, routine_id, generation, logical_period_key, occurrence_kind,
           state, target_count, completed_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          'occurrence-extra-unconfirmed',
          'owner-a',
          'routine-a',
          1,
          '2026-08-04/2026-08-10',
          'weekly_count',
          'completed',
          2,
          3,
          now,
          now,
        ],
      ),
    ).rejects.toThrow();
    await driver.run(
      `INSERT INTO routine_occurrences (
         id, owner_id, routine_id, generation, logical_period_key, occurrence_kind,
         state, target_count, completed_count, extra_completions_confirmed, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        'occurrence-extra-confirmed',
        'owner-a',
        'routine-a',
        1,
        '2026-08-04/2026-08-10',
        'weekly_count',
        'completed',
        2,
        3,
        1,
        now,
        now,
      ],
    );

    for (const [id, start, end] of [
      ['block-session-a', '2026-07-23T09:00:00.000Z', '2026-07-23T10:00:00.000Z'],
      ['block-session-b', '2026-07-24T09:00:00.000Z', '2026-07-24T10:00:00.000Z'],
    ] as const) {
      await driver.run(
        `INSERT INTO time_blocks (
           id, owner_id, routine_occurrence_id, starts_at_utc, ends_at_utc, time_zone,
           state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [id, 'owner-a', 'occurrence-week', start, end, 'Asia/Tashkent', 'planned', now, now],
      );
    }
    await expect(
      driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM time_blocks WHERE routine_occurrence_id = ?;',
        ['occurrence-week'],
      ),
    ).resolves.toEqual({ count: 2 });
    await expect(
      driver.run(
        `INSERT INTO routine_occurrences (
           id, owner_id, routine_id, generation, logical_period_key, occurrence_kind,
           state, target_count, completed_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          'occurrence-duplicate',
          'owner-a',
          'routine-a',
          1,
          '2026-07-21/2026-07-27',
          'weekly_count',
          'completed',
          2,
          2,
          now,
          now,
        ],
      ),
    ).rejects.toThrow();

    await driver.close();
  });

  it('versions Routine Action Defaults by generation with owner-safe Project links', async () => {
    const driver = new NodeSqliteDriver(await temporaryDatabasePath());
    await runMigrations(driver, schemaMigrations, appliedAt);
    await insertIdentity(driver, 'owner-a');
    await insertIdentity(driver, 'owner-b');
    await driver.run(
      `INSERT INTO projects (
         id, owner_id, title, desired_result, state, sort_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        'project-a',
        'owner-a',
        'Project A',
        'Result A',
        'active',
        'a',
        now,
        now,
        'project-b',
        'owner-b',
        'Project B',
        'Result B',
        'active',
        'a',
        now,
        now,
      ],
    );
    await driver.run(
      `INSERT INTO routines (id, owner_id, title, state, sort_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      ['routine-a', 'owner-a', 'Routine', 'active', 'a', now, now],
    );
    for (const generation of [1, 2]) {
      await driver.run(
        `INSERT INTO routine_generations (
           id, owner_id, routine_id, generation, recurrence_schema_version,
           recurrence_payload_json, starts_on, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          `generation-${String(generation)}`,
          'owner-a',
          'routine-a',
          generation,
          1,
          '{"kind":"daily","intervalDays":1}',
          '2026-07-23',
          now,
          now,
        ],
      );
      await driver.run(
        `INSERT INTO routine_action_defaults (
           id, owner_id, routine_id, generation, project_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [
          `defaults-${String(generation)}`,
          'owner-a',
          'routine-a',
          generation,
          'project-a',
          now,
          now,
        ],
      );
    }
    await expect(
      driver.run(
        `INSERT INTO routine_action_defaults (
           id, owner_id, routine_id, generation, project_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
        ['defaults-duplicate', 'owner-a', 'routine-a', 1, 'project-a', now, now],
      ),
    ).rejects.toThrow();
    await driver.run(
      `INSERT INTO routine_generations (
         id, owner_id, routine_id, generation, recurrence_schema_version,
         recurrence_payload_json, starts_on, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        'generation-3',
        'owner-a',
        'routine-a',
        3,
        1,
        '{"kind":"daily","intervalDays":1}',
        '2026-07-23',
        now,
        now,
      ],
    );
    await expect(
      driver.run(
        `INSERT INTO routine_action_defaults (
           id, owner_id, routine_id, generation, project_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
        ['defaults-cross-owner', 'owner-a', 'routine-a', 3, 'project-b', now, now],
      ),
    ).rejects.toThrow();

    await driver.close();
  });

  it('uses bounded Inbox and block-window indexes', async () => {
    const driver = new NodeSqliteDriver(await temporaryDatabasePath());
    await runMigrations(driver, schemaMigrations, appliedAt);
    await insertIdentity(driver, 'owner-a');
    await insertAction(driver, { id: 'action-b', ownerId: 'owner-a', sortKey: 'b' });
    await insertAction(driver, { id: 'action-a', ownerId: 'owner-a', sortKey: 'a' });
    await driver.run(
      `INSERT INTO time_blocks (
         id, owner_id, custom_title, starts_at_utc, ends_at_utc, time_zone, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        'block-a',
        'owner-a',
        'Reserved',
        '2026-07-23T09:00:00.000Z',
        '2026-07-23T10:00:00.000Z',
        'Asia/Tashkent',
        'planned',
        now,
        now,
      ],
    );

    await expect(listInboxActions(driver, { ownerId: 'owner-a', limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id: 'action-a' }),
    ]);
    await expect(
      listInboxActions(driver, {
        ownerId: 'owner-a',
        limit: 10,
        after: { sortKey: 'a', id: 'action-a' },
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 'action-b' })]);
    await expect(listInboxActions(driver, { ownerId: 'owner-a', limit: 101 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      listTimeBlocksInWindow(driver, {
        ownerId: 'owner-a',
        startsBeforeUtc: '2026-07-23T10:30:00.000Z',
        endsAfterUtc: '2026-07-23T08:30:00.000Z',
        limit: 10,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 'block-a' })]);
    await expect(
      listActionBlockHistory(driver, {
        ownerId: 'owner-a',
        actionId: 'action-a',
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      listOutboxDispatchPage(driver, {
        ownerId: 'owner-a',
        readyAt: now,
        limit: 10,
      }),
    ).resolves.toEqual([]);

    const inboxPlan = await driver.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT id, title, state, sort_key, local_revision
       FROM actions
       WHERE owner_id = ? AND state = 'inbox' AND archived_at IS NULL AND deleted_at IS NULL
       ORDER BY sort_key ASC, id ASC
       LIMIT ?;`,
      ['owner-a', 25],
    );
    const blockPlan = await driver.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT id, starts_at_utc, ends_at_utc, time_zone, state
       FROM time_blocks
       WHERE owner_id = ? AND deleted_at IS NULL
         AND starts_at_utc < ? AND ends_at_utc > ?
       ORDER BY starts_at_utc ASC, id ASC
       LIMIT ?;`,
      ['owner-a', '2026-07-24T00:00:00.000Z', '2026-07-23T00:00:00.000Z', 50],
    );
    const historyPlan = await driver.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT id, starts_at_utc
       FROM time_blocks
       WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL
       ORDER BY starts_at_utc DESC, id DESC
       LIMIT ?;`,
      ['owner-a', 'action-a', 50],
    );
    const outboxPlan = await driver.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT id, mutation_group_id, sequence
       FROM sync_outbox INDEXED BY idx_sync_outbox_dispatch
       WHERE owner_id = ? AND deleted_at IS NULL
         AND state IN ('pending', 'retry_wait') AND state = 'pending'
       ORDER BY mutation_group_id ASC, sequence ASC, id ASC
       LIMIT ?;`,
      ['owner-a', 50],
    );
    expect(inboxPlan.map((row) => row.detail).join(' ')).toContain('idx_actions_inbox_order');
    expect(blockPlan.map((row) => row.detail).join(' ')).toContain('idx_time_blocks_window');
    expect(historyPlan.map((row) => row.detail).join(' ')).toContain(
      'idx_time_blocks_action_history',
    );
    expect(outboxPlan.map((row) => row.detail).join(' ')).toContain('idx_sync_outbox_dispatch');

    await driver.close();
  });
});
