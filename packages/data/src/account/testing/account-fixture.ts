import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAccountApplication,
  createOnboardingApplication,
  executeCommand,
  type AccountApplication,
  type AccountStorePort,
  type ApplicationDependencies,
  type CanonicalMutation,
  type CanonicalRecordState,
  type CommandReceipt,
  type OnboardingApplication,
  type OnboardingState,
} from '@yelaxis/application';
import {
  alignmentLinkId,
  occurrenceLogicalKey,
  ok,
  routineOccurrenceId,
  type Clock,
  type EntityRef,
  type EntityType,
  type GeneratedOccurrencePeriod,
  type IdProvider,
  type Instant,
  type OnboardingDraft,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import { SqliteOnboardingPersistence } from '../../application/onboarding-adapter';
import { createSqliteApplicationAdapters } from '../../application/sqlite-adapters';
import { schemaMigrations } from '../../sqlite/migrations';
import { runMigrations } from '../../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../../sqlite/testing/node-driver.node';
import { CanonicalBundleCodec } from '../canonical-bundle';
import { profileReferenceTables } from '../owned-tables';
import { SqliteAccountStore } from '../sqlite-account-store';

/**
 * Real-SQLite fixture for identity, linking, export, and account lifecycle tests. Setup completes
 * on Monday 2026-09-28 at noon in Tashkent. Every id is deterministic and synthetic.
 */
export const fixtureStart = '2026-09-28T07:00:00.000Z' as Instant;
export const accountSubject = '5a000000-0000-4000-8000-000000000001';

type Document = Readonly<Record<string, unknown>>;

const temporaryDirectories: string[] = [];

/** Call from `afterEach`. */
export async function removeAccountFixtures(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}

export function setupDraft(): OnboardingDraft {
  return {
    identity: { preferredName: 'Sam', locale: 'en' },
    defaults: {
      planningTimeZone: 'Asia/Tashkent',
      weekStart: 'monday',
      timeFormat: '24_hour',
      locale: 'en',
    },
    context: {
      availability: {
        label: 'Study hours',
        weekdays: ['monday', 'wednesday'],
        start: '09:00',
        end: '12:00',
        strength: 'soft',
      },
      boundary: { text: 'No work after dinner', strength: 'hard' },
    },
    axes: ['Study', 'Health'],
    outcome: {
      title: 'Submit a clear proposal',
      successDefinition: 'The reviewer can decide without asking for missing information.',
      axisIndex: 0,
    },
    week: {
      commitments: [
        {
          title: 'Seminar',
          date: '2026-09-29',
          start: '10:00',
          end: '11:00',
          strength: 'hard',
          confirmed: true,
        },
      ],
      actionTitle: 'Draft the outline',
    },
  };
}

export function create(ref: EntityRef, document: Document): CanonicalMutation {
  return {
    operation: 'create',
    ref,
    expectedRevision: null,
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document,
  };
}

export function update(record: CanonicalRecordState, document: Document): CanonicalMutation {
  return {
    operation: 'update',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    document,
  };
}

export interface AccountFixture {
  readonly driver: NodeSqliteDriver;
  readonly databasePath: string;
  readonly ids: IdProvider;
  readonly clock: Clock;
  setNow(value: Instant): void;
  onboarding(): OnboardingApplication;
  store(): SqliteAccountStore;
  account(store?: AccountStorePort): AccountApplication;
  /** The one active identity's id. */
  ownerId(): Promise<OwnerId>;
  /** Commit mutations through the real command pipeline, as the current active identity. */
  commit(mutations: readonly CanonicalMutation[]): Promise<CommandReceipt>;
  read(ref: EntityRef): Promise<CanonicalRecordState | null>;
  readonly initialized: OnboardingState;
  /** Close and reopen the same database file, as a restart does. */
  reopen(): Promise<void>;
}

/** A migrated database with an initialized local identity and profile, before setup completes. */
export async function openAccountFixture(path?: string): Promise<AccountFixture> {
  let databasePath = path;
  if (databasePath === undefined) {
    const directory = await mkdtemp(join(tmpdir(), 'yelaxis-account-'));
    temporaryDirectories.push(directory);
    databasePath = join(directory, 'plan.sqlite');
  }
  let driver = new NodeSqliteDriver(databasePath);
  let now = fixtureStart;
  await runMigrations(driver, schemaMigrations, () => now);
  let counter = 1;
  const clock = { now: () => now };
  const ids = {
    next: () => {
      const suffix = counter.toString(16).padStart(12, '0');
      counter += 1;
      return `a0000000-0000-4000-8000-${suffix}` as UUID;
    },
  };

  const onboarding = () =>
    createOnboardingApplication(new SqliteOnboardingPersistence(driver), { clock, ids });
  const store = () => new SqliteAccountStore(driver);
  const account = (accountStore: AccountStorePort = store()): AccountApplication =>
    createAccountApplication({
      store: accountStore,
      bundles: new CanonicalBundleCodec(),
      clock,
      ids,
      appVersion: 'test',
    });

  const ownerId = async (): Promise<OwnerId> => {
    const result = await account().identity();
    if (!result.ok || result.value === null) throw new Error('No active identity');
    return result.value.id;
  };

  const commit = async (mutations: readonly CanonicalMutation[]): Promise<CommandReceipt> => {
    const owner = await ownerId();
    const dependencies: ApplicationDependencies = {
      ...createSqliteApplicationAdapters(driver),
      ids,
      clock,
      projections: { notifyCommitted() {} },
    };
    const result = await executeCommand(
      dependencies,
      {
        commandId: ids.next(),
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
            eventType: 'planning.test_changed',
            version: 1 as const,
            actor: context.actor,
            commandId: context.commandId,
            occurredAt: context.now,
            payload: { operation: mutation.operation },
          })),
        }),
    );
    if (!result.ok) throw new Error(`Commit failed: ${result.error.code}`);
    return result.value;
  };

  const read = async (ref: EntityRef) =>
    createSqliteApplicationAdapters(driver).unitOfWork.runInTransaction((work) =>
      work.records.read(ref),
    );

  const initialized = await onboarding().initialize({
    planningTimeZone: 'Asia/Tashkent',
    weekStart: 'monday',
    timeFormat: '24_hour',
    locale: 'en',
  });

  return {
    get driver() {
      return driver;
    },
    databasePath,
    ids,
    clock,
    setNow: (value: Instant) => {
      now = value;
    },
    onboarding,
    store,
    account,
    ownerId,
    commit,
    read,
    initialized,
    reopen: async () => {
      await driver.close();
      driver = new NodeSqliteDriver(databasePath);
      await runMigrations(driver, schemaMigrations, () => now);
    },
  };
}

export interface SeededPlan {
  readonly ownerId: OwnerId;
  readonly profileId: UUID;
  readonly ids: Readonly<Record<string, UUID>>;
}

/**
 * Completes setup and adds at least one live record of every canonical entity type, an unlinked
 * join row, a superseded Time Block chain, and a normal (not sensitive) Context entry.
 */
export async function seedEveryRecordType(fixture: AccountFixture): Promise<SeededPlan> {
  const completed = await fixture
    .onboarding()
    .execute({ kind: 'complete', draft: setupDraft(), handbookStatus: 'skipped' });
  if (!completed.ok) throw new Error(completed.message);
  const state = completed.value;
  const ownerId = state.ownerId;
  const profileId = state.profileId;
  const axisId = state.artifacts.axisIds[0];
  const outcomeId = state.artifacts.outcomeId;
  const actionId = state.artifacts.actionId;
  if (axisId === undefined || outcomeId === undefined || actionId === undefined) {
    throw new Error('Setup did not create its starter records');
  }
  const id = () => fixture.ids.next();
  const ref = <Type extends EntityType>(type: Type, value: UUID): EntityRef<Type> => ({
    type,
    id: value,
    ownerId,
  });
  const secondOutcomeId = id();
  const milestoneId = id();
  const projectId = id();
  const ids = {
    axisId,
    outcomeId,
    actionId,
    secondOutcomeId,
    milestoneId,
    projectId,
    noteId: id(),
    commitmentId: id(),
    templateId: id(),
    routineId: id(),
    defaultsId: id(),
    blockId: id(),
    supersedingBlockId: id(),
    canceledBlockId: id(),
    placementId: id(),
    focusId: id(),
    themeId: id(),
    directionId: id(),
    // Join rows have one derived id per pair.
    secondaryLinkId: alignmentLinkId('outcome_secondary_project', secondOutcomeId, projectId),
    milestoneProjectId: alignmentLinkId('milestone_project', milestoneId, projectId),
    milestoneActionId: alignmentLinkId('milestone_action', milestoneId, actionId),
    reviewId: id(),
    reviewItemId: id(),
    reminderId: id(),
  };
  const period = { kind: 'date', date: '2026-09-28' } as const;
  const occurrenceId = routineOccurrenceId(
    occurrenceLogicalKey(ids.routineId, 1, period as GeneratedOccurrencePeriod),
  );

  await fixture.commit([
    create(ref('outcome', ids.secondOutcomeId), {
      title: 'Stay rested',
      successDefinition: 'Seven calm nights in a row.',
      axisId,
      progress: { mode: 'none' },
      orderKey: 'b0',
      state: 'active',
    }),
    create(ref('milestone', ids.milestoneId), {
      title: 'Outline approved',
      measurableCheckpoint: 'The advisor signs off on the outline.',
      outcomeId,
      orderKey: 'a0',
      state: 'active',
    }),
    create(ref('project', ids.projectId), {
      title: 'Proposal draft',
      desiredResult: 'A complete first draft.',
      axisId,
      primaryOutcomeId: outcomeId,
      orderKey: 'a0',
      state: 'active',
    }),
    create(ref('note', ids.noteId), {
      title: 'Sources',
      body: 'Library list — نص عربي — 日本語',
      projectId: ids.projectId,
      orderKey: 'a0',
      state: 'active',
    }),
    create(ref('commitment', ids.commitmentId), {
      title: 'Dentist',
      strength: 'hard',
      state: 'planned',
    }),
    create(ref('template', ids.templateId), {
      title: 'Launch',
      blueprint: {
        version: 1,
        items: [{ templateKey: 'project', kind: 'project', title: 'Launch site' }],
      },
      state: 'active',
    }),
    create(ref('routine', ids.routineId), {
      title: 'Morning walk',
      orderKey: 'a0',
      state: 'active',
      generations: [
        {
          generation: 1,
          rule: {
            version: 1,
            kind: 'weekly_days',
            intervalWeeks: 1,
            weekdays: ['monday', 'wednesday'],
            startsOn: '2026-09-28',
          },
          schedulingMode: { kind: 'day_flexible' },
        },
      ],
    }),
  ]);
  await fixture.commit([
    create(ref('routine_action_defaults', ids.defaultsId), {
      routineId: ids.routineId,
      generation: 1,
      projectId: ids.projectId,
      estimateMinutes: 25,
    }),
    create(ref('routine_occurrence', occurrenceId), {
      routineId: ids.routineId,
      generation: 1,
      periodKey: '2026-09-28',
      period,
      state: 'planned',
    }),
    create(ref('time_block', ids.blockId), {
      target: { kind: 'action', actionId },
      startsAt: '2026-09-28T09:00:00.000Z',
      endsAt: '2026-09-28T10:00:00.000Z',
      timeZone: 'Asia/Tashkent',
      state: 'planned',
      overlapAcknowledged: false,
    }),
    create(ref('time_block', ids.canceledBlockId), {
      target: { kind: 'custom', title: 'Deep work' },
      startsAt: '2026-09-28T04:00:00.000Z',
      endsAt: '2026-09-28T05:00:00.000Z',
      timeZone: 'Asia/Tashkent',
      state: 'canceled',
      supersededById: ids.supersedingBlockId,
      overlapAcknowledged: false,
    }),
    create(ref('time_block', ids.supersedingBlockId), {
      target: { kind: 'custom', title: 'Deep work' },
      startsAt: '2026-09-28T05:00:00.000Z',
      endsAt: '2026-09-28T06:00:00.000Z',
      timeZone: 'Asia/Tashkent',
      state: 'planned',
      overlapAcknowledged: false,
    }),
    create(ref('planning_placement', ids.placementId), {
      target: { kind: 'project', projectId: ids.projectId },
      period: { kind: 'month', month: '2026-10' },
      orderKey: 'a0',
    }),
    create(ref('focus_selection', ids.focusId), {
      kind: 'day_focus',
      profileId,
      target: { kind: 'routine_occurrence', routineOccurrenceId: occurrenceId },
      periodStart: '2026-09-28',
      periodEnd: '2026-09-28',
      orderKey: 'b0',
    }),
    create(ref('theme', ids.themeId), { profileId, month: '2026-10', text: 'Fewer things' }),
    create(ref('direction', ids.directionId), { profileId, year: '2026', text: 'Build calmly' }),
    create(ref('project_secondary_outcome', ids.secondaryLinkId), {
      projectId: ids.projectId,
      outcomeId: ids.secondOutcomeId,
    }),
    create(ref('milestone_project', ids.milestoneProjectId), {
      milestoneId: ids.milestoneId,
      projectId: ids.projectId,
    }),
    // An unlinked join row is still a record (its `unlinkedAt`).
    create(ref('milestone_action', ids.milestoneActionId), {
      milestoneId: ids.milestoneId,
      actionId,
      unlinkedAt: fixtureStart,
    }),
    create(ref('review', ids.reviewId), {
      profileId,
      reviewType: 'daily',
      periodKey: '2026-09-28',
      periodStart: '2026-09-28',
      periodEnd: '2026-09-28',
      notes: 'A steady day',
      energy: 'medium',
      state: 'draft',
    }),
    create(ref('review_item', ids.reviewItemId), {
      reviewId: ids.reviewId,
      target: { kind: 'action', actionId },
      decision: 'carry',
      orderKey: 'a0',
    }),
    create(ref('reminder', ids.reminderId), {
      actionId,
      schedule: { kind: 'at', remindAt: '2026-09-28T08:45:00.000Z', timeZone: 'Asia/Tashkent' },
      state: 'scheduled',
    }),
  ]);
  // A normal Context entry beside the sensitive ones setup created.
  await fixture.driver.run(
    `INSERT INTO contexts (
       id, owner_id, category, context_key, value_text, source, sensitivity, strength,
       future_sharing_state, state, created_at, updated_at
     ) VALUES (?, ?, 'preferences', 'focus', 'Mornings', 'user', 'normal', 'soft', 'not_shared',
       'active', ?, ?);`,
    [id(), ownerId, fixtureStart, fixtureStart],
  );
  return { ownerId, profileId, ids };
}

/** Synthetic bookkeeping rows so every owned table holds at least one row of the owner. */
export async function seedBookkeeping(
  fixture: AccountFixture,
  ownerId: OwnerId,
  entity: { readonly type: EntityType; readonly id: UUID },
): Promise<void> {
  const run = (sql: string, values: readonly (string | number | null)[]) =>
    fixture.driver.run(sql, values);
  const at = fixtureStart;
  const id = () => fixture.ids.next();
  await run(
    `INSERT INTO undo_records (
       id, owner_id, command_id, state, descriptor_schema_version, descriptor_payload_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'available', 1, ?, ?, ?);`,
    [
      id(),
      ownerId,
      id(),
      JSON.stringify({
        commandType: 'planning.undo',
        payload: { title: 'Prior private title' },
        expectedRevisions: { [`${ownerId}:${entity.type}:${entity.id}`]: 2 },
      }),
      at,
      at,
    ],
  );
  const deletedId = id();
  await run(
    `INSERT INTO deletion_ledger (
       id, owner_id, entity_type, entity_id, local_revision, server_revision, deleted_at,
       created_at, updated_at
     ) VALUES (?, ?, 'action', ?, 2, 3, ?, ?, ?);`,
    [`${ownerId}:action:${deletedId}`, ownerId, deletedId, at, at, at],
  );
  await run(
    `INSERT INTO base_snapshots (
       id, owner_id, entity_type, entity_id, snapshot_hash, snapshot_schema_version,
       snapshot_payload_json, snapshot_server_revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'hash-1', 1, '{}', 1, ?, ?);`,
    [id(), ownerId, entity.type, entity.id, at, at],
  );
  const group = id();
  await run(
    `INSERT INTO sync_outbox (
       id, owner_id, operation_id, mutation_group_id, command_id, actor, sequence, entity_type,
       entity_id, operation_kind, expected_revision, document_schema_version,
       document_payload_json, base_server_revision, base_snapshot_hash, state, attempt_count,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'user', 0, 'action', ?, 'delete', 1, 1, ?, 1, 'hash-1',
       'pending', 0, ?, ?, ?);`,
    [
      'b0000000-0000-4000-8000-000000000001',
      ownerId,
      'b0000000-0000-4000-8000-000000000001',
      group,
      id(),
      deletedId,
      JSON.stringify({
        deletedAt: at,
        entityId: deletedId,
        entityType: 'action',
        ownerId,
        revision: 2,
      }),
      at,
      at,
      at,
    ],
  );
  await run(
    `INSERT INTO sync_conflicts (
       id, owner_id, entity_type, entity_id, conflict_kind, state, candidate_schema_version,
       candidate_payload_json, base_server_revision, remote_server_revision, created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, 'stale_base', 'open', 1, '{}', 1, 2, ?, ?);`,
    [id(), ownerId, entity.type, entity.id, at, at],
  );
  await run(
    `INSERT INTO sync_checkpoints (
       id, owner_id, replica_id, server_cursor, last_success_at, created_at, updated_at
     ) VALUES (?, ?, ?, '7', ?, ?, ?);`,
    [id(), ownerId, id(), at, at, at],
  );
  await run(
    `INSERT INTO account_deletion_state (id, owner_id, state, created_at, updated_at)
     VALUES (?, ?, 'none', ?, ?);`,
    [id(), ownerId, at, at],
  );
  await run(
    `INSERT INTO account_link_backups (
       id, owner_id, data_sha256, record_count, sync_was_pending, bundle_json, verified_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, 0, 0, '{}', ?, ?, ?);`,
    [id(), ownerId, 'c'.repeat(64), at, at, at],
  );
  await run(
    `INSERT INTO import_journal (id, owner_id, bundle_json, mode, decisions_json, remap_json, destination_digest, created_at, updated_at) VALUES (?, ?, '{}', 'merge', '[]', '{}', ?, ?, ?);`,
    [id(), ownerId, 'c'.repeat(64), at, at],
  );
  await run(
    `INSERT INTO import_recovery_backups (id, owner_id, bundle_json, data_sha256, record_count, verified_at, created_at, updated_at) VALUES (?, ?, '{}', ?, 0, ?, ?, ?);`,
    [id(), ownerId, 'c'.repeat(64), at, at, at],
  );
  await run(
    `INSERT INTO notification_preferences (owner_id, alerts_enabled, privacy_mode, updated_at) VALUES (?, 0, 1, ?);`,
    [ownerId, at],
  );
  await run(
    `INSERT INTO notification_receipts (owner_id, reminder_id, reminder_revision, occurrence_key, due_at, observed_at, delivery_status) VALUES (?, ?, 1, '', ?, ?, 'centre');`,
    [ownerId, entity.id, at, at],
  );
  await run(
    `INSERT INTO notification_routine_cursors (owner_id, reminder_id, reminder_revision, next_date) VALUES (?, ?, 1, '2026-10-03');`,
    [ownerId, entity.id],
  );
}

/**
 * Every `table.column` of the whole schema with a value that contains `text`, sorted: a schema-wide
 * search for an id, including JSON columns, so a new place that names it cannot be missed.
 */
export async function columnsNaming(
  fixture: AccountFixture,
  text: string,
): Promise<readonly string[]> {
  const tables = await fixture.driver.all<{ name: string }>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
  );
  const found: string[] = [];
  for (const { name: table } of tables) {
    for (const { name: column } of await fixture.driver.all<{ name: string }>(
      `PRAGMA table_info(${table});`,
    )) {
      const row = await fixture.driver.get<{ found: number }>(
        `SELECT 1 AS found FROM ${table} WHERE instr(CAST(${column} AS TEXT), ?) > 0 LIMIT 1;`,
        [text],
      );
      if (row !== undefined) found.push(`${table}.${column}`);
    }
  }
  return found.sort();
}

/**
 * Rows of `ownerId` that name `profileId`, by table: the Profile, every record that refers to it,
 * its events, and the receipts that list it.
 */
export async function profileNamingRows(
  fixture: AccountFixture,
  ownerId: string,
  profileId: string,
): Promise<Record<string, number>> {
  const count = async (sql: string) =>
    (await fixture.driver.get<{ count: number }>(sql, [ownerId, profileId]))?.count ?? -1;
  const rows: Record<string, number> = {
    profiles: await count('SELECT COUNT(*) AS count FROM profiles WHERE owner_id = ? AND id = ?;'),
  };
  for (const table of profileReferenceTables) {
    rows[table] = await count(
      `SELECT COUNT(*) AS count FROM ${table} WHERE owner_id = ? AND profile_id = ?;`,
    );
  }
  rows['domain_events'] = await count(
    `SELECT COUNT(*) AS count FROM domain_events
     WHERE owner_id = ? AND entity_type = 'profile' AND entity_id = ?;`,
  );
  rows['command_receipts'] = await count(
    `SELECT COUNT(*) AS count FROM command_receipts
     WHERE owner_id = ? AND instr(receipt_payload_json, ?) > 0;`,
  );
  return rows;
}

/** Rows of `table` owned by `ownerId`. */
export async function ownedRows(
  fixture: AccountFixture,
  table: string,
  ownerId: string,
): Promise<number> {
  const row = await fixture.driver.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE owner_id = ?;`,
    [ownerId],
  );
  return row?.count ?? -1;
}
