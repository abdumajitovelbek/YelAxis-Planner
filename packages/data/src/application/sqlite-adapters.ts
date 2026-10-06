import type {
  ActiveIdentityContext,
  AppliedCanonicalChange,
  CanonicalMutation,
  CanonicalRecordRepository,
  CanonicalRecordState,
  CommandReceipt,
  CommandReceiptStore,
  DomainEventRecord,
  DomainEventStore,
  IdentityContextPort,
  OutboxMutationGroup,
  OutboxStore,
  PlanningUnitOfWork,
  UndoDescriptorRecord,
  UndoDescriptorStore,
  StoredUndoDescriptor,
  UnitOfWorkPort,
} from '@yelaxis/application';
import type {
  CommandContext,
  CommandId,
  EntityRef,
  EntityType,
  Instant,
  OwnerId,
  UUID,
} from '@yelaxis/domain';
import { z } from 'zod';

import type { SqliteDriver, SqliteQueryConnection } from '../sqlite/driver';
import {
  type CanonicalCodecRegistry,
  createDefaultCanonicalCodecRegistry,
} from './canonical-codecs';
import { parseMinimalDeletionTombstone } from './deletion-tombstone';
import { DataAdapterError } from './errors';
import { decodeJson, encodeJson } from './json-codec';

const entityTypes = [
  'profile',
  'axis',
  'outcome',
  'milestone',
  'project',
  'action',
  'note',
  'commitment',
  'time_block',
  'routine',
  'routine_occurrence',
  'routine_action_defaults',
  'template',
  'review',
  'review_item',
  'reminder',
  'context',
  'constraint',
  'planning_placement',
  'focus_selection',
  'theme',
  'direction',
  'project_secondary_outcome',
  'milestone_project',
  'milestone_action',
] as const satisfies readonly EntityType[];

type MissingEntityType = Exclude<EntityType, (typeof entityTypes)[number]>;
const entityTypeParity: [MissingEntityType] extends [never] ? true : never = true;
void entityTypeParity;

const uuidSchema = z.uuid();
const instantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u);
const actorSchema = z.enum(['user', 'import', 'sync', 'intelligence_proposal']);
const entityRefSchema = z.strictObject({
  type: z.enum(entityTypes),
  id: uuidSchema,
  ownerId: uuidSchema,
});
const commandReceiptSchema = z.strictObject({
  commandId: uuidSchema,
  ownerId: uuidSchema,
  actor: actorSchema,
  acceptedAt: instantSchema,
  canonical: z.array(
    z.strictObject({
      ref: entityRefSchema,
      localRevision: z.number().int().positive(),
    }),
  ),
  eventIds: z.array(uuidSchema),
  undo: z.discriminatedUnion('available', [
    z.strictObject({ available: z.literal(false) }),
    z.strictObject({ available: z.literal(true), undoId: uuidSchema }),
  ]),
  sync: z.discriminatedUnion('queued', [
    z.strictObject({ queued: z.literal(false) }),
    z.strictObject({
      queued: z.literal(true),
      mutationGroupId: uuidSchema,
      operationIds: z.array(uuidSchema),
    }),
  ]),
});
const undoDescriptorSchema = z.strictObject({
  commandType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  expectedRevisions: z.record(z.string(), z.number().int().positive()),
});

class CapabilityGuard {
  #active = true;

  assertActive(): void {
    if (!this.#active) throw new DataAdapterError('capability_expired');
  }

  expire(): void {
    this.#active = false;
  }
}

class SqliteCanonicalRecordRepository implements CanonicalRecordRepository {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly codecs: CanonicalCodecRegistry,
    private readonly guard: CapabilityGuard,
  ) {}

  read(ref: EntityRef): Promise<CanonicalRecordState | null> {
    this.guard.assertActive();
    return this.codecs.resolve(ref.type).read(this.connection, ref);
  }

  apply(mutation: CanonicalMutation, context: CommandContext): Promise<AppliedCanonicalChange> {
    this.guard.assertActive();
    return this.codecs.resolve(mutation.ref.type).apply(this.connection, mutation, context);
  }
}

class SqliteDomainEventStore implements DomainEventStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly guard: CapabilityGuard,
  ) {}

  async append(events: readonly DomainEventRecord[]): Promise<void> {
    this.guard.assertActive();
    const rows = events.map((record, sequence) => {
      if (record.ownerId !== record.event.aggregate.ownerId || record.event.version !== 1) {
        throw new DataAdapterError('write_conflict');
      }
      return { record, sequence, payload: encodeJson(record.event.payload) };
    });

    for (const { record, sequence, payload } of rows) {
      this.guard.assertActive();
      const result = await this.connection.run(
        `INSERT INTO domain_events (
           id, owner_id, command_id, sequence, actor, event_type, entity_type, entity_id,
           payload_schema_version, payload_json, occurred_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?);`,
        [
          record.eventId,
          record.ownerId,
          record.event.commandId,
          sequence,
          record.event.actor,
          record.event.eventType,
          record.event.aggregate.type,
          record.event.aggregate.id,
          payload,
          record.event.occurredAt,
          record.event.occurredAt,
          record.event.occurredAt,
        ],
      );
      assertSingleWrite(result.changes);
    }
  }
}

class SqliteUndoDescriptorStore implements UndoDescriptorStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly guard: CapabilityGuard,
  ) {}

  async append(record: UndoDescriptorRecord): Promise<void> {
    this.guard.assertActive();
    if (record.descriptor.version !== 1) throw new DataAdapterError('write_conflict');
    const payload = encodeJson({
      commandType: record.descriptor.commandType,
      payload: record.descriptor.payload,
      expectedRevisions: record.descriptor.expectedRevisions,
    });
    const result = await this.connection.run(
      `INSERT INTO undo_records (
         id, owner_id, command_id, state, descriptor_schema_version, descriptor_payload_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'available', 1, ?, ?, ?);`,
      [
        record.undoId,
        record.ownerId,
        record.commandId,
        payload,
        record.createdAt,
        record.createdAt,
      ],
    );
    assertSingleWrite(result.changes);
  }

  async find(ownerId: OwnerId, undoId: UUID): Promise<StoredUndoDescriptor | null> {
    this.guard.assertActive();
    const row = await this.connection.get<{
      id: string;
      owner_id: string;
      command_id: string;
      state: string;
      descriptor_schema_version: number;
      descriptor_payload_json: string;
      created_at: string;
      local_revision: number;
    }>(
      `SELECT id, owner_id, command_id, state, descriptor_schema_version,
              descriptor_payload_json, created_at, local_revision
       FROM undo_records
       WHERE owner_id = ? AND id = ? AND state = 'available' AND deleted_at IS NULL;`,
      [ownerId, undoId],
    );
    if (row === undefined) return null;
    if (row.descriptor_schema_version !== 1 || row.state !== 'available') {
      throw new DataAdapterError('invalid_persisted_record');
    }
    const descriptor = undoDescriptorSchema.safeParse(decodeJson(row.descriptor_payload_json));
    if (!descriptor.success) throw new DataAdapterError('invalid_persisted_record');
    return {
      undoId: row.id as UUID,
      ownerId: row.owner_id as OwnerId,
      commandId: row.command_id as CommandId,
      createdAt: row.created_at as Instant,
      localRevision: row.local_revision,
      state: 'available',
      descriptor: { ...descriptor.data, version: 1 },
    };
  }

  async markApplied(
    ownerId: OwnerId,
    undoId: UUID,
    expectedRevision: number,
    appliedAt: Instant,
  ): Promise<void> {
    this.guard.assertActive();
    const result = await this.connection.run(
      `UPDATE undo_records
       SET state = 'applied', applied_at = ?, updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND state = 'available' AND deleted_at IS NULL
         AND local_revision = ?;`,
      [appliedAt, appliedAt, ownerId, undoId, expectedRevision],
    );
    assertSingleWrite(result.changes);
  }
}

class SqliteOutboxStore implements OutboxStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly guard: CapabilityGuard,
  ) {}

  async append(group: OutboxMutationGroup): Promise<void> {
    this.guard.assertActive();
    if (group.operations.length === 0) throw new DataAdapterError('write_conflict');
    const operationIds = new Set<string>();
    const rows = group.operations.map((operation, index) => {
      if (
        operation.mutationGroupId !== group.mutationGroupId ||
        operation.sequence !== index ||
        operation.state !== 'pending' ||
        operation.attemptCount !== 0 ||
        operation.mutation.ref.ownerId !== group.ownerId ||
        operationIds.has(operation.operationId)
      ) {
        throw new DataAdapterError('write_conflict');
      }
      operationIds.add(operation.operationId);
      const mutation = operation.mutation;
      let payload: string;
      if (mutation.operation === 'delete') {
        const tombstone = parseMinimalDeletionTombstone(mutation.tombstone);
        if (
          tombstone.ownerId !== mutation.ref.ownerId ||
          tombstone.entityType !== mutation.ref.type ||
          tombstone.entityId !== mutation.ref.id ||
          tombstone.revision !== mutation.expectedRevision + 1 ||
          tombstone.deletedAt !== group.createdAt
        ) {
          throw new DataAdapterError('write_conflict');
        }
        payload = encodeJson(tombstone);
      } else {
        payload = encodeJson(mutation.document);
      }
      return { operation, payload };
    });

    for (const { operation, payload } of rows) {
      this.guard.assertActive();
      const mutation = operation.mutation;
      const result = await this.connection.run(
        `INSERT INTO sync_outbox (
           id, owner_id, operation_id, mutation_group_id, command_id, actor, sequence,
           entity_type, entity_id, operation_kind, expected_revision, document_schema_version,
           document_payload_json, base_server_revision, base_snapshot_hash, state, attempt_count,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'pending', 0, ?, ?, ?);`,
        [
          operation.operationId,
          group.ownerId,
          operation.operationId,
          group.mutationGroupId,
          group.commandId,
          group.actor,
          operation.sequence,
          mutation.ref.type,
          mutation.ref.id,
          mutation.operation,
          mutation.operation === 'create' ? null : mutation.expectedRevision,
          payload,
          mutation.baseServerRevision,
          mutation.baseSnapshotHash,
          operation.nextAttemptAt,
          group.createdAt,
          group.createdAt,
        ],
      );
      assertSingleWrite(result.changes);
    }
  }
}

class SqliteCommandReceiptStore implements CommandReceiptStore {
  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly guard: CapabilityGuard,
  ) {}

  async find(ownerId: OwnerId, commandId: CommandId): Promise<CommandReceipt | null> {
    this.guard.assertActive();
    const row = await this.connection.get<{
      readonly owner_id: string;
      readonly command_id: string;
      readonly actor: string;
      readonly accepted_at: string;
      readonly receipt_schema_version: number;
      readonly receipt_payload_json: string;
    }>(
      `SELECT owner_id, command_id, actor, accepted_at, receipt_schema_version,
              receipt_payload_json
       FROM command_receipts
       WHERE owner_id = ? AND command_id = ? AND deleted_at IS NULL;`,
      [ownerId, commandId],
    );
    if (row === undefined) return null;
    if (row.receipt_schema_version !== 1) {
      throw new DataAdapterError('invalid_persisted_record');
    }

    const receipt = parseCommandReceipt(decodeJson(row.receipt_payload_json));
    if (
      receipt.ownerId !== row.owner_id ||
      receipt.commandId !== row.command_id ||
      receipt.actor !== row.actor ||
      receipt.acceptedAt !== row.accepted_at
    ) {
      throw new DataAdapterError('invalid_persisted_record');
    }
    return receipt;
  }

  async append(receipt: CommandReceipt): Promise<void> {
    this.guard.assertActive();
    const validated = parseCommandReceipt(receipt);
    const payload = encodeJson(validated);
    const result = await this.connection.run(
      `INSERT INTO command_receipts (
         id, owner_id, command_id, actor, accepted_at, receipt_schema_version,
         receipt_payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?);`,
      [
        validated.commandId,
        validated.ownerId,
        validated.commandId,
        validated.actor,
        validated.acceptedAt,
        payload,
        validated.acceptedAt,
        validated.acceptedAt,
      ],
    );
    assertSingleWrite(result.changes);
  }
}

export interface SqliteUnitOfWorkOptions {
  readonly codecs?: CanonicalCodecRegistry;
}

/**
 * The planning capabilities bound to one open transaction (shared by the sync unit of work,
 * so canonical rows, events, and outbox groups commit with sync metadata). `expire` ends them.
 */
export function bindPlanningUnitOfWork(
  connection: SqliteQueryConnection,
  codecs: CanonicalCodecRegistry,
): { readonly capabilities: PlanningUnitOfWork; readonly expire: () => void } {
  const guard = new CapabilityGuard();
  return {
    capabilities: {
      records: new SqliteCanonicalRecordRepository(connection, codecs, guard),
      events: new SqliteDomainEventStore(connection, guard),
      undo: new SqliteUndoDescriptorStore(connection, guard),
      outbox: new SqliteOutboxStore(connection, guard),
      receipts: new SqliteCommandReceiptStore(connection, guard),
    },
    expire: () => guard.expire(),
  };
}

export class SqliteUnitOfWork implements UnitOfWorkPort {
  readonly #driver: SqliteDriver;
  readonly #codecs: CanonicalCodecRegistry;
  #transactionActive = false;

  constructor(driver: SqliteDriver, options: SqliteUnitOfWorkOptions = {}) {
    this.#driver = driver;
    this.#codecs = options.codecs ?? createDefaultCanonicalCodecRegistry();
  }

  async runInTransaction<Result>(
    work: (unitOfWork: PlanningUnitOfWork) => Promise<Result>,
  ): Promise<Result> {
    if (this.#transactionActive) throw new DataAdapterError('concurrent_transaction');
    this.#transactionActive = true;

    try {
      return await this.#driver.transaction(async (connection) => {
        // A command may cancel an old block with `superseded_by_id` before it creates the
        // superseding block. Foreign keys stay enforced, but only when the transaction commits;
        // SQLite resets this pragma after every COMMIT or ROLLBACK.
        await connection.run('PRAGMA defer_foreign_keys = ON;');
        const { capabilities, expire } = bindPlanningUnitOfWork(connection, this.#codecs);
        try {
          return await work(capabilities);
        } finally {
          expire();
        }
      });
    } finally {
      this.#transactionActive = false;
    }
  }
}

interface IdentityRow {
  readonly id: string;
  readonly identity_kind: 'account' | 'local';
}

export interface SqliteIdentityContextOptions {
  /** Required when a database can contain more than one non-deleted identity. */
  readonly ownerId?: OwnerId;
}

export class SqliteIdentityContext implements IdentityContextPort {
  constructor(
    private readonly driver: SqliteDriver,
    private readonly options: SqliteIdentityContextOptions = {},
  ) {}

  async getActiveIdentity(): Promise<ActiveIdentityContext | null> {
    const rows =
      this.options.ownerId === undefined
        ? await this.driver.all<IdentityRow>(
            `SELECT id, identity_kind
             FROM planning_identities
             WHERE deleted_at IS NULL
             ORDER BY created_at, id
             LIMIT 2;`,
          )
        : await this.driver.all<IdentityRow>(
            `SELECT id, identity_kind
             FROM planning_identities
             WHERE id = ? AND deleted_at IS NULL
             LIMIT 1;`,
            [this.options.ownerId],
          );
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new DataAdapterError('identity_ambiguous');

    const row = rows[0];
    if (row === undefined || !uuidSchema.safeParse(row.id).success) {
      throw new DataAdapterError('invalid_identity_record');
    }
    if (row.identity_kind !== 'local' && row.identity_kind !== 'account') {
      throw new DataAdapterError('invalid_identity_record');
    }
    return {
      ownerId: row.id as OwnerId,
      syncEnabled: row.identity_kind === 'account',
    };
  }
}

export interface SqliteApplicationAdapters {
  readonly unitOfWork: UnitOfWorkPort;
  readonly identityContext: IdentityContextPort;
}

export function createSqliteApplicationAdapters(
  driver: SqliteDriver,
  options: SqliteIdentityContextOptions & SqliteUnitOfWorkOptions = {},
): SqliteApplicationAdapters {
  return {
    unitOfWork: new SqliteUnitOfWork(driver, options),
    identityContext: new SqliteIdentityContext(driver, options),
  };
}

function parseCommandReceipt(value: unknown): CommandReceipt {
  const parsed = commandReceiptSchema.safeParse(value);
  if (!parsed.success) throw new DataAdapterError('invalid_persisted_record');
  return parsed.data as unknown as CommandReceipt;
}

function assertSingleWrite(changes: number): void {
  if (changes !== 1) throw new DataAdapterError('write_conflict');
}
