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
  createDeletionTombstone,
  ok,
  type CommandContext,
  type EntityRef,
  type EntityType,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

/*
 * review records through the real SQLite record repository and command pipeline: every
 * review type, every review item target kind, version-1 details, cleared targets, archive, the
 * resurrection guard, and refusal of malformed documents and persisted rows. Synthetic fixtures.
 */
const now = '2026-09-30T09:00:00.000Z' as Instant;
const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const otherOwnerId = '10000000-0000-4000-8000-000000000002' as OwnerId;
const profileId = '11000000-0000-4000-8000-000000000001' as UUID;
const temporaryDirectories: string[] = [];

const ids = {
  axis: '12000000-0000-4000-8000-000000000001' as UUID,
  outcome: '13000000-0000-4000-8000-000000000001' as UUID,
  project: '14000000-0000-4000-8000-000000000001' as UUID,
  milestone: '15000000-0000-4000-8000-000000000001' as UUID,
  action: '16000000-0000-4000-8000-000000000001' as UUID,
  routine: '17000000-0000-4000-8000-000000000001' as UUID,
  commitment: '18000000-0000-4000-8000-000000000001' as UUID,
};

type Document = Readonly<Record<string, unknown>>;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-review-codecs-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(driver, schemaMigrations, () => now);
  const insert = async (table: string, row: Record<string, string | number | null>) => {
    const values = { created_at: now, updated_at: now, ...row };
    const columns = Object.keys(values);
    await driver.run(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')});`,
      Object.values(values),
    );
  };
  for (const [owner, profile] of [
    [ownerId, profileId],
    [otherOwnerId, '11000000-0000-4000-8000-000000000002'],
  ] as const) {
    await insert('planning_identities', { id: owner, identity_kind: 'local' });
    await insert('profiles', {
      id: profile,
      owner_id: owner,
      planning_time_zone: 'Asia/Tashkent',
      week_start: 'monday',
      time_format: '24_hour',
    });
  }
  await insert('axes', {
    id: ids.axis,
    owner_id: ownerId,
    title: 'Health',
    state: 'active',
    sort_key: 'a',
  });
  await insert('outcomes', {
    id: ids.outcome,
    owner_id: ownerId,
    axis_id: ids.axis,
    title: 'Run a 10k',
    success_definition: 'Finish the race',
    state: 'active',
    progress_mode: 'none',
    sort_key: 'a',
  });
  await insert('projects', {
    id: ids.project,
    owner_id: ownerId,
    axis_id: ids.axis,
    title: 'Training plan',
    desired_result: 'Three runs a week',
    state: 'active',
    sort_key: 'a',
  });
  await insert('milestones', {
    id: ids.milestone,
    owner_id: ownerId,
    outcome_id: ids.outcome,
    title: 'First 5k',
    measurable_checkpoint: 'Run 5k',
    state: 'active',
    sort_key: 'a',
  });
  await insert('actions', {
    id: ids.action,
    owner_id: ownerId,
    project_id: ids.project,
    title: 'Write the plan',
    state: 'planned',
    capture_origin: 'plan',
    sort_key: 'a',
  });
  await insert('routines', {
    id: ids.routine,
    owner_id: ownerId,
    title: 'Morning walk',
    state: 'active',
    sort_key: 'a',
  });
  await insert('commitments', {
    id: ids.commitment,
    owner_id: ownerId,
    title: 'Dentist',
    strength: 'hard',
    state: 'planned',
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
  const ref = <Type extends EntityType>(type: Type, id: UUID = nextId()): EntityRef<Type> => ({
    type,
    id,
    ownerId,
  });
  /** Commit mutations through the real command pipeline with one minimized event per record. */
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
            eventType: 'review.test_changed',
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
  /** Apply one mutation directly through the codec registry to observe the adapter error. */
  const applyDirect = (mutation: CanonicalMutation) =>
    adapters.unitOfWork.runInTransaction((work) => {
      const context: CommandContext = { ownerId, actor: 'user', commandId: nextId(), now };
      return work.records.apply(mutation, context);
    });
  const row = (table: string, id: UUID) =>
    driver.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?;`, [id]);
  return { driver, ref, commit, read, applyDirect, row };
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

function without(document: Document, key: string): Document {
  return Object.fromEntries(Object.entries(document).filter(([name]) => name !== key));
}

const daily: Document = {
  profileId,
  reviewType: 'daily',
  periodKey: '2026-09-28',
  periodStart: '2026-09-28',
  periodEnd: '2026-09-28',
  notes: 'A steady day',
  energy: 'medium',
  state: 'draft',
};
/** 2026-09-21 is a Monday. */
const weekly: Document = {
  profileId,
  reviewType: 'weekly',
  periodKey: '2026-09-21',
  periodStart: '2026-09-21',
  periodEnd: '2026-09-27',
  weekStart: 'monday',
  state: 'completed',
  completedAt: now,
};
/** A week kept from before a first-weekday change: it starts on its own Sunday. */
const sundayWeek: Document = {
  profileId,
  reviewType: 'weekly',
  periodKey: '2026-09-13',
  periodStart: '2026-09-13',
  periodEnd: '2026-09-19',
  weekStart: 'sunday',
  state: 'draft',
};
const monthly: Document = {
  profileId,
  reviewType: 'monthly',
  periodKey: '2026-08',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  themeText: 'Fewer, better things',
  state: 'skipped',
};
const yearly: Document = {
  profileId,
  reviewType: 'yearly',
  periodKey: '2025',
  periodStart: '2025-01-01',
  periodEnd: '2025-12-31',
  notes: 'r'.repeat(10_000),
  directionChoice: 'new',
  directionText: 'Build calmly',
  state: 'draft',
};

describe('review codec', () => {
  it('round-trips every review type, updates, and archives through the repository', async () => {
    const { ref, commit, read, row } = await fixture();
    const refs = [daily, weekly, sundayWeek, monthly, yearly].map(() => ref('review'));
    const documents = [daily, weekly, sundayWeek, monthly, yearly];
    expect(
      await commit(documents.map((document, index) => create(refs[index]!, document))),
    ).toMatchObject({ ok: true });
    for (const [index, document] of documents.entries()) {
      await expect(read(refs[index]!)).resolves.toMatchObject({ localRevision: 1, document });
      expect((await read(refs[index]!))?.document).toEqual(document);
    }
    await expect(row('review_checkpoints', refs[4]!.id)).resolves.toMatchObject({
      review_type: 'yearly',
      period_key: '2025',
      direction_choice: 'new',
      direction_text: 'Build calmly',
      theme_text: null,
      energy: null,
      archived_at: null,
    });
    await expect(row('review_checkpoints', refs[3]!.id)).resolves.toMatchObject({
      theme_text: 'Fewer, better things',
      direction_choice: null,
    });

    const saved = await read(refs[0]!);
    const skipped = { ...without(daily, 'energy'), notes: 'Changed my mind', state: 'skipped' };
    expect(await commit([update(saved!, skipped)])).toMatchObject({ ok: true });
    await expect(read(refs[0]!)).resolves.toMatchObject({ localRevision: 2, document: skipped });

    const archived = {
      ...skipped,
      state: 'archived',
      stateBeforeArchive: 'skipped',
      archivedAt: now,
    };
    expect(await commit([update((await read(refs[0]!))!, archived)])).toMatchObject({ ok: true });
    expect((await read(refs[0]!))?.document).toEqual(archived);
    await expect(row('review_checkpoints', refs[0]!.id)).resolves.toMatchObject({
      state: 'archived',
      state_before_archive: 'skipped',
      archived_at: now,
      local_revision: 3,
    });

    // A completed review archived by Undo keeps its completion time.
    const undone = {
      ...weekly,
      state: 'archived',
      stateBeforeArchive: 'completed',
      archivedAt: now,
    };
    expect(await commit([update((await read(refs[1]!))!, undone)])).toMatchObject({ ok: true });
    expect((await read(refs[1]!))?.document).toEqual(undone);

    // Once archived, the same period can be reviewed again (one non-archived row per period).
    const again = ref('review');
    expect(await commit([create(again, daily)])).toMatchObject({ ok: true });
    await expect(commit([create(ref('review'), daily)])).resolves.toMatchObject({ ok: false });
  });

  it('round-trips the lists a review cleared as a sorted JSON array', async () => {
    const { driver, ref, commit, read, row } = await fixture();
    const cases: readonly [Document, string][] = [
      [{ ...daily, clearedLists: ['next_focus'] }, '["next_focus"]'],
      [
        { ...weekly, clearedLists: ['commitments', 'first_day_focus'] },
        '["commitments","first_day_focus"]',
      ],
      [{ ...sundayWeek, clearedLists: ['first_day_focus'] }, '["first_day_focus"]'],
    ];
    const refs = cases.map(() => ref('review'));
    expect(
      await commit(cases.map(([document], index) => create(refs[index]!, document))),
    ).toMatchObject({ ok: true });
    for (const [index, [document, json]] of cases.entries()) {
      expect((await read(refs[index]!))?.document).toEqual(document);
      await expect(row('review_checkpoints', refs[index]!.id)).resolves.toMatchObject({
        cleared_lists_json: json,
      });
    }

    // Saving the list again (or leaving it to the plan) drops the key and stores NULL.
    const kept = without(cases[1]![0], 'clearedLists');
    expect(await commit([update((await read(refs[1]!))!, kept)])).toMatchObject({ ok: true });
    expect((await read(refs[1]!))?.document).toEqual(kept);
    await expect(row('review_checkpoints', refs[1]!.id)).resolves.toMatchObject({
      cleared_lists_json: null,
    });

    // Archive (Undo of the first save) keeps the cleared lists, and so does a skipped review.
    const archived = {
      ...cases[0]![0],
      state: 'archived',
      stateBeforeArchive: 'draft',
      archivedAt: now,
    };
    expect(await commit([update((await read(refs[0]!))!, archived)])).toMatchObject({ ok: true });
    expect((await read(refs[0]!))?.document).toEqual(archived);

    // Rows written by an earlier version read as clearing nothing.
    await driver.run('UPDATE review_checkpoints SET cleared_lists_json = NULL WHERE id = ?;', [
      refs[2]!.id,
    ]);
    expect((await read(refs[2]!))?.document).toEqual(sundayWeek);
  });

  it('refuses persisted cleared lists that are empty, unknown, unsorted, or not the type’s', async () => {
    const { driver, ref, commit, read } = await fixture();
    const week = ref('review');
    const day = ref('review');
    expect(
      await commit([
        create(week, { ...weekly, clearedLists: ['commitments'] }),
        create(day, daily),
      ]),
    ).toMatchObject({ ok: true });
    const corrupt = async (target: EntityRef, json: string) => {
      await driver.run('UPDATE review_checkpoints SET cleared_lists_json = ? WHERE id = ?;', [
        json,
        target.id,
      ]);
      await expect(read(target), json).rejects.toMatchObject({
        code: 'invalid_persisted_record',
      });
    };
    await corrupt(week, '[]');
    await corrupt(week, '["next_focus"]');
    await corrupt(week, '["first_day_focus","commitments"]');
    await corrupt(week, '["commitments","commitments"]');
    await corrupt(week, '["focus"]');
    await corrupt(week, '"commitments"');
    await corrupt(week, '{"v":1,"lists":["commitments"]}');
    await corrupt(week, '[1]');
    await corrupt(day, '["commitments"]');
    await corrupt(day, '["first_day_focus"]');
    // SQL refuses text that is not JSON at all.
    await expect(
      driver.run('UPDATE review_checkpoints SET cleared_lists_json = ? WHERE id = ?;', [
        '["commitments"',
        week.id,
      ]),
    ).rejects.toThrow();
  });

  it('refuses review documents that break type, period, text, or state rules', async () => {
    const { ref, applyDirect } = await fixture();
    const invalid: readonly Document[] = [
      { ...daily, clearedLists: [] },
      { ...daily, clearedLists: ['commitments'] },
      { ...daily, clearedLists: ['next_focus', 'next_focus'] },
      { ...weekly, clearedLists: ['next_focus'] },
      { ...weekly, clearedLists: ['first_day_focus', 'commitments'] },
      { ...weekly, clearedLists: ['commitments', 'commitments'] },
      { ...weekly, clearedLists: ['focus'] },
      { ...weekly, clearedLists: 'commitments' },
      { ...monthly, clearedLists: ['commitments'] },
      { ...yearly, clearedLists: ['first_day_focus'] },
      { ...weekly, energy: 'low' },
      { ...daily, energy: 'tired' },
      { ...daily, themeText: 'Theme' },
      { ...monthly, directionChoice: 'continue' },
      { ...yearly, directionChoice: 'continue' },
      without(yearly, 'directionText'),
      { ...yearly, directionChoice: 'outdated' },
      { ...yearly, directionText: 'd'.repeat(2_001) },
      { ...daily, notes: 'n'.repeat(10_001) },
      { ...daily, notes: '   ' },
      { ...monthly, themeText: 't'.repeat(2_001) },
      { ...monthly, themeText: '' },
      { ...daily, weekStart: 'monday' },
      without(weekly, 'weekStart'),
      { ...weekly, weekStart: 'sunday' },
      { ...weekly, periodEnd: '2026-09-28' },
      { ...daily, periodEnd: '2026-09-29' },
      { ...monthly, periodKey: '2026-13' },
      { ...monthly, periodKey: '2026-09' },
      { ...yearly, periodKey: '25' },
      { ...daily, reviewType: 'quarterly' },
      without(weekly, 'completedAt'),
      { ...daily, completedAt: now },
      { ...daily, state: 'archived', archivedAt: now },
      { ...daily, stateBeforeArchive: 'draft' },
      { ...daily, grade: 'A' },
      { ...daily, profileId: 'not-a-uuid' },
    ];
    for (const document of invalid) {
      await expect(
        applyDirect(create(ref('review'), document)),
        JSON.stringify(document),
      ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    }
  });
});

describe('review item codec', () => {
  async function withReview() {
    const context = await fixture();
    const review = context.ref('review');
    expect(await context.commit([create(review, weekly)])).toMatchObject({ ok: true });
    const item = (document: Document): Document => ({
      reviewId: review.id,
      orderKey: 'a0',
      ...document,
    });
    return { ...context, review, item };
  }

  const occurrenceDate = {
    kind: 'routine_occurrence',
    routineId: ids.routine,
    generation: 1,
    period: { kind: 'date', date: '2026-09-29' },
  };
  const occurrenceWeek = {
    kind: 'routine_occurrence',
    routineId: ids.routine,
    generation: 2,
    period: {
      kind: 'week',
      start: '2026-09-28',
      end: '2026-10-04',
      weekStart: 'monday',
      targetCount: 3,
    },
  };

  it('round-trips every target kind with version-1 details and exact columns', async () => {
    const { ref, commit, read, row, item } = await withReview();
    const cases: readonly [Document, Record<string, unknown>][] = [
      [
        item({
          target: { kind: 'axis', axisId: ids.axis },
          decision: 'note',
          note: 'Morning walks',
        }),
        {
          target_kind: 'axis',
          axis_id: ids.axis,
          decision_note: 'Morning walks',
          detail_json: null,
        },
      ],
      [
        item({ target: { kind: 'outcome', outcomeId: ids.outcome }, decision: 'pause' }),
        { target_kind: 'outcome', outcome_id: ids.outcome, detail_json: null },
      ],
      [
        item({ target: { kind: 'milestone', milestoneId: ids.milestone }, decision: 'commit' }),
        { target_kind: 'milestone', milestone_id: ids.milestone },
      ],
      [
        item({ target: { kind: 'project', projectId: ids.project }, decision: 'continue' }),
        { target_kind: 'project', project_id: ids.project },
      ],
      [
        item({
          target: { kind: 'action', actionId: ids.action },
          decision: 'move',
          period: { kind: 'week', date: '2026-10-01' },
        }),
        {
          target_kind: 'action',
          action_id: ids.action,
          detail_json: '{"v":1,"period":{"kind":"week","date":"2026-10-01"}}',
        },
      ],
      [
        item({ target: occurrenceDate, decision: 'focus', orderKey: 'b0' }),
        {
          target_kind: 'routine_occurrence',
          routine_id: ids.routine,
          detail_json:
            '{"v":1,"occurrence":{"generation":1,"period":{"kind":"date","date":"2026-09-29"}}}',
        },
      ],
      [
        // Both detail keys share one object; keys are stored in canonical order.
        item({
          target: {
            ...occurrenceWeek,
            period: {
              targetCount: 3,
              weekStart: 'monday',
              end: '2026-10-04',
              start: '2026-09-28',
              kind: 'week',
            },
          },
          decision: 'move',
          period: { date: '2026-10-02', kind: 'day' },
        }),
        {
          target_kind: 'routine_occurrence',
          detail_json:
            '{"v":1,"occurrence":{"generation":2,"period":{"kind":"week","start":"2026-09-28",' +
            '"end":"2026-10-04","weekStart":"monday","targetCount":3}},' +
            '"period":{"kind":"day","date":"2026-10-02"}}',
        },
      ],
      [
        item({ target: { kind: 'routine', routineId: ids.routine }, decision: 'focus' }),
        { target_kind: 'routine', routine_id: ids.routine, detail_json: null },
      ],
      [
        item({
          target: { kind: 'commitment', commitmentId: ids.commitment },
          decision: 'cancel',
        }),
        { target_kind: 'commitment', commitment_id: ids.commitment },
      ],
      [
        item({
          target: { kind: 'deleted', deletedKind: 'action', deletedAt: now },
          decision: 'move',
          period: { kind: 'month', date: '2026-10-15' },
        }),
        {
          target_kind: 'action',
          action_id: null,
          target_deleted_at: now,
          detail_json: '{"v":1,"period":{"kind":"month","date":"2026-10-15"}}',
        },
      ],
    ];
    const refs = cases.map(() => ref('review_item'));
    expect(
      await commit(cases.map(([document], index) => create(refs[index]!, document))),
    ).toMatchObject({ ok: true });
    for (const [index, [document, columns]] of cases.entries()) {
      const saved = await read(refs[index]!);
      expect(saved?.localRevision).toBe(1);
      // Documents compare by value, whatever key order they were written in.
      expect(saved?.document).toEqual(document);
      await expect(row('review_items', refs[index]!.id)).resolves.toMatchObject(columns);
    }
  });

  it('updates, archives, and clears targets while keeping the decision', async () => {
    const { driver, ref, commit, read, row, item } = await withReview();
    const moved = item({
      target: { kind: 'action', actionId: ids.action },
      decision: 'move',
      period: { kind: 'day', date: '2026-10-02' },
    });
    const occurrence = item({
      target: occurrenceWeek,
      decision: 'move',
      period: { kind: 'week', date: '2026-10-06' },
    });
    const project = item({
      target: { kind: 'project', projectId: ids.project },
      decision: 'pause',
    });
    const axisNote = item({
      target: { kind: 'axis', axisId: ids.axis },
      decision: 'note',
      note: 'Short walks helped',
    });
    const [movedRef, occurrenceRef, projectRef, axisRef] = [
      ref('review_item'),
      ref('review_item'),
      ref('review_item'),
      ref('review_item'),
    ];
    expect(
      await commit([
        create(movedRef, moved),
        create(occurrenceRef, occurrence),
        create(projectRef, project),
        create(axisRef, axisNote),
      ]),
    ).toMatchObject({ ok: true });

    // A changed choice drops its period.
    const carried = { ...without(moved, 'period'), decision: 'carry' };
    expect(await commit([update((await read(movedRef))!, carried)])).toMatchObject({ ok: true });
    expect((await read(movedRef))?.document).toEqual(carried);
    await expect(row('review_items', movedRef.id)).resolves.toMatchObject({
      decision: 'carry',
      detail_json: null,
      local_revision: 2,
    });

    // A removed choice is archived, never deleted.
    const removed = { ...project, archivedAt: now };
    expect(await commit([update((await read(projectRef))!, removed)])).toMatchObject({ ok: true });
    expect((await read(projectRef))?.document).toEqual(removed);
    await expect(row('review_items', projectRef.id)).resolves.toMatchObject({ archived_at: now });

    // Permanent delete of a target clears the reference and keeps the decision and note.
    const clearedNote = {
      ...axisNote,
      target: { kind: 'deleted', deletedKind: 'axis', deletedAt: now },
    };
    const clearedOccurrence = {
      ...occurrence,
      target: { kind: 'deleted', deletedKind: 'routine_occurrence', deletedAt: now },
    };
    expect(
      await commit([
        update((await read(axisRef))!, clearedNote),
        update((await read(occurrenceRef))!, clearedOccurrence),
      ]),
    ).toMatchObject({ ok: true });
    expect((await read(axisRef))?.document).toEqual(clearedNote);
    expect((await read(occurrenceRef))?.document).toEqual(clearedOccurrence);
    await expect(row('review_items', axisRef.id)).resolves.toMatchObject({
      target_kind: 'axis',
      axis_id: null,
      target_deleted_at: now,
      decision: 'note',
      decision_note: 'Short walks helped',
      detail_json: null,
    });
    await expect(row('review_items', occurrenceRef.id)).resolves.toMatchObject({
      target_kind: 'routine_occurrence',
      routine_id: null,
      target_deleted_at: now,
      detail_json: '{"v":1,"period":{"kind":"week","date":"2026-10-06"}}',
    });
    // No item names the Axis or the Routine any more, so RESTRICT no longer holds them.
    await expect(
      driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM review_items WHERE axis_id = ? OR routine_id = ?;',
        [ids.axis, ids.routine],
      ),
    ).resolves.toEqual({ count: 0 });
    await driver.run('DELETE FROM routines WHERE id = ?;', [ids.routine]);
    expect((await read(occurrenceRef))?.document).toEqual(clearedOccurrence);
  });

  it('refuses persisted details with unknown versions, keys, or misplaced identity', async () => {
    const { driver, ref, commit, read, item } = await withReview();
    const moved = ref('review_item');
    const occurrence = ref('review_item');
    expect(
      await commit([
        create(
          moved,
          item({
            target: { kind: 'action', actionId: ids.action },
            decision: 'move',
            period: { kind: 'day', date: '2026-10-02' },
          }),
        ),
        create(occurrence, item({ target: occurrenceDate, decision: 'focus' })),
      ]),
    ).toMatchObject({ ok: true });
    const corrupt = async (target: EntityRef, columns: string, values: readonly unknown[]) => {
      await driver.run(`UPDATE review_items SET ${columns} WHERE id = ?;`, [
        ...(values as (string | null)[]),
        target.id,
      ]);
      await expect(read(target), columns).rejects.toMatchObject({
        code: 'invalid_persisted_record',
      });
    };
    await corrupt(moved, 'detail_json = ?', [
      '{"v":2,"period":{"kind":"day","date":"2026-10-02"}}',
    ]);
    await corrupt(moved, 'detail_json = ?', [
      '{"v":1,"period":{"kind":"day","date":"2026-10-02"},"reason":"late"}',
    ]);
    await corrupt(moved, 'detail_json = ?', ['{"v":1}']);
    await corrupt(moved, 'detail_json = ?', [
      '{"v":1,"period":{"kind":"year","date":"2026-10-02"}}',
    ]);
    await corrupt(moved, 'detail_json = ?', ['[1]']);
    // A period on a decision other than `move`.
    await corrupt(moved, 'detail_json = ?, decision = ?', [
      '{"v":1,"period":{"kind":"day","date":"2026-10-02"}}',
      'carry',
    ]);
    // Occurrence identity on a target that is not a Routine Occurrence.
    await corrupt(moved, 'detail_json = ?, decision = ?', [
      '{"v":1,"occurrence":{"generation":1,"period":{"kind":"date","date":"2026-09-29"}}}',
      'focus',
    ]);
    // A Routine Occurrence target without its identity, or with a cleared reference.
    await corrupt(occurrence, 'detail_json = ?', [null]);
    await corrupt(occurrence, 'detail_json = ?, routine_id = ?, target_deleted_at = ?', [
      '{"v":1,"occurrence":{"generation":1,"period":{"kind":"date","date":"2026-09-29"}}}',
      null,
      now,
    ]);
  });

  it('refuses item documents with misplaced periods, notes, or unknown fields', async () => {
    const { ref, applyDirect, item } = await withReview();
    const action = { kind: 'action', actionId: ids.action };
    const invalid: readonly Document[] = [
      item({ target: action, decision: 'move' }),
      item({ target: action, decision: 'carry', period: { kind: 'day', date: '2026-10-02' } }),
      item({ target: action, decision: 'move', period: { kind: 'year', date: '2026-10-02' } }),
      item({
        target: action,
        decision: 'move',
        period: { kind: 'day', date: '2026-10-02', week: 1 },
      }),
      item({ target: action, decision: 'move', period: { kind: 'day', date: '2026-02-30' } }),
      item({ target: action, decision: 'continue', note: 'Noted' }),
      item({ target: { kind: 'axis', axisId: ids.axis }, decision: 'note' }),
      item({ target: { kind: 'axis', axisId: ids.axis }, decision: 'note', note: '  ' }),
      item({
        target: { kind: 'axis', axisId: ids.axis },
        decision: 'note',
        note: 'n'.repeat(2_001),
      }),
      item({ target: action, decision: 'defer' }),
      item({ target: { kind: 'note', noteId: ids.action }, decision: 'focus' }),
      item({ target: { ...action, projectId: ids.project }, decision: 'focus' }),
      item({ target: { ...occurrenceDate, revision: 2 }, decision: 'focus' }),
      item({ target: { ...occurrenceDate, generation: 0 }, decision: 'focus' }),
      item({
        target: {
          ...occurrenceWeek,
          period: { ...occurrenceWeek.period, start: '2026-10-05' },
        },
        decision: 'focus',
      }),
      item({
        target: { kind: 'deleted', deletedKind: 'note', deletedAt: now },
        decision: 'focus',
      }),
      item({ target: { kind: 'deleted', deletedKind: 'action' }, decision: 'focus' }),
      item({ target: action, decision: 'focus', orderKey: ' ' }),
      item({ target: action, decision: 'focus', score: 3 }),
      without(item({ target: action, decision: 'focus' }), 'reviewId'),
    ];
    for (const document of invalid) {
      await expect(
        applyDirect(create(ref('review_item'), document)),
        JSON.stringify(document),
      ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    }
  });

  it('never recreates a permanently deleted review or item and stays owner-scoped', async () => {
    const { driver, ref, commit, read, applyDirect, item, review } = await withReview();
    const focus = item({ target: { kind: 'action', actionId: ids.action }, decision: 'focus' });
    const saved = ref('review_item');
    expect(await commit([create(saved, focus)])).toMatchObject({ ok: true });
    const record = await read(saved);
    expect(
      await commit([
        {
          operation: 'delete',
          ref: saved,
          expectedRevision: record!.localRevision,
          baseServerRevision: record!.serverRevision,
          baseSnapshotHash: record!.baseSnapshotHash,
          tombstone: createDeletionTombstone(saved, record!.localRevision + 1, now),
        },
      ]),
    ).toMatchObject({ ok: true });
    await expect(read(saved)).resolves.toBeNull();
    await expect(applyDirect(create(saved, focus))).rejects.toMatchObject({
      code: 'write_conflict',
    });

    const deletedReview = ref('review');
    await driver.run(
      `INSERT INTO deletion_ledger (id, owner_id, entity_type, entity_id, local_revision,
         deleted_at, created_at, updated_at)
       VALUES (?, ?, 'review', ?, 2, ?, ?, ?);`,
      [`${ownerId}:review:${deletedReview.id}`, ownerId, deletedReview.id, now, now, now],
    );
    await expect(applyDirect(create(deletedReview, monthly))).rejects.toMatchObject({
      code: 'write_conflict',
    });
    await expect(read(deletedReview)).resolves.toBeNull();

    // Another identity's record is never read or written through this owner.
    await expect(
      applyDirect(create({ ...ref('review_item'), ownerId: otherOwnerId }, focus)),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    await expect(read({ ...review, ownerId: otherOwnerId })).resolves.toBeNull();
    // An item of a review this owner does not have fails its composite foreign key.
    await expect(
      applyDirect(
        create(ref('review_item'), { ...focus, reviewId: '1b000000-0000-4000-8000-0000000000ff' }),
      ),
    ).rejects.toThrow();
  });
});
