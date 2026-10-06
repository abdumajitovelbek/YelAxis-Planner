/**
 * account sync onboarding on an account plan: setup, its reruns, the progress resets, and the
 * Learn handbook commit locally first, and an account identity queues what each commit changed in
 * the same transaction: one outbox group with a create or update per changed record, parent first.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  createOnboardingApplication,
  type CanonicalRecordState,
  type CommandReceipt,
  type OnboardingCommand,
  type OnboardingCommit,
  type SyncStoredOperation,
} from '@yelaxis/application';
import {
  createEntityRef,
  type EntityRef,
  type EntityType,
  type OnboardingDraft,
  type UUID,
} from '@yelaxis/domain';

import type { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { SqliteSyncStore } from '../sync/sqlite-sync-store';
import { SqliteOnboardingPersistence } from './onboarding-adapter';
import { createSqliteApplicationAdapters } from './sqlite-adapters';
import {
  accountOwnerId,
  complete,
  expectReceiptMatchesEvents,
  firstCompletionArtifacts,
  latestReceipt,
  ledgerDeletion,
  onboardingDefaults,
  openOnboardingFixture,
  removeOnboardingFixtures,
  rerun,
  setupDay,
  setupDraft,
  starterActionTitle,
} from './testing/onboarding-fixture';

afterEach(removeOnboardingFixtures);

/** Setup with every kind of first-plan record: Context entries, a Constraint, and a commitment. */
function fullDraft(): OnboardingDraft {
  return {
    ...setupDraft(),
    context: {
      awakeWindow: { start: '07:00', end: '23:00' },
      availability: {
        label: 'Study time',
        weekdays: ['monday', 'wednesday'],
        start: '09:00',
        end: '12:00',
        strength: 'soft',
      },
      boundary: { text: 'Keep the evening unscheduled', strength: 'hard' },
    },
    week: {
      commitments: [
        {
          title: 'Planning session',
          date: '2026-08-06',
          start: '13:00',
          end: '14:00',
          strength: 'hard',
          confirmed: true,
        },
      ],
      actionTitle: starterActionTitle,
    },
  };
}

/** The first-plan records of `fullDraft()`, as setup writes them. */
const fullPlanTypes: readonly EntityType[] = [
  'axis',
  'outcome',
  'context',
  'context',
  'constraint',
  'context',
  'commitment',
  'time_block',
  'action',
  'planning_placement',
  'focus_selection',
  'focus_selection',
];

const ref = (type: EntityType, id: string): EntityRef =>
  createEntityRef(type, id as UUID, accountOwnerId);

/** Every operation still owed to the account, in local order, as the sync engine reads it. */
function queued(driver: NodeSqliteDriver): Promise<readonly SyncStoredOperation[]> {
  return new SqliteSyncStore(driver).runInTransaction(({ sync }) =>
    sync.scanOutbox(accountOwnerId, 0, 1000),
  );
}

/** The record already reached the account, at `serverRevision`. */
function reachedAccount(
  driver: NodeSqliteDriver,
  target: EntityRef,
  serverRevision: number,
): Promise<void> {
  return new SqliteSyncStore(driver).runInTransaction(({ sync }) =>
    sync.setRecordSyncBase(target, serverRevision, `${target.id}@${serverRevision}`),
  );
}

/** The account accepts every queued operation: each record is now at server revision 1. */
async function acknowledgeAll(driver: NodeSqliteDriver): Promise<void> {
  await new SqliteSyncStore(driver).runInTransaction(async ({ sync }) => {
    const operations = await sync.scanOutbox(accountOwnerId, 0, 1000);
    await sync.acknowledgeOperations(
      accountOwnerId,
      operations.map(({ operationId }) => operationId),
      setupDay,
    );
    for (const { entityType, entityId } of operations) {
      await sync.setRecordSyncBase(ref(entityType, entityId), 1, `${entityId}@1`);
    }
  });
}

/** A record as its canonical codec reads it. */
function read(driver: NodeSqliteDriver, target: EntityRef): Promise<CanonicalRecordState | null> {
  return createSqliteApplicationAdapters(driver).unitOfWork.runInTransaction((work) =>
    work.records.read(target),
  );
}

/** The latest receipt, read back through the strict receipt store of ordinary commands. */
async function storedReceipt(driver: NodeSqliteDriver): Promise<CommandReceipt | null> {
  const { commandId } = await latestReceipt(driver);
  return createSqliteApplicationAdapters(driver).unitOfWork.runInTransaction((work) =>
    work.receipts.find(accountOwnerId, commandId as UUID),
  );
}

async function counts(driver: NodeSqliteDriver): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of [
    'axes',
    'outcomes',
    'contexts',
    'constraints',
    'commitments',
    'time_blocks',
    'actions',
    'planning_placements',
    'focus_selections',
    'week_selections',
    'domain_events',
    'command_receipts',
    'sync_outbox',
  ]) {
    result[table] =
      (await driver.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table};`))?.count ?? -1;
  }
  return result;
}

describe('account sync onboarding on an account plan', () => {
  it('queues changed planning defaults and a create per new record in one group, parent first', async () => {
    const { driver, onboarding, initial } = await openOnboardingFixture({ identity: 'account' });
    await reachedAccount(driver, ref('profile', initial.profileId), 4);

    const completed = await complete(onboarding, {
      ...fullDraft(),
      defaults: { ...onboardingDefaults, planningTimeZone: 'Europe/London', timeFormat: '12_hour' },
    });

    const operations = await queued(driver);
    const receipt = await latestReceipt(driver);
    const group = operations[0]?.mutationGroupId;
    expect(operations.map(({ entityType, kind }) => [entityType, kind])).toEqual([
      ['profile', 'update'],
      ...fullPlanTypes.map((type) => [type, 'create']),
    ]);
    const { artifacts } = completed;
    expect(operations.map(({ entityId }) => entityId)).toEqual([
      initial.profileId,
      artifacts.axisIds[0],
      artifacts.outcomeId,
      artifacts.awakeContextId,
      artifacts.availabilityContextId,
      artifacts.availabilityConstraintId,
      artifacts.boundaryContextId,
      artifacts.commitments[0]?.commitmentId,
      artifacts.commitments[0]?.timeBlockId,
      artifacts.actionId,
      artifacts.placementId,
      artifacts.focusId,
      artifacts.weekSelectionId,
    ]);
    operations.forEach((operation, sequence) =>
      expect(operation).toMatchObject({
        mutationGroupId: group,
        commandId: receipt.commandId,
        actor: 'user',
        sequence,
        state: 'pending',
        attemptCount: 0,
        nextAttemptAt: setupDay,
      }),
    );
    expect(operations[0]).toMatchObject({
      expectedRevision: 1,
      baseServerRevision: 4,
      baseSnapshotHash: `${initial.profileId}@4`,
      document: { planningTimeZone: 'Europe/London', weekStart: 'sunday', timeFormat: '12_hour' },
    });
    for (const operation of operations.slice(1)) {
      expect(operation).toMatchObject({
        expectedRevision: null,
        baseServerRevision: 0,
        baseSnapshotHash: null,
      });
    }
    // Each operation carries the document its record codec reads back after the commit.
    for (const operation of operations) {
      const record = await read(driver, ref(operation.entityType, operation.entityId));
      expect(operation.document).toEqual(record?.document);
    }
    expect((await storedReceipt(driver))?.sync).toEqual({
      queued: true,
      mutationGroupId: group,
      operationIds: operations.map(({ operationId }) => operationId),
    });
    await expectReceiptMatchesEvents(driver, receipt);
    await driver.close();
  });

  it('queues a Profile update only for a setup step that changes the planning defaults', async () => {
    const { driver, onboarding, initial } = await openOnboardingFixture({ identity: 'account' });

    const started = await onboarding.execute({ kind: 'start', draft: initial.draft });

    expect(started.ok).toBe(true);
    expect(await queued(driver)).toEqual([]);
    expect((await storedReceipt(driver))?.sync).toEqual({ queued: false });

    const saved = await onboarding.execute({
      kind: 'save_step',
      step: 'defaults',
      draft: { ...initial.draft, defaults: { ...onboardingDefaults, weekStart: 'monday' } },
    });

    expect(saved.ok).toBe(true);
    const operations = await queued(driver);
    expect(operations).toEqual([
      expect.objectContaining({
        entityType: 'profile',
        entityId: initial.profileId,
        kind: 'update',
        expectedRevision: 2,
        baseServerRevision: 0,
        baseSnapshotHash: null,
        document: { planningTimeZone: 'Asia/Tashkent', weekStart: 'monday', timeFormat: '24_hour' },
      }),
    ]);
    expect((await storedReceipt(driver))?.sync).toEqual({
      queued: true,
      mutationGroupId: operations[0]?.mutationGroupId,
      operationIds: [operations[0]?.operationId],
    });
    await driver.close();
  });

  it('queues only the renamed starter Axis when setup is rerun, against the bases it read', async () => {
    const { driver, onboarding } = await openOnboardingFixture({ identity: 'account' });
    const completed = await complete(onboarding, fullDraft());
    expect(await queued(driver)).toHaveLength(fullPlanTypes.length);
    await acknowledgeAll(driver);
    const [axisId] = completed.artifacts.axisIds;
    const outcomeId = completed.artifacts.outcomeId;
    if (axisId === undefined || outcomeId === undefined) throw new Error('Missing starter records');
    await expect(read(driver, ref('axis', axisId))).resolves.toMatchObject({
      localRevision: 1,
      serverRevision: 1,
      baseSnapshotHash: `${axisId}@1`,
    });

    const replay = await rerun(onboarding, (draft) => ({ ...draft, axes: ['Study hard'] }));

    expect(replay.status).toBe('completed');
    expect(await queued(driver)).toEqual([
      expect.objectContaining({
        entityType: 'axis',
        entityId: axisId,
        kind: 'update',
        sequence: 0,
        expectedRevision: 1,
        baseServerRevision: 1,
        baseSnapshotHash: `${axisId}@1`,
        document: { title: 'Study hard', orderKey: 'onboarding-01', state: 'active' },
      }),
    ]);
    // The rerun rewrote the other first-plan rows too, but their documents did not change.
    await expect(read(driver, ref('outcome', outcomeId))).resolves.toMatchObject({
      localRevision: 2,
      serverRevision: 1,
    });
    await driver.close();
  });

  it('saves the Learn handbook, reruns, and resets progress without queueing anything', async () => {
    const { driver, onboarding, initial } = await openOnboardingFixture({ identity: 'account' });
    const profile = ref('profile', initial.profileId);
    await complete(onboarding, fullDraft());
    await acknowledgeAll(driver);
    await reachedAccount(driver, profile, 4);
    const commands: readonly OnboardingCommand[] = [
      { kind: 'save_handbook', status: 'in_progress', lesson: 1, completedLessons: [0] },
      { kind: 'reset_handbook' },
      { kind: 'rerun' },
      { kind: 'navigate', step: 'axes' },
      { kind: 'reset_onboarding' },
    ];

    for (const command of commands) {
      const result = await onboarding.execute(command);
      expect(result.ok).toBe(true);
      expect(await queued(driver)).toEqual([]);
      expect((await storedReceipt(driver))?.sync).toEqual({ queued: false });
    }

    expect(await onboarding.load()).toMatchObject({ status: 'not_started' });
    // Every command wrote the Profile row; its document and sync base stayed as they were.
    await expect(read(driver, profile)).resolves.toMatchObject({
      localRevision: 2 + commands.length,
      serverRevision: 4,
      baseSnapshotHash: `${initial.profileId}@4`,
      document: { planningTimeZone: 'Asia/Tashkent', weekStart: 'sunday', timeFormat: '24_hour' },
    });
    await driver.close();
  });

  it('queues nothing for a starter plan record that setup leaves out', async () => {
    const { placementId } = await firstCompletionArtifacts();
    if (placementId === undefined) throw new Error('Missing starter artifacts');
    const { driver, onboarding, initial } = await openOnboardingFixture({ identity: 'account' });
    await ledgerDeletion(driver, initial.ownerId, 'planning_placement', placementId);

    const completed = await complete(onboarding);

    expect(completed.artifacts.placementId).toBe(placementId);
    const operations = await queued(driver);
    expect(operations.map(({ entityType, entityId }) => [entityType, entityId])).toEqual([
      ['axis', completed.artifacts.axisIds[0]],
      ['outcome', completed.artifacts.outcomeId],
      ['action', completed.artifacts.actionId],
      ['focus_selection', completed.artifacts.focusId],
      ['focus_selection', completed.artifacts.weekSelectionId],
    ]);
    expect((await storedReceipt(driver))?.sync).toMatchObject({
      queued: true,
      operationIds: operations.map(({ operationId }) => operationId),
    });
    await driver.close();
  });

  it('leaves no record, event, receipt, or outbox row when the commit fails anywhere', async () => {
    const { driver, onboarding } = await openOnboardingFixture({ identity: 'account' });
    const empty = await counts(driver);
    expect(Object.values(empty).every((count) => count === 0)).toBe(true);

    for (const table of ['time_blocks', 'sync_outbox', 'domain_events', 'command_receipts']) {
      await driver.executeScript(`
        CREATE TRIGGER fail_onboarding_commit BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;
      `);
      const failed = await onboarding.execute({
        kind: 'complete',
        draft: fullDraft(),
        handbookStatus: 'skipped',
      });
      expect(failed.ok).toBe(false);
      expect(await counts(driver)).toEqual(empty);
      await expect(
        driver.get('SELECT onboarding_status, local_revision FROM profiles;'),
      ).resolves.toEqual({ onboarding_status: 'not_started', local_revision: 1 });
      await driver.executeScript('DROP TRIGGER fail_onboarding_commit;');
    }

    await complete(onboarding, fullDraft());
    expect(await queued(driver)).toHaveLength(fullPlanTypes.length);
    await driver.close();
  });

  it('returns early for a repeated command: no second group, event, or receipt', async () => {
    const { driver } = await openOnboardingFixture({ identity: 'account' });
    const persistence = new SqliteOnboardingPersistence(driver);
    const commits: OnboardingCommit[] = [];
    let id = 0;
    const onboarding = createOnboardingApplication(
      {
        initialize: (input) => persistence.initialize(input),
        load: () => persistence.load(),
        commit: (command) => {
          commits.push(command);
          return persistence.commit(command);
        },
      },
      {
        clock: { now: () => setupDay },
        ids: {
          next: () => {
            id += 1;
            return `61000000-0000-4000-8000-${id.toString(16).padStart(12, '0')}` as UUID;
          },
        },
      },
    );
    await complete(onboarding, fullDraft());
    const commit = commits.at(-1);
    if (commit === undefined) throw new Error('Missing commit');
    const committed = await counts(driver);
    expect(committed).toMatchObject({ command_receipts: 1, sync_outbox: fullPlanTypes.length });

    const replayed = await persistence.commit(commit);

    expect(replayed.status).toBe('completed');
    expect(await counts(driver)).toEqual(committed);
    await driver.close();
  });

  it('queues nothing for a local identity, and its receipts stay as they were', async () => {
    const { driver, onboarding, initial } = await openOnboardingFixture();
    await complete(onboarding, fullDraft());

    const saved = await onboarding.execute({
      kind: 'save_handbook',
      status: 'in_progress',
      lesson: 1,
      completedLessons: [0],
    });

    expect(saved.ok).toBe(true);
    expect(await counts(driver)).toMatchObject({ command_receipts: 2, sync_outbox: 0 });
    const row = await driver.get<{ command_id: string; receipt_payload_json: string }>(
      'SELECT command_id, receipt_payload_json FROM command_receipts ORDER BY rowid DESC LIMIT 1;',
    );
    const events = await driver.all<{ id: string }>(
      'SELECT id FROM domain_events WHERE command_id = ? ORDER BY sequence;',
      [row?.command_id ?? ''],
    );
    expect(row?.receipt_payload_json).toBe(
      JSON.stringify({
        commandId: row?.command_id,
        ownerId: initial.ownerId,
        actor: 'user',
        acceptedAt: setupDay,
        canonical: [
          {
            ref: { type: 'profile', id: initial.profileId, ownerId: initial.ownerId },
            localRevision: 3,
          },
        ],
        eventIds: events.map(({ id }) => id),
        undo: { available: false },
        sync: { queued: false },
      }),
    );
    await driver.close();
  });
});
