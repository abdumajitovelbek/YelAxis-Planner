import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createEntityRef,
  type CalendarDate,
  type EntityType,
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
import { SqlitePlanningQueries } from './planning-queries';
import { reviewItemRowLimit, reviewQuerySql, SqliteReviewQueries } from './review-queries';
import { SqliteTodayQueries } from './today-queries';

/*
 * review read model against real SQLite: every ReviewQueryPort statement with ordering,
 * bounds, totals, keyset cursors, type and state filters, archived and deleted exclusion, owner
 * isolation, joined titles, the "Deleted object" view, index use (EXPLAIN QUERY PLAN), and a
 * multi-year history. Synthetic fixtures only.
 */
const now = '2026-09-30T09:00:00.000Z' as Instant;
const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
const other = '10000000-0000-4000-8000-000000000002' as OwnerId;
const profile = '11000000-0000-4000-8000-000000000001' as UUID;
const otherProfile = '11000000-0000-4000-8000-000000000002' as UUID;
/** The lowest id: the application reads one exact period strictly before (next day, this id). */
const lowestId = '00000000-0000-1000-8000-000000000000' as UUID;
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
  health: id(1, 1),
  study: id(1, 2),
  tieB: id(1, 3),
  tieA: id(1, 4),
  oldAxis: id(1, 5),
  run: id(2, 1),
  sleep: id(2, 2),
  achieved: id(2, 3),
  archivedOutcome: id(2, 4),
  floating: id(2, 5),
  first5k: id(3, 1),
  second5k: id(3, 2),
  doneMilestone: id(3, 3),
  archivedMilestone: id(3, 4),
  training: id(4, 1),
  shoes: id(4, 2),
  reading: id(4, 3),
  legacy: id(4, 4),
  loose: id(4, 5),
  idea: id(4, 6),
  pausedProject: id(4, 7),
  completedProject: id(4, 8),
  archivedProject: id(4, 9),
  warmUp: id(5, 1),
  bookTrack: id(5, 2),
  stretch: id(5, 3),
  laces: id(5, 4),
  callBack: id(5, 5),
  writePlan: id(5, 6),
  archivedCapture: id(5, 7),
  gone: id(5, 8),
  walk: id(6, 1),
  dentist: id(7, 1),
  review: (index: number) => id(8, index),
  item: (index: number) => id(9, index),
  otherAxis: id(0x11, 1),
  otherAction: id(0x15, 1),
  otherReview: id(0x18, 1),
  otherItem: id(0x19, 1),
};

type Row = Record<string, SqliteParameter>;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-review-queries-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(driver, schemaMigrations, () => now);
  const insert = async (table: string, row: Row) => {
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
  const adapters = createSqliteApplicationAdapters(driver, { ownerId: owner });
  /** Write one record through its codec (for shapes such as Routine generations). */
  const createRecord = (type: EntityType, entityId: UUID, document: object) =>
    adapters.unitOfWork.runInTransaction((work) =>
      work.records.apply(
        {
          operation: 'create',
          ref: { type, id: entityId, ownerId: owner },
          expectedRevision: null,
          baseServerRevision: 0,
          baseSnapshotHash: null,
          document: document as Readonly<Record<string, unknown>>,
        },
        { ownerId: owner, actor: 'user', commandId: id(0x90, 1), now },
      ),
    );
  return { driver, insert, createRecord, queries: new SqliteReviewQueries(driver) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const daily = (date: string, extra: Row = {}): Row => ({
  review_type: 'daily',
  period_key: date,
  period_start_date: date,
  period_end_date: date,
  ...extra,
});

const weekly = (start: string, end: string, extra: Row = {}): Row => ({
  review_type: 'weekly',
  period_key: start,
  period_start_date: start,
  period_end_date: end,
  week_start: 'monday',
  ...extra,
});

const completedAt = {
  daily27: '2026-09-27T20:00:00.000Z',
  week21: '2026-09-27T18:00:00.000Z',
  week07: '2026-09-13T18:00:00.000Z',
  year2025: '2026-01-02T10:00:00.000Z',
};

/** Notes long enough to be cut to a 200-character excerpt. */
const longNotes = `${'A'.repeat(200)}${'B'.repeat(50)}`;

/** One realistic plan and review history, plus a second identity that must never leak. */
async function seed({ insert, createRecord }: Fixture) {
  const axis = (axisId: UUID, title: string, sortKey: string, extra: Row = {}) =>
    insert('axes', {
      id: axisId,
      owner_id: owner,
      title,
      state: 'active',
      sort_key: sortKey,
      ...extra,
    });
  await axis(ids.health, 'Health', 'a', { color_token: 'teal', icon_name: 'leaf' });
  await axis(ids.study, 'Study', 'b');
  await axis(ids.tieA, 'Tie A', 'c');
  await axis(ids.tieB, 'Tie B', 'c');
  await axis(ids.oldAxis, 'Old', '0', {
    state: 'archived',
    state_before_archive: 'active',
    archived_at: now,
  });

  const outcome = (outcomeId: UUID, title: string, sortKey: string, extra: Row = {}) =>
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
  await outcome(ids.run, 'Run a 10k', 'b', {
    target_start_date: '2026-10-01',
    target_end_date: '2026-12-31',
  });
  await outcome(ids.sleep, 'Sleep well', 'a', { state: 'paused' });
  await outcome(ids.achieved, 'Old goal', 'd', { state: 'achieved' });
  await outcome(ids.archivedOutcome, 'Shelved goal', 'e', {
    state: 'archived',
    state_before_archive: 'active',
    archived_at: now,
  });
  await outcome(ids.floating, 'Floating goal', 'c', { axis_id: null });

  const milestone = (
    milestoneId: UUID,
    title: string,
    outcomeId: UUID,
    sortKey: string,
    extra: Row = {},
  ) =>
    insert('milestones', {
      id: milestoneId,
      owner_id: owner,
      outcome_id: outcomeId,
      title,
      measurable_checkpoint: `${title} measured`,
      state: 'active',
      sort_key: sortKey,
      ...extra,
    });
  await milestone(ids.first5k, 'First 5k', ids.run, 'b', { target_end_date: '2026-10-31' });
  await milestone(ids.second5k, 'Second 5k', ids.sleep, 'a');
  await milestone(ids.doneMilestone, 'Done step', ids.run, 'c', { state: 'completed' });
  await milestone(ids.archivedMilestone, 'Archived step', ids.run, 'd', {
    state: 'archived',
    state_before_archive: 'active',
    archived_at: now,
  });

  const project = (projectId: UUID, title: string, sortKey: string, extra: Row = {}) =>
    insert('projects', {
      id: projectId,
      owner_id: owner,
      axis_id: ids.health,
      title,
      state: 'active',
      desired_result: `${title} result`,
      sort_key: sortKey,
      ...extra,
    });
  await project(ids.training, 'Training plan', 'b', {
    target_start_date: '2026-10-01',
    target_end_date: '2026-11-30',
  });
  await project(ids.shoes, 'Buy shoes', 'a', { state: 'blocked' });
  await project(ids.reading, 'Read a book', 'c', { axis_id: ids.study });
  await project(ids.legacy, 'Legacy plan', 'd', { axis_id: ids.oldAxis });
  await project(ids.loose, 'Loose plan', 'e', { axis_id: null });
  await project(ids.idea, 'Idea', 'f', { state: 'idea', desired_result: null });
  await project(ids.pausedProject, 'Paused plan', 'g', { state: 'paused' });
  await project(ids.completedProject, 'Done plan', 'h', { state: 'completed' });
  await project(ids.archivedProject, 'Shelved plan', 'i', {
    state: 'archived',
    state_before_archive: 'active',
    archived_at: now,
  });

  const action = (actionId: UUID, title: string, sortKey: string, extra: Row = {}) =>
    insert('actions', {
      id: actionId,
      owner_id: owner,
      title,
      state: 'planned',
      capture_origin: 'plan',
      sort_key: sortKey,
      ...extra,
    });
  await action(ids.warmUp, 'Warm up', 'a', {
    project_id: ids.training,
    state: 'completed',
    completed_at: now,
  });
  await action(ids.bookTrack, 'Book track', 'b', { project_id: ids.training, state: 'inbox' });
  await action(ids.stretch, 'Stretch', 'c', { project_id: ids.training });
  await action(ids.laces, 'Buy laces', 'a', { project_id: ids.shoes });
  await action(ids.callBack, 'Call back', 'x1', { state: 'inbox' });
  await action(ids.writePlan, 'Write the plan', 'x2', { state: 'inbox' });
  await action(ids.archivedCapture, 'Old capture', 'x3', {
    state: 'archived',
    state_before_archive: 'inbox',
    archived_at: now,
  });
  await action(ids.gone, 'Gone action', 'x4', { deleted_at: now });
  await createRecord('routine', ids.walk, {
    title: 'Morning walk',
    orderKey: 'a',
    state: 'active',
    generations: [
      {
        generation: 1,
        rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-01-01' },
        schedulingMode: { kind: 'day_flexible' },
      },
    ],
  });
  await insert('commitments', {
    id: ids.dentist,
    owner_id: owner,
    title: 'Dentist',
    strength: 'hard',
    state: 'planned',
  });

  const review = (index: number, row: Row) =>
    insert('review_checkpoints', {
      id: ids.review(index),
      owner_id: owner,
      profile_id: profile,
      state: 'draft',
      ...row,
    });
  await review(1, daily('2026-09-28', { notes: longNotes, energy: 'high' }));
  await review(
    2,
    daily('2026-09-27', { state: 'completed', completed_at: completedAt.daily27, energy: 'low' }),
  );
  await review(3, daily('2026-09-26', { state: 'skipped', notes: 'Short note' }));
  await review(
    4,
    weekly('2026-09-21', '2026-09-27', { state: 'completed', completed_at: completedAt.week21 }),
  );
  await review(5, weekly('2026-09-14', '2026-09-20'));
  await review(
    6,
    weekly('2026-09-07', '2026-09-13', { state: 'completed', completed_at: completedAt.week07 }),
  );
  await review(7, {
    review_type: 'monthly',
    period_key: '2026-09',
    period_start_date: '2026-09-01',
    period_end_date: '2026-09-30',
    theme_text: 'Fewer, better things',
  });
  // Same period start as the monthly review: the id breaks the tie.
  await review(8, daily('2026-09-01', { state: 'skipped' }));
  await review(9, {
    review_type: 'yearly',
    period_key: '2025',
    period_start_date: '2025-01-01',
    period_end_date: '2025-12-31',
    state: 'completed',
    completed_at: completedAt.year2025,
    direction_choice: 'new',
    direction_text: 'Build calmly',
  });
  await review(
    10,
    daily('2026-09-25', { state: 'archived', state_before_archive: 'draft', archived_at: now }),
  );
  // A week kept from before a first-weekday change: it starts on its own Sunday.
  await review(11, weekly('2026-08-30', '2026-09-05', { state: 'skipped', week_start: 'sunday' }));

  const item = (index: number, reviewIndex: number, row: Row) =>
    insert('review_items', {
      id: ids.item(index),
      owner_id: owner,
      review_id: ids.review(reviewIndex),
      ...row,
    });
  const occurrenceDetail =
    '{"v":1,"occurrence":{"generation":1,"period":{"kind":"date","date":"2026-09-28"}}}';
  // Review 4 names one of every target kind.
  await item(1, 4, {
    target_kind: 'axis',
    axis_id: ids.health,
    decision: 'note',
    decision_note: 'Morning walks helped',
    sort_key: 'a1',
  });
  await item(2, 4, {
    target_kind: 'project',
    project_id: ids.training,
    decision: 'continue',
    sort_key: 'a2',
  });
  await item(3, 4, {
    target_kind: 'action',
    action_id: ids.bookTrack,
    decision: 'commit',
    sort_key: 'a3',
  });
  await item(4, 4, {
    target_kind: 'milestone',
    milestone_id: ids.first5k,
    decision: 'commit',
    sort_key: 'a4',
  });
  await item(5, 4, {
    target_kind: 'outcome',
    outcome_id: ids.run,
    decision: 'continue',
    sort_key: 'a5',
  });
  await item(6, 4, {
    target_kind: 'routine_occurrence',
    routine_id: ids.walk,
    decision: 'focus',
    detail_json: occurrenceDetail,
    sort_key: 'a6',
  });
  await item(7, 4, {
    target_kind: 'routine',
    routine_id: ids.walk,
    decision: 'focus',
    sort_key: 'a7',
  });
  await item(8, 4, {
    target_kind: 'commitment',
    commitment_id: ids.dentist,
    decision: 'cancel',
    sort_key: 'a8',
  });
  await item(9, 4, {
    target_kind: 'project',
    target_deleted_at: now,
    decision: 'pause',
    sort_key: 'a9',
  });
  await item(10, 4, {
    target_kind: 'axis',
    axis_id: ids.health,
    decision: 'note',
    decision_note: 'Removed note',
    archived_at: now,
    sort_key: 'a0',
  });
  await item(11, 4, {
    target_kind: 'action',
    action_id: ids.stretch,
    decision: 'commit',
    deleted_at: now,
    sort_key: 'a0',
  });
  await item(12, 4, {
    target_kind: 'action',
    action_id: ids.gone,
    decision: 'commit',
    sort_key: 'b1',
  });
  await item(14, 4, {
    target_kind: 'action',
    action_id: ids.stretch,
    decision: 'focus',
    sort_key: 'b2',
    local_revision: 3,
  });
  await item(13, 4, {
    target_kind: 'action',
    action_id: ids.laces,
    decision: 'focus',
    sort_key: 'b2',
  });
  // Review 1: two active decisions and one removed choice.
  await item(20, 1, {
    target_kind: 'action',
    action_id: ids.bookTrack,
    decision: 'move',
    detail_json: '{"v":1,"period":{"kind":"week","date":"2026-10-05"}}',
    sort_key: 'a',
  });
  await item(21, 1, {
    target_kind: 'routine_occurrence',
    routine_id: ids.walk,
    decision: 'complete',
    detail_json: occurrenceDetail,
    sort_key: 'b',
  });
  await item(22, 1, {
    target_kind: 'action',
    action_id: ids.stretch,
    decision: 'carry',
    archived_at: now,
    sort_key: 'c',
  });
  // Axis notes in a draft and in an older completed review.
  await item(30, 5, {
    target_kind: 'axis',
    axis_id: ids.health,
    decision: 'note',
    decision_note: 'Draft note',
    sort_key: 'a',
  });
  await item(31, 6, {
    target_kind: 'axis',
    axis_id: ids.health,
    decision: 'note',
    decision_note: 'Older note',
    sort_key: 'a',
  });

  // A second identity with the same shapes; none of it may ever leak.
  await insert('axes', {
    id: ids.otherAxis,
    owner_id: other,
    title: 'Hidden axis',
    state: 'active',
    sort_key: '0',
  });
  await insert('actions', {
    id: ids.otherAction,
    owner_id: other,
    title: 'Hidden capture',
    state: 'inbox',
    capture_origin: 'plan',
    sort_key: '0',
  });
  await insert('review_checkpoints', {
    id: ids.otherReview,
    owner_id: other,
    profile_id: otherProfile,
    state: 'draft',
    ...daily('2026-09-28'),
  });
  await insert('review_items', {
    id: ids.otherItem,
    owner_id: other,
    review_id: ids.otherReview,
    target_kind: 'axis',
    axis_id: ids.otherAxis,
    decision: 'note',
    decision_note: 'Hidden note',
    sort_key: 'a',
  });
}

async function plan(driver: NodeSqliteDriver, sql: string, parameters: SqliteParameter[]) {
  const rows = await driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters);
  return rows.map(({ detail }) => detail).join('\n');
}

/** Every statement path of `reviewQuerySql`, such as `reviews.type.after`. */
function statementPaths(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === 'string'
      ? [`${prefix}${key}`]
      : statementPaths(entry as object, `${prefix}${key}.`),
  );
}

function statementAt(path: string): string {
  const value = path
    .split('.')
    .reduce<unknown>(
      (current, key) => (current as Readonly<Record<string, unknown>>)[key],
      reviewQuerySql,
    );
  if (typeof value !== 'string') throw new Error(`No statement at ${path}.`);
  return value;
}

/**
 * Expected index searches for representative parameters of every statement. `sorts` marks the
 * statements whose order needs a small sort: Axis-ordered Projects (and each Project's next
 * action), and object lists over several states.
 */
function explainCases(): readonly (readonly [
  string,
  SqliteParameter[],
  readonly string[],
  boolean,
])[] {
  const cursor = ['2026-09-21', '2026-09-21', ids.review(4)];
  const history = (index: string) => `SEARCH r USING INDEX ${index} (owner_id=? AND profile_id=?`;
  const items = 'SEARCH i USING INDEX idx_review_items_review (owner_id=? AND review_id=?)';
  return [
    [
      'reviewRecord',
      [owner, profile, 'daily', '2026-09-28', '2026-09-28'],
      [
        'SEARCH review_checkpoints USING INDEX uq_active_review_period (owner_id=? AND profile_id=? AND review_type=? AND period_start_date=? AND period_end_date=?)',
      ],
      false,
    ],
    [
      'reviewItems',
      [owner, ids.review(4)],
      [items, 'SEARCH tx USING INDEX', 'SEARCH tr USING INDEX', 'SEARCH tc USING INDEX'],
      false,
    ],
    // The scheduled-first order sorts only the review's own reminder records.
    [
      'reviewReminder',
      [owner, ids.review(4)],
      ['SEARCH reminders USING INDEX idx_reminders_review (owner_id=? AND review_id=?)'],
      true,
    ],
    [
      'reviews.type.first',
      [owner, profile, 'weekly', 'draft', 'completed', null, 20],
      [`${history('idx_review_history')} AND review_type=?)`, items],
      false,
    ],
    [
      'reviews.type.after',
      [owner, profile, 'weekly', 'draft', 'completed', null, ...cursor, 20],
      [`${history('idx_review_history')} AND review_type=? AND period_start_date<?)`, items],
      false,
    ],
    [
      'reviews.all.first',
      [owner, profile, 'draft', 'skipped', 'completed', 20],
      [`${history('idx_review_history_all')})`, items],
      false,
    ],
    [
      'reviews.all.after',
      [owner, profile, 'draft', 'skipped', 'completed', ...cursor, 20],
      [`${history('idx_review_history_all')} AND period_start_date<?)`, items],
      false,
    ],
    [
      'reviews.drafts.first',
      [owner, profile, 20],
      [`${history('idx_review_drafts')})`, items],
      false,
    ],
    [
      'reviews.drafts.after',
      [owner, profile, ...cursor, 20],
      [`${history('idx_review_drafts')} AND period_start_date<?)`, items],
      false,
    ],
    [
      'inboxCount',
      [owner],
      ['SEARCH actions USING INDEX idx_actions_inbox_order (owner_id=?)'],
      false,
    ],
    [
      'projects.items',
      [owner, 50],
      [
        'SEARCH p USING INDEX idx_projects_order (owner_id=? AND state=?)',
        'SEARCH x USING INDEX',
        'SEARCH a USING INDEX idx_actions_project (owner_id=? AND project_id=? AND state=?)',
      ],
      true,
    ],
    [
      'projects.count',
      [owner],
      ['SEARCH p USING INDEX idx_projects_order (owner_id=? AND state=?)'],
      false,
    ],
    [
      'axes.items',
      [owner, 50],
      ['SEARCH x USING INDEX idx_axes_order (owner_id=? AND state=?)'],
      false,
    ],
    [
      'axes.count',
      [owner],
      ['SEARCH x USING INDEX idx_axes_order (owner_id=? AND state=?)'],
      false,
    ],
    [
      'objects.outcome.items',
      [owner, 'active', 'paused', null, null, 100],
      ['SEARCH n USING INDEX idx_outcomes_order (owner_id=? AND state=?)', 'SEARCH c USING INDEX'],
      true,
    ],
    [
      'objects.outcome.count',
      [owner, 'active', 'paused', null, null],
      ['SEARCH n USING INDEX idx_outcomes_order (owner_id=? AND state=?)'],
      false,
    ],
    [
      'objects.milestone.items',
      [owner, 'active', null, null, 100],
      [
        'SEARCH n USING INDEX idx_milestones_order (owner_id=? AND state=?)',
        'SEARCH c USING INDEX',
      ],
      true,
    ],
    [
      'objects.milestone.count',
      [owner, 'active', null, null],
      ['SEARCH n USING INDEX idx_milestones_order (owner_id=? AND state=?)'],
      false,
    ],
    [
      'objects.project.items',
      [owner, 'active', 'blocked', 'paused', null, null, 100],
      ['SEARCH n USING INDEX idx_projects_order (owner_id=? AND state=?)', 'SEARCH c USING INDEX'],
      true,
    ],
    [
      'objects.project.count',
      [owner, 'active', 'blocked', 'paused', null, null],
      ['SEARCH n USING INDEX idx_projects_order (owner_id=? AND state=?)'],
      false,
    ],
  ];
}

async function expectIndexedPlans(driver: NodeSqliteDriver) {
  const cases = explainCases();
  expect(cases.map(([name]) => name).sort()).toEqual(statementPaths(reviewQuerySql).sort());
  for (const [name, parameters, expected, sorts] of cases) {
    const detail = await plan(driver, statementAt(name), parameters);
    for (const fragment of expected) expect(detail, name).toContain(fragment);
    // No statement walks a table or a join, and only the marked ones sort outside an index.
    expect(detail, name).not.toMatch(/\bSCAN\b/u);
    if (!sorts) expect(detail, name).not.toContain('TEMP B-TREE');
  }
}

describe('SqliteReviewQueries', () => {
  it('delegates the reads it shares with Today and Plan', async () => {
    const context = await fixture();
    await seed(context);
    const { queries, driver } = context;
    const today = new SqliteTodayQueries(driver);
    const planning = new SqlitePlanningQueries(driver);
    const day = '2026-09-28' as CalendarDate;
    const range = { start: '2026-09-01' as CalendarDate, end: '2026-09-30' as CalendarDate };
    const bounds = {
      startsAt: '2026-09-27T19:00:00.000Z' as Instant,
      endsAt: '2026-09-28T19:00:00.000Z' as Instant,
    };
    const actionRef = createEntityRef('action', ids.bookTrack, owner);
    await expect(queries.getPlanProfile(owner)).resolves.toEqual(await today.getPlanProfile(owner));
    await expect(queries.readRecord(owner, actionRef)).resolves.toEqual(
      await today.readRecord(owner, actionRef),
    );
    const reviewRef = createEntityRef('review', ids.review(7), owner);
    await expect(queries.readRecord(owner, reviewRef)).resolves.toMatchObject({
      document: { reviewType: 'monthly', themeText: 'Fewer, better things' },
    });
    await expect(queries.listRoutines(owner, { includeArchived: true })).resolves.toEqual(
      await today.listRoutines(owner, { includeArchived: true }),
    );
    await expect(queries.listMaterializedOccurrences(owner, range)).resolves.toEqual([]);
    await expect(queries.listCapacityConstraints(owner)).resolves.toEqual([]);
    await expect(queries.getActivePlacement(owner, 'action', ids.bookTrack)).resolves.toBeNull();
    await expect(queries.getPlannedActionBlock(owner, ids.bookTrack)).resolves.toBeNull();
    await expect(queries.listDayBlocks(owner, bounds)).resolves.toEqual(
      await today.listDayBlocks(owner, bounds),
    );
    await expect(queries.listDayActionPlacements(owner, day)).resolves.toEqual([]);
    await expect(queries.listWeekActionPlacements(owner, day, 50)).resolves.toEqual({
      items: [],
      total: 0,
    });
    await expect(queries.listWeekCommitmentActions(owner, day, 50)).resolves.toEqual({
      items: [],
      total: 0,
    });
    await expect(queries.listDayFocus(owner, profile, day)).resolves.toEqual([]);
    await expect(queries.getFocusAction(owner, ids.bookTrack)).resolves.toEqual(
      await today.getFocusAction(owner, ids.bookTrack),
    );
    await expect(queries.listPlacements(owner, range)).resolves.toEqual(
      await planning.listPlacements(owner, range),
    );
    await expect(queries.listBlocks(owner, bounds.startsAt, bounds.endsAt)).resolves.toEqual([]);
    await expect(queries.listWeekSelections(owner, range)).resolves.toEqual([]);
    await context.insert('month_themes', {
      id: id(0x0a, 1),
      owner_id: owner,
      profile_id: profile,
      period_key: '2026-10',
      theme_text: 'Rest',
    });
    await expect(queries.listMonthThemes(owner, '2026' as YearKey)).resolves.toEqual([
      { id: id(0x0a, 1), localRevision: 1, month: '2026-10', text: 'Rest' },
    ]);
    await expect(queries.getYearDirection(owner, '2026' as YearKey)).resolves.toBeNull();
  });

  it('searches a named index in every statement and never scans', async () => {
    const context = await fixture();
    await seed(context);
    await expectIndexedPlans(context.driver);
  });

  it('reads the one non-archived review of an exact period as a canonical record', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context;
    const record = await queries.getReviewRecord(owner, profile, {
      type: 'daily',
      start: '2026-09-28' as CalendarDate,
      end: '2026-09-28' as CalendarDate,
    });
    expect(record).toEqual({
      ref: { type: 'review', id: ids.review(1), ownerId: owner },
      localRevision: 1,
      serverRevision: 0,
      baseSnapshotHash: null,
      document: {
        profileId: profile,
        reviewType: 'daily',
        periodKey: '2026-09-28',
        periodStart: '2026-09-28',
        periodEnd: '2026-09-28',
        notes: longNotes,
        energy: 'high',
        state: 'draft',
      },
    });
    await expect(
      queries.getReviewRecord(owner, profile, {
        type: 'weekly',
        start: '2026-08-30' as CalendarDate,
        end: '2026-09-05' as CalendarDate,
      }),
    ).resolves.toMatchObject({ document: { weekStart: 'sunday', state: 'skipped' } });
    await expect(
      queries.getReviewRecord(owner, profile, {
        type: 'yearly',
        start: '2025-01-01' as CalendarDate,
        end: '2025-12-31' as CalendarDate,
      }),
    ).resolves.toMatchObject({
      document: {
        directionChoice: 'new',
        directionText: 'Build calmly',
        completedAt: completedAt.year2025,
      },
    });
    // Archived reviews, other types, other bounds, and other identities are never returned.
    for (const [ownerId, profileId, type, start, end] of [
      [owner, profile, 'daily', '2026-09-25', '2026-09-25'],
      [owner, profile, 'weekly', '2026-09-28', '2026-09-28'],
      [owner, profile, 'weekly', '2026-09-21', '2026-09-28'],
      [other, profile, 'daily', '2026-09-28', '2026-09-28'],
      [owner, otherProfile, 'daily', '2026-09-28', '2026-09-28'],
    ] as const) {
      await expect(
        queries.getReviewRecord(ownerId, profileId, {
          type,
          start: start as CalendarDate,
          end: end as CalendarDate,
        }),
      ).resolves.toBeNull();
    }
    await expect(
      queries.getReviewRecord(other, otherProfile, {
        type: 'daily',
        start: '2026-09-28' as CalendarDate,
        end: '2026-09-28' as CalendarDate,
      }),
    ).resolves.toMatchObject({ ref: { id: ids.otherReview, ownerId: other } });
  });

  it('lists active items in order with the titles and states they name', async () => {
    const context = await fixture();
    await seed(context);
    const rows = await context.queries.listReviewItems(owner, ids.review(4));
    expect(rows.map(({ record }) => record.ref.id)).toEqual([
      ids.item(1),
      ids.item(2),
      ids.item(3),
      ids.item(4),
      ids.item(5),
      ids.item(6),
      ids.item(7),
      ids.item(8),
      ids.item(9),
      ids.item(12),
      ids.item(13),
      ids.item(14),
    ]);
    expect(rows.map(({ target }) => target)).toEqual([
      { kind: 'axis', id: ids.health, title: 'Health', state: 'active' },
      { kind: 'project', id: ids.training, title: 'Training plan', state: 'active' },
      { kind: 'action', id: ids.bookTrack, title: 'Book track', state: 'inbox' },
      { kind: 'milestone', id: ids.first5k, title: 'First 5k', state: 'active' },
      { kind: 'outcome', id: ids.run, title: 'Run a 10k', state: 'active' },
      {
        kind: 'routine_occurrence',
        routineId: ids.walk,
        routineTitle: 'Morning walk',
        occurrence: {
          routineId: ids.walk,
          generation: 1,
          period: { kind: 'date', date: '2026-09-28' },
        },
      },
      { kind: 'routine', id: ids.walk, title: 'Morning walk' },
      { kind: 'commitment', id: ids.dentist, title: 'Dentist' },
      { kind: 'deleted' },
      // A soft-deleted target reads as "Deleted object" too.
      { kind: 'deleted' },
      { kind: 'action', id: ids.laces, title: 'Buy laces', state: 'planned' },
      { kind: 'action', id: ids.stretch, title: 'Stretch', state: 'planned' },
    ]);
    expect(rows[0]?.record).toEqual({
      ref: { type: 'review_item', id: ids.item(1), ownerId: owner },
      localRevision: 1,
      serverRevision: 0,
      baseSnapshotHash: null,
      document: {
        reviewId: ids.review(4),
        target: { kind: 'axis', axisId: ids.health },
        decision: 'note',
        note: 'Morning walks helped',
        orderKey: 'a1',
      },
    });
    expect(rows[8]?.record.document).toEqual({
      reviewId: ids.review(4),
      target: { kind: 'deleted', deletedKind: 'project', deletedAt: now },
      decision: 'pause',
      orderKey: 'a9',
    });
    expect(rows[11]?.record.localRevision).toBe(3);

    const dailyItems = await context.queries.listReviewItems(owner, ids.review(1));
    expect(dailyItems.map(({ record }) => record.document)).toEqual([
      {
        reviewId: ids.review(1),
        target: { kind: 'action', actionId: ids.bookTrack },
        decision: 'move',
        period: { kind: 'week', date: '2026-10-05' },
        orderKey: 'a',
      },
      {
        reviewId: ids.review(1),
        target: {
          kind: 'routine_occurrence',
          routineId: ids.walk,
          generation: 1,
          period: { kind: 'date', date: '2026-09-28' },
        },
        decision: 'complete',
        orderKey: 'b',
      },
    ]);
    await expect(context.queries.listReviewItems(other, ids.review(4))).resolves.toEqual([]);
    await expect(context.queries.listReviewItems(owner, ids.otherReview)).resolves.toEqual([]);
    await expect(context.queries.listReviewItems(owner, ids.review(10))).resolves.toEqual([]);
  });

  it('reads at most one more item than a review can hold', async () => {
    const context = await fixture();
    await seed(context);
    await context.driver.run(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 405
       )
       INSERT INTO review_items (id, owner_id, review_id, target_kind, action_id, decision,
         sort_key, created_at, updated_at)
       SELECT printf('7c000000-0000-4000-8000-%012x', value), ?, ?, 'action', ?, 'focus',
         printf('k%04d', 406 - value), ?, ?
       FROM sequence;`,
      [owner, ids.review(5), ids.stretch, now, now],
    );
    const rows = await context.queries.listReviewItems(owner, ids.review(5));
    expect(reviewItemRowLimit).toBe(401);
    expect(rows).toHaveLength(401);
    // The existing note sorts first ('a'), then the bulk items by their order keys.
    expect(rows[0]?.record.ref.id).toBe(ids.item(30));
    expect(rows[1]?.record.document['orderKey']).toBe('k0001');
    expect(rows[400]?.record.document['orderKey']).toBe('k0400');
  });

  it('lists reviews newest period first with filters, summaries, and a keyset cursor', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context;
    const all = ['draft', 'skipped', 'completed'] as const;
    const list = (options: Parameters<typeof queries.listReviews>[2]) =>
      queries.listReviews(owner, profile, options);
    const order = async (options: Parameters<typeof queries.listReviews>[2]) =>
      (await list(options)).map(({ reviewId }) => reviewId);

    await expect(order({ states: all, limit: 20 })).resolves.toEqual(
      [1, 2, 3, 4, 5, 6, 8, 7, 11, 9].map(ids.review),
    );
    await expect(order({ type: 'weekly', states: all, limit: 20 })).resolves.toEqual(
      [4, 5, 6, 11].map(ids.review),
    );
    await expect(
      order({ type: 'daily', states: ['draft', 'skipped'], limit: 20 }),
    ).resolves.toEqual([1, 3, 8].map(ids.review));
    await expect(order({ states: ['completed'], limit: 20 })).resolves.toEqual(
      [2, 4, 6, 9].map(ids.review),
    );
    await expect(order({ states: ['draft'], limit: 20 })).resolves.toEqual(
      [1, 5, 7].map(ids.review),
    );
    await expect(order({ states: ['skipped', 'skipped'], limit: 2 })).resolves.toEqual(
      [3, 8].map(ids.review),
    );
    await expect(list({ states: [], limit: 20 })).resolves.toEqual([]);

    const summaries = await list({ states: all, limit: 20 });
    expect(summaries[0]).toEqual({
      reviewId: ids.review(1),
      localRevision: 1,
      period: { type: 'daily', key: '2026-09-28', start: '2026-09-28', end: '2026-09-28' },
      state: 'draft',
      energy: 'high',
      notesExcerpt: 'A'.repeat(200),
      decisionCount: 2,
      updatedAt: now,
      createdAt: now,
    });
    expect(summaries[3]).toEqual({
      reviewId: ids.review(4),
      localRevision: 1,
      period: {
        type: 'weekly',
        key: '2026-09-21',
        start: '2026-09-21',
        end: '2026-09-27',
        weekStart: 'monday',
      },
      state: 'completed',
      decisionCount: 12,
      updatedAt: now,
      createdAt: now,
      completedAt: completedAt.week21,
    });
    const byId = (index: number) =>
      summaries.find(({ reviewId }) => reviewId === ids.review(index));
    expect(byId(3)).toMatchObject({ notesExcerpt: 'Short note', decisionCount: 0 });
    expect(byId(3)).not.toHaveProperty('energy');
    expect(byId(5)).toMatchObject({ state: 'draft', decisionCount: 1 });
    expect(byId(7)?.period).toEqual({
      type: 'monthly',
      key: '2026-09',
      start: '2026-09-01',
      end: '2026-09-30',
    });
    expect(byId(9)).toMatchObject({
      period: { type: 'yearly', key: '2025', start: '2025-01-01', end: '2025-12-31' },
      state: 'completed',
      completedAt: completedAt.year2025,
    });
    expect(byId(11)).toMatchObject({
      period: { type: 'weekly', start: '2026-08-30', end: '2026-09-05', weekStart: 'sunday' },
      state: 'skipped',
    });

    // Pages concatenate to the full list, across a tie on the period start.
    for (const [options, expected] of [
      [{ states: all }, [1, 2, 3, 4, 5, 6, 8, 7, 11, 9]],
      [{ type: 'weekly', states: all }, [4, 5, 6, 11]],
      [{ states: ['draft'] }, [1, 5, 7]],
    ] as const) {
      const pages: string[] = [];
      let before: { periodStart: CalendarDate; id: UUID } | undefined;
      for (let page = 0; page < 10; page += 1) {
        const items = await list({
          ...options,
          limit: 2,
          ...(before === undefined ? {} : { before }),
        });
        pages.push(...items.map(({ reviewId }) => reviewId));
        const last = items.at(-1);
        if (items.length < 2 || last === undefined) break;
        before = { periodStart: last.period.start, id: last.reviewId };
      }
      expect(pages).toEqual(expected.map(ids.review));
    }
    await expect(
      order({
        states: all,
        before: { periodStart: '2026-09-01' as CalendarDate, id: ids.review(8) },
        limit: 20,
      }),
    ).resolves.toEqual([7, 11, 9].map(ids.review));

    // Owner and profile isolation.
    await expect(queries.listReviews(other, profile, { states: all, limit: 20 })).resolves.toEqual(
      [],
    );
    await expect(
      queries.listReviews(owner, otherProfile, { states: all, limit: 20 }),
    ).resolves.toEqual([]);
    expect(
      (await queries.listReviews(other, otherProfile, { states: all, limit: 20 })).map(
        ({ reviewId, decisionCount }) => [reviewId, decisionCount],
      ),
    ).toEqual([[ids.otherReview, 1]]);

    // Invalid input is refused rather than guessed.
    await expect(list({ states: ['archived' as 'draft'], limit: 20 })).rejects.toThrow(RangeError);
    await expect(list({ type: 'quarterly' as 'daily', states: all, limit: 20 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      list({
        states: all,
        before: { periodStart: '2026-02-30' as CalendarDate, id: ids.review(1) },
        limit: 20,
      }),
    ).rejects.toThrow(RangeError);
    await expect(list({ states: all, limit: -1 })).rejects.toThrow(RangeError);
    await expect(list({ states: all, limit: 999 })).resolves.toHaveLength(10);
  });

  it('reads a cursor id written in capitals as the stored lowercase id', async () => {
    const context = await fixture();
    const first = 'bbbbbbbb-0000-4000-8000-000000000001' as UUID;
    const second = 'aaaaaaaa-0000-4000-8000-000000000001' as UUID;
    const third = '99999999-0000-4000-8000-000000000001' as UUID;
    const review = (reviewId: UUID, row: Row) =>
      context.insert('review_checkpoints', {
        id: reviewId,
        owner_id: owner,
        profile_id: profile,
        state: 'draft',
        ...row,
      });
    // Three reviews that start on the same day, so only their ids order them.
    await review(first, daily('2026-09-01'));
    await review(second, weekly('2026-09-01', '2026-09-07', { week_start: 'tuesday' }));
    await review(third, {
      review_type: 'monthly',
      period_key: '2026-09',
      period_start_date: '2026-09-01',
      period_end_date: '2026-09-30',
    });
    for (const states of [['draft', 'skipped', 'completed'], ['draft']] as const) {
      for (const cursorId of [first, first.toUpperCase() as UUID]) {
        const page = await context.queries.listReviews(owner, profile, {
          states,
          before: { periodStart: '2026-09-01' as CalendarDate, id: cursorId },
          limit: 10,
        });
        expect(
          page.map(({ reviewId }) => reviewId),
          `${states.join()} after ${cursorId}`,
        ).toEqual([second, third]);
      }
    }
  });

  it('reports when each listed review was first saved', async () => {
    const context = await fixture();
    await seed(context);
    const firstSaved = '2026-09-28T21:30:00.000Z';
    await context.driver.run('UPDATE review_checkpoints SET created_at = ? WHERE id = ?;', [
      firstSaved,
      ids.review(1),
    ]);
    const all = ['draft', 'skipped', 'completed'] as const;
    // Every statement: all types, one type (the exact-period lookup), and drafts.
    for (const options of [
      { states: all, limit: 20 },
      {
        type: 'daily',
        states: all,
        before: { periodStart: '2026-09-29' as CalendarDate, id: lowestId },
        limit: 1,
      },
      { states: ['draft'], limit: 20 },
    ] as const) {
      const [first] = await context.queries.listReviews(owner, profile, options);
      expect(first, JSON.stringify(options)).toMatchObject({
        reviewId: ids.review(1),
        createdAt: firstSaved,
        updatedAt: now,
      });
    }
  });

  it('counts Inbox Actions of one owner', async () => {
    const context = await fixture();
    await seed(context);
    await expect(context.queries.countInboxActions(owner)).resolves.toBe(3);
    await expect(context.queries.countInboxActions(other)).resolves.toBe(1);
  });

  it('lists active and blocked Projects in Axis order with their next Action', async () => {
    const context = await fixture();
    await seed(context);
    const projects = await context.queries.listReviewProjects(owner, 50);
    expect(projects).toEqual({
      items: [
        {
          kind: 'project',
          id: ids.shoes,
          localRevision: 1,
          title: 'Buy shoes',
          state: 'blocked',
          context: 'Health',
          nextAction: { id: ids.laces, title: 'Buy laces' },
        },
        {
          kind: 'project',
          id: ids.training,
          localRevision: 1,
          title: 'Training plan',
          state: 'active',
          context: 'Health',
          targetStart: '2026-10-01',
          targetEnd: '2026-11-30',
          nextAction: { id: ids.bookTrack, title: 'Book track' },
        },
        {
          kind: 'project',
          id: ids.reading,
          localRevision: 1,
          title: 'Read a book',
          state: 'active',
          context: 'Study',
        },
        {
          kind: 'project',
          id: ids.legacy,
          localRevision: 1,
          title: 'Legacy plan',
          state: 'active',
          context: 'Old',
        },
        { kind: 'project', id: ids.loose, localRevision: 1, title: 'Loose plan', state: 'active' },
      ],
      total: 5,
    });
    await expect(context.queries.listReviewProjects(owner, 2)).resolves.toMatchObject({
      items: [{ id: ids.shoes }, { id: ids.training }],
      total: 5,
    });
    await expect(context.queries.listReviewProjects(owner, 0)).resolves.toEqual({
      items: [],
      total: 5,
    });
    await expect(context.queries.listReviewProjects(other, 50)).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  it('lists active Axes in order with their color and icon', async () => {
    const context = await fixture();
    await seed(context);
    // Tie A and Tie B share an order key; the id breaks the tie. Archived Axes are left out.
    await expect(context.queries.listReviewAxes(owner, 50)).resolves.toEqual({
      items: [
        { id: ids.health, title: 'Health', color: 'teal', icon: 'leaf' },
        { id: ids.study, title: 'Study' },
        { id: ids.tieB, title: 'Tie B' },
        { id: ids.tieA, title: 'Tie A' },
      ],
      total: 4,
    });
    await expect(context.queries.listReviewAxes(owner, 1)).resolves.toEqual({
      items: [{ id: ids.health, title: 'Health', color: 'teal', icon: 'leaf' }],
      total: 4,
    });
    await expect(context.queries.listReviewAxes(other, 50)).resolves.toEqual({
      items: [{ id: ids.otherAxis, title: 'Hidden axis' }],
      total: 1,
    });
  });

  it('lists Outcomes, Milestones, and Projects in the given states with their context', async () => {
    const context = await fixture();
    await seed(context);
    const { queries } = context;
    await expect(
      queries.listReviewObjects(owner, 'outcome', ['active', 'paused'], 100),
    ).resolves.toEqual({
      items: [
        {
          kind: 'outcome',
          id: ids.sleep,
          localRevision: 1,
          title: 'Sleep well',
          state: 'paused',
          context: 'Health',
        },
        {
          kind: 'outcome',
          id: ids.run,
          localRevision: 1,
          title: 'Run a 10k',
          state: 'active',
          context: 'Health',
          targetStart: '2026-10-01',
          targetEnd: '2026-12-31',
        },
        {
          kind: 'outcome',
          id: ids.floating,
          localRevision: 1,
          title: 'Floating goal',
          state: 'active',
        },
      ],
      total: 3,
    });
    await expect(queries.listReviewObjects(owner, 'milestone', ['active'], 100)).resolves.toEqual({
      items: [
        {
          kind: 'milestone',
          id: ids.second5k,
          localRevision: 1,
          title: 'Second 5k',
          state: 'active',
          context: 'Sleep well',
        },
        {
          kind: 'milestone',
          id: ids.first5k,
          localRevision: 1,
          title: 'First 5k',
          state: 'active',
          context: 'Run a 10k',
          targetEnd: '2026-10-31',
        },
      ],
      total: 2,
    });
    const projects = await queries.listReviewObjects(
      owner,
      'project',
      ['active', 'blocked', 'paused'],
      100,
    );
    expect(projects.items.map((row) => [row.id, row.state, row.context])).toEqual([
      [ids.shoes, 'blocked', 'Health'],
      [ids.training, 'active', 'Health'],
      [ids.reading, 'active', 'Study'],
      [ids.legacy, 'active', 'Old'],
      [ids.loose, 'active', undefined],
      [ids.pausedProject, 'paused', 'Health'],
    ]);
    expect(projects.total).toBe(6);
    await expect(
      queries.listReviewObjects(owner, 'project', ['active', 'blocked', 'paused'], 2),
    ).resolves.toMatchObject({ items: [{ id: ids.shoes }, { id: ids.training }], total: 6 });
    await expect(
      queries.listReviewObjects(owner, 'outcome', ['achieved', 'abandoned'], 100),
    ).resolves.toMatchObject({ items: [{ id: ids.achieved }], total: 1 });
    await expect(queries.listReviewObjects(owner, 'milestone', [], 100)).resolves.toEqual({
      items: [],
      total: 0,
    });
    await expect(queries.listReviewObjects(other, 'outcome', ['active'], 100)).resolves.toEqual({
      items: [],
      total: 0,
    });
    await expect(queries.listReviewObjects(owner, 'outcome', ['archived'], 100)).rejects.toThrow(
      RangeError,
    );
    await expect(queries.listReviewObjects(owner, 'milestone', ['paused'], 100)).rejects.toThrow(
      RangeError,
    );
  });
});

describe('SqliteReviewQueries at scale', () => {
  it(
    'keeps history pages and item lists bounded over a multi-year history',
    { timeout: 120_000 },
    async () => {
      const context = await fixture();
      await seed(context);
      const { driver, queries } = context;
      // A plan with realistic numbers of Routines and Commitments, so table statistics never
      // make scanning a one-row table the cheaper join.
      await driver.run(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 60
         )
         INSERT INTO routines (id, owner_id, title, state, sort_key, created_at, updated_at)
         SELECT printf('7a000000-0000-4000-8000-%012x', value), ?, 'Routine ' || value, 'active',
           printf('r%03d', value), ?, ?
         FROM sequence;`,
        [owner, now, now],
      );
      await driver.run(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 60
         )
         INSERT INTO commitments (id, owner_id, title, strength, state, created_at, updated_at)
         SELECT printf('7b000000-0000-4000-8000-%012x', value), ?, 'Commitment ' || value, 'soft',
           'planned', ?, ?
         FROM sequence;`,
        [owner, now, now],
      );
      // Three years of completed daily reviews (none overlapping the seeded ones), weekly
      // reviews, and four decisions each.
      await driver.run(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 1000
         )
         INSERT INTO review_checkpoints (id, owner_id, profile_id, review_type, period_key,
           period_start_date, period_end_date, state, completed_at, created_at, updated_at)
         SELECT printf('7d000000-0000-4000-8000-%012x', value), ?, ?, 'daily',
           date('2023-06-01', '+' || value || ' days'), date('2023-06-01', '+' || value || ' days'),
           date('2023-06-01', '+' || value || ' days'), 'completed', ?, ?, ?
         FROM sequence;`,
        [owner, profile, now, now, now],
      );
      await driver.run(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 140
         )
         INSERT INTO review_checkpoints (id, owner_id, profile_id, review_type, period_key,
           period_start_date, period_end_date, week_start, state, completed_at, created_at,
           updated_at)
         SELECT printf('7e000000-0000-4000-8000-%012x', value), ?, ?, 'weekly',
           date('2023-06-05', '+' || (value * 7) || ' days'),
           date('2023-06-05', '+' || (value * 7) || ' days'),
           date('2023-06-05', '+' || (value * 7 + 6) || ' days'), 'monday', 'completed', ?, ?, ?
         FROM sequence;`,
        [owner, profile, now, now, now],
      );
      await driver.run(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 4003
         )
         INSERT INTO review_items (id, owner_id, review_id, target_kind, action_id, decision,
           sort_key, created_at, updated_at)
         SELECT printf('7f000000-0000-4000-8000-%012x', value), ?,
           printf('7d000000-0000-4000-8000-%012x', value / 4), 'action', ?, 'carry',
           printf('k%d', value % 4), ?, ?
         FROM sequence;`,
        [owner, ids.stretch, now, now],
      );
      await driver.executeScript('ANALYZE;');
      await expectIndexedPlans(driver);

      const all = ['draft', 'skipped', 'completed'] as const;
      const started = performance.now();
      let before: { periodStart: CalendarDate; id: UUID } | undefined;
      let listed = 0;
      for (let page = 0; page < 5; page += 1) {
        const items = await queries.listReviews(owner, profile, {
          states: all,
          limit: 21,
          ...(before === undefined ? {} : { before }),
        });
        listed += items.length;
        const last = items.at(-1);
        if (last === undefined) break;
        before = { periodStart: last.period.start, id: last.reviewId };
      }
      const oldest = await queries.listReviews(owner, profile, {
        type: 'daily',
        states: ['completed'],
        before: { periodStart: '2023-06-03' as CalendarDate, id: ids.review(1) },
        limit: 21,
      });
      const items = await queries.listReviewItems(
        owner,
        '7d000000-0000-4000-8000-000000000000' as UUID,
      );
      const drafts = await queries.listReviews(owner, profile, { states: ['draft'], limit: 21 });
      expect(performance.now() - started).toBeLessThan(500);
      expect(listed).toBe(105);
      expect(oldest.map(({ period }) => period.start)).toEqual(['2023-06-02', '2023-06-01']);
      expect(oldest[0]?.decisionCount).toBe(4);
      expect(items).toHaveLength(4);
      expect(drafts.map(({ reviewId }) => reviewId)).toEqual([1, 5, 7].map(ids.review));
    },
  );
});
