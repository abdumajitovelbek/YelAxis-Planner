import { afterEach, describe, expect, it } from 'vitest';

import type { ApplicationResult, CommandReceipt } from '@yelaxis/application';
import type { CalendarDate, Instant, UUID } from '@yelaxis/domain';

import { SqliteActionPlanningQueries } from '../queries/action-planning';
import { SqlitePlanningQueries } from '../queries/planning-queries';
import type { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import {
  complete,
  expectReceiptMatchesEvents,
  firstCompletionArtifacts,
  latestReceipt,
  ledgerDeletion,
  onboardingEventCount,
  openOnboardingFixture,
  removeOnboardingFixtures,
  rerun,
  rows,
  setupDay,
  starterActionTitle,
} from './testing/onboarding-fixture';

/**
 * A setup rerun never moves, reorders, re-dates, or rewrites the starter Action's Day placement or
 * week commitment once the person manages them in Plan (planning), archived ones included.
 */

// Saturday closing the setup week, and Wednesday of the next Sunday week (2026-08-09..15).
const laterSameWeek = '2026-08-08T07:00:00.000Z' as Instant;
const nextWeek = '2026-08-12T07:00:00.000Z' as Instant;

afterEach(removeOnboardingFixtures);

function accepted(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

/** Every row a rerun must leave alone. */
async function planSnapshot(driver: NodeSqliteDriver) {
  return {
    placements: await rows(driver, 'planning_placements'),
    focus: await rows(driver, 'focus_selections'),
    weeks: await rows(driver, 'week_selections'),
    blocks: await rows(driver, 'time_blocks'),
  };
}

async function revisionOf(
  driver: NodeSqliteDriver,
  table: 'planning_placements' | 'week_selections',
  id: string,
): Promise<number> {
  const row = await driver.get<{ local_revision: number }>(
    `SELECT local_revision FROM ${table} WHERE id = ?;`,
    [id],
  );
  if (row === undefined) throw new Error(`Missing ${table} row`);
  return row.local_revision;
}

/** Setup completed on 2026-08-06, with the Action and planning applications over the same database. */
async function completedSetup() {
  const fixture = await openOnboardingFixture();
  const state = await complete(fixture.onboarding);
  const { actionId, placementId, weekSelectionId } = state.artifacts;
  if (actionId === undefined || placementId === undefined || weekSelectionId === undefined)
    throw new Error('Missing starter artifacts');
  const actions = fixture.actions();
  const planning = fixture.planning();
  return {
    ...fixture,
    state,
    actionId,
    placementId,
    weekSelectionId,
    actions,
    planning,
    actionRevision: async () => {
      const detail = await actions.getAction(actionId);
      if (detail === null) throw new Error('Missing starter Action');
      return detail.action.localRevision;
    },
  };
}

/**
 * The rerun completed and wrote no placement or week record: the only such events are the first
 * completion's, and the receipt lists exactly the events written.
 */
async function expectRerunLeftStarterPlanAlone(
  driver: NodeSqliteDriver,
  before: Awaited<ReturnType<typeof planSnapshot>>,
) {
  expect(await planSnapshot(driver)).toEqual(before);
  expect(await onboardingEventCount(driver, 'placement')).toBe(1);
  expect(await onboardingEventCount(driver, 'week_selection')).toBe(1);
  const receipt = await latestReceipt(driver);
  expect(receipt.canonical.map(({ ref }) => ref.type)).not.toContain('planning_placement');
  expect(receipt.canonical.map(({ ref }) => ref.type)).not.toContain('focus_selection');
  await expectReceiptMatchesEvents(driver, receipt);
}

describe('Today and Focus onboarding rerun and the starter Action plan', () => {
  it('first completion places the starter Action on its day and week exactly once', async () => {
    const { driver, state, actionId, placementId, weekSelectionId } = await completedSetup();

    expect(await rows(driver, 'planning_placements')).toEqual([
      expect.objectContaining({
        id: placementId,
        action_id: actionId,
        horizon: 'day',
        period_key: '2026-08-06',
        period_start_date: '2026-08-06',
        period_end_date: '2026-08-06',
        sort_key: 'onboarding-01',
        archived_at: null,
        local_revision: 1,
      }),
    ]);
    expect(await rows(driver, 'week_selections')).toEqual([
      expect.objectContaining({
        id: weekSelectionId,
        profile_id: state.profileId,
        action_id: actionId,
        period_start_date: '2026-08-02',
        period_end_date: '2026-08-08',
        week_start: 'sunday',
        sort_key: 'onboarding-01',
        archived_at: null,
        local_revision: 1,
      }),
    ]);
    expect(await onboardingEventCount(driver, 'placement', placementId)).toBe(1);
    expect(await onboardingEventCount(driver, 'week_selection', weekSelectionId)).toBe(1);
    await expectReceiptMatchesEvents(driver, await latestReceipt(driver));
    await driver.close();
  });

  it('hazard 1: keeps a placement the person moved to another day and reordered', async () => {
    const { driver, onboarding, setNow, actions, planning, actionId, placementId, actionRevision } =
      await completedSetup();
    const day = { kind: 'day', date: '2026-08-10' } as const;
    accepted(
      await planning.place({
        target: { kind: 'action', id: actionId, revision: await actionRevision() },
        period: day,
      }),
    );
    accepted(
      await actions.capture(actions.newCaptureIntent('inbox'), { title: 'Book a reviewer' }),
    );
    const other = (await actions.listInbox({ limit: 10 })).items.find(
      (item) => item.title === 'Book a reviewer',
    );
    if (other === undefined) throw new Error('Missing captured Action');
    accepted(
      await planning.place({
        target: { kind: 'action', id: other.id, revision: other.localRevision },
        period: day,
      }),
    );
    accepted(
      await planning.reorderPlacement({
        placementId,
        revision: await revisionOf(driver, 'planning_placements', placementId),
        direction: 'up',
        scope: day,
      }),
    );
    const moved = await driver.get(
      'SELECT period_start_date, sort_key FROM planning_placements WHERE id = ?;',
      [placementId],
    );
    expect(moved).toEqual({ period_start_date: '2026-08-10', sort_key: '500000000000000' });
    const before = await planSnapshot(driver);

    setNow(laterSameWeek);
    const replay = await rerun(onboarding);

    expect(replay.status).toBe('completed');
    expect(replay.artifacts.placementId).toBe(placementId);
    await expectRerunLeftStarterPlanAlone(driver, before);
    const plan = await planning.getDayPlan('2026-08-10');
    expect(JSON.stringify(plan.day)).toContain(actionId);
    expect(JSON.stringify((await planning.getDayPlan('2026-08-08')).day)).not.toContain(actionId);
    await driver.close();
  });

  it('hazard 2: keeps a Month placement readable (no invalid_persisted_record)', async () => {
    const { driver, onboarding, setNow, actions, planning, state, actionId, actionRevision } =
      await completedSetup();
    accepted(
      await planning.place({
        target: { kind: 'action', id: actionId, revision: await actionRevision() },
        period: { kind: 'month', date: '2026-09-15' },
      }),
    );
    const before = await planSnapshot(driver);
    expect(before.placements).toEqual([
      expect.objectContaining({
        horizon: 'month',
        period_key: '2026-09',
        period_start_date: '2026-09-01',
        period_end_date: '2026-09-30',
      }),
    ]);

    setNow(laterSameWeek);
    await rerun(onboarding);

    await expectRerunLeftStarterPlanAlone(driver, before);
    const workspace = await new SqliteActionPlanningQueries(driver).getActionWorkspace(
      state.ownerId,
      actionId,
    );
    expect(workspace?.placement?.document).toMatchObject({
      period: { kind: 'month', month: '2026-09' },
    });
    const placements = await new SqlitePlanningQueries(driver).listPlacements(state.ownerId, {
      start: '2026-08-01' as CalendarDate,
      end: '2026-09-30' as CalendarDate,
    });
    expect(placements).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          kind: 'action',
          action: expect.objectContaining({ id: actionId }) as unknown,
        }) as unknown,
        period: { kind: 'month', month: '2026-09' },
      }),
    ]);
    expect((await actions.getAction(actionId))?.placement?.document).toMatchObject({
      period: { kind: 'month', month: '2026-09' },
    });
    const month = await planning.getMonthPlan('2026-09');
    expect(month.monthActions.map(({ id }) => id)).toEqual([actionId]);
    await driver.close();
  });

  it('hazard 3: keeps a Week placement as the whole week', async () => {
    const { driver, onboarding, setNow, planning, actionId, actionRevision } =
      await completedSetup();
    accepted(
      await planning.place({
        target: { kind: 'action', id: actionId, revision: await actionRevision() },
        period: { kind: 'week', date: '2026-08-12' },
      }),
    );
    const before = await planSnapshot(driver);
    expect(before.placements).toEqual([
      expect.objectContaining({
        horizon: 'week',
        period_start_date: '2026-08-09',
        period_end_date: '2026-08-15',
        week_start: 'sunday',
      }),
    ]);

    setNow(laterSameWeek);
    await rerun(onboarding);

    await expectRerunLeftStarterPlanAlone(driver, before);
    const week = await planning.getWeekPlan('2026-08-12');
    expect(week.weekActions.map(({ id }) => id)).toEqual([actionId]);
    await driver.close();
  });

  it('hazard 4: keeps a scheduled Action placement on its block day', async () => {
    const { driver, onboarding, setNow, actions, planning, actionId, actionRevision } =
      await completedSetup();
    accepted(
      await planning.scheduleAction({
        actionId,
        revision: await actionRevision(),
        date: '2026-08-10',
        startTime: '09:00',
        durationMinutes: 60,
        overlapAcknowledged: false,
      }),
    );
    const before = await planSnapshot(driver);
    expect(before.placements).toEqual([
      expect.objectContaining({ horizon: 'day', period_start_date: '2026-08-10' }),
    ]);
    expect(before.blocks).toEqual([
      expect.objectContaining({ action_id: actionId, state: 'planned' }),
    ]);

    setNow(laterSameWeek);
    await rerun(onboarding);

    await expectRerunLeftStarterPlanAlone(driver, before);
    expect((await actions.getAction(actionId))?.action.document).toMatchObject({
      state: 'scheduled',
    });
    await driver.close();
  });

  it('hazard 5: keeps the week commitment in its own week when setup is rerun a week later', async () => {
    const { driver, onboarding, setNow, planning, actionId, weekSelectionId } =
      await completedSetup();
    const before = await planSnapshot(driver);

    setNow(nextWeek);
    const replay = await rerun(onboarding);

    expect(replay.artifacts.weekSelectionId).toBe(weekSelectionId);
    await expectRerunLeftStarterPlanAlone(driver, before);
    const setupWeek = await planning.getWeekPlan('2026-08-06');
    expect(setupWeek.weekCommitments.map(({ id }) => id)).toEqual([weekSelectionId]);
    const laterWeek = await planning.getWeekPlan('2026-08-12');
    expect(JSON.stringify(laterWeek.weekCommitments)).not.toContain(actionId);
    await driver.close();
  });

  it('hazard 6: completes the rerun when the person already committed the Action to that week', async () => {
    const { driver, onboarding, setNow, planning, actionId } = await completedSetup();
    accepted(
      await planning.addWeekCommitment({
        weekDate: '2026-08-12',
        target: { kind: 'action', id: actionId },
      }),
    );
    const before = await planSnapshot(driver);
    expect(before.weeks.filter((row) => row['archived_at'] === null)).toHaveLength(2);

    setNow(nextWeek);
    const replay = await rerun(onboarding);

    expect(replay.status).toBe('completed');
    await expectRerunLeftStarterPlanAlone(driver, before);
    await driver.close();
  });

  it('hazard 7: keeps a removed placement and a removed week commitment as they are', async () => {
    const {
      driver,
      onboarding,
      setNow,
      actions,
      planning,
      actionId,
      weekSelectionId,
      actionRevision,
    } = await completedSetup();
    accepted(
      await planning.unplace({
        target: { kind: 'action', id: actionId, revision: await actionRevision() },
      }),
    );
    accepted(
      await planning.removeWeekCommitment({
        selectionId: weekSelectionId,
        revision: await revisionOf(driver, 'week_selections', weekSelectionId),
      }),
    );
    const before = await planSnapshot(driver);
    expect(before.placements).toEqual([
      expect.objectContaining({ period_start_date: '2026-08-06', archived_at: setupDay }),
    ]);
    expect(before.weeks).toEqual([
      expect.objectContaining({ period_start_date: '2026-08-02', archived_at: setupDay }),
    ]);

    setNow(nextWeek);
    await rerun(onboarding);

    await expectRerunLeftStarterPlanAlone(driver, before);
    expect((await actions.getAction(actionId))?.placement).toBeNull();
    await driver.close();
  });

  it('places a replacement starter Action under new ids after a permanent delete, never resurrecting', async () => {
    const { driver, onboarding, setNow, actions, actionId, placementId, weekSelectionId } =
      await completedSetup();
    const detail = await actions.getAction(actionId);
    if (detail === null) throw new Error('Missing starter Action');
    accepted(
      await actions.deletePermanently(actionId, detail.action.localRevision, starterActionTitle),
    );
    const ledger = await driver.all(
      `SELECT entity_type, entity_id FROM deletion_ledger
       WHERE entity_id IN (?, ?) ORDER BY entity_type;`,
      [placementId, weekSelectionId],
    );
    expect(ledger).toEqual([
      { entity_type: 'focus_selection', entity_id: weekSelectionId },
      { entity_type: 'planning_placement', entity_id: placementId },
    ]);

    setNow(nextWeek);
    // Setup asks for a first Action again, as the deleted one is gone.
    const replay = await rerun(onboarding, (draft) => ({
      ...draft,
      week: { ...draft.week, actionTitle: 'Outline the proposal again' },
    }));

    const next = replay.artifacts;
    expect(next.actionId).not.toBe(actionId);
    expect(next.placementId).not.toBe(placementId);
    expect(next.weekSelectionId).not.toBe(weekSelectionId);
    expect(await rows(driver, 'planning_placements')).toEqual([
      expect.objectContaining({
        id: next.placementId,
        action_id: next.actionId,
        horizon: 'day',
        period_start_date: '2026-08-12',
      }),
    ]);
    expect(await rows(driver, 'week_selections')).toEqual([
      expect.objectContaining({
        id: next.weekSelectionId,
        action_id: next.actionId,
        period_start_date: '2026-08-09',
        period_end_date: '2026-08-15',
      }),
    ]);
    await expect(
      driver.all(
        `SELECT entity_type, entity_id FROM deletion_ledger
         WHERE entity_id IN (?, ?) ORDER BY entity_type;`,
        [placementId, weekSelectionId],
      ),
    ).resolves.toEqual(ledger);
    expect(await onboardingEventCount(driver, 'placement', placementId)).toBe(1);
    expect(await onboardingEventCount(driver, 'placement', next.placementId)).toBe(1);
    expect(await onboardingEventCount(driver, 'week_selection', next.weekSelectionId)).toBe(1);
    await expectReceiptMatchesEvents(driver, await latestReceipt(driver));
    await driver.close();
  });

  it('first completion skips a placement id that is permanently deleted and a week id that is taken', async () => {
    const { placementId, weekSelectionId } = await firstCompletionArtifacts();
    if (placementId === undefined || weekSelectionId === undefined)
      throw new Error('Missing starter artifacts');
    const { driver, onboarding, initial } = await openOnboardingFixture();
    await ledgerDeletion(driver, initial.ownerId, 'planning_placement', placementId);
    // A week commitment of the person's own, holding the id setup would allocate.
    const ownAction = '32000000-0000-4000-8000-000000000001' as UUID;
    await driver.run(
      `INSERT INTO actions (id, owner_id, title, state, capture_origin, sort_key, created_at,
         updated_at, client_updated_at)
       VALUES (?, ?, 'Own Action', 'planned', 'plan', '000001000000000', ?, ?, ?);`,
      [ownAction, initial.ownerId, setupDay, setupDay, setupDay],
    );
    await driver.run(
      `INSERT INTO week_selections (id, owner_id, profile_id, action_id, period_start_date,
         period_end_date, week_start, sort_key, created_at, updated_at, client_updated_at)
       VALUES (?, ?, ?, ?, '2026-08-02', '2026-08-08', 'sunday', '000001000000000', ?, ?, ?);`,
      [
        weekSelectionId,
        initial.ownerId,
        initial.profileId,
        ownAction,
        setupDay,
        setupDay,
        setupDay,
      ],
    );
    const before = await planSnapshot(driver);

    const completed = await complete(onboarding);

    expect(completed.status).toBe('completed');
    expect(completed.artifacts).toMatchObject({ placementId, weekSelectionId });
    const after = await planSnapshot(driver);
    expect(after.placements).toEqual([]);
    expect(after.weeks).toEqual(before.weeks);
    expect(after.focus).toEqual([
      expect.objectContaining({ action_id: completed.artifacts.actionId }),
    ]);
    expect(await onboardingEventCount(driver, 'placement')).toBe(0);
    expect(await onboardingEventCount(driver, 'week_selection')).toBe(0);
    await expectReceiptMatchesEvents(driver, await latestReceipt(driver));
    await driver.close();
  });
});
