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
  ok,
  type CommandContext,
  type EntityRef,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { reminderDocumentSchema } from './planning-codecs';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

/*
 * The reminder codec after Review: one document targets exactly one Action, Time Block,
 * Routine, or review. Action reminders keep their exact document shape.
 */

const now = '2026-09-30T09:00:00.000Z' as Instant;
const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const profileId = '11000000-0000-4000-8000-000000000001' as UUID;
const actionId = '20000000-0000-4000-8000-000000000001' as UUID;
const blockIds: readonly string[] = [
  '21000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000002',
];
const routineId = '22000000-0000-4000-8000-000000000001' as UUID;
const reviewId = '23000000-0000-4000-8000-000000000001' as UUID;
const temporaryDirectories: string[] = [];

type Document = Readonly<Record<string, unknown>>;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-reminder-codec-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(driver, schemaMigrations, () => now);
  const insert = async (table: string, row: Readonly<Record<string, string>>) => {
    const values = { created_at: now, updated_at: now, ...row };
    const columns = Object.keys(values);
    await driver.run(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')});`,
      Object.values(values),
    );
  };
  await insert('planning_identities', { id: ownerId, identity_kind: 'local' });
  await insert('profiles', {
    id: profileId,
    owner_id: ownerId,
    planning_time_zone: 'Asia/Tashkent',
    week_start: 'monday',
    time_format: '24_hour',
  });
  await insert('actions', {
    id: actionId,
    owner_id: ownerId,
    title: 'Synthetic Action',
    state: 'planned',
    capture_origin: 'plan',
    sort_key: 'a',
  });
  for (const [index, id] of blockIds.entries()) {
    await insert('time_blocks', {
      id,
      owner_id: ownerId,
      custom_title: 'Synthetic block',
      starts_at_utc: `2026-10-0${String(index + 1)}T04:00:00.000Z`,
      ends_at_utc: `2026-10-0${String(index + 1)}T05:00:00.000Z`,
      time_zone: 'Asia/Tashkent',
      state: 'planned',
    });
  }
  await insert('routines', {
    id: routineId,
    owner_id: ownerId,
    title: 'Synthetic routine',
    state: 'active',
    sort_key: 'a',
  });
  await insert('review_checkpoints', {
    id: reviewId,
    owner_id: ownerId,
    profile_id: profileId,
    review_type: 'monthly',
    period_key: '2026-09',
    period_start_date: '2026-09-01',
    period_end_date: '2026-09-30',
    state: 'draft',
  });
  let counter = 1;
  const nextId = () => {
    const suffix = counter.toString(16).padStart(12, '0');
    counter += 1;
    return `90000000-0000-4000-8000-${suffix}` as UUID;
  };
  const adapters = createSqliteApplicationAdapters(driver, { ownerId });
  const dependencies: ApplicationDependencies = {
    ...adapters,
    ids: { next: nextId },
    clock: { now: () => now },
    projections: { notifyCommitted() {} },
  };
  const commit = (mutations: readonly CanonicalMutation[]) =>
    executeCommand(
      dependencies,
      {
        commandId: nextId(),
        ownerId,
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
            eventType: 'reminder.test_changed',
            version: 1 as const,
            actor: context.actor,
            commandId: context.commandId,
            occurredAt: context.now,
            payload: { operation: mutation.operation },
          })),
        }),
    );
  const read = (target: EntityRef) =>
    adapters.unitOfWork.runInTransaction((work) => work.records.read(target));
  const applyDirect = (mutation: CanonicalMutation) =>
    adapters.unitOfWork.runInTransaction((work) => {
      const context: CommandContext = { ownerId, actor: 'user', commandId: nextId(), now };
      return work.records.apply(mutation, context);
    });
  const reminderRef = (): EntityRef<'reminder'> => ({ type: 'reminder', id: nextId(), ownerId });
  return { driver, commit, read, applyDirect, reminderRef };
}

function create(target: EntityRef, document: Document): CanonicalMutation {
  return {
    operation: 'create',
    ref: target,
    expectedRevision: null,
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document,
  };
}

function update(record: CanonicalRecordState, document: Document): CanonicalMutation {
  return {
    operation: 'update',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    document,
  };
}

const relative = {
  kind: 'relative',
  remindAt: '2026-10-01T03:45:00.000Z',
  offsetMinutes: -15,
  timeZone: 'Asia/Tashkent',
} as const;
const at = { kind: 'at', remindAt: '2026-10-01T13:00:00.000Z', timeZone: 'Asia/Tashkent' } as const;

describe('reminder codec', () => {
  it('round-trips a reminder for each target kind and keeps the Action shape', async () => {
    const { commit, read, reminderRef, driver } = await fixture();
    const documents = [
      { actionId, schedule: at, state: 'scheduled' },
      { timeBlockId: blockIds[0], schedule: relative, state: 'scheduled' },
      { routineId, schedule: { ...relative, offsetMinutes: 0 }, state: 'scheduled' },
      { reviewId, schedule: at, state: 'scheduled' },
    ] as const;
    for (const document of documents) {
      const ref = reminderRef();
      expect(await commit([create(ref, document)])).toMatchObject({ ok: true });
      const saved = await read(ref);
      expect(saved).toMatchObject({ localRevision: 1 });
      expect(saved?.document).toEqual(document);
      const canceled = { ...document, state: 'canceled' };
      expect(await commit([update(saved!, canceled)])).toMatchObject({ ok: true });
      expect((await read(ref))?.document).toEqual(canceled);
    }
    // Exactly one target column per row, as the table requires.
    await expect(
      driver.all<object>(
        `SELECT action_id IS NOT NULL AS action, time_block_id IS NOT NULL AS block,
                routine_id IS NOT NULL AS routine, review_id IS NOT NULL AS review
         FROM reminders ORDER BY id;`,
      ),
    ).resolves.toEqual([
      { action: 1, block: 0, routine: 0, review: 0 },
      { action: 0, block: 1, routine: 0, review: 0 },
      { action: 0, block: 0, routine: 1, review: 0 },
      { action: 0, block: 0, routine: 0, review: 1 },
    ]);
  });

  it('moves a Time Block reminder to a superseding block by updating its target', async () => {
    const { commit, read, reminderRef, driver } = await fixture();
    const ref = reminderRef();
    const document = { timeBlockId: blockIds[0], schedule: relative, state: 'scheduled' };
    expect(await commit([create(ref, document)])).toMatchObject({ ok: true });
    const followed = {
      timeBlockId: blockIds[1],
      schedule: { ...relative, remindAt: '2026-10-02T03:45:00.000Z' },
      state: 'scheduled',
    };
    expect(await commit([update((await read(ref))!, followed)])).toMatchObject({ ok: true });
    expect(await read(ref)).toMatchObject({ document: followed, localRevision: 2 });
    await expect(
      driver.get<object>(
        'SELECT action_id, time_block_id, routine_id, review_id FROM reminders WHERE id = ?;',
        [ref.id],
      ),
    ).resolves.toEqual({
      action_id: null,
      time_block_id: blockIds[1],
      routine_id: null,
      review_id: null,
    });
  });

  it('refuses one scheduled reminder too many for a target, writing nothing', async () => {
    const { commit, reminderRef, driver } = await fixture();
    const scheduled = { routineId, schedule: relative, state: 'scheduled' };
    expect(await commit([create(reminderRef(), scheduled)])).toMatchObject({ ok: true });
    expect(await commit([create(reminderRef(), scheduled)])).toEqual({
      ok: false,
      error: { code: 'transaction_failed' },
    });
    expect(
      await commit([create(reminderRef(), { ...scheduled, state: 'canceled' })]),
    ).toMatchObject({ ok: true });
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM reminders;'),
    ).resolves.toEqual({ count: 2 });
  });

  it.each([
    ['no target', { schedule: at, state: 'scheduled' }],
    ['two targets', { actionId, timeBlockId: blockIds[0], schedule: at, state: 'scheduled' }],
    ['an unexpected field', { reviewId, schedule: at, state: 'scheduled', note: 'x' }],
    ['a target that is not an id', { routineId: 'routine-1', schedule: at, state: 'scheduled' }],
    [
      'an offset beyond seven days',
      { routineId, schedule: { ...relative, offsetMinutes: -10_081 } },
    ],
    ['a fractional offset', { routineId, schedule: { ...relative, offsetMinutes: -1.5 } }],
    ['an offset on a fixed time', { reviewId, schedule: { ...at, offsetMinutes: -5 } }],
    ['a malformed instant', { reviewId, schedule: { ...at, remindAt: '2026-10-01 13:00' } }],
    ['an unknown schedule kind', { reviewId, schedule: { ...at, kind: 'every' } }],
    ['an unknown state', { reviewId, schedule: at, state: 'snoozed' }],
  ])('refuses a document with %s', async (_name, document) => {
    const { applyDirect, reminderRef, driver } = await fixture();
    const candidate = 'state' in document ? document : { ...document, state: 'scheduled' as const };
    expect(reminderDocumentSchema.safeParse(candidate).success).toBe(false);
    await expect(applyDirect(create(reminderRef(), candidate))).rejects.toMatchObject({
      code: 'invalid_canonical_document',
    });
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM reminders;'),
    ).resolves.toEqual({ count: 0 });
  });

  it('decodes a stored Action reminder row exactly as before', async () => {
    const { driver, read } = await fixture();
    const id = '24000000-0000-4000-8000-000000000001' as UUID;
    await driver.run(
      `INSERT INTO reminders (id, owner_id, action_id, schedule_kind, remind_at_utc,
         offset_minutes, time_zone, state, created_at, updated_at)
       VALUES (?, ?, ?, 'relative', '2026-10-01T03:45:00.000Z', -15, 'Asia/Tashkent',
         'scheduled', ?, ?);`,
      [id, ownerId, actionId, now, now],
    );
    const record = await read({ type: 'reminder', id, ownerId });
    expect(record?.document).toEqual({ actionId, schedule: relative, state: 'scheduled' });
    expect(Object.keys(record?.document ?? {})).toEqual(['actionId', 'schedule', 'state']);
  });
});
