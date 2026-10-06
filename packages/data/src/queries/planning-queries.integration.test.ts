import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPlanningApplication,
  executeCommand,
  type ApplicationDependencies,
  type CanonicalMutation,
} from '@yelaxis/application';
import {
  occurrenceLogicalKey,
  ok,
  routineOccurrenceId,
  type CalendarDate,
  type EntityRef,
  type EntityType,
  type GeneratedOccurrencePeriod,
  type Instant,
  type OwnerId,
  type UUID,
  type YearKey,
} from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { createSqliteApplicationAdapters } from '../application/sqlite-adapters';
import type { SqliteParameter } from '../sqlite/driver';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { planningQuerySql, SqlitePlanningQueries } from './planning-queries';

const now = '2026-09-27T09:00:00.000Z' as Instant;
const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
const other = '10000000-0000-4000-8000-000000000002' as OwnerId;
const profile = '11000000-0000-4000-8000-000000000001' as UUID;
const otherProfile = '11000000-0000-4000-8000-000000000002' as UUID;
const week = { start: '2026-09-28' as CalendarDate, end: '2026-10-04' as CalendarDate };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Stable synthetic ids: `id(7, 3)` → `07000000-0000-4000-8000-000000000003`. */
const id = (group: number, index: number) =>
  `${group.toString(16).padStart(2, '0')}000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}` as UUID;

const ids = {
  healthAxis: id(1, 1),
  oldAxis: id(1, 2),
  garden: id(2, 1),
  archivedProject: id(2, 2),
  outcomeRun: id(3, 1),
  outcomeHome: id(3, 2),
  outcomeAchieved: id(3, 3),
  outcomeFloating: id(3, 4),
  milestoneDone: id(4, 1),
  milestonePlaced: id(4, 2),
  milestoneArchived: id(4, 3),
  milestoneStartOnly: id(4, 4),
  action: (index: number) => id(5, index),
  block: (index: number) => id(6, index),
  commitment: id(7, 1),
  placement: (index: number) => id(8, index),
  selection: (index: number) => id(9, index),
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-planning-queries-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(driver, schemaMigrations, () => now);
  const insert = async (table: string, row: Record<string, SqliteParameter>) => {
    const values = { created_at: now, updated_at: now, ...row };
    const columns = Object.keys(values);
    await driver.run(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')});`,
      Object.values(values),
    );
  };
  for (const [ownerId, profileId] of [
    [owner, profile],
    [other, otherProfile],
  ] as const) {
    await insert('planning_identities', { id: ownerId, identity_kind: 'local' });
    await insert('profiles', {
      id: profileId,
      owner_id: ownerId,
      planning_time_zone: 'Asia/Tashkent',
      week_start: 'monday',
      time_format: '24_hour',
    });
  }
  let counter = 1;
  const nextId = () => id(9, 0x1000 + counter++);
  const adapters = createSqliteApplicationAdapters(driver, { ownerId: owner });
  const dependencies: ApplicationDependencies = {
    ...adapters,
    ids: { next: nextId },
    clock: { now: () => now },
    projections: { notifyCommitted() {} },
  };
  const commit = async (mutations: readonly CanonicalMutation[]) => {
    const result = await executeCommand(
      dependencies,
      {
        commandId: nextId(),
        ownerId: owner,
        actor: 'user',
        expectedRevisions: [],
        input: {},
      },
      ({ context }) =>
        ok({
          value: mutations,
          touched: mutations.map((mutation) => mutation.ref),
          events: mutations.map((mutation) => ({
            aggregate: mutation.ref,
            eventType: 'planning.test_seeded',
            version: 1 as const,
            actor: context.actor,
            commandId: context.commandId,
            occurredAt: context.now,
            payload: { operation: mutation.operation },
          })),
        }),
    );
    if (!result.ok) throw new Error(`Seed command failed: ${JSON.stringify(result.error)}`);
  };
  const create = (
    type: EntityType,
    entityId: UUID,
    document: Readonly<Record<string, unknown>>,
  ): CanonicalMutation => ({
    operation: 'create',
    ref: { type, id: entityId, ownerId: owner },
    expectedRevision: null,
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document,
  });
  return {
    driver,
    insert,
    commit,
    create,
    dependencies,
    queries: new SqlitePlanningQueries(driver),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const action = (
  index: number,
  state: string,
  extra: Record<string, SqliteParameter> = {},
): Record<string, SqliteParameter> => ({
  id: ids.action(index),
  owner_id: owner,
  title: `Action ${String(index)}`,
  state,
  capture_origin: 'plan',
  sort_key: `a${String(index).padStart(2, '0')}`,
  ...extra,
});

const dayPlacement = (index: number, actionIndex: number, date: string, archived = false) => ({
  id: ids.placement(index),
  owner_id: owner,
  action_id: ids.action(actionIndex),
  horizon: 'day',
  period_key: date,
  period_start_date: date,
  period_end_date: date,
  sort_key: `p${String(index).padStart(2, '0')}`,
  archived_at: archived ? now : null,
});

const block = (
  index: number,
  startsAt: string,
  endsAt: string,
  target: Record<string, SqliteParameter>,
  state = 'planned',
  extra: Record<string, SqliteParameter> = {},
) => ({
  id: ids.block(index),
  owner_id: owner,
  starts_at_utc: startsAt,
  ends_at_utc: endsAt,
  time_zone: 'Asia/Tashkent',
  state,
  ...target,
  ...extra,
});

const routineId = id(10, 1);
const archivedRoutineId = id(10, 2);
const weeklyRoutineId = id(10, 3);
const timedMode = {
  kind: 'time_specific',
  wallTime: '07:30',
  durationMinutes: 30,
  zonePolicy: { kind: 'follow_profile' },
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
};
const occurrence = (
  routine: UUID,
  period:
    | { kind: 'date'; date: string }
    | { kind: 'week'; start: string; end: string; weekStart: 'monday'; targetCount: number },
  extra: Record<string, unknown> = {},
) => {
  const logical = occurrenceLogicalKey(routine, 1, period as GeneratedOccurrencePeriod);
  return {
    id: routineOccurrenceId(logical),
    document: {
      routineId: routine,
      generation: 1,
      periodKey:
        period.kind === 'date' ? period.date : `${period.start}/${period.end}/${period.weekStart}`,
      period,
      state: 'planned',
      ...(period.kind === 'week' ? { targetCount: period.targetCount, completedCount: 0 } : {}),
      ...extra,
    },
  };
};

/** A realistic plan for one week plus a second identity that must never leak. */
async function seed({ insert, commit, create }: Fixture) {
  await insert('axes', {
    id: ids.healthAxis,
    owner_id: owner,
    title: 'Health',
    state: 'active',
    sort_key: 'a',
  });
  await insert('axes', {
    id: ids.oldAxis,
    owner_id: owner,
    title: 'Old',
    state: 'archived',
    state_before_archive: 'active',
    sort_key: 'b',
    archived_at: now,
  });
  await insert('projects', {
    id: ids.garden,
    owner_id: owner,
    axis_id: ids.healthAxis,
    title: 'Garden',
    desired_result: 'Beds planted',
    state: 'active',
    sort_key: 'a',
    target_start_date: '2026-10-10',
    target_end_date: '2026-10-15',
  });
  await insert('projects', {
    id: ids.archivedProject,
    owner_id: owner,
    title: 'Shelved',
    state: 'archived',
    state_before_archive: 'idea',
    sort_key: 'b',
    archived_at: now,
    target_end_date: '2026-10-01',
  });
  const outcome = (outcomeId: UUID, title: string, extra: Record<string, SqliteParameter>) =>
    insert('outcomes', {
      id: outcomeId,
      owner_id: owner,
      title,
      success_definition: `${title} done`,
      state: 'active',
      progress_mode: 'none',
      sort_key: title,
      ...extra,
    });
  await outcome(ids.outcomeRun, 'Run', {
    axis_id: ids.healthAxis,
    progress_mode: 'manual',
    progress_percent: 40,
    target_start_date: '2026-10-01',
    target_end_date: '2026-12-31',
  });
  await outcome(ids.outcomeHome, 'Home', { state: 'paused', progress_mode: 'milestone_derived' });
  await outcome(ids.outcomeAchieved, 'Achieved', {
    state: 'achieved',
    target_end_date: '2026-10-02',
  });
  await outcome(ids.outcomeFloating, 'Floating', {});
  const milestone = (milestoneId: UUID, title: string, extra: Record<string, SqliteParameter>) =>
    insert('milestones', {
      id: milestoneId,
      owner_id: owner,
      outcome_id: ids.outcomeHome,
      title,
      measurable_checkpoint: `${title} checkpoint`,
      state: 'active',
      sort_key: title,
      ...extra,
    });
  await milestone(ids.milestoneDone, 'Done', { state: 'completed', target_end_date: '2026-10-20' });
  await milestone(ids.milestonePlaced, 'Placed', {});
  await milestone(ids.milestoneArchived, 'Archived', {
    state: 'archived',
    state_before_archive: 'active',
    archived_at: now,
    target_end_date: '2026-09-30',
  });
  await milestone(ids.milestoneStartOnly, 'Start only', {
    outcome_id: ids.outcomeRun,
    target_start_date: '2026-10-02',
  });

  await insert(
    'actions',
    action(1, 'planned', {
      axis_id: ids.healthAxis,
      project_id: ids.garden,
      estimate_minutes: 45,
      energy: 'focused',
      priority: 'high',
      due_date: '2026-10-02',
    }),
  );
  await insert('actions', action(2, 'scheduled'));
  await insert(
    'actions',
    action(3, 'planned', {
      due_at_utc: '2026-10-03T10:00:00.000Z',
      due_time_zone: 'Asia/Tashkent',
    }),
  );
  await insert('actions', action(4, 'in_progress'));
  await insert('actions', action(5, 'planned'));
  await insert('actions', action(6, 'planned'));
  await insert('actions', action(7, 'completed', { completed_at: now }));
  await insert(
    'actions',
    action(8, 'archived', { state_before_archive: 'planned', archived_at: now }),
  );
  await insert('actions', action(9, 'inbox'));
  await insert('actions', action(10, 'planned'));

  await insert('planning_placements', dayPlacement(1, 1, '2026-09-29'));
  await insert('planning_placements', dayPlacement(2, 2, '2026-09-30'));
  await insert('planning_placements', dayPlacement(3, 5, '2026-09-20'));
  await insert('planning_placements', {
    id: ids.placement(4),
    owner_id: owner,
    action_id: ids.action(6),
    horizon: 'week',
    period_key: '2026-09-21',
    period_start_date: '2026-09-21',
    period_end_date: '2026-09-27',
    week_start: 'monday',
    sort_key: 'p04',
  });
  await insert('planning_placements', dayPlacement(5, 7, '2026-09-20'));
  await insert('planning_placements', dayPlacement(6, 10, '2026-09-29', true));
  await insert('planning_placements', {
    id: ids.placement(7),
    owner_id: owner,
    milestone_id: ids.milestonePlaced,
    horizon: 'week',
    period_key: '2026-09-28',
    period_start_date: '2026-09-28',
    period_end_date: '2026-10-04',
    week_start: 'monday',
    sort_key: 'p07',
  });
  await insert('planning_placements', {
    id: ids.placement(8),
    owner_id: owner,
    outcome_id: ids.outcomeHome,
    horizon: 'month',
    period_key: '2026-10',
    period_start_date: '2026-10-01',
    period_end_date: '2026-10-31',
    sort_key: 'p08',
  });
  await insert('planning_placements', {
    id: ids.placement(9),
    owner_id: owner,
    project_id: ids.archivedProject,
    horizon: 'month',
    period_key: '2026-10',
    period_start_date: '2026-10-01',
    period_end_date: '2026-10-31',
    sort_key: 'p09',
  });
  await insert('planning_placements', {
    id: ids.placement(10),
    owner_id: owner,
    project_id: ids.garden,
    horizon: 'year',
    period_key: '2026',
    period_start_date: '2026-01-01',
    period_end_date: '2026-12-31',
    sort_key: 'p10',
  });

  await insert('commitments', {
    id: ids.commitment,
    owner_id: owner,
    title: 'Dentist',
    strength: 'hard',
    state: 'planned',
  });

  await commit([
    create('routine', routineId, {
      title: 'Morning walk',
      axisId: ids.healthAxis,
      orderKey: 'a',
      state: 'active',
      generations: [
        {
          generation: 1,
          rule: {
            version: 1,
            kind: 'weekly_days',
            intervalWeeks: 1,
            weekdays: ['monday', 'wednesday'],
            startsOn: '2026-09-01',
          },
          schedulingMode: timedMode,
        },
      ],
    }),
    create('routine', archivedRoutineId, {
      title: 'Old habit',
      orderKey: 'b',
      state: 'archived',
      stateBeforeArchive: 'active',
      archivedAt: now,
      generations: [
        {
          generation: 1,
          rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-01-01' },
          schedulingMode: { kind: 'day_flexible' },
        },
      ],
    }),
    create('routine', weeklyRoutineId, {
      title: 'Strength',
      orderKey: 'c',
      state: 'active',
      generations: [
        {
          generation: 1,
          rule: {
            version: 1,
            kind: 'weekly_count',
            targetCount: 3,
            weekStart: 'monday',
            startsOn: '2026-09-01',
          },
          schedulingMode: { kind: 'day_flexible' },
        },
      ],
    }),
    create('routine_action_defaults', id(11, 1), {
      routineId,
      generation: 1,
      projectId: ids.garden,
      estimateMinutes: 30,
    }),
  ]);
  const completedMonday = occurrence(
    routineId,
    { kind: 'date', date: '2026-09-28' },
    {
      state: 'completed',
      completedAt: now,
    },
  );
  const moved = occurrence(
    routineId,
    { kind: 'date', date: '2026-09-23' },
    {
      override: { date: '2026-09-29', wallTime: '19:00', durationMinutes: 30 },
    },
  );
  const old = occurrence(routineId, { kind: 'date', date: '2026-09-14' }, { state: 'skipped' });
  const lastWeek = occurrence(weeklyRoutineId, {
    kind: 'week',
    start: '2026-09-21',
    end: '2026-09-27',
    weekStart: 'monday',
    targetCount: 3,
  });
  const thisWeek = occurrence(
    weeklyRoutineId,
    { kind: 'week', start: '2026-09-28', end: '2026-10-04', weekStart: 'monday', targetCount: 3 },
    { completedCount: 1 },
  );
  await commit(
    [completedMonday, moved, old, lastWeek, thisWeek].map((item) =>
      create('routine_occurrence', item.id, item.document),
    ),
  );

  // Blocks, in the planning zone (UTC+5). The local day 2026-09-30 is 09-29T19:00Z..09-30T19:00Z.
  await insert(
    'time_blocks',
    block(1, '2026-09-30T04:00:00.000Z', '2026-09-30T05:00:00.000Z', { action_id: ids.action(2) }),
  );
  await insert(
    'time_blocks',
    block(2, '2026-09-29T18:00:00.000Z', '2026-09-29T20:00:00.000Z', {
      custom_title: 'Night shift',
    }),
  );
  await insert(
    'time_blocks',
    block(
      3,
      '2026-09-30T02:00:00.000Z',
      '2026-09-30T03:00:00.000Z',
      { action_id: ids.action(2) },
      'canceled',
      {
        superseded_by_id: ids.block(1),
      },
    ),
  );
  await insert(
    'time_blocks',
    block(
      4,
      '2026-09-30T06:00:00.000Z',
      '2026-09-30T07:00:00.000Z',
      { custom_title: 'Canceled' },
      'canceled',
    ),
  );
  await insert(
    'time_blocks',
    block(
      5,
      '2026-09-30T08:00:00.000Z',
      '2026-09-30T09:00:00.000Z',
      { custom_title: 'Done' },
      'completed',
    ),
  );
  await insert(
    'time_blocks',
    block(6, '2026-09-30T10:00:00.000Z', '2026-09-30T11:00:00.000Z', {
      commitment_id: ids.commitment,
    }),
  );
  await insert(
    'time_blocks',
    block(
      7,
      '2026-09-30T12:00:00.000Z',
      '2026-09-30T12:30:00.000Z',
      { routine_occurrence_id: completedMonday.id },
      'completed',
    ),
  );
  await insert(
    'time_blocks',
    block(8, '2026-09-29T17:00:00.000Z', '2026-09-29T19:00:00.000Z', { custom_title: 'Touching' }),
  );

  await insert('week_selections', {
    id: ids.selection(1),
    owner_id: owner,
    profile_id: profile,
    project_id: ids.garden,
    period_start_date: '2026-09-28',
    period_end_date: '2026-10-04',
    week_start: 'monday',
    sort_key: 'a',
  });
  await insert('week_selections', {
    id: ids.selection(2),
    owner_id: owner,
    profile_id: profile,
    action_id: ids.action(1),
    period_start_date: '2026-09-21',
    period_end_date: '2026-09-27',
    week_start: 'monday',
    sort_key: 'a',
  });
  await insert('week_selections', {
    id: ids.selection(3),
    owner_id: owner,
    profile_id: profile,
    milestone_id: ids.milestonePlaced,
    period_start_date: '2026-09-28',
    period_end_date: '2026-10-04',
    week_start: 'monday',
    sort_key: 'b',
    archived_at: now,
  });
  await insert('week_selections', {
    id: ids.selection(4),
    owner_id: owner,
    profile_id: profile,
    action_id: ids.action(8),
    period_start_date: '2026-09-28',
    period_end_date: '2026-10-04',
    week_start: 'monday',
    sort_key: 'c',
  });

  const contextId = id(12, 1);
  await insert('contexts', {
    id: contextId,
    owner_id: owner,
    category: 'availability',
    context_key: 'work',
    value_text: 'Work hours',
    source: 'user',
    sensitivity: 'normal',
    strength: 'soft',
    state: 'active',
  });
  await commit([
    create('constraint', id(13, 1), {
      contextId,
      constraintKind: 'availability',
      strength: 'soft',
      value: {
        kind: 'availability',
        windows: [{ weekday: 'monday', start: '09:00', end: '17:00' }],
      },
      state: 'active',
    }),
    create('constraint', id(13, 2), {
      constraintKind: 'capacity',
      strength: 'hard',
      value: { kind: 'capacity', period: 'week', minutes: 1_800 },
      state: 'active',
    }),
    create('constraint', id(13, 3), {
      constraintKind: 'capacity',
      strength: 'hard',
      value: { kind: 'capacity', period: 'day', minutes: 300 },
      state: 'archived',
      stateBeforeArchive: 'active',
      archivedAt: now,
    }),
    create('constraint', id(13, 4), {
      constraintKind: 'other',
      strength: 'soft',
      value: { kind: 'other', description: 'Not capacity' },
      state: 'active',
    }),
    create('theme', id(14, 1), { profileId: profile, month: '2026-10', text: 'Plant beds' }),
    create('theme', id(14, 2), {
      profileId: profile,
      month: '2026-11',
      text: 'Cleared',
      archivedAt: now,
    }),
    create('theme', id(14, 3), { profileId: profile, month: '2025-10', text: 'Last year' }),
    create('direction', id(15, 1), { profileId: profile, year: '2026', text: 'Calmer weeks' }),
    create('template', id(16, 1), {
      title: 'Beta',
      blueprint: { version: 1, items: [{ templateKey: 'a', kind: 'action', title: 'A' }] },
      state: 'active',
    }),
    create('template', id(16, 2), {
      title: 'Alpha',
      blueprint: { version: 1, items: [{ templateKey: 'a', kind: 'action', title: 'A' }] },
      state: 'archived',
      stateBeforeArchive: 'active',
      archivedAt: now,
    }),
    create('template', id(16, 3), {
      title: 'Alpha weekly',
      blueprint: {
        version: 2,
        items: [{ templateKey: 'a', kind: 'action', title: 'A', relativeDayOffset: 1 }],
      },
      state: 'active',
    }),
  ]);
  await insert('milestone_projects', {
    id: id(17, 1),
    owner_id: owner,
    milestone_id: ids.milestonePlaced,
    project_id: ids.garden,
  });
  await insert('milestone_projects', {
    id: id(17, 2),
    owner_id: owner,
    milestone_id: ids.milestonePlaced,
    project_id: ids.archivedProject,
  });
  await insert('milestone_actions', {
    id: id(18, 1),
    owner_id: owner,
    milestone_id: ids.milestonePlaced,
    action_id: ids.action(1),
  });

  // Second identity: overlapping data that must never appear for `owner`.
  await insert('actions', {
    id: id(19, 1),
    owner_id: other,
    title: 'Private',
    state: 'planned',
    capture_origin: 'plan',
    sort_key: 'a',
  });
  await insert('time_blocks', {
    id: id(19, 2),
    owner_id: other,
    custom_title: 'Private block',
    starts_at_utc: '2026-09-30T04:00:00.000Z',
    ends_at_utc: '2026-09-30T05:00:00.000Z',
    time_zone: 'UTC',
    state: 'planned',
  });
  await insert('planning_placements', {
    id: id(19, 3),
    owner_id: other,
    action_id: id(19, 1),
    horizon: 'day',
    period_key: '2026-09-30',
    period_start_date: '2026-09-30',
    period_end_date: '2026-09-30',
    sort_key: 'a',
  });
  return { completedMonday, moved, old, lastWeek, thisWeek };
}

async function plan(driver: NodeSqliteDriver, sql: string, parameters: SqliteParameter[]) {
  const rows = await driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters);
  return rows.map(({ detail }) => detail).join('\n');
}

describe('SqlitePlanningQueries', () => {
  it('reads the plan profile and fails closed without confirmed defaults', async () => {
    const context = await fixture();
    await expect(context.queries.getPlanProfile(owner)).resolves.toEqual({
      profileId: profile,
      planningTimeZone: 'Asia/Tashkent',
      weekStart: 'monday',
      timeFormat: '24_hour',
      localRevision: 1,
      createdAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u,
      ) as unknown,
    });
    await context.driver.run('UPDATE profiles SET time_format = NULL WHERE id = ?;', [profile]);
    await expect(context.queries.getPlanProfile(owner)).rejects.toMatchObject({
      code: 'invalid_identity_record',
    });
  });

  it('lists blocks intersecting a local day, across midnight, excluding superseded and canceled', async () => {
    const context = await fixture();
    const seeded = await seed(context);
    const blocks = await context.queries.listBlocks(
      owner,
      '2026-09-29T19:00:00.000Z' as Instant,
      '2026-09-30T19:00:00.000Z' as Instant,
    );
    expect(blocks.map((row) => row.id)).toEqual([
      ids.block(2),
      ids.block(1),
      ids.block(5),
      ids.block(6),
      ids.block(7),
    ]);
    expect(blocks[0]).toEqual({
      id: ids.block(2),
      localRevision: 1,
      startsAt: '2026-09-29T18:00:00.000Z',
      endsAt: '2026-09-29T20:00:00.000Z',
      timeZone: 'Asia/Tashkent',
      state: 'planned',
      overlapAcknowledged: false,
      target: { kind: 'custom', title: 'Night shift' },
    });
    expect(blocks[1]?.target).toEqual({
      kind: 'action',
      actionId: ids.action(2),
      title: 'Action 2',
      actionState: 'scheduled',
      actionRevision: 1,
    });
    expect(blocks[2]?.state).toBe('completed');
    expect(blocks[3]?.target).toEqual({
      kind: 'commitment',
      commitmentId: ids.commitment,
      title: 'Dentist',
      strength: 'hard',
      commitmentState: 'planned',
      commitmentRevision: 1,
    });
    expect(blocks[4]?.target).toEqual({
      kind: 'routine_occurrence',
      routineOccurrenceId: seeded.completedMonday.id,
      title: 'Morning walk',
    });
    await expect(
      plan(context.driver, planningQuerySql.listBlocks, [owner, 'b', 'a']),
    ).resolves.toContain('idx_time_blocks_overlap_end');
  });

  it('lists active placements of every horizon overlapping a range, without archived targets', async () => {
    const context = await fixture();
    await seed(context);
    const placements = await context.queries.listPlacements(owner, week);
    expect(placements.map((row) => row.id)).toEqual([
      ids.placement(10),
      ids.placement(7),
      ids.placement(1),
      ids.placement(2),
      ids.placement(8),
    ]);
    const [year, weekly, day] = placements;
    expect(year).toMatchObject({
      period: { kind: 'year', year: '2026' },
      target: {
        kind: 'project',
        id: ids.garden,
        title: 'Garden',
        state: 'active',
        localRevision: 1,
      },
    });
    expect(weekly).toMatchObject({
      period: { kind: 'week', start: '2026-09-28', end: '2026-10-04', weekStart: 'monday' },
      target: {
        kind: 'milestone',
        id: ids.milestonePlaced,
        outcomeId: ids.outcomeHome,
        outcomeTitle: 'Home',
      },
    });
    expect(day).toEqual({
      id: ids.placement(1),
      localRevision: 1,
      period: { kind: 'day', date: '2026-09-29' },
      orderKey: 'p01',
      target: {
        kind: 'action',
        action: {
          id: ids.action(1),
          title: 'Action 1',
          state: 'planned',
          localRevision: 1,
          orderKey: 'a01',
          estimateMinutes: 45,
          energy: 'focused',
          priority: 'high',
          due: { kind: 'date', date: '2026-10-02' },
          axisTitle: 'Health',
          projectTitle: 'Garden',
          placement: {
            id: ids.placement(1),
            localRevision: 1,
            period: { kind: 'day', date: '2026-09-29' },
          },
        },
      },
    });
    expect(placements[4]).toMatchObject({
      period: { kind: 'month', month: '2026-10' },
      target: { kind: 'outcome', id: ids.outcomeHome, state: 'paused' },
    });
    await expect(
      plan(context.driver, planningQuerySql.listPlacements, [owner, week.end, week.start]),
    ).resolves.toContain('idx_placements_overlap_end');
  });

  it('separates Backlog from carry-forward', async () => {
    const context = await fixture();
    await seed(context);
    const backlog = await context.queries.listBacklog(owner, 50);
    expect(backlog.total).toBe(3);
    expect(backlog.items.map((item) => item.id)).toEqual([
      ids.action(3),
      ids.action(4),
      ids.action(10),
    ]);
    expect(backlog.items[0]).toEqual({
      id: ids.action(3),
      title: 'Action 3',
      state: 'planned',
      localRevision: 1,
      orderKey: 'a03',
      due: {
        kind: 'instant',
        instant: '2026-10-03T10:00:00.000Z',
        authoredTimeZone: 'Asia/Tashkent',
      },
    });
    const firstOnly = await context.queries.listBacklog(owner, 1);
    expect(firstOnly).toMatchObject({ total: 3, items: [{ id: ids.action(3) }] });

    const carry = await context.queries.listCarryForward(owner, week.start, 50);
    expect(carry.total).toBe(2);
    expect(carry.items.map((item) => [item.id, item.placement?.period])).toEqual([
      [ids.action(5), { kind: 'day', date: '2026-09-20' }],
      [
        ids.action(6),
        { kind: 'week', start: '2026-09-21', end: '2026-09-27', weekStart: 'monday' },
      ],
    ]);
    const earlier = await context.queries.listCarryForward(owner, '2026-09-21' as CalendarDate, 50);
    expect(earlier.items.map((item) => item.id)).toEqual([ids.action(5)]);

    await expect(
      plan(context.driver, planningQuerySql.listBacklog, [owner, 10]),
    ).resolves.toContain('idx_actions_planning_state');
    await expect(
      plan(context.driver, planningQuerySql.listCarryForward, [owner, week.start, week.start, 10]),
    ).resolves.toContain('idx_placements_period');
    await expect(context.queries.listBacklog(owner, -1)).rejects.toThrow(RangeError);
  });

  it('caps unbounded lists at 200 rows while reporting the full total', async () => {
    const context = await fixture();
    for (let index = 0; index < 205; index += 1) {
      await context.insert('actions', {
        id: id(20, index + 1),
        owner_id: owner,
        title: `Bulk ${String(index)}`,
        state: 'planned',
        capture_origin: 'plan',
        sort_key: `b${String(index).padStart(3, '0')}`,
      });
    }
    const page = await context.queries.listBacklog(owner, 1_000);
    expect(page.items).toHaveLength(200);
    expect(page.total).toBe(205);
  });

  it('lists week commitments overlapping a range with their targets', async () => {
    const context = await fixture();
    await seed(context);
    const selections = await context.queries.listWeekSelections(owner, week);
    expect(selections).toEqual([
      {
        id: ids.selection(1),
        localRevision: 1,
        period: { kind: 'week', start: '2026-09-28', end: '2026-10-04', weekStart: 'monday' },
        orderKey: 'a',
        target: { kind: 'project', id: ids.garden, title: 'Garden', state: 'active' },
      },
    ]);
    await expect(
      plan(context.driver, planningQuerySql.listWeekSelections, [owner, week.end, week.start]),
    ).resolves.toContain('idx_week_selections_overlap_end');
  });

  it('reads Routines with generations, axis title, and current defaults', async () => {
    const context = await fixture();
    await seed(context);
    const active = await context.queries.listRoutines(owner, { includeArchived: false });
    expect(active.map((row) => row.id)).toEqual([routineId, weeklyRoutineId]);
    expect(active[0]).toMatchObject({
      localRevision: 1,
      axisTitle: 'Health',
      document: { title: 'Morning walk', state: 'active', generations: [{ generation: 1 }] },
      defaults: {
        id: id(11, 1),
        localRevision: 1,
        routineId,
        generation: 1,
        projectId: ids.garden,
        projectTitle: 'Garden',
        estimateMinutes: 30,
      },
    });
    expect(active[1]?.defaults).toBeUndefined();
    const all = await context.queries.listRoutines(owner, { includeArchived: true });
    expect(all.map((row) => row.id)).toEqual([routineId, archivedRoutineId, weeklyRoutineId]);
    await expect(context.queries.getRoutine(owner, routineId)).resolves.toEqual(active[0]);
    await expect(context.queries.getRoutine(other, routineId)).resolves.toBeNull();
  });

  it('finds materialized occurrences by logical date, override date, or weekly period', async () => {
    const context = await fixture();
    const seeded = await seed(context);
    const found = await context.queries.listMaterializedOccurrences(owner, week);
    expect(found.map((row) => row.id).sort()).toEqual(
      [seeded.completedMonday.id, seeded.moved.id, seeded.thisWeek.id].sort(),
    );
    const moved = found.find((row) => row.id === seeded.moved.id);
    expect(moved).toEqual({
      id: seeded.moved.id,
      routineId,
      generation: 1,
      logicalKey: occurrenceLogicalKey(routineId, 1, {
        kind: 'date',
        date: '2026-09-23' as CalendarDate,
      }),
      period: { kind: 'date', date: '2026-09-23' },
      state: 'planned',
      localRevision: 1,
      override: { date: '2026-09-29', wallTime: '19:00', durationMinutes: 30 },
    });
    const weekly = found.find((row) => row.id === seeded.thisWeek.id);
    expect(weekly).toMatchObject({ targetCount: 3, completedCount: 1, state: 'planned' });

    const onlyWeekly = await context.queries.listMaterializedOccurrences(
      owner,
      { start: '2026-09-27' as CalendarDate, end: '2026-09-27' as CalendarDate },
      weeklyRoutineId,
    );
    expect(onlyWeekly.map((row) => row.id)).toEqual([seeded.lastWeek.id]);
    // The logical date moved away: the original date no longer finds it, only via its period.
    const logicalDay = await context.queries.listMaterializedOccurrences(owner, {
      start: '2026-09-23' as CalendarDate,
      end: '2026-09-23' as CalendarDate,
    });
    expect(logicalDay.map((row) => row.id)).toEqual(
      expect.arrayContaining([seeded.moved.id, seeded.lastWeek.id]),
    );
    await expect(context.queries.listMaterializedOccurrences(other, week)).resolves.toEqual([]);

    const history = await context.queries.listOccurrenceHistory(owner, routineId, 2);
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.routineId)).toEqual([routineId, routineId]);
    await expect(
      plan(context.driver, planningQuerySql.occurrenceHistory, [owner, routineId, 5]),
    ).resolves.toContain('idx_routine_occurrences_history');
    const occurrencePlan = await plan(context.driver, planningQuerySql.listOccurrences, [
      owner,
      '2026-09-22',
      '2026-10-04/~',
      owner,
      week.start,
      week.end,
    ]);
    expect(occurrencePlan).toContain('idx_routine_occurrences_overlap_end');
    expect(occurrencePlan).toContain('idx_routine_occurrences_override_date');
  });

  it('lists active capacity constraints with their Context label', async () => {
    const context = await fixture();
    await seed(context);
    const constraints = await context.queries.listCapacityConstraints(owner);
    expect(
      constraints.map((row) => [row.id, row.document.constraintKind, row.contextLabel]),
    ).toEqual([
      [id(13, 1), 'availability', 'Work hours'],
      [id(13, 2), 'capacity', undefined],
    ]);
    await expect(
      plan(context.driver, planningQuerySql.capacityConstraints, [owner]),
    ).resolves.toContain('idx_constraints_kind');
  });

  it('retains active capacity constraints beyond the former 200-row boundary', async () => {
    const context = await fixture();
    await context.commit(
      Array.from({ length: 203 }, (_, index) =>
        context.create('constraint', id(0x35, index + 1), {
          constraintKind: 'capacity',
          strength: 'hard',
          state: 'active',
          value: { kind: 'capacity', period: 'day', minutes: index === 202 ? 1 : 300 },
        }),
      ),
    );
    const rows = await context.queries.listCapacityConstraints(owner);
    expect(rows).toHaveLength(203);
    expect(rows.at(-1)?.document.value).toEqual({ kind: 'capacity', period: 'day', minutes: 1 });
    await expect(context.queries.listCapacityConstraints(other)).resolves.toEqual([]);
    await context.driver.close();
  });

  it('reads active Month themes and the Year direction', async () => {
    const context = await fixture();
    await seed(context);
    await expect(context.queries.listMonthThemes(owner, '2026' as YearKey)).resolves.toEqual([
      { id: id(14, 1), localRevision: 1, month: '2026-10', text: 'Plant beds' },
    ]);
    await expect(context.queries.getYearDirection(owner, '2026' as YearKey)).resolves.toEqual({
      id: id(15, 1),
      localRevision: 1,
      year: '2026',
      text: 'Calmer weeks',
    });
    await expect(context.queries.getYearDirection(owner, '2027' as YearKey)).resolves.toBeNull();
    await expect(context.queries.getYearDirection(other, '2026' as YearKey)).resolves.toBeNull();
  });

  it('lists Outcomes, Milestones, and Projects placed in or targeting a range', async () => {
    const context = await fixture();
    await seed(context);
    const october = { start: '2026-10-01' as CalendarDate, end: '2026-10-31' as CalendarDate };
    const outcomes = await context.queries.listOutcomes(owner, october);
    expect(outcomes.map((row) => row.id)).toEqual([ids.outcomeHome, ids.outcomeRun]);
    expect(outcomes[0]).toEqual({
      id: ids.outcomeHome,
      title: 'Home',
      successDefinition: 'Home done',
      state: 'paused',
      localRevision: 1,
      progress: { mode: 'milestone_derived', completed: 1, total: 2, canceled: 0 },
      placement: { id: ids.placement(8), period: { kind: 'month', month: '2026-10' } },
    });
    expect(outcomes[1]).toMatchObject({
      axisTitle: 'Health',
      targetStart: '2026-10-01',
      targetEnd: '2026-12-31',
      progress: { mode: 'manual', percentage: 40 },
    });

    const milestones = await context.queries.listMilestones(owner, week);
    expect(milestones.map((row) => row.id)).toEqual([ids.milestonePlaced, ids.milestoneStartOnly]);
    expect(milestones[1]).toEqual({
      id: ids.milestoneStartOnly,
      title: 'Start only',
      measurableCheckpoint: 'Start only checkpoint',
      state: 'active',
      localRevision: 1,
      outcomeId: ids.outcomeRun,
      outcomeTitle: 'Run',
      targetStart: '2026-10-02',
    });
    const octoberMilestones = await context.queries.listMilestones(owner, october);
    // The placed week (09-28..10-04) overlaps October, so that Milestone is listed too.
    expect(octoberMilestones.map((row) => row.id)).toEqual([
      ids.milestoneDone,
      ids.milestonePlaced,
      ids.milestoneStartOnly,
    ]);

    const projects = await context.queries.listProjectTargets(owner, {
      start: '2026-10-12' as CalendarDate,
      end: '2026-10-18' as CalendarDate,
    });
    expect(projects).toEqual([
      {
        id: ids.garden,
        title: 'Garden',
        state: 'active',
        localRevision: 1,
        axisTitle: 'Health',
        targetStart: '2026-10-10',
        targetEnd: '2026-10-15',
        placement: { id: ids.placement(10), period: { kind: 'year', year: '2026' } },
      },
    ]);
    await expect(context.queries.listOutcomes(other, october)).resolves.toEqual([]);
    await expect(
      plan(context.driver, planningQuerySql.listMilestones, [
        owner,
        owner,
        week.end,
        week.start,
        owner,
        week.start,
        week.end,
        owner,
        week.start,
        week.end,
      ]),
    ).resolves.toContain('idx_milestones_target_end');
  });

  it('reads a Milestone chain with its Outcome, Axis, and supporting work', async () => {
    const context = await fixture();
    await seed(context);
    const chain = await context.queries.getMilestoneChain(owner, ids.milestoneStartOnly);
    expect(chain).toMatchObject({
      milestone: { id: ids.milestoneStartOnly },
      outcome: { id: ids.outcomeRun, progress: { mode: 'manual', percentage: 40 } },
      axis: { id: ids.healthAxis, title: 'Health' },
      projects: [],
      actions: [],
    });
    const placed = await context.queries.getMilestoneChain(owner, ids.milestonePlaced);
    expect(placed).toMatchObject({
      outcome: { id: ids.outcomeHome },
      projects: [{ id: ids.garden, title: 'Garden', state: 'active' }],
      actions: [{ id: ids.action(1), title: 'Action 1', state: 'planned' }],
    });
    expect(placed?.axis).toBeUndefined();
    await expect(context.queries.getMilestoneChain(other, ids.milestonePlaced)).resolves.toBeNull();
  });

  it('counts milestone-derived progress over active and completed Milestones only', async () => {
    const context = await fixture();
    await seed(context);
    await context.insert('milestones', {
      id: id(4, 9),
      owner_id: owner,
      outcome_id: ids.outcomeHome,
      title: 'Dropped',
      measurable_checkpoint: 'Dropped checkpoint',
      state: 'canceled',
      sort_key: 'Dropped',
    });
    const chain = await context.queries.getMilestoneChain(owner, ids.milestonePlaced);
    // Done (completed) and Placed (active) count; Dropped (canceled) and Archived do not.
    expect(chain?.outcome.progress).toEqual({
      mode: 'milestone_derived',
      completed: 1,
      total: 2,
      canceled: 1,
    });
    await context.driver.run(`UPDATE milestones SET state = 'canceled' WHERE id = ?;`, [
      ids.milestonePlaced,
    ]);
    await context.driver.run(`UPDATE milestones SET state = 'canceled' WHERE id = ?;`, [
      ids.milestoneDone,
    ]);
    const empty = await context.queries.getMilestoneChain(owner, ids.milestonePlaced);
    expect(empty?.outcome.progress).toEqual({
      mode: 'milestone_derived',
      completed: 0,
      total: 0,
      canceled: 3,
    });
    await expect(
      plan(context.driver, planningQuerySql.getOutcome, [owner, ids.outcomeHome]),
    ).resolves.toContain('idx_milestones_outcome');
  });

  it('lists templates by title and reads choices, Actions, and records', async () => {
    const context = await fixture();
    await seed(context);
    const active = await context.queries.listTemplates(owner, { includeArchived: false });
    expect(active.map((row) => row.document.title)).toEqual(['Alpha weekly', 'Beta']);
    const all = await context.queries.listTemplates(owner, { includeArchived: true });
    expect(all.map((row) => row.document.title)).toEqual(['Alpha', 'Alpha weekly', 'Beta']);
    await expect(context.queries.getTemplate(owner, id(16, 3))).resolves.toMatchObject({
      localRevision: 1,
      document: { blueprint: { version: 2 } },
    });
    await expect(context.queries.getTemplate(other, id(16, 3))).resolves.toBeNull();

    await expect(context.queries.listAxes(owner)).resolves.toEqual([
      { id: ids.healthAxis, title: 'Health', localRevision: 1 },
    ]);
    await expect(context.queries.listProjects(owner)).resolves.toEqual([
      { id: ids.garden, title: 'Garden', localRevision: 1 },
    ]);
    await expect(context.queries.getAction(owner, ids.action(2))).resolves.toMatchObject({
      id: ids.action(2),
      state: 'scheduled',
      placement: { id: ids.placement(2), period: { kind: 'day', date: '2026-09-30' } },
    });
    await expect(context.queries.getAction(other, ids.action(2))).resolves.toBeNull();

    const actionBlock = await context.queries.getPlannedActionBlock(owner, ids.action(2));
    expect(actionBlock).toMatchObject({
      ref: { type: 'time_block', id: ids.block(1) },
      document: { state: 'planned', target: { kind: 'action', actionId: ids.action(2) } },
    });
    await expect(
      context.queries.getPlannedCommitmentBlock(owner, ids.commitment),
    ).resolves.toMatchObject({ ref: { id: ids.block(6) } });
    await expect(context.queries.getPlannedActionBlock(owner, ids.action(1))).resolves.toBeNull();

    const ref: EntityRef = { type: 'routine', id: routineId, ownerId: owner };
    await expect(context.queries.readRecord(owner, ref)).resolves.toMatchObject({
      localRevision: 1,
      document: { title: 'Morning walk' },
    });
    await expect(context.queries.readRecord(other, ref)).resolves.toBeNull();
  });

  it('finds the one active placement of each target kind by target id', async () => {
    const context = await fixture();
    await seed(context);
    await expect(
      context.queries.getActivePlacement(owner, 'action', ids.action(1)),
    ).resolves.toMatchObject({
      ref: { type: 'planning_placement', id: ids.placement(1) },
      document: { target: { kind: 'action', actionId: ids.action(1) } },
    });
    await expect(
      context.queries.getActivePlacement(owner, 'milestone', ids.milestonePlaced),
    ).resolves.toMatchObject({ ref: { id: ids.placement(7) } });
    await expect(
      context.queries.getActivePlacement(owner, 'outcome', ids.outcomeHome),
    ).resolves.toMatchObject({ ref: { id: ids.placement(8) } });
    await expect(
      context.queries.getActivePlacement(owner, 'project', ids.garden),
    ).resolves.toMatchObject({ ref: { id: ids.placement(10) } });
    // Archived placement, wrong kind for the id, and another identity all find nothing.
    await expect(
      context.queries.getActivePlacement(owner, 'action', ids.action(10)),
    ).resolves.toBeNull();
    await expect(
      context.queries.getActivePlacement(owner, 'project', ids.milestonePlaced),
    ).resolves.toBeNull();
    await expect(
      context.queries.getActivePlacement(other, 'milestone', ids.milestonePlaced),
    ).resolves.toBeNull();
    for (const [statement, index] of [
      [planningQuerySql.activeActionPlacement, 'uq_active_placement_action'],
      [planningQuerySql.activeProjectPlacement, 'uq_active_placement_project'],
      [planningQuerySql.activeMilestonePlacement, 'uq_active_placement_milestone'],
      [planningQuerySql.activeOutcomePlacement, 'uq_active_placement_outcome'],
    ] as const) {
      await expect(plan(context.driver, statement, [owner, ids.garden])).resolves.toContain(index);
    }
  });

  it('moves a Milestone placement even when more than a page of older placements exist', async () => {
    const context = await fixture();
    await seed(context);
    await context.driver.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1005)
       INSERT INTO actions (id, owner_id, title, state, capture_origin, sort_key,
                            created_at, updated_at)
       SELECT printf('30000000-0000-4000-8000-%012x', i), ?, 'Older ' || i, 'planned', 'plan',
              printf('z%05d', i), ?, ? FROM n;`,
      [owner, now, now],
    );
    await context.driver.run(
      `INSERT INTO planning_placements (
         id, owner_id, action_id, horizon, period_key, period_start_date, period_end_date,
         sort_key, created_at, updated_at
       )
       SELECT printf('31000000-0000-4000-8000-%012x', rowid), owner_id, id, 'day', '2020-01-06',
              '2020-01-06', '2020-01-06', sort_key, ?, ?
       FROM actions WHERE id LIKE '30000000-%';`,
      [now, now],
    );
    const planning = createPlanningApplication(context.dependencies, context.queries);
    const moved = await planning.place({
      target: { kind: 'milestone', id: ids.milestonePlaced, revision: 1 },
      period: { kind: 'week', date: '2026-10-05' },
    });
    expect(moved).toMatchObject({ ok: true });
    await expect(
      context.driver.all<{ id: string; period_start_date: string }>(
        `SELECT id, period_start_date FROM planning_placements
         WHERE milestone_id = ? AND archived_at IS NULL;`,
        [ids.milestonePlaced],
      ),
    ).resolves.toEqual([{ id: ids.placement(7), period_start_date: '2026-10-05' }]);
    const removed = await planning.unplace({
      target: { kind: 'milestone', id: ids.milestonePlaced, revision: 1 },
    });
    expect(removed).toMatchObject({ ok: true });
  });

  it('never returns another identity’s rows', async () => {
    const context = await fixture();
    await seed(context);
    const blocks = await context.queries.listBlocks(
      other,
      '2026-09-29T00:00:00.000Z' as Instant,
      '2026-10-01T00:00:00.000Z' as Instant,
    );
    expect(blocks.map((row) => row.id)).toEqual([id(19, 2)]);
    await expect(context.queries.listPlacements(other, week)).resolves.toHaveLength(1);
    await expect(context.queries.listBacklog(other, 10)).resolves.toMatchObject({ total: 0 });
    await expect(context.queries.listRoutines(other, { includeArchived: true })).resolves.toEqual(
      [],
    );
    await expect(context.queries.listCapacityConstraints(other)).resolves.toEqual([]);
    await expect(context.queries.listTemplates(other, { includeArchived: true })).resolves.toEqual(
      [],
    );
    await expect(context.queries.listWeekSelections(other, week)).resolves.toEqual([]);
  });
});
