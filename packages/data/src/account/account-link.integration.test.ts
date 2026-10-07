import {
  initialUploadOrder,
  seededAccountProfileId,
  type AccountStorePort,
  type AccountSyncStore,
} from '@yelaxis/application';
import type { Instant, OwnerId, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteIdentityContext } from '../application/sqlite-adapters';
import { ownedTables } from './owned-tables';
import type { SqliteAccountStore } from './sqlite-account-store';
import {
  accountSubject,
  columnsNaming,
  create,
  fixtureStart,
  openAccountFixture,
  ownedRows,
  profileNamingRows,
  removeAccountFixtures,
  seedEveryRecordType,
  update,
  type AccountFixture,
} from './testing/account-fixture';

afterEach(removeAccountFixtures);

const accountId = accountSubject as OwnerId;
const later = '2026-09-28T08:00:00.000Z' as Instant;

type OutboxRow = {
  readonly operation_id: string;
  readonly mutation_group_id: string;
  readonly command_id: string;
  readonly sequence: number;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly operation_kind: string;
  readonly expected_revision: number | null;
  readonly base_server_revision: number;
  readonly base_snapshot_hash: string | null;
  readonly state: string;
  readonly document_payload_json: string;
};

function outbox(fixture: AccountFixture): Promise<OutboxRow[]> {
  return fixture.driver.all<OutboxRow>('SELECT * FROM sync_outbox ORDER BY rowid;');
}

async function linkWithBackup(fixture: AccountFixture) {
  const backup = await fixture.account().createVerifiedBackup();
  if (!backup.ok) throw new Error(backup.error.code);
  const linked = await fixture
    .account()
    .linkToAccount({ accountSubjectId: accountSubject, backupId: backup.value.bundleId });
  if (!linked.ok) throw new Error(linked.error.code);
  return { backup: backup.value, receipt: linked.value };
}

/** Seed the same synthetic rows atomically so fixture setup does not pay one fsync per Action. */
async function seedActions(fixture: AccountFixture, owner: OwnerId, count: number): Promise<void> {
  await fixture.driver.transaction(async (transaction) => {
    for (let index = 0; index < count; index += 1) {
      await transaction.run(
        `INSERT INTO actions (id, owner_id, title, state, capture_origin, sort_key, created_at,
           updated_at)
         VALUES (?, ?, ?, 'inbox', 'inbox', ?, ?, ?);`,
        [
          fixture.ids.next(),
          owner,
          `Synthetic ${String(index)}`,
          `k${String(index)}`,
          later,
          later,
        ],
      );
    }
  });
}

/** The sync part's acknowledgments and first pull, as rows. */
async function acknowledgeInitialUpload(fixture: AccountFixture, linkId: string) {
  await fixture.driver.run("UPDATE sync_outbox SET state = 'acknowledged' WHERE command_id = ?;", [
    linkId,
  ]);
}

async function pullCheckpoint(fixture: AccountFixture, replicaId: string) {
  await fixture.driver.run(
    `INSERT INTO sync_checkpoints (
       id, owner_id, replica_id, server_cursor, last_success_at, created_at, updated_at
     ) VALUES (?, ?, ?, '42', ?, ?, ?);`,
    [fixture.ids.next(), accountId, replicaId, later, later, later],
  );
}

function failingStore(inner: SqliteAccountStore, failOnGroup: number): AccountStorePort {
  return {
    read: (work) => inner.read(work),
    runInTransaction: (work) =>
      inner.runInTransaction((transaction) => {
        let appended = 0;
        const sync: AccountSyncStore = {
          facts: (ownerId) => transaction.sync.facts(ownerId),
          firstUpload: (input) => transaction.sync.firstUpload(input),
          clear: (ownerId) => transaction.sync.clear(ownerId),
          appendGroup: async (group) => {
            appended += 1;
            if (appended === failOnGroup) throw new Error('Injected storage failure');
            await transaction.sync.appendGroup(group);
          },
        };
        return work({ ...transaction, sync });
      }),
  };
}

describe('linking a local plan to an account', () => {
  it('creates the account identity, remaps every row, and queues the initial upload', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    const snapshot = await fixture
      .store()
      .runInTransaction((transaction) => transaction.records.snapshot(plan.ownerId));
    const before: Record<string, number> = {};
    for (const table of ownedTables) before[table] = await ownedRows(fixture, table, plan.ownerId);

    const { backup, receipt } = await linkWithBackup(fixture);

    expect(receipt).toMatchObject({
      ownerId: accountId,
      sourceIdentityId: plan.ownerId,
      operations: snapshot.records.length,
      groups: 1,
    });
    const identity = await fixture.account().identity();
    expect(identity).toMatchObject({
      ok: true,
      value: {
        id: accountId,
        kind: 'account',
        accountSubjectId: accountSubject,
        replicaId: receipt.replicaId,
        linkId: receipt.linkId,
        linkSourceIdentityId: plan.ownerId,
        linkStartedAt: fixtureStart,
        linkedAt: null,
      },
    });
    // The local identity is retired, not lost: cancel restores it.
    await expect(
      fixture.driver.get<object>(
        'SELECT identity_kind, deleted_at FROM planning_identities WHERE id = ?;',
        [plan.ownerId],
      ),
    ).resolves.toEqual({ identity_kind: 'local', deleted_at: fixtureStart });
    for (const table of ownedTables) {
      expect(await ownedRows(fixture, table, plan.ownerId), table).toBe(0);
    }
    // Every row moved, plus the queued initial upload; the backup stays until linkage.
    expect(await ownedRows(fixture, 'sync_outbox', accountId)).toBe(snapshot.records.length);
    expect(await ownedRows(fixture, 'account_link_backups', accountId)).toBe(1);
    for (const table of ownedTables.filter(
      (name) => name !== 'sync_outbox' && name !== 'account_link_backups',
    )) {
      expect(await ownedRows(fixture, table, accountId), table).toBe(before[table]);
    }
    await expect(fixture.account().latestBackup()).resolves.toMatchObject({
      ok: true,
      value: { bundleId: backup.bundleId },
    });

    const rows = await outbox(fixture);
    expect(rows.every((row) => row.command_id === receipt.linkId)).toBe(true);
    expect(
      rows.every(
        (row) =>
          row.operation_kind === 'create' &&
          row.expected_revision === null &&
          row.base_server_revision === 0 &&
          row.base_snapshot_hash === null &&
          row.state === 'pending',
      ),
    ).toBe(true);
    expect(rows.map((row) => row.sequence)).toEqual(rows.map((_, index) => index));
    // Parents travel before the records that name them.
    const ranks = rows.map((row) => initialUploadOrder.indexOf(row.entity_type as never));
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    const blocks = rows.filter((row) => row.entity_type === 'time_block').map((r) => r.entity_id);
    expect(blocks.indexOf(plan.ids['supersedingBlockId']!)).toBeLessThan(
      blocks.indexOf(plan.ids['canceledBlockId']!),
    );
    // Each queued document is the codec document of the record, now under the account's Profile id.
    const linked = await fixture
      .store()
      .runInTransaction((transaction) => transaction.records.snapshot(accountId));
    expect(linked.records).toHaveLength(snapshot.records.length);
    const documents = new Map(
      linked.records.map((record) => [`${record.type}/${record.id}`, record.document]),
    );
    for (const row of rows) {
      expect(JSON.parse(row.document_payload_json)).toEqual(
        documents.get(`${row.entity_type}/${row.entity_id}`),
      );
    }
    await expect(fixture.driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);

    // The plan is now the account's: commands queue ordinary outbox groups.
    await expect(new SqliteIdentityContext(fixture.driver).getActiveIdentity()).resolves.toEqual({
      ownerId: accountId,
      syncEnabled: true,
    });
    const action = await fixture.read({
      type: 'action',
      id: plan.ids['actionId']!,
      ownerId: accountId,
    });
    const edited = await fixture.commit([
      update(action!, { ...action!.document, title: 'Draft the outline today' }),
    ]);
    expect(edited.sync).toMatchObject({ queued: true });
    await fixture.driver.close();
  });

  it('splits a large plan into groups of at most 500 operations', async () => {
    const fixture = await openAccountFixture();
    const owner = await fixture.ownerId();
    await seedActions(fixture, owner, 1_100);
    const { receipt } = await linkWithBackup(fixture);
    expect(receipt).toMatchObject({ groups: 5, operations: 1_101 });
    const sizes = await fixture.driver.all<{ size: number }>(
      `SELECT COUNT(*) AS size FROM sync_outbox GROUP BY mutation_group_id
       ORDER BY MIN(rowid);`,
    );
    expect(sizes.map(({ size }) => size)).toEqual([250, 250, 250, 250, 101]);
    await fixture.driver.close();
  });

  it('rolls the whole link back when any step fails', async () => {
    const fixture = await openAccountFixture();
    const owner = await fixture.ownerId();
    await seedActions(fixture, owner, 600);
    const backup = await fixture.account().createVerifiedBackup();
    if (!backup.ok) throw new Error(backup.error.code);
    const tables = async () => {
      const counts: Record<string, number> = {};
      for (const table of [...ownedTables, 'planning_identities']) {
        counts[table] =
          (await fixture.driver.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table};`))
            ?.count ?? -1;
      }
      return counts;
    };
    const before = await tables();

    // The second group fails after the remap and the first group were written.
    const failed = await fixture
      .account(failingStore(fixture.store(), 2))
      .linkToAccount({ accountSubjectId: accountSubject, backupId: backup.value.bundleId });

    expect(failed).toEqual({ ok: false, error: { code: 'store_failed' } });
    await expect(tables()).resolves.toEqual(before);
    for (const table of ownedTables) {
      expect(await ownedRows(fixture, table, accountId), table).toBe(0);
    }
    // The Profile rename rolled back with the rest.
    await expect(columnsNaming(fixture, seededAccountProfileId(accountSubject))).resolves.toEqual(
      [],
    );
    await expect(fixture.account().identity()).resolves.toMatchObject({
      ok: true,
      value: { id: owner, kind: 'local' },
    });
    // A retry with the kept backup succeeds.
    await expect(
      fixture
        .account()
        .linkToAccount({ accountSubjectId: accountSubject, backupId: backup.value.bundleId }),
    ).resolves.toMatchObject({ ok: true, value: { groups: 3, operations: 601 } });
    await fixture.driver.close();
  });

  it('discards a backup no link needs, and keeps a linking plan’s backup', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    const made = await fixture.account().createVerifiedBackup();
    if (!made.ok) throw new Error(made.error.code);
    // The link failed: the backup and its copy of the plan go; the plan itself stays.
    await expect(fixture.account().discardBackup()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(fixture.account().latestBackup()).resolves.toEqual({ ok: true, value: null });
    expect(await columnsNaming(fixture, made.value.bundleId)).toEqual([]);
    expect(await ownedRows(fixture, 'actions', plan.ownerId)).toBeGreaterThan(0);
    // A linking plan keeps its backup until linkage.
    const { backup } = await linkWithBackup(fixture);
    await expect(fixture.account().discardBackup()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(fixture.account().latestBackup()).resolves.toMatchObject({
      ok: true,
      value: { bundleId: backup.bundleId },
    });
    await fixture.driver.close();
  });

  it('refuses a missing backup, a non-local store, and an invalid subject', async () => {
    const fixture = await openAccountFixture();
    await expect(
      fixture.account().linkToAccount({
        accountSubjectId: accountSubject,
        backupId: 'a3000000-0000-4000-8000-000000000001' as UUID,
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'backup_missing' } });
    await expect(
      fixture.account().linkToAccount({ accountSubjectId: 'Not-A-Subject', backupId: null }),
    ).resolves.toEqual({ ok: false, error: { code: 'invalid_account_subject' } });
    await expect(
      fixture.account().linkToAccount({
        accountSubjectId: accountSubject.toUpperCase(),
        backupId: null,
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'invalid_account_subject' } });
    await linkWithBackup(fixture);
    await expect(
      fixture.account().linkToAccount({ accountSubjectId: accountSubject, backupId: null }),
    ).resolves.toEqual({ ok: false, error: { code: 'not_local' } });
    await fixture.driver.close();
  });
});

describe('completing, resuming, and canceling a link', () => {
  it('is linked once every initial group is acknowledged and a pull checkpoint exists', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    const { receipt } = await linkWithBackup(fixture);
    const account = fixture.account();

    await expect(account.firstUploadProgress()).resolves.toMatchObject({
      ok: true,
      value: {
        totalOperations: receipt.operations,
        acknowledgedOperations: 0,
        totalGroups: 1,
        openGroups: 1,
        pullCheckpoint: false,
      },
    });
    await expect(account.completeLinkIfReady()).resolves.toEqual({
      ok: true,
      value: { linked: false },
    });
    await acknowledgeInitialUpload(fixture, receipt.linkId);
    // A later edit waiting in its own group does not hold linkage back.
    const note = await fixture.read({
      type: 'note',
      id: plan.ids['noteId']!,
      ownerId: accountId,
    });
    await fixture.commit([update(note!, { ...note!.document, title: 'Sources (edited)' })]);
    await expect(account.completeLinkIfReady()).resolves.toEqual({
      ok: true,
      value: { linked: false },
    });
    await pullCheckpoint(fixture, receipt.replicaId);
    fixture.setNow(later);
    await expect(account.completeLinkIfReady()).resolves.toEqual({
      ok: true,
      value: { linked: true },
    });
    await expect(account.identity()).resolves.toMatchObject({
      ok: true,
      value: { linkedAt: later, linkStartedAt: fixtureStart },
    });
    // The retired local row and the backup were kept only until linkage.
    await expect(
      fixture.driver.get<object>('SELECT COUNT(*) AS count FROM planning_identities;'),
    ).resolves.toEqual({ count: 1 });
    await expect(account.latestBackup()).resolves.toEqual({ ok: true, value: null });
    await expect(account.completeLinkIfReady()).resolves.toEqual({
      ok: true,
      value: { linked: true },
    });
    await expect(account.cancelLink()).resolves.toEqual({
      ok: false,
      error: { code: 'not_linking' },
    });
    await expect(account.firstUploadProgress()).resolves.toEqual({ ok: true, value: null });
    await fixture.driver.close();
  });

  it('resumes after a restart with the same idempotent groups', async () => {
    const fixture = await openAccountFixture();
    await seedEveryRecordType(fixture);
    const { receipt } = await linkWithBackup(fixture);
    const queued = (await outbox(fixture)).map((row) => row.operation_id);
    // An interrupted push leaves a group sending; the sync part returns it to pending.
    await fixture.driver.run("UPDATE sync_outbox SET state = 'sending' WHERE sequence < 3;");

    await fixture.reopen();

    await expect(fixture.account().identity()).resolves.toMatchObject({
      ok: true,
      value: { id: accountId, linkId: receipt.linkId, linkedAt: null },
    });
    expect((await outbox(fixture)).map((row) => row.operation_id)).toEqual(queued);
    await expect(fixture.account().firstUploadProgress()).resolves.toMatchObject({
      ok: true,
      value: { totalOperations: receipt.operations, openGroups: 1 },
    });
    await acknowledgeInitialUpload(fixture, receipt.linkId);
    await pullCheckpoint(fixture, receipt.replicaId);
    await expect(fixture.account().completeLinkIfReady()).resolves.toEqual({
      ok: true,
      value: { linked: true },
    });
    await fixture.driver.close();
  });

  it('cancels before linkage, reversing the remap and keeping every record and later edit', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    const before: Record<string, number> = {};
    for (const table of ownedTables) before[table] = await ownedRows(fixture, table, plan.ownerId);
    const { backup, receipt } = await linkWithBackup(fixture);

    // Edits after linking, part of the upload acknowledged, a pull, a conflict, and a snapshot.
    const action = await fixture.read({
      type: 'action',
      id: plan.ids['actionId']!,
      ownerId: accountId,
    });
    await fixture.commit([
      update(action!, { ...action!.document, title: 'Edited while uploading' }),
    ]);
    const newNoteId = fixture.ids.next();
    await fixture.commit([
      create(
        { type: 'note', id: newNoteId, ownerId: accountId },
        { title: 'Written while uploading', orderKey: 'z0', state: 'active' },
      ),
    ]);
    await fixture.driver.run(
      `UPDATE sync_outbox SET state = 'acknowledged'
       WHERE command_id = ? AND sequence < 5;`,
      [receipt.linkId],
    );
    await fixture.driver.run(
      "UPDATE axes SET server_revision = 4, base_snapshot_hash = 'remote-hash';",
    );
    await pullCheckpoint(fixture, receipt.replicaId);
    await fixture.driver.run(
      `INSERT INTO sync_conflicts (
         id, owner_id, entity_type, entity_id, conflict_kind, state, candidate_schema_version,
         candidate_payload_json, base_server_revision, remote_server_revision, created_at,
         updated_at
       ) VALUES (?, ?, 'action', ?, 'create_collision', 'open', 1, '{}', 0, 1, ?, ?);`,
      [fixture.ids.next(), accountId, plan.ids['actionId']!, later, later],
    );
    await fixture.driver.run(
      `INSERT INTO base_snapshots (
         id, owner_id, entity_type, entity_id, snapshot_hash, snapshot_schema_version,
         snapshot_payload_json, snapshot_server_revision, created_at, updated_at
       ) VALUES (?, ?, 'axis', ?, 'remote-hash', 1, '{}', 4, ?, ?);`,
      [fixture.ids.next(), accountId, plan.ids['axisId']!, later, later],
    );

    fixture.setNow(later);
    await expect(fixture.account().cancelLink()).resolves.toEqual({
      ok: true,
      value: { ownerId: plan.ownerId },
    });

    await expect(fixture.account().identity()).resolves.toMatchObject({
      ok: true,
      value: { id: plan.ownerId, kind: 'local', linkId: null },
    });
    await expect(
      fixture.driver.get<object>('SELECT COUNT(*) AS count FROM planning_identities;'),
    ).resolves.toEqual({ count: 1 });
    for (const table of ownedTables) {
      expect(await ownedRows(fixture, table, accountId), table).toBe(0);
    }
    for (const table of ['sync_outbox', 'sync_conflicts', 'sync_checkpoints', 'base_snapshots']) {
      expect(await ownedRows(fixture, table, plan.ownerId), table).toBe(0);
    }
    // Every record stays, with the edits made while uploading.
    expect(await ownedRows(fixture, 'notes', plan.ownerId)).toBe(before['notes']! + 1);
    expect(await ownedRows(fixture, 'actions', plan.ownerId)).toBe(before['actions']);
    await expect(
      fixture.read({ type: 'action', id: plan.ids['actionId']!, ownerId: plan.ownerId }),
    ).resolves.toMatchObject({ document: { title: 'Edited while uploading' }, serverRevision: 0 });
    await expect(
      fixture.read({ type: 'note', id: newNoteId, ownerId: plan.ownerId }),
    ).resolves.toMatchObject({ document: { title: 'Written while uploading' } });
    await expect(
      fixture.driver.get<object>(
        `SELECT COUNT(*) AS count FROM axes
         WHERE server_revision <> 0 OR base_snapshot_hash IS NOT NULL;`,
      ),
    ).resolves.toEqual({ count: 0 });
    // The pre-link backup goes with the canceled link: nothing keeps that copy of the plan.
    await expect(fixture.account().latestBackup()).resolves.toEqual({ ok: true, value: null });
    expect(await ownedRows(fixture, 'account_link_backups', plan.ownerId)).toBe(0);
    expect(await columnsNaming(fixture, backup.bundleId)).toEqual([]);
    await expect(fixture.account().cancelLink()).resolves.toEqual({
      ok: false,
      error: { code: 'not_linking' },
    });
    await expect(fixture.driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    // The local plan works and can link again later.
    await expect(new SqliteIdentityContext(fixture.driver).getActiveIdentity()).resolves.toEqual({
      ownerId: plan.ownerId,
      syncEnabled: false,
    });
    await expect(
      fixture.account().linkToAccount({ accountSubjectId: accountSubject, backupId: null }),
    ).resolves.toMatchObject({ ok: true });
    await fixture.driver.close();
  });
});

describe('the account Profile id', () => {
  const accountProfileId = seededAccountProfileId(accountSubject);

  it('gives the Profile the account Profile id in every record, event, and receipt', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    const before = await profileNamingRows(fixture, plan.ownerId, plan.profileId);
    for (const [table, rows] of Object.entries(before)) expect(rows, table).toBeGreaterThan(0);

    const { receipt } = await linkWithBackup(fixture);

    await expect(profileNamingRows(fixture, accountId, accountProfileId)).resolves.toEqual(before);
    // Only the link (for cancel) and the verified backup made before it name the local id.
    await expect(columnsNaming(fixture, plan.profileId)).resolves.toEqual([
      'account_link_backups.bundle_json',
      'planning_identities.link_source_profile_id',
    ]);
    await expect(fixture.account().identity()).resolves.toMatchObject({
      ok: true,
      value: { id: accountId, linkSourceProfileId: plan.profileId },
    });
    await expect(
      fixture.read({ type: 'profile', id: accountProfileId, ownerId: accountId }),
    ).resolves.toMatchObject({
      document: { planningTimeZone: 'Asia/Tashkent', weekStart: 'monday', timeFormat: '24_hour' },
    });
    // The initial upload creates the account's Profile first, and every record names only it.
    const rows = await outbox(fixture);
    expect(rows).toHaveLength(receipt.operations);
    expect(rows[0]).toMatchObject({
      entity_type: 'profile',
      entity_id: accountProfileId,
      operation_kind: 'create',
    });
    const named = rows
      .map((row) => JSON.parse(row.document_payload_json) as Record<string, unknown>)
      .filter((document) => 'profileId' in document);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((document) => document['profileId'] === accountProfileId)).toBe(true);
    await expect(fixture.driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await fixture.driver.close();
  });

  it('cancel restores the Profile id everywhere, with edits made while linking', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    const before = await profileNamingRows(fixture, plan.ownerId, plan.profileId);
    await linkWithBackup(fixture);
    // While linking, the Profile changes and a new month Theme names the account's Profile.
    const profile = await fixture.read({
      type: 'profile',
      id: accountProfileId,
      ownerId: accountId,
    });
    await fixture.commit([update(profile!, { ...profile!.document, weekStart: 'sunday' })]);
    const themeId = fixture.ids.next();
    await fixture.commit([
      create(
        { type: 'theme', id: themeId, ownerId: accountId },
        { profileId: accountProfileId, month: '2026-11', text: 'Rest well' },
      ),
    ]);
    fixture.setNow(later);

    await expect(fixture.account().cancelLink()).resolves.toEqual({
      ok: true,
      value: { ownerId: plan.ownerId },
    });

    // Nothing anywhere names the account's Profile id any more.
    await expect(columnsNaming(fixture, accountProfileId)).resolves.toEqual([]);
    await expect(profileNamingRows(fixture, plan.ownerId, plan.profileId)).resolves.toEqual({
      ...before,
      month_themes: before['month_themes']! + 1,
      domain_events: before['domain_events']! + 1,
      command_receipts: before['command_receipts']! + 1,
    });
    await expect(
      fixture.read({ type: 'profile', id: plan.profileId, ownerId: plan.ownerId }),
    ).resolves.toMatchObject({ document: { weekStart: 'sunday' }, serverRevision: 0 });
    await expect(
      fixture.read({ type: 'theme', id: themeId, ownerId: plan.ownerId }),
    ).resolves.toMatchObject({ document: { profileId: plan.profileId } });
    await expect(fixture.driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    // Linking again renames it again.
    await expect(
      fixture.account().linkToAccount({ accountSubjectId: accountSubject, backupId: null }),
    ).resolves.toMatchObject({ ok: true });
    await expect(fixture.account().identity()).resolves.toMatchObject({
      ok: true,
      value: { linkSourceProfileId: plan.profileId },
    });
    // The canceled link's backup went with it: only the new link remembers the local id.
    await expect(columnsNaming(fixture, plan.profileId)).resolves.toEqual([
      'planning_identities.link_source_profile_id',
    ]);
    await fixture.driver.close();
  });

  it('keeps a Profile that has the account Profile id through a link and a cancel', async () => {
    const fixture = await openAccountFixture();
    const owner = await fixture.ownerId();
    const localProfileId = fixture.initialized.profileId;
    await fixture.store().runInTransaction((transaction) =>
      transaction.ownership.remapProfile({
        ownerId: owner,
        from: localProfileId,
        to: accountProfileId,
        at: fixtureStart,
      }),
    );

    await linkWithBackup(fixture);
    await expect(fixture.account().identity()).resolves.toMatchObject({
      ok: true,
      value: { id: accountId, linkSourceProfileId: null },
    });
    await expect(fixture.driver.all<object>('SELECT id, owner_id FROM profiles;')).resolves.toEqual(
      [{ id: accountProfileId, owner_id: accountId }],
    );
    await expect(fixture.account().cancelLink()).resolves.toMatchObject({ ok: true });
    await expect(fixture.driver.all<object>('SELECT id, owner_id FROM profiles;')).resolves.toEqual(
      [{ id: accountProfileId, owner_id: owner }],
    );
    await expect(columnsNaming(fixture, localProfileId)).resolves.toEqual([]);
    await expect(fixture.driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await fixture.driver.close();
  });
});

describe('account replicas, deletion, and detaching a kept copy', () => {
  it('creates an empty replica linked from its creation, or seeds an empty account', async () => {
    const source = await openAccountFixture();
    const seed = await source.account().profileSeed();
    expect(seed).toMatchObject({
      ok: true,
      value: {
        planningTimeZone: 'Asia/Tashkent',
        weekStart: 'monday',
        timeFormat: '24_hour',
        onboarding: { status: 'not_started', step: 'welcome' },
      },
    });

    const replica = await openAccountFixture();
    // A replica database starts without an identity.
    await replica.driver.run('DELETE FROM profiles;');
    await replica.driver.run('DELETE FROM planning_identities;');
    await expect(replica.account().identity()).resolves.toEqual({ ok: true, value: null });
    const seeded = await replica.account().createAccountReplica({
      accountSubjectId: accountSubject,
      profileSeed: seed.ok ? seed.value : null,
    });
    expect(seeded).toMatchObject({
      ok: true,
      value: { id: accountId, kind: 'account', linkedAt: fixtureStart, linkStartedAt: null },
    });
    await expect(
      replica.read({
        type: 'profile',
        id: seededAccountProfileId(accountSubject),
        ownerId: accountId,
      }),
    ).resolves.toMatchObject({
      document: { planningTimeZone: 'Asia/Tashkent', weekStart: 'monday', timeFormat: '24_hour' },
    });
    const rows = await outbox(replica);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_type: 'profile',
      entity_id: seededAccountProfileId(accountSubject),
      operation_kind: 'create',
      base_server_revision: 0,
    });
    // Opening the same account again changes nothing; another account cannot use this store.
    await expect(
      replica
        .account()
        .createAccountReplica({ accountSubjectId: accountSubject, profileSeed: null }),
    ).resolves.toMatchObject({ ok: true, value: { id: accountId } });
    await expect(
      replica.account().createAccountReplica({
        accountSubjectId: '5a000000-0000-4000-8000-000000000009',
        profileSeed: null,
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'identity_exists' } });

    const empty = await openAccountFixture();
    await empty.driver.run('DELETE FROM profiles;');
    await empty.driver.run('DELETE FROM planning_identities;');
    await expect(
      empty.account().createAccountReplica({ accountSubjectId: accountSubject, profileSeed: null }),
    ).resolves.toMatchObject({ ok: true, value: { id: accountId, linkedAt: fixtureStart } });
    expect(await outbox(empty)).toEqual([]);
    await expect(empty.account().ensureLocalIdentity()).resolves.toMatchObject({
      ok: true,
      value: { id: accountId },
    });

    const blank = await openAccountFixture();
    await blank.driver.run('DELETE FROM profiles;');
    await blank.driver.run('DELETE FROM planning_identities;');
    const local = await blank.account().ensureLocalIdentity();
    expect(local).toMatchObject({ ok: true, value: { kind: 'local' } });
    await expect(blank.account().ensureLocalIdentity()).resolves.toEqual(local);
    for (const fixture of [source, replica, empty, blank]) await fixture.driver.close();
  });

  it('records the deletion lifecycle and detaches a kept copy into a local-only plan', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    await expect(fixture.account().deletionStatus()).resolves.toEqual({
      ok: false,
      error: { code: 'not_account' },
    });
    const { receipt } = await linkWithBackup(fixture);
    await acknowledgeInitialUpload(fixture, receipt.linkId);
    await pullCheckpoint(fixture, receipt.replicaId);
    await fixture.account().completeLinkIfReady();
    const account = fixture.account();

    await expect(account.detachToLocalPlan()).resolves.toEqual({
      ok: false,
      error: { code: 'deletion_not_confirmed' },
    });
    await expect(account.recordDeletion({ kind: 'confirm' })).resolves.toEqual({
      ok: false,
      error: { code: 'deletion_state_invalid' },
    });
    await expect(
      account.recordDeletion({ kind: 'request', localCopy: 'keep' }),
    ).resolves.toMatchObject({ ok: true, value: { phase: 'requested', localCopy: 'keep' } });
    await account.recordDeletion({ kind: 'start' });
    await account.recordDeletion({ kind: 'fail', errorCode: 'server_unavailable' });
    await expect(account.deletionStatus()).resolves.toMatchObject({
      ok: true,
      value: { phase: 'failed_recoverable', errorCode: 'server_unavailable', localCopy: 'keep' },
    });
    await account.recordDeletion({ kind: 'start' });
    await expect(account.recordDeletion({ kind: 'confirm' })).resolves.toMatchObject({
      ok: true,
      value: { phase: 'confirmed', errorCode: null },
    });
    const pendingEdit = await fixture.read({
      type: 'note',
      id: plan.ids['noteId']!,
      ownerId: accountId,
    });
    await fixture.commit([
      update(pendingEdit!, { ...pendingEdit!.document, title: 'Kept on this device' }),
    ]);
    const before: Record<string, number> = {};
    for (const table of ownedTables) before[table] = await ownedRows(fixture, table, accountId);

    const detached = await account.detachToLocalPlan();
    if (!detached.ok) throw new Error(detached.error.code);
    const localId = detached.value.ownerId;

    await expect(account.identity()).resolves.toMatchObject({
      ok: true,
      value: { id: localId, kind: 'local', accountSubjectId: null, replicaId: null },
    });
    await expect(
      fixture.driver.get<object>('SELECT COUNT(*) AS count FROM planning_identities;'),
    ).resolves.toEqual({ count: 1 });
    for (const table of ownedTables) {
      expect(await ownedRows(fixture, table, accountId), table).toBe(0);
    }
    for (const table of [
      'sync_outbox',
      'sync_conflicts',
      'sync_checkpoints',
      'base_snapshots',
      'account_deletion_state',
    ]) {
      expect(await ownedRows(fixture, table, localId), table).toBe(0);
    }
    for (const table of ['actions', 'notes', 'axes', 'profiles', 'review_items', 'contexts']) {
      expect(await ownedRows(fixture, table, localId), table).toBe(before[table]);
    }
    await expect(
      fixture.read({ type: 'note', id: plan.ids['noteId']!, ownerId: localId }),
    ).resolves.toMatchObject({ document: { title: 'Kept on this device' }, serverRevision: 0 });
    // The kept copy keeps the deleted account's Profile id; nothing names the old local one.
    await expect(fixture.driver.all<object>('SELECT id, owner_id FROM profiles;')).resolves.toEqual(
      [{ id: seededAccountProfileId(accountSubject), owner_id: localId }],
    );
    await expect(columnsNaming(fixture, plan.profileId)).resolves.toEqual([]);
    await expect(new SqliteIdentityContext(fixture.driver).getActiveIdentity()).resolves.toEqual({
      ownerId: localId,
      syncEnabled: false,
    });
    await expect(fixture.driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await fixture.driver.close();
  });

  it('reports sync facts and states pending sync in an account export', async () => {
    const fixture = await openAccountFixture();
    await seedEveryRecordType(fixture);
    const { receipt } = await linkWithBackup(fixture);
    await fixture.driver.run(
      `INSERT INTO sync_conflicts (
         id, owner_id, entity_type, entity_id, conflict_kind, state, candidate_schema_version,
         candidate_payload_json, base_server_revision, remote_server_revision, created_at,
         updated_at
       ) VALUES (?, ?, 'axis', ?, 'stale_base', 'open', 1, '{}', 1, 2, ?, ?);`,
      [fixture.ids.next(), accountId, fixture.ids.next(), later, later],
    );
    await pullCheckpoint(fixture, receipt.replicaId);
    await expect(fixture.account().syncFacts()).resolves.toEqual({
      ok: true,
      value: { pendingOperations: receipt.operations, openConflicts: 1, lastSyncedAt: later },
    });
    const exported = await fixture.account().exportBundle();
    expect(exported).toMatchObject({
      ok: true,
      value: { manifest: { sourceMode: 'account', syncWasPending: true } },
    });
    expect(exported.ok && exported.value.text).not.toContain(receipt.replicaId);
    expect(exported.ok && exported.value.text).not.toContain(accountId);
    await acknowledgeInitialUpload(fixture, receipt.linkId);
    await expect(fixture.account().exportBundle()).resolves.toMatchObject({
      ok: true,
      value: { manifest: { syncWasPending: false } },
    });
    await fixture.driver.close();
  });
});
