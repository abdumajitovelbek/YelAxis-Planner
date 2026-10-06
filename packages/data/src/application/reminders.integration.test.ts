import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createActionApplication,
  createPlanningApplication,
  createReviewApplication,
  createSerialQueue,
  type ApplicationDependencies,
  type ApplicationResult,
  type CommandReceipt,
} from '@yelaxis/application';
import type { Instant, OwnerId, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteActionPlanningQueries } from '../queries/action-planning';
import { planningQuerySql, SqlitePlanningQueries } from '../queries/planning-queries';
import { reviewQuerySql, SqliteReviewQueries } from '../queries/review-queries';
import type { SqliteParameter } from '../sqlite/driver';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

/**
 * Cross-layer Review evidence for reminder definitions: the composed planning and
 * Review facades over real SQLite (migration 12, the reminder codec, and the target reads), with a
 * restart. Nothing here schedules or delivers a notification.
 */
const ownerId = '10000000-0000-4000-8000-000000000091' as OwnerId;
const otherOwnerId = '10000000-0000-4000-8000-000000000092' as OwnerId;
const profileId = '11000000-0000-4000-8000-000000000091';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-reminders-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'plan.sqlite');
  // Wednesday 30 September 2026, 09:00 in Tashkent (UTC+5).
  const now = '2026-09-30T04:00:00.000Z' as Instant;
  let counter = 1;
  const ids = {
    next() {
      const suffix = counter.toString(16).padStart(12, '0');
      counter += 1;
      return `97000000-0000-4000-8000-${suffix}` as UUID;
    },
  };
  const first = new NodeSqliteDriver(path);
  await runMigrations(first, schemaMigrations, () => now);
  for (const [owner, profile] of [
    [ownerId, profileId],
    [otherOwnerId, '11000000-0000-4000-8000-000000000092'],
  ] as const) {
    await first.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
       VALUES (?, 'local', ?, ?);`,
      [owner, now, now],
    );
    await first.run(
      `INSERT INTO profiles (
         id, owner_id, planning_time_zone, week_start, time_format, locale_override,
         onboarding_status, onboarding_step, created_at, updated_at
       ) VALUES (?, ?, 'Asia/Tashkent', 'monday', '24_hour', 'en',
                 'completed', 'handbook', ?, ?);`,
      [profile, owner, now, now],
    );
  }
  const open = (driver: NodeSqliteDriver) => {
    const adapters = createSqliteApplicationAdapters(driver, { ownerId });
    const dependencies: ApplicationDependencies = {
      ...adapters,
      ids,
      clock: { now: () => now },
      projections: { notifyCommitted() {} },
    };
    const queue = createSerialQueue();
    return {
      driver,
      planningQueries: new SqlitePlanningQueries(driver),
      reviewQueries: new SqliteReviewQueries(driver),
      planning: createPlanningApplication(dependencies, new SqlitePlanningQueries(driver), {
        queue,
      }),
      reviews: createReviewApplication(dependencies, new SqliteReviewQueries(driver), { queue }),
      actions: createActionApplication(dependencies, new SqliteActionPlanningQueries(driver), {
        queue,
      }),
    };
  };
  let current = open(first);
  return {
    get: () => current,
    /** Close and reopen the database file, as a browser restart would. */
    async restart() {
      await current.driver.close();
      const reopened = new NodeSqliteDriver(path);
      await runMigrations(reopened, schemaMigrations, () => now);
      current = open(reopened);
      return current;
    },
  };
}

function accepted(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

const createdId = (receipt: CommandReceipt, type: string): UUID => {
  const ref = receipt.canonical.find((item) => item.ref.type === type)?.ref;
  if (ref === undefined) throw new Error(`No ${type} in the receipt.`);
  return ref.id;
};

type Row = Readonly<Record<string, unknown>>;

const reminderRows = (driver: NodeSqliteDriver) =>
  driver.all<Row>(
    `SELECT id, action_id, time_block_id, routine_id, review_id, schedule_kind, remind_at_utc,
            offset_minutes, time_zone, state, local_revision
     FROM reminders ORDER BY id;`,
  );

async function explain(driver: NodeSqliteDriver, sql: string, parameters: SqliteParameter[]) {
  const rows = await driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters);
  return rows.map(({ detail }) => detail).join('\n');
}

describe('reminder definitions over SQLite', () => {
  it('sets, moves, undoes, and turns off a Time Block reminder, across a restart', async () => {
    const context = await fixture();
    const { planning, driver } = context.get();
    const added = accepted(
      await planning.createCustomBlock({
        title: 'Deep work',
        date: '2026-10-01',
        startTime: '10:00',
        durationMinutes: 60,
        overlapAcknowledged: false,
      }),
    );
    const blockId = createdId(added, 'time_block');
    const set = accepted(
      await planning.setTimeBlockReminder({
        blockId,
        revision: 1,
        reminder: { kind: 'relative', minutesBefore: 15 },
      }),
    );
    const reminderId = createdId(set, 'reminder');
    await expect(reminderRows(driver)).resolves.toEqual([
      {
        id: reminderId,
        action_id: null,
        time_block_id: blockId,
        routine_id: null,
        review_id: null,
        schedule_kind: 'relative',
        remind_at_utc: '2026-10-01T04:45:00.000Z',
        offset_minutes: -15,
        time_zone: 'Asia/Tashkent',
        state: 'scheduled',
        local_revision: 1,
      },
    ]);

    const moved = accepted(
      await planning.moveBlock({
        blockId,
        revision: 1,
        date: '2026-10-02',
        startTime: '14:00',
        durationMinutes: 60,
        overlapAcknowledged: false,
      }),
    );
    const replacement = moved.canonical.find(
      (item) => item.ref.type === 'time_block' && item.ref.id !== blockId,
    )?.ref.id;
    await expect(reminderRows(driver)).resolves.toMatchObject([
      {
        id: reminderId,
        time_block_id: replacement,
        remind_at_utc: '2026-10-02T08:45:00.000Z',
        offset_minutes: -15,
        state: 'scheduled',
        local_revision: 2,
      },
    ]);
    if (!moved.undo.available) throw new Error('No undo.');
    accepted(await planning.undo(moved.undo.undoId));
    await expect(reminderRows(driver)).resolves.toMatchObject([
      { id: reminderId, time_block_id: blockId, remind_at_utc: '2026-10-01T04:45:00.000Z' },
    ]);

    const reopened = await context.restart();
    await expect(reopened.planning.getTimeBlockReminder(blockId)).resolves.toMatchObject({
      reminderId,
      kind: 'relative',
      minutesBefore: 15,
      date: '2026-10-01',
      time: '09:45',
    });
    const revision = (await reopened.planning.getTimeBlockReminder(blockId))?.localRevision ?? 0;
    accepted(
      await reopened.planning.turnOffTimeBlockReminder({ blockId, reminderRevision: revision }),
    );
    await expect(reopened.planning.getTimeBlockReminder(blockId)).resolves.toBeNull();
    // Setting it again schedules the same row: the unique index never sees a second one. The
    // block is at revision 3 after the move and its undo.
    const block = await reopened.driver.get<{ local_revision: number }>(
      'SELECT local_revision FROM time_blocks WHERE id = ?;',
      [blockId],
    );
    expect(block).toEqual({ local_revision: 3 });
    accepted(
      await reopened.planning.setTimeBlockReminder({
        blockId,
        revision: 3,
        reminder: { kind: 'at', date: '2026-10-01', time: '08:00' },
      }),
    );
    await expect(reminderRows(reopened.driver)).resolves.toMatchObject([
      {
        id: reminderId,
        schedule_kind: 'at',
        remind_at_utc: '2026-10-01T03:00:00.000Z',
        offset_minutes: null,
        state: 'scheduled',
      },
    ]);
  });

  it('removes the reminder of a scheduled Action’s block when the Action is permanently deleted', async () => {
    // The delete says it removes the Action's reminders; its retained "Deleted Action" block keeps
    // no reminder either.
    const context = await fixture();
    const { planning, actions, driver } = context.get();
    accepted(await actions.capture(actions.newCaptureIntent('inbox'), { title: 'Private errand' }));
    const draft = (await actions.listInbox({ limit: 10 })).items[0];
    if (draft === undefined) throw new Error('No Action.');
    const scheduled = accepted(
      await planning.scheduleAction({
        actionId: draft.id,
        revision: draft.localRevision,
        date: '2026-10-01',
        startTime: '10:00',
        durationMinutes: 30,
        overlapAcknowledged: false,
      }),
    );
    const blockId = createdId(scheduled, 'time_block');
    accepted(
      await planning.setTimeBlockReminder({
        blockId,
        revision: 1,
        reminder: { kind: 'relative', minutesBefore: 10 },
      }),
    );
    await expect(reminderRows(driver)).resolves.toHaveLength(1);
    const workspace = await actions.getAction(draft.id);
    accepted(
      await actions.deletePermanently(
        draft.id,
        workspace?.action.localRevision ?? 0,
        'Private errand',
      ),
    );
    await expect(reminderRows(driver)).resolves.toEqual([]);
    await expect(
      driver.get<Row>('SELECT custom_title, state FROM time_blocks WHERE id = ?;', [blockId]),
    ).resolves.toEqual({ custom_title: 'Deleted Action', state: 'canceled' });
  });

  it('creates a Routine with its reminder, and its archive turns the reminder off', async () => {
    const context = await fixture();
    const { planning, driver } = context.get();
    const created = accepted(
      await planning.createRoutine({
        title: 'Morning run',
        rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-10-01' },
        schedulingMode: {
          kind: 'time_specific',
          wallTime: '07:00',
          durationMinutes: 30,
          zonePolicy: { kind: 'follow_profile' },
          gapPolicy: 'shift_forward',
          overlapPolicy: 'earlier_offset',
        },
        reminder: { minutesBefore: 20 },
      }),
    );
    const routineId = createdId(created, 'routine');
    await expect(reminderRows(driver)).resolves.toMatchObject([
      {
        routine_id: routineId,
        schedule_kind: 'relative',
        remind_at_utc: '2026-10-01T01:40:00.000Z',
        offset_minutes: -20,
        state: 'scheduled',
      },
    ]);
    await expect(planning.getRoutine(routineId)).resolves.toMatchObject({
      reminder: { kind: 'relative', minutesBefore: 20, date: '2026-10-01', time: '06:40' },
    });
    const archived = accepted(await planning.archiveRoutine({ routineId, revision: 1 }));
    expect(archived.canonical.map(({ ref }) => ref.type)).toEqual(['routine', 'reminder']);
    accepted(await planning.restoreRoutine({ routineId, revision: 2 }));
    await expect(reminderRows(driver)).resolves.toMatchObject([
      { routine_id: routineId, state: 'canceled' },
    ]);
    await expect(planning.getRoutine(routineId)).resolves.not.toHaveProperty('reminder');
    await expect(
      driver.all<Row>(
        `SELECT event_type, payload_json FROM domain_events
         WHERE entity_type = 'reminder' ORDER BY occurred_at, sequence;`,
      ),
    ).resolves.toEqual([
      { event_type: 'reminder.set', payload_json: '{"operation":"create"}' },
      { event_type: 'reminder.canceled', payload_json: '{"operation":"update"}' },
    ]);
  });

  it('keeps a saved review reminder through Finish until the person turns it off', async () => {
    const context = await fixture();
    const { reviews, driver } = context.get();
    accepted(
      await reviews.saveReview({
        type: 'monthly',
        periodKey: '2026-09',
        outcomes: [],
        milestones: [],
        projects: [],
        notes: 'A calm month',
      }),
    );
    const reviewId = (await reviews.getReview('monthly', '2026-09'))?.saved?.reviewId;
    if (reviewId === undefined) throw new Error('No saved review.');
    accepted(
      await reviews.setReviewReminder({
        reviewId,
        revision: 1,
        reminder: { date: '2026-10-01', time: '19:00' },
      }),
    );
    accepted(
      await reviews.finishReview({
        type: 'monthly',
        periodKey: '2026-09',
        revision: 1,
        outcomes: [],
        milestones: [],
        projects: [],
        notes: 'A calm month',
      }),
    );
    const view = await reviews.getReview('monthly', '2026-09');
    expect(view?.saved).toMatchObject({
      state: 'completed',
      reminder: { kind: 'at', date: '2026-10-01', time: '19:00', localRevision: 1 },
    });
    accepted(await reviews.turnOffReviewReminder({ reviewId, reminderRevision: 1 }));
    await expect(reminderRows(driver)).resolves.toMatchObject([
      {
        review_id: reviewId,
        schedule_kind: 'at',
        remind_at_utc: '2026-10-01T14:00:00.000Z',
        state: 'canceled',
      },
    ]);
  });

  it('reads one target reminder through its named index, scheduled first and owner-scoped', async () => {
    const context = await fixture();
    const { driver, planningQueries, reviewQueries } = context.get();
    const target = '96000000-0000-4000-8000-000000000001';
    for (const [sql, index] of [
      [planningQuerySql.timeBlockReminder, 'idx_reminders_time_block'],
      [planningQuerySql.routineReminder, 'idx_reminders_routine'],
      [reviewQuerySql.reviewReminder, 'idx_reminders_review'],
    ] as const) {
      const detail = await explain(driver, sql, [ownerId, target]);
      expect(detail).toContain(`SEARCH reminders USING INDEX ${index} (owner_id=? AND`);
      expect(detail).not.toMatch(/\bSCAN\b/u);
    }

    await driver.run(
      `INSERT INTO routines (id, owner_id, title, state, sort_key, created_at, updated_at)
       VALUES (?, ?, 'Synthetic routine', 'active', 'a', ?, ?);`,
      [target, ownerId, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    const insert = (id: string, state: string, updatedAt: string) =>
      driver.run(
        `INSERT INTO reminders (id, owner_id, routine_id, schedule_kind, remind_at_utc,
           offset_minutes, time_zone, state, created_at, updated_at)
         VALUES (?, ?, ?, 'relative', '2026-10-01T01:45:00.000Z', -15, 'Asia/Tashkent', ?, ?, ?);`,
        [id, ownerId, target, state, updatedAt, updatedAt],
      );
    await insert('95000000-0000-4000-8000-000000000001', 'canceled', '2026-09-02T00:00:00.000Z');
    await insert('95000000-0000-4000-8000-000000000002', 'canceled', '2026-09-03T00:00:00.000Z');
    await expect(
      planningQueries.getTargetReminder(ownerId, { kind: 'routine', id: target as UUID }),
    ).resolves.toMatchObject({ ref: { id: '95000000-0000-4000-8000-000000000002' } });
    await insert('95000000-0000-4000-8000-000000000003', 'scheduled', '2026-09-01T00:00:00.000Z');
    await expect(
      planningQueries.getTargetReminder(ownerId, { kind: 'routine', id: target as UUID }),
    ).resolves.toMatchObject({
      ref: { type: 'reminder', id: '95000000-0000-4000-8000-000000000003', ownerId },
      localRevision: 1,
      document: { routineId: target, state: 'scheduled' },
    });
    await expect(
      planningQueries.getTargetReminder(otherOwnerId, { kind: 'routine', id: target as UUID }),
    ).resolves.toBeNull();
    await expect(
      planningQueries.getTargetReminder(ownerId, { kind: 'time_block', id: target as UUID }),
    ).resolves.toBeNull();
    await expect(reviewQueries.getReviewReminder(ownerId, target as UUID)).resolves.toBeNull();
  });
});
