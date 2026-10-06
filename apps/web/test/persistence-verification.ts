import {
  executeCommand,
  type ApplicationDependencies,
  type CommandEnvelope,
  type CommandHandler,
} from '@yelaxis/application';
import {
  checkDatabaseHealth,
  createSqliteApplicationAdapters,
  defineMigration,
  latestSchemaVersion,
  runMigrations,
  schemaMigrations,
  type ActionCanonicalDocument,
  type SqliteDriver,
  type SqliteTransaction,
} from '@yelaxis/data';
import { BrowserSqliteDriver, BrowserSqliteError } from '@yelaxis/data/browser';
import {
  entityRefKey,
  ok,
  type CommandId,
  type EntityRef,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

const now = '2026-07-27T08:00:00.000Z' as Instant;
const accountOwnerId = '11000000-0000-4000-8000-000000000001' as OwnerId;
const localOwnerId = '11000000-0000-4000-8000-000000000002' as OwnerId;
const accountActionId = '21000000-0000-4000-8000-000000000001';
const failedActionId = '21000000-0000-4000-8000-000000000002';
const localActionId = '21000000-0000-4000-8000-000000000003';
const accountCommandId = '31000000-0000-4000-8000-000000000001' as CommandId;
const failedCommandId = '31000000-0000-4000-8000-000000000002' as CommandId;
const localCommandId = '31000000-0000-4000-8000-000000000003' as CommandId;
const deleteCommandId = '31000000-0000-4000-8000-000000000004' as CommandId;
const resurrectCommandId = '31000000-0000-4000-8000-000000000005' as CommandId;
const privateMarker = 'browser persistence private deletion marker';

interface CreateActionInput {
  readonly ref: EntityRef<'action'>;
  readonly document: ActionCanonicalDocument;
}

interface DeleteActionInput {
  readonly ref: EntityRef<'action'>;
  readonly expectedRevision: number;
}

type VerificationResult = Readonly<{
  phase: string;
  checks: readonly string[];
  storage?: string;
  sqliteVersion?: string;
}>;

const resultNode = document.querySelector('#result');
if (!(resultNode instanceof HTMLElement)) throw new Error('Missing verification result node.');
const output = resultNode;

void verify().then(
  (result) => report('passed', result),
  (error: unknown) =>
    report('failed', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
);

async function verify(): Promise<VerificationResult> {
  const parameters = new URLSearchParams(window.location.search);
  const phase = parameters.get('phase') ?? 'seed';
  const databaseName = parameters.get('database');
  if (databaseName === null) throw new Error('A test database name is required.');

  if (phase === 'expect-busy') {
    try {
      const opened = await BrowserSqliteDriver.open({ databaseName });
      await opened.driver.close();
    } catch (error) {
      if (error instanceof BrowserSqliteError && error.code === 'database_busy') {
        return { phase, checks: ['exclusive cross-tab database lock'] };
      }
      throw error;
    }
    throw new Error('A second tab unexpectedly opened the same database.');
  }

  if (phase === 'hold') {
    // Each runner starts with its own fresh disposable profile. Preserve a v1 legacy value on upgrade.
    const original = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('yelaxis-sqlite-snapshots-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('databases');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Synthetic v1 fixture failed.'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = original.transaction('databases', 'readwrite');
        transaction
          .objectStore('databases')
          .put(new Uint8Array([7, 11, 17]), 'synthetic-upgrade-sentinel');
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error('Synthetic v1 write failed.'));
      });
    } finally {
      original.close();
    }
  }

  const { driver, storage } = await BrowserSqliteDriver.open({ databaseName });
  const checks: string[] = [];
  let closed = false;
  try {
    if (phase === 'seed') {
      const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('yelaxis-sqlite-snapshots-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Synthetic upgraded store failed.'));
      });
      try {
        assertEqual(upgraded.version, 2, 'metadata-only IndexedDB upgrade reaches v2');
        const retained = await new Promise<unknown>((resolve, reject) => {
          const request = upgraded
            .transaction('databases')
            .objectStore('databases')
            .get('synthetic-upgrade-sentinel');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(new Error('Synthetic upgrade read failed.'));
        });
        assertEqual(
          retained instanceof Uint8Array && String([...retained]) === '7,11,17',
          true,
          'v1 values survive byte-for-byte',
        );
        checks.push('metadata-only IndexedDB v1-to-v2 upgrade preserves legacy values');
      } finally {
        upgraded.close();
      }
    }
    if (phase === 'hold') {
      output.setAttribute('data-status', 'holding');
      output.textContent = JSON.stringify({ phase, storage }, null, 2);
      await new Promise<never>(() => undefined);
    } else if (phase === 'seed') {
      await verifySeed(driver, checks);
      await verifyCheckedImageHealth(driver, databaseName, checks);
      const legacy = await driver.exportDatabase();
      await driver.close();
      closed = true;
      await verifySnapshotFormats(databaseName, legacy, checks);
    } else if (phase === 'reopen') {
      await verifyReopen(driver, checks);
    } else if (phase === 'cleared') {
      await verifySiteDataCleared(driver, checks);
    } else {
      throw new Error(`Unknown verification phase: ${phase}`);
    }
    return {
      phase,
      checks,
      storage: storage.durability,
      sqliteVersion: storage.sqliteVersion,
    };
  } finally {
    if (!closed) await driver.close();
  }
}

async function verifyCheckedImageHealth(
  driver: BrowserSqliteDriver,
  databaseName: string,
  checks: string[],
): Promise<void> {
  const policy = 'a'.repeat(40);
  assertEqual(
    (await driver.checkedHealth(policy)).verification,
    'full',
    'unrecognized image receives both full health checks',
  );
  assertEqual(
    (await driver.checkedHealth(policy)).verification,
    'identical-image',
    'exact checked image reuses its full result',
  );
  assertEqual(
    (await driver.checkedHealth('b'.repeat(40))).verification,
    'full',
    'different code policy requires full checks',
  );
  const snapshots = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('yelaxis-sqlite-snapshots-v1');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Synthetic proof store unavailable.'));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = snapshots.transaction('checked-images', 'readwrite');
      transaction
        .objectStore('checked-images')
        .put({ format: 'invalid' }, `active:${databaseName}`);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error('Synthetic proof write failed.'));
    });
    assertEqual(
      (await driver.checkedHealth(policy)).verification,
      'full',
      'malformed metadata is a cache miss',
    );
    await driver.executeScript(`
      CREATE TABLE health_probe_parent(id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE health_probe_child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES health_probe_parent(id)) STRICT;
    `);
    assertEqual(
      (await driver.checkedHealth(policy)).verification,
      'full',
      'changed exact image requires full checks',
    );
    await driver.executeScript('PRAGMA foreign_keys = OFF;');
    await driver.run('INSERT INTO health_probe_child(id,parent_id) VALUES(1,999);');
    await driver.executeScript('PRAGMA foreign_keys = ON;');
    const corrupt = await driver.checkedHealth(policy);
    assertEqual(corrupt.verification, 'full', 'changed corrupt relationship runs full checks');
    assertEqual(
      corrupt.foreignKeyViolations.length,
      1,
      'corrupt relationships never receive a healthy proof',
    );
    await driver.executeScript('DROP TABLE health_probe_child; DROP TABLE health_probe_parent;');
    const restored = await driver.checkedHealth(policy);
    assertEqual(restored.verification, 'full', 'repaired synthetic image is validated again');
    assertEqual(restored.foreignKeyViolations.length, 0, 'canonical data remains healthy');
    checks.push(
      'digest/code/engine-bound health reuse, malformed/changed-image full validation, corrupt relationship refusal and exact persisted image',
    );
  } finally {
    snapshots.close();
  }
}

function isCompressedSnapshot(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'format' in value &&
    value.format === 'sqlite-gzip-v1' &&
    'bytes' in value &&
    value.bytes instanceof ArrayBuffer
  );
}

async function verifySnapshotFormats(
  databaseName: string,
  legacy: Uint8Array,
  checks: string[],
): Promise<void> {
  const snapshots = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('yelaxis-sqlite-snapshots-v1');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Synthetic snapshot store unavailable.'));
  });
  async function readValue(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = snapshots
        .transaction('databases')
        .objectStore('databases')
        .get(`active:${databaseName}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Synthetic snapshot read failed.'));
    });
  }
  try {
    assertEqual(
      isCompressedSnapshot(await readValue()),
      true,
      'acknowledged images use the versioned compressed representation',
    );
    for (const value of [legacy.buffer, legacy, new Blob([legacy as Uint8Array<ArrayBuffer>])]) {
      await new Promise<void>((resolve, reject) => {
        const transaction = snapshots.transaction('databases', 'readwrite');
        transaction.objectStore('databases').put(value, `active:${databaseName}`);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error('Synthetic legacy snapshot write failed.'));
      });
      const reopened = (await BrowserSqliteDriver.open({ databaseName })).driver;
      try {
        const actual = await reopened.exportDatabase();
        assertEqual(actual.length, legacy.length, 'legacy image length survives');
        assertEqual(
          actual.every((byte, index) => byte === legacy[index]),
          true,
          'legacy bytes survive exact reopen',
        );
        const health = await checkDatabaseHealth(reopened);
        assertEqual(health.integrityCheck, 'ok', 'legacy image remains valid');
        assertEqual(
          (await reopened.checkedHealth('a'.repeat(40))).verification,
          'identical-image',
          'exact legacy persisted image reuses checked proof after restart',
        );
        await reopened.executeScript(`PRAGMA user_version = ${latestSchemaVersion};`);
        assertEqual(
          isCompressedSnapshot(await readValue()),
          true,
          'next acknowledged write upgrades representation',
        );
      } finally {
        await reopened.close();
      }
    }
    checks.push(
      'compressed durability and exact legacy ArrayBuffer/Uint8Array/Blob reopen without reset',
    );
  } finally {
    snapshots.close();
  }
}

async function verifySeed(driver: BrowserSqliteDriver, checks: string[]): Promise<void> {
  const migration = await runMigrations(driver, schemaMigrations, () => now);
  assertEqual(migration.fromVersion, 0, 'new browser database starts at schema version zero');
  assertEqual(migration.toVersion, latestSchemaVersion, 'all migrations apply');
  assertEqual(
    migration.appliedVersions.join(','),
    Array.from({ length: latestSchemaVersion }, (_, index) => String(index + 1)).join(','),
    'migration order is stable',
  );
  checks.push('database creation and ordered migrations');

  const failedMigration = defineMigration(
    latestSchemaVersion + 1,
    'verification_failure',
    'CREATE TABLE persistence_failed_migration (id INTEGER PRIMARY KEY) STRICT; INSERT INTO missing_table VALUES (1);',
  );
  await expectRejected(
    runMigrations(driver, [...schemaMigrations, failedMigration], () => now),
    'synthetic migration must fail',
  );
  assertEqual(
    (await driver.get<{ user_version: number }>('PRAGMA user_version;'))?.user_version,
    latestSchemaVersion,
    'failed migration retains user_version',
  );
  assertEqual(
    (
      await driver.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'persistence_failed_migration';",
      )
    )?.count,
    0,
    'failed migration rolls schema back',
  );
  checks.push('failed-migration rollback');

  await driver.executeScript(
    'CREATE TABLE persistence_transaction_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;',
  );
  await expectRejected(
    driver.executeScript(
      "INSERT INTO persistence_transaction_probe (id, value) VALUES (99, 'must-rollback'); INSERT INTO missing_table VALUES (1);",
    ),
    'failed standalone script must reject',
  );
  assertEqual(
    (
      await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM persistence_transaction_probe WHERE id = 99;',
      )
    )?.count,
    0,
    'failed standalone script restores its pre-operation snapshot',
  );
  await driver.transaction(async (transaction) => {
    await transaction.run('INSERT INTO persistence_transaction_probe (id, value) VALUES (?, ?);', [
      1,
      'committed',
    ]);
  });
  await expectRejected(
    driver.transaction(async (transaction) => {
      await transaction.run(
        'INSERT INTO persistence_transaction_probe (id, value) VALUES (?, ?);',
        [2, 'rolled-back'],
      );
      throw new Error('synthetic transaction failure');
    }),
    'transaction failure must reject',
  );
  assertEqual(
    (
      await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM persistence_transaction_probe;',
      )
    )?.count,
    1,
    'transaction rollback retains only committed data',
  );

  let escaped: SqliteTransaction | undefined;
  await driver.transaction((transaction) => {
    escaped = transaction;
    return Promise.resolve();
  });
  if (escaped === undefined) throw new Error('Transaction capability was not captured.');
  await expectRejected(
    escaped.run('INSERT INTO persistence_transaction_probe (id, value) VALUES (3, ?);', [
      'escaped',
    ]),
    'expired transaction capability must reject',
  );
  checks.push('standalone-script and transaction rollback plus escape protection');

  let mainThreadHeartbeat = false;
  window.setTimeout(() => {
    mainThreadHeartbeat = true;
  }, 0);
  await driver.get<{ total: number }>(
    `WITH RECURSIVE counter(value) AS (
       VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 250000
     ) SELECT sum(value) AS total FROM counter;`,
  );
  assert(mainThreadHeartbeat, 'SQLite work must not block the browser main thread');
  checks.push('dedicated-worker execution');

  await insertIdentity(driver, accountOwnerId, 'account');
  const accountRef = actionRef(accountOwnerId, accountActionId);
  const accountInput: CreateActionInput = {
    ref: accountRef,
    document: {
      title: 'Account verification action',
      captureOrigin: 'onboarding',
      orderKey: 'a',
      state: 'planned',
    },
  };
  const accountResult = await executeCommand(
    dependencies(driver, accountOwnerId, [
      '41000000-0000-4000-8000-000000000001',
      '41000000-0000-4000-8000-000000000002',
      '41000000-0000-4000-8000-000000000003',
      '41000000-0000-4000-8000-000000000004',
    ]),
    createEnvelope(accountCommandId, accountInput),
    createActionHandler(),
  );
  assert(accountResult.ok, 'sync-enabled application command must commit');
  assertEqual(
    JSON.stringify(await ownerCounts(driver, accountOwnerId)),
    JSON.stringify({
      actions: 1,
      domain_events: 1,
      undo_records: 1,
      command_receipts: 1,
      sync_outbox: 1,
    }),
    'canonical, audit, undo, receipt, and outbox writes are atomic',
  );

  await driver.executeScript(`
    CREATE TRIGGER persistence_fail_event
    BEFORE INSERT ON domain_events
    WHEN NEW.owner_id = '${accountOwnerId}' AND NEW.command_id = '${failedCommandId}'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic event failure');
    END;
  `);
  const failedRef = actionRef(accountOwnerId, failedActionId);
  const failedResult = await executeCommand(
    dependencies(driver, accountOwnerId, [
      '41000000-0000-4000-8000-000000000011',
      '41000000-0000-4000-8000-000000000012',
      '41000000-0000-4000-8000-000000000013',
      '41000000-0000-4000-8000-000000000014',
    ]),
    createEnvelope(failedCommandId, {
      ref: failedRef,
      document: {
        title: 'Must roll back',
        captureOrigin: 'onboarding',
        orderKey: 'b',
        state: 'planned',
      },
    }),
    createActionHandler(),
  );
  await driver.executeScript('DROP TRIGGER persistence_fail_event;');
  assert(!failedResult.ok, 'synthetic support-write failure must reject the command');
  assertEqual(
    (
      await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM actions WHERE owner_id = ? AND id = ?;',
        [accountOwnerId, failedRef.id],
      )
    )?.count,
    0,
    'support-write failure rolls back canonical data',
  );
  checks.push('application atomicity and rollback');

  await insertIdentity(driver, localOwnerId, 'local');
  const localRef = actionRef(localOwnerId, localActionId);
  const localInput: CreateActionInput = {
    ref: localRef,
    document: {
      title: privateMarker,
      note: privateMarker,
      captureOrigin: 'onboarding',
      orderKey: 'a',
      state: 'planned',
    },
  };
  const localCreate = await executeCommand(
    dependencies(driver, localOwnerId, [
      '41000000-0000-4000-8000-000000000021',
      '41000000-0000-4000-8000-000000000022',
    ]),
    createEnvelope(localCommandId, localInput),
    createActionHandler(),
  );
  assert(localCreate.ok, 'local action must be created');
  const deletion = await executeCommand(
    dependencies(driver, localOwnerId, ['41000000-0000-4000-8000-000000000023']),
    {
      commandId: deleteCommandId,
      ownerId: localOwnerId,
      actor: 'user',
      expectedRevisions: [{ ref: localRef, revision: 1 }],
      input: { ref: localRef, expectedRevision: 1 },
    },
    deleteActionHandler(),
  );
  assert(deletion.ok, 'local permanent delete must commit');
  assertEqual(
    (
      await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM actions WHERE owner_id = ? AND id = ?;',
        [localOwnerId, localRef.id],
      )
    )?.count,
    0,
    'deleted action content is physically removed',
  );
  const tombstone = await driver.get<Record<string, unknown>>(
    `SELECT owner_id, entity_type, entity_id, local_revision, deleted_at
     FROM deletion_ledger WHERE owner_id = ? AND entity_id = ?;`,
    [localOwnerId, localRef.id],
  );
  assertEqual(
    JSON.stringify(tombstone),
    JSON.stringify({
      owner_id: localOwnerId,
      entity_type: 'action',
      entity_id: localRef.id,
      local_revision: 2,
      deleted_at: now,
    }),
    'deletion ledger is content-free and exact',
  );
  assert(!JSON.stringify(tombstone).includes(privateMarker), 'tombstone must exclude content');

  const resurrection = await executeCommand(
    dependencies(driver, localOwnerId, [
      '41000000-0000-4000-8000-000000000024',
      '41000000-0000-4000-8000-000000000025',
    ]),
    createEnvelope(resurrectCommandId, localInput),
    createActionHandler(),
  );
  assert(!resurrection.ok, 'deleted ID resurrection must be rejected');
  checks.push('content-free tombstone, cleanup, and resurrection prevention');

  const backup = await driver.exportDatabase();
  assert(backup.byteLength > 1024, 'database backup must contain SQLite bytes');
  await driver.run('INSERT INTO persistence_transaction_probe (id, value) VALUES (?, ?);', [
    4,
    'after-backup',
  ]);
  await driver.importDatabase(backup, async (candidate) => {
    const health = await checkDatabaseHealth(candidate);
    assertEqual(health.integrityCheck, 'ok', 'imported backup integrity');
    assertEqual(health.foreignKeyViolations.length, 0, 'imported backup foreign keys');
  });
  assertEqual(
    (
      await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM persistence_transaction_probe WHERE id = 4;',
      )
    )?.count,
    0,
    'valid import restores the archived snapshot',
  );
  await expectRejected(
    driver.importDatabase(backup, () =>
      Promise.reject(new Error('synthetic validation rejection')),
    ),
    'rejected import must roll back',
  );
  assertEqual(
    (
      await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM actions WHERE owner_id = ?;',
        [accountOwnerId],
      )
    )?.count,
    1,
    'failed import restores the previous database',
  );
  await expectRejected(
    driver.importDatabase(new Uint8Array([1, 2, 3, 4]), () => Promise.resolve()),
    'corrupt import must reject',
  );
  assertEqual(
    (
      await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM actions WHERE owner_id = ?;',
        [accountOwnerId],
      )
    )?.count,
    1,
    'corrupt import preserves the previous database',
  );
  checks.push('backup, restore, validation rollback, and corrupt-import recovery');
}

async function verifyReopen(driver: BrowserSqliteDriver, checks: string[]): Promise<void> {
  const migration = await runMigrations(driver, schemaMigrations, () => now);
  assertEqual(
    migration.fromVersion,
    latestSchemaVersion,
    'reopened browser database retains schema',
  );
  assertEqual(migration.appliedVersions.length, 0, 'reopen does not reapply migrations');

  let handlerCalls = 0;
  const replay = await executeCommand(
    dependencies(driver, accountOwnerId, []),
    createEnvelope(accountCommandId, {
      ref: actionRef(accountOwnerId, accountActionId),
      document: {
        title: 'Account verification action',
        captureOrigin: 'onboarding',
        orderKey: 'a',
        state: 'planned',
      },
    }),
    () => {
      handlerCalls += 1;
      throw new Error('replay handler must not execute');
    },
  );
  assert(replay.ok, 'command receipt must replay after browser restart');
  assertEqual(handlerCalls, 0, 'restart replay bypasses handler');
  assertEqual(
    JSON.stringify(await ownerCounts(driver, accountOwnerId)),
    JSON.stringify({
      actions: 1,
      domain_events: 1,
      undo_records: 1,
      command_receipts: 1,
      sync_outbox: 1,
    }),
    'browser restart retains atomic records',
  );
  checks.push('browser restart persistence and idempotent replay');
}

async function verifySiteDataCleared(driver: BrowserSqliteDriver, checks: string[]): Promise<void> {
  const migration = await runMigrations(driver, schemaMigrations, () => now);
  assertEqual(migration.fromVersion, 0, 'cleared site data produces a new database');
  assertEqual(
    (
      await driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM planning_identities WHERE id = ?;',
        [accountOwnerId],
      )
    )?.count,
    0,
    'browser site-data clearing removes local planning data',
  );
  checks.push('browser-managed site-data clearing behavior');
}

function dependencies(
  driver: SqliteDriver,
  ownerId: OwnerId,
  ids: readonly string[],
): ApplicationDependencies {
  let index = 0;
  return {
    ...createSqliteApplicationAdapters(driver, { ownerId }),
    clock: { now: () => now },
    ids: {
      next() {
        const value = ids[index];
        if (value === undefined) throw new Error('Deterministic ID sequence exhausted.');
        index += 1;
        return value as UUID;
      },
    },
    projections: { notifyCommitted: () => Promise.resolve() },
  };
}

function createEnvelope(
  commandId: CommandId,
  input: CreateActionInput,
): CommandEnvelope<CreateActionInput> {
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

function deleteActionHandler(): CommandHandler<DeleteActionInput> {
  return async ({ input, context, records }) => {
    const current = await records.read(input.ref);
    if (current === null) throw new Error('Missing action for deletion.');
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

async function insertIdentity(
  driver: SqliteDriver,
  ownerId: OwnerId,
  kind: 'account' | 'local',
): Promise<void> {
  await driver.run(
    `INSERT INTO planning_identities (
       id, identity_kind, account_subject_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?);`,
    [ownerId, kind, kind === 'account' ? 'persistence-account' : null, now, now],
  );
}

function actionRef(ownerId: OwnerId, id: string): EntityRef<'action'> {
  return { type: 'action', ownerId, id: id as EntityRef<'action'>['id'] };
}

async function ownerCounts(
  driver: SqliteDriver,
  ownerId: OwnerId,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of [
    'actions',
    'domain_events',
    'undo_records',
    'command_receipts',
    'sync_outbox',
  ]) {
    const row = await driver.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE owner_id = ?;`,
      [ownerId],
    );
    counts[table] = row?.count ?? -1;
  }
  return counts;
}

async function expectRejected(promise: Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function report(status: 'failed' | 'passed', value: unknown): void {
  output.dataset['status'] = status;
  output.textContent = JSON.stringify(value, null, 2);
}
