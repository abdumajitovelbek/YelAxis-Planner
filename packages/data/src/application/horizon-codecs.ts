import type {
  AxisDocument as ContractAxisDocument,
  ConstraintDocument as ContractConstraintDocument,
  MilestoneDocument as ContractMilestoneDocument,
  OutcomeDocument as ContractOutcomeDocument,
} from '@yelaxis/application';
import {
  isAvailabilityWindowOrdered,
  parseWallTime,
  type CommandContext,
  type EntityRef,
} from '@yelaxis/domain';
import { z } from 'zod';

import type { SqliteParameter, SqliteQueryConnection } from '../sqlite/driver';
import {
  archiveMetadataConsistent,
  assertCreatable,
  BaseCodec,
  calendarDate,
  ianaTimeZone,
  instant,
  nonBlank,
  optional,
  selectById,
  syncWhere,
  targetWindowOrdered,
  uuid,
  wallTime,
  weekday,
  type CreateMutation,
  type Row,
  type SameKeys,
  type UpdateMutation,
} from './base-codec';
import type { CanonicalRecordCodec } from './canonical-codecs';
import { DataAdapterError } from './errors';
import { decodeJson, encodeJson } from './json-codec';

/* ───────────────────────── Axis ───────────────────────── */

export const axisDocumentSchema = z
  .strictObject({
    title: nonBlank,
    purpose: z.string().optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
    orderKey: nonBlank,
    state: z.enum(['active', 'archived']),
    stateBeforeArchive: z.literal('active').optional(),
    archivedAt: instant.optional(),
  })
  .refine(archiveMetadataConsistent);
export type AxisDocument = z.infer<typeof axisDocumentSchema>;

function axisColumns(document: AxisDocument): SqliteParameter[] {
  return [
    document.title,
    document.purpose ?? null,
    document.color ?? null,
    document.icon ?? null,
    document.state,
    document.stateBeforeArchive ?? null,
    document.orderKey,
    document.archivedAt ?? null,
  ];
}

class AxisCodec extends BaseCodec<AxisDocument> {
  readonly entityType = 'axis' as const;
  readonly table = 'axes';
  protected readonly schema = axisDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      title: row['title'],
      ...optional('purpose', row['purpose']),
      ...optional('color', row['color_token']),
      ...optional('icon', row['icon_name']),
      orderKey: row['sort_key'],
      state: row['state'],
      ...optional('stateBeforeArchive', row['state_before_archive']),
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: AxisDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO axes (
         id, owner_id, title, purpose, color_token, icon_name, state, state_before_archive,
         sort_key, archived_at, created_at, updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...axisColumns(document),
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
    document: AxisDocument,
  ) {
    const result = await connection.run(
      `UPDATE axes SET title = ?, purpose = ?, color_token = ?, icon_name = ?, state = ?,
         state_before_archive = ?, sort_key = ?, archived_at = ?, updated_at = ?,
         client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [...axisColumns(document), context.now, context.now, ...syncWhere(mutation)],
    );
    return result.changes;
  }
}

/* ───────────────────────── Outcome ───────────────────────── */

export const outcomeDocumentSchema = z
  .strictObject({
    title: nonBlank,
    successDefinition: nonBlank,
    axisId: uuid.optional(),
    progress: z.discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('none') }),
      z.strictObject({
        mode: z.literal('manual'),
        percentage: z.number().int().min(0).max(100),
      }),
      z.strictObject({ mode: z.literal('milestone_derived') }),
    ]),
    targetStart: calendarDate.optional(),
    targetEnd: calendarDate.optional(),
    orderKey: nonBlank,
    state: z.enum(['active', 'paused', 'achieved', 'abandoned', 'archived']),
    stateBeforeArchive: z.enum(['active', 'paused', 'achieved', 'abandoned']).optional(),
    archivedAt: instant.optional(),
  })
  .refine(archiveMetadataConsistent)
  .refine(targetWindowOrdered);
export type OutcomeDocument = z.infer<typeof outcomeDocumentSchema>;

/** Candidate Outcome progress from `progress_mode` and `progress_percent`. */
export function decodeOutcomeProgress(mode: unknown, percent: unknown): unknown {
  return mode === 'manual' ? { mode, percentage: percent } : { mode };
}

function outcomeColumns(document: OutcomeDocument): SqliteParameter[] {
  return [
    document.axisId ?? null,
    document.title,
    document.successDefinition,
    document.state,
    document.stateBeforeArchive ?? null,
    document.progress.mode,
    document.progress.mode === 'manual' ? document.progress.percentage : null,
    document.targetStart ?? null,
    document.targetEnd ?? null,
    document.orderKey,
    document.archivedAt ?? null,
  ];
}

class OutcomeCodec extends BaseCodec<OutcomeDocument> {
  readonly entityType = 'outcome' as const;
  readonly table = 'outcomes';
  protected readonly schema = outcomeDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      title: row['title'],
      successDefinition: row['success_definition'],
      ...optional('axisId', row['axis_id']),
      progress: decodeOutcomeProgress(row['progress_mode'], row['progress_percent']),
      ...optional('targetStart', row['target_start_date']),
      ...optional('targetEnd', row['target_end_date']),
      orderKey: row['sort_key'],
      state: row['state'],
      ...optional('stateBeforeArchive', row['state_before_archive']),
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: OutcomeDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO outcomes (
         id, owner_id, axis_id, title, success_definition, state, state_before_archive,
         progress_mode, progress_percent, target_start_date, target_end_date, sort_key,
         archived_at, created_at, updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...outcomeColumns(document),
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
    document: OutcomeDocument,
  ) {
    const result = await connection.run(
      `UPDATE outcomes SET axis_id = ?, title = ?, success_definition = ?, state = ?,
         state_before_archive = ?, progress_mode = ?, progress_percent = ?,
         target_start_date = ?, target_end_date = ?, sort_key = ?, archived_at = ?,
         updated_at = ?, client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [...outcomeColumns(document), context.now, context.now, ...syncWhere(mutation)],
    );
    return result.changes;
  }
}

/* ───────────────────────── Milestone ───────────────────────── */

export const milestoneDocumentSchema = z
  .strictObject({
    title: nonBlank,
    measurableCheckpoint: nonBlank,
    outcomeId: uuid,
    targetStart: calendarDate.optional(),
    targetEnd: calendarDate.optional(),
    orderKey: nonBlank,
    state: z.enum(['active', 'completed', 'canceled', 'archived']),
    stateBeforeArchive: z.enum(['active', 'completed', 'canceled']).optional(),
    archivedAt: instant.optional(),
  })
  .refine(archiveMetadataConsistent)
  .refine(targetWindowOrdered);
export type MilestoneDocument = z.infer<typeof milestoneDocumentSchema>;

function milestoneColumns(document: MilestoneDocument): SqliteParameter[] {
  return [
    document.outcomeId,
    document.title,
    document.measurableCheckpoint,
    document.state,
    document.stateBeforeArchive ?? null,
    document.targetStart ?? null,
    document.targetEnd ?? null,
    document.orderKey,
    document.archivedAt ?? null,
  ];
}

class MilestoneCodec extends BaseCodec<MilestoneDocument> {
  readonly entityType = 'milestone' as const;
  readonly table = 'milestones';
  protected readonly schema = milestoneDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      title: row['title'],
      measurableCheckpoint: row['measurable_checkpoint'],
      outcomeId: row['outcome_id'],
      ...optional('targetStart', row['target_start_date']),
      ...optional('targetEnd', row['target_end_date']),
      orderKey: row['sort_key'],
      state: row['state'],
      ...optional('stateBeforeArchive', row['state_before_archive']),
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: MilestoneDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO milestones (
         id, owner_id, outcome_id, title, measurable_checkpoint, state, state_before_archive,
         target_start_date, target_end_date, sort_key, archived_at, created_at, updated_at,
         client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...milestoneColumns(document),
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
    document: MilestoneDocument,
  ) {
    const result = await connection.run(
      `UPDATE milestones SET outcome_id = ?, title = ?, measurable_checkpoint = ?, state = ?,
         state_before_archive = ?, target_start_date = ?, target_end_date = ?, sort_key = ?,
         archived_at = ?, updated_at = ?, client_updated_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [...milestoneColumns(document), context.now, context.now, ...syncWhere(mutation)],
    );
    return result.changes;
  }
}

/* ───────────────────────── Constraint ───────────────────────── */

/** Both ends are wall times; an end of 00:00 after a later start means the end of that day. */
const windowOrdered = (window: { readonly start: string; readonly end: string }): boolean => {
  const start = parseWallTime(window.start);
  const end = parseWallTime(window.end);
  return start.ok && end.ok && isAvailabilityWindowOrdered(start.value, end.value);
};

export const constraintValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('availability'),
    windows: z
      .array(z.strictObject({ weekday, start: wallTime, end: wallTime }).refine(windowOrdered))
      .max(100),
  }),
  z.strictObject({
    kind: z.literal('protected_interval'),
    interval: z
      .strictObject({ startsAt: instant, endsAt: instant, timeZone: ianaTimeZone })
      .refine((interval) => Date.parse(interval.startsAt) < Date.parse(interval.endsAt)),
  }),
  z.strictObject({
    kind: z.literal('capacity'),
    period: z.enum(['day', 'week']),
    minutes: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal('other'), description: nonBlank }),
]);

export const constraintDocumentSchema = z
  .strictObject({
    contextId: uuid.optional(),
    constraintKind: z.enum(['availability', 'protected_interval', 'capacity', 'other']),
    strength: z.enum(['hard', 'soft', 'unknown']),
    value: constraintValueSchema,
    state: z.enum(['active', 'archived']),
    stateBeforeArchive: z.literal('active').optional(),
    archivedAt: instant.optional(),
  })
  .refine((value) => value.constraintKind === value.value.kind)
  .refine(archiveMetadataConsistent);
export type ConstraintDocument = z.infer<typeof constraintDocumentSchema>;

/** Candidate Constraint document from one `constraints` row. */
export function decodeConstraintRow(row: Readonly<Record<string, unknown>>): unknown {
  if (row['value_schema_version'] !== 1 || typeof row['value_payload_json'] !== 'string') {
    throw new DataAdapterError('invalid_persisted_record');
  }
  return {
    ...optional('contextId', row['context_id']),
    constraintKind: row['constraint_kind'],
    strength: row['strength'],
    value: decodeJson(row['value_payload_json']),
    state: row['state'],
    ...optional('stateBeforeArchive', row['state_before_archive']),
    ...optional('archivedAt', row['archived_at']),
  };
}

function constraintColumns(document: ConstraintDocument): SqliteParameter[] {
  return [
    document.contextId ?? null,
    document.constraintKind,
    document.strength,
    encodeJson(document.value),
    document.state,
    document.stateBeforeArchive ?? null,
    document.archivedAt ?? null,
  ];
}

class ConstraintCodec extends BaseCodec<ConstraintDocument> {
  readonly entityType = 'constraint' as const;
  readonly table = 'constraints';
  protected readonly schema = constraintDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return decodeConstraintRow(row);
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: ConstraintDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO constraints (
         id, owner_id, context_id, constraint_kind, strength, value_schema_version,
         value_payload_json, state, state_before_archive, archived_at, created_at, updated_at,
         client_updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...constraintColumns(document),
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
    document: ConstraintDocument,
  ) {
    const result = await connection.run(
      `UPDATE constraints SET context_id = ?, constraint_kind = ?, strength = ?,
         value_schema_version = 1, value_payload_json = ?, state = ?, state_before_archive = ?,
         archived_at = ?, updated_at = ?, client_updated_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [...constraintColumns(document), context.now, context.now, ...syncWhere(mutation)],
    );
    return result.changes;
  }
}

const contractShape: readonly true[] = [
  true satisfies SameKeys<AxisDocument, ContractAxisDocument>,
  true satisfies SameKeys<OutcomeDocument, ContractOutcomeDocument>,
  true satisfies SameKeys<MilestoneDocument, ContractMilestoneDocument>,
  true satisfies SameKeys<ConstraintDocument, ContractConstraintDocument>,
];
void contractShape;

export const constraintCanonicalCodec = new ConstraintCodec();

export const horizonCanonicalCodecs: readonly CanonicalRecordCodec[] = [
  new AxisCodec(),
  new OutcomeCodec(),
  new MilestoneCodec(),
  constraintCanonicalCodec,
];
