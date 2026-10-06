import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAlignmentApplication,
  executeCommand,
  type ApplicationDependencies,
  type CanonicalMutation,
} from '@yelaxis/application';
import {
  alignmentLinkId,
  ok,
  spacedOrderKey,
  type AlignmentJoinRelationship,
  type EntityType,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { createSqliteApplicationAdapters } from '../application/sqlite-adapters';
import type { SqliteParameter } from '../sqlite/driver';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { alignmentQuerySql, SqliteAlignmentQueries, titleSearchPattern } from './alignment-queries';
import { SqliteReviewQueries } from './review-queries';

/*
 * alignment read model against real SQLite: every AlignmentQueryPort method, bounded lists
 * with id tie-breaks, owner isolation, index use (EXPLAIN QUERY PLAN), restart, and a
 * 2,000-Action Project. Synthetic fixtures only.
 */
const now = '2026-09-28T09:00:00.000Z' as Instant;
const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
const other = '10000000-0000-4000-8000-000000000002' as OwnerId;
const profile = '11000000-0000-4000-8000-000000000001' as UUID;
const otherProfile = '11000000-0000-4000-8000-000000000002' as UUID;
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

const s = spacedOrderKey;

const ids = {
  health: id(1, 1),
  study: id(1, 2),
  tieB: id(1, 3),
  tieA: id(1, 4),
  oldAxis: id(1, 5),
  run: id(2, 1),
  sleep: id(2, 2),
  achieved: id(2, 3),
  archivedOutcome: id(2, 4),
  floatingOutcome: id(2, 5),
  first5k: id(3, 1),
  second5k: id(3, 2),
  trail: id(3, 3),
  archivedMilestone: id(3, 4),
  orphaned: id(3, 5),
  training: id(4, 1),
  shoes: id(4, 2),
  oldPlan: id(4, 3),
  shelved: id(4, 4),
  looseIdea: id(4, 5),
  emptyActive: id(4, 6),
  warmUp: id(5, 1),
  bookTrack: id(5, 2),
  longRun: id(5, 3),
  archivedAction: id(5, 4),
  unrelated: id(5, 5),
  shoeNote: id(6, 1),
  oldNote: id(6, 2),
  axisNote: id(6, 3),
  walk: id(7, 1),
  stretch: id(7, 2),
  oldRoutine: id(7, 3),
  yearPlacement: id(8, 1),
  archivedPlacement: id(8, 2),
  monthPlacement: id(8, 3),
  weekSelection: id(9, 1),
  archivedSelection: id(9, 2),
  review: id(10, 1),
  reviewItem: id(10, 2),
  defaults: id(10, 3),
  otherAxis: id(1, 9),
  otherOutcome: id(2, 9),
  otherMilestone: id(3, 9),
  otherProject: id(4, 9),
  otherAction: id(5, 9),
};

const link = (relationship: AlignmentJoinRelationship, parentId: UUID, childId: UUID) =>
  alignmentLinkId(relationship, parentId, childId);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-alignment-queries-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'plan.sqlite');
  const driver = new NodeSqliteDriver(path);
  await runMigrations(driver, schemaMigrations, () => now);
  const context = { driver, queries: new SqliteAlignmentQueries(driver) };
  const insert = async (table: string, row: Record<string, SqliteParameter>) => {
    const values = { created_at: now, updated_at: now, ...row };
    const columns = Object.keys(values);
    await context.driver.run(
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
  const nextId = () => id(0x90, counter++);
  const commit = async (ownerId: OwnerId, mutations: readonly CanonicalMutation[]) => {
    const dependencies: ApplicationDependencies = {
      ...createSqliteApplicationAdapters(context.driver, { ownerId }),
      ids: { next: nextId },
      clock: { now: () => now },
      projections: { notifyCommitted() {} },
    };
    const result = await executeCommand(
      dependencies,
      { commandId: nextId(), ownerId, actor: 'user', expectedRevisions: [], input: {} },
      ({ context: command }) =>
        ok({
          value: mutations,
          touched: mutations.map((mutation) => mutation.ref),
          events: mutations.map((mutation) => ({
            aggregate: mutation.ref,
            eventType: 'alignment.test_seeded',
            version: 1 as const,
            actor: command.actor,
            commandId: command.commandId,
            occurredAt: command.now,
            payload: { operation: mutation.operation },
          })),
        }),
    );
    if (!result.ok) throw new Error(`Seed command failed: ${JSON.stringify(result.error)}`);
  };
  return {
    context,
    path,
    insert,
    commit,
    /** Close and reopen the database file, as a browser restart would. */
    async restart() {
      await context.driver.close();
      context.driver = new NodeSqliteDriver(path);
      await runMigrations(context.driver, schemaMigrations, () => now);
      context.queries = new SqliteAlignmentQueries(context.driver);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function create(
  type: EntityType,
  entityId: UUID,
  ownerId: OwnerId,
  document: Readonly<Record<string, unknown>>,
): CanonicalMutation {
  return {
    operation: 'create',
    ref: { type, id: entityId, ownerId },
    expectedRevision: null,
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document,
  };
}

const routine = (
  title: string,
  orderKey: string,
  state: 'active' | 'paused' | 'archived',
): Readonly<Record<string, unknown>> => ({
  title,
  axisId: ids.health,
  orderKey,
  state,
  ...(state === 'archived' ? { stateBeforeArchive: 'active', archivedAt: now } : {}),
  generations: [
    {
      generation: 1,
      rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-01-01' },
      schedulingMode: { kind: 'day_flexible' },
    },
  ],
});

/** One realistic alignment plan plus a second identity that must never leak. */
async function seed({ insert, commit }: Fixture) {
  const axis = (axisId: UUID, title: string, sortKey: string, extra = {}) =>
    insert('axes', {
      id: axisId,
      owner_id: owner,
      title,
      state: 'active',
      sort_key: sortKey,
      ...extra,
    });
  await axis(ids.health, 'Health', s(0), {
    purpose: 'Feel steady',
    color_token: 'teal',
    icon_name: 'leaf',
  });
  await axis(ids.study, 'Study', s(1));
  await axis(ids.tieA, 'Tie A', s(2));
  await axis(ids.tieB, 'Tie B', s(2));
  await axis(ids.oldAxis, 'Old', s(0).replace('1', '0'), {
    state: 'archived',
    state_before_archive: 'active',
    archived_at: now,
  });

  const outcome = (outcomeId: UUID, title: string, sortKey: string, extra = {}) =>
    insert('outcomes', {
      id: outcomeId,
      owner_id: owner,
      axis_id: ids.health,
      title,
      success_definition: `${title} done`,
      state: 'active',
      progress_mode: 'none',
      sort_key: sortKey,
      ...extra,
    });
  await outcome(ids.run, 'Run a 10k', s(0), {
    progress_mode: 'milestone_derived',
    target_start_date: '2026-10-01',
    target_end_date: '2026-12-31',
  });
  await outcome(ids.sleep, 'Sleep well', s(1), {
    state: 'paused',
    progress_mode: 'manual',
    progress_percent: 40,
  });
  await outcome(ids.achieved, 'Old goal', s(2), { state: 'achieved' });
  await outcome(ids.archivedOutcome, 'Shelved goal', s(3), {
    state: 'archived',
    state_before_archive: 'active',
    archived_at: now,
  });
  await outcome(ids.floatingOutcome, 'Floating', s(0), { axis_id: null });

  const milestone = (milestoneId: UUID, title: string, sortKey: string, extra = {}) =>
    insert('milestones', {
      id: milestoneId,
      owner_id: owner,
      outcome_id: ids.run,
      title,
      measurable_checkpoint: `${title} checkpoint`,
      state: 'active',
      sort_key: sortKey,
      ...extra,
    });
  await milestone(ids.first5k, 'First 5k', s(0), { state: 'completed' });
  await milestone(ids.second5k, 'Second 5k', s(1), { target_end_date: '2026-10-31' });
  await milestone(ids.trail, 'Trail run', s(2), { state: 'canceled' });
  await milestone(ids.archivedMilestone, 'Archived step', s(3), {
    state: 'archived',
    state_before_archive: 'active',
    archived_at: now,
  });
  await milestone(ids.orphaned, 'Under a shelved goal', s(0), { outcome_id: ids.archivedOutcome });

  const project = (projectId: UUID, title: string, sortKey: string, extra = {}) =>
    insert('projects', {
      id: projectId,
      owner_id: owner,
      axis_id: ids.health,
      title,
      state: 'idea',
      sort_key: sortKey,
      ...extra,
    });
  await project(ids.training, 'Training plan', s(0), {
    state: 'active',
    desired_result: 'Run three times a week',
    description: 'Build up slowly',
    notes: 'Keep it light',
    primary_outcome_id: ids.run,
    target_start_date: '2026-10-01',
    target_end_date: '2026-11-30',
  });
  await project(ids.shoes, 'Buy shoes', s(1));
  await project(ids.oldPlan, 'Old plan', s(2), { state: 'completed', desired_result: 'Done' });
  await project(ids.shelved, 'Shelved plan', s(3), {
    state: 'archived',
    state_before_archive: 'idea',
    archived_at: now,
  });
  await project(ids.looseIdea, 'Loose idea', s(0), { axis_id: null });
  await project(ids.emptyActive, 'Empty active', s(0), {
    axis_id: ids.study,
    state: 'active',
    desired_result: 'Something',
  });

  const action = (actionId: UUID, title: string, sortKey: string, extra = {}) =>
    insert('actions', {
      id: actionId,
      owner_id: owner,
      title,
      state: 'planned',
      capture_origin: 'plan',
      sort_key: sortKey,
      ...extra,
    });
  await action(ids.warmUp, 'Warm up', s(0), {
    project_id: ids.training,
    state: 'completed',
    completed_at: now,
  });
  await action(ids.bookTrack, 'Book track', s(1), { project_id: ids.training, state: 'inbox' });
  await action(ids.longRun, 'Long run', s(2), { project_id: ids.training, axis_id: ids.study });
  await action(ids.archivedAction, 'Archived errand', '000000500000000', {
    project_id: ids.training,
    state: 'archived',
    state_before_archive: 'planned',
    archived_at: now,
  });
  await action(ids.unrelated, 'Unrelated', s(3), { axis_id: ids.health });

  await insert('notes', {
    id: ids.shoeNote,
    owner_id: owner,
    project_id: ids.training,
    body: 'Shoe sizes',
    state: 'active',
    sort_key: 'a',
  });
  await insert('notes', {
    id: ids.oldNote,
    owner_id: owner,
    project_id: ids.training,
    title: 'Old note',
    state: 'archived',
    state_before_archive: 'active',
    sort_key: 'b',
    archived_at: now,
  });
  await insert('notes', {
    id: ids.axisNote,
    owner_id: owner,
    axis_id: ids.health,
    title: 'Axis note',
    state: 'active',
    sort_key: 'c',
  });

  await commit(owner, [
    create('routine', ids.walk, owner, routine('Morning walk', s(0), 'active')),
    create('routine', ids.stretch, owner, routine('Stretch', s(1), 'paused')),
    create('routine', ids.oldRoutine, owner, routine('Old routine', s(2), 'archived')),
    create('routine_action_defaults', ids.defaults, owner, {
      routineId: ids.walk,
      generation: 1,
      projectId: ids.training,
    }),
  ]);

  const joinRow = async (
    relationship: AlignmentJoinRelationship,
    table: string,
    parent: readonly [string, UUID],
    child: readonly [string, UUID],
    unlinked = false,
  ) =>
    insert(table, {
      id: link(relationship, parent[1], child[1]),
      owner_id: owner,
      [parent[0]]: parent[1],
      [child[0]]: child[1],
      deleted_at: unlinked ? now : null,
    });
  await joinRow(
    'outcome_secondary_project',
    'project_secondary_outcomes',
    ['outcome_id', ids.sleep],
    ['project_id', ids.training],
  );
  await joinRow(
    'outcome_secondary_project',
    'project_secondary_outcomes',
    ['outcome_id', ids.achieved],
    ['project_id', ids.training],
    true,
  );
  await joinRow(
    'milestone_project',
    'milestone_projects',
    ['milestone_id', ids.second5k],
    ['project_id', ids.training],
  );
  await joinRow(
    'milestone_project',
    'milestone_projects',
    ['milestone_id', ids.first5k],
    ['project_id', ids.shoes],
  );
  await joinRow(
    'milestone_action',
    'milestone_actions',
    ['milestone_id', ids.second5k],
    ['action_id', ids.longRun],
  );
  await joinRow(
    'milestone_action',
    'milestone_actions',
    ['milestone_id', ids.second5k],
    ['action_id', ids.bookTrack],
    true,
  );

  const placement = (
    placementId: UUID,
    target: Record<string, SqliteParameter>,
    period: Record<string, SqliteParameter>,
    archived = false,
  ) =>
    insert('planning_placements', {
      id: placementId,
      owner_id: owner,
      ...target,
      ...period,
      sort_key: 'a',
      archived_at: archived ? now : null,
    });
  const year = {
    horizon: 'year',
    period_key: '2026',
    period_start_date: '2026-01-01',
    period_end_date: '2026-12-31',
  };
  const month = (key: string, end: string) => ({
    horizon: 'month',
    period_key: key,
    period_start_date: `${key}-01`,
    period_end_date: end,
  });
  await placement(ids.yearPlacement, { outcome_id: ids.run }, year);
  await placement(
    ids.archivedPlacement,
    { outcome_id: ids.run },
    month('2026-09', '2026-09-30'),
    true,
  );
  await placement(
    ids.monthPlacement,
    { milestone_id: ids.second5k },
    month('2026-10', '2026-10-31'),
  );

  const week = {
    owner_id: owner,
    profile_id: profile,
    period_start_date: '2026-09-28',
    period_end_date: '2026-10-04',
    week_start: 'monday',
    sort_key: 'a',
  };
  await insert('week_selections', { ...week, id: ids.weekSelection, project_id: ids.training });
  await insert('week_selections', {
    ...week,
    id: ids.archivedSelection,
    milestone_id: ids.second5k,
    archived_at: now,
  });
  await insert('review_checkpoints', {
    id: ids.review,
    owner_id: owner,
    profile_id: profile,
    review_type: 'monthly',
    period_key: '2026-09',
    period_start_date: '2026-09-01',
    period_end_date: '2026-09-30',
    state: 'draft',
  });
  await insert('review_items', {
    id: ids.reviewItem,
    owner_id: owner,
    review_id: ids.review,
    target_kind: 'project',
    project_id: ids.training,
    decision: 'continue',
    sort_key: 'a',
  });

  // A second identity with the same shapes; none of it may ever leak.
  await insert('axes', {
    id: ids.otherAxis,
    owner_id: other,
    title: 'Hidden Health',
    state: 'active',
    sort_key: s(0),
  });
  await insert('outcomes', {
    id: ids.otherOutcome,
    owner_id: other,
    axis_id: ids.otherAxis,
    title: 'Hidden run',
    success_definition: 'Hidden',
    state: 'active',
    progress_mode: 'none',
    sort_key: s(0),
  });
  await insert('milestones', {
    id: ids.otherMilestone,
    owner_id: other,
    outcome_id: ids.otherOutcome,
    title: 'Hidden 5k',
    measurable_checkpoint: 'Hidden',
    state: 'active',
    sort_key: s(0),
  });
  await insert('projects', {
    id: ids.otherProject,
    owner_id: other,
    axis_id: ids.otherAxis,
    primary_outcome_id: ids.otherOutcome,
    title: 'Hidden training',
    state: 'idea',
    sort_key: s(0),
  });
  await insert('actions', {
    id: ids.otherAction,
    owner_id: other,
    project_id: ids.otherProject,
    title: 'Hidden run',
    state: 'inbox',
    capture_origin: 'plan',
    sort_key: s(0),
  });
  await insert('milestone_actions', {
    id: link('milestone_action', ids.otherMilestone, ids.otherAction),
    owner_id: other,
    milestone_id: ids.otherMilestone,
    action_id: ids.otherAction,
  });
}

const node = (kind: string, nodeId: UUID, title: string, state: string, archived = false) => ({
  id: nodeId,
  title,
  state,
  archived,
  kind,
  localRevision: 1,
});

async function plan(fixtureValue: Fixture, sql: string, parameters: readonly SqliteParameter[]) {
  const rows = await fixtureValue.context.driver.all<{ detail: string }>(
    `EXPLAIN QUERY PLAN ${sql}`,
    parameters,
  );
  return rows.map(({ detail }) => detail).join('\n');
}

describe('SqliteAlignmentQueries', () => {
  it('lists Axes in persisted order with id tie-breaks, archived last, neutral counts, and bounds', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    const current = await queries.listAxes(owner, { includeArchived: false, limit: 200 });
    expect(current.items.map((axis) => axis.id)).toEqual([
      ids.health,
      ids.study,
      ids.tieB,
      ids.tieA,
    ]);
    expect(current.total).toBe(4);
    expect(current.items[0]).toEqual({
      id: ids.health,
      localRevision: 1,
      title: 'Health',
      purpose: 'Feel steady',
      color: 'teal',
      icon: 'leaf',
      state: 'active',
      orderKey: s(0),
      counts: { outcomes: 2, projects: 2, routines: 2 },
    });
    expect(current.items[1]?.counts).toEqual({ outcomes: 0, projects: 1, routines: 0 });

    const all = await queries.listAxes(owner, { includeArchived: true, limit: 200 });
    expect(all.items.map((axis) => axis.id)).toEqual([
      ids.health,
      ids.study,
      ids.tieB,
      ids.tieA,
      ids.oldAxis,
    ]);
    expect(all.items[4]).toMatchObject({ state: 'archived', archivedAt: now });
    expect(all.total).toBe(5);
    await expect(
      queries.listAxes(owner, { includeArchived: true, limit: 2 }),
    ).resolves.toMatchObject({ items: [{ id: ids.health }, { id: ids.study }], total: 5 });
    await expect(
      queries.listAxes(owner, { includeArchived: false, limit: 999 }),
    ).resolves.toMatchObject({ total: 4 });
    await expect(queries.listAxes(other, { includeArchived: true, limit: 200 })).resolves.toEqual({
      items: [expect.objectContaining({ id: ids.otherAxis })],
      total: 1,
    });
  });

  it('reads an Axis with current members, finished members on request, Routines, and history', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    const detail = await queries.getAxis(owner, ids.health, { includeFinished: false, limit: 200 });
    expect(detail?.outcomes.items.map((outcome) => outcome.id)).toEqual([ids.run, ids.sleep]);
    expect(detail?.projects.items.map((project) => project.id)).toEqual([ids.training, ids.shoes]);
    expect(detail?.routines).toEqual({
      items: [
        node('routine', ids.walk, 'Morning walk', 'active'),
        node('routine', ids.stretch, 'Stretch', 'paused'),
      ],
      total: 2,
    });
    expect(detail?.reviewNote).toBeNull();
    expect(detail?.history).toEqual([]);

    const finished = await queries.getAxis(owner, ids.health, {
      includeFinished: true,
      limit: 200,
    });
    expect(finished?.outcomes.items.map((outcome) => outcome.id)).toEqual([
      ids.run,
      ids.sleep,
      ids.achieved,
    ]);
    expect(finished?.projects.items.map((project) => project.id)).toEqual([
      ids.training,
      ids.shoes,
      ids.oldPlan,
    ]);
    const bounded = await queries.getAxis(owner, ids.health, { includeFinished: true, limit: 1 });
    expect(bounded?.outcomes).toMatchObject({ items: [{ id: ids.run }], total: 3 });
    expect(bounded?.projects.total).toBe(3);

    await expect(
      queries.getAxis(owner, ids.oldAxis, { includeFinished: false, limit: 200 }),
    ).resolves.toMatchObject({ axis: { state: 'archived' } });
    await expect(
      queries.getAxis(owner, ids.otherAxis, { includeFinished: false, limit: 200 }),
    ).resolves.toBeNull();
    await expect(
      queries.getAxis(owner, id(1, 0x77), { includeFinished: false, limit: 200 }),
    ).resolves.toBeNull();
  });

  it('reads an Axis recent review note from its latest completed review', async () => {
    const context = await fixture();
    await seed(context);
    const { insert } = context;
    const review = (index: number) => id(10, 0x10 + index);
    const item = (index: number) => id(10, 0x20 + index);
    const week = (
      index: number,
      start: string,
      end: string,
      extra: Record<string, SqliteParameter>,
    ) =>
      insert('review_checkpoints', {
        id: review(index),
        owner_id: owner,
        profile_id: profile,
        review_type: 'weekly',
        period_key: start,
        period_start_date: start,
        period_end_date: end,
        week_start: 'monday',
        state: 'completed',
        ...extra,
      });
    const note = (
      index: number,
      reviewIndex: number,
      axisId: UUID,
      text: string,
      extra: Record<string, SqliteParameter> = {},
    ) =>
      insert('review_items', {
        id: item(index),
        owner_id: owner,
        review_id: review(reviewIndex),
        target_kind: 'axis',
        axis_id: axisId,
        decision: 'note',
        decision_note: text,
        sort_key: `n${String(index)}`,
        ...extra,
      });
    await week(1, '2026-09-14', '2026-09-20', { completed_at: '2026-09-20T18:00:00.000Z' });
    await week(2, '2026-09-21', '2026-09-27', { completed_at: '2026-09-27T18:00:00.000Z' });
    await week(3, '2026-09-28', '2026-10-04', { state: 'draft' });
    await note(1, 1, ids.health, 'Walks helped');
    await note(2, 2, ids.health, 'Rest helped');
    await note(3, 2, ids.health, 'Removed choice', { archived_at: now });
    await note(4, 2, ids.study, 'Reading helped');
    await note(5, 3, ids.health, 'Draft thought');
    const { queries } = context.context;
    const axisNote = async (axisId: UUID) =>
      (await queries.getAxis(owner, axisId, { includeFinished: false, limit: 200 }))?.reviewNote;

    await expect(axisNote(ids.health)).resolves.toEqual({
      text: 'Rest helped',
      reviewId: review(2),
      reviewType: 'weekly',
      period: {
        type: 'weekly',
        key: '2026-09-21',
        start: '2026-09-21',
        end: '2026-09-27',
        weekStart: 'monday',
      },
      completedAt: '2026-09-27T18:00:00.000Z',
    });
    await expect(axisNote(ids.study)).resolves.toMatchObject({
      text: 'Reading helped',
      reviewId: review(2),
    });
    await expect(axisNote(ids.tieA)).resolves.toBeNull();

    // A removed choice, a draft, an archived review, or a cleared reference never shows.
    await context.context.driver.run('UPDATE review_items SET archived_at = ? WHERE id = ?;', [
      now,
      item(2),
    ]);
    await expect(axisNote(ids.health)).resolves.toMatchObject({
      text: 'Walks helped',
      reviewId: review(1),
      period: { key: '2026-09-14' },
    });
    // Same completion time: the larger review id comes first.
    await week(4, '2026-08-31', '2026-09-06', { completed_at: '2026-09-20T18:00:00.000Z' });
    await note(6, 4, ids.health, 'Tied note');
    await expect(axisNote(ids.health)).resolves.toMatchObject({ text: 'Tied note' });
    await context.context.driver.run(
      `UPDATE review_checkpoints SET state = 'archived', state_before_archive = 'completed',
         archived_at = ? WHERE id = ?;`,
      [now, review(4)],
    );
    await expect(axisNote(ids.health)).resolves.toMatchObject({ text: 'Walks helped' });
    await context.context.driver.run(
      `UPDATE review_items SET axis_id = NULL, target_deleted_at = ? WHERE id = ?;`,
      [now, item(1)],
    );
    await expect(axisNote(ids.health)).resolves.toBeNull();

    // Another identity's notes never leak, even for the same review shapes.
    await insert('review_checkpoints', {
      id: id(10, 0x30),
      owner_id: other,
      profile_id: otherProfile,
      review_type: 'weekly',
      period_key: '2026-09-21',
      period_start_date: '2026-09-21',
      period_end_date: '2026-09-27',
      week_start: 'monday',
      state: 'completed',
      completed_at: '2026-09-29T18:00:00.000Z',
    });
    await insert('review_items', {
      id: id(10, 0x31),
      owner_id: other,
      review_id: id(10, 0x30),
      target_kind: 'axis',
      axis_id: ids.otherAxis,
      decision: 'note',
      decision_note: 'Hidden note',
      sort_key: 'a',
    });
    await expect(axisNote(ids.study)).resolves.toMatchObject({ text: 'Reading helped' });
    await expect(
      queries.getAxis(other, ids.otherAxis, { includeFinished: false, limit: 200 }),
    ).resolves.toMatchObject({ reviewNote: { text: 'Hidden note', reviewId: id(10, 0x30) } });

    const detail = await plan(context, alignmentQuerySql.axisReviewNote, [owner, ids.health]);
    expect(detail).toContain(
      'SEARCH i USING INDEX idx_review_items_axis (owner_id=? AND axis_id=?)',
    );
    expect(detail).not.toMatch(/\bSCAN\b/u);
  });

  it('lists Outcomes and Projects that are in no Axis', async () => {
    const context = await fixture();
    await seed(context);
    const unassigned = await context.context.queries.listUnassigned(owner, 200);
    expect(unassigned.outcomes).toMatchObject({ items: [{ id: ids.floatingOutcome }], total: 1 });
    expect(unassigned.projects).toMatchObject({ items: [{ id: ids.looseIdea }], total: 1 });
    expect(unassigned.outcomes.items[0]?.axis).toBeUndefined();
    await expect(context.context.queries.listUnassigned(owner, 0)).resolves.toEqual({
      outcomes: { items: [], total: 1 },
      projects: { items: [], total: 1 },
    });
  });

  it('reads an Outcome with transparent progress, Milestones, primary and supporting Projects', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    const detail = await queries.getOutcome(owner, ids.run, 200);
    expect(detail?.outcome).toEqual({
      id: ids.run,
      localRevision: 1,
      title: 'Run a 10k',
      successDefinition: 'Run a 10k done',
      state: 'active',
      axis: { id: ids.health, title: 'Health', state: 'active', archived: false },
      targetStart: '2026-10-01',
      targetEnd: '2026-12-31',
      progress: { mode: 'milestone_derived', completed: 1, total: 2, canceled: 1 },
      canceledMilestones: 1,
      placement: { id: ids.yearPlacement, period: { kind: 'year', year: '2026' } },
      orderKey: s(0),
    });
    expect(detail?.milestones.items.map((milestone) => milestone.id)).toEqual([
      ids.first5k,
      ids.second5k,
      ids.trail,
    ]);
    expect(detail?.milestones.items[1]).toEqual({
      id: ids.second5k,
      localRevision: 1,
      title: 'Second 5k',
      measurableCheckpoint: 'Second 5k checkpoint',
      state: 'active',
      outcome: { id: ids.run, title: 'Run a 10k', state: 'active', archived: false },
      targetEnd: '2026-10-31',
      placement: { id: ids.monthPlacement, period: { kind: 'month', month: '2026-10' } },
      orderKey: s(1),
    });
    expect(detail?.primaryProjects).toMatchObject({
      items: [
        {
          id: ids.training,
          nextAction: {
            status: 'present',
            action: { id: ids.bookTrack, title: 'Book track', state: 'inbox' },
          },
        },
      ],
      total: 1,
    });
    expect(detail?.supportingProjects).toEqual({ items: [], total: 0 });

    const sleep = await queries.getOutcome(owner, ids.sleep, 200);
    expect(sleep?.outcome).toMatchObject({
      state: 'paused',
      progress: { mode: 'manual', percentage: 40 },
      canceledMilestones: 0,
    });
    expect(sleep?.outcome.placement).toBeUndefined();
    expect(sleep?.supportingProjects).toEqual({
      items: [
        {
          ...node('project', ids.training, 'Training plan', 'active'),
          linkId: link('outcome_secondary_project', ids.sleep, ids.training),
          linkRevision: 1,
        },
      ],
      total: 1,
    });
    // The unlinked secondary link is history, not a current relationship.
    await expect(queries.getOutcome(owner, ids.achieved, 200)).resolves.toMatchObject({
      supportingProjects: { items: [], total: 0 },
    });
    await expect(queries.getOutcome(owner, ids.floatingOutcome, 200)).resolves.toMatchObject({
      outcome: { progress: { mode: 'none' } },
    });
    await expect(queries.getOutcome(owner, ids.otherOutcome, 200)).resolves.toBeNull();
  });

  it('reads a Project with its next action, links, ordered Actions, and captured Notes', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    const detail = await queries.getProject(owner, ids.training, { actionLimit: 2, limit: 200 });
    expect(detail?.project).toEqual({
      id: ids.training,
      localRevision: 1,
      title: 'Training plan',
      state: 'active',
      desiredResult: 'Run three times a week',
      axis: { id: ids.health, title: 'Health', state: 'active', archived: false },
      primaryOutcome: { id: ids.run, title: 'Run a 10k', state: 'active', archived: false },
      targetStart: '2026-10-01',
      targetEnd: '2026-11-30',
      orderKey: s(0),
      nextAction: {
        status: 'present',
        action: { id: ids.bookTrack, title: 'Book track', state: 'inbox' },
      },
      description: 'Build up slowly',
      notes: 'Keep it light',
    });
    expect(detail?.secondaryOutcomes).toEqual([
      {
        ...node('outcome', ids.sleep, 'Sleep well', 'paused'),
        linkId: link('outcome_secondary_project', ids.sleep, ids.training),
        linkRevision: 1,
      },
    ]);
    expect(detail?.milestones).toEqual({
      items: [
        {
          ...node('milestone', ids.second5k, 'Second 5k', 'active'),
          linkId: link('milestone_project', ids.second5k, ids.training),
          linkRevision: 1,
        },
      ],
      total: 1,
    });
    expect(detail?.actions).toEqual({
      items: [
        { ...node('action', ids.warmUp, 'Warm up', 'completed'), orderKey: s(0) },
        { ...node('action', ids.bookTrack, 'Book track', 'inbox'), orderKey: s(1) },
      ],
      total: 3,
    });
    expect(detail?.capturedNotes).toEqual({
      items: [node('note', ids.shoeNote, 'Shoe sizes', 'active')],
      total: 1,
    });

    await expect(
      queries.getProject(owner, ids.emptyActive, { actionLimit: 50, limit: 200 }),
    ).resolves.toMatchObject({ project: { nextAction: { status: 'missing' } } });
    await expect(
      queries.getProject(owner, ids.shoes, { actionLimit: 50, limit: 200 }),
    ).resolves.toMatchObject({
      project: { state: 'idea', nextAction: { status: 'not_applicable' } },
    });
    await expect(
      queries.getProject(owner, ids.shelved, { actionLimit: 50, limit: 200 }),
    ).resolves.toMatchObject({ project: { state: 'archived', stateBeforeArchive: 'idea' } });
    await expect(
      queries.getProject(owner, ids.otherProject, { actionLimit: 50, limit: 200 }),
    ).resolves.toBeNull();
  });

  it('reads a Milestone with its Outcome, Axis, and active links, flagging an archived parent', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    const detail = await queries.getMilestone(owner, ids.second5k, 200);
    expect(detail?.milestone).toMatchObject({ id: ids.second5k, outcome: { id: ids.run } });
    expect(detail?.axis).toEqual({
      id: ids.health,
      title: 'Health',
      state: 'active',
      archived: false,
    });
    expect(detail?.projects).toEqual({
      items: [
        {
          ...node('project', ids.training, 'Training plan', 'active'),
          linkId: link('milestone_project', ids.second5k, ids.training),
          linkRevision: 1,
        },
      ],
      total: 1,
    });
    expect(detail?.actions).toEqual({
      items: [
        {
          ...node('action', ids.longRun, 'Long run', 'planned'),
          linkId: link('milestone_action', ids.second5k, ids.longRun),
          linkRevision: 1,
        },
      ],
      total: 1,
    });
    await expect(queries.getMilestone(owner, ids.orphaned, 200)).resolves.toMatchObject({
      milestone: {
        outcome: { id: ids.archivedOutcome, state: 'archived', archived: true },
      },
      axis: { id: ids.health },
    });
    await expect(queries.getMilestone(owner, ids.archivedMilestone, 200)).resolves.toMatchObject({
      milestone: { state: 'archived', stateBeforeArchive: 'active' },
    });
    await expect(queries.getMilestone(owner, ids.otherMilestone, 200)).resolves.toBeNull();
  });

  it('builds neighborhoods: ancestry chain, typed parents, bounded children, and totals', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    const health = node('axis', ids.health, 'Health', 'active');
    const run = node('outcome', ids.run, 'Run a 10k', 'active');
    const training = node('project', ids.training, 'Training plan', 'active');
    const second = node('milestone', ids.second5k, 'Second 5k', 'active');

    const outcome = await queries.getNeighborhood(owner, { kind: 'outcome', id: ids.run }, 2);
    expect(outcome).toEqual({
      focus: {
        ...run,
        progress: { mode: 'milestone_derived', completed: 1, total: 2, canceled: 1 },
        targetStart: '2026-10-01',
        targetEnd: '2026-12-31',
      },
      chain: [health],
      above: [{ relationship: 'axis_outcome', direction: 'up', required: false, other: health }],
      below: [
        {
          relationship: 'outcome_milestone',
          direction: 'down',
          required: true,
          other: node('milestone', ids.first5k, 'First 5k', 'completed'),
        },
        { relationship: 'outcome_milestone', direction: 'down', required: true, other: second },
        {
          relationship: 'outcome_primary_project',
          direction: 'down',
          required: false,
          other: training,
        },
      ],
      totals: {
        outcome_milestone: 4,
        outcome_primary_project: 1,
        outcome_secondary_project: 0,
      },
    });

    const project = await queries.getNeighborhood(
      owner,
      { kind: 'project', id: ids.training },
      200,
    );
    expect(project?.chain).toEqual([health, run]);
    expect(project?.focus).toEqual({
      ...training,
      targetStart: '2026-10-01',
      targetEnd: '2026-11-30',
    });
    expect(project?.above).toEqual([
      { relationship: 'axis_project', direction: 'up', required: false, other: health },
      { relationship: 'outcome_primary_project', direction: 'up', required: false, other: run },
      {
        relationship: 'outcome_secondary_project',
        direction: 'up',
        required: false,
        linkId: link('outcome_secondary_project', ids.sleep, ids.training),
        linkRevision: 1,
        other: node('outcome', ids.sleep, 'Sleep well', 'paused'),
      },
      {
        relationship: 'milestone_project',
        direction: 'up',
        required: false,
        linkId: link('milestone_project', ids.second5k, ids.training),
        linkRevision: 1,
        other: second,
      },
    ]);
    // Children in any state; archived ones stay listed and flagged.
    expect(
      project?.below.map((edge) => [edge.relationship, edge.other.id, edge.other.archived]),
    ).toEqual([
      ['project_action', ids.archivedAction, true],
      ['project_action', ids.warmUp, false],
      ['project_action', ids.bookTrack, false],
      ['project_action', ids.longRun, false],
      ['project_note', ids.shoeNote, false],
      ['project_note', ids.oldNote, true],
    ]);
    expect(project?.totals).toEqual({ project_action: 4, project_note: 2 });

    const action = await queries.getNeighborhood(owner, { kind: 'action', id: ids.longRun }, 200);
    expect(action?.chain).toEqual([health, run, training]);
    expect(action?.above).toEqual([
      { relationship: 'project_action', direction: 'up', required: false, other: training },
      {
        relationship: 'milestone_action',
        direction: 'up',
        required: false,
        linkId: link('milestone_action', ids.second5k, ids.longRun),
        linkRevision: 1,
        other: second,
      },
    ]);
    expect(action?.below).toEqual([]);
    expect(action?.totals).toEqual({});
    await expect(
      queries.getNeighborhood(owner, { kind: 'action', id: ids.unrelated }, 200),
    ).resolves.toMatchObject({ chain: [health], above: [], below: [] });

    const milestone = await queries.getNeighborhood(
      owner,
      { kind: 'milestone', id: ids.second5k },
      200,
    );
    expect(milestone?.chain).toEqual([health, run]);
    expect(milestone?.above).toEqual([
      { relationship: 'outcome_milestone', direction: 'up', required: true, other: run },
    ]);
    expect(milestone?.below.map((edge) => [edge.relationship, edge.other.id])).toEqual([
      ['milestone_project', ids.training],
      ['milestone_action', ids.longRun],
    ]);
    expect(milestone?.totals).toEqual({ milestone_project: 1, milestone_action: 1 });

    const axis = await queries.getNeighborhood(owner, { kind: 'axis', id: ids.health }, 1);
    expect(axis?.chain).toEqual([]);
    expect(axis?.above).toEqual([]);
    expect(axis?.below.map((edge) => [edge.relationship, edge.other.id])).toEqual([
      ['axis_outcome', ids.run],
      ['axis_project', ids.training],
      ['axis_routine', ids.walk],
    ]);
    expect(axis?.totals).toEqual({ axis_outcome: 4, axis_project: 4, axis_routine: 3 });

    await expect(
      queries.getNeighborhood(owner, { kind: 'routine', id: ids.walk }, 200),
    ).resolves.toMatchObject({
      chain: [health],
      above: [{ relationship: 'axis_routine', other: health }],
    });
    await expect(
      queries.getNeighborhood(owner, { kind: 'note', id: ids.shoeNote }, 200),
    ).resolves.toMatchObject({
      focus: { title: 'Shoe sizes' },
      chain: [health, run, training],
      above: [{ relationship: 'project_note', other: training }],
    });
    await expect(
      queries.getNeighborhood(owner, { kind: 'outcome', id: ids.otherOutcome }, 200),
    ).resolves.toBeNull();
    await expect(
      queries.getNeighborhood(owner, { kind: 'project', id: ids.run }, 200),
    ).resolves.toBeNull();
  });

  it('lists non-archived link candidates with case-insensitive, literal title search', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    await context.insert('outcomes', {
      id: id(2, 0x20),
      owner_id: owner,
      title: 'Здоровье и сон',
      success_definition: 'Спать',
      state: 'active',
      progress_mode: 'none',
      sort_key: s(9),
    });
    await context.insert('outcomes', {
      id: id(2, 0x21),
      owner_id: owner,
      title: 'Plan [draft] 100%*?',
      success_definition: 'Draft',
      state: 'active',
      progress_mode: 'none',
      sort_key: s(10),
    });
    const outcomes = await queries.listCandidates(owner, 'outcome', undefined, 200);
    expect(outcomes.items.map((item) => item.id)).toEqual([
      ids.run,
      ids.floatingOutcome,
      ids.sleep,
      ids.achieved,
      id(2, 0x20),
      id(2, 0x21),
    ]);
    expect(outcomes.total).toBe(6);
    expect(outcomes.items[0]).toEqual({
      ...node('outcome', ids.run, 'Run a 10k', 'active'),
      axisId: ids.health,
    });
    expect(outcomes.items[1]?.axisId).toBeUndefined();

    const search = async (text: string) =>
      (await queries.listCandidates(owner, 'outcome', text, 200)).items.map((item) => item.id);
    await expect(search('  RUN ')).resolves.toEqual([ids.run]);
    await expect(search('ЗДОРОВЬЕ')).resolves.toEqual([id(2, 0x20)]);
    await expect(search('[draft]')).resolves.toEqual([id(2, 0x21)]);
    await expect(search('*')).resolves.toEqual([id(2, 0x21)]);
    await expect(search('%*?')).resolves.toEqual([id(2, 0x21)]);
    await expect(search('_')).resolves.toEqual([]);
    await expect(search('')).resolves.toHaveLength(6);
    await expect(queries.listCandidates(owner, 'outcome', 'L', 1)).resolves.toMatchObject({
      items: [{ id: ids.floatingOutcome }],
      total: 4,
    });

    await expect(queries.listCandidates(owner, 'milestone', undefined, 200)).resolves.toMatchObject(
      {
        items: [{ id: ids.first5k }, { id: ids.orphaned }, { id: ids.second5k }, { id: ids.trail }],
        total: 4,
      },
    );
    const actions = await queries.listCandidates(owner, 'action', undefined, 200);
    expect(actions.items.map((item) => [item.id, item.axisId])).toEqual([
      [ids.warmUp, undefined],
      [ids.bookTrack, undefined],
      [ids.longRun, ids.study],
      [ids.unrelated, ids.health],
    ]);
    await expect(queries.listCandidates(owner, 'axis', 'health', 200)).resolves.toEqual({
      items: [node('axis', ids.health, 'Health', 'active')],
      total: 1,
    });
    await expect(queries.listCandidates(owner, 'note', 'shoe', 200)).resolves.toMatchObject({
      items: [{ id: ids.shoeNote, title: 'Shoe sizes' }],
    });
    await expect(queries.listCandidates(owner, 'routine', undefined, 200)).resolves.toMatchObject({
      items: [{ id: ids.walk }, { id: ids.stretch }],
      total: 2,
    });
    await expect(queries.listCandidates(other, 'outcome', 'run', 200)).resolves.toMatchObject({
      items: [{ id: ids.otherOutcome }],
      total: 1,
    });
    expect(titleSearchPattern(' Ab[*?]% ')).toBe('*[Aa][bB][[][*][?]]%*');
    // A title-case letter matches all three of its forms.
    expect(titleSearchPattern('ǅ')).toBe('*[ǅǆǄ]*');
  });

  it('lists every non-archived row of each ordering container', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    const ids_ = async (scope: Parameters<typeof queries.listContainer>[1]) =>
      (await queries.listContainer(owner, scope)).map((row) => row.ref.id);
    await expect(queries.listContainer(owner, { container: 'axes' })).resolves.toEqual([
      {
        ref: { type: 'axis', id: ids.health, ownerId: owner },
        orderKey: s(0),
        localRevision: 1,
        state: 'active',
      },
      {
        ref: { type: 'axis', id: ids.study, ownerId: owner },
        orderKey: s(1),
        localRevision: 1,
        state: 'active',
      },
      {
        ref: { type: 'axis', id: ids.tieB, ownerId: owner },
        orderKey: s(2),
        localRevision: 1,
        state: 'active',
      },
      {
        ref: { type: 'axis', id: ids.tieA, ownerId: owner },
        orderKey: s(2),
        localRevision: 1,
        state: 'active',
      },
    ]);
    await expect(ids_({ container: 'axis_outcomes', axisId: ids.health })).resolves.toEqual([
      ids.run,
      ids.sleep,
      ids.achieved,
    ]);
    await expect(ids_({ container: 'axis_outcomes', axisId: null })).resolves.toEqual([
      ids.floatingOutcome,
    ]);
    await expect(ids_({ container: 'axis_projects', axisId: ids.health })).resolves.toEqual([
      ids.training,
      ids.shoes,
      ids.oldPlan,
    ]);
    await expect(ids_({ container: 'axis_projects', axisId: null })).resolves.toEqual([
      ids.looseIdea,
    ]);
    await expect(ids_({ container: 'outcome_milestones', outcomeId: ids.run })).resolves.toEqual([
      ids.first5k,
      ids.second5k,
      ids.trail,
    ]);
    const actions = await queries.listContainer(owner, {
      container: 'project_actions',
      projectId: ids.training,
    });
    expect(actions.map((row) => [row.ref.type, row.ref.id, row.state])).toEqual([
      ['action', ids.warmUp, 'completed'],
      ['action', ids.bookTrack, 'inbox'],
      ['action', ids.longRun, 'planned'],
    ]);
    await expect(
      queries.listContainer(other, { container: 'axis_outcomes', axisId: ids.health }),
    ).resolves.toEqual([]);
  });

  it('finds the one join record of a pair in any link state, owner-scoped', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    const active = await queries.findLink(owner, 'milestone_action', ids.second5k, ids.longRun);
    expect(active).toMatchObject({
      ref: {
        type: 'milestone_action',
        id: link('milestone_action', ids.second5k, ids.longRun),
        ownerId: owner,
      },
      localRevision: 1,
      document: { milestoneId: ids.second5k, actionId: ids.longRun },
    });
    expect(active?.document['unlinkedAt']).toBeUndefined();
    await expect(
      queries.findLink(owner, 'milestone_action', ids.second5k, ids.bookTrack),
    ).resolves.toMatchObject({ document: { unlinkedAt: now } });
    await expect(
      queries.findLink(owner, 'outcome_secondary_project', ids.achieved, ids.training),
    ).resolves.toMatchObject({
      ref: { type: 'project_secondary_outcome' },
      document: { outcomeId: ids.achieved, projectId: ids.training, unlinkedAt: now },
    });
    await expect(
      queries.findLink(owner, 'milestone_project', ids.second5k, ids.shoes),
    ).resolves.toBeNull();
    await expect(
      queries.findLink(owner, 'milestone_action', ids.otherMilestone, ids.otherAction),
    ).resolves.toBeNull();
    await expect(
      queries.findLink(other, 'milestone_action', ids.otherMilestone, ids.otherAction),
    ).resolves.not.toBeNull();
    await expect(
      queries.readRecord(owner, { type: 'axis', id: ids.otherAxis, ownerId: other }),
    ).resolves.toBeNull();
    await expect(
      queries.readRecord(owner, { type: 'axis', id: ids.health, ownerId: owner }),
    ).resolves.toMatchObject({ document: { title: 'Health', state: 'active' } });
  });

  it('counts the non-archived children an archive leaves in place', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    const impact = (type: EntityType, targetId: UUID) =>
      queries.getArchiveImpact(owner, { type, id: targetId, ownerId: owner });
    await expect(impact('axis', ids.health)).resolves.toEqual({
      outcome: 3,
      project: 3,
      routine: 2,
      action: 1,
      note: 1,
    });
    await expect(impact('outcome', ids.run)).resolves.toEqual({ milestone: 3, project: 1 });
    await expect(impact('outcome', ids.sleep)).resolves.toEqual({ project: 1 });
    await expect(impact('project', ids.training)).resolves.toEqual({ action: 3, note: 1 });
    await expect(impact('milestone', ids.second5k)).resolves.toEqual({ project: 1, action: 1 });
    await expect(impact('action', ids.longRun)).resolves.toEqual({});
    await expect(
      queries.getArchiveImpact(other, { type: 'axis', id: ids.health, ownerId: other }),
    ).resolves.toEqual({});
  });

  it('reads the full permanent-delete impact of each alignment kind', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context.context;
    const impact = (type: EntityType, targetId: UUID) =>
      queries.getDeleteImpact(owner, { type, id: targetId, ownerId: owner });

    const axis = await impact('axis', ids.health);
    expect(
      axis.optionalReferrers.map(({ record, relationship, title }) => [
        record.ref.type,
        record.ref.id,
        relationship,
        title,
      ]),
    ).toEqual([
      ['outcome', ids.run, 'axis_outcome', 'Run a 10k'],
      ['outcome', ids.sleep, 'axis_outcome', 'Sleep well'],
      ['outcome', ids.achieved, 'axis_outcome', 'Old goal'],
      ['outcome', ids.archivedOutcome, 'axis_outcome', 'Shelved goal'],
      ['project', ids.training, 'axis_project', 'Training plan'],
      ['project', ids.shoes, 'axis_project', 'Buy shoes'],
      ['project', ids.oldPlan, 'axis_project', 'Old plan'],
      ['project', ids.shelved, 'axis_project', 'Shelved plan'],
      ['routine', ids.walk, 'axis_routine', 'Morning walk'],
      ['routine', ids.stretch, 'axis_routine', 'Stretch'],
      ['routine', ids.oldRoutine, 'axis_routine', 'Old routine'],
      ['action', ids.unrelated, 'axis_action', 'Unrelated'],
      ['note', ids.axisNote, 'axis_note', 'Axis note'],
    ]);
    expect(axis.optionalReferrers[3]?.record).toMatchObject({
      localRevision: 1,
      document: { state: 'archived', axisId: ids.health },
    });
    expect(axis).toMatchObject({
      activeLinks: [],
      inactiveLinks: [],
      activePlacements: [],
      archivedPlacements: [],
      activeSelections: [],
      archivedSelections: [],
      requiredChildren: { items: [], total: 0 },
      reviewItems: [],
      reviewReferences: 0,
      routineDefaultReferences: 0,
      pendingMutation: false,
      openConflict: false,
    });

    const outcome = await impact('outcome', ids.run);
    expect(
      outcome.optionalReferrers.map(({ record, relationship }) => [record.ref.id, relationship]),
    ).toEqual([[ids.training, 'outcome_primary_project']]);
    expect(outcome.requiredChildren).toEqual({
      items: [
        { id: ids.first5k, title: 'First 5k', archived: false },
        { id: ids.second5k, title: 'Second 5k', archived: false },
        { id: ids.trail, title: 'Trail run', archived: false },
        { id: ids.archivedMilestone, title: 'Archived step', archived: true },
      ],
      total: 4,
    });
    expect(outcome.activePlacements.map((record) => record.ref.id)).toEqual([ids.yearPlacement]);
    expect(outcome.archivedPlacements.map((record) => record.ref.id)).toEqual([
      ids.archivedPlacement,
    ]);
    expect(outcome.reviewReferences).toBe(0);

    const project = await impact('project', ids.training);
    expect(
      project.optionalReferrers.map(({ record, relationship, title }) => [
        record.ref.id,
        relationship,
        title,
      ]),
    ).toEqual([
      [ids.archivedAction, 'project_action', 'Archived errand'],
      [ids.warmUp, 'project_action', 'Warm up'],
      [ids.bookTrack, 'project_action', 'Book track'],
      [ids.longRun, 'project_action', 'Long run'],
      [ids.shoeNote, 'project_note', 'Shoe sizes'],
      [ids.oldNote, 'project_note', 'Old note'],
    ]);
    expect(project.activeLinks.map((record) => [record.ref.type, record.ref.id])).toEqual([
      ['project_secondary_outcome', link('outcome_secondary_project', ids.sleep, ids.training)],
      ['milestone_project', link('milestone_project', ids.second5k, ids.training)],
    ]);
    expect(project.inactiveLinks.map((record) => record.ref.id)).toEqual([
      link('outcome_secondary_project', ids.achieved, ids.training),
    ]);
    expect(project.activeSelections.map((record) => record.ref.id)).toEqual([ids.weekSelection]);
    expect(project).toMatchObject({ reviewReferences: 1, routineDefaultReferences: 1 });
    expect(project.reviewItems).toEqual([
      {
        ref: { type: 'review_item', id: ids.reviewItem, ownerId: owner },
        localRevision: 1,
        serverRevision: 0,
        baseSnapshotHash: null,
        document: {
          reviewId: ids.review,
          target: { kind: 'project', projectId: ids.training },
          decision: 'continue',
          orderKey: 'a',
        },
      },
    ]);

    const milestone = await impact('milestone', ids.second5k);
    expect(milestone.activeLinks.map((record) => record.ref.id)).toEqual([
      link('milestone_project', ids.second5k, ids.training),
      link('milestone_action', ids.second5k, ids.longRun),
    ]);
    expect(milestone.inactiveLinks.map((record) => record.ref.id)).toEqual([
      link('milestone_action', ids.second5k, ids.bookTrack),
    ]);
    expect(milestone.activePlacements.map((record) => record.ref.id)).toEqual([ids.monthPlacement]);
    expect(milestone.archivedSelections.map((record) => record.ref.id)).toEqual([
      ids.archivedSelection,
    ]);
    expect(milestone.optionalReferrers).toEqual([]);

    const action = await impact('action', ids.bookTrack);
    expect(action.inactiveLinks.map((record) => record.ref.id)).toEqual([
      link('milestone_action', ids.second5k, ids.bookTrack),
    ]);

    await context.insert('sync_outbox', {
      id: id(11, 1),
      owner_id: owner,
      operation_id: id(11, 1),
      mutation_group_id: id(11, 2),
      command_id: id(11, 3),
      actor: 'user',
      sequence: 0,
      entity_type: 'outcome',
      entity_id: ids.sleep,
      operation_kind: 'update',
      expected_revision: 1,
      document_schema_version: 1,
      document_payload_json: '{}',
      base_server_revision: 0,
      state: 'pending',
    });
    await context.insert('sync_conflicts', {
      id: id(11, 4),
      owner_id: owner,
      entity_type: 'outcome',
      entity_id: ids.sleep,
      conflict_kind: 'update_update',
      state: 'open',
      candidate_schema_version: 1,
      candidate_payload_json: '{}',
      base_server_revision: 0,
      remote_server_revision: 1,
    });
    await expect(impact('outcome', ids.sleep)).resolves.toMatchObject({
      pendingMutation: true,
      openConflict: true,
    });
    await expect(
      queries.getDeleteImpact(other, { type: 'axis', id: ids.health, ownerId: other }),
    ).resolves.toMatchObject({ optionalReferrers: [], requiredChildren: { total: 0 } });
  });

  it('reads every review item naming a delete target, in any state, in id order and bounded pages', async () => {
    const context = await fixture();
    await seed(context);
    const { insert } = context;
    const draft = id(10, 0x40);
    const archivedReview = id(10, 0x41);
    const weekly = {
      owner_id: owner,
      profile_id: profile,
      review_type: 'weekly',
      period_key: '2026-09-21',
      period_start_date: '2026-09-21',
      period_end_date: '2026-09-27',
      week_start: 'monday',
    };
    await insert('review_checkpoints', { ...weekly, id: draft, state: 'draft' });
    await insert('review_checkpoints', {
      ...weekly,
      id: archivedReview,
      state: 'archived',
      state_before_archive: 'completed',
      completed_at: now,
      archived_at: now,
    });
    const item = (
      index: number,
      reviewId: UUID,
      target: Record<string, SqliteParameter>,
      extra: Record<string, SqliteParameter> = {},
    ) =>
      insert('review_items', {
        id: id(10, 0x50 + index),
        owner_id: owner,
        review_id: reviewId,
        decision: 'continue',
        sort_key: `i${String(index)}`,
        ...target,
        ...extra,
      });
    const study = { target_kind: 'axis', axis_id: ids.study };
    const note = (text: string) => ({ decision: 'note', decision_note: text });
    // Inserted out of id order; every state is read, in id order.
    await item(3, archivedReview, study, note('Reading helped'));
    await item(1, draft, study, note('Notes helped'));
    await item(2, draft, study, { ...note('Removed choice'), archived_at: now });
    // A soft-deleted row still holds the foreign key: counted, never returned as a record.
    await item(4, draft, study, { ...note('Already removed'), deleted_at: now });
    await item(5, draft, { target_kind: 'outcome', outcome_id: ids.sleep });
    await item(6, draft, { target_kind: 'milestone', milestone_id: ids.second5k });
    await item(7, draft, { target_kind: 'action', action_id: ids.longRun }, { decision: 'focus' });
    // More than two pages for one Project, inserted in reverse id order.
    await context.context.driver.run(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 401
       )
       INSERT INTO review_items (id, owner_id, review_id, target_kind, project_id, decision,
         sort_key, created_at, updated_at)
       SELECT printf('7b000000-0000-4000-8000-%012x', 1000 - value), ?, ?, 'project', ?,
         'continue', printf('%04d', value), ?, ?
       FROM sequence;`,
      [owner, draft, ids.shoes, now, now],
    );
    // Another identity's review history never leaks.
    await insert('review_checkpoints', {
      ...weekly,
      id: id(10, 0x42),
      owner_id: other,
      profile_id: otherProfile,
      state: 'draft',
    });
    await insert('review_items', {
      id: id(10, 0x60),
      owner_id: other,
      review_id: id(10, 0x42),
      target_kind: 'axis',
      axis_id: ids.otherAxis,
      ...note('Hidden note'),
      sort_key: 'a',
    });
    const { queries } = context.context;
    const impact = (type: EntityType, targetId: UUID, ownerId: OwnerId = owner) =>
      queries.getDeleteImpact(ownerId, { type, id: targetId, ownerId });

    const axis = await impact('axis', ids.study);
    expect(axis.reviewItems.map((record) => record.ref.id)).toEqual([
      id(10, 0x51),
      id(10, 0x52),
      id(10, 0x53),
    ]);
    expect(axis.reviewReferences).toBe(4);
    expect(axis.reviewItems.map((record) => record.document)).toEqual([
      {
        reviewId: draft,
        target: { kind: 'axis', axisId: ids.study },
        decision: 'note',
        note: 'Notes helped',
        orderKey: 'i1',
      },
      {
        reviewId: draft,
        target: { kind: 'axis', axisId: ids.study },
        decision: 'note',
        note: 'Removed choice',
        orderKey: 'i2',
        archivedAt: now,
      },
      {
        reviewId: archivedReview,
        target: { kind: 'axis', axisId: ids.study },
        decision: 'note',
        note: 'Reading helped',
        orderKey: 'i3',
      },
    ]);
    for (const [type, targetId, itemId] of [
      ['outcome', ids.sleep, id(10, 0x55)],
      ['milestone', ids.second5k, id(10, 0x56)],
      ['action', ids.longRun, id(10, 0x57)],
    ] as const) {
      const found = await impact(type, targetId);
      expect(
        found.reviewItems.map((record) => record.ref.id),
        type,
      ).toEqual([itemId]);
      expect(found.reviewReferences, type).toBe(1);
    }
    const shoes = await impact('project', ids.shoes);
    const pageIds = shoes.reviewItems.map((record) => record.ref.id);
    expect(pageIds).toHaveLength(401);
    expect(pageIds).toEqual([...pageIds].sort());
    expect(new Set(pageIds).size).toBe(401);
    expect(shoes.reviewReferences).toBe(401);
    await expect(impact('axis', ids.tieA)).resolves.toMatchObject({
      reviewItems: [],
      reviewReferences: 0,
    });
    await expect(impact('axis', ids.otherAxis, other)).resolves.toMatchObject({
      reviewItems: [{ ref: { id: id(10, 0x60), ownerId: other } }],
      reviewReferences: 1,
    });
    await expect(impact('axis', ids.study, other)).resolves.toMatchObject({
      reviewItems: [],
      reviewReferences: 0,
    });

    // Each page is one bounded, owner-scoped search through the target's named index.
    for (const [kind, column] of [
      ['axis', 'axis_id'],
      ['outcome', 'outcome_id'],
      ['project', 'project_id'],
      ['milestone', 'milestone_id'],
      ['action', 'action_id'],
    ] as const) {
      const statement = alignmentQuerySql.deleteImpact.reviewItems[kind];
      expect(statement, kind).toMatch(/ORDER BY id LIMIT \?;$/u);
      const detail = await plan(context, statement, [owner, ids.study, '', 200]);
      expect(detail, kind).toContain(
        `SEARCH review_items USING INDEX idx_review_items_${kind} (owner_id=? AND ${column}=?`,
      );
      expect(detail, kind).not.toMatch(/\bSCAN\b/u);
    }
  });

  it('keeps the review decisions of a permanently deleted Axis, Outcome, Project, or Milestone', async () => {
    const context = await fixture();
    await seed(context);
    const { insert } = context;
    const { driver } = context.context;
    const targets = {
      axis: id(1, 0x20),
      outcome: id(2, 0x20),
      project: id(4, 0x20),
      milestone: id(3, 0x20),
    } as const;
    await insert('axes', {
      id: targets.axis,
      owner_id: owner,
      title: 'Private axis',
      state: 'active',
      sort_key: s(9),
    });
    await insert('outcomes', {
      id: targets.outcome,
      owner_id: owner,
      title: 'Private outcome',
      success_definition: 'Private definition',
      state: 'active',
      progress_mode: 'none',
      sort_key: s(9),
    });
    await insert('projects', {
      id: targets.project,
      owner_id: owner,
      title: 'Private project',
      state: 'idea',
      sort_key: s(9),
    });
    await insert('milestones', {
      id: targets.milestone,
      owner_id: owner,
      outcome_id: ids.sleep,
      title: 'Private milestone',
      measurable_checkpoint: 'Private checkpoint',
      state: 'active',
      sort_key: s(9),
    });
    const weekly = {
      owner_id: owner,
      profile_id: profile,
      review_type: 'weekly',
      period_key: '2026-09-21',
      period_start_date: '2026-09-21',
      period_end_date: '2026-09-27',
      week_start: 'monday',
    };
    const draft = id(10, 0x70);
    const archivedReview = id(10, 0x71);
    await insert('review_checkpoints', { ...weekly, id: draft, state: 'draft' });
    await insert('review_checkpoints', {
      ...weekly,
      id: archivedReview,
      state: 'archived',
      state_before_archive: 'completed',
      completed_at: now,
      archived_at: now,
    });
    let index = 0;
    const kept: { readonly itemId: UUID; readonly kind: keyof typeof targets }[] = [];
    for (const kind of ['axis', 'outcome', 'project', 'milestone'] as const) {
      const decision = kind === 'axis' ? { decision: 'note', decision_note: `${kind} helped` } : {};
      for (const extra of [
        { review_id: draft },
        { review_id: draft, archived_at: now },
        { review_id: archivedReview },
      ]) {
        index += 1;
        const itemId = id(10, 0x80 + index);
        await insert('review_items', {
          id: itemId,
          owner_id: owner,
          target_kind: kind,
          [`${kind}_id`]: targets[kind],
          decision: 'continue',
          sort_key: `k${String(index)}`,
          ...decision,
          ...extra,
        });
        kept.push({ itemId, kind });
      }
    }
    let counter = 1;
    const dependencies: ApplicationDependencies = {
      ...createSqliteApplicationAdapters(driver, { ownerId: owner }),
      ids: { next: () => id(0xa0, counter++) },
      clock: { now: () => now },
      projections: { notifyCommitted() {} },
    };
    const alignment = createAlignmentApplication(dependencies, new SqliteAlignmentQueries(driver));

    for (const kind of ['milestone', 'project', 'outcome', 'axis'] as const) {
      const preview = await alignment.previewDelete({ kind, id: targets[kind] }, 'restrict');
      // History lists only the draft's choice; the removed choice and the archived review's are
      // kept unlisted.
      expect(preview, kind).toMatchObject({
        allowed: true,
        blockers: [],
        historyReferences: { reviews: 1, routineDefaults: 0 },
      });
      const deleted = await alignment.deletePermanently({
        target: { kind, id: targets[kind], revision: 1 },
        policy: 'restrict',
        confirmation: `Private ${kind}`,
      });
      expect(deleted, kind).toMatchObject({ ok: true, value: { undo: { available: false } } });
    }

    await expect(alignment.getAxis(targets.axis)).resolves.toBeNull();
    await expect(
      context.context.queries.getAxis(owner, targets.axis, { includeFinished: true, limit: 10 }),
    ).resolves.toBeNull();
    await expect(alignment.getOutcome(targets.outcome)).resolves.toBeNull();
    await expect(alignment.getProject(targets.project)).resolves.toBeNull();
    await expect(alignment.getMilestone(targets.milestone)).resolves.toBeNull();
    await expect(driver.all('PRAGMA foreign_key_check;')).resolves.toEqual([]);

    // Active items, also in an archived review, read as "Deleted object".
    const reviews = new SqliteReviewQueries(driver);
    for (const reviewId of [draft, archivedReview]) {
      const rows = await reviews.listReviewItems(owner, reviewId);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.target).toEqual({ kind: 'deleted' });
        expect(row.record.localRevision).toBe(2);
      }
    }
    // Every row, removed choices included, keeps its decision with only the reference cleared.
    for (const { itemId, kind } of kept) {
      const record = await context.context.queries.readRecord(owner, {
        type: 'review_item',
        id: itemId,
        ownerId: owner,
      });
      expect(record?.document['target'], itemId).toEqual({
        kind: 'deleted',
        deletedKind: kind,
        deletedAt: now,
      });
      expect(record?.document['decision']).toBe(kind === 'axis' ? 'note' : 'continue');
      await expect(
        driver.get(
          `SELECT target_kind, axis_id, outcome_id, milestone_id, project_id, action_id,
             routine_id, commitment_id, target_deleted_at
           FROM review_items WHERE owner_id = ? AND id = ?;`,
          [owner, itemId],
        ),
      ).resolves.toEqual({
        target_kind: kind,
        axis_id: null,
        outcome_id: null,
        milestone_id: null,
        project_id: null,
        action_id: null,
        routine_id: null,
        commitment_id: null,
        target_deleted_at: now,
      });
    }
    // Minimized events only: the clearing names no title, body, or deleted id.
    const events = await driver.all<{ event_type: string; payload_json: string }>(
      `SELECT event_type, payload_json FROM domain_events
       WHERE owner_id = ? AND entity_type = 'review_item' AND event_type <> 'alignment.test_seeded';`,
      [owner],
    );
    expect(events).toHaveLength(kept.length);
    for (const event of events) {
      expect(event).toEqual({
        event_type: 'review_item.target_cleared',
        payload_json: '{"operation":"update"}',
      });
    }
    const everything = JSON.stringify(
      await driver.all('SELECT payload_json FROM domain_events WHERE owner_id = ?;', [owner]),
    );
    expect(everything).not.toMatch(/Private|helped/u);
  });

  it('lists history newest first with event type and time only, owner-scoped and bounded', async () => {
    const context = await fixture();
    await seed(context);
    const event = (
      eventId: UUID,
      ownerId: OwnerId,
      eventType: string,
      occurredAt: string,
      deleted = false,
    ) =>
      context.insert('domain_events', {
        id: eventId,
        owner_id: ownerId,
        command_id: eventId,
        sequence: 0,
        actor: 'user',
        event_type: eventType,
        entity_type: 'outcome',
        entity_id: ids.run,
        payload_schema_version: 1,
        payload_json: '{"operation":"update","relationship":"axis_outcome"}',
        occurred_at: occurredAt,
        deleted_at: deleted ? now : null,
      });
    await event(id(12, 1), owner, 'outcome.created', '2026-09-01T08:00:00.000Z');
    await event(id(12, 2), owner, 'outcome.edited', '2026-09-02T08:00:00.000Z');
    await event(id(12, 4), owner, 'outcome.transitioned', '2026-09-03T08:00:00.000Z');
    await event(id(12, 3), owner, 'outcome.progress_set', '2026-09-03T08:00:00.000Z');
    await event(id(12, 5), owner, 'outcome.hidden', '2026-09-04T08:00:00.000Z', true);
    await event(id(12, 6), other, 'outcome.foreign', '2026-09-05T08:00:00.000Z');
    const { queries } = context.context;
    const ref = { type: 'outcome' as const, id: ids.run, ownerId: owner };
    await expect(queries.listHistory(owner, ref, 3)).resolves.toEqual([
      { eventType: 'outcome.transitioned', occurredAt: '2026-09-03T08:00:00.000Z' },
      { eventType: 'outcome.progress_set', occurredAt: '2026-09-03T08:00:00.000Z' },
      { eventType: 'outcome.edited', occurredAt: '2026-09-02T08:00:00.000Z' },
    ]);
    await expect(queries.listHistory(owner, ref, 500)).resolves.toHaveLength(4);
    await expect(queries.getOutcome(owner, ids.run, 1)).resolves.toMatchObject({
      history: [{ eventType: 'outcome.transitioned' }],
    });
  });

  it('uses the named indexes for every list, link, impact, and history statement', async () => {
    const context = await fixture();
    await seed(context);
    const sql = alignmentQuerySql;
    const cases: [string, readonly SqliteParameter[], readonly string[]][] = [
      [
        sql.listAxes.items,
        [owner, 0, 10],
        ['idx_axes_order', 'idx_outcomes_axis', 'idx_projects_axis', 'idx_routines_axis'],
      ],
      [
        sql.axisOutcomes.items,
        [owner, ids.health, 10],
        ['idx_outcomes_axis', 'idx_milestones_outcome'],
      ],
      [sql.unassignedOutcomes.items, [owner, 10], ['idx_outcomes_axis']],
      [
        sql.axisProjects.items,
        [owner, ids.health, 10],
        ['idx_projects_axis', 'idx_actions_project'],
      ],
      [sql.unassignedProjects.items, [owner, 10], ['idx_projects_axis']],
      [sql.primaryProjects.items, [owner, ids.run, 10], ['idx_projects_primary_outcome']],
      [sql.outcomeMilestones.items, [owner, ids.run, 10], ['idx_milestones_outcome']],
      [sql.axisRoutines.items, [owner, ids.health, 10], ['idx_routines_axis']],
      [sql.projectActions.items, [owner, ids.training, 10], ['idx_actions_project']],
      [sql.projectNotes.items, [owner, ids.training, 10], ['idx_notes_project']],
      [
        sql.linked.outcome_secondary_project.down.items,
        [owner, ids.run, 10],
        ['idx_project_secondary_outcomes_outcome'],
      ],
      [
        sql.linked.outcome_secondary_project.up.items,
        [owner, ids.training, 10],
        ['idx_project_secondary_outcomes_project'],
      ],
      [
        sql.linked.milestone_project.down.items,
        [owner, ids.second5k, 10],
        ['idx_milestone_projects_milestone'],
      ],
      [
        sql.linked.milestone_project.up.items,
        [owner, ids.training, 10],
        ['idx_milestone_projects_project'],
      ],
      [
        sql.linked.milestone_action.down.items,
        [owner, ids.second5k, 10],
        ['idx_milestone_actions_milestone'],
      ],
      [
        sql.linked.milestone_action.up.items,
        [owner, ids.longRun, 10],
        ['idx_milestone_actions_action'],
      ],
      [sql.children.axis_outcome.items, [owner, ids.health, 10], ['idx_outcomes_axis']],
      [sql.children.outcome_milestone.items, [owner, ids.run, 10], ['idx_milestones_outcome']],
      [sql.children.project_note.items, [owner, ids.training, 10], ['idx_notes_project']],
      [sql.candidates.axis.items, [owner, '*', 10], ['idx_axes_order']],
      [sql.candidates.outcome.items, [owner, '*', 10], ['idx_outcomes_order']],
      [sql.candidates.project.items, [owner, '*', 10], ['idx_projects_order']],
      [sql.container.axes, [owner, 10], ['idx_axes_order']],
      [sql.container.projectActions, [owner, ids.training, 10], ['idx_actions_project']],
      [sql.archiveImpact.axis[4]!.sql, [owner, ids.health], ['idx_notes_axis']],
      [sql.deleteImpact.referrers.axis[3]!.sql, [owner, ids.health], ['idx_actions_axis']],
      [sql.deleteImpact.placements.outcome, [owner, ids.run], ['idx_placements_outcome_all']],
      [sql.deleteImpact.placements.project, [owner, ids.training], ['idx_placements_project_all']],
      [
        sql.deleteImpact.placements.milestone,
        [owner, ids.second5k],
        ['idx_placements_milestone_all'],
      ],
      [
        sql.deleteImpact.selections.project[0]!,
        [owner, ids.training],
        ['idx_week_selections_project'],
      ],
      [
        sql.deleteImpact.selections.milestone[0]!,
        [owner, ids.second5k],
        ['idx_week_selections_milestone'],
      ],
      [sql.deleteImpact.reviewItems.axis, [owner, ids.health, '', 10], ['idx_review_items_axis']],
      [
        sql.deleteImpact.reviewItems.outcome,
        [owner, ids.run, '', 10],
        ['idx_review_items_outcome'],
      ],
      [
        sql.deleteImpact.reviewItems.project,
        [owner, ids.training, '', 10],
        ['idx_review_items_project'],
      ],
      [
        sql.deleteImpact.reviewItems.milestone,
        [owner, ids.second5k, '', 10],
        ['idx_review_items_milestone'],
      ],
      [
        sql.deleteImpact.reviewItems.action,
        [owner, ids.longRun, '', 10],
        ['idx_review_items_action'],
      ],
      [sql.axisReviewNote, [owner, ids.health], ['idx_review_items_axis']],
      [sql.deleteImpact.routineDefaults, [owner, ids.training], ['idx_routine_defaults_project']],
      [sql.history, [owner, 'outcome', ids.run, 10], ['idx_domain_events_entity']],
    ];
    for (const [statement, parameters, indexes] of cases) {
      const detail = await plan(context, statement, parameters);
      for (const index of indexes) expect(detail, statement).toContain(index);
    }
    // Every statement prepares and runs against the current schema.
    for (const statement of Object.values(sql.node)) {
      await expect(
        context.context.driver.all(statement, [owner, ids.health]),
      ).resolves.toBeDefined();
    }
    for (const [key, statement] of Object.entries(sql.findLink)) {
      expect(statement, key).toContain('LIMIT 1');
      await expect(plan(context, statement, [owner, ids.run, ids.training])).resolves.toMatch(
        /SEARCH .* USING (?:COVERING )?INDEX/u,
      );
    }
  });

  it('keeps persisted order and read models across a restart', async () => {
    const context = await fixture();
    await seed(context);
    // A reorder only rewrites order keys (spaced keys, as alignment normalization writes them).
    await context.context.driver.run('UPDATE axes SET sort_key = ? WHERE id = ?;', [
      s(5),
      ids.health,
    ]);
    await context.context.driver.run('UPDATE milestones SET sort_key = ? WHERE id = ?;', [
      s(9),
      ids.first5k,
    ]);
    const before = await context.context.queries.getOutcome(owner, ids.run, 200);
    await context.restart();
    const { queries } = context.context;
    await expect(
      queries.listAxes(owner, { includeArchived: false, limit: 200 }),
    ).resolves.toMatchObject({
      items: [{ id: ids.study }, { id: ids.tieB }, { id: ids.tieA }, { id: ids.health }],
    });
    const after = await queries.getOutcome(owner, ids.run, 200);
    expect(after).toEqual(before);
    expect(after?.milestones.items.map((milestone) => milestone.id)).toEqual([
      ids.second5k,
      ids.trail,
      ids.first5k,
    ]);
    await context.context.driver.close();
  });

  it('keeps a 2,000-Action Project neighborhood and detail bounded and fast', async () => {
    const context = await fixture();
    await seed(context);
    await context.context.driver.run(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 2000
       )
       INSERT INTO actions (id, owner_id, project_id, title, state, completed_at, capture_origin,
         sort_key, created_at, updated_at)
       SELECT printf('7a000000-0000-4000-8000-%012x', value), ?, ?, 'Bulk ' || value,
         CASE WHEN value % 3 = 0 THEN 'completed' ELSE 'planned' END,
         CASE WHEN value % 3 = 0 THEN ? END, 'plan', printf('%015d', 100000000 + value), ?, ?
       FROM sequence;`,
      [owner, ids.emptyActive, now, now, now],
    );
    const { queries } = context.context;
    const budgetMs = 750;

    let started = performance.now();
    const neighborhood = await queries.getNeighborhood(
      owner,
      { kind: 'project', id: ids.emptyActive },
      50,
    );
    expect(performance.now() - started).toBeLessThan(budgetMs);
    expect(neighborhood?.below).toHaveLength(50);
    expect(neighborhood?.totals).toEqual({ project_action: 2000, project_note: 0 });

    started = performance.now();
    const detail = await queries.getProject(owner, ids.emptyActive, { actionLimit: 50, limit: 50 });
    expect(performance.now() - started).toBeLessThan(budgetMs);
    expect(detail?.actions.items).toHaveLength(50);
    expect(detail?.actions.total).toBe(2000);
    expect(detail?.project.nextAction).toEqual({
      status: 'present',
      action: { id: '7a000000-0000-4000-8000-000000000001', title: 'Bulk 1', state: 'planned' },
    });

    started = performance.now();
    const axis = await queries.getAxis(owner, ids.study, { includeFinished: true, limit: 200 });
    expect(performance.now() - started).toBeLessThan(budgetMs);
    expect(axis?.projects.items[0]?.nextAction.status).toBe('present');
    const container = await queries.listContainer(owner, {
      container: 'project_actions',
      projectId: ids.emptyActive,
    });
    expect(container).toHaveLength(2000);
  });
});
