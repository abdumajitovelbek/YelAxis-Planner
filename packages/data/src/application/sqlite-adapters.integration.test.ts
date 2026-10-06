import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeCommand,
  type ApplicationDependencies,
  type CanonicalMutation,
  type CommandEnvelope,
  type CommandHandler,
  type PlanningUnitOfWork,
  type ProjectionInvalidation,
} from '@yelaxis/application';
import {
  entityRefKey,
  ok,
  type CommandId,
  type DomainChange,
  type EntityRef,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { actionCanonicalDocumentSchema, type ActionCanonicalDocument } from './action-codec';
import type { TimeBlockDocument } from './planning-codecs';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

const now = '2026-07-23T09:00:00.000Z' as Instant;
const later = '2026-07-24T09:00:00.000Z' as Instant;
const localOwnerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const accountOwnerId = '10000000-0000-4000-8000-000000000002' as OwnerId;
const actionId = '20000000-0000-4000-8000-000000000001' as EntityRef<'action'>['id'];
const secondActionId = '20000000-0000-4000-8000-000000000002' as EntityRef<'action'>['id'];
const commandId = '30000000-0000-4000-8000-000000000001' as CommandId;
const temporaryDirectories: string[] = [];

interface CreateActionInput {
  readonly ref: EntityRef<'action'>;
  readonly document: ActionCanonicalDocument;
}

interface CompleteActionsInput {
  readonly refs: readonly EntityRef<'action'>[];
}

interface DeleteActionInput {
  readonly ref: EntityRef<'action'>;
  readonly expectedRevision: number;
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-adapter-'));
  temporaryDirectories.push(directory);
  return join(directory, 'plan.sqlite');
}

async function openMigratedDatabase(path: string): Promise<NodeSqliteDriver> {
  const driver = new NodeSqliteDriver(path);
  await runMigrations(driver, schemaMigrations, () => now);
  return driver;
}

async function insertIdentity(
  driver: NodeSqliteDriver,
  ownerId: OwnerId,
  kind: 'account' | 'local',
): Promise<void> {
  await driver.run(
    `INSERT INTO planning_identities (
       id, identity_kind, account_subject_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?);`,
    [ownerId, kind, kind === 'account' ? 'account-subject' : null, now, now],
  );
}

async function insertAction(
  driver: NodeSqliteDriver,
  ref: EntityRef<'action'>,
  title: string,
  sortKey: string,
  note: string | null = null,
): Promise<void> {
  await driver.run(
    `INSERT INTO actions (
       id, owner_id, title, note_text, state, capture_origin, sort_key, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'planned', 'global_capture', ?, ?, ?);`,
    [ref.id, ref.ownerId, title, note, sortKey, now, now],
  );
}

async function seedSettledDeleteSupport(
  driver: NodeSqliteDriver,
  actionRef: EntityRef<'action'>,
  privateMarker: string,
): Promise<void> {
  const suffix = actionRef.ownerId.at(-1) ?? 'x';
  await driver.run(
    `INSERT INTO base_snapshots (
       id, owner_id, entity_type, entity_id, snapshot_hash, snapshot_schema_version,
       snapshot_payload_json, snapshot_server_revision, created_at, updated_at
     ) VALUES (?, ?, 'action', ?, ?, 1, ?, 0, ?, ?);`,
    [
      `snapshot-${suffix}`,
      actionRef.ownerId,
      actionRef.id,
      `hash-${suffix}`,
      JSON.stringify({ title: privateMarker }),
      now,
      now,
    ],
  );
  await driver.run(
    `INSERT INTO sync_outbox (
       id, owner_id, operation_id, mutation_group_id, command_id, actor, sequence,
       entity_type, entity_id, operation_kind, expected_revision, document_schema_version,
       document_payload_json, base_server_revision, base_snapshot_hash, state, attempt_count,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'user', 0, 'action', ?, 'update', 1, 1, ?, 0, NULL,
               'acknowledged', 0, NULL, ?, ?);`,
    [
      `outbox-${suffix}`,
      actionRef.ownerId,
      `operation-${suffix}`,
      `group-${suffix}`,
      `old-command-${suffix}`,
      actionRef.id,
      JSON.stringify({ title: privateMarker }),
      now,
      now,
    ],
  );
  await driver.run(
    `INSERT INTO sync_conflicts (
       id, owner_id, entity_type, entity_id, conflict_kind, state, candidate_schema_version,
       candidate_payload_json, base_server_revision, remote_server_revision, created_at, updated_at
     ) VALUES (?, ?, 'action', ?, 'concurrent_update', 'resolved', 1, ?, 0, 1, ?, ?);`,
    [
      `conflict-${suffix}`,
      actionRef.ownerId,
      actionRef.id,
      JSON.stringify({ title: privateMarker }),
      now,
      now,
    ],
  );
  await driver.run(
    `INSERT INTO undo_records (
       id, owner_id, command_id, state, descriptor_schema_version, descriptor_payload_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'available', 1, ?, ?, ?);`,
    [
      `undo-${suffix}`,
      actionRef.ownerId,
      `undo-command-${suffix}`,
      JSON.stringify({
        commandType: 'private_previous_change',
        payload: { title: privateMarker },
        expectedRevisions: { [entityRefKey(actionRef)]: 1 },
      }),
      now,
      now,
    ],
  );
  await driver.run(
    `INSERT INTO domain_events (
       id, owner_id, command_id, sequence, actor, event_type, entity_type, entity_id,
       payload_schema_version, payload_json, occurred_at, created_at, updated_at
     ) VALUES (?, ?, ?, 0, 'user', 'action.private_changed', 'action', ?, 1, ?, ?, ?, ?);`,
    [
      `event-${suffix}`,
      actionRef.ownerId,
      `event-command-${suffix}`,
      actionRef.id,
      JSON.stringify({ title: privateMarker }),
      now,
      now,
      now,
    ],
  );
}

async function seedBlockingDeleteSupport(
  driver: NodeSqliteDriver,
  actionRef: EntityRef<'action'>,
  privateMarker: string,
): Promise<void> {
  await driver.run(
    `INSERT INTO sync_outbox (
       id, owner_id, operation_id, mutation_group_id, command_id, actor, sequence,
       entity_type, entity_id, operation_kind, expected_revision, document_schema_version,
       document_payload_json, base_server_revision, base_snapshot_hash, state, attempt_count,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'user', 0, 'action', ?, 'update', 1, 1, ?, 0, NULL,
               'pending', 0, ?, ?, ?);`,
    [
      'blocking-outbox',
      actionRef.ownerId,
      'blocking-operation',
      'blocking-group',
      'blocking-command',
      actionRef.id,
      JSON.stringify({ title: privateMarker }),
      now,
      now,
      now,
    ],
  );
  await driver.run(
    `INSERT INTO sync_conflicts (
       id, owner_id, entity_type, entity_id, conflict_kind, state, candidate_schema_version,
       candidate_payload_json, base_server_revision, remote_server_revision, created_at, updated_at
     ) VALUES (?, ?, 'action', ?, 'concurrent_update', 'open', 1, ?, 0, 1, ?, ?);`,
    [
      'blocking-conflict',
      actionRef.ownerId,
      actionRef.id,
      JSON.stringify({ title: privateMarker }),
      now,
      now,
    ],
  );
}

function ref(ownerId: OwnerId, id = actionId): EntityRef<'action'> {
  return { type: 'action', id, ownerId };
}

function idProvider(values: readonly UUID[]): ApplicationDependencies['ids'] {
  let index = 0;
  return {
    next() {
      const value = values[index];
      if (value === undefined) throw new Error('Deterministic ID sequence exhausted');
      index += 1;
      return value;
    },
  };
}

function dependencies(
  driver: NodeSqliteDriver,
  ids: readonly UUID[],
  clockValue: Instant = now,
): ApplicationDependencies & { readonly notifications: ProjectionInvalidation[] } {
  const adapters = createSqliteApplicationAdapters(driver);
  const notifications: ProjectionInvalidation[] = [];
  return {
    ...adapters,
    clock: { now: () => clockValue },
    ids: idProvider(ids),
    projections: {
      notifyCommitted(invalidation) {
        notifications.push(invalidation);
      },
    },
    notifications,
  };
}

function createEnvelope(input: CreateActionInput): CommandEnvelope<CreateActionInput> {
  return {
    commandId,
    ownerId: input.ref.ownerId,
    actor: 'user',
    expectedRevisions: [],
    input,
  };
}

function createActionHandler(): CommandHandler<CreateActionInput> {
  return ({ input, context }) =>
    ok({
      value: [
        {
          ref: input.ref,
          operation: 'create',
          expectedRevision: null,
          baseServerRevision: 0,
          baseSnapshotHash: null,
          document: input.document,
        },
      ],
      events: [
        {
          aggregate: input.ref,
          eventType: 'action.created',
          version: 1,
          actor: context.actor,
          commandId: context.commandId,
          occurredAt: context.now,
          payload: { state: input.document.state },
        },
      ],
      undo: {
        commandType: 'create_action',
        version: 1,
        payload: { actionId: input.ref.id },
        expectedRevisions: { [entityRefKey(input.ref)]: 1 },
      },
      touched: [input.ref],
    });
}

function completeActionsHandler(): CommandHandler<CompleteActionsInput> {
  return async ({ input, context, records }) => {
    const mutations: CanonicalMutation[] = [];
    const events: DomainChange<unknown>['events'][number][] = [];
    const expectedRevisions: Record<string, number> = {};

    for (const actionRef of input.refs) {
      const current = await records.read(actionRef);
      if (current === null) throw new Error('Synthetic missing action');
      const document = actionCanonicalDocumentSchema.safeParse(current.document);
      if (!document.success) throw new Error('Synthetic invalid action');
      mutations.push({
        ref: actionRef,
        operation: 'update',
        expectedRevision: current.localRevision,
        baseServerRevision: current.serverRevision,
        baseSnapshotHash: current.baseSnapshotHash,
        document: { ...document.data, state: 'completed', completedAt: context.now },
      });
      events.push({
        aggregate: actionRef,
        eventType: 'action.completed',
        version: 1,
        actor: context.actor,
        commandId: context.commandId,
        occurredAt: context.now,
        payload: { state: 'completed' },
      });
      expectedRevisions[entityRefKey(actionRef)] = current.localRevision + 1;
    }

    return ok({
      value: mutations,
      events,
      undo: {
        commandType: 'complete_actions',
        version: 1,
        payload: { count: input.refs.length },
        expectedRevisions,
      },
      touched: input.refs,
    });
  };
}

function deleteActionHandler(): CommandHandler<DeleteActionInput> {
  return async ({ input, context, records }) => {
    const current = await records.read(input.ref);
    if (current === null) throw new Error('Synthetic missing action');
    return ok({
      value: [
        {
          ref: input.ref,
          operation: 'delete',
          expectedRevision: input.expectedRevision,
          baseServerRevision: current.serverRevision,
          baseSnapshotHash: current.baseSnapshotHash,
          tombstone: {
            ownerId: input.ref.ownerId,
            entityType: input.ref.type,
            entityId: input.ref.id,
            revision: input.expectedRevision + 1,
            deletedAt: context.now,
          },
        },
      ],
      events: [
        {
          aggregate: input.ref,
          eventType: 'action.deleted',
          version: 1,
          actor: context.actor,
          commandId: context.commandId,
          occurredAt: context.now,
          payload: { revision: input.expectedRevision + 1 },
        },
      ],
      touched: [input.ref],
    });
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('SQLite application adapters', () => {
  it('atomically creates a local Action with audit, undo, and receipt and replays after reopen', async () => {
    const path = await temporaryDatabasePath();
    const driver = await openMigratedDatabase(path);
    await insertIdentity(driver, localOwnerId, 'local');
    const actionRef = ref(localOwnerId);
    const input: CreateActionInput = {
      ref: actionRef,
      document: {
        title: 'Private first plan',
        captureOrigin: 'onboarding',
        orderKey: 'a',
        state: 'planned',
      },
    };
    const generatedIds = [
      '40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000002',
    ] as UUID[];
    const firstDependencies = dependencies(driver, generatedIds);

    const first = await executeCommand(
      firstDependencies,
      createEnvelope(input),
      createActionHandler(),
    );
    expect(first).toEqual({
      ok: true,
      value: {
        commandId,
        ownerId: localOwnerId,
        actor: 'user',
        acceptedAt: now,
        canonical: [{ ref: actionRef, localRevision: 1 }],
        eventIds: [generatedIds[0]],
        undo: { available: true, undoId: generatedIds[1] },
        sync: { queued: false },
      },
    });
    expect(firstDependencies.notifications).toHaveLength(1);
    await expect(
      driver.get<{ state: string; local_revision: number; capture_origin: string }>(
        `SELECT state, local_revision, capture_origin FROM actions
         WHERE owner_id = ? AND id = ?;`,
        [localOwnerId, actionId],
      ),
    ).resolves.toEqual({ state: 'planned', local_revision: 1, capture_origin: 'onboarding' });
    await expect(tableCounts(driver)).resolves.toEqual({
      actions: 1,
      domain_events: 1,
      undo_records: 1,
      command_receipts: 1,
      sync_outbox: 0,
    });
    await driver.close();

    const reopened = await openMigratedDatabase(path);
    let replayHandlerCalls = 0;
    const replayDependencies = dependencies(reopened, [], later);
    const replay = await executeCommand(replayDependencies, createEnvelope(input), () => {
      replayHandlerCalls += 1;
      throw new Error('Private first plan');
    });
    expect(replay).toEqual(first);
    expect(replayHandlerCalls).toBe(0);
    expect(replayDependencies.notifications).toHaveLength(0);
    await expect(tableCounts(reopened)).resolves.toEqual({
      actions: 1,
      domain_events: 1,
      undo_records: 1,
      command_receipts: 1,
      sync_outbox: 0,
    });
    await reopened.close();
  });

  it('rolls back canonical and support writes on a real SQL failure without leaking content', async () => {
    const driver = await openMigratedDatabase(await temporaryDatabasePath());
    await insertIdentity(driver, localOwnerId, 'local');
    await driver.executeScript(`
      CREATE TRIGGER fail_domain_event_insert
      BEFORE INSERT ON domain_events
      BEGIN
        SELECT RAISE(ABORT, 'synthetic event failure');
      END;
    `);
    const privateTitle = 'Never expose this planning title';
    const input: CreateActionInput = {
      ref: ref(localOwnerId),
      document: {
        title: privateTitle,
        captureOrigin: 'onboarding',
        orderKey: 'a',
        state: 'planned',
      },
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await executeCommand(
      dependencies(driver, [
        '40000000-0000-4000-8000-000000000011' as UUID,
        '40000000-0000-4000-8000-000000000012' as UUID,
      ]),
      createEnvelope(input),
      createActionHandler(),
    );

    expect(result).toEqual({ ok: false, error: { code: 'transaction_failed' } });
    expect(JSON.stringify(result)).not.toContain(privateTitle);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    await expect(tableCounts(driver)).resolves.toEqual({
      actions: 0,
      domain_events: 0,
      undo_records: 0,
      command_receipts: 0,
      sync_outbox: 0,
    });
    await driver.close();
  });

  it('rejects invalid Action documents before any canonical or support write', async () => {
    const driver = await openMigratedDatabase(await temporaryDatabasePath());
    await insertIdentity(driver, localOwnerId, 'local');
    const privateTitle = 'Invalid private planning title';
    const base = {
      title: privateTitle,
      captureOrigin: 'onboarding',
      orderKey: 'a',
      state: 'planned',
    } as const;
    const invalidDocuments = [
      { ...base, captureOrigin: 'unsupported-origin' },
      { ...base, due: { kind: 'date', date: '2026-02-30' } },
      {
        ...base,
        due: {
          kind: 'instant',
          instant: '2026-07-23T09:00:00Z',
          authoredTimeZone: 'Asia/Tashkent',
        },
      },
      {
        ...base,
        due: {
          kind: 'instant',
          instant: now,
          authoredTimeZone: 'Not/AZone',
        },
      },
      { ...base, orderKey: '   ' },
      { ...base, state: 'archived', archivedAt: now },
      { ...base, state: 'completed' },
      {
        ...base,
        convertedTo: { type: 'note', id: secondActionId },
      },
    ];

    for (const document of invalidDocuments) {
      const input: CreateActionInput = {
        ref: ref(localOwnerId),
        document: document as unknown as ActionCanonicalDocument,
      };
      const result = await executeCommand(
        dependencies(driver, []),
        createEnvelope(input),
        createActionHandler(),
      );
      expect(result).toEqual({ ok: false, error: { code: 'transaction_failed' } });
      expect(JSON.stringify(result)).not.toContain(privateTitle);
    }
    await expect(tableCounts(driver)).resolves.toEqual({
      actions: 0,
      domain_events: 0,
      undo_records: 0,
      command_receipts: 0,
      sync_outbox: 0,
    });
    await driver.close();
  });

  it('leaves every row unchanged when permanent delete has pending sync or an open conflict', async () => {
    const driver = await openMigratedDatabase(await temporaryDatabasePath());
    await insertIdentity(driver, accountOwnerId, 'account');
    const actionRef = ref(accountOwnerId);
    const privateMarker = 'Blocked private marker';
    await insertAction(driver, actionRef, privateMarker, 'a', privateMarker);
    await seedBlockingDeleteSupport(driver, actionRef, privateMarker);
    const envelope: CommandEnvelope<DeleteActionInput> = {
      commandId,
      ownerId: accountOwnerId,
      actor: 'user',
      expectedRevisions: [{ ref: actionRef, revision: 1 }],
      input: { ref: actionRef, expectedRevision: 1 },
    };
    const before = await deleteBlockingSnapshot(driver);

    const result = await executeCommand(dependencies(driver, []), envelope, deleteActionHandler());

    expect(result).toEqual({ ok: false, error: { code: 'transaction_failed' } });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    await expect(deleteBlockingSnapshot(driver)).resolves.toEqual(before);
    await driver.close();
  });

  it('rejects a deletion tombstone carrying a private field at the data boundary with zero writes', async () => {
    const driver = await openMigratedDatabase(await temporaryDatabasePath());
    await insertIdentity(driver, localOwnerId, 'local');
    const actionRef = ref(localOwnerId);
    const privateMarker = 'Private title must never enter a tombstone';
    await insertAction(driver, actionRef, privateMarker, 'a', privateMarker);
    const tombstone = {
      ownerId: actionRef.ownerId,
      entityType: actionRef.type,
      entityId: actionRef.id,
      revision: 2,
      deletedAt: now,
      privateTitle: privateMarker,
    };
    const mutation: CanonicalMutation = {
      ref: actionRef,
      operation: 'delete',
      expectedRevision: 1,
      baseServerRevision: 0,
      baseSnapshotHash: null,
      tombstone,
    };
    const before = {
      blocking: await deleteBlockingSnapshot(driver),
      counts: await tableCounts(driver),
      baseSnapshots: await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM base_snapshots;',
      ),
    };

    const { unitOfWork } = createSqliteApplicationAdapters(driver);
    let failure: unknown;
    try {
      await unitOfWork.runInTransaction(async ({ records }) => {
        await records.apply(mutation, {
          ownerId: localOwnerId,
          actor: 'user',
          commandId,
          now,
        });
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'write_conflict',
      message: 'YelAxis Planner data operation failed.',
    });
    expect(JSON.stringify(failure)).not.toContain(privateMarker);
    await expect(
      Promise.all([
        deleteBlockingSnapshot(driver),
        tableCounts(driver),
        driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM base_snapshots;'),
      ]),
    ).resolves.toEqual([before.blocking, before.counts, before.baseSnapshots]);
    await driver.close();
  });

  it.each([
    { kind: 'local' as const, ownerId: localOwnerId, queued: false },
    { kind: 'account' as const, ownerId: accountOwnerId, queued: true },
  ])('physically removes $kind Action content and persists only a tombstone', async (scenario) => {
    const path = await temporaryDatabasePath();
    const driver = await openMigratedDatabase(path);
    await insertIdentity(driver, scenario.ownerId, scenario.kind);
    const actionRef = ref(scenario.ownerId);
    const privateTitle = `Private ${scenario.kind} title`;
    const privateNote = `Private ${scenario.kind} note`;
    await insertAction(driver, actionRef, privateTitle, 'a', privateNote);
    await seedSettledDeleteSupport(driver, actionRef, privateTitle);
    const input: DeleteActionInput = { ref: actionRef, expectedRevision: 1 };
    const envelope: CommandEnvelope<DeleteActionInput> = {
      commandId,
      ownerId: scenario.ownerId,
      actor: 'user',
      expectedRevisions: [{ ref: actionRef, revision: 1 }],
      input,
    };
    const generatedIds = [
      '40000000-0000-4000-8000-000000000031',
      '40000000-0000-4000-8000-000000000032',
      '40000000-0000-4000-8000-000000000033',
    ] as UUID[];

    const result = await executeCommand(
      dependencies(driver, generatedIds),
      envelope,
      deleteActionHandler(),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        canonical: [{ ref: actionRef, localRevision: 2 }],
        eventIds: [generatedIds[0]],
        undo: { available: false },
        sync: scenario.queued
          ? {
              queued: true,
              mutationGroupId: generatedIds[1],
              operationIds: [generatedIds[2]],
            }
          : { queued: false },
      },
    });
    await expect(
      driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM actions WHERE owner_id = ? AND id = ?;',
        [scenario.ownerId, actionRef.id],
      ),
    ).resolves.toEqual({ count: 0 });
    await expect(
      driver.get<{
        entity_type: string;
        entity_id: string;
        local_revision: number;
        deleted_at: string;
      }>(
        `SELECT entity_type, entity_id, local_revision, deleted_at
         FROM deletion_ledger WHERE owner_id = ? AND entity_id = ?;`,
        [scenario.ownerId, actionRef.id],
      ),
    ).resolves.toEqual({
      entity_type: 'action',
      entity_id: actionRef.id,
      local_revision: 2,
      deleted_at: now,
    });
    const persistedPayloads = await driver.all<{ payload: string }>(
      `SELECT payload_json AS payload FROM domain_events WHERE owner_id = ?
       UNION ALL
       SELECT receipt_payload_json AS payload FROM command_receipts WHERE owner_id = ?
       UNION ALL
       SELECT document_payload_json AS payload FROM sync_outbox WHERE owner_id = ?
       UNION ALL
       SELECT descriptor_payload_json AS payload FROM undo_records WHERE owner_id = ?;`,
      [scenario.ownerId, scenario.ownerId, scenario.ownerId, scenario.ownerId],
    );
    expect(JSON.stringify(persistedPayloads)).not.toContain(privateTitle);
    expect(JSON.stringify(persistedPayloads)).not.toContain(privateNote);
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM base_snapshots;'),
    ).resolves.toEqual({ count: 0 });
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM sync_conflicts;'),
    ).resolves.toEqual({ count: 0 });
    await expect(
      driver.get<{ state: string; descriptor_payload_json: string }>(
        'SELECT state, descriptor_payload_json FROM undo_records;',
      ),
    ).resolves.toEqual({
      state: 'expired',
      descriptor_payload_json:
        '{"commandType":"redacted_for_permanent_delete","payload":{},"expectedRevisions":{}}',
    });
    if (scenario.queued) {
      const outbox = await driver.get<{ document_payload_json: string }>(
        `SELECT document_payload_json FROM sync_outbox
         WHERE owner_id = ? AND entity_id = ?;`,
        [scenario.ownerId, actionRef.id],
      );
      expect(JSON.parse(outbox?.document_payload_json ?? 'null')).toEqual({
        ownerId: scenario.ownerId,
        entityType: 'action',
        entityId: actionRef.id,
        revision: 2,
        deletedAt: now,
      });
    } else {
      await expect(
        driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM sync_outbox;'),
      ).resolves.toEqual({ count: 0 });
    }
    await driver.close();

    const reopened = await openMigratedDatabase(path);
    await expect(
      reopened.get<{ count: number }>('SELECT COUNT(*) AS count FROM actions;'),
    ).resolves.toEqual({ count: 0 });
    await expect(
      reopened.get<{ count: number }>('SELECT COUNT(*) AS count FROM deletion_ledger;'),
    ).resolves.toEqual({ count: 1 });
    const recreateInput: CreateActionInput = {
      ref: actionRef,
      document: {
        title: 'Attempted resurrection',
        captureOrigin: 'global_capture',
        orderKey: 'a',
        state: 'planned',
      },
    };
    const recreateEnvelope: CommandEnvelope<CreateActionInput> = {
      ...createEnvelope(recreateInput),
      commandId: '30000000-0000-4000-8000-000000000002' as CommandId,
    };
    const supportCountsBeforeRecreate = await tableCounts(reopened);
    const recreateIds = [
      '40000000-0000-4000-8000-000000000051',
      '40000000-0000-4000-8000-000000000052',
      '40000000-0000-4000-8000-000000000053',
      '40000000-0000-4000-8000-000000000054',
    ] as UUID[];
    await expect(
      executeCommand(dependencies(reopened, recreateIds), recreateEnvelope, createActionHandler()),
    ).resolves.toEqual({ ok: false, error: { code: 'transaction_failed' } });
    await expect(
      reopened.get<{ count: number }>('SELECT COUNT(*) AS count FROM actions;'),
    ).resolves.toEqual({ count: 0 });
    await expect(tableCounts(reopened)).resolves.toEqual(supportCountsBeforeRecreate);
    await expect(
      reopened.get<{ count: number }>('SELECT COUNT(*) AS count FROM deletion_ledger;'),
    ).resolves.toEqual({ count: 1 });
    await reopened.close();
  });

  it('queues one stable ordered mutation group for a sync-enabled account', async () => {
    const driver = await openMigratedDatabase(await temporaryDatabasePath());
    await insertIdentity(driver, accountOwnerId, 'account');
    const firstRef = ref(accountOwnerId);
    const secondRef = ref(accountOwnerId, secondActionId);
    await insertAction(driver, firstRef, 'Private A', 'a');
    await insertAction(driver, secondRef, 'Private B', 'b');
    const input: CompleteActionsInput = { refs: [firstRef, secondRef] };
    const envelope: CommandEnvelope<CompleteActionsInput> = {
      commandId,
      ownerId: accountOwnerId,
      actor: 'user',
      expectedRevisions: [
        { ref: firstRef, revision: 1 },
        { ref: secondRef, revision: 1 },
      ],
      input,
    };
    const generatedIds = [
      '40000000-0000-4000-8000-000000000021',
      '40000000-0000-4000-8000-000000000022',
      '40000000-0000-4000-8000-000000000023',
      '40000000-0000-4000-8000-000000000024',
      '40000000-0000-4000-8000-000000000025',
      '40000000-0000-4000-8000-000000000026',
    ] as UUID[];

    const result = await executeCommand(
      dependencies(driver, generatedIds),
      envelope,
      completeActionsHandler(),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        canonical: [
          { ref: firstRef, localRevision: 2 },
          { ref: secondRef, localRevision: 2 },
        ],
        eventIds: generatedIds.slice(0, 2),
        undo: { available: true, undoId: generatedIds[2] },
        sync: {
          queued: true,
          mutationGroupId: generatedIds[3],
          operationIds: generatedIds.slice(4, 6),
        },
      },
    });
    await expect(
      driver.all<{ id: string; state: string; local_revision: number }>(
        `SELECT id, state, local_revision FROM actions
         WHERE owner_id = ? ORDER BY sort_key, id;`,
        [accountOwnerId],
      ),
    ).resolves.toEqual([
      { id: firstRef.id, state: 'completed', local_revision: 2 },
      { id: secondRef.id, state: 'completed', local_revision: 2 },
    ]);
    await expect(
      driver.all<{
        operation_id: string;
        mutation_group_id: string;
        sequence: number;
        entity_id: string;
      }>(
        `SELECT operation_id, mutation_group_id, sequence, entity_id
         FROM sync_outbox
         WHERE owner_id = ? ORDER BY sequence, id;`,
        [accountOwnerId],
      ),
    ).resolves.toEqual([
      {
        operation_id: generatedIds[4],
        mutation_group_id: generatedIds[3],
        sequence: 0,
        entity_id: firstRef.id,
      },
      {
        operation_id: generatedIds[5],
        mutation_group_id: generatedIds[3],
        sequence: 1,
        entity_id: secondRef.id,
      },
    ]);
    await expect(
      driver.all<{ id: string; sequence: number }>(
        `SELECT id, sequence FROM domain_events
         WHERE owner_id = ? AND command_id = ? ORDER BY sequence, id;`,
        [accountOwnerId, commandId],
      ),
    ).resolves.toEqual([
      { id: generatedIds[0], sequence: 0 },
      { id: generatedIds[1], sequence: 1 },
    ]);
    await driver.close();
  });

  it('expires retained UnitOfWork capabilities', async () => {
    const driver = await openMigratedDatabase(await temporaryDatabasePath());
    await insertIdentity(driver, localOwnerId, 'local');
    const { unitOfWork } = createSqliteApplicationAdapters(driver);
    let retained: PlanningUnitOfWork | undefined;
    await unitOfWork.runInTransaction((capabilities) => {
      retained = capabilities;
      return Promise.resolve();
    });
    if (retained === undefined) throw new Error('Synthetic missing capability');
    let failure: unknown;
    try {
      void retained.records.read(ref(localOwnerId));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'capability_expired',
      message: 'YelAxis Planner data operation failed.',
    });
    await driver.close();
  });

  it('atomically creates a Time Block through executeCommand', async () => {
    const driver = await openMigratedDatabase(await temporaryDatabasePath());
    await insertIdentity(driver, localOwnerId, 'local');

    const app = dependencies(driver, [
      '30000000-0000-4000-8000-000000000001' as UUID,
      '30000000-0000-4000-8000-000000000002' as UUID,
      '30000000-0000-4000-8000-000000000003' as UUID,
      '30000000-0000-4000-8000-000000000004' as UUID,
    ]);

    const blockRef: EntityRef<'time_block'> = {
      type: 'time_block',
      id: '40000000-0000-4000-8000-000000000001' as UUID,
      ownerId: localOwnerId,
    };
    const document: TimeBlockDocument = {
      target: { kind: 'custom', title: 'Deep Work' },
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
      timeZone: 'America/New_York',
      state: 'planned',
      overlapAcknowledged: false,
    };

    const handler: CommandHandler<unknown> = ({ context }) =>
      ok({
        value: [
          {
            ref: blockRef,
            operation: 'create',
            expectedRevision: null,
            baseServerRevision: 0,
            baseSnapshotHash: null,
            document,
          },
        ],
        events: [
          {
            aggregate: blockRef,
            eventType: 'timeBlock.created',
            version: 1,
            actor: context.actor,
            commandId: context.commandId,
            occurredAt: context.now,
            payload: { state: 'planned' },
          },
        ],
        touched: [blockRef],
      });

    const result = await executeCommand(
      app,
      {
        commandId,
        ownerId: localOwnerId,
        actor: 'user',
        expectedRevisions: [],
        input: {},
      },
      handler,
    );

    expect(result.ok).toBe(true);

    const saved = await app.unitOfWork.runInTransaction((uow) => uow.records.read(blockRef));
    expect(saved).not.toBeNull();
    expect(saved!.localRevision).toBe(1);
    expect(saved!.document).toEqual(document);

    const timeBlockRows = await driver.all<{
      id: string;
      custom_title: string;
      action_id: string | null;
    }>('SELECT * FROM time_blocks');
    expect(timeBlockRows).toHaveLength(1);
    const dbRow = timeBlockRows[0]!;
    expect(dbRow.id).toBe(blockRef.id);
    expect(dbRow.custom_title).toBe('Deep Work');
    expect(dbRow.action_id).toBeNull();

    await driver.close();
  });

  it('atomically reschedules a Time Block (supersession chain)', async () => {
    const driver = await openMigratedDatabase(await temporaryDatabasePath());
    await insertIdentity(driver, localOwnerId, 'local');

    const app = dependencies(driver, [
      '30000000-0000-4000-8000-000000000001' as UUID,
      '30000000-0000-4000-8000-000000000002' as UUID,
      '30000000-0000-4000-8000-000000000003' as UUID,
      '30000000-0000-4000-8000-000000000004' as UUID,
      '30000000-0000-4000-8000-000000000005' as UUID,
      '30000000-0000-4000-8000-000000000006' as UUID,
    ]);

    const oldBlockRef: EntityRef<'time_block'> = {
      type: 'time_block',
      id: '40000000-0000-4000-8000-000000000001' as UUID,
      ownerId: localOwnerId,
    };
    const newBlockRef: EntityRef<'time_block'> = {
      type: 'time_block',
      id: '40000000-0000-4000-8000-000000000002' as UUID,
      ownerId: localOwnerId,
    };

    const oldDocument: TimeBlockDocument = {
      target: { kind: 'custom', title: 'Deep Work' },
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
      timeZone: 'America/New_York',
      state: 'planned',
      overlapAcknowledged: false,
    };

    // Pre-insert old block
    await driver.run(
      `INSERT INTO time_blocks (id, owner_id, custom_title, starts_at_utc, ends_at_utc, time_zone, state, overlap_confirmed, created_at, updated_at, client_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?);`,
      [
        oldBlockRef.id,
        localOwnerId,
        'Deep Work',
        oldDocument.startsAt,
        oldDocument.endsAt,
        oldDocument.timeZone,
        oldDocument.state,
        now,
        now,
        now,
      ],
    );

    // Initialize server revision cache (just like actual integration tests)
    const oldRecord = await app.unitOfWork.runInTransaction((uow) => uow.records.read(oldBlockRef));
    if (oldRecord === null) throw new Error('Setup failed');

    const newDocument: TimeBlockDocument = {
      ...oldDocument,
      startsAt: '2026-08-01T14:00:00.000Z',
      endsAt: '2026-08-01T15:00:00.000Z',
    };
    const canceledOldDocument: TimeBlockDocument = {
      ...oldDocument,
      state: 'canceled',
      supersededById: newBlockRef.id,
    };

    const handler: CommandHandler<unknown> = ({ context }) =>
      ok({
        value: [
          {
            ref: newBlockRef,
            operation: 'create',
            expectedRevision: null,
            baseServerRevision: 0,
            baseSnapshotHash: null,
            document: newDocument,
          },
          {
            ref: oldBlockRef,
            operation: 'update',
            expectedRevision: oldRecord.localRevision,
            baseServerRevision: oldRecord.serverRevision,
            baseSnapshotHash: oldRecord.baseSnapshotHash,
            document: canceledOldDocument,
          },
        ],
        events: [
          {
            aggregate: oldBlockRef,
            eventType: 'timeBlock.canceled',
            version: 1,
            actor: context.actor,
            commandId: context.commandId,
            occurredAt: context.now,
            payload: { state: 'canceled' },
          },
          {
            aggregate: newBlockRef,
            eventType: 'timeBlock.created',
            version: 1,
            actor: context.actor,
            commandId: context.commandId,
            occurredAt: context.now,
            payload: { state: 'planned' },
          },
        ],
        touched: [oldBlockRef, newBlockRef],
      });

    const result = await executeCommand(
      app,
      {
        commandId: '30000000-0000-4000-8000-000000000007' as UUID,
        ownerId: localOwnerId,
        actor: 'user',
        expectedRevisions: [{ ref: oldBlockRef, revision: oldRecord.localRevision }],
        input: {},
      },
      handler,
    );

    expect(result).toMatchObject({ ok: true });

    const oldSaved = await app.unitOfWork.runInTransaction((uow) => uow.records.read(oldBlockRef));
    const newSaved = await app.unitOfWork.runInTransaction((uow) => uow.records.read(newBlockRef));
    expect(oldSaved!.document).toEqual(canceledOldDocument);
    expect(newSaved!.document).toEqual(newDocument);

    const timeBlockRows = await driver.all<{
      id: string;
      state: string;
      superseded_by_id: string | null;
      starts_at_utc: string;
    }>(
      'SELECT id, state, superseded_by_id, starts_at_utc FROM time_blocks ORDER BY created_at ASC',
    );
    expect(timeBlockRows).toHaveLength(2);
    expect(timeBlockRows[0]!.id).toBe(oldBlockRef.id);
    expect(timeBlockRows[0]!.state).toBe('canceled');
    expect(timeBlockRows[0]!.superseded_by_id).toBe(newBlockRef.id);

    expect(timeBlockRows[1]!.id).toBe(newBlockRef.id);
    expect(timeBlockRows[1]!.state).toBe('planned');
    expect(timeBlockRows[1]!.superseded_by_id).toBeNull();
    expect(timeBlockRows[1]!.starts_at_utc).toBe('2026-08-01T14:00:00.000Z');

    await driver.close();
  });
});

async function tableCounts(driver: NodeSqliteDriver): Promise<Record<string, number>> {
  const tables = [
    'actions',
    'domain_events',
    'undo_records',
    'command_receipts',
    'sync_outbox',
  ] as const;
  const result: Record<string, number> = {};
  for (const table of tables) {
    const row = await driver.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table};`);
    result[table] = row?.count ?? -1;
  }
  return result;
}

async function deleteBlockingSnapshot(driver: NodeSqliteDriver): Promise<unknown> {
  return {
    action: await driver.get<{
      title: string;
      note_text: string;
      local_revision: number;
    }>('SELECT title, note_text, local_revision FROM actions;'),
    outbox: await driver.all<{
      state: string;
      document_payload_json: string;
    }>('SELECT state, document_payload_json FROM sync_outbox ORDER BY id;'),
    conflicts: await driver.all<{
      state: string;
      candidate_payload_json: string;
    }>('SELECT state, candidate_payload_json FROM sync_conflicts ORDER BY id;'),
    ledger: await driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM deletion_ledger;'),
    events: await driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM domain_events;'),
    receipts: await driver.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM command_receipts;',
    ),
  };
}
