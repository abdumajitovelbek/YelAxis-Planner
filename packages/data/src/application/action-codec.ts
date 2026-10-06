import type {
  AppliedCanonicalChange,
  CanonicalMutation,
  CanonicalRecordState,
} from '@yelaxis/application';
import {
  parseCalendarDate,
  parseIanaTimeZone,
  parseInstant,
  type CommandContext,
  type EntityRef,
} from '@yelaxis/domain';
import { z } from 'zod';

import type { SqliteParameter, SqliteQueryConnection } from '../sqlite/driver';
import { energyLabels } from '@yelaxis/domain';
import { actionCaptureOrigins } from '../sqlite/schema/vocabulary';
import type { CanonicalRecordCodec } from './canonical-codecs';
import { parseMinimalDeletionTombstone } from './deletion-tombstone';
import { DataAdapterError } from './errors';

const uuidSchema = z.uuid();
const nonBlankSchema = z
  .string()
  .max(200)
  .refine((value) => value.trim().length > 0);
const calendarDateSchema = z.string().refine((value) => {
  const parsed = parseCalendarDate(value);
  return parsed.ok && parsed.value === value;
});
const instantSchema = z.string().refine((value) => {
  const parsed = parseInstant(value);
  return parsed.ok && parsed.value === value;
});
const timeZoneSchema = z.string().refine((value) => {
  const parsed = parseIanaTimeZone(value);
  return parsed.ok && parsed.value === value;
});
const actionStateSchema = z.enum([
  'inbox',
  'planned',
  'scheduled',
  'in_progress',
  'completed',
  'canceled',
  'archived',
]);
const actionStateBeforeArchiveSchema = z.enum([
  'inbox',
  'planned',
  'scheduled',
  'in_progress',
  'completed',
  'canceled',
]);

export const actionCanonicalDocumentSchema = z
  .strictObject({
    title: nonBlankSchema,
    captureOrigin: z.enum(actionCaptureOrigins),
    note: z.string().max(10_000).optional(),
    axisId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    due: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('date'), date: calendarDateSchema }),
        z.strictObject({
          kind: z.literal('instant'),
          instant: instantSchema,
          authoredTimeZone: timeZoneSchema,
        }),
      ])
      .optional(),
    estimateMinutes: z.number().int().positive().max(10_080).optional(),
    energy: z.enum(energyLabels).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    orderKey: nonBlankSchema,
    state: actionStateSchema,
    stateBeforeArchive: actionStateBeforeArchiveSchema.optional(),
    completedAt: instantSchema.optional(),
    archivedAt: instantSchema.optional(),
    convertedTo: z.strictObject({ type: z.enum(['note', 'project']), id: uuidSchema }).optional(),
  })
  .superRefine((document, context) => {
    const archived = document.state === 'archived';
    if (
      archived !== (document.archivedAt !== undefined) ||
      archived !== (document.stateBeforeArchive !== undefined)
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid archive metadata.' });
    }
    const completed =
      document.state === 'completed' ||
      (document.state === 'archived' && document.stateBeforeArchive === 'completed');
    if (completed !== (document.completedAt !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Invalid completion metadata.' });
    }
    if (document.convertedTo !== undefined && !archived) {
      context.addIssue({ code: 'custom', message: 'Invalid conversion metadata.' });
    }
  });

export type ActionCanonicalDocument = z.infer<typeof actionCanonicalDocumentSchema>;

interface ActionRow {
  readonly id: string;
  readonly owner_id: string;
  readonly axis_id: string | null;
  readonly project_id: string | null;
  readonly title: string;
  readonly note_text: string | null;
  readonly state: ActionCanonicalDocument['state'];
  readonly state_before_archive: ActionCanonicalDocument['stateBeforeArchive'] | null;
  readonly estimate_minutes: number | null;
  readonly energy: string | null;
  readonly priority: ActionCanonicalDocument['priority'] | null;
  readonly due_date: string | null;
  readonly due_at_utc: string | null;
  readonly due_time_zone: string | null;
  readonly converted_to_type: 'note' | 'project' | null;
  readonly converted_to_id: string | null;
  readonly capture_origin: ActionCanonicalDocument['captureOrigin'];
  readonly sort_key: string;
  readonly completed_at: string | null;
  readonly archived_at: string | null;
  readonly local_revision: number;
  readonly server_revision: number;
  readonly base_snapshot_hash: string | null;
}

interface EncodedActionDocument {
  readonly parameters: readonly SqliteParameter[];
}

class ActionCanonicalCodec implements CanonicalRecordCodec {
  readonly entityType = 'action' as const;

  async read(
    connection: SqliteQueryConnection,
    ref: EntityRef,
  ): Promise<CanonicalRecordState | null> {
    const row = await connection.get<ActionRow>(
      `SELECT id, owner_id, axis_id, project_id, title, note_text, state,
              state_before_archive, estimate_minutes, energy, priority, due_date, due_at_utc,
              due_time_zone, converted_to_type, converted_to_id, capture_origin, sort_key,
              completed_at, archived_at, local_revision, server_revision, base_snapshot_hash
       FROM actions
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
      [ref.ownerId, ref.id],
    );
    if (row === undefined) return null;
    if (
      row.owner_id !== ref.ownerId ||
      row.id !== ref.id ||
      !Number.isSafeInteger(row.local_revision) ||
      row.local_revision < 1 ||
      !Number.isSafeInteger(row.server_revision) ||
      row.server_revision < 0
    ) {
      throw new DataAdapterError('invalid_persisted_record');
    }

    return {
      ref,
      localRevision: row.local_revision,
      serverRevision: row.server_revision,
      baseSnapshotHash: row.base_snapshot_hash,
      document: decodeActionDocument(row),
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
      const result = await this.#delete(connection, mutation, context);
      if (result !== 1) throw new DataAdapterError('write_conflict');
      return {
        ref: mutation.ref,
        operation: mutation.operation,
        localRevision: mutation.tombstone.revision,
      };
    }

    const document = parseActionDocument(mutation.document);
    if (mutation.operation === 'create') {
      await this.#create(connection, mutation, context, document);
      return { ref: mutation.ref, operation: mutation.operation, localRevision: 1 };
    }

    const result = await this.#update(connection, mutation, context, document);
    if (result !== 1) throw new DataAdapterError('write_conflict');

    return {
      ref: mutation.ref,
      operation: mutation.operation,
      localRevision: mutation.expectedRevision + 1,
    };
  }

  async #create(
    connection: SqliteQueryConnection,
    mutation: Extract<CanonicalMutation, { readonly operation: 'create' }>,
    context: CommandContext,
    document: ActionCanonicalDocument,
  ): Promise<void> {
    if (mutation.baseServerRevision !== 0 || mutation.baseSnapshotHash !== null) {
      throw new DataAdapterError('write_conflict');
    }
    const deletedIdentity = await connection.get<{ readonly deleted: number }>(
      `SELECT 1 AS deleted
       FROM deletion_ledger
       WHERE owner_id = ? AND entity_type = ? AND entity_id = ?
       LIMIT 1;`,
      [mutation.ref.ownerId, mutation.ref.type, mutation.ref.id],
    );
    if (deletedIdentity !== undefined) throw new DataAdapterError('write_conflict');
    const encoded = encodeActionDocument(document);
    const result = await connection.run(
      `INSERT INTO actions (
         id, owner_id, axis_id, project_id, title, note_text, state, state_before_archive,
         estimate_minutes, energy, priority, due_date, due_at_utc, due_time_zone,
         converted_to_type, converted_to_id, capture_origin, sort_key, completed_at, archived_at,
         created_at, updated_at, client_updated_at, local_revision, server_revision,
         base_snapshot_hash
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
       );`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...encoded.parameters,
        context.now,
        context.now,
        context.now,
        mutation.baseServerRevision,
        mutation.baseSnapshotHash,
      ],
    );
    if (result.changes !== 1) throw new DataAdapterError('write_conflict');
  }

  async #update(
    connection: SqliteQueryConnection,
    mutation: Extract<CanonicalMutation, { readonly operation: 'update' }>,
    context: CommandContext,
    document: ActionCanonicalDocument,
  ): Promise<number> {
    const encoded = encodeActionDocument(document);
    const result = await connection.run(
      `UPDATE actions
       SET axis_id = ?, project_id = ?, title = ?, note_text = ?, state = ?,
           state_before_archive = ?, estimate_minutes = ?, energy = ?, priority = ?, due_date = ?,
           due_at_utc = ?, due_time_zone = ?, converted_to_type = ?, converted_to_id = ?,
           capture_origin = ?, sort_key = ?, completed_at = ?, archived_at = ?, updated_at = ?,
           client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        ...encoded.parameters,
        context.now,
        context.now,
        mutation.ref.ownerId,
        mutation.ref.id,
        mutation.expectedRevision,
        mutation.baseServerRevision,
        mutation.baseSnapshotHash,
      ],
    );
    return result.changes;
  }

  async #delete(
    connection: SqliteQueryConnection,
    mutation: Extract<CanonicalMutation, { readonly operation: 'delete' }>,
    context: CommandContext,
  ): Promise<number> {
    const tombstone = parseMinimalDeletionTombstone(mutation.tombstone);
    if (
      tombstone.ownerId !== mutation.ref.ownerId ||
      tombstone.entityType !== mutation.ref.type ||
      tombstone.entityId !== mutation.ref.id ||
      tombstone.revision !== mutation.expectedRevision + 1 ||
      tombstone.deletedAt !== context.now
    ) {
      throw new DataAdapterError('write_conflict');
    }

    const blocked = await connection.get<{ readonly blocked: number }>(
      `SELECT 1 AS blocked
       FROM (
         SELECT 1
         FROM sync_outbox
         WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
           AND state IN (
             'pending', 'sending', 'retry_wait', 'blocked_conflict', 'dead_letter'
           )
         UNION ALL
         SELECT 1
         FROM sync_conflicts
         WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
           AND state = 'open'
       )
       LIMIT 1;`,
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
      `DELETE FROM base_snapshots
       WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;`,
      [mutation.ref.ownerId, mutation.ref.type, mutation.ref.id],
    );
    await connection.run(
      `DELETE FROM sync_outbox
       WHERE owner_id = ? AND entity_type = ? AND entity_id = ?
         AND (state = 'acknowledged' OR deleted_at IS NOT NULL);`,
      [mutation.ref.ownerId, mutation.ref.type, mutation.ref.id],
    );
    await connection.run(
      `DELETE FROM sync_conflicts
       WHERE owner_id = ? AND entity_type = ? AND entity_id = ?
         AND (state IN ('resolved', 'superseded') OR deleted_at IS NOT NULL);`,
      [mutation.ref.ownerId, mutation.ref.type, mutation.ref.id],
    );
    await connection.run(
      `UPDATE undo_records
       SET state = 'expired', descriptor_payload_json = ?, updated_at = ?,
           local_revision = local_revision + 1
       WHERE owner_id = ?
         AND EXISTS (
           SELECT 1
           FROM json_each(json_extract(undo_records.descriptor_payload_json, '$.expectedRevisions'))
           WHERE key = ?
         );`,
      [
        '{"commandType":"redacted_for_permanent_delete","payload":{},"expectedRevisions":{}}',
        tombstone.deletedAt,
        mutation.ref.ownerId,
        `${mutation.ref.ownerId}:${mutation.ref.type}:${mutation.ref.id}`,
      ],
    );
    await connection.run(
      `UPDATE domain_events
       SET payload_json = '{}', updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;`,
      [tombstone.deletedAt, mutation.ref.ownerId, mutation.ref.type, mutation.ref.id],
    );

    const result = await connection.run(
      `DELETE FROM actions
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        mutation.ref.ownerId,
        mutation.ref.id,
        mutation.expectedRevision,
        mutation.baseServerRevision,
        mutation.baseSnapshotHash,
      ],
    );
    if (result.changes !== 1) return result.changes;

    const ledger = await connection.run(
      `INSERT INTO deletion_ledger (
         id, owner_id, entity_type, entity_id, local_revision, server_revision,
         deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        `${mutation.ref.ownerId}:${mutation.ref.type}:${mutation.ref.id}`,
        tombstone.ownerId,
        tombstone.entityType,
        tombstone.entityId,
        tombstone.revision,
        mutation.baseServerRevision,
        tombstone.deletedAt,
        tombstone.deletedAt,
        tombstone.deletedAt,
      ],
    );
    if (ledger.changes !== 1) throw new DataAdapterError('write_conflict');
    return result.changes;
  }
}

function parseActionDocument(document: Readonly<Record<string, unknown>>): ActionCanonicalDocument {
  const parsed = actionCanonicalDocumentSchema.safeParse(document);
  if (!parsed.success) throw new DataAdapterError('invalid_canonical_document');
  return parsed.data;
}

function encodeActionDocument(document: ActionCanonicalDocument): EncodedActionDocument {
  return {
    parameters: [
      document.axisId ?? null,
      document.projectId ?? null,
      document.title,
      document.note ?? null,
      document.state,
      document.stateBeforeArchive ?? null,
      document.estimateMinutes ?? null,
      document.energy ?? null,
      document.priority ?? null,
      document.due?.kind === 'date' ? document.due.date : null,
      document.due?.kind === 'instant' ? document.due.instant : null,
      document.due?.kind === 'instant' ? document.due.authoredTimeZone : null,
      document.convertedTo?.type ?? null,
      document.convertedTo?.id ?? null,
      document.captureOrigin,
      document.orderKey,
      document.completedAt ?? null,
      document.archivedAt ?? null,
    ],
  };
}

function decodeActionDocument(row: ActionRow): ActionCanonicalDocument {
  const candidate = {
    title: row.title,
    captureOrigin: row.capture_origin,
    ...(row.note_text === null ? {} : { note: row.note_text }),
    ...(row.axis_id === null ? {} : { axisId: row.axis_id }),
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.due_date !== null
      ? { due: { kind: 'date' as const, date: row.due_date } }
      : row.due_at_utc !== null && row.due_time_zone !== null
        ? {
            due: {
              kind: 'instant' as const,
              instant: row.due_at_utc,
              authoredTimeZone: row.due_time_zone,
            },
          }
        : {}),
    ...(row.estimate_minutes === null ? {} : { estimateMinutes: row.estimate_minutes }),
    ...(row.energy === null ? {} : { energy: row.energy }),
    ...(row.priority === null ? {} : { priority: row.priority }),
    orderKey: row.sort_key,
    state: row.state,
    ...(row.state_before_archive === null ? {} : { stateBeforeArchive: row.state_before_archive }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    ...(row.converted_to_type === null || row.converted_to_id === null
      ? {}
      : { convertedTo: { type: row.converted_to_type, id: row.converted_to_id } }),
  };
  return parseActionDocument(candidate);
}

export const actionCanonicalCodec: CanonicalRecordCodec = new ActionCanonicalCodec();
