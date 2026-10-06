import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeCommand,
  type ApplicationDependencies,
  type CommandEnvelope,
  type CommandHandler,
} from '@yelaxis/application';
import {
  entityRefKey,
  ok,
  type CommandActor,
  type CommandId,
  type EntityRef,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import type { ActionCanonicalDocument } from './action-codec';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

const now = '2026-10-01T09:00:00.000Z' as Instant;
const later = '2026-10-02T09:00:00.000Z' as Instant;
const localOwnerId = '10000000-0000-4000-8000-000000000021' as OwnerId;
const accountOwnerId = '10000000-0000-4000-8000-000000000022' as OwnerId;
const actionId = '20000000-0000-4000-8000-000000000021' as EntityRef<'action'>['id'];
const commandId = '30000000-0000-4000-8000-000000000021' as CommandId;
const temporaryDirectories: string[] = [];

interface CreateActionInput {
  readonly ref: EntityRef<'action'>;
  readonly document: ActionCanonicalDocument;
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-actor-'));
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

function dependencies(
  driver: NodeSqliteDriver,
  ids: readonly string[],
  clockValue: Instant = now,
): ApplicationDependencies {
  let index = 0;
  return {
    ...createSqliteApplicationAdapters(driver),
    clock: { now: () => clockValue },
    ids: {
      next() {
        const value = ids[index];
        if (value === undefined) throw new Error('Deterministic ID sequence exhausted');
        index += 1;
        return value as UUID;
      },
    },
    projections: { notifyCommitted: () => undefined },
  };
}

function envelope(
  ownerId: OwnerId,
  actor: CommandActor = 'intelligence_proposal',
): CommandEnvelope<CreateActionInput> {
  return {
    commandId,
    ownerId,
    actor,
    expectedRevisions: [],
    input: {
      ref: { type: 'action', id: actionId, ownerId },
      document: {
        title: 'Sample accepted Action',
        captureOrigin: 'plan',
        orderKey: 'a',
        state: 'planned',
      },
    },
  };
}

/** Creates the Action through the normal command path with a minimized `{ operation }` event. */
const createActionHandler: CommandHandler<CreateActionInput> = ({ input, context }) =>
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
        payload: { operation: 'create' },
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('intelligence_proposal audit actor at the data boundary', () => {
  it('stores the actor on events and receipts and replays the receipt after reopen', async () => {
    const path = await temporaryDatabasePath();
    const driver = await openMigratedDatabase(path);
    await insertIdentity(driver, localOwnerId, 'local');
    const ids = ['40000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000022'];

    const first = await executeCommand(
      dependencies(driver, ids),
      envelope(localOwnerId),
      createActionHandler,
    );

    expect(first).toEqual({
      ok: true,
      value: {
        commandId,
        ownerId: localOwnerId,
        actor: 'intelligence_proposal',
        acceptedAt: now,
        canonical: [
          { ref: { type: 'action', id: actionId, ownerId: localOwnerId }, localRevision: 1 },
        ],
        eventIds: [ids[0]],
        undo: { available: true, undoId: ids[1] },
        sync: { queued: false },
      },
    });
    await expect(
      driver.all(`SELECT actor, event_type, payload_json FROM domain_events WHERE owner_id = ?;`, [
        localOwnerId,
      ]),
    ).resolves.toEqual([
      {
        actor: 'intelligence_proposal',
        event_type: 'action.created',
        payload_json: '{"operation":"create"}',
      },
    ]);
    await expect(
      driver.get(`SELECT actor FROM command_receipts WHERE owner_id = ? AND command_id = ?;`, [
        localOwnerId,
        commandId,
      ]),
    ).resolves.toEqual({ actor: 'intelligence_proposal' });
    await driver.close();

    const reopened = await openMigratedDatabase(path);
    let handlerCalls = 0;
    const replay = await executeCommand(
      dependencies(reopened, [], later),
      envelope(localOwnerId),
      () => {
        handlerCalls += 1;
        throw new Error('A replayed command must not run again.');
      },
    );

    expect(replay).toEqual(first);
    expect(handlerCalls).toBe(0);
    await reopened.close();
  });

  it('queues the sync outbox with the actor for a sync-enabled identity', async () => {
    const driver = await openMigratedDatabase(await temporaryDatabasePath());
    await insertIdentity(driver, accountOwnerId, 'account');
    const ids = [
      '40000000-0000-4000-8000-000000000031',
      '40000000-0000-4000-8000-000000000032',
      '40000000-0000-4000-8000-000000000033',
      '40000000-0000-4000-8000-000000000034',
    ];

    const result = await executeCommand(
      dependencies(driver, ids),
      envelope(accountOwnerId),
      createActionHandler,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        actor: 'intelligence_proposal',
        sync: { queued: true, mutationGroupId: ids[2], operationIds: [ids[3]] },
      },
    });
    await expect(
      driver.all(`SELECT actor, operation_kind FROM sync_outbox WHERE owner_id = ?;`, [
        accountOwnerId,
      ]),
    ).resolves.toEqual([{ actor: 'intelligence_proposal', operation_kind: 'create' }]);
    await driver.close();
  });

  it('keeps the actor set closed in SQL and in stored receipts', async () => {
    const driver = await openMigratedDatabase(await temporaryDatabasePath());
    await insertIdentity(driver, localOwnerId, 'local');

    await expect(
      driver.run(
        `INSERT INTO domain_events (
           id, owner_id, command_id, sequence, actor, event_type, entity_type, entity_id,
           payload_schema_version, payload_json, occurred_at, created_at, updated_at
         ) VALUES (?, ?, ?, 0, 'model', 'action.created', 'action', ?, 1, '{}', ?, ?, ?);`,
        ['event-unknown-actor', localOwnerId, commandId, actionId, now, now, now],
      ),
    ).rejects.toThrow();

    const storeReceipt = async (id: CommandId, payloadActor: string): Promise<void> => {
      const receipt = {
        commandId: id,
        ownerId: localOwnerId,
        actor: payloadActor,
        acceptedAt: now,
        canonical: [],
        eventIds: [],
        undo: { available: false },
        sync: { queued: false },
      };
      await driver.run(
        `INSERT INTO command_receipts (
           id, owner_id, command_id, actor, accepted_at, receipt_schema_version,
           receipt_payload_json, created_at, updated_at
         ) VALUES (?, ?, ?, 'user', ?, 1, ?, ?, ?);`,
        [id, localOwnerId, id, now, JSON.stringify(receipt), now, now],
      );
    };
    const controlCommandId = '30000000-0000-4000-8000-000000000022' as CommandId;
    await storeReceipt(commandId, 'model');
    await storeReceipt(controlCommandId, 'user');

    const unknown = await executeCommand(
      dependencies(driver, []),
      envelope(localOwnerId, 'user'),
      createActionHandler,
    );
    const control = await executeCommand(
      dependencies(driver, []),
      { ...envelope(localOwnerId, 'user'), commandId: controlCommandId },
      createActionHandler,
    );

    expect(unknown).toEqual({ ok: false, error: { code: 'transaction_failed' } });
    expect(control).toMatchObject({
      ok: true,
      value: { commandId: controlCommandId, actor: 'user' },
    });
    await driver.close();
  });
});
