import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeCommand,
  type ApplicationDependencies,
  type CanonicalMutation,
  type CanonicalRecordState,
} from '@yelaxis/application';
import {
  addDays,
  createEntityRef,
  localDayBounds,
  occurrenceLogicalKey,
  occurrencePeriodKey,
  ok,
  routineOccurrenceId,
  type CalendarDate,
  type EntityType,
  type GeneratedOccurrencePeriod,
  type IanaTimeZone,
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
import { SqlitePlanningQueries } from './planning-queries';
import { blockLookbackMs, SqliteTodayQueries, todayQuerySql } from './today-queries';

const now = '2026-09-28T09:00:00.000Z' as Instant;
const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
const other = '10000000-0000-4000-8000-000000000002' as OwnerId;
const profile = '11000000-0000-4000-8000-000000000001' as UUID;
const otherProfile = '11000000-0000-4000-8000-000000000002' as UUID;
const zone = 'America/New_York' as IanaTimeZone;
/** A Monday. The local day is 2026-09-28T04:00Z to 2026-09-29T04:00Z. */
const day = '2026-09-28' as CalendarDate;
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
  action: (index: number) => id(5, index),
  block: (index: number) => id(6, index),
  commitment: id(7, 1),
  placement: (index: number) => id(8, index),
  selection: (index: number) => id(9, index),
  routine: (index: number) => id(10, index),
  focus: (index: number) => id(12, index),
  project: id(13, 1),
  otherAction: id(19, 1),
};

type Row = Record<string, SqliteParameter>;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-today-queries-'));
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
      planning_time_zone: zone,
      week_start: 'monday',
      time_format: '12_hour',
    });
  }
  let counter = 1;
  const nextId = () => id(0x90, counter++);
  const dependencies: ApplicationDependencies = {
    ...createSqliteApplicationAdapters(driver, { ownerId: owner }),
    ids: { next: nextId },
    clock: { now: () => now },
    projections: { notifyCommitted() {} },
  };
  /** Commit mutations through the real command pipeline with one minimized event per record. */
  const commit = (mutations: readonly CanonicalMutation[]) =>
    executeCommand(
      dependencies,
      {
        commandId: nextId(),
        ownerId: owner,
        actor: 'user',
        expectedRevisions: mutations.flatMap((mutation) =>
          mutation.operation === 'create'
            ? []
            : [{ ref: mutation.ref, revision: mutation.expectedRevision }],
        ),
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
  const seeded = async (mutations: readonly CanonicalMutation[]) => {
    const result = await commit(mutations);
    if (!result.ok) throw new Error(`Seed command failed: ${JSON.stringify(result.error)}`);
  };
  return {
    driver,
    insert,
    commit,
    seeded,
    today: new SqliteTodayQueries(driver),
    planning: new SqlitePlanningQueries(driver),
  };
}

function create(type: EntityType, entityId: UUID, document: object): CanonicalMutation {
  return {
    operation: 'create',
    ref: { type, id: entityId, ownerId: owner },
    expectedRevision: null,
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document: document as Readonly<Record<string, unknown>>,
  };
}

function update(record: CanonicalRecordState, document: object): CanonicalMutation {
  return {
    operation: 'update',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    document: document as Readonly<Record<string, unknown>>,
  };
}

const action = (index: number, state: string, extra: Row = {}): Row => ({
  id: ids.action(index),
  owner_id: owner,
  title: `Action ${String(index)}`,
  state,
  capture_origin: 'plan',
  sort_key: `a${String(index).padStart(2, '0')}`,
  ...(state === 'completed' ? { completed_at: now } : {}),
  ...(state === 'archived' ? { state_before_archive: 'planned', archived_at: now } : {}),
  ...extra,
});

const dayPlacement = (index: number, actionIndex: number, date: string, extra: Row = {}): Row => ({
  id: ids.placement(index),
  owner_id: owner,
  action_id: ids.action(actionIndex),
  horizon: 'day',
  period_key: date,
  period_start_date: date,
  period_end_date: date,
  sort_key: `p${String(index).padStart(2, '0')}`,
  ...extra,
});

const weekPlacement = (
  index: number,
  actionIndex: number,
  start: string,
  weekStart: string,
  extra: Row = {},
): Row => ({
  id: ids.placement(index),
  owner_id: owner,
  action_id: ids.action(actionIndex),
  horizon: 'week',
  period_key: start,
  period_start_date: start,
  period_end_date: addDays(start as CalendarDate, 6),
  week_start: weekStart,
  sort_key: `w${String(index).padStart(2, '0')}`,
  ...extra,
});

const block = (
  index: number,
  startsAt: string,
  endsAt: string,
  target: Row,
  state = 'planned',
  extra: Row = {},
): Row => ({
  id: ids.block(index),
  owner_id: owner,
  starts_at_utc: startsAt,
  ends_at_utc: endsAt,
  time_zone: zone,
  state,
  ...target,
  ...extra,
});

const weekSelection = (
  index: number,
  target: Row,
  start: string,
  weekStart: string,
  sortKey: string,
  extra: Row = {},
): Row => ({
  id: ids.selection(index),
  owner_id: owner,
  profile_id: profile,
  period_start_date: start,
  period_end_date: addDays(start as CalendarDate, 6),
  week_start: weekStart,
  sort_key: sortKey,
  ...target,
  ...extra,
});

const focusRow = (
  index: number,
  target: Row,
  date: string,
  sortKey: string,
  extra: Row = {},
): Row => ({
  id: ids.focus(index),
  owner_id: owner,
  profile_id: profile,
  local_date: date,
  sort_key: sortKey,
  ...target,
  ...extra,
});

function occurrence(
  routineId: UUID,
  period: GeneratedOccurrencePeriod,
  extra: Record<string, unknown> = {},
) {
  return {
    id: routineOccurrenceId(occurrenceLogicalKey(routineId, 1, period)),
    document: {
      routineId,
      generation: 1,
      periodKey: occurrencePeriodKey(period),
      period,
      state: 'planned',
      ...(period.kind === 'week' ? { targetCount: period.targetCount, completedCount: 0 } : {}),
      ...extra,
    },
  };
}

const flexibleRoutine = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  orderKey: title,
  state: 'active',
  generations: [
    {
      generation: 1,
      rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-01-01' },
      schedulingMode: { kind: 'day_flexible' },
    },
  ],
  ...extra,
});

async function plan(driver: NodeSqliteDriver, sql: string, parameters: SqliteParameter[]) {
  const rows = await driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters);
  return rows.map(({ detail }) => detail).join('\n');
}

/** Expected index searches  for representative parameters of every statement. */
function explainCases(
  date: CalendarDate,
  bounds: { readonly startsAt: string; readonly endsAt: string },
  actionId: UUID,
): readonly (readonly [keyof typeof todayQuerySql, SqliteParameter[], readonly string[]])[] {
  const week = [owner, date, date];
  const placementWeek =
    'SEARCH p USING INDEX idx_placements_overlap_end (owner_id=? AND horizon=? AND period_end_date>?)';
  const selectionWeek =
    'SEARCH w USING INDEX idx_week_selections_overlap_end (owner_id=? AND period_end_date>?)';
  return [
    [
      'dayBlocks',
      [owner, bounds.endsAt, bounds.startsAt],
      ['SEARCH b USING INDEX idx_time_blocks_overlap_end (owner_id=? AND ends_at_utc>?)'],
    ],
    [
      'dayActionPlacements',
      [owner, date, date],
      [
        'SEARCH p USING INDEX idx_placements_period (owner_id=? AND horizon=? AND period_start_date=? AND period_end_date=?)',
      ],
    ],
    [
      'weekActionPlacements',
      [...week, 50],
      [placementWeek, 'SEARCH nb USING INDEX uq_time_blocks_one_planned_action'],
    ],
    ['countWeekActionPlacements', week, [placementWeek]],
    [
      'weekCommitmentActions',
      [...week, 50],
      [selectionWeek, 'SEARCH pl USING INDEX uq_active_placement_action'],
    ],
    ['countWeekCommitmentActions', week, [selectionWeek]],
    [
      'dayFocus',
      [owner, profile, date],
      [
        'SEARCH f USING INDEX idx_focus_day_order (owner_id=? AND profile_id=? AND local_date=?)',
        'SEARCH pl USING INDEX uq_active_placement_action',
      ],
    ],
    [
      'focusAction',
      [owner, actionId],
      ['SEARCH a USING INDEX', 'SEARCH pl USING INDEX uq_active_placement_action'],
    ],
    [
      'focusActionBlock',
      [owner, actionId],
      ['SEARCH b USING INDEX uq_time_blocks_one_planned_action (owner_id=? AND action_id=?)'],
    ],
  ];
}

async function expectIndexedPlans(driver: NodeSqliteDriver, date: CalendarDate, actionId: UUID) {
  const cases = explainCases(date, localDayBounds(date, zone), actionId);
  expect(cases.map(([name]) => name).sort()).toEqual(Object.keys(todayQuerySql).sort());
  for (const [name, parameters, expected] of cases) {
    const detail = await plan(driver, todayQuerySql[name], parameters);
    for (const fragment of expected) expect(detail, name).toContain(fragment);
    // No statement walks an owner history table. Overlap reads sort only their matching
    // interval rows because valid imported intervals need not have a fixed duration.
    expect(detail, name).not.toMatch(/\bSCAN\b/u);
    if (!['dayBlocks', 'weekActionPlacements', 'weekCommitmentActions'].includes(name))
      expect(detail, name).not.toContain('TEMP B-TREE');
  }
}

describe('SqliteTodayQueries', () => {
  it('delegates the reads it shares with Plan to the planning statements', async () => {
    const { today, planning, insert } = await fixture();
    await insert('actions', action(1, 'planned'));
    const range = { start: '2026-09-27' as CalendarDate, end: '2026-09-29' as CalendarDate };
    await expect(today.getPlanProfile(owner)).resolves.toEqual(
      await planning.getPlanProfile(owner),
    );
    const ref = createEntityRef('action', ids.action(1), owner);
    await expect(today.readRecord(owner, ref)).resolves.toEqual(
      await planning.readRecord(owner, ref),
    );
    await expect(today.listRoutines(owner, { includeArchived: false })).resolves.toEqual([]);
    await expect(today.listMaterializedOccurrences(owner, range)).resolves.toEqual([]);
    await expect(today.listCapacityConstraints(owner)).resolves.toEqual([]);
    await expect(today.getActivePlacement(owner, 'action', ids.action(1))).resolves.toBeNull();
    await expect(today.getPlannedActionBlock(owner, ids.action(1))).resolves.toBeNull();
  });

  it('looks back 48 hours for blocks that reach into a day', () => {
    expect(blockLookbackMs).toBe(48 * 3_600_000);
  });

  it('searches a named index in every statement and never scans or sorts outside one', async () => {
    const { driver } = await fixture();
    await expectIndexedPlans(driver, day, ids.action(1));
  });

  it('reads all blocks intersecting one local day across midnight, including long imports', async () => {
    const { insert, today } = await fixture();
    await insert('actions', action(1, 'scheduled'));
    await insert('commitments', {
      id: ids.commitment,
      owner_id: owner,
      title: 'Dentist',
      strength: 'hard',
      state: 'planned',
    });
    const custom = (title: string) => ({ custom_title: title });
    const actionTarget = { action_id: ids.action(1) };
    // Starts the evening before (22:00 local) and reaches 01:00 local.
    await insert(
      'time_blocks',
      block(1, '2026-09-28T02:00:00.000Z', '2026-09-28T05:00:00.000Z', custom('Night shift')),
    );
    // Ends exactly at the day's start / starts exactly at its end: never on the day.
    await insert(
      'time_blocks',
      block(2, '2026-09-28T03:00:00.000Z', '2026-09-28T04:00:00.000Z', custom('Before')),
    );
    await insert(
      'time_blocks',
      block(3, '2026-09-29T04:00:00.000Z', '2026-09-29T05:00:00.000Z', custom('After')),
    );
    // Starts 23:00 local and runs past midnight into the next day.
    await insert(
      'time_blocks',
      block(4, '2026-09-29T03:00:00.000Z', '2026-09-29T05:00:00.000Z', actionTarget),
    );
    await insert(
      'time_blocks',
      block(5, '2026-09-28T12:00:00.000Z', '2026-09-28T13:00:00.000Z', custom('Done'), 'completed'),
    );
    await insert(
      'time_blocks',
      block(6, '2026-09-28T14:00:00.000Z', '2026-09-28T15:00:00.000Z', custom('Let go'), 'skipped'),
    );
    await insert(
      'time_blocks',
      block(
        7,
        '2026-09-28T16:00:00.000Z',
        '2026-09-28T17:00:00.000Z',
        custom('Canceled'),
        'canceled',
      ),
    );
    await insert(
      'time_blocks',
      block(8, '2026-09-28T17:00:00.000Z', '2026-09-28T18:00:00.000Z', actionTarget, 'canceled', {
        superseded_by_id: ids.block(4),
      }),
    );
    await insert(
      'time_blocks',
      block(
        9,
        '2026-09-28T18:00:00.000Z',
        '2026-09-28T19:00:00.000Z',
        custom('Deleted'),
        'planned',
        { deleted_at: now },
      ),
    );
    // Both intervals remain valid imports and intersect the day, even past the former48h cutoff.
    await insert(
      'time_blocks',
      block(11, '2026-09-26T04:00:00.000Z', '2026-09-28T04:30:00.000Z', custom('Long import')),
    );
    await insert(
      'time_blocks',
      block(12, '2026-09-26T03:59:59.999Z', '2026-09-28T05:00:00.000Z', custom('Longer import')),
    );
    await insert(
      'time_blocks',
      block(13, '2026-09-28T10:00:00.000Z', '2026-09-28T11:00:00.000Z', {
        commitment_id: ids.commitment,
      }),
    );
    await insert('time_blocks', {
      ...block(14, '2026-09-28T12:00:00.000Z', '2026-09-28T13:00:00.000Z', custom('Private')),
      owner_id: other,
    });

    const blocks = await today.listDayBlocks(owner, localDayBounds(day, zone));
    expect(blocks.map((row) => row.id)).toEqual([
      ids.block(12),
      ids.block(11),
      ids.block(1),
      ids.block(13),
      ids.block(5),
      ids.block(6),
      ids.block(4),
    ]);
    expect(blocks[2]).toEqual({
      id: ids.block(1),
      localRevision: 1,
      startsAt: '2026-09-28T02:00:00.000Z',
      endsAt: '2026-09-28T05:00:00.000Z',
      timeZone: zone,
      state: 'planned',
      overlapAcknowledged: false,
      target: { kind: 'custom', title: 'Night shift' },
    });
    expect(blocks[3]?.target).toEqual({
      kind: 'commitment',
      commitmentId: ids.commitment,
      title: 'Dentist',
      strength: 'hard',
      commitmentState: 'planned',
      commitmentRevision: 1,
    });
    expect(blocks[6]?.target).toEqual({
      kind: 'action',
      actionId: ids.action(1),
      title: 'Action 1',
      actionState: 'scheduled',
      actionRevision: 1,
    });
    expect(blocks.map((row) => row.state)).toEqual([
      'planned',
      'planned',
      'planned',
      'planned',
      'completed',
      'skipped',
      'planned',
    ]);

    const next = await today.listDayBlocks(
      owner,
      localDayBounds('2026-09-29' as CalendarDate, zone),
    );
    // The late block continues into the next day, which also owns the block starting at midnight.
    expect(next.map((row) => row.id)).toEqual([ids.block(4), ids.block(3)]);
    await expect(today.listDayBlocks(other, localDayBounds(day, zone))).resolves.toMatchObject([
      { id: ids.block(14), target: { kind: 'custom', title: 'Private' } },
    ]);
    await expect(
      today.listDayBlocks(owner, { startsAt: '2026-09-28' as Instant, endsAt: now }),
    ).rejects.toThrow(RangeError);
  });

  it('keeps a 24 h 59 m clock-change block that began the previous day', async () => {
    const { insert, today } = await fixture();
    // A commitment authored in St. John's for its fall-back day, 00:00 NDT to 23:59 NST: 24 h 59 m.
    const startsAt = '2026-11-01T02:30:00.000Z';
    const endsAt = '2026-11-02T03:29:00.000Z';
    await insert(
      'time_blocks',
      block(1, startsAt, endsAt, { custom_title: 'Overnight shift' }, 'planned', {
        time_zone: 'America/St_Johns',
      }),
    );
    // Read in a São Paulo planning day, which starts 24 h 30 m after the block began.
    const bounds = localDayBounds(
      '2026-11-02' as CalendarDate,
      'America/Sao_Paulo' as IanaTimeZone,
    );
    expect(bounds.startsAt).toBe('2026-11-02T03:00:00.000Z');
    expect(Date.parse(endsAt) - Date.parse(startsAt)).toBe((24 * 60 + 59) * 60_000);
    expect(Date.parse(bounds.startsAt) - Date.parse(startsAt)).toBeGreaterThan(24 * 3_600_000);
    await expect(today.listDayBlocks(owner, bounds)).resolves.toMatchObject([
      { id: ids.block(1), timeZone: 'America/St_Johns', target: { title: 'Overnight shift' } },
    ]);

    // The planning zone's own 25-hour fall-back day includes its extra hour.
    await insert(
      'time_blocks',
      block(2, '2026-11-02T04:30:00.000Z', '2026-11-02T05:30:00.000Z', {
        custom_title: 'Late call',
      }),
    );
    const fallBack = localDayBounds('2026-11-01' as CalendarDate, zone);
    expect(Date.parse(fallBack.endsAt) - Date.parse(fallBack.startsAt)).toBe(25 * 3_600_000);
    const long = await today.listDayBlocks(owner, fallBack);
    expect(long.map((row) => row.id)).toEqual([ids.block(1), ids.block(2)]);
    const after = await today.listDayBlocks(
      owner,
      localDayBounds('2026-11-02' as CalendarDate, zone),
    );
    expect(after.map((row) => row.id)).toEqual([ids.block(2)]);
  });
});

describe('SqliteTodayQueries placements and Week lists', () => {
  it('reads Day placements on exactly one date, of every non-archived Action state', async () => {
    const { insert, today } = await fixture();
    await insert(
      'actions',
      action(1, 'planned', {
        estimate_minutes: 45,
        energy: 'focused',
        priority: 'high',
        due_date: '2026-10-02',
      }),
    );
    await insert('actions', action(2, 'in_progress'));
    await insert('actions', action(3, 'completed'));
    await insert('actions', action(4, 'scheduled'));
    await insert('actions', action(5, 'canceled'));
    await insert('actions', action(6, 'archived'));
    await insert('actions', action(7, 'planned'));
    await insert('actions', action(8, 'planned'));
    await insert('actions', action(9, 'planned'));
    await insert('actions', action(10, 'planned'));
    await insert('actions', action(11, 'planned', { deleted_at: now }));
    await insert('actions', { ...action(12, 'planned'), id: ids.otherAction, owner_id: other });

    await insert('planning_placements', dayPlacement(1, 1, day, { sort_key: 'p2' }));
    await insert('planning_placements', dayPlacement(2, 2, day, { sort_key: 'p1' }));
    await insert('planning_placements', dayPlacement(3, 3, day, { sort_key: 'p3' }));
    // Same order key: the id breaks the tie.
    await insert('planning_placements', dayPlacement(5, 5, day, { sort_key: 'p4' }));
    await insert('planning_placements', dayPlacement(4, 4, day, { sort_key: 'p4' }));
    await insert('planning_placements', dayPlacement(6, 6, day));
    await insert('planning_placements', dayPlacement(7, 7, day, { archived_at: now }));
    await insert('planning_placements', dayPlacement(8, 8, '2026-09-27'));
    await insert('planning_placements', dayPlacement(9, 9, '2026-09-29'));
    await insert('planning_placements', weekPlacement(10, 10, day, 'monday'));
    await insert('planning_placements', dayPlacement(11, 11, day));
    await insert('planning_placements', {
      ...dayPlacement(12, 12, day),
      owner_id: other,
      action_id: ids.otherAction,
    });

    const rows = await today.listDayActionPlacements(owner, day);
    expect(rows.map((row) => row.id)).toEqual([
      ids.placement(2),
      ids.placement(1),
      ids.placement(3),
      ids.placement(4),
      ids.placement(5),
    ]);
    expect(rows[1]).toEqual({
      id: ids.placement(1),
      localRevision: 1,
      period: { kind: 'day', date: day },
      orderKey: 'p2',
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
          placement: {
            id: ids.placement(1),
            localRevision: 1,
            period: { kind: 'day', date: day },
          },
        },
      },
    });
    expect(
      rows.map((row) => (row.target.kind === 'action' ? row.target.action.state : null)),
    ).toEqual(['in_progress', 'planned', 'completed', 'scheduled', 'canceled']);
    await expect(today.listDayActionPlacements(other, day)).resolves.toMatchObject([
      { id: ids.placement(12) },
    ]);
    await expect(
      today.listDayActionPlacements(owner, '2026-02-30' as CalendarDate),
    ).rejects.toThrow(RangeError);
  });

  it('reads Week placements whose exact-date week contains a date, across a week-start change', async () => {
    const { insert, driver, today } = await fixture();
    for (const [index, state] of [
      [1, 'planned'],
      [2, 'in_progress'],
      [3, 'planned'],
      [4, 'completed'],
      [5, 'planned'],
      [6, 'scheduled'],
      [7, 'planned'],
      [8, 'planned'],
    ] as const) {
      await insert('actions', action(index, state));
    }
    await insert('actions', { ...action(20, 'planned'), id: ids.otherAction, owner_id: other });
    // Planned under a Monday week start.
    await insert('planning_placements', weekPlacement(1, 1, '2026-09-21', 'monday'));
    // The person then starts weeks on Sunday; stored weeks keep their exact dates.
    await driver.run(`UPDATE profiles SET week_start = 'sunday' WHERE id = ?;`, [profile]);
    await insert('planning_placements', weekPlacement(2, 2, '2026-09-27', 'sunday'));
    await insert('planning_placements', weekPlacement(3, 3, '2026-09-27', 'sunday'));
    await insert(
      'time_blocks',
      block(1, '2026-10-05T13:00:00.000Z', '2026-10-05T14:00:00.000Z', {
        action_id: ids.action(3),
      }),
    );
    await insert('planning_placements', weekPlacement(4, 4, '2026-09-27', 'sunday'));
    await insert(
      'planning_placements',
      weekPlacement(5, 5, '2026-09-27', 'sunday', { archived_at: now }),
    );
    await insert('planning_placements', weekPlacement(6, 6, '2026-09-27', 'sunday'));
    await insert(
      'planning_placements',
      weekPlacement(7, 7, '2026-09-27', 'sunday', { sort_key: 'w00' }),
    );
    await insert('planning_placements', dayPlacement(8, 8, '2026-09-27'));
    await insert('planning_placements', {
      ...weekPlacement(9, 20, '2026-09-27', 'sunday'),
      owner_id: other,
      action_id: ids.otherAction,
    });

    const listed = async (date: string, limit = 50) => {
      const page = await today.listWeekActionPlacements(owner, date as CalendarDate, limit);
      return { ids: page.items.map((row) => row.id), total: page.total };
    };
    await expect(listed('2026-09-27')).resolves.toEqual({
      ids: [ids.placement(1), ids.placement(7), ids.placement(2)],
      total: 3,
    });
    await expect(listed('2026-09-28')).resolves.toEqual({
      ids: [ids.placement(7), ids.placement(2)],
      total: 2,
    });
    await expect(listed('2026-09-21')).resolves.toEqual({ ids: [ids.placement(1)], total: 1 });
    await expect(listed('2026-10-03')).resolves.toEqual({
      ids: [ids.placement(7), ids.placement(2)],
      total: 2,
    });
    await expect(listed('2026-09-20')).resolves.toEqual({ ids: [], total: 0 });
    await expect(listed('2026-10-04')).resolves.toEqual({ ids: [], total: 0 });
    await expect(listed('2026-09-27', 1)).resolves.toEqual({
      ids: [ids.placement(1)],
      total: 3,
    });
    await expect(listed('2026-09-27', 0)).resolves.toEqual({ ids: [], total: 3 });

    const page = await today.listWeekActionPlacements(owner, '2026-09-27' as CalendarDate, 50);
    expect(page.items[2]).toMatchObject({
      id: ids.placement(2),
      period: { kind: 'week', start: '2026-09-27', end: '2026-10-03', weekStart: 'sunday' },
      orderKey: 'w02',
      target: {
        kind: 'action',
        action: {
          id: ids.action(2),
          state: 'in_progress',
          placement: {
            id: ids.placement(2),
            period: { kind: 'week', start: '2026-09-27', end: '2026-10-03', weekStart: 'sunday' },
          },
        },
      },
    });
    await expect(
      today.listWeekActionPlacements(other, '2026-09-28' as CalendarDate, 50),
    ).resolves.toMatchObject({ items: [{ id: ids.placement(9) }], total: 1 });
    await expect(
      today.listWeekActionPlacements(owner, '2026-09-28' as CalendarDate, -1),
    ).rejects.toThrow(RangeError);
  });

  it('reads unfinished Week-commitment Actions whose week contains a date', async () => {
    const { insert, today } = await fixture();
    for (const [index, state] of [
      [1, 'inbox'],
      [2, 'scheduled'],
      [3, 'completed'],
      [4, 'archived'],
      [5, 'planned'],
      [7, 'in_progress'],
    ] as const) {
      await insert('actions', action(index, state));
    }
    await insert('actions', { ...action(20, 'planned'), id: ids.otherAction, owner_id: other });
    await insert('projects', {
      id: ids.project,
      owner_id: owner,
      title: 'Garden',
      desired_result: 'Beds planted',
      state: 'active',
      sort_key: 'a',
    });
    await insert('planning_placements', dayPlacement(1, 2, day));
    const actionTarget = (index: number) => ({ action_id: ids.action(index) });
    const sunday = '2026-09-27';
    await insert('week_selections', weekSelection(1, actionTarget(1), '2026-09-21', 'monday', 'a'));
    await insert('week_selections', weekSelection(2, actionTarget(2), sunday, 'sunday', 'b'));
    await insert('week_selections', weekSelection(3, actionTarget(3), sunday, 'sunday', 'c'));
    await insert('week_selections', weekSelection(4, actionTarget(4), sunday, 'sunday', 'd'));
    await insert(
      'week_selections',
      weekSelection(5, actionTarget(5), sunday, 'sunday', 'e', { archived_at: now }),
    );
    await insert(
      'week_selections',
      weekSelection(6, { project_id: ids.project }, sunday, 'sunday', 'f'),
    );
    await insert('week_selections', weekSelection(7, actionTarget(7), sunday, 'sunday', 'a'));
    await insert('week_selections', {
      ...weekSelection(8, { action_id: ids.otherAction }, sunday, 'sunday', 'a'),
      owner_id: other,
      profile_id: otherProfile,
    });

    const page = await today.listWeekCommitmentActions(owner, sunday as CalendarDate, 50);
    expect(page.items.map((item) => item.id)).toEqual([
      ids.action(1),
      ids.action(7),
      ids.action(2),
    ]);
    expect(page.total).toBe(3);
    expect(page.items[2]).toEqual({
      id: ids.action(2),
      title: 'Action 2',
      state: 'scheduled',
      localRevision: 1,
      orderKey: 'a02',
      placement: {
        id: ids.placement(1),
        localRevision: 1,
        period: { kind: 'day', date: day },
      },
    });
    const monday = await today.listWeekCommitmentActions(owner, day, 50);
    expect(monday.items.map((item) => item.id)).toEqual([ids.action(7), ids.action(2)]);
    const first = await today.listWeekCommitmentActions(owner, sunday as CalendarDate, 2);
    expect({ count: first.items.length, total: first.total }).toEqual({ count: 2, total: 3 });
    await expect(
      today.listWeekCommitmentActions(owner, '2026-10-04' as CalendarDate, 50),
    ).resolves.toEqual({ items: [], total: 0 });
    await expect(today.listWeekCommitmentActions(other, day, 50)).resolves.toMatchObject({
      items: [{ id: ids.otherAction }],
      total: 1,
    });
  });
});

async function focusFixture() {
  const context = await fixture();
  const { insert, seeded, driver } = context;
  await insert('actions', action(1, 'planned'));
  await insert('actions', action(2, 'planned'));
  await insert('actions', action(3, 'planned', { deleted_at: now }));
  await insert('actions', { ...action(20, 'planned'), id: ids.otherAction, owner_id: other });
  await insert('planning_placements', dayPlacement(1, 1, day));
  const walk = ids.routine(1);
  const oldHabit = ids.routine(2);
  const strength = ids.routine(3);
  await seeded([
    create('routine', walk, flexibleRoutine('Morning walk')),
    create('routine', oldHabit, flexibleRoutine('Old habit')),
    create('routine', strength, {
      ...flexibleRoutine('Strength'),
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
  ]);
  const walkToday = occurrence(walk, { kind: 'date', date: day });
  const oldToday = occurrence(oldHabit, { kind: 'date', date: day }, { state: 'skipped' });
  const strengthWeek = occurrence(
    strength,
    {
      kind: 'week',
      start: day,
      end: '2026-10-04' as CalendarDate,
      weekStart: 'monday',
      targetCount: 3,
    },
    { completedCount: 1 },
  );
  await seeded(
    [walkToday, oldToday, strengthWeek].map((item) =>
      create('routine_occurrence', item.id, item.document),
    ),
  );
  // A later change bumps the occurrence's own revision (the focus row stays at revision 1).
  await driver.run('UPDATE routine_occurrences SET local_revision = 2 WHERE id = ?;', [
    walkToday.id,
  ]);
  await driver.run(
    `UPDATE routines SET state = 'archived', state_before_archive = 'active', archived_at = ?
     WHERE id = ?;`,
    [now, oldHabit],
  );

  const tomorrow = '2026-09-29';
  await insert('focus_selections', focusRow(1, { action_id: ids.action(1) }, day, 'b'));
  await insert('focus_selections', focusRow(2, { routine_occurrence_id: walkToday.id }, day, 'a'));
  await insert('focus_selections', focusRow(3, { routine_occurrence_id: oldToday.id }, day, 'c'));
  await insert(
    'focus_selections',
    focusRow(4, { action_id: ids.action(2) }, day, 'a', { archived_at: now }),
  );
  await insert('focus_selections', focusRow(5, { action_id: ids.action(2) }, '2026-09-27', 'a'));
  await insert(
    'focus_selections',
    focusRow(6, { routine_occurrence_id: strengthWeek.id }, tomorrow, 'b'),
  );
  await insert('focus_selections', focusRow(7, { action_id: ids.action(3) }, tomorrow, 'a'));
  await insert('focus_selections', {
    ...focusRow(8, { action_id: ids.otherAction }, day, 'a'),
    owner_id: other,
    profile_id: otherProfile,
  });
  return { ...context, walk, oldHabit, strength, walkToday, oldToday, strengthWeek };
}

describe('SqliteTodayQueries focus', () => {
  it('maps focus rows of Actions and Routine Occurrences, including an archived Routine', async () => {
    const { today, walk, oldHabit, strength, walkToday, oldToday, strengthWeek } =
      await focusFixture();
    await expect(today.listDayFocus(owner, profile, day)).resolves.toEqual([
      {
        id: ids.focus(2),
        localRevision: 1,
        orderKey: 'a',
        date: day,
        target: {
          kind: 'routine_occurrence',
          occurrenceId: walkToday.id,
          routineId: walk,
          routineTitle: 'Morning walk',
          routineState: 'active',
          generation: 1,
          period: { kind: 'date', date: day },
          occurrenceRevision: 2,
          state: 'planned',
        },
      },
      {
        id: ids.focus(1),
        localRevision: 1,
        orderKey: 'b',
        date: day,
        target: {
          kind: 'action',
          action: {
            id: ids.action(1),
            title: 'Action 1',
            state: 'planned',
            localRevision: 1,
            orderKey: 'a01',
            placement: {
              id: ids.placement(1),
              localRevision: 1,
              period: { kind: 'day', date: day },
            },
          },
        },
      },
      {
        id: ids.focus(3),
        localRevision: 1,
        orderKey: 'c',
        date: day,
        target: {
          kind: 'routine_occurrence',
          occurrenceId: oldToday.id,
          routineId: oldHabit,
          routineTitle: 'Old habit',
          routineState: 'archived',
          generation: 1,
          period: { kind: 'date', date: day },
          occurrenceRevision: 1,
          state: 'skipped',
        },
      },
    ]);
    // A weekly-count occurrence decodes its week period; a row whose Action was deleted is left out.
    await expect(today.listDayFocus(owner, profile, '2026-09-29' as CalendarDate)).resolves.toEqual(
      [
        {
          id: ids.focus(6),
          localRevision: 1,
          orderKey: 'b',
          date: '2026-09-29',
          target: {
            kind: 'routine_occurrence',
            occurrenceId: strengthWeek.id,
            routineId: strength,
            routineTitle: 'Strength',
            routineState: 'active',
            generation: 1,
            period: {
              kind: 'week',
              start: day,
              end: '2026-10-04',
              weekStart: 'monday',
              targetCount: 3,
            },
            occurrenceRevision: 1,
            state: 'planned',
          },
        },
      ],
    );
    await expect(today.listDayFocus(owner, otherProfile, day)).resolves.toEqual([]);
    await expect(today.listDayFocus(other, otherProfile, day)).resolves.toMatchObject([
      { id: ids.focus(8), target: { kind: 'action', action: { id: ids.otherAction } } },
    ]);
  });

  it('keeps the three-item trigger as a backstop: a fourth active row rolls back', async () => {
    const { commit, driver, today, planning, insert } = await fixture();
    for (let index = 1; index <= 5; index += 1) await insert('actions', action(index, 'planned'));
    const focus = (index: number, date: string) =>
      create('focus_selection', ids.focus(index), {
        kind: 'day_focus',
        profileId: profile,
        target: { kind: 'action', actionId: ids.action(index) },
        periodStart: date,
        periodEnd: date,
        orderKey: String(index * 1_000_000_000).padStart(15, '0'),
      });
    const count = async (table: string) =>
      (await driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table};`))?.n;
    const counts = async () => ({
      focus: await count('focus_selections'),
      events: await count('domain_events'),
      receipts: await count('command_receipts'),
      outbox: await count('sync_outbox'),
    });
    const empty = await counts();
    await expect(commit([1, 2, 3, 4].map((index) => focus(index, day)))).resolves.toEqual({
      ok: false,
      error: { code: 'transaction_failed' },
    });
    expect(await counts()).toEqual(empty);
    await expect(today.listDayFocus(owner, profile, day)).resolves.toEqual([]);

    await expect(commit([1, 2, 3].map((index) => focus(index, day)))).resolves.toMatchObject({
      ok: true,
    });
    const full = await counts();
    await expect(commit([focus(4, day)])).resolves.toEqual({
      ok: false,
      error: { code: 'transaction_failed' },
    });
    expect(await counts()).toEqual(full);
    // The same Action on another day is fine.
    await expect(commit([focus(4, '2026-09-29')])).resolves.toMatchObject({ ok: true });

    // Archiving first and creating after it in one command stays within three.
    const first = await planning.readRecord(
      owner,
      createEntityRef('focus_selection', ids.focus(1), owner),
    );
    if (first === null) throw new Error('Focus row missing.');
    await expect(
      commit([update(first, { ...first.document, archivedAt: now }), focus(5, day)]),
    ).resolves.toMatchObject({ ok: true });
    const rows = await today.listDayFocus(owner, profile, day);
    expect(rows.map((row) => row.id)).toEqual([ids.focus(2), ids.focus(3), ids.focus(5)]);
  });

  it('reads one Action for Focus mode with its note, placement, and planned block', async () => {
    const { insert, today } = await fixture();
    await insert('actions', action(1, 'scheduled', { note_text: 'Bring the outline' }));
    await insert('actions', action(2, 'completed'));
    await insert('actions', action(3, 'planned', { deleted_at: now }));
    await insert('actions', { ...action(20, 'planned'), id: ids.otherAction, owner_id: other });
    await insert('planning_placements', dayPlacement(1, 1, '2026-09-30'));
    const target = (index: number) => ({ action_id: ids.action(index) });
    await insert(
      'time_blocks',
      block(1, '2026-09-24T13:00:00.000Z', '2026-09-24T14:00:00.000Z', target(1), 'skipped'),
    );
    // The current planned block may be on any date.
    await insert(
      'time_blocks',
      block(2, '2026-09-30T13:00:00.000Z', '2026-09-30T14:00:00.000Z', target(1)),
    );
    await insert(
      'time_blocks',
      block(3, '2026-09-28T13:00:00.000Z', '2026-09-28T14:00:00.000Z', target(2), 'completed'),
    );

    await expect(today.getFocusAction(owner, ids.action(1))).resolves.toEqual({
      id: ids.action(1),
      title: 'Action 1',
      state: 'scheduled',
      localRevision: 1,
      orderKey: 'a01',
      note: 'Bring the outline',
      placement: {
        id: ids.placement(1),
        localRevision: 1,
        period: { kind: 'day', date: '2026-09-30' },
      },
      plannedBlock: {
        id: ids.block(2),
        localRevision: 1,
        startsAt: '2026-09-30T13:00:00.000Z',
        endsAt: '2026-09-30T14:00:00.000Z',
        timeZone: zone,
        state: 'planned',
        overlapAcknowledged: false,
        target: {
          kind: 'action',
          actionId: ids.action(1),
          title: 'Action 1',
          actionState: 'scheduled',
          actionRevision: 1,
        },
      },
    });
    await expect(today.getFocusAction(owner, ids.action(2))).resolves.toEqual({
      id: ids.action(2),
      title: 'Action 2',
      state: 'completed',
      localRevision: 1,
      orderKey: 'a02',
    });
    await expect(today.getFocusAction(owner, ids.action(3))).resolves.toBeNull();
    await expect(today.getFocusAction(owner, ids.action(9))).resolves.toBeNull();
    await expect(today.getFocusAction(owner, ids.otherAction)).resolves.toBeNull();
    await expect(today.getFocusAction(other, ids.otherAction)).resolves.toMatchObject({
      id: ids.otherAction,
    });
  });
});

/**
 * Synthetic large plan: 10,000 Actions, about three years of Day placements, 12,000
 * Time Blocks, Week placements and Week commitments, and three focus rows on each of 1,000 days.
 */
const hex = (group: string, index: number) =>
  `${group}-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`;

function largeSeedStatements(): string[] {
  const sortKey = (index: number) => String(500_000_000_000_000 + index).padStart(15, '0');
  const at = (date: string, hour: number, minute = 0) =>
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
  const actions: string[] = [];
  const placements: string[] = [];
  const blocks: string[] = [];
  const selections: string[] = [];
  const focus: string[] = [];
  const actionRow = (index: number, state: string) =>
    `('${hex('83000000', index)}','${owner}','Synthetic Action ${String(index + 1).padStart(5, '0')}','${state}','plan','${sortKey(index)}',${state === 'completed' ? `'${now}'` : 'NULL'},'${now}','${now}')`;
  const placementRow = (index: number, date: string, horizon = 'day') =>
    `('${hex('84000000', index)}','${owner}','${hex('83000000', index)}','${horizon}','${date}','${date}','${horizon === 'week' ? addDays(date as CalendarDate, 6) : date}',${horizon === 'week' ? `'monday'` : 'NULL'},'${sortKey(index)}','${now}','${now}')`;
  const blockRowSql = (
    blockId: string,
    actionId: string | null,
    title: string | null,
    startsAt: string,
    endsAt: string,
    state: string,
  ) =>
    `('${blockId}','${owner}',${actionId === null ? 'NULL' : `'${actionId}'`},${title === null ? 'NULL' : `'${title}'`},'${startsAt}','${endsAt}','${zone}','${state}','${now}','${now}')`;
  for (let index = 0; index < 10_000; index += 1) {
    const actionId = hex('83000000', index);
    if (index < 5_000) {
      // Completed history: five a day for 1,000 days, each with its completed block.
      const date = addDays('2023-10-03' as CalendarDate, Math.floor(index / 5));
      actions.push(actionRow(index, 'completed'));
      placements.push(placementRow(index, date));
      blocks.push(
        blockRowSql(
          hex('85000000', index),
          actionId,
          null,
          at(date, 14),
          at(date, 15),
          'completed',
        ),
      );
    } else if (index < 7_000) {
      // Flexible Day work around today: ten a day for 200 days.
      actions.push(actionRow(index, 'planned'));
      placements.push(
        placementRow(index, addDays('2026-06-20' as CalendarDate, (index - 5_000) % 200)),
      );
    } else if (index < 8_000) {
      // Scheduled Day work: five a day for 200 days, each with its planned block.
      const offset = index - 7_000;
      const date = addDays('2026-06-20' as CalendarDate, offset % 200);
      actions.push(actionRow(index, 'scheduled'));
      placements.push(placementRow(index, date));
      const hour = 13 + (offset % 8);
      blocks.push(
        blockRowSql(
          hex('85000000', index),
          actionId,
          null,
          at(date, hour),
          at(date, hour, 45),
          'planned',
        ),
      );
    } else if (index < 9_000) {
      // Week-placed work across 60 Monday weeks.
      const start = addDays('2025-10-06' as CalendarDate, 7 * ((index - 8_000) % 60));
      actions.push(actionRow(index, 'planned'));
      placements.push(placementRow(index, start, 'week'));
    } else {
      actions.push(actionRow(index, 'inbox'));
    }
  }
  for (let index = 0; index < 6_000; index += 1) {
    const date = addDays('2023-10-03' as CalendarDate, Math.floor(index / 6));
    blocks.push(
      blockRowSql(
        hex('86000000', index),
        null,
        `History ${String(index)}`,
        at(date, 20),
        at(date, 20, 45),
        'completed',
      ),
    );
  }
  for (let week = 0; week < 104; week += 1) {
    const start = addDays('2024-10-07' as CalendarDate, 7 * week);
    for (let slot = 0; slot < 3; slot += 1) {
      const index = week * 3 + slot;
      selections.push(
        `('${hex('87000000', index)}','${owner}','${profile}','${hex('83000000', 9_000 + (index % 1_000))}','${start}','${addDays(start, 6)}','monday','${sortKey(index)}','${now}','${now}')`,
      );
    }
  }
  for (let dayIndex = 0; dayIndex < 1_000; dayIndex += 1) {
    const date = addDays(day, dayIndex - 999);
    for (let slot = 0; slot < 3; slot += 1) {
      const index = dayIndex * 3 + slot;
      focus.push(
        `('${hex('88000000', index)}','${owner}','${profile}','${hex('83000000', index % 5_000)}','${date}','${sortKey(slot)}','${now}','${now}')`,
      );
    }
  }
  const chunks = (values: readonly string[], size = 500): string[][] => {
    const output: string[][] = [];
    for (let index = 0; index < values.length; index += size)
      output.push(values.slice(index, index + size));
    return output;
  };
  return [
    ...chunks(actions).map(
      (rows) => `INSERT INTO actions (id, owner_id, title, state, capture_origin, sort_key,
        completed_at, created_at, updated_at) VALUES ${rows.join(',')};`,
    ),
    ...chunks(placements).map(
      (rows) => `INSERT INTO planning_placements (id, owner_id, action_id, horizon, period_key,
        period_start_date, period_end_date, week_start, sort_key, created_at, updated_at)
        VALUES ${rows.join(',')};`,
    ),
    ...chunks(blocks).map(
      (rows) => `INSERT INTO time_blocks (id, owner_id, action_id, custom_title, starts_at_utc,
        ends_at_utc, time_zone, state, created_at, updated_at) VALUES ${rows.join(',')};`,
    ),
    ...chunks(selections).map(
      (rows) => `INSERT INTO week_selections (id, owner_id, profile_id, action_id,
        period_start_date, period_end_date, week_start, sort_key, created_at, updated_at)
        VALUES ${rows.join(',')};`,
    ),
    ...chunks(focus).map(
      (rows) => `INSERT INTO focus_selections (id, owner_id, profile_id, action_id, local_date,
        sort_key, created_at, updated_at) VALUES ${rows.join(',')};`,
    ),
  ];
}

describe('SqliteTodayQueries at scale', () => {
  it('retains every same-day block and placement beyond the former 1,000-row boundary', async () => {
    const { driver, insert, today, planning } = await fixture();
    for (let index = 1; index <= 1_003; index += 1) {
      await insert('actions', action(index, 'planned'));
      await insert('planning_placements', dayPlacement(index, index, day));
      await insert(
        'time_blocks',
        block(index, '2026-09-28T12:00:00.000Z', '2026-09-28T13:00:00.000Z', {
          custom_title: `Synthetic block ${String(index)}`,
        }),
      );
    }
    await insert(
      'time_blocks',
      block(1_004, '2026-09-10T12:00:00.000Z', '2026-09-29T13:00:00.000Z', {
        custom_title: 'Synthetic imported long interval',
      }),
    );
    const bounds = localDayBounds(day, zone);
    const placements = await today.listDayActionPlacements(owner, day);
    const blocks = await today.listDayBlocks(owner, bounds);
    expect(placements).toHaveLength(1_003);
    expect(new Set(placements.map((row) => row.id)).size).toBe(1_003);
    expect(blocks).toHaveLength(1_004);
    expect(new Set(blocks.map((row) => row.id)).size).toBe(1_004);
    await expect(planning.listPlacements(owner, { start: day, end: day })).resolves.toHaveLength(
      1_003,
    );
    await expect(planning.listBlocks(owner, bounds.startsAt, bounds.endsAt)).resolves.toHaveLength(
      1_004,
    );
    await expect(today.listDayBlocks(other, bounds)).resolves.toEqual([]);
    await driver.close();
  });

  it('uses the stored Week interval instead of assuming its duration is seven days', async () => {
    const { driver, insert, today } = await fixture();
    await insert('actions', action(1, 'planned'));
    await insert('actions', action(2, 'planned'));
    await insert(
      'planning_placements',
      weekPlacement(1, 1, '2026-09-07', 'monday', { period_end_date: '2026-10-04' }),
    );
    await insert(
      'week_selections',
      weekSelection(1, { action_id: ids.action(2) }, '2026-09-07', 'monday', 'a', {
        period_end_date: '2026-10-04',
      }),
    );
    await expect(today.listWeekActionPlacements(owner, day, 50)).resolves.toMatchObject({
      total: 1,
      items: [{ id: ids.placement(1) }],
    });
    await expect(today.listWeekCommitmentActions(owner, day, 50)).resolves.toMatchObject({
      total: 1,
      items: [{ id: ids.action(2) }],
    });
    await expect(
      today.listWeekActionPlacements(owner, '2026-10-05' as CalendarDate, 50),
    ).resolves.toEqual({ total: 0, items: [] });
    await driver.close();
  });

  it(
    'reads a Today day of a large multi-year plan within budget',
    { timeout: 120_000 },
    async () => {
      const { driver, today } = await fixture();
      for (const statement of largeSeedStatements()) await driver.executeScript(statement);
      // Scheduled Action 7,100 is placed and blocked on `day` (offset 100 of its 200 days).
      const scheduledOnDay = hex('83000000', 7_100) as UUID;

      /** Every Today read of one date, in the order Today and its focus choices issue them. */
      const readDay = async (date: CalendarDate) => ({
        profile: await today.getPlanProfile(owner),
        blocks: await today.listDayBlocks(owner, localDayBounds(date, zone)),
        placements: await today.listDayActionPlacements(owner, date),
        routines: await today.listRoutines(owner, { includeArchived: true }),
        occurrences: await today.listMaterializedOccurrences(owner, {
          start: addDays(date, -1),
          end: addDays(date, 1),
        }),
        constraints: await today.listCapacityConstraints(owner),
        focus: await today.listDayFocus(owner, profile, date),
        week: await today.listWeekActionPlacements(owner, date, 50),
        commitments: await today.listWeekCommitmentActions(owner, date, 50),
        focusAction: await today.getFocusAction(owner, scheduledOnDay),
      });
      const timed = async (date: CalendarDate) => {
        const durations: number[] = [];
        let last: Awaited<ReturnType<typeof readDay>> | undefined;
        for (let run = 0; run < 5; run += 1) {
          const started = performance.now();
          last = await readDay(date);
          durations.push(performance.now() - started);
        }
        if (last === undefined) throw new Error('No Today read ran.');
        return { worstMs: Math.max(...durations), result: last };
      };

      const current = await timed(day);
      expect(current.result.blocks).toHaveLength(5);
      expect(current.result.blocks.every((row) => row.state === 'planned')).toBe(true);
      expect(current.result.placements).toHaveLength(15);
      expect(current.result.focus).toHaveLength(3);
      expect(current.result.week.total).toBe(16);
      expect(current.result.commitments.total).toBe(3);
      expect(current.result.focusAction).toMatchObject({
        state: 'scheduled',
        placement: { period: { kind: 'day', date: day } },
        plannedBlock: { state: 'planned' },
      });
      expect(current.worstMs).toBeLessThan(150);

      const history = await timed('2024-03-12' as CalendarDate);
      expect(history.result.blocks).toHaveLength(11);
      expect(history.result.placements).toHaveLength(5);
      expect(history.result.focus).toHaveLength(3);
      expect(history.result.week.total).toBe(0);
      expect(history.worstMs).toBeLessThan(150);

      // With table statistics the plans still search the same named indexes.
      await driver.executeScript('ANALYZE;');
      await expectIndexedPlans(driver, day, scheduledOnDay);
    },
  );
});
