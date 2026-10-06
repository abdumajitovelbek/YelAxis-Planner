import type {
  AccountBackupStore,
  AccountDeletionStatus,
  AccountDeletionStore,
  AccountIdentityStore,
  AccountOwnershipStore,
  AccountProfileSeed,
  AccountProfileStore,
  AccountRecordReader,
  AccountStorePort,
  AccountStoreReader,
  AccountSyncFacts,
  AccountSyncStore,
  AccountTransaction,
  BundleConflictCandidate,
  BundleProfileSettings,
  BundleSupplement,
  BundleTombstone,
  BundleHistoryEvent,
  OnboardingArtifacts,
  FirstUploadProgress,
  OutboxMutationGroup,
  OwnershipRemapResult,
  PlanningIdentity,
  StoredAccountBackup,
} from '@yelaxis/application';
import type { EntityType, Instant, OnboardingDraft, OwnerId, UUID } from '@yelaxis/domain';
import { onboardingSteps } from '@yelaxis/domain';
import { z } from 'zod';

import { instant, uuid } from '../application/base-codec';
import {
  type CanonicalCodecRegistry,
  createDefaultCanonicalCodecRegistry,
} from '../application/canonical-codecs';
import { DataAdapterError } from '../application/errors';
import { decodeJson, encodeJson } from '../application/json-codec';
import type { SqliteDriver, SqliteParameter, SqliteQueryConnection } from '../sqlite/driver';
import { bundleSections, CanonicalBundleCodec } from './canonical-bundle';
import { countCanonicalRecords, readCanonicalSnapshot } from './canonical-snapshot';
import {
  canonicalRecordTables,
  ownedTables,
  profileReferenceTables,
  type OwnedTable,
} from './owned-tables';

/*
 * SQLite adapter of the account store port. Every capability is bound to one
 * connection: the driver for reads, or one write transaction with deferred foreign keys, so a remap
 * of composite owner keys is checked when the transaction commits.
 */

class CapabilityGuard {
  #active = true;

  assertActive(): void {
    if (!this.#active) throw new DataAdapterError('capability_expired');
  }

  expire(): void {
    this.#active = false;
  }
}

const identityColumns = `id, identity_kind, account_subject_id, replica_id, link_id,
  link_source_identity_id, link_source_profile_id, link_started_at, linked_at, created_at,
  deleted_at`;

const identityRowSchema = z.strictObject({
  id: uuid,
  identity_kind: z.enum(['local', 'account']),
  account_subject_id: z.string().min(1).nullable(),
  replica_id: uuid.nullable(),
  link_id: uuid.nullable(),
  link_source_identity_id: uuid.nullable(),
  link_source_profile_id: uuid.nullable(),
  link_started_at: instant.nullable(),
  linked_at: instant.nullable(),
  created_at: instant,
  deleted_at: z.string().nullable(),
});

function parseIdentity(candidate: unknown): PlanningIdentity {
  const row = identityRowSchema.safeParse(candidate);
  if (!row.success) throw new DataAdapterError('invalid_identity_record');
  const value = row.data;
  return {
    id: value.id as OwnerId,
    kind: value.identity_kind,
    accountSubjectId: value.account_subject_id,
    replicaId: value.replica_id as UUID | null,
    linkId: value.link_id as UUID | null,
    linkSourceIdentityId: value.link_source_identity_id as OwnerId | null,
    linkSourceProfileId: value.link_source_profile_id as UUID | null,
    linkStartedAt: value.link_started_at as Instant | null,
    linkedAt: value.linked_at as Instant | null,
    createdAt: value.created_at as Instant,
  };
}

function assertOne(changes: number): void {
  if (changes !== 1) throw new DataAdapterError('write_conflict');
}

class SqliteIdentityRows implements AccountIdentityStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly guard: CapabilityGuard,
  ) {}

  async listActive(): Promise<readonly PlanningIdentity[]> {
    this.guard.assertActive();
    const rows = await this.connection.all<object>(
      `SELECT ${identityColumns} FROM planning_identities
       WHERE deleted_at IS NULL ORDER BY created_at, id;`,
    );
    return rows.map(parseIdentity);
  }

  async find(id: OwnerId): Promise<PlanningIdentity | null> {
    this.guard.assertActive();
    const row = await this.connection.get<object>(
      `SELECT ${identityColumns} FROM planning_identities WHERE id = ?;`,
      [id],
    );
    return row === undefined ? null : parseIdentity(row);
  }

  async insertLocal(input: { readonly id: OwnerId; readonly at: Instant }): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
       VALUES (?, 'local', ?, ?);`,
      [input.id, input.at, input.at],
    );
    assertOne(result.changes);
  }

  async insertAccount(input: Parameters<AccountIdentityStore['insertAccount']>[0]): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run(
      `INSERT INTO planning_identities (
         id, identity_kind, account_subject_id, replica_id, link_id, link_source_identity_id,
         link_source_profile_id, link_started_at, linked_at, created_at, updated_at
       ) VALUES (?, 'account', ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        input.id,
        input.accountSubjectId,
        input.replicaId,
        input.link?.linkId ?? null,
        input.link?.sourceIdentityId ?? null,
        input.link?.sourceProfileId ?? null,
        input.link === null ? null : input.at,
        input.link === null ? input.at : null,
        input.at,
        input.at,
      ],
    );
    assertOne(result.changes);
  }

  async retire(id: OwnerId, at: Instant): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run(
      `UPDATE planning_identities
       SET deleted_at = ?, updated_at = ?, local_revision = local_revision + 1
       WHERE id = ? AND deleted_at IS NULL;`,
      [at, at, id],
    );
    assertOne(result.changes);
  }

  async restore(id: OwnerId, at: Instant): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run(
      `UPDATE planning_identities
       SET deleted_at = NULL, updated_at = ?, local_revision = local_revision + 1
       WHERE id = ? AND deleted_at IS NOT NULL;`,
      [at, id],
    );
    assertOne(result.changes);
  }

  async markLinked(id: OwnerId, at: Instant): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run(
      `UPDATE planning_identities
       SET linked_at = ?, updated_at = ?, local_revision = local_revision + 1
       WHERE id = ? AND identity_kind = 'account' AND link_started_at IS NOT NULL
         AND linked_at IS NULL AND deleted_at IS NULL;`,
      [at, at, id],
    );
    assertOne(result.changes);
  }

  async remove(id: OwnerId): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run('DELETE FROM planning_identities WHERE id = ?;', [id]);
    assertOne(result.changes);
  }
}

/** Undo for commands of an earlier identity cannot apply any more; its content is not kept. */
const redactedUndoDescriptor =
  '{"commandType":"redacted_for_identity_change","payload":{},"expectedRevisions":{}}';

/** The statement that moves one owned table's rows, keeping owner-keyed values consistent. */
function remapStatement(
  table: OwnedTable,
  from: OwnerId,
  to: OwnerId,
  at: Instant,
): { readonly sql: string; readonly parameters: readonly SqliteParameter[] } {
  const quotedFrom = JSON.stringify(from);
  const quotedTo = JSON.stringify(to);
  if (table === 'undo_records') {
    return {
      sql: `UPDATE undo_records SET owner_id = ?, state = 'expired', descriptor_payload_json = ?,
              updated_at = ?, local_revision = local_revision + 1
            WHERE owner_id = ?;`,
      parameters: [to, redactedUndoDescriptor, at, from],
    };
  }
  if (table === 'command_receipts') {
    // Receipts hold only ids, times, and flags: every owner id in them is the owner.
    return {
      sql: `UPDATE command_receipts
            SET owner_id = ?, receipt_payload_json = replace(receipt_payload_json, ?, ?)
            WHERE owner_id = ?;`,
      parameters: [to, quotedFrom, quotedTo, from],
    };
  }
  if (table === 'deletion_ledger') {
    // Ledger ids are `ownerId:entityType:entityId`.
    return {
      sql: `UPDATE deletion_ledger
            SET owner_id = ?,
                id = CASE WHEN substr(id, 1, ?) = ? THEN ? || substr(id, ?) ELSE id END
            WHERE owner_id = ?;`,
      parameters: [to, from.length + 1, `${from}:`, to, from.length + 1, from],
    };
  }
  if (table === 'sync_outbox') {
    // A queued delete carries a content-free tombstone naming its owner.
    return {
      sql: `UPDATE sync_outbox
            SET owner_id = ?,
                document_payload_json = CASE WHEN operation_kind = 'delete'
                  THEN replace(document_payload_json, ?, ?) ELSE document_payload_json END
            WHERE owner_id = ?;`,
      parameters: [to, quotedFrom, quotedTo, from],
    };
  }
  return { sql: `UPDATE ${table} SET owner_id = ? WHERE owner_id = ?;`, parameters: [to, from] };
}

/**
 * Where a row of an owner can name a Profile id, each with one `?` for the id: the Profile, the
 * records that refer to it, their history, and the sync bookkeeping that a link and a cancel clear
 * before renaming. A renamed Profile's old id is in none of them. The verified backup kept until
 * linkage is a frozen copy of the plan from before the link and keeps the id it was made with,
 * which is the id a cancel restores.
 */
const profileNamingConditions: readonly (readonly [OwnedTable, string])[] = Object.freeze([
  ['profiles', 'id = ?'],
  ...profileReferenceTables.map((table) => [table, 'profile_id = ?'] as const),
  ['domain_events', 'entity_id = ?'],
  ['domain_events', 'instr(payload_json, ?) > 0'],
  ['command_receipts', 'instr(receipt_payload_json, ?) > 0'],
  ['undo_records', 'instr(descriptor_payload_json, ?) > 0'],
  ['deletion_ledger', 'entity_id = ?'],
  ['base_snapshots', 'entity_id = ?'],
  ['base_snapshots', 'instr(snapshot_payload_json, ?) > 0'],
  ['sync_outbox', 'entity_id = ?'],
  ['sync_outbox', 'instr(document_payload_json, ?) > 0'],
  ['sync_conflicts', 'entity_id = ?'],
  ['sync_conflicts', 'instr(candidate_payload_json, ?) > 0'],
]);

class SqliteOwnershipRemap implements AccountOwnershipStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly guard: CapabilityGuard,
  ) {}

  async remap(input: {
    readonly from: OwnerId;
    readonly to: OwnerId;
    readonly at: Instant;
  }): Promise<OwnershipRemapResult> {
    this.guard.assertActive();
    const { from, to, at } = input;
    if (from === to) throw new DataAdapterError('write_conflict');
    const rowsByTable: Record<string, number> = {};
    for (const table of ownedTables) {
      this.guard.assertActive();
      if (table === 'search_documents' || table === 'search_tokens') continue;
      const statement = remapStatement(table, from, to, at);
      rowsByTable[table] = (await this.connection.run(statement.sql, statement.parameters)).changes;
    }
    // Derived indexes are rebuilt only after every canonical endpoint has its new owner.
    await this.connection.run('DELETE FROM search_documents WHERE owner_id IN (?, ?);', [from, to]);
    rowsByTable['search_documents'] = (
      await this.connection.run(
        'INSERT INTO search_documents SELECT * FROM search_source_documents WHERE owner_id = ?;',
        [to],
      )
    ).changes;
    rowsByTable['search_tokens'] =
      (
        await this.connection.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM search_tokens WHERE owner_id = ?;',
          [to],
        )
      )?.count ?? 0;
    for (const table of ownedTables) {
      const left = await this.connection.get<{ found: number }>(
        `SELECT 1 AS found FROM ${table} WHERE owner_id = ? LIMIT 1;`,
        [from],
      );
      if (left !== undefined) throw new DataAdapterError('write_conflict');
    }
    return { rowsByTable };
  }

  async remapProfile(input: {
    readonly ownerId: OwnerId;
    readonly from: UUID;
    readonly to: UUID;
    readonly at: Instant;
  }): Promise<OwnershipRemapResult> {
    this.guard.assertActive();
    const { ownerId, from, to, at } = input;
    if (from === to) throw new DataAdapterError('write_conflict');
    const quotedFrom = JSON.stringify(from);
    const quotedTo = JSON.stringify(to);
    const rowsByTable: Record<string, number> = {};
    const run = async (table: string, sql: string, parameters: readonly SqliteParameter[]) => {
      this.guard.assertActive();
      rowsByTable[table] = (await this.connection.run(sql, parameters)).changes;
    };
    // The server knows a synchronized Profile by its id: only one that never synchronized moves.
    await run(
      'profiles',
      `UPDATE profiles SET id = ?
       WHERE owner_id = ? AND id = ? AND server_revision = 0 AND base_snapshot_hash IS NULL;`,
      [to, ownerId, from],
    );
    if (rowsByTable['profiles'] !== 1) throw new DataAdapterError('write_conflict');
    for (const table of profileReferenceTables) {
      await run(
        table,
        `UPDATE ${table} SET profile_id = ? WHERE owner_id = ? AND profile_id = ?;`,
        [to, ownerId, from],
      );
    }
    // Events and receipts hold only ids, times, and flags: every quoted Profile id is the Profile.
    await run(
      'domain_events',
      `UPDATE domain_events
       SET entity_id = CASE WHEN entity_type = 'profile' AND entity_id = ? THEN ?
                            ELSE entity_id END,
           payload_json = replace(payload_json, ?, ?)
       WHERE owner_id = ?
         AND ((entity_type = 'profile' AND entity_id = ?) OR instr(payload_json, ?) > 0);`,
      [from, to, quotedFrom, quotedTo, ownerId, from, quotedFrom],
    );
    await run(
      'command_receipts',
      `UPDATE command_receipts SET receipt_payload_json = replace(receipt_payload_json, ?, ?)
       WHERE owner_id = ? AND instr(receipt_payload_json, ?) > 0;`,
      [quotedFrom, quotedTo, ownerId, quotedFrom],
    );
    // Undo that names the Profile (also inside owner-keyed revision keys) cannot apply any more.
    await run(
      'undo_records',
      `UPDATE undo_records SET state = 'expired', descriptor_payload_json = ?, updated_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND instr(descriptor_payload_json, ?) > 0;`,
      [redactedUndoDescriptor, at, ownerId, from],
    );
    for (const [table, names] of profileNamingConditions) {
      this.guard.assertActive();
      const left = await this.connection.get<{ found: number }>(
        `SELECT 1 AS found FROM ${table} WHERE owner_id = ? AND ${names} LIMIT 1;`,
        [ownerId, from],
      );
      if (left !== undefined) throw new DataAdapterError('write_conflict');
    }
    return { rowsByTable };
  }
}

const profileSettingsRowSchema = z.strictObject({
  id: uuid,
  local_revision: z.number().int().positive(),
  preferred_name: z.string().nullable(),
  locale_override: z.string().nullable(),
  onboarding_draft_json: z.string().nullable(),
  onboarding_artifacts_json: z.string(),
});

const conflictRowSchema = z.strictObject({
  id: uuid,
  entity_type: z.string(),
  entity_id: uuid,
  conflict_kind: z.enum([
    'stale_base',
    'edit_versus_delete',
    'delete_versus_edit',
    'create_collision',
    'merge_conflict',
  ]),
  candidate_payload_json: z.string(),
  local_revision: z.number().int().positive(),
  created_at: instant,
});

const candidateDocument = z.record(z.string(), z.unknown());
const candidateSide = z.object({ deleted: z.boolean(), document: candidateDocument.nullable() });
/**
 * The parts of a stored conflict candidate that recovery needs. The sync part owns the full
 * payload; its other members (outbox groups, server ids, closure state) are never exported.
 */
const candidatePayloadSchema = z.object({
  base: candidateDocument.nullable(),
  local: candidateSide,
  remote: candidateSide,
  fields: z.array(z.string()),
});

class SqliteAccountRecords implements AccountRecordReader {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly codecs: CanonicalCodecRegistry,
    private readonly guard: CapabilityGuard,
  ) {}

  counts(ownerId: OwnerId) {
    this.guard.assertActive();
    return countCanonicalRecords(this.connection, ownerId);
  }

  snapshot(ownerId: OwnerId) {
    this.guard.assertActive();
    return readCanonicalSnapshot(this.connection, this.codecs, ownerId);
  }

  async supplement(ownerId: OwnerId): Promise<BundleSupplement> {
    this.guard.assertActive();
    const profile = await this.connection.get<object>(
      `SELECT id, local_revision, preferred_name, locale_override, onboarding_draft_json, onboarding_artifacts_json
       FROM profiles WHERE owner_id = ? AND deleted_at IS NULL;`,
      [ownerId],
    );
    let profileSettings: BundleProfileSettings | null = null;
    if (profile !== undefined) {
      const row = profileSettingsRowSchema.safeParse(profile);
      if (!row.success) throw new DataAdapterError('invalid_persisted_record');
      profileSettings = {
        profileId: row.data.id as UUID,
        localRevision: row.data.local_revision,
        preferredName: row.data.preferred_name,
        localeOverride: row.data.locale_override,
        onboardingDraft:
          row.data.onboarding_draft_json === null
            ? null
            : (decodeJson(row.data.onboarding_draft_json) as OnboardingDraft),
        onboardingArtifacts: decodeJson(row.data.onboarding_artifacts_json) as OnboardingArtifacts,
      };
      const seed = await new SqliteProfileSeeds(this.connection, this.guard).readSeed(ownerId);
      if (seed !== null)
        profileSettings = {
          ...profileSettings,
          deviceState: {
            defaultsConfirmedAt: seed.defaultsConfirmedAt,
            onboarding: seed.onboarding,
            handbook: seed.handbook,
          },
        };
    }
    this.guard.assertActive();
    const rows = await this.connection.all<object>(
      `SELECT id, entity_type, entity_id, conflict_kind, candidate_payload_json, local_revision,
              created_at
       FROM sync_conflicts WHERE owner_id = ? AND state = 'open' AND deleted_at IS NULL
       ORDER BY id;`,
      [ownerId],
    );
    const openConflicts: BundleConflictCandidate[] = [];
    for (const candidate of rows) {
      const row = conflictRowSchema.safeParse(candidate);
      if (!row.success || !(row.data.entity_type in bundleSections)) continue;
      const payload = candidatePayloadSchema.safeParse(
        decodeOptionalJson(row.data.candidate_payload_json),
      );
      // A candidate that cannot be read cannot be recovered either; the rest still export.
      if (!payload.success) continue;
      openConflicts.push({
        conflictId: row.data.id as UUID,
        localRevision: row.data.local_revision,
        entityType: row.data.entity_type as EntityType,
        entityId: row.data.entity_id as UUID,
        kind: row.data.conflict_kind,
        fields: payload.data.fields,
        base: payload.data.base,
        local: payload.data.local,
        remote: payload.data.remote,
        createdAt: row.data.created_at as Instant,
      });
    }
    const deleted = await this.connection.all<{
      entity_type: EntityType;
      entity_id: UUID;
      local_revision: number;
      deleted_at: Instant;
    }>(
      'SELECT entity_type, entity_id, local_revision, deleted_at FROM deletion_ledger WHERE owner_id = ? ORDER BY entity_id, entity_type;',
      [ownerId],
    );
    const tombstones: BundleTombstone[] = deleted.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      localRevision: row.local_revision,
      deletedAt: row.deleted_at,
    }));
    const eventRows = await this.connection.all<{
      id: UUID;
      entity_type: EntityType;
      entity_id: UUID;
      event_type: string;
      actor: BundleHistoryEvent['actor'];
      occurred_at: Instant;
      local_revision: number;
    }>(
      'SELECT id, entity_type, entity_id, event_type, actor, occurred_at, local_revision FROM domain_events WHERE owner_id = ? AND deleted_at IS NULL ORDER BY id;',
      [ownerId],
    );
    const history: BundleHistoryEvent[] = eventRows.map((row) => ({
      eventId: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      eventType: row.event_type,
      actor: row.actor,
      occurredAt: row.occurred_at,
      localRevision: row.local_revision,
    }));
    return { profileSettings, openConflicts, tombstones, history };
  }
}

function decodeOptionalJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Waiting, sending, retrying, blocked, or rejected: anything not yet acknowledged. */
const pendingOutboxState = `state <> 'acknowledged' AND deleted_at IS NULL`;

class SqliteSyncBookkeeping implements AccountSyncStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly guard: CapabilityGuard,
  ) {}

  async facts(ownerId: OwnerId): Promise<AccountSyncFacts> {
    this.guard.assertActive();
    const pending = await this.connection.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sync_outbox WHERE owner_id = ? AND ${pendingOutboxState};`,
      [ownerId],
    );
    const conflicts = await this.connection.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sync_conflicts
       WHERE owner_id = ? AND state = 'open' AND deleted_at IS NULL;`,
      [ownerId],
    );
    const synced = await this.connection.get<{ last: string | null }>(
      `SELECT MAX(last_success_at) AS last FROM sync_checkpoints
       WHERE owner_id = ? AND deleted_at IS NULL;`,
      [ownerId],
    );
    const lastSyncedAt = synced?.last ?? null;
    return {
      pendingOperations: pending?.count ?? 0,
      openConflicts: conflicts?.count ?? 0,
      lastSyncedAt:
        lastSyncedAt !== null && instant.safeParse(lastSyncedAt).success
          ? (lastSyncedAt as Instant)
          : null,
    };
  }

  async firstUpload(input: {
    readonly ownerId: OwnerId;
    readonly linkId: UUID;
    readonly replicaId: UUID;
  }): Promise<FirstUploadProgress> {
    this.guard.assertActive();
    const totals = await this.connection.get<{
      operations: number;
      settled: number | null;
      groups: number;
      open: number;
    }>(
      `SELECT COUNT(*) AS operations,
              SUM(CASE WHEN state = 'acknowledged' OR deleted_at IS NOT NULL THEN 1 ELSE 0 END)
                AS settled,
              COUNT(DISTINCT mutation_group_id) AS groups,
              COUNT(DISTINCT CASE WHEN ${pendingOutboxState} THEN mutation_group_id END) AS open
       FROM sync_outbox WHERE owner_id = ? AND command_id = ?;`,
      [input.ownerId, input.linkId],
    );
    const checkpoint = await this.connection.get<{ found: number }>(
      `SELECT 1 AS found FROM sync_checkpoints
       WHERE owner_id = ? AND replica_id = ? AND server_cursor IS NOT NULL
         AND deleted_at IS NULL
       LIMIT 1;`,
      [input.ownerId, input.replicaId],
    );
    return {
      totalOperations: totals?.operations ?? 0,
      acknowledgedOperations: totals?.settled ?? 0,
      totalGroups: totals?.groups ?? 0,
      openGroups: totals?.open ?? 0,
      pullCheckpoint: checkpoint !== undefined,
    };
  }

  async appendGroup(group: OutboxMutationGroup): Promise<void> {
    this.guard.assertActive();
    if (group.operations.length === 0 || group.operations.length > 500) {
      throw new DataAdapterError('write_conflict');
    }
    const operationIds = new Set<string>();
    const rows = group.operations.map((operation, index) => {
      const mutation = operation.mutation;
      if (
        operation.mutationGroupId !== group.mutationGroupId ||
        operation.sequence !== index ||
        operation.state !== 'pending' ||
        operation.attemptCount !== 0 ||
        mutation.operation !== 'create' ||
        mutation.ref.ownerId !== group.ownerId ||
        mutation.baseServerRevision !== 0 ||
        mutation.baseSnapshotHash !== null ||
        operationIds.has(operation.operationId)
      ) {
        throw new DataAdapterError('write_conflict');
      }
      operationIds.add(operation.operationId);
      return { operation, ref: mutation.ref, payload: encodeJson(mutation.document) };
    });
    for (const { operation, ref, payload } of rows) {
      this.guard.assertActive();
      const result = await this.connection.run(
        `INSERT INTO sync_outbox (
           id, owner_id, operation_id, mutation_group_id, command_id, actor, sequence,
           entity_type, entity_id, operation_kind, expected_revision, document_schema_version,
           document_payload_json, base_server_revision, base_snapshot_hash, state, attempt_count,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'create', NULL, 1, ?, 0, NULL, 'pending', 0, ?, ?, ?);`,
        [
          operation.operationId,
          group.ownerId,
          operation.operationId,
          group.mutationGroupId,
          group.commandId,
          group.actor,
          operation.sequence,
          ref.type,
          ref.id,
          payload,
          operation.nextAttemptAt,
          group.createdAt,
          group.createdAt,
        ],
      );
      assertOne(result.changes);
    }
  }

  async clear(ownerId: OwnerId): Promise<void> {
    this.guard.assertActive();
    for (const table of ['sync_outbox', 'sync_conflicts', 'sync_checkpoints', 'base_snapshots']) {
      await this.connection.run(`DELETE FROM ${table} WHERE owner_id = ?;`, [ownerId]);
    }
    for (const table of canonicalRecordTables) {
      this.guard.assertActive();
      await this.connection.run(
        `UPDATE ${table} SET server_revision = 0, base_snapshot_hash = NULL
         WHERE owner_id = ? AND (server_revision <> 0 OR base_snapshot_hash IS NOT NULL);`,
        [ownerId],
      );
    }
    await this.connection.run(
      `UPDATE deletion_ledger SET server_revision = 0
       WHERE owner_id = ? AND server_revision <> 0;`,
      [ownerId],
    );
  }
}

const deletionRowSchema = z.strictObject({
  request_id: uuid.nullable(),
  state: z.enum(['none', 'requested', 'pending', 'confirmed', 'failed_recoverable']),
  requested_at: instant.nullable(),
  confirmed_at: instant.nullable(),
  local_copy_choice: z.enum(['keep', 'delete']).nullable(),
  recoverable_error_code: z.string().nullable(),
});

class SqliteDeletionState implements AccountDeletionStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly guard: CapabilityGuard,
  ) {}

  async read(ownerId: OwnerId): Promise<AccountDeletionStatus> {
    this.guard.assertActive();
    const candidate = await this.connection.get<object>(
      `SELECT request_id, state, requested_at, confirmed_at, local_copy_choice,
              recoverable_error_code
       FROM account_deletion_state WHERE owner_id = ? AND deleted_at IS NULL;`,
      [ownerId],
    );
    if (candidate === undefined) {
      return {
        phase: 'none',
        requestId: null,
        requestedAt: null,
        confirmedAt: null,
        localCopy: null,
        errorCode: null,
      };
    }
    const row = deletionRowSchema.safeParse(candidate);
    if (!row.success) throw new DataAdapterError('invalid_persisted_record');
    return {
      phase: row.data.state,
      requestId: row.data.request_id as UUID | null,
      requestedAt: row.data.requested_at as Instant | null,
      confirmedAt: row.data.confirmed_at as Instant | null,
      localCopy: row.data.local_copy_choice,
      errorCode: row.data.recoverable_error_code,
    };
  }

  async write(input: {
    readonly ownerId: OwnerId;
    readonly rowId: UUID;
    readonly status: AccountDeletionStatus;
    readonly at: Instant;
  }): Promise<void> {
    this.guard.assertActive();
    const { status } = input;
    const values = [
      status.requestId,
      status.phase,
      status.requestedAt,
      status.confirmedAt,
      status.localCopy,
      status.errorCode,
    ];
    const updated = await this.connection.run(
      `UPDATE account_deletion_state
       SET request_id = ?, state = ?, requested_at = ?, confirmed_at = ?, local_copy_choice = ?,
           recoverable_error_code = ?, updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND deleted_at IS NULL;`,
      [...values, input.at, input.ownerId],
    );
    if (updated.changes === 1) return;
    const inserted = await this.connection.run(
      `INSERT INTO account_deletion_state (
         id, owner_id, request_id, state, requested_at, confirmed_at, local_copy_choice,
         recoverable_error_code, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [input.rowId, input.ownerId, ...values, input.at, input.at],
    );
    assertOne(inserted.changes);
  }

  async clear(ownerId: OwnerId): Promise<void> {
    this.guard.assertActive();
    await this.connection.run('DELETE FROM account_deletion_state WHERE owner_id = ?;', [ownerId]);
  }
}

const backupRowSchema = z.strictObject({
  id: uuid,
  data_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  record_count: z.number().int().nonnegative(),
  sync_was_pending: z.union([z.literal(0), z.literal(1)]),
  bundle_json: z.string(),
  created_at: instant,
});

class SqliteBackups implements AccountBackupStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly guard: CapabilityGuard,
  ) {}

  async latest(ownerId: OwnerId): Promise<StoredAccountBackup | null> {
    this.guard.assertActive();
    const candidate = await this.connection.get<object>(
      `SELECT id, data_sha256, record_count, sync_was_pending, bundle_json, created_at
       FROM account_link_backups WHERE owner_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1;`,
      [ownerId],
    );
    if (candidate === undefined) return null;
    const row = backupRowSchema.safeParse(candidate);
    if (!row.success) throw new DataAdapterError('invalid_persisted_record');
    return {
      bundleId: row.data.id as UUID,
      createdAt: row.data.created_at as Instant,
      recordCount: row.data.record_count,
      syncWasPending: row.data.sync_was_pending === 1,
      dataSha256: row.data.data_sha256,
      text: row.data.bundle_json,
    };
  }

  async save(input: Parameters<AccountBackupStore['save']>[0]): Promise<void> {
    this.guard.assertActive();
    const { bundle } = input;
    await this.connection.run('DELETE FROM account_link_backups WHERE owner_id = ?;', [
      input.ownerId,
    ]);
    const result = await this.connection.run(
      `INSERT INTO account_link_backups (
         id, owner_id, data_sha256, record_count, sync_was_pending, bundle_json, verified_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        bundle.bundleId,
        input.ownerId,
        bundle.manifest.dataSha256,
        bundle.recordCount,
        bundle.manifest.syncWasPending ? 1 : 0,
        bundle.text,
        input.at,
        input.at,
        input.at,
      ],
    );
    assertOne(result.changes);
  }

  async clear(ownerId: OwnerId): Promise<void> {
    this.guard.assertActive();
    await this.connection.run('DELETE FROM account_link_backups WHERE owner_id = ?;', [ownerId]);
  }
}

const onboardingStep = z.enum(onboardingSteps);
const stepList = z.array(onboardingStep).refine((steps) => new Set(steps).size === steps.length);
const seedRowSchema = z.strictObject({
  preferred_name: z.string().nullable(),
  planning_time_zone: z.string().min(1),
  week_start: z.string().min(1),
  time_format: z.enum(['12_hour', '24_hour']),
  locale_override: z.string().nullable(),
  defaults_confirmed_at: instant.nullable(),
  onboarding_status: z.enum(['not_started', 'in_progress', 'completed']),
  onboarding_step: onboardingStep,
  onboarding_completed_steps_json: z.string(),
  onboarding_skipped_steps_json: z.string(),
  onboarding_completed_at: instant.nullable(),
  handbook_status: z.enum(['not_started', 'in_progress', 'skipped', 'completed']),
  handbook_lesson: z.number().int().min(0).max(4),
  handbook_completed_lessons_json: z.string(),
});

function parseJsonColumn<Value>(schema: z.ZodType<Value>, text: string): Value {
  const parsed = schema.safeParse(decodeJson(text));
  if (!parsed.success) throw new DataAdapterError('invalid_persisted_record');
  return parsed.data;
}

class SqliteProfileSeeds implements AccountProfileStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly guard: CapabilityGuard,
  ) {}

  async readId(ownerId: OwnerId): Promise<UUID | null> {
    this.guard.assertActive();
    // An owner has at most one Profile row (`UNIQUE (owner_id)`).
    const row = await this.connection.get<{ id: unknown }>(
      'SELECT id FROM profiles WHERE owner_id = ?;',
      [ownerId],
    );
    if (row === undefined) return null;
    const id = uuid.safeParse(row.id);
    if (!id.success) throw new DataAdapterError('invalid_persisted_record');
    return id.data as UUID;
  }

  async readSeed(ownerId: OwnerId): Promise<AccountProfileSeed | null> {
    this.guard.assertActive();
    const candidate = await this.connection.get<object>(
      `SELECT preferred_name, planning_time_zone, week_start, time_format, locale_override,
              defaults_confirmed_at, onboarding_status, onboarding_step,
              onboarding_completed_steps_json, onboarding_skipped_steps_json,
              onboarding_completed_at, handbook_status, handbook_lesson,
              handbook_completed_lessons_json
       FROM profiles WHERE owner_id = ? AND deleted_at IS NULL;`,
      [ownerId],
    );
    if (candidate === undefined) return null;
    const row = seedRowSchema.safeParse(candidate);
    if (!row.success) throw new DataAdapterError('invalid_persisted_record');
    const value = row.data;
    return {
      preferredName: value.preferred_name,
      planningTimeZone: value.planning_time_zone,
      weekStart: value.week_start,
      timeFormat: value.time_format,
      localeOverride: value.locale_override,
      defaultsConfirmedAt: value.defaults_confirmed_at as Instant | null,
      onboarding: {
        status: value.onboarding_status,
        step: value.onboarding_step,
        completedSteps: parseJsonColumn(stepList, value.onboarding_completed_steps_json),
        skippedSteps: parseJsonColumn(stepList, value.onboarding_skipped_steps_json),
        completedAt: value.onboarding_completed_at as Instant | null,
      },
      handbook: {
        status: value.handbook_status,
        lesson: value.handbook_lesson,
        completedLessons: parseJsonColumn(
          z.array(z.number().int().min(0).max(3)),
          value.handbook_completed_lessons_json,
        ),
      },
    };
  }

  async seed(input: {
    readonly ownerId: OwnerId;
    readonly profileId: UUID;
    readonly seed: AccountProfileSeed;
    readonly at: Instant;
  }): Promise<void> {
    this.guard.assertActive();
    const { seed, at } = input;
    const result = await this.connection.run(
      `INSERT INTO profiles (
         id, owner_id, preferred_name, planning_time_zone, week_start, time_format,
         locale_override, defaults_confirmed_at, onboarding_status, onboarding_step,
         onboarding_completed_steps_json, onboarding_skipped_steps_json, onboarding_draft_json,
         onboarding_artifacts_json, onboarding_completed_at, handbook_status, handbook_lesson,
         handbook_completed_lessons_json, created_at, updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        input.profileId,
        input.ownerId,
        seed.preferredName,
        seed.planningTimeZone,
        seed.weekStart,
        seed.timeFormat,
        seed.localeOverride,
        seed.defaultsConfirmedAt,
        seed.onboarding.status,
        seed.onboarding.step,
        encodeJson(seed.onboarding.completedSteps),
        encodeJson(seed.onboarding.skippedSteps),
        '{"axisIds":[],"commitments":[]}',
        seed.onboarding.completedAt,
        seed.handbook.status,
        seed.handbook.lesson,
        encodeJson(seed.handbook.completedLessons),
        at,
        at,
        at,
      ],
    );
    assertOne(result.changes);
  }
}

function capabilities(
  connection: SqliteQueryConnection,
  codecs: CanonicalCodecRegistry,
  guard: CapabilityGuard,
): AccountTransaction {
  return {
    identities: new SqliteIdentityRows(connection, guard),
    ownership: new SqliteOwnershipRemap(connection, guard),
    records: new SqliteAccountRecords(connection, codecs, guard),
    sync: new SqliteSyncBookkeeping(connection, guard),
    deletion: new SqliteDeletionState(connection, guard),
    backups: new SqliteBackups(connection, guard),
    profiles: new SqliteProfileSeeds(connection, guard),
  };
}

/** Reuses the canonical account reader and Profile seed path inside an import transaction. */
export function bindAccountTransaction(
  connection: SqliteQueryConnection,
  codecs: CanonicalCodecRegistry,
): { readonly transaction: AccountTransaction; readonly expire: () => void } {
  const guard = new CapabilityGuard();
  return { transaction: capabilities(connection, codecs, guard), expire: () => guard.expire() };
}

export interface SqliteAccountStoreOptions {
  readonly codecs?: CanonicalCodecRegistry;
}

export class SqliteAccountStore implements AccountStorePort {
  readonly #driver: SqliteDriver;
  readonly #codecs: CanonicalCodecRegistry;
  #transactionActive = false;

  constructor(driver: SqliteDriver, options: SqliteAccountStoreOptions = {}) {
    this.#driver = driver;
    this.#codecs = options.codecs ?? createDefaultCanonicalCodecRegistry();
  }

  async read<Result>(work: (reader: AccountStoreReader) => Promise<Result>): Promise<Result> {
    const guard = new CapabilityGuard();
    try {
      return await work(capabilities(this.#driver, this.#codecs, guard));
    } finally {
      guard.expire();
    }
  }

  async runInTransaction<Result>(
    work: (transaction: AccountTransaction) => Promise<Result>,
  ): Promise<Result> {
    if (this.#transactionActive) throw new DataAdapterError('concurrent_transaction');
    this.#transactionActive = true;
    try {
      return await this.#driver.transaction(async (connection) => {
        // Remapping composite owner keys moves parents and children in turn; foreign keys stay
        // enforced, but only when the transaction commits. SQLite resets this after it ends.
        await connection.run('PRAGMA defer_foreign_keys = ON;');
        const guard = new CapabilityGuard();
        try {
          return await work(capabilities(connection, this.#codecs, guard));
        } finally {
          guard.expire();
        }
      });
    } finally {
      this.#transactionActive = false;
    }
  }
}

export interface SqliteAccountAdapters {
  readonly store: SqliteAccountStore;
  readonly bundles: CanonicalBundleCodec;
}

/** The account store and bundle codec over one database, for the composition root. */
export function createSqliteAccountAdapters(
  driver: SqliteDriver,
  options: SqliteAccountStoreOptions = {},
): SqliteAccountAdapters {
  return { store: new SqliteAccountStore(driver, options), bundles: new CanonicalBundleCodec() };
}
