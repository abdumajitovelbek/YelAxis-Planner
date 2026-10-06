import type {
  MilestoneActionDocument as ContractMilestoneActionDocument,
  MilestoneProjectDocument as ContractMilestoneProjectDocument,
  ProjectSecondaryOutcomeDocument as ContractProjectSecondaryOutcomeDocument,
} from '@yelaxis/application';
import {
  alignmentLinkId,
  type AlignmentJoinRelationship,
  type AlignmentLinkEntityType,
  type CommandContext,
  type EntityRef,
  type UUID,
} from '@yelaxis/domain';
import { z } from 'zod';

import type { SqliteQueryConnection } from '../sqlite/driver';
import {
  assertCreatable,
  BaseCodec,
  instant,
  optional,
  syncWhere,
  uuid,
  type CreateMutation,
  type DeleteMutation,
  type Row,
  type SameKeys,
  type UpdateMutation,
} from './base-codec';
import type { CanonicalRecordCodec } from './canonical-codecs';
import { parseMinimalDeletionTombstone } from './deletion-tombstone';
import { DataAdapterError } from './errors';

/*
 * alignment typed many-to-many links. A join row's `deleted_at` means "link inactive" and
 * is the document's `unlinkedAt`: the existing primary≠secondary triggers and every read already
 * treat it that way. Rows are read in any state, so a command can revive an unlinked row (the id is
 * derived from the pair) instead of inserting a duplicate. A row is physically removed, with a
 * deletion-ledger entry, only when one of its endpoints is permanently deleted.
 */

/* ───────────────────────── Schemas ───────────────────────── */

export const projectSecondaryOutcomeDocumentSchema = z.strictObject({
  projectId: uuid,
  outcomeId: uuid,
  unlinkedAt: instant.optional(),
});
export type ProjectSecondaryOutcomeDocument = z.infer<typeof projectSecondaryOutcomeDocumentSchema>;

export const milestoneProjectDocumentSchema = z.strictObject({
  milestoneId: uuid,
  projectId: uuid,
  unlinkedAt: instant.optional(),
});
export type MilestoneProjectDocument = z.infer<typeof milestoneProjectDocumentSchema>;

export const milestoneActionDocumentSchema = z.strictObject({
  milestoneId: uuid,
  actionId: uuid,
  unlinkedAt: instant.optional(),
});
export type MilestoneActionDocument = z.infer<typeof milestoneActionDocumentSchema>;

const contractShape: readonly true[] = [
  true satisfies SameKeys<ProjectSecondaryOutcomeDocument, ContractProjectSecondaryOutcomeDocument>,
  true satisfies SameKeys<MilestoneProjectDocument, ContractMilestoneProjectDocument>,
  true satisfies SameKeys<MilestoneActionDocument, ContractMilestoneActionDocument>,
];
void contractShape;

/* ───────────────────────── Tables ───────────────────────── */

/** Storage of one join relationship. The parent is the Outcome or Milestone; the child is the Project or Action. */
export interface AlignmentLinkTable {
  readonly relationship: AlignmentJoinRelationship;
  readonly entityType: AlignmentLinkEntityType;
  readonly table: 'project_secondary_outcomes' | 'milestone_projects' | 'milestone_actions';
  readonly parentKey: 'outcomeId' | 'milestoneId';
  readonly parentColumn: 'outcome_id' | 'milestone_id';
  readonly childKey: 'projectId' | 'actionId';
  readonly childColumn: 'project_id' | 'action_id';
}

export const alignmentLinkTables: Readonly<Record<AlignmentJoinRelationship, AlignmentLinkTable>> =
  Object.freeze({
    outcome_secondary_project: Object.freeze({
      relationship: 'outcome_secondary_project',
      entityType: 'project_secondary_outcome',
      table: 'project_secondary_outcomes',
      parentKey: 'outcomeId',
      parentColumn: 'outcome_id',
      childKey: 'projectId',
      childColumn: 'project_id',
    }),
    milestone_project: Object.freeze({
      relationship: 'milestone_project',
      entityType: 'milestone_project',
      table: 'milestone_projects',
      parentKey: 'milestoneId',
      parentColumn: 'milestone_id',
      childKey: 'projectId',
      childColumn: 'project_id',
    }),
    milestone_action: Object.freeze({
      relationship: 'milestone_action',
      entityType: 'milestone_action',
      table: 'milestone_actions',
      parentKey: 'milestoneId',
      parentColumn: 'milestone_id',
      childKey: 'actionId',
      childColumn: 'action_id',
    }),
  });

/* ───────────────────────── Codec ───────────────────────── */

type LinkDocument = Readonly<{ unlinkedAt?: string | undefined }>;

class AlignmentLinkCodec<Document extends LinkDocument> extends BaseCodec<Document> {
  readonly entityType: AlignmentLinkEntityType;
  readonly table: AlignmentLinkTable['table'];

  constructor(
    private readonly link: AlignmentLinkTable,
    protected readonly schema: z.ZodType<Document>,
  ) {
    super();
    this.entityType = link.entityType;
    this.table = link.table;
  }

  /** Any state: an unlinked row stays readable so it can be revived or removed. */
  readDocument(connection: SqliteQueryConnection, ref: EntityRef): Promise<Row | undefined> {
    return connection.get<Row>(`SELECT * FROM ${this.table} WHERE owner_id = ? AND id = ?;`, [
      ref.ownerId,
      ref.id,
    ]);
  }

  protected decodeRow(row: Row) {
    return {
      [this.link.parentKey]: row[this.link.parentColumn],
      [this.link.childKey]: row[this.link.childColumn],
      ...optional('unlinkedAt', row['deleted_at']),
    };
  }

  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: Document,
  ): Promise<number> {
    const { parentId, childId } = this.#endpoints(document);
    // One row per pair: the id must be the derived link id, so relinking can only revive it.
    if (mutation.ref.id !== alignmentLinkId(this.link.relationship, parentId, childId)) {
      throw new DataAdapterError('invalid_canonical_document');
    }
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO ${this.table} (
         id, owner_id, ${this.link.parentColumn}, ${this.link.childColumn}, created_at, updated_at,
         client_updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        parentId,
        childId,
        context.now,
        context.now,
        context.now,
        document.unlinkedAt ?? null,
      ],
    );
    return result.changes;
  }

  /** Only the link state changes; endpoints are part of the identity and must match. */
  async update(
    connection: SqliteQueryConnection,
    mutation: UpdateMutation,
    context: CommandContext,
    document: Document,
  ): Promise<number> {
    const { parentId, childId } = this.#endpoints(document);
    const result = await connection.run(
      `UPDATE ${this.table} SET deleted_at = ?, updated_at = ?, client_updated_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND local_revision = ? AND server_revision = ?
         AND base_snapshot_hash IS ? AND ${this.link.parentColumn} = ? AND ${this.link.childColumn} = ?;`,
      [
        document.unlinkedAt ?? null,
        context.now,
        context.now,
        ...syncWhere(mutation),
        parentId,
        childId,
      ],
    );
    return result.changes;
  }

  protected override delete(
    connection: SqliteQueryConnection,
    mutation: DeleteMutation,
    context: CommandContext,
  ): Promise<number> {
    return permanentlyDeleteLink(connection, this.table, mutation, context);
  }

  #endpoints(document: Document): { readonly parentId: UUID; readonly childId: UUID } {
    // The schema already validated both ids.
    const values = document as Readonly<Record<string, unknown>>;
    return {
      parentId: values[this.link.parentKey] as UUID,
      childId: values[this.link.childKey] as UUID,
    };
  }
}

/**
 * The permanent-delete steps of every canonical record (sync guards, snapshot and acknowledged
 * outbox cleanup, undo and event redaction, ledger entry), except that the row may be unlinked, so
 * the DELETE does not require `deleted_at IS NULL`. Used only when an endpoint is permanently
 * deleted.
 */
async function permanentlyDeleteLink(
  connection: SqliteQueryConnection,
  table: AlignmentLinkTable['table'],
  mutation: DeleteMutation,
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
  const { ownerId, type, id } = mutation.ref;
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
    [ownerId, type, id, ownerId, type, id],
  );
  if (blocked !== undefined) throw new DataAdapterError('write_conflict');
  await connection.run(
    `DELETE FROM base_snapshots WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;`,
    [ownerId, type, id],
  );
  await connection.run(
    `DELETE FROM sync_outbox WHERE owner_id = ? AND entity_type = ? AND entity_id = ?
       AND (state = 'acknowledged' OR deleted_at IS NOT NULL);`,
    [ownerId, type, id],
  );
  await connection.run(
    `DELETE FROM sync_conflicts WHERE owner_id = ? AND entity_type = ? AND entity_id = ?
       AND (state IN ('resolved', 'superseded') OR deleted_at IS NOT NULL);`,
    [ownerId, type, id],
  );
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
      ownerId,
      `${ownerId}:${type}:${id}`,
    ],
  );
  await connection.run(
    `UPDATE domain_events SET payload_json = '{}', updated_at = ?, local_revision = local_revision + 1
     WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;`,
    [context.now, ownerId, type, id],
  );
  const result = await connection.run(
    `DELETE FROM ${table} WHERE owner_id = ? AND id = ? AND local_revision = ?
       AND server_revision = ? AND base_snapshot_hash IS ?;`,
    syncWhere(mutation),
  );
  if (result.changes !== 1) return result.changes;
  const ledger = await connection.run(
    `INSERT INTO deletion_ledger (
       id, owner_id, entity_type, entity_id, local_revision, server_revision,
       deleted_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      `${ownerId}:${type}:${id}`,
      ownerId,
      type,
      id,
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

export const relationshipCanonicalCodecs: readonly CanonicalRecordCodec[] = [
  new AlignmentLinkCodec(
    alignmentLinkTables.outcome_secondary_project,
    projectSecondaryOutcomeDocumentSchema,
  ),
  new AlignmentLinkCodec(alignmentLinkTables.milestone_project, milestoneProjectDocumentSchema),
  new AlignmentLinkCodec(alignmentLinkTables.milestone_action, milestoneActionDocumentSchema),
];
