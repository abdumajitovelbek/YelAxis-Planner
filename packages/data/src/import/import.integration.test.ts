import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAccountApplication,
  createImportApplication,
  createSyncApplication,
  seededAccountProfileId,
  type ImportApplication,
  type ImportStorePort,
  type ImportTransaction,
} from '@yelaxis/application';
import { createDeletionTombstone, type Instant, type OwnerId, type UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { CanonicalBundleCodec, canonicalJson, sha256Hex } from '../account/canonical-bundle';
import { SqliteAccountStore } from '../account/sqlite-account-store';
import {
  openAccountFixture,
  removeAccountFixtures,
  seedEveryRecordType,
} from '../account/testing/account-fixture';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { SqliteSyncStore } from '../sync/sqlite-sync-store';
import { createDefaultCanonicalCodecRegistry } from '../application/canonical-codecs';
import { SqliteNotificationStore } from '../notifications/sqlite-notification-store';
import { SqliteImportStore } from './sqlite-import-store';

const paths: string[] = [];
afterEach(async () => {
  await removeAccountFixtures();
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const at = '2026-10-03T05:00:00.000Z' as Instant;
const id = (number: number) =>
  `dd000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}` as UUID;
const owner = id(1);
const codec = new CanonicalBundleCodec();
const hasher = {
  hash: (document: Readonly<Record<string, unknown>>) => sha256Hex(canonicalJson(document)),
};

async function target(kind: 'local' | 'account' = 'local') {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-import-'));
  paths.push(directory);
  const path = join(directory, 'plan.sqlite');
  let driver = new NodeSqliteDriver(path);
  await runMigrations(driver, schemaMigrations, () => at);
  const profileId = kind === 'account' ? seededAccountProfileId(owner) : id(2);
  await driver.run(
    'INSERT INTO planning_identities (id, identity_kind, account_subject_id, replica_id, linked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
    [
      owner,
      kind,
      kind === 'account' ? owner : null,
      kind === 'account' ? id(3) : null,
      kind === 'account' ? at : null,
      at,
      at,
    ],
  );
  await driver.run(
    "INSERT INTO profiles (id, owner_id, planning_time_zone, week_start, time_format, onboarding_artifacts_json, created_at, updated_at) VALUES (?, ?, 'UTC', 'monday', '24_hour', '{\"axisIds\":[],\"commitments\":[]}', ?, ?);",
    [profileId, owner, at, at],
  );
  let counter = 100;
  const ids = { next: () => id(counter++) };
  const clock = { now: () => at };
  const account = () =>
    createAccountApplication({
      store: new SqliteAccountStore(driver),
      bundles: codec,
      clock,
      ids,
      appVersion: 'test',
    });
  const application = (store: ImportStorePort = new SqliteImportStore(driver)): ImportApplication =>
    createImportApplication({
      store,
      decoder: codec,
      bundles: codec,
      clock,
      ids,
      appVersion: 'test',
    });
  return {
    get driver() {
      return driver;
    },
    profileId,
    application,
    account,
    ids,
    clock,
    reopen: async () => {
      await driver.close();
      driver = new NodeSqliteDriver(path);
    },
  };
}

async function sourceBundle() {
  const source = await openAccountFixture();
  const plan = await seedEveryRecordType(source);
  await source.driver.run(
    'INSERT INTO deletion_ledger (id, owner_id, entity_type, entity_id, local_revision, server_revision, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 2, 0, ?, ?, ?);',
    [`${plan.ownerId}:action:${id(90)}`, plan.ownerId, 'action', id(90), at, at, at],
  );
  const result = await source.account().exportBundle();
  if (!result.ok) throw new Error('Synthetic source export failed');
  const decoded = await codec.decode(result.value.text);
  if (!decoded.ok) throw new Error('Synthetic source decode failed');
  return { source, plan, bundle: result.value, decoded: decoded.value };
}

async function acceptedPreview(
  application: ImportApplication,
  text: string,
  mode: 'merge' | 'replace' = 'merge',
) {
  const first = await application.preview(text, { mode });
  if (!first.ok) throw new Error(`Preview failed: ${first.code}`);
  if (first.value.conflicts.length === 0) return first.value;
  const resolved = await application.preview(text, {
    mode,
    decisions: first.value.conflicts.map((conflict) => ({
      type: conflict.type,
      id: conflict.id,
      decision: 'use_imported' as const,
    })),
  });
  if (!resolved.ok) throw new Error(`Resolved preview failed: ${resolved.code}`);
  return resolved.value;
}

describe('real SQLite canonical import and recovery', () => {
  it('round-trips every canonical entity, local Profile state, minimized history, tombstones, and Unicode with destination ownership', async () => {
    const { source, decoded, bundle } = await sourceBundle();
    const destination = await target();
    const application = destination.application();
    const preview = await acceptedPreview(application, bundle.text);
    expect(preview.problems).toEqual([]);
    expect(preview.canApply).toBe(true);
    const applied = await application.apply(preview.previewId);
    expect(applied).toMatchObject({
      ok: true,
      value: { actor: 'import', sync: { queued: false } },
    });
    const snapshot = await new SqliteAccountStore(destination.driver).runInTransaction(
      (transaction) => transaction.records.snapshot(owner),
    );
    expect(snapshot.ownerId).toBe(owner);
    expect(snapshot.records).toHaveLength(decoded.records.length);
    for (const original of decoded.records) {
      const row = snapshot.records.find(
        (record) =>
          record.type === original.type &&
          record.id === (original.type === 'profile' ? destination.profileId : original.id),
      );
      const text = JSON.stringify(original.document).replaceAll(
        decoded.supplement.profileSettings?.profileId ?? '',
        destination.profileId,
      );
      expect(row?.document, original.type).toEqual(JSON.parse(text));
    }
    const supplement = await new SqliteAccountStore(destination.driver).runInTransaction(
      (transaction) => transaction.records.supplement(owner),
    );
    expect(supplement.profileSettings).toMatchObject({
      preferredName: decoded.supplement.profileSettings?.preferredName,
      deviceState: decoded.supplement.profileSettings?.deviceState,
      onboardingDraft: decoded.supplement.profileSettings?.onboardingDraft,
      onboardingArtifacts: decoded.supplement.profileSettings?.onboardingArtifacts,
    });
    expect(supplement.tombstones).toEqual(decoded.supplement.tombstones);
    expect(supplement.history?.length).toBeGreaterThanOrEqual(
      decoded.supplement.history?.length ?? 0,
    );
    expect(await destination.driver.all('PRAGMA foreign_key_check;')).toEqual([]);
    const backup = await application.recoveryBackup();
    expect(backup?.recordCount).toBe(1);
    expect(backup !== null && (await codec.verify(backup.text)).ok).toBe(true);
    expect(await application.apply(preview.previewId)).toEqual(applied);
    const repeat = await acceptedPreview(application, bundle.text);
    expect(repeat).toMatchObject({
      creates: 0,
      updates: 0,
      identicalSkips: decoded.records.length,
      canApply: true,
    });
    await source.driver.close();
    await destination.driver.close();
  });

  it('keeps durable preview over restart and offers discard without canonical writes', async () => {
    const { source, bundle } = await sourceBundle();
    const destination = await target();
    const before = await destination.driver.all('SELECT * FROM profiles;');
    const preview = await acceptedPreview(destination.application(), bundle.text);
    await destination.reopen();
    const application = destination.application();
    expect((await application.pending())?.id).toBe(preview.previewId);
    expect(await application.resume()).toMatchObject({
      ok: true,
      value: { previewId: preview.previewId },
    });
    expect(await application.discard()).toEqual({ ok: true, value: undefined });
    expect(await application.pending()).toBeNull();
    expect(await destination.driver.all('SELECT * FROM profiles;')).toEqual(before);
    expect(await destination.driver.get('SELECT COUNT(*) AS count FROM actions;')).toEqual({
      count: 0,
    });
    await source.driver.close();
    await destination.driver.close();
  });

  it('rolls back failed writes while retaining the verified pre-import backup and resumable journal', async () => {
    const { source, bundle } = await sourceBundle();
    const destination = await target();
    const base = new SqliteImportStore(destination.driver);
    let fail = true;
    const broken: ImportStorePort = {
      readJournal: () => base.readJournal(),
      runInTransaction: (work) =>
        base.runInTransaction((transaction) => {
          let writes = 0;
          const wrapped = new Proxy(transaction, {
            get(target, field, receiver) {
              if (field === 'records')
                return {
                  read: transaction.records.read.bind(transaction.records),
                  apply: async (...args: Parameters<ImportTransaction['records']['apply']>) => {
                    writes += 1;
                    if (fail && writes === 2) throw new Error('Synthetic disk write failure');
                    return transaction.records.apply(...args);
                  },
                };
              const value = Reflect.get(target, field, receiver) as unknown;
              return typeof value === 'function'
                ? (value as (...args: unknown[]) => unknown).bind(transaction)
                : value;
            },
          });
          return work(wrapped);
        }),
    };
    const application = destination.application(broken);
    const preview = await acceptedPreview(application, bundle.text);
    const before = await destination.driver.all('SELECT * FROM profiles;');
    expect(await application.apply(preview.previewId)).toEqual({
      ok: false,
      code: 'storage_failed',
    });
    expect(await destination.driver.all('SELECT * FROM profiles;')).toEqual(before);
    expect(await destination.driver.get('SELECT COUNT(*) AS count FROM actions;')).toEqual({
      count: 0,
    });
    expect(await destination.driver.get('SELECT COUNT(*) AS count FROM domain_events;')).toEqual({
      count: 0,
    });
    expect((await application.pending())?.id).toBe(preview.previewId);
    const backup = await application.recoveryBackup();
    expect(backup !== null && (await codec.verify(backup.text)).ok).toBe(true);
    fail = false;
    expect(await application.apply(preview.previewId)).toMatchObject({ ok: true });
    await source.driver.close();
    await destination.driver.close();
  });

  it('requires typed replacement confirmation and restores a verified pre-import backup atomically', async () => {
    const { source, bundle } = await sourceBundle();
    const destination = await target();
    const application = destination.application();
    const preview = await acceptedPreview(application, bundle.text, 'replace');
    expect(await application.apply(preview.previewId, 'yes')).toEqual({
      ok: false,
      code: 'confirmation_required',
    });
    expect(await application.recoveryBackup()).toBeNull();
    expect(await application.apply(preview.previewId, 'REPLACE MY PLAN')).toMatchObject({
      ok: true,
    });
    const backup = await application.recoveryBackup();
    if (backup === null) throw new Error('No retained backup');
    const recovery = await acceptedPreview(application, backup.text, 'replace');
    const restored = await application.apply(recovery.previewId, 'REPLACE MY PLAN');
    expect(restored).toMatchObject({ ok: true });
    expect(await destination.driver.get('SELECT COUNT(*) AS count FROM actions;')).toEqual({
      count: 0,
    });
    expect(await destination.driver.get('SELECT COUNT(*) AS count FROM profiles;')).toEqual({
      count: 1,
    });
    expect(await destination.driver.all('PRAGMA foreign_key_check;')).toEqual([]);
    await source.driver.close();
    await destination.driver.close();
  });

  it('refuses a stale preview and malformed files without canonical writes', async () => {
    const { source, bundle } = await sourceBundle();
    const destination = await target();
    const application = destination.application();
    expect(await application.preview(bundle.text.slice(0, 99))).toEqual({
      ok: false,
      code: 'invalid_bundle',
    });
    expect(await application.pending()).toBeNull();
    const preview = await acceptedPreview(application, bundle.text);
    await destination.driver.run(
      "UPDATE profiles SET preferred_name = 'Changed' WHERE owner_id = ?;",
      [owner],
    );
    expect(await application.apply(preview.previewId)).toEqual({
      ok: false,
      code: 'preview_stale',
    });
    expect(await destination.driver.get('SELECT COUNT(*) AS count FROM actions;')).toEqual({
      count: 0,
    });
    await source.driver.close();
    await destination.driver.close();
  });

  it('queues offline account imports once and acknowledges the ordinary group idempotently', async () => {
    const { source, bundle } = await sourceBundle();
    const destination = await target('account');
    const application = destination.application();
    const preview = await acceptedPreview(application, bundle.text);
    const applied = await application.apply(preview.previewId);
    expect(applied).toMatchObject({ ok: true, value: { sync: { queued: true } } });
    const sync = createSyncApplication({
      store: new SqliteSyncStore(destination.driver),
      hasher,
      clock: destination.clock,
      ids: destination.ids,
    });
    const group = await sync.claimNextGroup();
    expect(group?.operations.length).toBe(preview.creates + preview.updates);
    if (group === null) throw new Error('Import did not queue ordinary group');
    const acknowledgments = group.operations.map((operation) => ({
      operationId: operation.operationId,
      entityType: operation.entityType,
      entityId: operation.entityId,
      serverRevision: 1,
    }));
    expect(
      await sync.recordPushOutcome(group.mutationGroupId, {
        kind: 'accepted',
        acknowledgments,
        cursor: '1',
      }),
    ).toEqual({ status: 'acknowledged' });
    expect(
      await sync.recordPushOutcome(group.mutationGroupId, {
        kind: 'accepted',
        acknowledgments,
        cursor: '1',
      }),
    ).toEqual({ status: 'stale' });
    expect(await sync.claimNextGroup()).toBeNull();
    const owners = await destination.driver.all<{ owner_id: string }>(
      'SELECT DISTINCT owner_id FROM domain_events UNION SELECT DISTINCT owner_id FROM actions;',
    );
    expect(owners).toEqual([{ owner_id: owner }]);
    await source.driver.close();
    await destination.driver.close();
  });

  it('preserves candidates without source server authority, blocks their group, and resolves as an ordinary queued change', async () => {
    const { source, decoded } = await sourceBundle();
    const action = decoded.records.find((row) => row.type === 'action');
    if (action === undefined) throw new Error('Synthetic plan has no action');
    const bundle = await codec.encode({
      snapshot: { ownerId: decoded.records[0]?.id as OwnerId, records: decoded.records },
      supplement: {
        ...decoded.supplement,
        openConflicts: [
          {
            conflictId: id(91),
            localRevision: 1,
            entityType: 'action',
            entityId: action.id,
            kind: 'stale_base',
            fields: ['title'],
            base: action.document,
            local: { deleted: false, document: action.document },
            remote: {
              deleted: false,
              document: { ...action.document, title: 'Recovered other candidate' },
            },
            createdAt: at,
          },
        ],
      },
      bundleId: id(92),
      exportedAt: at,
      appVersion: 'test',
      sourceMode: 'account',
      syncWasPending: true,
    });
    const destination = await target('account');
    const application = destination.application();
    const preview = await acceptedPreview(application, bundle.text);
    expect(await application.apply(preview.previewId)).toMatchObject({ ok: true });
    const sync = createSyncApplication({
      store: new SqliteSyncStore(destination.driver),
      hasher,
      clock: destination.clock,
      ids: destination.ids,
    });
    expect(await sync.claimNextGroup()).toBeNull();
    expect(
      await destination.driver.get(
        'SELECT base_server_revision, remote_server_revision, resolution_strategy FROM sync_conflicts WHERE id = ?;',
        [id(91)],
      ),
    ).toEqual({
      base_server_revision: 0,
      remote_server_revision: 0,
      resolution_strategy: 'import_recovery',
    });
    expect(await application.resolveRecovery(id(91), 'use_remote')).toMatchObject({
      ok: true,
      value: { sync: { queued: true } },
    });
    const groups = await destination.driver.all<{
      actor: string;
      state: string;
      document_payload_json: string;
    }>(
      'SELECT actor, state, document_payload_json FROM sync_outbox WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;',
      [owner, 'action', action.id],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.state).toBe('pending');
    expect(JSON.parse(groups[0]?.document_payload_json ?? '{}')).toMatchObject({
      title: 'Recovered other candidate',
    });
    expect(await application.recoveryConflicts()).toEqual([]);
    const ready = await sync.claimNextGroup();
    expect(ready?.operations).toHaveLength(preview.creates + preview.updates);
    expect(ready?.operations.find((operation) => operation.entityId === action.id)).toMatchObject({
      kind: 'create',
      document: { title: 'Recovered other candidate' },
    });
    await source.driver.close();
    await destination.driver.close();
  });

  it('resolves new-record recovery through the account conflict use case without splitting its dependent create group', async () => {
    const { source, decoded } = await sourceBundle();
    const action = decoded.records.find((row) => row.type === 'action');
    if (action === undefined) throw new Error('Synthetic plan has no action');
    const bundle = await codec.encode({
      snapshot: { ownerId: owner, records: decoded.records },
      supplement: {
        ...decoded.supplement,
        openConflicts: [
          {
            conflictId: id(91),
            localRevision: 1,
            entityType: 'action',
            entityId: action.id,
            kind: 'stale_base',
            fields: ['title'],
            base: action.document,
            local: { deleted: false, document: action.document },
            remote: {
              deleted: false,
              document: { ...action.document, title: 'Account recovery choice' },
            },
            createdAt: at,
          },
        ],
      },
      bundleId: id(92),
      exportedAt: at,
      appVersion: 'test',
      sourceMode: 'account',
      syncWasPending: true,
    });
    const destination = await target('account');
    const application = destination.application();
    const preview = await acceptedPreview(application, bundle.text);
    const applied = await application.apply(preview.previewId);
    if (!applied.ok || !applied.value.sync.queued) throw new Error('Import not queued');
    const sync = createSyncApplication({
      store: new SqliteSyncStore(destination.driver),
      hasher,
      clock: destination.clock,
      ids: destination.ids,
    });
    expect(await sync.resolveConflict(id(91), { choice: 'keep_remote' })).toEqual({
      ok: true,
      value: { queued: true },
    });
    const ready = await sync.claimNextGroup();
    expect(ready?.mutationGroupId).toBe(applied.value.sync.mutationGroupId);
    expect(ready?.operations).toHaveLength(preview.creates + preview.updates);
    expect(ready?.operations.find((operation) => operation.entityId === action.id)).toMatchObject({
      kind: 'create',
      baseServerRevision: 0,
      document: { title: 'Account recovery choice' },
    });
    await source.driver.close();
    await destination.driver.close();
  });

  it('clears stale notification receipts and cursors on replace while preserving device privacy preferences and other owners', async () => {
    const { source, plan, bundle } = await sourceBundle();
    const reminderId = plan.ids['reminderId'];
    if (reminderId === undefined) throw new Error('No synthetic Reminder');
    const destination = await target();
    const application = destination.application(
      new SqliteImportStore(destination.driver, { ownerId: owner }),
    );
    const first = await acceptedPreview(application, bundle.text);
    expect(await application.apply(first.previewId)).toMatchObject({ ok: true });
    const notifications = new SqliteNotificationStore(destination.driver);
    expect(
      (await notifications.listDue(owner, at, 50)).some((row) => row.reminderId === reminderId),
    ).toBe(true);
    const other = id(98);
    await destination.driver.run(
      "INSERT INTO planning_identities (id, identity_kind, created_at, updated_at) VALUES (?, 'local', ?, ?);",
      [other, at, at],
    );
    for (const identity of [owner, other]) {
      await destination.driver.run(
        'INSERT INTO notification_preferences (owner_id, alerts_enabled, privacy_mode, updated_at) VALUES (?, 1, 0, ?);',
        [identity, at],
      );
      await destination.driver.run(
        "INSERT INTO notification_receipts (owner_id, reminder_id, reminder_revision, occurrence_key, due_at, observed_at, delivery_status) VALUES (?, ?, 1, '', ?, ?, 'delivered');",
        [identity, reminderId, at, at],
      );
      await destination.driver.run(
        'INSERT INTO notification_routine_cursors (owner_id, reminder_id, reminder_revision, next_date) VALUES (?, ?, 1, ?);',
        [identity, reminderId, '2030-01-01'],
      );
    }
    expect(await notifications.listDue(owner, at, 50)).toEqual([]);
    const replacement = await acceptedPreview(application, bundle.text, 'replace');
    expect(await application.apply(replacement.previewId, 'REPLACE MY PLAN')).toMatchObject({
      ok: true,
    });
    expect(
      (await notifications.listDue(owner, at, 50)).some((row) => row.reminderId === reminderId),
    ).toBe(true);
    expect(
      await destination.driver.get(
        'SELECT COUNT(*) AS count FROM notification_routine_cursors WHERE owner_id = ?;',
        [owner],
      ),
    ).toEqual({ count: 0 });
    expect(
      await destination.driver.get(
        'SELECT COUNT(*) AS count FROM notification_receipts WHERE owner_id = ?;',
        [other],
      ),
    ).toEqual({ count: 1 });
    expect(
      await destination.driver.get(
        'SELECT COUNT(*) AS count FROM notification_routine_cursors WHERE owner_id = ?;',
        [other],
      ),
    ).toEqual({ count: 1 });
    expect(await notifications.getPreferences(owner)).toEqual({
      alertsEnabled: true,
      privacyMode: false,
    });
    await source.driver.close();
    await destination.driver.close();
  });

  it('Routine permanent deletion removes only internal generations and refuses to cascade explicit defaults', async () => {
    const { source, decoded } = await sourceBundle();
    const destination = await target();
    const routine = decoded.records.find((row) => row.type === 'routine');
    if (routine === undefined) throw new Error('No synthetic Routine');
    const document = { ...routine.document };
    delete document['axisId'];
    const registry = createDefaultCanonicalCodecRegistry();
    const context = { ownerId: owner, commandId: id(77), actor: 'import' as const, now: at };
    const ref = { type: 'routine' as const, id: id(78), ownerId: owner };
    const create = {
      operation: 'create' as const,
      ref,
      expectedRevision: null,
      baseServerRevision: 0,
      baseSnapshotHash: null,
      document,
    };
    await destination.driver.transaction((connection) =>
      registry.resolve('routine').apply(connection, create, context),
    );
    await destination.driver.transaction(async (connection) => {
      await connection.run('PRAGMA defer_foreign_keys = ON;');
      await registry.resolve('routine').apply(
        connection,
        {
          operation: 'delete',
          ref,
          expectedRevision: 1,
          baseServerRevision: 0,
          baseSnapshotHash: null,
          tombstone: createDeletionTombstone(ref, 2, at),
        },
        context,
      );
    });
    expect(
      await destination.driver.get(
        'SELECT COUNT(*) AS count FROM routine_generations WHERE owner_id = ? AND routine_id = ?;',
        [owner, ref.id],
      ),
    ).toEqual({ count: 0 });
    expect(
      await destination.driver.get(
        'SELECT entity_type FROM deletion_ledger WHERE owner_id = ? AND entity_id = ?;',
        [owner, ref.id],
      ),
    ).toEqual({ entity_type: 'routine' });
    const kept = { ...ref, id: id(79) };
    await destination.driver.transaction(async (connection) => {
      await registry.resolve('routine').apply(connection, { ...create, ref: kept }, context);
      await registry.resolve('routine_action_defaults').apply(
        connection,
        {
          operation: 'create',
          ref: { type: 'routine_action_defaults', id: id(80), ownerId: owner },
          expectedRevision: null,
          baseServerRevision: 0,
          baseSnapshotHash: null,
          document: { routineId: kept.id, generation: 1 },
        },
        context,
      );
    });
    await expect(
      destination.driver.transaction(async (connection) => {
        await connection.run('PRAGMA defer_foreign_keys = ON;');
        await registry.resolve('routine').apply(
          connection,
          {
            operation: 'delete',
            ref: kept,
            expectedRevision: 1,
            baseServerRevision: 0,
            baseSnapshotHash: null,
            tombstone: createDeletionTombstone(kept, 2, at),
          },
          context,
        );
      }),
    ).rejects.toThrow();
    expect(
      await destination.driver.get(
        'SELECT COUNT(*) AS count FROM routine_action_defaults WHERE owner_id = ? AND routine_id = ?;',
        [owner, kept.id],
      ),
    ).toEqual({ count: 1 });
    expect(
      await destination.driver.get(
        'SELECT COUNT(*) AS count FROM routine_generations WHERE owner_id = ? AND routine_id = ?;',
        [owner, kept.id],
      ),
    ).toEqual({ count: 1 });
    await source.driver.close();
    await destination.driver.close();
  });

  it('starts a fresh reminder lifecycle after explicit Merge resurrection without restoring device preferences', async () => {
    const { source, plan, bundle } = await sourceBundle();
    const reminderId = plan.ids['reminderId'];
    if (reminderId === undefined) throw new Error('No synthetic Reminder');
    const destination = await target();
    const application = destination.application();
    expect(
      await application.apply((await acceptedPreview(application, bundle.text)).previewId),
    ).toMatchObject({ ok: true });
    await destination.driver.run(
      'INSERT INTO notification_preferences (owner_id, alerts_enabled, privacy_mode, updated_at) VALUES (?, 1, 1, ?);',
      [owner, at],
    );
    await destination.driver.run(
      "INSERT INTO notification_receipts (owner_id, reminder_id, reminder_revision, occurrence_key, due_at, observed_at, delivery_status) VALUES (?, ?, 1, '', ?, ?, 'delivered');",
      [owner, reminderId, at, at],
    );
    await destination.driver.run(
      'INSERT INTO notification_routine_cursors (owner_id, reminder_id, reminder_revision, next_date) VALUES (?, ?, 1, ?);',
      [owner, reminderId, '2030-01-01'],
    );
    const registry = createDefaultCanonicalCodecRegistry();
    const ref = { type: 'reminder' as const, id: reminderId, ownerId: owner };
    await destination.driver.transaction((connection) =>
      registry.resolve('reminder').apply(
        connection,
        {
          operation: 'delete',
          ref,
          expectedRevision: 1,
          baseServerRevision: 0,
          baseSnapshotHash: null,
          tombstone: createDeletionTombstone(ref, 2, at),
        },
        { ownerId: owner, commandId: id(75), actor: 'user', now: at },
      ),
    );
    const unresolved = await application.preview(bundle.text);
    expect(unresolved).toMatchObject({
      ok: true,
      value: { conflicts: [{ type: 'reminder', reason: 'deleted_here' }] },
    });
    expect(
      await application.apply((await acceptedPreview(application, bundle.text)).previewId),
    ).toMatchObject({ ok: true });
    const notifications = new SqliteNotificationStore(destination.driver);
    expect(
      (await notifications.listDue(owner, at, 50)).some((row) => row.reminderId === reminderId),
    ).toBe(true);
    expect(
      await destination.driver.get(
        'SELECT COUNT(*) AS count FROM notification_receipts WHERE owner_id = ? AND reminder_id = ?;',
        [owner, ref.id],
      ),
    ).toEqual({ count: 0 });
    expect(
      await destination.driver.get(
        'SELECT COUNT(*) AS count FROM notification_routine_cursors WHERE owner_id = ? AND reminder_id = ?;',
        [owner, ref.id],
      ),
    ).toEqual({ count: 0 });
    expect(await notifications.getPreferences(owner)).toEqual({
      alertsEnabled: true,
      privacyMode: true,
    });
    await source.driver.close();
    await destination.driver.close();
  });

  it('remaps the converted record inside preserved recovery candidates when duplicating their dependency component', async () => {
    const destination = await target();
    const actionId = id(81);
    const noteId = id(82);
    const current = { title: 'Existing', orderKey: 'a', state: 'planned', captureOrigin: 'plan' };
    await destination.driver.transaction((connection) =>
      createDefaultCanonicalCodecRegistry()
        .resolve('action')
        .apply(
          connection,
          {
            operation: 'create',
            ref: { type: 'action', id: actionId, ownerId: owner },
            expectedRevision: null,
            baseServerRevision: 0,
            baseSnapshotHash: null,
            document: current,
          },
          { ownerId: owner, commandId: id(83), actor: 'user', now: at },
        ),
    );
    const converted = {
      ...current,
      title: 'Converted',
      state: 'archived',
      stateBeforeArchive: 'planned',
      archivedAt: at,
      convertedTo: { type: 'note', id: noteId },
    };
    const records = [
      {
        type: 'profile' as const,
        id: destination.profileId,
        localRevision: 1,
        document: { planningTimeZone: 'UTC', weekStart: 'monday', timeFormat: '24_hour' },
      },
      { type: 'action' as const, id: actionId, localRevision: 1, document: converted },
      {
        type: 'note' as const,
        id: noteId,
        localRevision: 1,
        document: { body: 'Converted note', state: 'active', orderKey: 'a' },
      },
    ];
    const bundle = await codec.encode({
      snapshot: { ownerId: owner, records },
      supplement: {
        profileSettings: null,
        openConflicts: [
          {
            conflictId: id(84),
            localRevision: 1,
            entityType: 'action',
            entityId: actionId,
            kind: 'stale_base',
            fields: ['title'],
            base: converted,
            local: { deleted: false, document: converted },
            remote: {
              deleted: false,
              document: { ...converted, title: 'Other converted candidate' },
            },
            createdAt: at,
          },
        ],
      },
      bundleId: id(85),
      exportedAt: at,
      appVersion: 'test',
      sourceMode: 'local',
      syncWasPending: false,
    });
    const application = destination.application();
    const preview = await application.preview(bundle.text, {
      decisions: [{ type: 'action', id: actionId, decision: 'duplicate_imported' }],
    });
    expect(preview).toMatchObject({ ok: true, value: { creates: 2, canApply: true } });
    if (!preview.ok) throw new Error('Synthetic preview failed');
    expect(await application.apply(preview.value.previewId)).toMatchObject({ ok: true });
    const note = await destination.driver.get<{ id: UUID }>(
      'SELECT id FROM notes WHERE owner_id = ?;',
      [owner],
    );
    const conflicts = await application.recoveryConflicts();
    expect(note?.id).not.toBe(noteId);
    expect(conflicts[0]?.remote.document?.['convertedTo']).toEqual({ type: 'note', id: note?.id });
    expect(await application.resolveRecovery(id(84), 'use_remote')).toMatchObject({ ok: true });
    const restored = await destination.driver.get<{ converted_to_id: UUID }>(
      'SELECT converted_to_id FROM actions WHERE owner_id = ? AND id <> ?;',
      [owner, actionId],
    );
    expect(restored?.converted_to_id).toBe(note?.id);
    await destination.driver.close();
  });
});
