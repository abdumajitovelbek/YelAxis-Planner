import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createActionApplication,
  createAlignmentApplication,
  createPlanningApplication,
  createReviewApplication,
  createSerialQueue,
  type ApplicationDependencies,
  type ApplicationResult,
  type CommandReceipt,
  type ReviewView,
} from '@yelaxis/application';
import type { Instant, OwnerId, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteActionPlanningQueries } from '../queries/action-planning';
import { SqliteAlignmentQueries } from '../queries/alignment-queries';
import { SqlitePlanningQueries } from '../queries/planning-queries';
import { SqliteReviewQueries } from '../queries/review-queries';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

/**
 * Cross-layer Review evidence: the composed Review facade (createReviewApplication with
 * SqliteReviewQueries) running real Save, Skip, Finish, and Undo commands against real SQLite
 * (migrations 1..latest, record codecs, the review read model), including a restart.
 */
const ownerId = '10000000-0000-4000-8000-000000000081' as OwnerId;
const profileId = '11000000-0000-4000-8000-000000000081';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-reviews-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'plan.sqlite');
  // Monday 5 October 2026, 08:00 in New York.
  const state = { now: '2026-10-05T12:00:00.000Z' as Instant, idCounter: 1 };
  const ids = {
    next() {
      const suffix = state.idCounter.toString(16).padStart(12, '0');
      state.idCounter += 1;
      return `98000000-0000-4000-8000-${suffix}` as UUID;
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
     ) VALUES (?, ?, 'America/New_York', 'monday', '24_hour', 'en',
               'completed', 'handbook', ?, ?);`,
    [profileId, ownerId, state.now, state.now],
  );
  const open = (driver: NodeSqliteDriver) => {
    const adapters = createSqliteApplicationAdapters(driver, { ownerId });
    const dependencies: ApplicationDependencies = {
      ...adapters,
      ids,
      clock: { now: () => state.now },
      projections: { notifyCommitted() {} },
    };
    const queue = createSerialQueue();
    return {
      driver,
      actions: createActionApplication(dependencies, new SqliteActionPlanningQueries(driver), {
        queue,
      }),
      planning: createPlanningApplication(dependencies, new SqlitePlanningQueries(driver), {
        queue,
      }),
      alignment: createAlignmentApplication(dependencies, new SqliteAlignmentQueries(driver), {
        queue,
      }),
      reviews: createReviewApplication(dependencies, new SqliteReviewQueries(driver), { queue }),
    };
  };
  let current = open(first);
  return {
    get: () => current,
    setNow(value: string) {
      state.now = value as Instant;
    },
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

type App = ReturnType<Awaited<ReturnType<typeof fixture>>['get']>;

function receipt(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

function undoId(result: ApplicationResult<CommandReceipt>): UUID {
  const value = receipt(result);
  if (!value.undo.available) throw new Error('Expected an undo receipt.');
  return value.undo.undoId;
}

/** The reason of a domain refusal (`domain_rejected` carries the domain error). */
function refusalReason(result: ApplicationResult<CommandReceipt>): unknown {
  if (result.ok) throw new Error('Expected a refusal.');
  if (result.error.code !== 'domain_rejected')
    throw new Error(`Expected a domain refusal: ${JSON.stringify(result.error)}`);
  return result.error.domainError.details?.['reason'];
}

async function view(app: App, type: string, key: string): Promise<ReviewView> {
  const found = await app.reviews.getReview(type, key);
  if (found === null) throw new Error(`No ${type} review view for ${key}`);
  return found;
}

async function captureOnDay(app: App, title: string, date: string) {
  receipt(await app.actions.capture(app.actions.newCaptureIntent('inbox'), { title }));
  const item = (await app.actions.listInbox({ limit: 50 })).items.find(
    (entry) => entry.title === title,
  );
  if (item === undefined) throw new Error(`Missing ${title}`);
  receipt(
    await app.planning.place({
      target: { kind: 'action', id: item.id, revision: item.localRevision },
      period: { kind: 'day', date },
    }),
  );
  return item.id;
}

async function actionPlacementDate(app: App, actionId: UUID): Promise<unknown> {
  const found = await app.actions.getAction(actionId);
  const placement = found?.placement?.document as
    { readonly period?: { readonly kind: string; readonly date?: string } } | undefined;
  return placement?.period?.date;
}

async function actionRevision(app: App, actionId: UUID): Promise<number> {
  const found = await app.actions.getAction(actionId);
  if (found === null) throw new Error('Missing Action');
  return found.action.localRevision;
}

async function eventPayloadsAreOperationsOnly(driver: NodeSqliteDriver): Promise<void> {
  const rows = await driver.all<{ payload_json: string }>(
    'SELECT payload_json FROM domain_events;',
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(Object.keys(JSON.parse(row.payload_json) as object)).toEqual(['operation']);
  }
}

describe('reviews with SQLite', () => {
  it('saves, resumes after restart, finishes, undoes, and finishes a daily review again', async () => {
    const db = await fixture();
    let app = db.get();
    const actionId = await captureOnDay(app, 'Write the plan', '2026-10-05');

    const before = await view(app, 'daily', '2026-10-05');
    expect(before).toMatchObject({ type: 'daily', editable: true, saved: null, due: 'due' });
    if (before.type !== 'daily' || before.context === null) throw new Error('No daily context');
    expect(before.context.endDay.carryTo).toBe('2026-10-06');
    expect(
      before.context.endDay.open.items.some(
        (item) => item.kind === 'action' && item.action.id === actionId,
      ),
    ).toBe(true);

    receipt(
      await app.reviews.saveReview({
        type: 'daily',
        periodKey: '2026-10-05',
        notes: 'A steady day.',
        energy: 'medium',
        endDay: {
          actions: [
            {
              actionId,
              revision: await actionRevision(app, actionId),
              decision: { kind: 'carry' },
            },
          ],
          occurrences: [],
          nextFocus: [{ kind: 'action', actionId }],
        },
      }),
    );

    app = await db.restart();
    const resumed = await view(app, 'daily', '2026-10-05');
    expect(resumed.saved).toMatchObject({
      state: 'draft',
      notes: 'A steady day.',
      energy: 'medium',
    });
    expect(resumed.saved?.items.map((item) => item.decision).sort()).toEqual(['carry', 'focus']);
    // Saving changed nothing in the plan.
    expect(await actionPlacementDate(app, actionId)).toBe('2026-10-05');

    const finishInput = async (revision: number) =>
      ({
        type: 'daily',
        periodKey: '2026-10-05',
        revision,
        notes: 'A steady day.',
        energy: 'medium',
        endDay: {
          carryTo: '2026-10-06',
          actions: [
            {
              actionId,
              revision: await actionRevision(app, actionId),
              decision: { kind: 'carry' },
            },
          ],
          occurrences: [],
          nextFocus: [{ kind: 'action', actionId }],
        },
      }) as const;

    const finished = await app.reviews.finishReview(
      await finishInput(resumed.saved?.localRevision ?? 0),
    );
    expect(await actionPlacementDate(app, actionId)).toBe('2026-10-06');
    const completed = await view(app, 'daily', '2026-10-05');
    expect(completed).toMatchObject({ editable: false, saved: { state: 'completed' } });
    expect(completed.saved?.completedAt).toBe('2026-10-05T12:00:00.000Z');

    const overview = await app.reviews.getOverview();
    expect(overview.checkpoints.map((checkpoint) => checkpoint.period.type)).toEqual([
      'daily',
      'weekly',
      'monthly',
      'yearly',
    ]);
    expect(overview.checkpoints[0]).toMatchObject({
      status: 'completed',
      review: { state: 'completed', decisionCount: 2, energy: 'medium' },
    });

    // One Undo restores the plan and the draft exactly.
    receipt(await app.planning.undo(undoId(finished)));
    expect(await actionPlacementDate(app, actionId)).toBe('2026-10-05');
    const restored = await view(app, 'daily', '2026-10-05');
    expect(restored.saved).toMatchObject({ state: 'draft', notes: 'A steady day.' });

    receipt(await app.reviews.finishReview(await finishInput(restored.saved?.localRevision ?? 0)));
    expect(await actionPlacementDate(app, actionId)).toBe('2026-10-06');

    // A finished review is history: another save or finish is refused without writing.
    const again = await app.reviews.saveReview({
      type: 'daily',
      periodKey: '2026-10-05',
      revision: (await view(app, 'daily', '2026-10-05')).saved?.localRevision ?? 0,
      notes: 'Changed later.',
      endDay: { actions: [], occurrences: [] },
    });
    expect(refusalReason(again)).toBe('review_finished');

    const history = await app.reviews.listHistory();
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      period: { type: 'daily', key: '2026-10-05' },
      state: 'completed',
    });
    await eventPayloadsAreOperationsOnly(app.driver);
  });

  it('finishes weekly, monthly, and yearly reviews through the normal rules', async () => {
    const db = await fixture();
    const app = db.get();
    receipt(await app.alignment.createAxis({ title: 'Health' }));
    const axis = (await app.alignment.listAxes()).items.find((item) => item.title === 'Health');
    if (axis === undefined) throw new Error('Missing Axis');
    receipt(
      await app.alignment.createProject({
        title: 'Garden beds',
        desiredResult: 'Two raised beds ready for spring.',
        axisId: axis.id,
        state: 'active',
      }),
    );
    receipt(
      await app.alignment.createOutcome({
        title: 'Run a 5K',
        successDefinition: 'Finish a 5K without stopping.',
        axisId: axis.id,
      }),
    );

    // Sunday 11 October: the last day of the week that began on Monday 5 October.
    db.setNow('2026-10-11T16:00:00.000Z');
    const notice = await app.reviews.getNotice();
    expect(notice.due.map((checkpoint) => checkpoint.period.type)).toEqual(['weekly']);

    const weekly = await view(app, 'weekly', '2026-10-05');
    if (weekly.type !== 'weekly' || weekly.context === null) throw new Error('No weekly context');
    expect(weekly.planning).toMatchObject({ start: '2026-10-12', end: '2026-10-18' });
    const project = weekly.context.projects.items.find((item) => item.title === 'Garden beds');
    if (project === undefined) throw new Error('Missing Project');
    expect(weekly.context.axes.items.map((item) => item.title)).toContain('Health');
    expect(
      weekly.context.commitmentCandidates.items.some(
        (item) => item.kind === 'project' && item.id === project.id && !item.selected,
      ),
    ).toBe(true);

    receipt(
      await app.reviews.finishReview({
        type: 'weekly',
        periodKey: '2026-10-05',
        notes: 'The mornings worked.',
        projects: [{ id: project.id, revision: project.localRevision, decision: 'pause' }],
        axisNotes: [{ axisId: axis.id, note: 'Morning walks helped.' }],
        commitments: [{ kind: 'project', id: project.id }],
      }),
    );
    const paused = await app.alignment.getProject(project.id);
    expect(paused?.project.state).toBe('paused');
    const nextWeek = await app.planning.getWeekPlan('2026-10-12');
    expect(nextWeek.weekCommitments.map((row) => row.target.id)).toEqual([project.id]);
    const axisDetail = await app.alignment.getAxis(axis.id);
    expect(axisDetail?.reviewNote).toMatchObject({
      text: 'Morning walks helped.',
      reviewType: 'weekly',
      period: { type: 'weekly', key: '2026-10-05', start: '2026-10-05', end: '2026-10-11' },
    });
    expect((await app.reviews.getNotice()).due).toEqual([]);

    // Saturday 31 October: the monthly review is due. Save, skip, resume, then finish.
    db.setNow('2026-10-31T16:00:00.000Z');
    const monthly = await view(app, 'monthly', '2026-10');
    if (monthly.type !== 'monthly' || monthly.context === null)
      throw new Error('No monthly context');
    expect(monthly.context.planningMonth).toBe('2026-11');
    const outcome = monthly.context.outcomes.items.find((item) => item.title === 'Run a 5K');
    if (outcome === undefined) throw new Error('Missing Outcome');
    const monthlyInput = (revision?: number) =>
      ({
        type: 'monthly',
        periodKey: '2026-10',
        ...(revision === undefined ? {} : { revision }),
        notes: 'The Outcome moved.',
        outcomes: [{ id: outcome.id, revision: outcome.localRevision, decision: 'complete' }],
        milestones: [],
        projects: [],
        theme: 'Rest and repair',
      }) as const;
    receipt(await app.reviews.saveReview(monthlyInput()));
    const draft = await view(app, 'monthly', '2026-10');
    receipt(
      await app.reviews.skipReview({
        type: 'monthly',
        periodKey: '2026-10',
        revision: draft.saved?.localRevision ?? 0,
      }),
    );
    const skipped = await view(app, 'monthly', '2026-10');
    expect(skipped.saved).toMatchObject({ state: 'skipped', themeText: 'Rest and repair' });
    // Skipping applied nothing.
    expect((await app.alignment.getOutcome(outcome.id))?.outcome.state).toBe('active');
    receipt(await app.reviews.finishReview(monthlyInput(skipped.saved?.localRevision ?? 0)));
    expect((await app.alignment.getOutcome(outcome.id))?.outcome.state).toBe('achieved');
    expect((await app.planning.getMonthPlan('2026-11')).theme?.text).toBe('Rest and repair');

    // Thursday 31 December: the yearly review writes next year's direction.
    db.setNow('2026-12-31T16:00:00.000Z');
    const yearly = await view(app, 'yearly', '2026');
    if (yearly.type !== 'yearly' || yearly.context === null) throw new Error('No yearly context');
    expect(yearly.context.planningYear).toBe('2027');
    receipt(
      await app.reviews.finishReview({
        type: 'yearly',
        periodKey: '2026',
        notes: 'What mattered: steady mornings.',
        outcomes: [],
        direction: { choice: 'new', text: 'Build steady habits.' },
      }),
    );
    expect((await app.planning.getYearPlan('2027')).direction?.text).toBe('Build steady habits.');
    expect((await view(app, 'yearly', '2026')).saved).toMatchObject({
      state: 'completed',
      direction: { choice: 'new', text: 'Build steady habits.' },
    });

    // History: newest period first, filtered by type, and paged without gaps.
    const history = await app.reviews.listHistory();
    expect(history.items.map((item) => item.period.type)).toEqual(['weekly', 'monthly', 'yearly']);
    expect(
      (await app.reviews.listHistory({ type: 'monthly' })).items.map((item) => item.state),
    ).toEqual(['completed']);
    await eventPayloadsAreOperationsOnly(app.driver);
  });

  it('saves an emptied weekly commitment list, resumes it after restart, and Finish clears it', async () => {
    const db = await fixture();
    let app = db.get();
    receipt(await app.alignment.createAxis({ title: 'Home' }));
    const axis = (await app.alignment.listAxes()).items.find((item) => item.title === 'Home');
    if (axis === undefined) throw new Error('Missing Axis');
    receipt(
      await app.alignment.createProject({
        title: 'Paint the hall',
        desiredResult: 'The hall is painted.',
        axisId: axis.id,
        state: 'active',
      }),
    );
    // Sunday 11 October: the weekly review of 5–11 October plans the week of 12–18 October.
    db.setNow('2026-10-11T16:00:00.000Z');
    const opened = await view(app, 'weekly', '2026-10-05');
    if (opened.type !== 'weekly' || opened.context === null) throw new Error('No weekly context');
    const project = opened.context.projects.items.find((item) => item.title === 'Paint the hall');
    if (project === undefined) throw new Error('Missing Project');
    receipt(
      await app.planning.addWeekCommitment({
        weekDate: '2026-10-12',
        target: { kind: 'project', id: project.id },
      }),
    );
    const planned = await view(app, 'weekly', '2026-10-05');
    if (planned.type !== 'weekly' || planned.context === null) throw new Error('No context');
    expect(planned.context.commitments.map((row) => row.target.id)).toEqual([project.id]);

    // Save for later with the commitments emptied: nothing is applied, and the draft remembers
    // the cleared list rather than leaving the week to the plan.
    receipt(
      await app.reviews.saveReview({
        type: 'weekly',
        periodKey: '2026-10-05',
        projects: [],
        axisNotes: [],
        commitments: [],
      }),
    );
    expect(
      (await app.planning.getWeekPlan('2026-10-12')).weekCommitments.map((row) => row.target.id),
    ).toEqual([project.id]);
    await expect(
      app.driver.get<{ cleared_lists_json: string | null }>(
        `SELECT cleared_lists_json FROM review_checkpoints
         WHERE review_type = 'weekly' AND period_key = '2026-10-05';`,
      ),
    ).resolves.toEqual({ cleared_lists_json: '["commitments"]' });

    app = await db.restart();
    const resumed = await view(app, 'weekly', '2026-10-05');
    expect(resumed.saved).toMatchObject({ state: 'draft', clearedLists: ['commitments'] });
    expect(resumed.saved?.items).toEqual([]);

    // Finish as the draft was saved: the planning Week's commitments are cleared.
    const finished = await app.reviews.finishReview({
      type: 'weekly',
      periodKey: '2026-10-05',
      revision: resumed.saved?.localRevision ?? 0,
      projects: [],
      axisNotes: [],
      commitments: [],
    });
    receipt(finished);
    expect((await app.planning.getWeekPlan('2026-10-12')).weekCommitments).toEqual([]);
    expect((await view(app, 'weekly', '2026-10-05')).saved).toMatchObject({
      state: 'completed',
      clearedLists: ['commitments'],
    });

    // One Undo restores the commitment and the draft that remembers the cleared list.
    receipt(await app.planning.undo(undoId(finished)));
    expect(
      (await app.planning.getWeekPlan('2026-10-12')).weekCommitments.map((row) => row.target.id),
    ).toEqual([project.id]);
    expect((await view(app, 'weekly', '2026-10-05')).saved).toMatchObject({
      state: 'draft',
      clearedLists: ['commitments'],
    });
    await eventPayloadsAreOperationsOnly(app.driver);
  });

  it('keeps when a review was first saved across later saves', async () => {
    const db = await fixture();
    const app = db.get();
    receipt(
      await app.reviews.saveReview({
        type: 'daily',
        periodKey: '2026-10-05',
        notes: 'Started.',
        endDay: { actions: [], occurrences: [] },
      }),
    );
    const first = await view(app, 'daily', '2026-10-05');
    // 16:00 the same day in New York.
    db.setNow('2026-10-05T20:00:00.000Z');
    receipt(
      await app.reviews.saveReview({
        type: 'daily',
        periodKey: '2026-10-05',
        revision: first.saved?.localRevision ?? 0,
        notes: 'Started, then added a thought.',
        endDay: { actions: [], occurrences: [] },
      }),
    );
    expect((await view(app, 'daily', '2026-10-05')).saved).toMatchObject({
      notes: 'Started, then added a thought.',
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T20:00:00.000Z',
    });
  });
});
