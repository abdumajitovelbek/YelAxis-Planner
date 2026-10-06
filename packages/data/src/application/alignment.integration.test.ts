import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createActionApplication,
  createAlignmentApplication,
  createPlanningApplication,
  createSerialQueue,
  type ApplicationDependencies,
  type ApplicationResult,
  type CommandReceipt,
  type NoChangeReceipt,
} from '@yelaxis/application';
import { alignmentLinkId, type Instant, type OwnerId, type UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteActionPlanningQueries } from '../queries/action-planning';
import { SqliteAlignmentQueries } from '../queries/alignment-queries';
import { SqlitePlanningQueries } from '../queries/planning-queries';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

/*
 * Cross-layer alignment evidence: the composed alignment application (createAlignmentApplication with
 * SqliteAlignmentQueries and the SQLite unit of work) running real commands against real SQLite,
 * including undo through the shared planning undo, permanent delete, and restart.
 *
 * Every case is skipped in the data part's worktree because the four application modules are still
 * foundation stubs that reject each call. The integrator enables them once parts A1–A3 are merged.
 */
const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const profileId = '11000000-0000-4000-8000-000000000001';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-alignment-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'plan.sqlite');
  const state = { now: '2026-09-28T09:00:00.000Z' as Instant, idCounter: 1 };
  const ids = {
    next() {
      const suffix = state.idCounter.toString(16).padStart(12, '0');
      state.idCounter += 1;
      return `a0000000-0000-4000-8000-${suffix}` as UUID;
    },
  };
  const first = new NodeSqliteDriver(path);
  await runMigrations(first, schemaMigrations, () => state.now);
  await first.run(
    `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
     VALUES (?, 'local', ?, ?);`,
    [ownerId, state.now, state.now],
  );
  await first.run(
    `INSERT INTO profiles (
       id, owner_id, planning_time_zone, week_start, time_format, locale_override,
       onboarding_status, onboarding_step, created_at, updated_at
     ) VALUES (?, ?, 'Asia/Tashkent', 'monday', '24_hour', 'en', 'completed', 'handbook', ?, ?);`,
    [profileId, ownerId, state.now, state.now],
  );
  const open = (driver: NodeSqliteDriver) => {
    const dependencies: ApplicationDependencies = {
      ...createSqliteApplicationAdapters(driver, { ownerId }),
      ids,
      clock: { now: () => state.now },
      projections: { notifyCommitted() {} },
    };
    // One queue for the one connection, as in the composition root.
    const queue = createSerialQueue();
    return {
      driver,
      alignment: createAlignmentApplication(dependencies, new SqliteAlignmentQueries(driver), {
        queue,
      }),
      planning: createPlanningApplication(dependencies, new SqlitePlanningQueries(driver), {
        queue,
      }),
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
      await runMigrations(reopened, schemaMigrations, () => state.now);
      current = open(reopened);
      return current;
    },
  };
}

function receipt(result: ApplicationResult<CommandReceipt | NoChangeReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  if ('status' in result.value) throw new Error('Expected a write, not a no-change result.');
  return result.value;
}

function createdId(result: ApplicationResult<CommandReceipt>): UUID {
  const created = receipt(result).canonical[0]?.ref.id;
  if (created === undefined) throw new Error('Expected a created record.');
  return created;
}

function undoId(value: CommandReceipt): UUID {
  if (!value.undo.available) throw new Error('Expected an undo receipt.');
  return value.undo.undoId;
}

async function seedAlignment(context: Awaited<ReturnType<typeof fixture>>) {
  const { alignment } = context.get();
  const axis = createdId(await alignment.createAxis({ title: 'Health' }));
  const outcome = createdId(
    await alignment.createOutcome({
      title: 'Run a 10k',
      successDefinition: 'Finish a 10k run',
      axisId: axis,
      targetEnd: '2026-12-31',
    }),
  );
  const project = createdId(
    await alignment.createProject({ title: 'Training plan', axisId: axis }),
  );
  const milestone = createdId(
    await alignment.createMilestone({
      outcomeId: outcome,
      title: 'First 5k',
      measurableCheckpoint: 'Run 5k without stopping',
    }),
  );
  return { axis, outcome, project, milestone };
}

describe('alignment composed alignment application on SQLite', () => {
  it('creates and reorders Axes, and the order survives a restart', async () => {
    const context = await fixture();
    const { alignment } = context.get();
    const health = createdId(await alignment.createAxis({ title: 'Health' }));
    const study = createdId(await alignment.createAxis({ title: 'Study' }));
    const listed = await alignment.listAxes();
    expect(listed.items.map((axis) => axis.id)).toEqual([health, study]);
    const second = listed.items[1];
    if (second === undefined) throw new Error('Missing Axis');
    receipt(
      await alignment.reorder({
        target: { kind: 'axis', id: study, revision: second.localRevision },
        direction: 'up',
        scope: { container: 'axes' },
      }),
    );
    expect((await alignment.listAxes()).items.map((axis) => axis.id)).toEqual([study, health]);
    const restarted = await context.restart();
    expect((await restarted.alignment.listAxes()).items.map((axis) => axis.id)).toEqual([
      study,
      health,
    ]);
    const keys = await restarted.driver.all<{ sort_key: string }>('SELECT sort_key FROM axes;');
    expect(keys.every(({ sort_key }) => /^\d{15}$/u.test(sort_key))).toBe(true);
    await restarted.driver.close();
  });

  it('links, reports a duplicate, unlinks, revives, and undoes with minimized events', async () => {
    const context = await fixture();
    const { alignment, planning, driver } = context.get();
    const { project, milestone } = await seedAlignment(context);
    const linkId = alignmentLinkId('milestone_project', milestone, project);

    const linked = receipt(
      await alignment.link({
        relationship: 'milestone_project',
        milestoneId: milestone,
        projectId: project,
      }),
    );
    expect(linked.canonical.map(({ ref }) => ref.id)).toEqual([linkId]);
    await expect(
      alignment.link({
        relationship: 'milestone_project',
        milestoneId: milestone,
        projectId: project,
      }),
    ).resolves.toEqual({ ok: true, value: { status: 'no_change', reason: 'already_linked' } });

    // Undoing the link marks the row unlinked; it is never deleted.
    receipt(await planning.undo(undoId(linked)));
    await expect(
      driver.get<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM milestone_projects WHERE id = ?;',
        [linkId],
      ),
    ).resolves.toEqual({ deleted_at: '2026-09-28T09:00:00.000Z' });
    await expect(alignment.getMilestone(milestone)).resolves.toMatchObject({
      projects: { total: 0 },
    });

    // Linking again revives the same row.
    receipt(
      await alignment.link({
        relationship: 'milestone_project',
        milestoneId: milestone,
        projectId: project,
      }),
    );
    const detail = await alignment.getMilestone(milestone);
    const row = detail?.projects.items[0];
    if (row?.linkId === undefined || row.linkRevision === undefined) {
      throw new Error('Missing link');
    }
    expect(row.linkId).toBe(linkId);
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM milestone_projects;'),
    ).resolves.toEqual({ count: 1 });

    const unlinked = receipt(
      await alignment.unlink({
        relationship: 'milestone_project',
        linkId: row.linkId,
        revision: row.linkRevision,
      }),
    );
    // Both endpoints stay; only the link became inactive.
    await expect(alignment.getProject(project)).resolves.not.toBeNull();
    await expect(alignment.getMilestone(milestone)).resolves.toMatchObject({
      projects: { total: 0 },
    });
    receipt(await planning.undo(undoId(unlinked)));
    await expect(alignment.getMilestone(milestone)).resolves.toMatchObject({
      projects: { total: 1 },
    });

    const payloads = await driver.all<{ payload_json: string }>(
      `SELECT payload_json FROM domain_events WHERE entity_type = 'milestone_project';`,
    );
    expect(payloads.length).toBeGreaterThan(0);
    for (const { payload_json } of payloads) {
      expect(payload_json).not.toMatch(/First 5k|Training plan|Run 5k/u);
    }
    await driver.close();
  });

  it('archives and restores an Outcome without cascading to its Milestone', async () => {
    const context = await fixture();
    const { alignment, driver } = context.get();
    const { outcome, milestone } = await seedAlignment(context);
    const before = await alignment.getOutcome(outcome);
    if (before === null) throw new Error('Missing Outcome');
    receipt(
      await alignment.archive({
        kind: 'outcome',
        id: outcome,
        revision: before.outcome.localRevision,
      }),
    );
    await expect(alignment.getMilestone(milestone)).resolves.toMatchObject({
      milestone: { state: 'active', outcome: { id: outcome, archived: true } },
    });
    const archived = await alignment.getOutcome(outcome);
    if (archived === null) throw new Error('Missing Outcome');
    expect(archived.outcome).toMatchObject({ state: 'archived', stateBeforeArchive: 'active' });
    receipt(
      await alignment.restore({
        kind: 'outcome',
        id: outcome,
        revision: archived.outcome.localRevision,
      }),
    );
    await expect(alignment.getOutcome(outcome)).resolves.toMatchObject({
      outcome: { state: 'active' },
      milestones: { total: 1 },
    });
    await driver.close();
  });

  it('restricts, confirms, and permanently deletes without touching another object', async () => {
    const context = await fixture();
    const { alignment, driver } = context.get();
    const { outcome, project, milestone } = await seedAlignment(context);
    const outcomeRevision = async () => {
      const detail = await alignment.getOutcome(outcome);
      if (detail === null) throw new Error('Missing Outcome');
      return detail.outcome.localRevision;
    };
    // The Outcome still owns a Milestone: blocked under every policy.
    await expect(
      alignment.deletePermanently({
        target: { kind: 'outcome', id: outcome, revision: await outcomeRevision() },
        policy: 'unlink_and_delete',
        confirmation: 'Run a 10k',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'domain_rejected' } });

    // An unlinked Project row leaves with the Milestone and is disclosed in the preview.
    const linked = receipt(
      await alignment.link({
        relationship: 'milestone_project',
        milestoneId: milestone,
        projectId: project,
      }),
    );
    expect(linked.undo.available).toBe(true);
    const detail = await alignment.getMilestone(milestone);
    const row = detail?.projects.items[0];
    if (detail === null || row?.linkId === undefined || row.linkRevision === undefined) {
      throw new Error('Missing link');
    }
    receipt(
      await alignment.unlink({
        relationship: 'milestone_project',
        linkId: row.linkId,
        revision: row.linkRevision,
      }),
    );
    await expect(
      alignment.previewDelete({ kind: 'milestone', id: milestone }, 'restrict'),
    ).resolves.toMatchObject({ allowed: true, removedHistory: { inactiveLinks: 1 } });
    const current = await alignment.getMilestone(milestone);
    if (current === null) throw new Error('Missing Milestone');
    const target = {
      kind: 'milestone' as const,
      id: milestone,
      revision: current.milestone.localRevision,
    };
    await expect(
      alignment.deletePermanently({ target, policy: 'restrict', confirmation: 'first 5k' }),
    ).resolves.toMatchObject({ ok: false });
    const deleted = receipt(
      await alignment.deletePermanently({ target, policy: 'restrict', confirmation: 'First 5k' }),
    );
    expect(deleted.undo.available).toBe(false);
    await expect(alignment.getMilestone(milestone)).resolves.toBeNull();
    await expect(alignment.getProject(project)).resolves.not.toBeNull();
    await expect(
      driver.all<{ entity_type: string }>(
        'SELECT entity_type FROM deletion_ledger ORDER BY entity_type;',
      ),
    ).resolves.toEqual([{ entity_type: 'milestone' }, { entity_type: 'milestone_project' }]);

    // With its Milestone gone, the Outcome can be deleted after typing its title.
    receipt(
      await alignment.deletePermanently({
        target: { kind: 'outcome', id: outcome, revision: await outcomeRevision() },
        policy: 'restrict',
        confirmation: 'Run a 10k',
      }),
    );
    await expect(alignment.getOutcome(outcome)).resolves.toBeNull();
    await expect(alignment.getProject(project)).resolves.not.toBeNull();
    await driver.close();
  });

  it('permanently deletes an Action after its Milestone link was unlinked (part A1)', async () => {
    const context = await fixture();
    const { alignment, actions, driver } = context.get();
    const { milestone } = await seedAlignment(context);
    const intent = actions.newCaptureIntent('inbox');
    receipt(await actions.capture(intent, { title: 'Book track' }));
    receipt(
      await alignment.link({
        relationship: 'milestone_action',
        milestoneId: milestone,
        actionId: intent.actionId,
      }),
    );
    const detail = await alignment.getMilestone(milestone);
    const row = detail?.actions.items[0];
    if (row?.linkId === undefined || row.linkRevision === undefined) {
      throw new Error('Missing link');
    }
    receipt(
      await alignment.unlink({
        relationship: 'milestone_action',
        linkId: row.linkId,
        revision: row.linkRevision,
      }),
    );
    const action = await actions.getAction(intent.actionId);
    if (action === null) throw new Error('Missing Action');
    receipt(
      await actions.deletePermanently(intent.actionId, action.action.localRevision, 'Book track'),
    );
    await expect(actions.getAction(intent.actionId)).resolves.toBeNull();
    await expect(
      driver.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM deletion_ledger WHERE entity_type = 'milestone_action';`,
      ),
    ).resolves.toEqual({ count: 1 });
    await expect(alignment.getMilestone(milestone)).resolves.not.toBeNull();
    await driver.close();
  });

  it('keeps links, archive state, and neighborhoods across a restart', async () => {
    const context = await fixture();
    const { alignment } = context.get();
    const { axis, outcome, project, milestone } = await seedAlignment(context);
    receipt(
      await alignment.link({
        relationship: 'milestone_project',
        milestoneId: milestone,
        projectId: project,
      }),
    );
    const projectDetail = await alignment.getProject(project);
    if (projectDetail === null) throw new Error('Missing Project');
    receipt(
      await alignment.archive({
        kind: 'project',
        id: project,
        revision: projectDetail.project.localRevision,
      }),
    );
    const before = {
      axis: await alignment.getAxis(axis),
      outcome: await alignment.getOutcome(outcome),
      neighborhood: await alignment.getNeighborhood({ kind: 'milestone', id: milestone }),
    };
    expect(before.neighborhood?.below).toMatchObject([
      { relationship: 'milestone_project', other: { id: project, archived: true } },
    ]);
    const restarted = await context.restart();
    await expect(restarted.alignment.getAxis(axis)).resolves.toEqual(before.axis);
    await expect(restarted.alignment.getOutcome(outcome)).resolves.toEqual(before.outcome);
    await expect(
      restarted.alignment.getNeighborhood({ kind: 'milestone', id: milestone }),
    ).resolves.toEqual(before.neighborhood);
    await restarted.driver.close();
  });
});
