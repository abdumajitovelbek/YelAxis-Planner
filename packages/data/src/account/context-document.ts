import type { CanonicalRecordState } from '@yelaxis/application';
import type { EntityRef } from '@yelaxis/domain';
import { z } from 'zod';

import { optional, selectById } from '../application/base-codec';
import { contextDocumentSchema } from '../application/context-codec';
import { DataAdapterError } from '../application/errors';
import type { SqliteQueryConnection } from '../sqlite/driver';

/** The Context document is defined once, by its record codec (export, upload, and the server). */
export { contextDocumentSchema };
export type { ContextDocument } from '../application/context-codec';

const contextRow = z.looseObject({
  id: z.string(),
  owner_id: z.string(),
  local_revision: z.number().int().positive(),
  server_revision: z.number().int().nonnegative(),
  base_snapshot_hash: z.string().nullable(),
});

/** Candidate Context document from one `contexts` row. */
export function decodeContextRow(row: Readonly<Record<string, unknown>>): unknown {
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

/** One live Context entry as a canonical record, validated like a codec read. */
export async function readContextRecord(
  connection: SqliteQueryConnection,
  ref: EntityRef,
): Promise<CanonicalRecordState | null> {
  const candidate = await selectById(connection, 'contexts', ref);
  if (candidate === undefined) return null;
  const row = contextRow.safeParse(candidate);
  if (!row.success || row.data.id !== ref.id || row.data.owner_id !== ref.ownerId) {
    throw new DataAdapterError('invalid_persisted_record');
  }
  const document = contextDocumentSchema.safeParse(decodeContextRow(candidate));
  if (!document.success) throw new DataAdapterError('invalid_persisted_record');
  return {
    ref,
    localRevision: row.data.local_revision,
    serverRevision: row.data.server_revision,
    baseSnapshotHash: row.data.base_snapshot_hash,
    document: document.data,
  };
}
