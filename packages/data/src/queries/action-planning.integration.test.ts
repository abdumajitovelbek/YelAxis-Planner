import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createActionApplication,
  createAlignmentApplication,
  createReviewApplication,
  createSerialQueue,
  executeCommand,
  type ApplicationDependencies,
  type ApplicationResult,
  type CanonicalMutation,
  type CanonicalRecordState,
  type CommandReceipt,
} from '@yelaxis/application';
import {
  alignmentLinkId,
  createDeletionTombstone,
  ok,
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
import { SqliteActionPlanningQueries } from './action-planning';
import { alignmentQuerySql, SqliteAlignmentQueries } from './alignment-queries';
import { SqliteReviewQueries } from './review-queries';

/*
 * alignment additions to the Action read model: Milestone choices for Inbox triage, the Milestone link
 * of a pair in any state, Project Axis for cross-Axis checks, and the unlinked Milestone rows an
 * Action delete must remove. Synthetic fixtures only.
 */
const now = '2026-09-28T09:00:00.000Z' as Instant;
const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
const other = '10000000-0000-4000-8000-000000000002' as OwnerId;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const id = (group: number, index: number) =>
  `${group.toString(16).padStart(2, '0')}000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}` as UUID;

const ids = {
  axis: id(1, 1),
  firstOutcome: id(2, 1),
  secondOutcome: id(2, 2),
  project: id(4, 1),
  looseProject: id(4, 2),
  action: id(5, 1),
  otherAction: id(5, 2),
  stepOne: id(3, 1),
  stepTwo: id(3, 2),
  done: id(3, 3),
  archived: id(3, 4),
  secondOutcomeStep: id(3, 5),
  foreignMilestone: id(3, 9),
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-action-planning-'));
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
  for (const ownerId of [owner, other]) {
    await insert('planning_identities', { id: ownerId, identity_kind: 'local' });
  }
  await insert('axes', {
    id: ids.axis,
    owner_id: owner,
    title: 'Health',
    state: 'active',
    sort_key: 'a',
  });
  const outcome = (outcomeId: UUID, title: string, sortKey: string, ownerId: OwnerId = owner) =>
    insert('outcomes', {
      id: outcomeId,
      owner_id: ownerId,
      title,
      success_definition: `${title} done`,
      state: 'active',
      progress_mode: 'none',
      sort_key: sortKey,
    });
  await outcome(ids.firstOutcome, 'Run a 10k', '000001000000000');
  await outcome(ids.secondOutcome, 'Sleep well', '000002000000000');
  await outcome(id(2, 9), 'Hidden', '000001000000000', other);
  const milestone = (
    milestoneId: UUID,
    outcomeId: UUID,
    title: string,
    sortKey: string,
    extra: Record<string, SqliteParameter> = {},
  ) =>
    insert('milestones', {
      id: milestoneId,
      owner_id: owner,
      outcome_id: outcomeId,
      title,
      measurable_checkpoint: `${title} checkpoint`,
      state: 'active',
      sort_key: sortKey,
      ...extra,
    });
  // The second Outcome's Milestone has the smallest key; grouping follows Outcome order first.
  await milestone(ids.secondOutcomeStep, ids.secondOutcome, 'Lights out', '000000100000000');
  await milestone(ids.stepTwo, ids.firstOutcome, 'Second 5k', '000002000000000');
  await milestone(ids.stepOne, ids.firstOutcome, 'First 5k', '000001000000000');
  await milestone(ids.done, ids.firstOutcome, 'Done step', '000003000000000', {
    state: 'completed',
  });
  await milestone(ids.archived, ids.firstOutcome, 'Archived step', '000004000000000', {
    state: 'archived',
    state_before_archive: 'active',
    archived_at: now,
  });
  await insert('milestones', {
    id: ids.foreignMilestone,
    owner_id: other,
    outcome_id: id(2, 9),
    title: 'Hidden step',
    measurable_checkpoint: 'Hidden',
    state: 'active',
    sort_key: 'a',
  });
  await insert('projects', {
    id: ids.project,
    owner_id: owner,
    axis_id: ids.axis,
    title: 'Training plan',
    state: 'idea',
    sort_key: 'a',
  });
  await insert('projects', {
    id: ids.looseProject,
    owner_id: owner,
    title: 'Loose idea',
    state: 'idea',
    sort_key: 'b',
  });
  for (const [actionId, title] of [
    [ids.action, 'Book track'],
    [ids.otherAction, 'Warm up'],
  ] as const) {
    await insert('actions', {
      id: actionId,
      owner_id: owner,
      title,
      state: 'inbox',
      capture_origin: 'inbox',
      sort_key: actionId,
    });
  }
  const linkRow = (milestoneId: UUID, actionId: UUID, unlinked: boolean) =>
    insert('milestone_actions', {
      id: alignmentLinkId('milestone_action', milestoneId, actionId),
      owner_id: owner,
      milestone_id: milestoneId,
      action_id: actionId,
      deleted_at: unlinked ? now : null,
    });
  await linkRow(ids.stepOne, ids.action, false);
  await linkRow(ids.stepTwo, ids.action, true);
  await linkRow(ids.stepOne, ids.otherAction, true);

  let counter = 1;
  const nextId = () => id(0x90, counter++);
  const dependencies: ApplicationDependencies = {
    ...createSqliteApplicationAdapters(driver, { ownerId: owner }),
    ids: { next: nextId },
    clock: { now: () => now },
    projections: { notifyCommitted() {} },
  };
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
            eventType: 'action.test_deleted',
            version: 1 as const,
            actor: context.actor,
            commandId: context.commandId,
            occurredAt: context.now,
            payload: { operation: mutation.operation },
          })),
        }),
    );
  return { driver, commit, queries: new SqliteActionPlanningQueries(driver) };
}

function remove(record: CanonicalRecordState): CanonicalMutation {
  return {
    operation: 'delete',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    tombstone: createDeletionTombstone(record.ref, record.localRevision + 1, now),
  };
}

describe('SqliteActionPlanningQueries alignment additions', () => {
  it('lists active Milestones grouped by Outcome order with the Outcome title', async () => {
    const { queries } = await fixture();
    await expect(queries.listMilestones(owner)).resolves.toEqual([
      {
        id: ids.stepOne,
        title: 'First 5k',
        localRevision: 1,
        outcomeId: ids.firstOutcome,
        outcomeTitle: 'Run a 10k',
      },
      {
        id: ids.stepTwo,
        title: 'Second 5k',
        localRevision: 1,
        outcomeId: ids.firstOutcome,
        outcomeTitle: 'Run a 10k',
      },
      {
        id: ids.secondOutcomeStep,
        title: 'Lights out',
        localRevision: 1,
        outcomeId: ids.secondOutcome,
        outcomeTitle: 'Sleep well',
      },
    ]);
    await expect(queries.listMilestones(other)).resolves.toEqual([
      expect.objectContaining({ id: ids.foreignMilestone, outcomeTitle: 'Hidden' }),
    ]);
  });

  it('finds the Milestone link of a pair in any state, owner-scoped', async () => {
    const { queries } = await fixture();
    await expect(
      queries.findMilestoneActionLink(owner, ids.stepOne, ids.action),
    ).resolves.toMatchObject({
      ref: {
        type: 'milestone_action',
        id: alignmentLinkId('milestone_action', ids.stepOne, ids.action),
      },
      document: { milestoneId: ids.stepOne, actionId: ids.action },
    });
    await expect(
      queries.findMilestoneActionLink(owner, ids.stepTwo, ids.action),
    ).resolves.toMatchObject({ document: { unlinkedAt: now } });
    await expect(queries.findMilestoneActionLink(owner, ids.done, ids.action)).resolves.toBeNull();
    await expect(
      queries.findMilestoneActionLink(other, ids.stepOne, ids.action),
    ).resolves.toBeNull();
  });

  it('lists Project choices with their Axis for cross-Axis checks', async () => {
    const { queries } = await fixture();
    await expect(queries.listProjects(owner)).resolves.toEqual([
      { id: ids.project, title: 'Training plan', localRevision: 1, axisId: ids.axis },
      { id: ids.looseProject, title: 'Loose idea', localRevision: 1 },
    ]);
  });

  it('reports unlinked Milestone rows, which an Action delete must remove with the Action', async () => {
    const { queries, commit, driver } = await fixture();
    const impact = await queries.getActionDeleteImpact(owner, ids.otherAction);
    expect(impact.milestoneLinkCount).toBe(0);
    expect(impact.inactiveMilestoneLinks.map((record) => record.ref.id)).toEqual([
      alignmentLinkId('milestone_action', ids.stepOne, ids.otherAction),
    ]);
    const linked = await queries.getActionDeleteImpact(owner, ids.action);
    expect(linked.milestoneLinkCount).toBe(1);
    expect(linked.inactiveMilestoneLinks.map((record) => record.ref.id)).toEqual([
      alignmentLinkId('milestone_action', ids.stepTwo, ids.action),
    ]);

    const workspace = await queries.getActionWorkspace(owner, ids.otherAction);
    if (workspace === null) throw new Error('Missing Action');
    // Deleting only the Action fails at COMMIT: the unlinked row still holds the foreign key.
    await expect(commit([remove(workspace.action)])).resolves.toMatchObject({
      ok: false,
      error: { code: 'transaction_failed' },
    });
    await expect(
      commit([...impact.inactiveMilestoneLinks.map(remove), remove(workspace.action)]),
    ).resolves.toMatchObject({ ok: true });
    await expect(queries.getActionWorkspace(owner, ids.otherAction)).resolves.toBeNull();
    await expect(
      driver.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM deletion_ledger
         WHERE entity_type IN ('action', 'milestone_action');`,
      ),
    ).resolves.toEqual({ count: 2 });
    // Both Milestone endpoints stay.
    await expect(
      driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM milestones WHERE owner_id = ?;',
        [owner],
      ),
    ).resolves.toEqual({ count: 5 });
  });
});

const insertRow = (
  driver: NodeSqliteDriver,
  table: string,
  row: Record<string, SqliteParameter>,
): Promise<unknown> => {
  const values = { created_at: now, updated_at: now, ...row };
  const columns = Object.keys(values);
  return driver.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')});`,
    Object.values(values),
  );
};

/** Monday 5 October 2026, 08:00 in New York: the weekly review of that week can be saved. */
const reviewNow = '2026-10-05T12:00:00.000Z' as Instant;

/** The composed Action, alignment, and Review facades over one real SQLite file. */
async function reviewedPlan() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-review-delete-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(driver, schemaMigrations, () => reviewNow);
  const stamp = { created_at: reviewNow, updated_at: reviewNow };
  await insertRow(driver, 'planning_identities', { id: owner, identity_kind: 'local', ...stamp });
  await insertRow(driver, 'profiles', {
    id: id(0x11, 1),
    owner_id: owner,
    planning_time_zone: 'America/New_York',
    week_start: 'monday',
    time_format: '24_hour',
    locale_override: 'en',
    onboarding_status: 'completed',
    onboarding_step: 'handbook',
    ...stamp,
  });
  let counter = 1;
  const dependencies: ApplicationDependencies = {
    ...createSqliteApplicationAdapters(driver, { ownerId: owner }),
    ids: { next: () => id(0x98, counter++) },
    clock: { now: () => reviewNow },
    projections: { notifyCommitted() {} },
  };
  const queue = createSerialQueue();
  return {
    driver,
    actions: createActionApplication(dependencies, new SqliteActionPlanningQueries(driver), {
      queue,
    }),
    alignment: createAlignmentApplication(dependencies, new SqliteAlignmentQueries(driver), {
      queue,
    }),
    reviews: createReviewApplication(dependencies, new SqliteReviewQueries(driver), { queue }),
  };
}

function receiptOf(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('permanent Action delete keeps review decisions', () => {
  it('reads every review item naming the Action through its index, in any state', async () => {
    const { driver, queries, commit } = await fixture();
    await insertRow(driver, 'profiles', {
      id: id(0x11, 1),
      owner_id: owner,
      planning_time_zone: 'Asia/Tashkent',
      week_start: 'monday',
      time_format: '24_hour',
    });
    const weekly = {
      owner_id: owner,
      profile_id: id(0x11, 1),
      review_type: 'weekly',
      period_key: '2026-09-21',
      period_start_date: '2026-09-21',
      period_end_date: '2026-09-27',
      week_start: 'monday',
    };
    await insertRow(driver, 'review_checkpoints', { ...weekly, id: id(10, 1), state: 'draft' });
    await insertRow(driver, 'review_checkpoints', {
      ...weekly,
      id: id(10, 2),
      state: 'archived',
      state_before_archive: 'completed',
      completed_at: now,
      archived_at: now,
    });
    const item = (index: number, reviewId: UUID, extra: Record<string, SqliteParameter> = {}) =>
      insertRow(driver, 'review_items', {
        id: id(10, 0x10 + index),
        owner_id: owner,
        review_id: reviewId,
        target_kind: 'action',
        action_id: ids.action,
        decision: 'focus',
        sort_key: `i${String(index)}`,
        ...extra,
      });
    await item(3, id(10, 2), { decision: 'commit' });
    await item(1, id(10, 1));
    await item(2, id(10, 1), { archived_at: now });
    await item(4, id(10, 1), { deleted_at: now });
    await insertRow(driver, 'review_items', {
      id: id(10, 0x20),
      owner_id: owner,
      review_id: id(10, 1),
      target_kind: 'action',
      action_id: ids.otherAction,
      decision: 'commit',
      sort_key: 'z',
    });

    const impact = await queries.getActionDeleteImpact(owner, ids.action);
    expect(impact.reviewItems.map((record) => record.ref.id)).toEqual([
      id(10, 0x11),
      id(10, 0x12),
      id(10, 0x13),
    ]);
    // The soft-deleted row still holds the foreign key, so it is counted.
    expect(impact.reviewReferences).toBe(4);
    expect(impact.reviewItems.map((record) => record.document)).toEqual([
      {
        reviewId: id(10, 1),
        target: { kind: 'action', actionId: ids.action },
        decision: 'focus',
        orderKey: 'i1',
      },
      {
        reviewId: id(10, 1),
        target: { kind: 'action', actionId: ids.action },
        decision: 'focus',
        orderKey: 'i2',
        archivedAt: now,
      },
      {
        reviewId: id(10, 2),
        target: { kind: 'action', actionId: ids.action },
        decision: 'commit',
        orderKey: 'i3',
      },
    ]);
    await expect(queries.getActionDeleteImpact(other, ids.action)).resolves.toMatchObject({
      reviewItems: [],
      reviewReferences: 0,
    });

    // The foreign key holds: a delete that leaves a review item naming the Action rolls back.
    const otherImpact = await queries.getActionDeleteImpact(owner, ids.otherAction);
    expect(otherImpact.reviewItems.map((record) => record.ref.id)).toEqual([id(10, 0x20)]);
    const workspace = await queries.getActionWorkspace(owner, ids.otherAction);
    if (workspace === null) throw new Error('Missing Action');
    await expect(
      commit([...otherImpact.inactiveMilestoneLinks.map(remove), remove(workspace.action)]),
    ).resolves.toMatchObject({ ok: false, error: { code: 'transaction_failed' } });
    await expect(queries.getActionWorkspace(owner, ids.otherAction)).resolves.not.toBeNull();
    await expect(queries.getActionDeleteImpact(owner, ids.otherAction)).resolves.toEqual(
      otherImpact,
    );

    const plan = await driver.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${alignmentQuerySql.deleteImpact.reviewItems.action}`,
      [owner, ids.action, '', 200],
    );
    const detail = plan.map((row) => row.detail).join('\n');
    expect(detail).toContain(
      'SEARCH review_items USING INDEX idx_review_items_action (owner_id=? AND action_id=?)',
    );
    expect(detail).not.toMatch(/\bSCAN\b/u);
  });

  it('deletes an Action and an Axis that a saved weekly review names, keeping its decisions', async () => {
    const app = await reviewedPlan();
    const axisId = receiptOf(await app.alignment.createAxis({ title: 'Private Health' }))
      .canonical[0]?.ref.id;
    if (axisId === undefined) throw new Error('Missing Axis');
    const intent = app.actions.newCaptureIntent('inbox');
    receiptOf(await app.actions.capture(intent, { title: 'Private errand' }));
    const actionId = intent.actionId;
    receiptOf(
      await app.reviews.saveReview({
        type: 'weekly',
        periodKey: '2026-10-05',
        notes: 'A steady week.',
        projects: [],
        axisNotes: [{ axisId, note: 'Morning walks helped.' }],
        firstDayFocus: [{ kind: 'action', actionId }],
      }),
    );
    const saved = (await app.reviews.getReview('weekly', '2026-10-05'))?.saved;
    if (saved === undefined || saved === null) throw new Error('Missing saved review');
    expect(saved.items.map((item) => [item.target.kind, item.decision])).toEqual([
      ['axis', 'note'],
      ['action', 'focus'],
    ]);

    const action = await app.actions.getAction(actionId);
    const actionCommand = id(0x13, 1);
    const actionDeleted = receiptOf(
      await app.actions.deletePermanently(
        actionId,
        action?.action.localRevision ?? 0,
        'Private errand',
        actionCommand,
      ),
    );
    const axis = await app.alignment.getAxis(axisId);
    const axisCommand = id(0x13, 2);
    const axisDeleted = receiptOf(
      await app.alignment.deletePermanently(
        {
          target: { kind: 'axis', id: axisId, revision: axis?.axis.localRevision ?? 0 },
          policy: 'unlink_and_delete',
          confirmation: 'Private Health',
        },
        axisCommand,
      ),
    );
    expect(actionDeleted.undo).toEqual({ available: false });
    expect(axisDeleted.undo).toEqual({ available: false });

    await expect(app.actions.getAction(actionId)).resolves.toBeNull();
    await expect(app.alignment.getAxis(axisId)).resolves.toBeNull();
    await expect(app.driver.all('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    const rows = await new SqliteReviewQueries(app.driver).listReviewItems(owner, saved.reviewId);
    expect(rows.map((row) => row.target)).toEqual([{ kind: 'deleted' }, { kind: 'deleted' }]);
    expect(rows.map((row) => row.record.document)).toEqual([
      expect.objectContaining({
        reviewId: saved.reviewId,
        target: { kind: 'deleted', deletedKind: 'axis', deletedAt: reviewNow },
        decision: 'note',
        note: 'Morning walks helped.',
      }),
      expect.objectContaining({
        reviewId: saved.reviewId,
        target: { kind: 'deleted', deletedKind: 'action', deletedAt: reviewNow },
        decision: 'focus',
      }),
    ]);

    // A repeated command id returns its receipt and changes nothing.
    await expect(
      app.actions.deletePermanently(actionId, 1, 'Private errand', actionCommand),
    ).resolves.toEqual({ ok: true, value: actionDeleted });
    await expect(
      app.alignment.deletePermanently(
        {
          target: { kind: 'axis', id: axisId, revision: 1 },
          policy: 'unlink_and_delete',
          confirmation: 'Private Health',
        },
        axisCommand,
      ),
    ).resolves.toEqual({ ok: true, value: axisDeleted });

    // The review stays readable and can still be saved.
    const kept = (await app.reviews.getReview('weekly', '2026-10-05'))?.saved;
    expect(kept?.notes).toBe('A steady week.');
    expect(kept?.items.map((item) => item.target)).toEqual([
      { kind: 'deleted' },
      { kind: 'deleted' },
    ]);
    receiptOf(
      await app.reviews.saveReview({
        type: 'weekly',
        periodKey: '2026-10-05',
        revision: kept?.localRevision ?? 0,
        notes: 'A steady week, rewritten.',
        projects: [],
        axisNotes: [],
      }),
    );

    // Minimized events: one per cleared review item, and no title or note anywhere.
    await expect(
      app.driver.all(
        `SELECT event_type, payload_json FROM domain_events
         WHERE owner_id = ? AND event_type = 'review_item.target_cleared'
         ORDER BY occurred_at, command_id, sequence;`,
        [owner],
      ),
    ).resolves.toEqual([
      { event_type: 'review_item.target_cleared', payload_json: '{"operation":"update"}' },
      { event_type: 'review_item.target_cleared', payload_json: '{"operation":"update"}' },
    ]);
    const payloads = await app.driver.all('SELECT payload_json FROM domain_events;');
    expect(JSON.stringify(payloads)).not.toMatch(/Private|Morning walks|steady/u);
    await expect(
      app.driver.all(
        `SELECT entity_type FROM deletion_ledger WHERE owner_id = ? ORDER BY entity_type;`,
        [owner],
      ),
    ).resolves.toEqual([{ entity_type: 'action' }, { entity_type: 'axis' }]);
  });

  it('previews only the review decisions history lists, though every one is kept', async () => {
    const app = await reviewedPlan();
    const axisId = receiptOf(await app.alignment.createAxis({ title: 'Private Health' }))
      .canonical[0]?.ref.id;
    if (axisId === undefined) throw new Error('Missing Axis');
    const save = async (axisNotes: readonly { axisId: UUID; note: string }[]) => {
      const saved = (await app.reviews.getReview('weekly', '2026-10-05'))?.saved;
      receiptOf(
        await app.reviews.saveReview({
          type: 'weekly',
          periodKey: '2026-10-05',
          ...(saved === null || saved === undefined ? {} : { revision: saved.localRevision }),
          notes: 'A steady week.',
          projects: [],
          axisNotes,
        }),
      );
    };
    // The note is written, removed (a removed choice), and written again.
    await save([{ axisId, note: 'Morning walks helped.' }]);
    await save([]);
    await save([{ axisId, note: 'Evening walks helped.' }]);
    const saved = (await app.reviews.getReview('weekly', '2026-10-05'))?.saved;
    expect(saved?.items.map((item) => [item.target.kind, item.decision])).toEqual([
      ['axis', 'note'],
    ]);

    const preview = await app.alignment.previewDelete({ kind: 'axis', id: axisId }, 'restrict');
    expect(preview).toMatchObject({
      allowed: true,
      historyReferences: { reviews: 1, routineDefaults: 0 },
    });

    // Both rows lose the reference; the listed note stays as "Deleted object".
    receiptOf(
      await app.alignment.deletePermanently({
        target: { kind: 'axis', id: axisId, revision: preview?.target.localRevision ?? 0 },
        policy: 'restrict',
        confirmation: 'Private Health',
      }),
    );
    await expect(app.driver.all('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await expect(
      app.driver.all(
        `SELECT target_kind, target_deleted_at, archived_at IS NOT NULL AS removed
         FROM review_items WHERE owner_id = ? ORDER BY created_at, id;`,
        [owner],
      ),
    ).resolves.toEqual([
      { target_kind: 'axis', target_deleted_at: reviewNow, removed: 1 },
      { target_kind: 'axis', target_deleted_at: reviewNow, removed: 0 },
    ]);
    const kept = (await app.reviews.getReview('weekly', '2026-10-05'))?.saved;
    expect(kept?.items.map((item) => [item.target, item.note])).toEqual([
      [{ kind: 'deleted' }, 'Evening walks helped.'],
    ]);
  });
});
