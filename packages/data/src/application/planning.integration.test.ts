import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  builtInTemplates,
  createActionApplication,
  createPlanningApplication,
  type ApplicationDependencies,
  type ApplicationResult,
  type CommandReceipt,
  type OccurrenceEntry,
  type OccurrenceTargetInput,
  type PlanningApplication,
  type TimedEntry,
  type WeekPlan,
} from '@yelaxis/application';
import type { Instant, OwnerId, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteActionPlanningQueries } from '../queries/action-planning';
import { SqlitePlanningQueries } from '../queries/planning-queries';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

/**
 * Cross-layer planning evidence: the composed planning application running real commands against real
 * SQLite (migrations 1..latest, codecs, deferred foreign keys, read model), including restart.
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

const timed = {
  kind: 'time_specific',
  wallTime: '07:00',
  durationMinutes: 30,
  zonePolicy: { kind: 'follow_profile' },
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
} as const;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-planning-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'plan.sqlite');
  const state = { now: '2026-10-05T12:00:00.000Z' as Instant, idCounter: 1 };
  const ids = {
    next() {
      const suffix = state.idCounter.toString(16).padStart(12, '0');
      state.idCounter += 1;
      return `90000000-0000-4000-8000-${suffix}` as UUID;
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
    return {
      driver,
      planning: createPlanningApplication(dependencies, new SqlitePlanningQueries(driver)),
      actions: createActionApplication(dependencies, new SqliteActionPlanningQueries(driver)),
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

function receipt(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

function undoId(result: ApplicationResult<CommandReceipt>): UUID {
  const value = receipt(result);
  if (!value.undo.available) throw new Error('Expected an undo receipt.');
  return value.undo.undoId;
}

async function captureAction(
  actions: ReturnType<typeof createActionApplication>,
  title: string,
  estimateMinutes?: number,
) {
  receipt(
    await actions.capture(actions.newCaptureIntent('inbox'), {
      title,
      ...(estimateMinutes === undefined ? {} : { estimateMinutes }),
    }),
  );
  const item = (await actions.listInbox({ limit: 50 })).items.find(
    (entry) => entry.title === title,
  );
  if (item === undefined) throw new Error(`Missing ${title}`);
  return item;
}

const allTimed = (plan: WeekPlan): TimedEntry[] => {
  const byKey = new Map<string, TimedEntry>();
  for (const day of plan.days) for (const entry of day.timed) byKey.set(entry.key, entry);
  return [...byKey.values()];
};

const target = (entry: OccurrenceEntry): OccurrenceTargetInput => ({
  routineId: entry.ref.routineId,
  generation: entry.ref.generation,
  period: entry.ref.period,
  ...(entry.ref.localRevision === undefined ? {} : { revision: entry.ref.localRevision }),
});

async function actionRevision(planning: PlanningApplication, title: string, week: string) {
  const plan = await planning.getWeekPlan(week);
  const entry = allTimed(plan).find((item) => item.title === title);
  return entry;
}

async function payloadOperationsOnly(driver: NodeSqliteDriver): Promise<void> {
  const rows = await driver.all<{ payload_json: string }>(
    'SELECT payload_json FROM domain_events;',
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(Object.keys(JSON.parse(row.payload_json) as object)).toEqual(['operation']);
  }
}

describe('planning application with SQLite', () => {
  it('schedules, rejects unacknowledged overlap, moves, completes, and undoes across restart', async () => {
    const db = await fixture();
    const { planning, actions, driver } = db.get();
    const draft = await captureAction(actions, 'Write report', 60);

    const scheduled = await planning.scheduleAction({
      actionId: draft.id,
      revision: draft.localRevision,
      date: '2026-10-06',
      startTime: '09:00',
      durationMinutes: 60,
      overlapAcknowledged: false,
    });
    receipt(scheduled);
    let week = await planning.getWeekPlan('2026-10-06');
    const block = allTimed(week).find((entry) => entry.title === 'Write report');
    expect(block).toMatchObject({
      kind: 'action_block',
      localDate: '2026-10-06',
      localStart: '09:00',
      localEnd: '10:00',
      durationMinutes: 60,
      state: 'planned',
    });
    expect((await actions.getAction(draft.id))?.action.document).toMatchObject({
      state: 'scheduled',
    });

    const blocked = await planning.createCustomBlock({
      title: 'Dentist',
      date: '2026-10-06',
      startTime: '09:30',
      durationMinutes: 30,
      overlapAcknowledged: false,
    });
    expect(blocked).toMatchObject({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: { details: { reason: 'overlap_requires_acknowledgement' } },
      },
    });
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM time_blocks;'),
    ).resolves.toEqual({ count: 1 });

    receipt(
      await planning.createCustomBlock({
        title: 'Dentist',
        date: '2026-10-06',
        startTime: '09:30',
        durationMinutes: 30,
        overlapAcknowledged: true,
      }),
    );
    week = await planning.getWeekPlan('2026-10-06');
    expect(week.conflicts).toHaveLength(1);
    expect(week.conflicts[0]).toMatchObject({ kept: true });

    const moving = await actionRevision(planning, 'Write report', '2026-10-06');
    if (moving?.block === undefined) throw new Error('Expected action block');
    const moved = await planning.moveBlock({
      blockId: moving.block.id,
      revision: moving.block.localRevision,
      date: '2026-10-07',
      startTime: '14:00',
      durationMinutes: 60,
      overlapAcknowledged: false,
    });
    const moveUndo = undoId(moved);
    week = await planning.getWeekPlan('2026-10-06');
    expect(allTimed(week).find((entry) => entry.title === 'Write report')).toMatchObject({
      localDate: '2026-10-07',
      localStart: '14:00',
    });
    expect(week.conflicts).toHaveLength(0);
    await expect(
      driver.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM time_blocks WHERE superseded_by_id IS NOT NULL AND state = 'canceled';",
      ),
    ).resolves.toEqual({ count: 1 });
    const placement = await driver.get<{ period_start_date: string }>(
      'SELECT period_start_date FROM planning_placements WHERE action_id = ? AND archived_at IS NULL;',
      [draft.id],
    );
    expect(placement).toEqual({ period_start_date: '2026-10-07' });

    receipt(await planning.undo(moveUndo));
    week = await planning.getWeekPlan('2026-10-06');
    expect(allTimed(week).find((entry) => entry.title === 'Write report')).toMatchObject({
      localDate: '2026-10-06',
      localStart: '09:00',
      state: 'planned',
    });
    await expect(
      driver.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM time_blocks WHERE state = 'planned' AND action_id = ?;",
        [draft.id],
      ),
    ).resolves.toEqual({ count: 1 });

    const restarted = await db.restart();
    const again = await restarted.planning.getWeekPlan('2026-10-06');
    const persisted = allTimed(again).find((entry) => entry.title === 'Write report');
    if (persisted?.block === undefined) throw new Error('Expected persisted block');
    receipt(
      await restarted.planning.setBlockState({
        blockId: persisted.block.id,
        revision: persisted.block.localRevision,
        to: 'completed',
      }),
    );
    expect((await restarted.actions.getAction(draft.id))?.action.document).toMatchObject({
      state: 'planned',
    });
    await payloadOperationsOnly(restarted.driver);
    await restarted.driver.close();
  });

  it('resolves template conflicts only by explicit choices: keep overlap, shorten, cancel', async () => {
    const db = await fixture();
    const { planning, driver } = db.get();
    receipt(
      await planning.createCommitment({
        title: 'Client call',
        strength: 'hard',
        date: '2026-10-06',
        startTime: '09:00',
        durationMinutes: 60,
        overlapAcknowledged: false,
      }),
    );
    const balanced = builtInTemplates.find((template) => template.title === 'Balanced Day');
    if (balanced === undefined) throw new Error('Missing Balanced Day');
    const preview = await planning.previewTemplate({
      templateId: balanced.id,
      anchorDate: '2026-10-06',
      timeZone: 'America/New_York',
    });
    expect(preview).toMatchObject({ ok: true, value: { issues: [] } });
    const request = {
      templateId: balanced.id,
      anchorDate: '2026-10-06',
      timeZone: 'America/New_York',
      selectedKeys: balanced.blueprint.items.map((item) => item.templateKey),
    };
    // Applying over planned work needs the user's explicit Keep-overlap choice; nothing is written.
    expect(await planning.applyTemplate({ ...request, overlapAcknowledged: false })).toMatchObject({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: { details: { reason: 'overlap_requires_acknowledgement' } },
      },
    });
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM time_blocks;'),
    ).resolves.toEqual({ count: 1 });
    const applied = await planning.applyTemplate({ ...request, overlapAcknowledged: true });
    const applyUndo = undoId(applied);

    let week = await planning.getWeekPlan('2026-10-06');
    expect(week.fixed.map((entry) => entry.title)).toEqual(['Client call']);
    expect(week.conflicts).toHaveLength(1);
    const conflict = week.conflicts[0]!;
    expect(conflict.kept).toBe(true);
    expect([conflict.first.title, conflict.second.title].sort()).toEqual([
      'Client call',
      'Deep work session',
    ]);
    const ref = (entry: TimedEntry) => {
      if (entry.block === undefined) throw new Error('Expected block');
      return {
        kind: 'block' as const,
        blockId: entry.block.id,
        revision: entry.block.localRevision,
      };
    };
    expect(
      await planning.keepOverlap({ first: ref(conflict.first), second: ref(conflict.second) }),
    ).toMatchObject({
      ok: false,
      error: { domainError: { details: { reason: 'already_kept' } } },
    });
    const deep = [conflict.first, conflict.second].find(
      (entry) => entry.title === 'Deep work session',
    )!;
    receipt(
      await planning.shortenBlock({
        blockId: deep.block!.id,
        revision: deep.block!.localRevision,
        durationMinutes: 45,
      }),
    );
    week = await planning.getWeekPlan('2026-10-06');
    const shortened = allTimed(week).find((entry) => entry.title === 'Deep work session')!;
    expect(shortened).toMatchObject({ localStart: '09:00', localEnd: '09:45' });
    // Still overlapping, so the kept acknowledgement stays.
    expect(week.conflicts).toHaveLength(1);
    expect(week.conflicts.filter((item) => !item.kept)).toHaveLength(0);
    const call = allTimed(week).find((entry) => entry.title === 'Client call')!;
    receipt(
      await planning.setBlockState({
        blockId: call.block!.id,
        revision: call.block!.localRevision,
        to: 'canceled',
      }),
    );
    week = await planning.getWeekPlan('2026-10-06');
    expect(week.conflicts).toHaveLength(0);
    expect(week.fixed).toHaveLength(0);

    // Undo is exact only while nothing it would restore has changed since; later edits refuse it.
    const blocksBefore = await driver.all(
      'SELECT id, state, local_revision FROM time_blocks ORDER BY id;',
    );
    expect(await planning.undo(applyUndo)).toMatchObject({
      ok: false,
      error: { code: 'revision_conflict' },
    });
    await expect(
      driver.all('SELECT id, state, local_revision FROM time_blocks ORDER BY id;'),
    ).resolves.toEqual(blocksBefore);
    await driver.close();
  });

  it('runs a routine through complete, this-occurrence edit, this-and-future, undo, pause, and resume', async () => {
    const db = await fixture();
    const { planning, driver } = db.get();
    receipt(
      await planning.createRoutine({
        title: 'Morning pages',
        rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-10-05' },
        schedulingMode: timed,
      }),
    );
    let week = await planning.getWeekPlan('2026-10-05');
    let occurrences = allTimed(week).filter((entry) => entry.kind === 'routine_occurrence');
    expect(occurrences).toHaveLength(7);
    expect(occurrences.every((entry) => entry.localStart === '07:00')).toBe(true);

    const monday = occurrences.find((entry) => entry.localDate === '2026-10-05')!;
    receipt(await planning.completeOccurrence({ occurrence: target(monday.occurrence!) }));
    const tuesday = occurrences.find((entry) => entry.localDate === '2026-10-06')!;
    receipt(
      await planning.editOccurrence({
        occurrence: target(tuesday.occurrence!),
        date: '2026-10-06',
        startTime: '08:15',
        durationMinutes: 20,
        overlapAcknowledged: false,
      }),
    );
    week = await planning.getWeekPlan('2026-10-05');
    occurrences = allTimed(week).filter((entry) => entry.kind === 'routine_occurrence');
    expect(occurrences.find((entry) => entry.localDate === '2026-10-05')).toMatchObject({
      state: 'completed',
    });
    expect(occurrences.find((entry) => entry.localDate === '2026-10-06')).toMatchObject({
      localStart: '08:15',
      durationMinutes: 20,
    });

    const routine = (await planning.listRoutines())[0]!;
    const split = await planning.editRoutineThisAndFuture({
      routineId: routine.id,
      revision: routine.localRevision,
      selectedOn: '2026-10-08',
      rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-10-08' },
      schedulingMode: { ...timed, wallTime: '06:30' },
    });
    const splitUndo = undoId(split);
    week = await planning.getWeekPlan('2026-10-05');
    occurrences = allTimed(week).filter((entry) => entry.kind === 'routine_occurrence');
    expect(
      occurrences
        .filter((entry) => entry.localDate >= '2026-10-08')
        .every((entry) => entry.localStart === '06:30'),
    ).toBe(true);
    expect(occurrences.find((entry) => entry.localDate === '2026-10-05')).toMatchObject({
      state: 'completed',
      localStart: '07:00',
    });
    expect((await planning.getRoutine(routine.id))?.routine.generations).toHaveLength(2);

    receipt(await planning.undo(splitUndo));
    expect((await planning.getRoutine(routine.id))?.routine.generations).toHaveLength(1);
    week = await planning.getWeekPlan('2026-10-05');
    expect(
      allTimed(week)
        .filter((entry) => entry.kind === 'routine_occurrence' && entry.localDate >= '2026-10-08')
        .every((entry) => entry.localStart === '07:00'),
    ).toBe(true);

    const beforePause = (await planning.listRoutines())[0]!;
    receipt(
      await planning.pauseRoutine({
        routineId: beforePause.id,
        revision: beforePause.localRevision,
        pauseOn: '2026-10-09',
      }),
    );
    week = await planning.getWeekPlan('2026-10-05');
    expect(
      allTimed(week).filter(
        (entry) => entry.kind === 'routine_occurrence' && entry.localDate >= '2026-10-09',
      ),
    ).toHaveLength(0);
    const paused = (await planning.listRoutines())[0]!;
    expect(paused).toMatchObject({ state: 'paused', pauseEffectiveOn: '2026-10-09' });
    receipt(
      await planning.resumeRoutine({
        routineId: paused.id,
        revision: paused.localRevision,
        resumeOn: '2026-10-12',
      }),
    );
    const resumedWeek = await planning.getWeekPlan('2026-10-12');
    expect(
      allTimed(resumedWeek).filter((entry) => entry.kind === 'routine_occurrence'),
    ).toHaveLength(7);
    const gap = await planning.getWeekPlan('2026-10-05');
    expect(
      allTimed(gap).filter(
        (entry) =>
          entry.kind === 'routine_occurrence' &&
          entry.localDate >= '2026-10-09' &&
          entry.localDate <= '2026-10-11',
      ),
    ).toHaveLength(0);

    const restarted = await db.restart();
    const detail = await restarted.planning.getRoutine(routine.id);
    expect(detail?.history.some((entry) => entry.state === 'completed')).toBe(true);
    await expect(
      restarted.driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM routine_occurrences;'),
    ).resolves.toMatchObject({ count: expect.any(Number) as number });
    await payloadOperationsOnly(restarted.driver);
    await restarted.driver.close();
    void driver;
  });

  it('counts weekly routines and requires confirmation for an extra completion', async () => {
    const db = await fixture();
    const { planning, driver } = db.get();
    receipt(
      await planning.createRoutine({
        title: 'Strength training',
        rule: {
          version: 1,
          kind: 'weekly_count',
          targetCount: 2,
          weekStart: 'monday',
          startsOn: '2026-10-05',
        },
        schedulingMode: { kind: 'day_flexible' },
      }),
    );
    const log = async (confirmExtra?: boolean) => {
      const plan = await planning.getWeekPlan('2026-10-05');
      const entry = plan.weeklyCounts[0]!;
      return planning.completeOccurrence({
        occurrence: target(entry),
        ...(confirmExtra === undefined ? {} : { confirmExtra }),
      });
    };
    receipt(await log());
    receipt(await log());
    expect((await planning.getWeekPlan('2026-10-05')).weeklyCounts[0]).toMatchObject({
      completedCount: 2,
      targetCount: 2,
      state: 'completed',
    });
    expect((await log()).ok).toBe(false);
    receipt(await log(true));
    expect((await planning.getWeekPlan('2026-10-05')).weeklyCounts[0]).toMatchObject({
      completedCount: 3,
    });
    await driver.close();
  });

  it('creates nothing when a Template apply fails mid-transaction, and a retry creates one coherent set', async () => {
    const db = await fixture();
    const { planning, driver } = db.get();
    const study = builtInTemplates.find((template) => template.title === 'Study Week')!;
    const request = {
      templateId: study.id,
      anchorDate: '2026-10-05',
      timeZone: 'America/New_York',
      selectedKeys: study.blueprint.items.map((item) => item.templateKey),
      overlapAcknowledged: false,
    };
    const counts = () =>
      driver.get<{ actions: number; projects: number; blocks: number; placements: number }>(
        `SELECT (SELECT COUNT(*) FROM actions) AS actions, (SELECT COUNT(*) FROM projects) AS projects,
                (SELECT COUNT(*) FROM time_blocks) AS blocks,
                (SELECT COUNT(*) FROM planning_placements) AS placements;`,
      );
    const before = await counts();
    // Fault injection: the first Time Block insert of the apply fails inside SQLite.
    await driver.run(
      `CREATE TRIGGER test_fail_block BEFORE INSERT ON time_blocks
       BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`,
    );
    const failed = await planning.applyTemplate(request);
    expect(failed).toMatchObject({ ok: false, error: { code: 'transaction_failed' } });
    await expect(counts()).resolves.toEqual(before);
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM command_receipts;'),
    ).resolves.toEqual({ count: 0 });

    await driver.run('DROP TRIGGER test_fail_block;');
    receipt(await planning.applyTemplate(request));
    await expect(counts()).resolves.toEqual({
      actions: 6,
      projects: 1,
      blocks: 5,
      placements: before!.placements + 7,
    });
    await driver.close();
  });

  it('applies and undoes a built-in template atomically and never duplicates built-ins', async () => {
    const db = await fixture();
    const { planning, driver } = db.get();
    const study = builtInTemplates.find((template) => template.title === 'Study Week')!;
    const keys = study.blueprint.items.map((item) => item.templateKey);
    const deselectParent = await planning.previewTemplate({
      templateId: study.id,
      anchorDate: '2026-10-05',
      timeZone: 'America/New_York',
      selectedKeys: keys.filter((key) => key !== 'project'),
    });
    expect(deselectParent).toMatchObject({ ok: true });
    if (!deselectParent.ok) throw new Error('preview');
    expect(deselectParent.value.issues.length).toBeGreaterThan(0);
    const refused = await planning.applyTemplate({
      templateId: study.id,
      anchorDate: '2026-10-05',
      timeZone: 'America/New_York',
      selectedKeys: keys.filter((key) => key !== 'project'),
      overlapAcknowledged: false,
    });
    expect(refused.ok).toBe(false);
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM actions;'),
    ).resolves.toEqual({ count: 0 });

    const applied = await planning.applyTemplate({
      templateId: study.id,
      anchorDate: '2026-10-05',
      timeZone: 'America/New_York',
      selectedKeys: keys,
      overlapAcknowledged: false,
    });
    const applyUndo = undoId(applied);
    const week = await planning.getWeekPlan('2026-10-05');
    const titles = allTimed(week).map(
      (entry) => `${entry.localDate} ${entry.localStart} ${entry.title}`,
    );
    expect(titles).toContain('2026-10-05 18:00 Review lecture notes');
    expect(titles).toContain('2026-10-09 17:00 Self-test and list open questions');
    expect(week.days[5]?.flexibleActions.map((action) => action.title)).toEqual(['Light review']);
    expect(
      week.weekObjects.map((row) => (row.target.kind === 'action' ? '' : row.target.title)),
    ).toContain('Study week');
    const created = await driver.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM actions WHERE state IN ('planned', 'scheduled');",
    );
    expect(created).toEqual({ count: 6 });

    receipt(await planning.saveWeekAsTemplate({ weekDate: '2026-10-05', title: 'Study copy' }));
    const savedWeek = (await planning.listTemplates()).find((item) => item.title === 'Study copy');
    expect(savedWeek).toMatchObject({ source: 'user', blueprintVersion: 2, itemCount: 6 });

    receipt(await planning.undo(applyUndo));
    const undone = await planning.getWeekPlan('2026-10-05');
    expect(allTimed(undone).filter((entry) => entry.state === 'planned')).toHaveLength(0);
    expect(undone.days.flatMap((day) => day.flexibleActions)).toHaveLength(0);
    await expect(
      driver.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM actions WHERE state IN ('planned', 'scheduled');",
      ),
    ).resolves.toEqual({ count: 0 });

    const restarted = await db.restart();
    const listed = await restarted.planning.listTemplates();
    expect(listed.filter((item) => item.source === 'built_in').map((item) => item.id)).toEqual(
      builtInTemplates.map((template) => template.id),
    );
    await expect(
      restarted.driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM templates WHERE id IN (' +
          builtInTemplates.map(() => '?').join(', ') +
          ');',
        builtInTemplates.map((template) => template.id),
      ),
    ).resolves.toEqual({ count: 0 });
    await restarted.driver.close();
  });

  it('keeps V1 and V2 user templates decoding without reinterpretation', async () => {
    const db = await fixture();
    const { planning, driver } = db.get();
    receipt(
      await planning.saveTemplate({
        title: 'Legacy checklist',
        blueprint: {
          version: 1,
          items: [{ templateKey: 'a', kind: 'action', title: 'Old step' }],
        },
      }),
    );
    receipt(
      await planning.duplicateTemplate({
        templateId: builtInTemplates[0]!.id,
        title: 'My weekly reset',
      }),
    );
    const listed = await planning.listTemplates();
    const legacy = listed.find((item) => item.title === 'Legacy checklist')!;
    expect(legacy).toMatchObject({ source: 'user', blueprintVersion: 1 });
    const preview = await planning.previewTemplate({
      templateId: legacy.id,
      anchorDate: '2026-10-05',
      timeZone: 'America/New_York',
    });
    expect(preview).toMatchObject({
      ok: true,
      value: { items: [{ schedule: { kind: 'unscheduled' } }] },
    });
    const copy = listed.find((item) => item.title === 'My weekly reset')!;
    expect(copy).toMatchObject({ source: 'user', blueprintVersion: 2 });
    expect(copy.id).not.toBe(builtInTemplates[0]!.id);
    await driver.close();
  });

  it('reports unknown, partial, and capped capacity without treating missing time as free', async () => {
    const db = await fixture();
    const { planning, driver } = db.get();
    let week = await planning.getWeekPlan('2026-10-05');
    expect(week.capacity.availability.status).toBe('unknown');
    receipt(
      await planning.addAvailability({
        strength: 'soft',
        windows: (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const).flatMap(
          (weekday) => [
            { weekday, start: '09:00', end: '12:00' },
            { weekday, start: '11:00', end: '17:00' },
          ],
        ),
      }),
    );
    week = await planning.getWeekPlan('2026-10-05');
    expect(week.capacity.availability.status).toBe('partial');
    expect(week.days[0]?.capacity).toMatchObject({
      availability: { status: 'known', minutes: 480 },
    });
    expect(week.days[6]?.capacity).toMatchObject({ availability: { status: 'unknown' } });
    receipt(await planning.setCapacityCap({ period: 'day', minutes: 360 }));
    week = await planning.getWeekPlan('2026-10-05');
    expect(week.days[0]?.capacity).toMatchObject({ availability: { minutes: 360 } });
    expect(week.days[6]?.capacity).toMatchObject({ availability: { minutes: 360 } });
    const month = await planning.getMonthPlan('2026-10');
    expect(month.weeks.length).toBeGreaterThanOrEqual(4);
    expect(month.weeks[0]?.summary).toMatch(/planned/u);
    await driver.close();
  });
});
