import type { CommandContext, EntityRef } from '@yelaxis/domain';
import { z } from 'zod';

import type { SqliteQueryConnection } from '../sqlite/driver';
import {
  assertCreatable,
  BaseCodec,
  instant,
  nonBlank,
  optional,
  selectById,
  syncWhere,
  type CreateMutation,
  type Row,
  type UpdateMutation,
} from './base-codec';
import type { CanonicalRecordCodec } from './canonical-codecs';

/*
 * account sync record codec for private Context (identity contract). onboarding setup writes
 * Context rows directly; this codec gives them the same canonical document every other record has,
 * so they sync, export, and validate on the server like the rest of the plan. The document mirrors
 * the `contexts` row and the domain `UserContext`; the future sharing state is always
 * `not_shared` in manual planning.
 */
export const contextDocumentSchema = z
  .strictObject({
    category: z.enum([
      'identity_locale',
      'roles_axes',
      'availability',
      'commitments',
      'preferences',
      'goals',
      'boundaries',
      'sensitive_notes',
    ]),
    contextKey: nonBlank,
    value: z.string(),
    source: z.enum(['user', 'device', 'import']),
    sensitivity: z.enum(['normal', 'sensitive']),
    strength: z.enum(['hard', 'soft', 'unknown']),
    futureSharing: z.literal('not_shared'),
    state: z.enum(['active', 'archived']),
    stateBeforeArchive: z.literal('active').optional(),
    archivedAt: instant.optional(),
  })
  // The table's own rule: archived exactly when `archivedAt` is set (`state_before_archive` may be
  // absent on an archived row), and a prior state only on an archived one. No length caps beyond
  // the server's document size: setup accepts these values today, so the server must too.
  .refine((value) => (value.state === 'archived') === (value.archivedAt !== undefined))
  .refine((value) => value.stateBeforeArchive === undefined || value.state === 'archived');
export type ContextDocument = z.infer<typeof contextDocumentSchema>;

const contextColumns = (document: ContextDocument) => [
  document.category,
  document.contextKey,
  document.value,
  document.source,
  document.sensitivity,
  document.strength,
  document.state,
  document.stateBeforeArchive ?? null,
  document.archivedAt ?? null,
];

class ContextCodec extends BaseCodec<ContextDocument> {
  readonly entityType = 'context' as const;
  readonly table = 'contexts';
  protected readonly schema = contextDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      category: row['category'],
      contextKey: row['context_key'],
      value: row['value_text'],
      source: row['source'],
      sensitivity: row['sensitivity'],
      strength: row['strength'],
      futureSharing: row['future_sharing_state'],
      state: row['state'],
      ...optional('stateBeforeArchive', row['state_before_archive']),
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: ContextDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO contexts (
         id, owner_id, category, context_key, value_text, source, sensitivity, strength,
         future_sharing_state, state, state_before_archive, archived_at, created_at, updated_at,
         client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'not_shared', ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...contextColumns(document),
        context.now,
        context.now,
        context.now,
      ],
    );
    return result.changes;
  }
  async update(
    connection: SqliteQueryConnection,
    mutation: UpdateMutation,
    context: CommandContext,
    document: ContextDocument,
  ) {
    const result = await connection.run(
      `UPDATE contexts SET category = ?, context_key = ?, value_text = ?, source = ?,
         sensitivity = ?, strength = ?, state = ?, state_before_archive = ?, archived_at = ?,
         updated_at = ?, client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [...contextColumns(document), context.now, context.now, ...syncWhere(mutation)],
    );
    return result.changes;
  }
}

export const contextCanonicalCodec: CanonicalRecordCodec = new ContextCodec();
