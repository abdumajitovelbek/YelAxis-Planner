import {
  seededAccountProfileId,
  type CanonicalSnapshotRecord,
  type EncodedBundle,
} from '@yelaxis/application';
import type { EntityType, Instant, OwnerId, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { schemaInventory } from '../sqlite/schema/inventory';
import {
  bundleSections,
  bundleSupplementSections,
  CanonicalBundleCodec,
  canonicalJson,
  sha256Hex,
} from './canonical-bundle';
import { snapshotSources } from './canonical-snapshot';
import { canonicalRecordTables, ownedTables, profileReferenceTables } from './owned-tables';
import {
  accountSubject,
  columnsNaming,
  fixtureStart,
  openAccountFixture,
  ownedRows,
  profileNamingRows,
  removeAccountFixtures,
  seedBookkeeping,
  seedEveryRecordType,
} from './testing/account-fixture';

afterEach(removeAccountFixtures);

const everyEntityType: readonly EntityType[] = Object.keys(bundleSections) as EntityType[];

async function liveTables(fixture: Awaited<ReturnType<typeof openAccountFixture>>) {
  const tables = await fixture.driver.all<{ name: string }>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_schema_migrations'
     ORDER BY name;`,
  );
  const columns = new Map<string, Set<string>>();
  for (const { name } of tables) {
    const info = await fixture.driver.all<{ name: string }>(`PRAGMA table_info(${name});`);
    columns.set(name, new Set(info.map((column) => column.name)));
  }
  return columns;
}

describe('owned table catalog', () => {
  it('names every table with an owner, so a new owned table cannot be missed', async () => {
    const fixture = await openAccountFixture();
    const columns = await liveTables(fixture);
    const live = [...columns.keys()].sort();
    // Every live table is inventoried, and every inventoried table exists.
    expect([...schemaInventory.tables].sort()).toEqual(live);
    const withOwner = live.filter((table) => columns.get(table)?.has('owner_id'));
    expect([...ownedTables].sort()).toEqual(withOwner);
    expect(live.filter((table) => !withOwner.includes(table))).toEqual(['planning_identities']);
    // Canonical record tables are exactly those with the synchronized-record metadata.
    const recordTables = live.filter((table) =>
      ['server_revision', 'base_snapshot_hash', 'client_updated_at', 'device_id'].every((column) =>
        columns.get(table)?.has(column),
      ),
    );
    expect([...canonicalRecordTables].sort()).toEqual(recordTables);
    // Every canonical table is read by a snapshot source (Routine generations by the Routine).
    const read = new Set([
      ...snapshotSources.flatMap(({ tables }) => tables),
      'routine_generations',
    ]);
    expect([...read].sort()).toEqual([...canonicalRecordTables].sort());
    expect(snapshotSources.map(({ type }) => type)).toEqual([...everyEntityType].sort());
    await fixture.driver.close();
  });

  it('names every table that refers to the Profile, each by its owner-scoped key', async () => {
    const fixture = await openAccountFixture();
    const columns = await liveTables(fixture);
    const withProfile = [...columns.entries()]
      .filter(([, names]) => names.has('profile_id'))
      .map(([table]) => table);
    expect([...profileReferenceTables].sort()).toEqual(withProfile.sort());
    // Every foreign key to `profiles` is `(owner_id, profile_id)` of one of those tables.
    const references: string[] = [];
    for (const table of columns.keys()) {
      const keys = await fixture.driver.all<{
        id: number;
        table: string;
        from: string;
        to: string;
      }>(`PRAGMA foreign_key_list(${table});`);
      const toProfiles = keys.filter((key) => key.table === 'profiles');
      for (const id of new Set(toProfiles.map((key) => key.id))) {
        const pairs = toProfiles
          .filter((key) => key.id === id)
          .map((key) => `${key.from}>${key.to}`)
          .sort();
        references.push(`${table}(${pairs.join(',')})`);
      }
    }
    expect(references.sort()).toEqual(
      profileReferenceTables.map((table) => `${table}(owner_id>owner_id,profile_id>id)`).sort(),
    );
    await fixture.driver.close();
  });
});

describe('ownership remap', () => {
  it('moves every row of every owned table and keeps owner-keyed values consistent', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    await seedBookkeeping(fixture, plan.ownerId, { type: 'action', id: plan.ids['actionId']! });
    const before: Record<string, number> = {};
    for (const table of ownedTables) {
      before[table] = await ownedRows(fixture, table, plan.ownerId);
      expect(before[table], table).toBeGreaterThan(0);
    }
    const accountId = accountSubject as OwnerId;

    const result = await fixture.store().runInTransaction(async (transaction) => {
      await transaction.identities.insertAccount({
        id: accountId,
        accountSubjectId: accountSubject,
        replicaId: 'a1000000-0000-4000-8000-000000000001' as UUID,
        at: fixtureStart,
        link: null,
      });
      const remapped = await transaction.ownership.remap({
        from: plan.ownerId,
        to: accountId,
        at: fixtureStart,
      });
      await transaction.identities.retire(plan.ownerId, fixtureStart);
      return remapped;
    });

    expect(result.rowsByTable).toEqual(before);
    for (const table of ownedTables) {
      expect(await ownedRows(fixture, table, plan.ownerId), table).toBe(0);
      expect(await ownedRows(fixture, table, accountId), table).toBe(before[table]);
    }
    await expect(fixture.driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    // Ledger ids are owner-keyed.
    const ledger = await fixture.driver.all<{ id: string }>('SELECT id FROM deletion_ledger;');
    expect(ledger.every(({ id }) => id.startsWith(`${accountId}:action:`))).toBe(true);
    // Receipts name the new owner everywhere.
    const receipts = await fixture.driver.all<{ receipt_payload_json: string }>(
      'SELECT receipt_payload_json FROM command_receipts;',
    );
    for (const { receipt_payload_json: payload } of receipts) {
      expect(payload).not.toContain(plan.ownerId);
      const parsed = JSON.parse(payload) as {
        ownerId: string;
        canonical: { ref: { ownerId: string } }[];
      };
      expect(parsed.ownerId).toBe(accountId);
      expect(parsed.canonical.every(({ ref }) => ref.ownerId === accountId)).toBe(true);
    }
    // Undo of earlier commands ends, and keeps no prior content.
    await expect(
      fixture.driver.all<object>('SELECT state, descriptor_payload_json FROM undo_records;'),
    ).resolves.toEqual([
      {
        state: 'expired',
        descriptor_payload_json:
          '{"commandType":"redacted_for_identity_change","payload":{},"expectedRevisions":{}}',
      },
    ]);
    // A queued delete's tombstone names the new owner.
    const tombstone = await fixture.driver.get<{ document_payload_json: string }>(
      "SELECT document_payload_json FROM sync_outbox WHERE operation_kind = 'delete';",
    );
    expect(JSON.parse(tombstone?.document_payload_json ?? '{}')).toMatchObject({
      ownerId: accountId,
    });
    await fixture.driver.close();
  });

  it('refuses to remap an identity onto itself', async () => {
    const fixture = await openAccountFixture();
    const owner = await fixture.ownerId();
    await expect(
      fixture
        .store()
        .runInTransaction((transaction) =>
          transaction.ownership.remap({ from: owner, to: owner, at: fixtureStart }),
        ),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    await fixture.driver.close();
  });
});

describe('Profile remap', () => {
  const renamed = seededAccountProfileId(accountSubject);
  const later = '2026-09-28T08:00:00.000Z' as Instant;

  it('renames the Profile in every record, event, and receipt; undo naming it ends', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    // Bookkeeping about an Action (undo, queued delete, conflict, base snapshot) does not name it.
    await seedBookkeeping(fixture, plan.ownerId, { type: 'action', id: plan.ids['actionId']! });
    // Undo of an earlier command that changed the Profile names it twice.
    const undoId = fixture.ids.next();
    await fixture.driver.run(
      `INSERT INTO undo_records (
         id, owner_id, command_id, state, descriptor_schema_version, descriptor_payload_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'available', 1, ?, ?, ?);`,
      [
        undoId,
        plan.ownerId,
        fixture.ids.next(),
        JSON.stringify({
          commandType: 'planning.restore_v1',
          payload: {
            prior: [
              {
                ref: { type: 'profile', id: plan.profileId, ownerId: plan.ownerId },
                document: { planningTimeZone: 'UTC', weekStart: 'sunday', timeFormat: '12_hour' },
              },
            ],
          },
          expectedRevisions: { [`${plan.ownerId}:profile:${plan.profileId}`]: 2 },
        }),
        fixtureStart,
        fixtureStart,
      ],
    );
    const before = await profileNamingRows(fixture, plan.ownerId, plan.profileId);
    for (const [table, rows] of Object.entries(before)) expect(rows, table).toBeGreaterThan(0);

    const result = await fixture.store().runInTransaction((transaction) =>
      transaction.ownership.remapProfile({
        ownerId: plan.ownerId,
        from: plan.profileId,
        to: renamed,
        at: later,
      }),
    );

    expect(result.rowsByTable).toEqual({ ...before, undo_records: 1 });
    await expect(profileNamingRows(fixture, plan.ownerId, renamed)).resolves.toEqual(before);
    // Nothing anywhere names the old id, JSON included.
    await expect(columnsNaming(fixture, plan.profileId)).resolves.toEqual([]);
    await expect(
      fixture.read({ type: 'profile', id: renamed, ownerId: plan.ownerId }),
    ).resolves.toMatchObject({
      document: { planningTimeZone: 'Asia/Tashkent', weekStart: 'monday', timeFormat: '24_hour' },
    });
    for (const [type, id] of [
      ['theme', plan.ids['themeId']],
      ['direction', plan.ids['directionId']],
      ['focus_selection', plan.ids['focusId']],
      ['review', plan.ids['reviewId']],
    ] as const) {
      await expect(
        fixture.read({ type, id: id!, ownerId: plan.ownerId }),
        type,
      ).resolves.toMatchObject({ document: { profileId: renamed } });
    }
    await expect(
      fixture.driver.get<object>(
        'SELECT state, descriptor_payload_json, updated_at FROM undo_records WHERE id = ?;',
        [undoId],
      ),
    ).resolves.toEqual({
      state: 'expired',
      descriptor_payload_json:
        '{"commandType":"redacted_for_identity_change","payload":{},"expectedRevisions":{}}',
      updated_at: later,
    });
    // Undo that does not name the Profile stays available.
    await expect(
      fixture.driver.all<object>('SELECT state FROM undo_records WHERE id <> ?;', [undoId]),
    ).resolves.toEqual([{ state: 'available' }]);
    await expect(fixture.driver.all<object>('PRAGMA foreign_key_check;')).resolves.toEqual([]);
    await fixture.driver.close();
  });

  it('refuses a missing, synchronized, or queued Profile, and a rename onto itself', async () => {
    const fixture = await openAccountFixture();
    const owner = await fixture.ownerId();
    const profileId = fixture.initialized.profileId;
    const rename = (from: UUID, to: UUID) =>
      fixture
        .store()
        .runInTransaction((transaction) =>
          transaction.ownership.remapProfile({ ownerId: owner, from, to, at: later }),
        );
    const unchanged = async () => {
      await expect(
        fixture.driver.all<object>('SELECT id, owner_id FROM profiles;'),
      ).resolves.toEqual([{ id: profileId, owner_id: owner }]);
      await expect(columnsNaming(fixture, renamed)).resolves.toEqual([]);
    };

    await expect(rename(profileId, profileId)).rejects.toMatchObject({ code: 'write_conflict' });
    await expect(rename(renamed, profileId)).rejects.toMatchObject({ code: 'write_conflict' });
    // The server knows a synchronized Profile by its id.
    await fixture.driver.run('UPDATE profiles SET server_revision = 1;');
    await expect(rename(profileId, renamed)).rejects.toMatchObject({ code: 'write_conflict' });
    await fixture.driver.run('UPDATE profiles SET server_revision = 0;');
    await unchanged();
    // Queued sync work names the Profile by its id: a link and a cancel clear it first.
    const operationId = fixture.ids.next();
    await fixture.driver.run(
      `INSERT INTO sync_outbox (
         id, owner_id, operation_id, mutation_group_id, command_id, actor, sequence, entity_type,
         entity_id, operation_kind, expected_revision, document_schema_version,
         document_payload_json, base_server_revision, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'user', 0, 'profile', ?, 'update', 1, 1, ?, 0, 'pending', ?, ?);`,
      [
        operationId,
        owner,
        operationId,
        fixture.ids.next(),
        fixture.ids.next(),
        profileId,
        '{"planningTimeZone":"UTC","weekStart":"monday","timeFormat":"24_hour"}',
        fixtureStart,
        fixtureStart,
      ],
    );
    await expect(rename(profileId, renamed)).rejects.toMatchObject({ code: 'write_conflict' });
    await unchanged();
    await fixture.driver.close();
  });
});

describe('canonical snapshot and counts', () => {
  it('reads every record type through the codecs, sorted by type and id', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    const snapshot = await fixture
      .store()
      .runInTransaction((transaction) => transaction.records.snapshot(plan.ownerId));
    const types = new Set(snapshot.records.map(({ type }) => type));
    expect([...types].sort()).toEqual([...everyEntityType].sort());
    const order = snapshot.records.map(({ type, id }) => `${type}/${id}`);
    expect(order).toEqual([...order].sort());
    // The unlinked join row and the archived-state rules come through as documents.
    expect(
      snapshot.records.find(({ id }) => id === plan.ids['milestoneActionId'])?.document,
    ).toMatchObject({ unlinkedAt: fixtureStart });
    // Every document is free of owner and sync metadata.
    for (const record of snapshot.records) {
      expect(JSON.stringify(record.document)).not.toContain(plan.ownerId);
      expect(Object.keys(record.document)).not.toContain('ownerId');
    }

    const counts = await fixture.store().read((reader) => reader.records.counts(plan.ownerId));
    expect(counts.total).toBe(snapshot.records.length);
    const byType: Partial<Record<EntityType, number>> = {};
    for (const { type } of snapshot.records) byType[type] = (byType[type] ?? 0) + 1;
    expect(counts.byType).toEqual(byType);
    // Setup stores its Context entries as sensitive; the extra entry is normal.
    expect(counts.sensitiveContextCount).toBe((byType.context ?? 0) - 1);
    expect(counts.sensitiveContextCount).toBeGreaterThan(0);
    await fixture.driver.close();
  });

  it('defines meaningful data as any live record beyond the identity and its profile', async () => {
    const fixture = await openAccountFixture();
    await expect(fixture.account().hasMeaningfulLocalData()).resolves.toEqual({
      ok: true,
      value: false,
    });
    // Setup progress and the profile's choices are setup defaults, not planning records.
    await fixture.onboarding().execute({
      kind: 'save_handbook',
      status: 'in_progress',
      lesson: 1,
      completedLessons: [0],
    });
    await expect(fixture.account().hasMeaningfulLocalData()).resolves.toEqual({
      ok: true,
      value: false,
    });
    // One archived Axis is a planning record.
    await fixture.driver.run(
      `INSERT INTO axes (id, owner_id, title, state, state_before_archive, sort_key, archived_at,
         created_at, updated_at)
       VALUES (?, ?, 'Old', 'archived', 'active', 'a', ?, ?, ?);`,
      [fixture.ids.next(), await fixture.ownerId(), fixtureStart, fixtureStart, fixtureStart],
    );
    await expect(fixture.account().hasMeaningfulLocalData()).resolves.toEqual({
      ok: true,
      value: true,
    });
    await fixture.driver.close();
  });
});

describe('canonical JSON bundle v1', () => {
  async function exportedPlan() {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    const exported = await fixture.account().exportBundle();
    if (!exported.ok) throw new Error(exported.error.code);
    return { fixture, plan, bundle: exported.value };
  }

  function edit(bundle: EncodedBundle, change: (value: Record<string, unknown>) => void): string {
    const value = JSON.parse(bundle.text) as Record<string, unknown>;
    change(value);
    return JSON.stringify(value);
  }

  it('exports a verified, deterministic bundle with an honest manifest', async () => {
    const { fixture, plan, bundle } = await exportedPlan();
    const parsed = JSON.parse(bundle.text) as {
      format: string;
      formatVersion: number;
      bundleId: string;
      exportedAt: string;
      appVersion: string;
      manifest: EncodedBundle['manifest'];
      data: Record<string, { id: string; revision: number; document: object }[]>;
    };
    expect(parsed).toMatchObject({
      format: 'yelaxis.backup',
      formatVersion: 1,
      bundleId: bundle.bundleId,
      exportedAt: fixtureStart,
      appVersion: 'test',
    });
    expect(parsed.manifest).toEqual(bundle.manifest);
    expect(bundle.manifest).toMatchObject({
      sourceMode: 'local',
      containsSensitiveContext: true,
      syncWasPending: false,
    });
    expect(parsed.manifest.sections).toEqual(Object.keys(parsed.data));
    expect(Object.keys(parsed.data)).toEqual(
      [...Object.values(bundleSections), ...Object.values(bundleSupplementSections)].sort(),
    );
    let total = 0;
    for (const [section, records] of Object.entries(parsed.data)) {
      expect(parsed.manifest.recordCounts[section]).toBe(records.length);
      expect(records.map(({ id }) => id)).toEqual(records.map(({ id }) => id).sort());
      // Planning records are counted; the supplement's sections are counted in the manifest.
      if (Object.values(bundleSections).includes(section)) total += records.length;
    }
    expect(bundle.recordCount).toBe(total);
    // The whole Profile: its planning preferences, and the settings that stay on a device.
    const profile = await fixture.driver.get<{
      preferred_name: string;
      locale_override: string;
      onboarding_artifacts_json: string;
    }>(
      'SELECT preferred_name, locale_override, onboarding_artifacts_json FROM profiles WHERE owner_id = ?;',
      [plan.ownerId],
    );
    expect(profile?.preferred_name).toBe('Sam');
    expect(parsed.data['profile_settings']).toEqual([
      {
        id: plan.profileId,
        revision: parsed.data['profile']?.[0]?.revision,
        document: {
          preferredName: 'Sam',
          localeOverride: profile?.locale_override ?? null,
          onboardingArtifacts: JSON.parse(profile?.onboarding_artifacts_json ?? '{}') as unknown,
          onboardingDraft: null,
          deviceState: {
            defaultsConfirmedAt: fixtureStart,
            onboarding: {
              status: 'completed',
              step: 'handbook',
              completedSteps: ['handbook'],
              skippedSteps: ['handbook'],
              completedAt: fixtureStart,
            },
            handbook: { status: 'skipped', lesson: 0, completedLessons: [] },
          },
        },
      },
    ]);
    expect(parsed.data['conflict_candidates']).toEqual([]);
    expect(bundle.manifest.dataSha256).toBe(await sha256Hex(canonicalJson(parsed.data)));
    await expect(new CanonicalBundleCodec().verify(bundle.text)).resolves.toEqual({
      ok: true,
      bundleId: bundle.bundleId,
      manifest: bundle.manifest,
      recordCount: total,
    });

    // Never owners, replica ids, sync bookkeeping, or credentials.
    expect(bundle.text).not.toContain(plan.ownerId);
    for (const forbidden of [
      'ownerId',
      'owner_id',
      'replica',
      'serverRevision',
      'server_revision',
      'outbox',
      'cursor',
      'token',
      'session',
    ]) {
      expect(bundle.text, forbidden).not.toContain(forbidden);
    }
    // The same plan exports the same data and digest.
    const again = await fixture.account().exportBundle();
    expect(again.ok && again.value.manifest.dataSha256).toBe(bundle.manifest.dataSha256);
    await fixture.driver.close();
  });

  it('refuses a changed, miscounted, unsupported, or unreadable bundle', async () => {
    const { fixture, bundle } = await exportedPlan();
    const codec = new CanonicalBundleCodec();
    const changedTitle = edit(bundle, (value) => {
      const data = value['data'] as Record<string, { document: Record<string, unknown> }[]>;
      const first = data['actions']?.[0];
      if (first) first.document['title'] = 'Changed outside the app';
    });
    await expect(codec.verify(changedTitle)).resolves.toEqual({
      ok: false,
      reason: 'digest_mismatch',
    });
    const miscounted = edit(bundle, (value) => {
      const manifest = value['manifest'] as { recordCounts: Record<string, number> };
      manifest.recordCounts['actions'] = (manifest.recordCounts['actions'] ?? 0) + 1;
    });
    await expect(codec.verify(miscounted)).resolves.toEqual({
      ok: false,
      reason: 'count_mismatch',
    });
    const newer = edit(bundle, (value) => {
      value['formatVersion'] = 2;
    });
    await expect(codec.verify(newer)).resolves.toEqual({
      ok: false,
      reason: 'unsupported_format',
    });
    const invalidRecord = edit(bundle, (value) => {
      const data = value['data'] as Record<string, { document: Record<string, unknown> }[]>;
      const first = data['actions']?.[0];
      if (first) first.document['state'] = 'unknown_state';
    });
    await expect(codec.verify(invalidRecord)).resolves.toEqual({
      ok: false,
      reason: 'invalid_record',
    });
    const missingSection = edit(bundle, (value) => {
      const data = value['data'] as Record<string, unknown>;
      delete data['notes'];
    });
    await expect(codec.verify(missingSection)).resolves.toEqual({
      ok: false,
      reason: 'manifest_mismatch',
    });
    const withOwner = edit(bundle, (value) => {
      value['ownerId'] = accountSubject;
    });
    await expect(codec.verify(withOwner)).resolves.toEqual({
      ok: false,
      reason: 'invalid_structure',
    });
    await expect(codec.verify(bundle.text.slice(0, 200))).resolves.toEqual({
      ok: false,
      reason: 'unreadable',
    });
    // The Profile's settings belong to the bundle's one Profile, and only once.
    const otherSettings = edit(bundle, (value) => {
      const data = value['data'] as Record<string, { id: string }[]>;
      const settings = data['profile_settings']?.[0];
      if (settings) settings.id = 'a3000000-0000-4000-8000-000000000001';
    });
    await expect(codec.verify(otherSettings)).resolves.toEqual({
      ok: false,
      reason: 'invalid_structure',
    });
    const settingsWithExtra = edit(bundle, (value) => {
      const data = value['data'] as Record<string, { document: Record<string, unknown> }[]>;
      const settings = data['profile_settings']?.[0];
      if (settings) settings.document['email'] = 'sam@example.test';
    });
    await expect(codec.verify(settingsWithExtra)).resolves.toEqual({
      ok: false,
      reason: 'invalid_record',
    });
    await fixture.driver.close();
  });

  it('exports open conflict candidates minimized for recovery, and verifies them', async () => {
    const fixture = await openAccountFixture();
    const plan = await seedEveryRecordType(fixture);
    const actionId = plan.ids['actionId']!;
    const conflictId = 'a4000000-0000-4000-8000-000000000001';
    const serverConflictId = 'a4000000-0000-4000-8000-000000000099';
    const blockedGroup = 'a4000000-0000-4000-8000-000000000098';
    const insert = (id: string, state: string, payload: string) =>
      fixture.driver.run(
        `INSERT INTO sync_conflicts (
           id, owner_id, entity_type, entity_id, conflict_kind, state, candidate_schema_version,
           candidate_payload_json, base_server_revision, remote_server_revision, created_at,
           updated_at
         ) VALUES (?, ?, 'action', ?, 'stale_base', ?, 1, ?, 3, 4, ?, ?);`,
        [id, plan.ownerId, actionId, state, payload, fixtureStart, fixtureStart],
      );
    const actionDocument = { captureOrigin: 'global_capture', orderKey: 'a', state: 'inbox' };
    const side = (title: string) => ({ deleted: false, document: { ...actionDocument, title } });
    const payload = {
      v: 1,
      origin: 'other_device',
      base: { ...actionDocument, title: 'Draft outline' },
      local: side('Draft the outline'),
      remote: side('Outline the draft'),
      fields: ['title'],
      blockedGroups: [blockedGroup],
      serverConflictIds: [serverConflictId],
      closure: 'none',
    };
    await insert(conflictId, 'open', JSON.stringify(payload));
    // A resolved conflict is not a recovery candidate; an unreadable one cannot be recovered.
    await insert('a4000000-0000-4000-8000-000000000002', 'resolved', JSON.stringify(payload));
    await insert('a4000000-0000-4000-8000-000000000003', 'open', '{}');

    const exported = await fixture.account().exportBundle();
    if (!exported.ok) throw new Error(exported.error.code);
    const parsed = JSON.parse(exported.value.text) as {
      manifest: { recordCounts: Record<string, number> };
      data: Record<string, unknown[]>;
    };
    expect(parsed.data['conflict_candidates']).toEqual([
      {
        id: conflictId,
        revision: 1,
        document: {
          entityType: 'action',
          entityId: actionId,
          kind: 'stale_base',
          fields: ['title'],
          base: payload.base,
          local: payload.local,
          remote: payload.remote,
          createdAt: fixtureStart,
        },
      },
    ]);
    expect(parsed.manifest.recordCounts['conflict_candidates']).toBe(1);
    // Server and replica authority, outbox groups, and closure bookkeeping stay out.
    for (const forbidden of [
      serverConflictId,
      blockedGroup,
      '"blockedGroups"',
      '"serverConflictIds"',
      '"closure"',
      '"origin"',
      '"v"',
    ]) {
      expect(exported.value.text, forbidden).not.toContain(forbidden);
    }
    const codec = new CanonicalBundleCodec();
    await expect(codec.verify(exported.value.text)).resolves.toMatchObject({ ok: true });
    const withServerIds = JSON.parse(exported.value.text) as {
      data: Record<string, { document: Record<string, unknown> }[]>;
    };
    const candidate = withServerIds.data['conflict_candidates']?.[0];
    if (candidate) candidate.document['serverConflictIds'] = [serverConflictId];
    await expect(codec.verify(JSON.stringify(withServerIds))).resolves.toEqual({
      ok: false,
      reason: 'invalid_record',
    });
    await fixture.driver.close();
  });

  it('says a bundle holds sensitive Context when only a conflict candidate holds it', async () => {
    const codec = new CanonicalBundleCodec();
    const contextConflict = {
      conflictId: 'a5000000-0000-4000-8000-000000000001' as UUID,
      localRevision: 1,
      entityType: 'context' as const,
      entityId: 'a5000000-0000-4000-8000-000000000002' as UUID,
      kind: 'stale_base' as const,
      fields: ['value'],
      base: null,
      local: {
        deleted: false,
        document: {
          category: 'sensitive_notes',
          contextKey: 'private',
          value: 'Synthetic normal',
          source: 'user',
          sensitivity: 'normal',
          strength: 'unknown',
          futureSharing: 'not_shared',
          state: 'active',
        },
      },
      remote: {
        deleted: false,
        document: {
          category: 'sensitive_notes',
          contextKey: 'private',
          value: 'Synthetic private',
          source: 'user',
          sensitivity: 'sensitive',
          strength: 'unknown',
          futureSharing: 'not_shared',
          state: 'active',
        },
      },
      createdAt: fixtureStart,
    };
    const bundle = await codec.encode({
      snapshot: { ownerId: accountSubject as OwnerId, records: [] },
      supplement: { profileSettings: null, openConflicts: [contextConflict] },
      bundleId: 'a5000000-0000-4000-8000-000000000003' as UUID,
      exportedAt: fixtureStart,
      appVersion: 'test',
      sourceMode: 'account',
      syncWasPending: false,
    });
    expect(bundle.manifest.containsSensitiveContext).toBe(true);
    expect(bundle.recordCount).toBe(0);
    await expect(codec.verify(bundle.text)).resolves.toMatchObject({ ok: true, recordCount: 0 });
  });

  it('serializes canonically: sorted keys, no whitespace, no undefined members', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, d: { z: 0, y: -1.5 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"d":{"y":-1.5,"z":0}}',
    );
    expect(() => canonicalJson({ value: Number.NaN })).toThrow();
  });

  it('round-trips Unicode text exactly', async () => {
    const records: CanonicalSnapshotRecord[] = [
      {
        type: 'profile',
        id: 'a2000000-0000-4000-8000-000000000001' as UUID,
        localRevision: 3,
        document: { planningTimeZone: 'Asia/Tashkent', weekStart: 'monday', timeFormat: '24_hour' },
      },
      {
        type: 'note',
        id: 'a2000000-0000-4000-8000-000000000002' as UUID,
        localRevision: 1,
        document: { body: 'שלום — مرحبا — 🌱', orderKey: 'a0', state: 'active' },
      },
    ];
    const codec = new CanonicalBundleCodec();
    const bundle = await codec.encode({
      snapshot: { ownerId: accountSubject as OwnerId, records },
      supplement: {
        profileSettings: {
          profileId: 'a2000000-0000-4000-8000-000000000001' as UUID,
          localRevision: 3,
          preferredName: 'نور — 🌱',
          localeOverride: 'ar',
        },
        openConflicts: [],
      },
      bundleId: 'a2000000-0000-4000-8000-000000000003' as UUID,
      exportedAt: fixtureStart,
      appVersion: 'test',
      sourceMode: 'account',
      syncWasPending: true,
    });
    const verification = await codec.verify(bundle.text);
    expect(verification).toMatchObject({ ok: true, recordCount: 2 });
    expect(bundle.manifest).toMatchObject({
      sourceMode: 'account',
      syncWasPending: true,
      containsSensitiveContext: false,
    });
    const data = (
      JSON.parse(bundle.text) as {
        data: {
          notes: { document: { body: string } }[];
          profile_settings: { document: { preferredName: string } }[];
        };
      }
    ).data;
    expect(data.notes[0]?.document.body).toBe('שלום — مرحبا — 🌱');
    expect(data.profile_settings[0]?.document.preferredName).toBe('نور — 🌱');
  });
});
