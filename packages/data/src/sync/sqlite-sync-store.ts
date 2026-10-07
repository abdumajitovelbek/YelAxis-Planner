/**
 * SQLite adapter of the sync ports. One sync transaction is one SQLite transaction
 * that exposes the ordinary planning capabilities plus the sync tables (`sync_outbox`,
 * `base_snapshots`, `deletion_ledger`, `sync_conflicts`, `sync_checkpoints`). Every statement is
 * owner-scoped and prepared; nothing here decides what to sync, it only stores what the
 * application decided. Foreign keys stay deferred until commit, and `danglingReferences` lets the
 * application see unsatisfied ones before that.
 */
import type {
  SyncBaseSnapshot,
  SyncCheckpoint,
  SyncConflictPayload,
  SyncDanglingReference,
  SyncDeletionRecord,
  SyncDocument,
  SyncIdentity,
  SyncOutboxCounts,
  SyncOutboxState,
  SyncStoredConflict,
  SyncStoredOperation,
  SyncStorePort,
  SyncTransactionStore,
  SyncUnitOfWork,
} from '@yelaxis/application';
import type {
  CommandActor,
  CommandId,
  EntityRef,
  EntityType,
  Instant,
  OwnerId,
  UUID,
} from '@yelaxis/domain';
import { z } from 'zod';

import { actionCanonicalDocumentSchema } from '../application/action-codec';
import { BaseCodec } from '../application/base-codec';
import {
  type CanonicalCodecRegistry,
  createDefaultCanonicalCodecRegistry,
} from '../application/canonical-codecs';
import { DataAdapterError } from '../application/errors';
import { decodeJson, encodeJson } from '../application/json-codec';
import { bindPlanningUnitOfWork } from '../application/sqlite-adapters';
import type { SqliteDriver, SqliteQueryConnection } from '../sqlite/driver';
import { setGroupStateSql, setRecordSyncBaseSql, syncSql, uploadProgressSql } from './sync-sql';
import {
  entityOfTable,
  referenceTablesOf,
  syncEntityTables,
  syncRecordTables,
} from './sync-tables';

const entityTypes = Object.keys(syncEntityTables) as EntityType[];
const entityTypeSet = new Set<string>(entityTypes);
const outboxStates = new Set<string>([
  'pending',
  'sending',
  'retry_wait',
  'blocked_conflict',
  'acknowledged',
  'dead_letter',
]);
const conflictKinds = new Set<string>([
  'stale_base',
  'edit_versus_delete',
  'delete_versus_edit',
  'create_collision',
  'merge_conflict',
]);

const documentSchema = z.record(z.string(), z.unknown());
const sideSchema = z.strictObject({ deleted: z.boolean(), document: documentSchema.nullable() });
const conflictPayloadSchema = z.strictObject({
  v: z.literal(1),
  origin: z.enum(['this_device', 'other_device']),
  base: documentSchema.nullable(),
  local: sideSchema,
  remote: sideSchema,
  fields: z.array(z.string()),
  blockedGroups: z.array(z.string()),
  serverConflictIds: z.array(z.string()),
  closedServerIds: z.array(z.string()).optional(),
  closure: z.enum(['none', 'pending', 'done']),
  resolution: z
    .enum(['keep_local', 'keep_remote', 'merge', 'keep_deleted', 'restore_edited'])
    .optional(),
});

/** Adapter failures that mean "this record cannot be held here", not "the store failed". */
const refusalCodes = new Set<string>([
  'invalid_canonical_document',
  'invalid_json_payload',
  'invalid_persisted_record',
  'unsupported_entity_type',
  'write_conflict',
]);

/** SQLite constraint messages and the RAISE messages of this schema's triggers. */
const refusalMessage =
  /constraint failed|already has a planned block|limited to three|^invalid (?:action energy|reminder offset)|too long|cannot (?:also be|equal)|do not match/iu;

/** Deletion states that freeze pushes. */
const deletionFreezes = new Set(['requested', 'pending', 'failed_recoverable', 'confirmed']);

class Guard {
  #active = true;

  assertActive(): void {
    if (!this.#active) throw new DataAdapterError('capability_expired');
  }

  expire(): void {
    this.#active = false;
  }
}

interface OutboxRow {
  readonly position: number;
  readonly operation_id: string;
  readonly mutation_group_id: string;
  readonly command_id: string;
  readonly actor: string;
  readonly sequence: number;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly operation_kind: string;
  readonly expected_revision: number | null;
  readonly state: string;
  readonly attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly base_server_revision: number;
  readonly base_snapshot_hash: string | null;
  readonly document_payload_json: string;
}

interface ConflictRow {
  readonly id: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly conflict_kind: string;
  readonly state: string;
  readonly candidate_payload_json: string;
  readonly base_server_revision: number;
  readonly remote_server_revision: number;
  readonly resolution_strategy: string | null;
  readonly resolved_at: string | null;
  readonly created_at: string;
}

interface ForeignKey {
  readonly id: number;
  readonly parent: string;
  readonly columns: readonly { readonly from: string; readonly to: string }[];
}

/** Foreign keys of every table, read once per store (the schema never changes while open). */
interface ReferenceMap {
  readonly keys: ReadonlyMap<string, readonly ForeignKey[]>;
  readonly referrers: ReadonlyMap<string, readonly string[]>;
}

function invalid(): never {
  throw new DataAdapterError('invalid_persisted_record');
}

function decodeOperation(row: OutboxRow): SyncStoredOperation {
  if (
    !entityTypeSet.has(row.entity_type) ||
    !outboxStates.has(row.state) ||
    (row.operation_kind !== 'create' &&
      row.operation_kind !== 'update' &&
      row.operation_kind !== 'delete')
  ) {
    invalid();
  }
  const payload = decodeJson(row.document_payload_json);
  const document =
    row.operation_kind === 'delete'
      ? null
      : payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as SyncDocument)
        : invalid();
  return {
    position: row.position,
    operationId: row.operation_id as UUID,
    mutationGroupId: row.mutation_group_id as UUID,
    commandId: row.command_id as CommandId,
    actor: row.actor as CommandActor,
    sequence: row.sequence,
    entityType: row.entity_type as EntityType,
    entityId: row.entity_id as UUID,
    kind: row.operation_kind,
    expectedRevision: row.expected_revision,
    state: row.state as SyncOutboxState,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at as Instant | null,
    baseServerRevision: row.base_server_revision,
    baseSnapshotHash: row.base_snapshot_hash,
    document,
  };
}

function decodeConflict(row: ConflictRow): SyncStoredConflict {
  if (
    !entityTypeSet.has(row.entity_type) ||
    !conflictKinds.has(row.conflict_kind) ||
    (row.state !== 'open' && row.state !== 'resolved' && row.state !== 'superseded')
  ) {
    invalid();
  }
  const parsed = conflictPayloadSchema.safeParse(decodeJson(row.candidate_payload_json));
  if (!parsed.success) invalid();
  return {
    conflictId: row.id as UUID,
    entityType: row.entity_type as EntityType,
    entityId: row.entity_id as UUID,
    kind: row.conflict_kind as SyncStoredConflict['kind'],
    state: row.state,
    baseServerRevision: row.base_server_revision,
    remoteServerRevision: row.remote_server_revision,
    createdAt: row.created_at as Instant,
    payload: parsed.data as unknown as SyncConflictPayload,
    ...(row.resolution_strategy === null ? {} : { resolutionStrategy: row.resolution_strategy }),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at as Instant }),
  };
}

const ledgerId = (ref: EntityRef): string => `${ref.ownerId}:${ref.type}:${ref.id}`;

class SqliteSyncTransactionStore implements SyncTransactionStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly codecs: CanonicalCodecRegistry,
    private readonly guard: Guard,
    private readonly ownerFilter: OwnerId | undefined,
    private readonly references: () => Promise<ReferenceMap>,
  ) {}

  async identity(): Promise<SyncIdentity | null> {
    this.guard.assertActive();
    const rows =
      this.ownerFilter === undefined
        ? await this.connection.all<Record<string, unknown>>(syncSql.identities)
        : await this.connection.all<Record<string, unknown>>(syncSql.identity, [this.ownerFilter]);
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new DataAdapterError('identity_ambiguous');
    const row = rows[0];
    if (row === undefined || typeof row['id'] !== 'string') {
      throw new DataAdapterError('invalid_identity_record');
    }
    const kind = row['identity_kind'];
    if (kind !== 'local' && kind !== 'account')
      throw new DataAdapterError('invalid_identity_record');
    const replica = row['replica_id'];
    const deletion = await this.connection.get<{ readonly state: string }>(syncSql.deletionState, [
      row['id'],
    ]);
    return {
      ownerId: row['id'] as OwnerId,
      kind,
      replicaId: typeof replica === 'string' ? (replica as UUID) : null,
      // Migration 14: an identity is linking while `link_started_at` is set and `linked_at` is not;
      // a replica opened for an account without a local plan is linked from its creation.
      linked: row['link_started_at'] === null || row['linked_at'] !== null,
      deletion: deletion !== undefined && deletionFreezes.has(deletion.state) ? 'pending' : 'none',
    };
  }

  /* ───────────────────────── Outbox ───────────────────────── */

  async outboxCounts(ownerId: OwnerId): Promise<SyncOutboxCounts> {
    this.guard.assertActive();
    const rows = await this.connection.all<{
      readonly state: string;
      readonly count: number;
      readonly unconfirmed: number | null;
      readonly next_attempt_at: string | null;
    }>(syncSql.outboxCounts, [ownerId]);
    const byState: Partial<Record<SyncOutboxState, number>> = {};
    let unconfirmed = 0;
    let nextAttemptAt: string | null = null;
    for (const row of rows) {
      if (!outboxStates.has(row.state)) invalid();
      byState[row.state as SyncOutboxState] = row.count;
      unconfirmed += row.unconfirmed ?? 0;
      if (
        row.next_attempt_at !== null &&
        (nextAttemptAt === null || row.next_attempt_at < nextAttemptAt)
      ) {
        nextAttemptAt = row.next_attempt_at;
      }
    }
    return { byState, unconfirmed, nextAttemptAt: nextAttemptAt as Instant | null };
  }

  async uploadProgress(ownerId: OwnerId): Promise<{ uploaded: number; total: number }> {
    this.guard.assertActive();
    let uploaded = 0;
    let total = 0;
    for (const item of syncRecordTables) {
      const row = await this.connection.get<{ readonly total: number; readonly uploaded: number }>(
        uploadProgressSql(item.table, item.anyState === true),
        [ownerId],
      );
      total += row?.total ?? 0;
      uploaded += row?.uploaded ?? 0;
    }
    return { uploaded, total };
  }

  async scanOutbox(
    ownerId: OwnerId,
    fromPosition: number,
    limit: number,
  ): Promise<readonly SyncStoredOperation[]> {
    this.guard.assertActive();
    const rows = await this.connection.all<OutboxRow>(syncSql.scanOutbox, [
      fromPosition,
      ownerId,
      Math.max(1, Math.min(limit, 1000)),
    ]);
    return rows.map(decodeOperation);
  }

  async operationsForEntity(
    ownerId: OwnerId,
    ref: Pick<EntityRef, 'type' | 'id'>,
  ): Promise<readonly SyncStoredOperation[]> {
    this.guard.assertActive();
    const rows = await this.connection.all<OutboxRow>(syncSql.operationsForEntity, [
      ownerId,
      ref.type,
      ref.id,
    ]);
    return rows.map(decodeOperation);
  }

  async readGroup(
    ownerId: OwnerId,
    mutationGroupId: UUID,
  ): Promise<readonly SyncStoredOperation[]> {
    this.guard.assertActive();
    const rows = await this.connection.all<OutboxRow>(syncSql.readGroup, [
      ownerId,
      mutationGroupId,
    ]);
    return rows.map(decodeOperation);
  }

  async setGroupState(
    ownerId: OwnerId,
    mutationGroupId: UUID,
    update: {
      readonly from: readonly SyncOutboxState[];
      readonly state: SyncOutboxState;
      readonly attemptCount?: number;
      readonly nextAttemptAt?: Instant | null;
    },
    now: Instant,
  ): Promise<number> {
    this.guard.assertActive();
    if (update.from.length === 0) return 0;
    const result = await this.connection.run(setGroupStateSql(update.from.length), [
      update.state,
      update.attemptCount ?? null,
      update.nextAttemptAt === undefined ? 0 : 1,
      update.nextAttemptAt ?? null,
      now,
      ownerId,
      mutationGroupId,
      ...update.from,
    ]);
    return result.changes;
  }

  async setStateWhere(
    ownerId: OwnerId,
    update: {
      readonly from: SyncOutboxState;
      readonly state: SyncOutboxState;
      readonly nextAttemptAt: Instant | null;
      readonly resetAttempts?: boolean;
    },
    now: Instant,
  ): Promise<number> {
    this.guard.assertActive();
    const result = await this.connection.run(syncSql.setStateWhere, [
      update.state,
      update.nextAttemptAt,
      update.resetAttempts === true ? 1 : 0,
      now,
      ownerId,
      update.from,
    ]);
    return result.changes;
  }

  async rewriteOperation(
    ownerId: OwnerId,
    operationId: UUID,
    update: {
      readonly document?: SyncDocument;
      readonly baseServerRevision?: number;
      readonly baseSnapshotHash?: string | null;
    },
    now: Instant,
  ): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run(syncSql.rewriteOperation, [
      update.document === undefined ? null : encodeJson(update.document),
      update.baseServerRevision ?? null,
      update.baseSnapshotHash === undefined ? 0 : 1,
      update.baseSnapshotHash ?? null,
      now,
      ownerId,
      operationId,
    ]);
    if (result.changes !== 1) throw new DataAdapterError('write_conflict');
  }

  async rebaseQueuedOperations(
    ownerId: OwnerId,
    bases: readonly {
      readonly entityType: EntityType;
      readonly entityId: UUID;
      readonly serverRevision: number;
      readonly hash: string | null;
    }[],
    now: Instant,
  ): Promise<number> {
    this.guard.assertActive();
    if (bases.length === 0) return 0;
    const payload = encodeJson(
      bases.map((base) => ({
        type: base.entityType,
        id: base.entityId,
        revision: base.serverRevision,
        hash: base.hash,
      })),
    );
    const result = await this.connection.run(syncSql.rebaseQueuedOperations, [
      now,
      payload,
      ownerId,
    ]);
    return result.changes;
  }

  async dropOperations(ownerId: OwnerId, operationIds: readonly UUID[]): Promise<void> {
    this.guard.assertActive();
    if (operationIds.length === 0) return;
    // One prepared, owner-scoped statement instead of a worker round trip per accepted operation.
    await this.connection.run(syncSql.removeOperations, [ownerId, encodeJson(operationIds)]);
  }

  async acknowledgeOperations(ownerId: OwnerId, operationIds: readonly UUID[]): Promise<void> {
    // Accepted operations are compacted at once: the server's receipts keep retries idempotent.
    await this.dropOperations(ownerId, operationIds);
  }

  /* ───────────────────────── Record sync metadata ───────────────────────── */

  async setRecordSyncBase(
    ref: EntityRef,
    serverRevision: number,
    hash: string | null,
  ): Promise<void> {
    this.guard.assertActive();
    let changed = 0;
    for (const item of syncEntityTables[ref.type]) {
      const result = await this.connection.run(
        setRecordSyncBaseSql(item.table, item.anyState === true),
        [serverRevision, hash, ref.ownerId, ref.id],
      );
      changed += result.changes;
      if (changed > 0) break;
    }
    if (changed !== 1) throw new DataAdapterError('write_conflict');
  }

  async readBaseSnapshot(ref: EntityRef): Promise<SyncBaseSnapshot | null> {
    this.guard.assertActive();
    const row = await this.connection.get<{
      readonly snapshot_hash: string;
      readonly snapshot_payload_json: string;
      readonly snapshot_server_revision: number;
    }>(syncSql.readBaseSnapshot, [ref.ownerId, ref.type, ref.id]);
    if (row === undefined) return null;
    const document = decodeJson(row.snapshot_payload_json);
    if (document === null || typeof document !== 'object' || Array.isArray(document)) invalid();
    return {
      serverRevision: row.snapshot_server_revision,
      hash: row.snapshot_hash,
      document: document as SyncDocument,
    };
  }

  async writeBaseSnapshot(ref: EntityRef, snapshot: SyncBaseSnapshot, now: Instant): Promise<void> {
    this.guard.assertActive();
    await this.connection.run(syncSql.writeBaseSnapshot, [
      ledgerId(ref),
      ref.ownerId,
      ref.type,
      ref.id,
      snapshot.hash,
      encodeJson(snapshot.document),
      snapshot.serverRevision,
      now,
      now,
    ]);
  }

  async deleteBaseSnapshot(ref: EntityRef): Promise<void> {
    this.guard.assertActive();
    await this.connection.run(syncSql.deleteBaseSnapshot, [ref.ownerId, ref.type, ref.id]);
  }

  async readDeletion(ref: EntityRef): Promise<SyncDeletionRecord | null> {
    this.guard.assertActive();
    const row = await this.connection.get<{
      readonly server_revision: number;
      readonly local_revision: number;
    }>(syncSql.readDeletion, [ref.ownerId, ref.type, ref.id]);
    return row === undefined
      ? null
      : { serverRevision: row.server_revision, localRevision: row.local_revision };
  }

  async setDeletionServerRevision(
    ref: EntityRef,
    serverRevision: number,
    now: Instant,
  ): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run(syncSql.setDeletionServerRevision, [
      serverRevision,
      now,
      ref.ownerId,
      ref.type,
      ref.id,
    ]);
    if (result.changes !== 1) throw new DataAdapterError('write_conflict');
  }

  async recordRemoteDeletion(ref: EntityRef, serverRevision: number, now: Instant): Promise<void> {
    this.guard.assertActive();
    await this.connection.run(syncSql.recordRemoteDeletion, [
      ledgerId(ref),
      ref.ownerId,
      ref.type,
      ref.id,
      serverRevision,
      now,
      now,
      now,
    ]);
  }

  async clearDeletion(ref: EntityRef): Promise<void> {
    this.guard.assertActive();
    await this.connection.run(syncSql.clearDeletion, [ref.ownerId, ref.type, ref.id]);
  }

  async createProfileFromRemote(
    ref: EntityRef,
    document: SyncDocument,
    now: Instant,
  ): Promise<void> {
    this.guard.assertActive();
    const codec = this.codecs.resolve('profile');
    if (!(codec instanceof BaseCodec)) throw new DataAdapterError('unsupported_entity_type');
    const parsed = codec.parse(document) as {
      readonly planningTimeZone: string;
      readonly weekStart: string;
      readonly timeFormat: string;
    };
    // The account completed setup on the device that created it; this replica only receives it.
    const result = await this.connection.run(syncSql.createProfile, [
      ref.id,
      ref.ownerId,
      parsed.planningTimeZone,
      parsed.weekStart,
      parsed.timeFormat,
      now,
      now,
      now,
      now,
      now,
    ]);
    if (result.changes !== 1) throw new DataAdapterError('write_conflict');
  }

  validateDocument(entityType: EntityType, document: SyncDocument): boolean {
    this.guard.assertActive();
    if (entityType === 'action') return actionCanonicalDocumentSchema.safeParse(document).success;
    let codec;
    try {
      codec = this.codecs.resolve(entityType);
    } catch {
      return false;
    }
    if (!(codec instanceof BaseCodec)) return false;
    try {
      codec.parse(document);
      return true;
    } catch {
      return false;
    }
  }

  isRecordRefusal(error: unknown): boolean {
    if (error instanceof DataAdapterError) return refusalCodes.has(error.code);
    // node:sqlite reports the result code; SQLITE_CONSTRAINT (19) covers every extended code.
    const code = (error as { readonly errcode?: unknown } | null)?.errcode;
    if (typeof code === 'number') return (code & 0xff) === 19;
    // The browser worker reports SQLite's message: constraint failures and this schema's rules.
    return error instanceof Error && refusalMessage.test(error.message);
  }

  async danglingReferences(scope: {
    readonly written: readonly EntityType[];
    readonly deleted: readonly EntityType[];
  }): Promise<readonly SyncDanglingReference[]> {
    this.guard.assertActive();
    if (scope.written.length === 0 && scope.deleted.length === 0) return [];
    const map = await this.references();
    const tables = new Set<string>();
    for (const entityType of scope.written) {
      for (const table of referenceTablesOf(entityType)) tables.add(table);
    }
    for (const entityType of scope.deleted) {
      for (const table of referenceTablesOf(entityType)) {
        for (const referrer of map.referrers.get(table) ?? []) tables.add(referrer);
      }
    }
    const dangling: SyncDanglingReference[] = [];
    for (const table of [...tables].sort()) {
      // A PRAGMA argument cannot be bound; `table` comes from the schema, never from input.
      const violations = await this.connection.all<{
        readonly table: string;
        readonly rowid: number | null;
        readonly parent: string;
        readonly fkid: number;
      }>(`PRAGMA foreign_key_check(${quoteIdentifier(table)});`);
      for (const violation of violations) {
        dangling.push(await this.#describe(map, violation));
        if (dangling.length >= 200) return dangling;
      }
    }
    return dangling;
  }

  async #describe(
    map: ReferenceMap,
    violation: {
      readonly table: string;
      readonly rowid: number | null;
      readonly parent: string;
      readonly fkid: number;
    },
  ): Promise<SyncDanglingReference> {
    const key = map.keys.get(violation.table)?.find((item) => item.id === violation.fkid);
    if (violation.rowid === null || key === undefined) return { child: null, parent: null };
    const row = await this.connection.get<Record<string, unknown>>(
      `SELECT * FROM ${quoteIdentifier(violation.table)} WHERE rowid = ?;`,
      [violation.rowid],
    );
    // A Routine's generation rows are part of the Routine document.
    const generation = violation.table === 'routine_generations';
    const childType = generation ? 'routine' : entityOfTable(violation.table);
    const childId = generation ? row?.['routine_id'] : row?.['id'];
    const parentType = entityOfTable(key.parent);
    const parentColumn = key.columns.find((column) => column.to === 'id')?.from;
    const parentId = parentColumn === undefined ? undefined : row?.[parentColumn];
    return {
      child:
        childType !== undefined && typeof childId === 'string'
          ? { entityType: childType, entityId: childId as UUID }
          : null,
      parent:
        parentType !== undefined && typeof parentId === 'string'
          ? { entityType: parentType, entityId: parentId as UUID }
          : null,
    };
  }

  /* ───────────────────────── Conflicts ───────────────────────── */

  async openConflicts(ownerId: OwnerId): Promise<readonly SyncStoredConflict[]> {
    this.guard.assertActive();
    const rows = await this.connection.all<ConflictRow>(syncSql.openConflicts, [ownerId]);
    return rows.map(decodeConflict);
  }

  async readConflict(ownerId: OwnerId, conflictId: UUID): Promise<SyncStoredConflict | null> {
    this.guard.assertActive();
    const row = await this.connection.get<ConflictRow>(syncSql.readConflict, [ownerId, conflictId]);
    return row === undefined ? null : decodeConflict(row);
  }

  async conflictsAwaitingClosure(ownerId: OwnerId): Promise<readonly SyncStoredConflict[]> {
    this.guard.assertActive();
    const rows = await this.connection.all<ConflictRow>(syncSql.conflictsAwaitingClosure, [
      ownerId,
    ]);
    return rows.map(decodeConflict);
  }

  async conflictsForServerId(
    ownerId: OwnerId,
    serverConflictId: UUID,
  ): Promise<readonly SyncStoredConflict[]> {
    this.guard.assertActive();
    const rows = await this.connection.all<ConflictRow>(syncSql.conflictsForServerId, [
      ownerId,
      serverConflictId,
    ]);
    return rows.map(decodeConflict);
  }

  async insertConflict(
    ownerId: OwnerId,
    conflict: SyncStoredConflict,
    now: Instant,
  ): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run(syncSql.insertConflict, [
      conflict.conflictId,
      ownerId,
      conflict.entityType,
      conflict.entityId,
      conflict.kind,
      conflict.state,
      encodeJson(conflict.payload),
      conflict.baseServerRevision,
      conflict.remoteServerRevision,
      conflict.resolutionStrategy ?? null,
      conflict.resolvedAt ?? null,
      conflict.createdAt,
      now,
    ]);
    if (result.changes !== 1) throw new DataAdapterError('write_conflict');
  }

  async updateConflict(
    ownerId: OwnerId,
    conflictId: UUID,
    update: {
      readonly state?: 'open' | 'resolved' | 'superseded';
      readonly payload?: SyncConflictPayload;
      readonly resolutionStrategy?: string;
      readonly resolvedAt?: Instant;
    },
    now: Instant,
  ): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run(syncSql.updateConflict, [
      update.state ?? null,
      update.payload === undefined ? null : encodeJson(update.payload),
      update.resolutionStrategy ?? null,
      update.resolvedAt ?? null,
      now,
      ownerId,
      conflictId,
    ]);
    if (result.changes !== 1) throw new DataAdapterError('write_conflict');
  }

  /* ───────────────────────── Cursor ───────────────────────── */

  async readCheckpoint(ownerId: OwnerId, replicaId: UUID): Promise<SyncCheckpoint> {
    this.guard.assertActive();
    const row = await this.connection.get<{
      readonly server_cursor: string | null;
      readonly last_success_at: string | null;
    }>(syncSql.readCheckpoint, [ownerId, replicaId]);
    return {
      cursor: row?.server_cursor ?? null,
      lastSuccessAt: (row?.last_success_at ?? null) as Instant | null,
    };
  }

  async writeCheckpoint(
    ownerId: OwnerId,
    replicaId: UUID,
    update: { readonly cursor: string | null; readonly lastSuccessAt?: Instant },
    now: Instant,
  ): Promise<void> {
    this.guard.assertActive();
    await this.connection.run(syncSql.writeCheckpoint, [
      `${ownerId}:${replicaId}`,
      ownerId,
      replicaId,
      update.cursor,
      update.lastSuccessAt ?? null,
      now,
      now,
    ]);
  }
}

function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new DataAdapterError('write_conflict');
  return `"${name}"`;
}

async function readReferenceMap(connection: SqliteQueryConnection): Promise<ReferenceMap> {
  const keys = new Map<string, ForeignKey[]>();
  const referrers = new Map<string, string[]>();
  const tables = await connection.all<{ readonly name: string }>(syncSql.tables);
  for (const { name } of tables) {
    const rows = await connection.all<{
      readonly id: number;
      readonly seq: number;
      readonly table: string;
      readonly from: string;
      readonly to: string;
    }>(`PRAGMA foreign_key_list(${quoteIdentifier(name)});`);
    const byId = new Map<number, ForeignKey>();
    for (const row of rows) {
      const existing = byId.get(row.id);
      const column = { from: row.from, to: row.to };
      byId.set(row.id, {
        id: row.id,
        parent: row.table,
        columns: existing === undefined ? [column] : [...existing.columns, column],
      });
    }
    keys.set(name, [...byId.values()]);
    for (const key of byId.values()) {
      const list = referrers.get(key.parent) ?? [];
      if (!list.includes(name)) list.push(name);
      referrers.set(key.parent, list);
    }
  }
  return { keys, referrers };
}

export interface SqliteSyncStoreOptions {
  readonly codecs?: CanonicalCodecRegistry;
  /** Required when a database can hold more than one live identity. */
  readonly ownerId?: OwnerId;
}

/** The sync store over one SQLite database (queue it with the other facades). */
export class SqliteSyncStore implements SyncStorePort {
  readonly #driver: SqliteDriver;
  readonly #codecs: CanonicalCodecRegistry;
  readonly #ownerId: OwnerId | undefined;
  #references: Promise<ReferenceMap> | null = null;
  #transactionActive = false;

  constructor(driver: SqliteDriver, options: SqliteSyncStoreOptions = {}) {
    this.#driver = driver;
    this.#codecs = options.codecs ?? createDefaultCanonicalCodecRegistry();
    this.#ownerId = options.ownerId;
  }

  async runInTransaction<Result>(
    work: (unitOfWork: SyncUnitOfWork) => Promise<Result>,
  ): Promise<Result> {
    if (this.#transactionActive) throw new DataAdapterError('concurrent_transaction');
    this.#transactionActive = true;
    try {
      return await this.#driver.transaction(async (connection) => {
        await connection.run('PRAGMA defer_foreign_keys = ON;');
        const { capabilities, expire } = bindPlanningUnitOfWork(connection, this.#codecs);
        const guard = new Guard();
        const sync = new SqliteSyncTransactionStore(
          connection,
          this.#codecs,
          guard,
          this.#ownerId,
          () => {
            this.#references ??= readReferenceMap(connection).catch((error: unknown) => {
              this.#references = null;
              throw error;
            });
            return this.#references;
          },
        );
        try {
          return await work({ ...capabilities, sync });
        } finally {
          expire();
          guard.expire();
        }
      });
    } finally {
      this.#transactionActive = false;
    }
  }
}
