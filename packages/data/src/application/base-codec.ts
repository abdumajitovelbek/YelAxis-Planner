import type {
  AppliedCanonicalChange,
  CanonicalMutation,
  CanonicalRecordState,
} from '@yelaxis/application';
import {
  parseCalendarDate,
  parseIanaTimeZone,
  parseWallTime,
  type CommandContext,
  type EntityRef,
  type EntityType,
} from '@yelaxis/domain';
import { z } from 'zod';

import type { SqliteQueryConnection } from '../sqlite/driver';
import type { CanonicalRecordCodec } from './canonical-codecs';
import { parseMinimalDeletionTombstone } from './deletion-tombstone';
import { DataAdapterError } from './errors';

/* ───────────────────────── Shared document primitives ───────────────────────── */

export const uuid = z.uuid();
export const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u);
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => parseCalendarDate(value).ok);
export const monthKey = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
export const yearKey = z.string().regex(/^\d{4}$/u);
export const wallTime = z.string().refine((value) => parseWallTime(value).ok);
export const ianaTimeZone = z.string().refine((value) => parseIanaTimeZone(value).ok);
export const weekday = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);
export const nonBlank = z.string().refine((value) => value.trim().length > 0);
export const boundedText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0);

/** `state`, `stateBeforeArchive`, and `archivedAt` must agree for archivable records. */
export function archiveMetadataConsistent(value: {
  readonly state: string;
  readonly stateBeforeArchive?: string | undefined;
  readonly archivedAt?: string | undefined;
}): boolean {
  const archived = value.state === 'archived';
  return (
    archived === (value.archivedAt !== undefined) &&
    archived === (value.stateBeforeArchive !== undefined)
  );
}

export function targetWindowOrdered(value: {
  readonly targetStart?: string | undefined;
  readonly targetEnd?: string | undefined;
}): boolean {
  return (
    value.targetStart === undefined ||
    value.targetEnd === undefined ||
    value.targetStart <= value.targetEnd
  );
}

/** Compile-time guard: a codec schema must expose exactly the contract document keys. */
export type SameKeys<Left, Right> = [keyof Left] extends [keyof Right]
  ? [keyof Right] extends [keyof Left]
    ? true
    : never
  : never;

/* ───────────────────────── Row helpers ───────────────────────── */

const syncRow = z.looseObject({
  id: z.string(),
  owner_id: z.string(),
  local_revision: z.number().int().positive(),
  server_revision: z.number().int().nonnegative(),
  base_snapshot_hash: z.string().nullable(),
});

export type Row = z.infer<typeof syncRow> & Record<string, unknown>;

/** Spread helper: include `{ [key]: value }` only when the column is not NULL. */
export function optional<Key extends string>(
  key: Key,
  value: unknown,
): Partial<Record<Key, unknown>> {
  return value === null || value === undefined
    ? {}
    : ({ [key]: value } as Partial<Record<Key, unknown>>);
}

export type CreateMutation = Extract<CanonicalMutation, { operation: 'create' }>;
export type UpdateMutation = Extract<CanonicalMutation, { operation: 'update' }>;
export type DeleteMutation = Extract<CanonicalMutation, { operation: 'delete' }>;

/* ───────────────────────── Base codec ───────────────────────── */

/**
 * One canonical entity persisted in one table. Documents are validated by a strict schema before
 * every write (`invalid_canonical_document`) and after every read (`invalid_persisted_record`).
 * Updates are optimistic: owner, id, local revision, server revision, and base snapshot must match.
 */
export abstract class BaseCodec<Document> implements CanonicalRecordCodec {
  abstract readonly entityType: EntityType;
  abstract readonly table: string;
  protected abstract readonly schema: z.ZodType<Document>;
  abstract readDocument(
    connection: SqliteQueryConnection,
    ref: EntityRef,
  ): Promise<Row | undefined>;
  /** Build the candidate document from a row; validated by `decode`. */
  protected abstract decodeRow(row: Row): unknown;
  abstract create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: Document,
  ): Promise<number>;
  abstract update(
    connection: SqliteQueryConnection,
    mutation: UpdateMutation,
    context: CommandContext,
    document: Document,
  ): Promise<number>;

  parse(value: unknown): Document {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new DataAdapterError('invalid_canonical_document');
    return parsed.data;
  }

  decode(row: Row): Document {
    const parsed = this.schema.safeParse(this.decodeRow(row));
    if (!parsed.success) throw new DataAdapterError('invalid_persisted_record');
    return parsed.data;
  }

  async read(
    connection: SqliteQueryConnection,
    ref: EntityRef,
  ): Promise<CanonicalRecordState | null> {
    const candidate = await this.readDocument(connection, ref);
    return candidate === undefined ? null : this.recordFromRow(ref, candidate);
  }

  /**
   * The record state of one full row of this codec's table that a query already read for `ref`,
   * validated exactly like `read` (so a bounded list never re-reads each row by id).
   */
  recordFromRow(
    ref: EntityRef,
    candidate: Readonly<Record<string, unknown>>,
  ): CanonicalRecordState {
    const row = syncRow.safeParse(candidate);
    if (!row.success || row.data.id !== ref.id || row.data.owner_id !== ref.ownerId) {
      throw new DataAdapterError('invalid_persisted_record');
    }
    return {
      ref,
      localRevision: row.data.local_revision,
      serverRevision: row.data.server_revision,
      baseSnapshotHash: row.data.base_snapshot_hash,
      document: this.decode(candidate as Row) as Readonly<Record<string, unknown>>,
    };
  }

  async apply(
    connection: SqliteQueryConnection,
    mutation: CanonicalMutation,
    context: CommandContext,
  ): Promise<AppliedCanonicalChange> {
    if (mutation.ref.type !== this.entityType || mutation.ref.ownerId !== context.ownerId) {
      throw new DataAdapterError('write_conflict');
    }
    if (mutation.operation === 'delete') {
      const changes = await this.delete(connection, mutation, context);
      if (changes !== 1) throw new DataAdapterError('write_conflict');
      return { ref: mutation.ref, operation: 'delete', localRevision: mutation.tombstone.revision };
    }
    const document = this.parse(mutation.document);
    const changes =
      mutation.operation === 'create'
        ? await this.create(connection, mutation, context, document)
        : await this.update(connection, mutation, context, document);
    if (changes !== 1) throw new DataAdapterError('write_conflict');
    return {
      ref: mutation.ref,
      operation: mutation.operation,
      localRevision: mutation.operation === 'create' ? 1 : mutation.expectedRevision + 1,
    };
  }

  protected delete(
    connection: SqliteQueryConnection,
    mutation: DeleteMutation,
    context: CommandContext,
  ): Promise<number> {
    return permanentlyDelete(connection, this.table, mutation, context);
  }
}

export function syncWhere(mutation: UpdateMutation | DeleteMutation) {
  return [
    mutation.ref.ownerId,
    mutation.ref.id,
    mutation.expectedRevision,
    mutation.baseServerRevision,
    mutation.baseSnapshotHash,
  ] as const;
}

/** Resurrection guard: a permanently deleted identity can never be created again. */
export async function assertCreatable(
  connection: SqliteQueryConnection,
  mutation: CreateMutation,
): Promise<void> {
  const deleted = await connection.get<{ deleted: number }>(
    `SELECT 1 AS deleted FROM deletion_ledger
     WHERE owner_id = ? AND entity_type = ? AND entity_id = ? LIMIT 1;`,
    [mutation.ref.ownerId, mutation.ref.type, mutation.ref.id],
  );
  if (deleted !== undefined) throw new DataAdapterError('write_conflict');
}

export async function permanentlyDelete(
  connection: SqliteQueryConnection,
  table: string,
  mutation: DeleteMutation,
  context: CommandContext,
): Promise<number> {
  const tombstone = parseMinimalDeletionTombstone(mutation.tombstone);
  if (tombstone.deletedAt !== context.now || tombstone.revision !== mutation.expectedRevision + 1) {
    throw new DataAdapterError('write_conflict');
  }
  const blocked = await connection.get<{ blocked: number }>(
    `SELECT 1 AS blocked FROM (
       SELECT 1 FROM sync_outbox
       WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
         AND state IN ('pending', 'sending', 'retry_wait', 'blocked_conflict', 'dead_letter')
       UNION ALL
       SELECT 1 FROM sync_conflicts
       WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
         AND state = 'open'
     ) LIMIT 1;`,
    [
      mutation.ref.ownerId,
      mutation.ref.type,
      mutation.ref.id,
      mutation.ref.ownerId,
      mutation.ref.type,
      mutation.ref.id,
    ],
  );
  if (blocked !== undefined) throw new DataAdapterError('write_conflict');
  await connection.run(
    `DELETE FROM base_snapshots WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;`,
    [mutation.ref.ownerId, mutation.ref.type, mutation.ref.id],
  );
  await connection.run(
    `DELETE FROM sync_outbox WHERE owner_id = ? AND entity_type = ? AND entity_id = ?
       AND (state = 'acknowledged' OR deleted_at IS NOT NULL);`,
    [mutation.ref.ownerId, mutation.ref.type, mutation.ref.id],
  );
  await connection.run(
    `DELETE FROM sync_conflicts WHERE owner_id = ? AND entity_type = ? AND entity_id = ?
       AND (state IN ('resolved', 'superseded') OR deleted_at IS NOT NULL);`,
    [mutation.ref.ownerId, mutation.ref.type, mutation.ref.id],
  );
  // Every state, like ActionCodec: applied or expired descriptors can still hold prior documents.
  await connection.run(
    `UPDATE undo_records SET state = 'expired', descriptor_payload_json = ?, updated_at = ?,
       local_revision = local_revision + 1
     WHERE owner_id = ? AND EXISTS (
       SELECT 1 FROM json_each(json_extract(undo_records.descriptor_payload_json, '$.expectedRevisions'))
       WHERE key = ?
     );`,
    [
      '{"commandType":"redacted_for_permanent_delete","payload":{},"expectedRevisions":{}}',
      context.now,
      mutation.ref.ownerId,
      `${mutation.ref.ownerId}:${mutation.ref.type}:${mutation.ref.id}`,
    ],
  );
  await connection.run(
    `UPDATE domain_events SET payload_json = '{}', updated_at = ?, local_revision = local_revision + 1
     WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;`,
    [context.now, mutation.ref.ownerId, mutation.ref.type, mutation.ref.id],
  );
  const result = await connection.run(
    `DELETE FROM ${table} WHERE owner_id = ? AND id = ? AND deleted_at IS NULL
       AND local_revision = ? AND server_revision = ? AND base_snapshot_hash IS ?;`,
    syncWhere(mutation),
  );
  if (result.changes === 1) {
    const ledger = await connection.run(
      `INSERT INTO deletion_ledger (
         id, owner_id, entity_type, entity_id, local_revision, server_revision,
         deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        `${mutation.ref.ownerId}:${mutation.ref.type}:${mutation.ref.id}`,
        mutation.ref.ownerId,
        mutation.ref.type,
        mutation.ref.id,
        mutation.tombstone.revision,
        mutation.baseServerRevision,
        context.now,
        context.now,
        context.now,
      ],
    );
    if (ledger.changes !== 1) throw new DataAdapterError('write_conflict');
  }
  return result.changes;
}

/** Owner-scoped single-row lookup of a non-deleted record. */
export function selectById(
  connection: SqliteQueryConnection,
  table: string,
  ref: EntityRef,
): Promise<Row | undefined> {
  return connection.get<Row>(
    `SELECT * FROM ${table} WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
    [ref.ownerId, ref.id],
  );
}
