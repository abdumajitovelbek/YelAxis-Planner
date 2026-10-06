import type {
  RoutineActionDefaultsDocument as ContractRoutineActionDefaultsDocument,
  RoutineDocument as ContractRoutineDocument,
  RoutineOccurrenceDocument as ContractRoutineOccurrenceDocument,
} from '@yelaxis/application';
import {
  deriveNameBasedUuid,
  energyLabels,
  occurrenceLogicalKey,
  occurrencePeriodKey,
  parseOccurrenceOverride,
  parseRecurrenceRuleV1,
  parseRoutineSchedulingMode,
  routineOccurrenceId,
  yelaxisDerivedIdNamespace,
  type CommandContext,
  type EntityRef,
  type GeneratedOccurrencePeriod,
  type OccurrenceOverrideV1,
  type RecurrenceRuleV1,
  type RoutineSchedulingMode,
  type UUID,
} from '@yelaxis/domain';
import { z } from 'zod';

import type { SqliteParameter, SqliteQueryConnection } from '../sqlite/driver';
import {
  archiveMetadataConsistent,
  assertCreatable,
  BaseCodec,
  boundedText,
  calendarDate,
  instant,
  nonBlank,
  optional,
  selectById,
  syncWhere,
  uuid,
  weekday,
  type CreateMutation,
  type DeleteMutation,
  type Row,
  type SameKeys,
  type UpdateMutation,
} from './base-codec';
import type { CanonicalRecordCodec } from './canonical-codecs';
import { DataAdapterError } from './errors';
import { decodeJson, encodeJson } from './json-codec';

/* ───────────────────────── Routine ───────────────────────── */

const recurrenceRule = z
  .custom<RecurrenceRuleV1>((value) => parseRecurrenceRuleV1(value).ok)
  .transform((value) => {
    const parsed = parseRecurrenceRuleV1(value);
    if (!parsed.ok) throw new DataAdapterError('invalid_canonical_document');
    return parsed.value;
  });

const schedulingMode = z
  .custom<RoutineSchedulingMode>((value) => parseRoutineSchedulingMode(value).ok)
  .transform((value) => {
    const parsed = parseRoutineSchedulingMode(value);
    if (!parsed.ok) throw new DataAdapterError('invalid_canonical_document');
    return parsed.value;
  });

export const routineGenerationDocumentSchema = z
  .strictObject({
    generation: z.number().int().positive(),
    rule: recurrenceRule,
    schedulingMode,
  })
  .refine(
    (value) => value.rule.kind !== 'weekly_count' || value.schedulingMode.kind === 'day_flexible',
  );

export const routineDocumentSchema = z
  .strictObject({
    title: boundedText(200),
    description: z.string().max(10_000).optional(),
    axisId: uuid.optional(),
    orderKey: nonBlank,
    state: z.enum(['active', 'paused', 'archived']),
    stateBeforeArchive: z.enum(['active', 'paused']).optional(),
    pauseEffectiveOn: calendarDate.optional(),
    archivedAt: instant.optional(),
    generations: z.array(routineGenerationDocumentSchema).min(1),
  })
  .refine(archiveMetadataConsistent);
export type RoutineDocument = z.infer<typeof routineDocumentSchema>;
export type RoutineGenerationDocument = RoutineDocument['generations'][number];

/** Stable derived id of one generation row, so repeated writes never duplicate generations. */
export function routineGenerationId(routineId: string, generation: number): UUID {
  return deriveNameBasedUuid(
    yelaxisDerivedIdNamespace,
    `routine-generation:${routineId}:${String(generation)}`,
  );
}

function contiguous(generations: readonly { readonly generation: number }[]): boolean {
  return generations.every((item, index) => item.generation === index + 1);
}

/** Column values after `generation` in `routine_generations` for one generation document. */
function generationColumns(value: RoutineGenerationDocument): SqliteParameter[] {
  const mode = value.schedulingMode;
  const timed = mode.kind === 'time_specific' ? mode : undefined;
  return [
    1,
    encodeJson(value.rule),
    mode.kind,
    value.rule.startsOn,
    value.rule.endsOn ?? null,
    timed?.wallTime ?? null,
    timed?.durationMinutes ?? null,
    timed?.zonePolicy.kind ?? null,
    timed?.zonePolicy.kind === 'fixed_zone' ? timed.zonePolicy.timeZone : null,
    timed?.gapPolicy ?? null,
    timed?.overlapPolicy ?? null,
  ];
}

const generationColumnNames = [
  'recurrence_schema_version',
  'recurrence_payload_json',
  'scheduling_mode',
  'starts_on',
  'ends_on',
  'wall_time',
  'duration_minutes',
  'zone_policy',
  'anchor_time_zone',
  'dst_gap_policy',
  'repeated_time_policy',
] as const;

/** Candidate generation document from one `routine_generations` row. */
export function decodeGenerationRow(row: Readonly<Record<string, unknown>>): unknown {
  if (row['recurrence_schema_version'] !== 1 || typeof row['recurrence_payload_json'] !== 'string')
    throw new DataAdapterError('invalid_persisted_record');
  const rule = parseRecurrenceRuleV1(decodeJson(row['recurrence_payload_json']));
  if (
    !rule.ok ||
    row['starts_on'] !== rule.value.startsOn ||
    (row['ends_on'] ?? undefined) !== rule.value.endsOn
  ) {
    throw new DataAdapterError('invalid_persisted_record');
  }
  const mode =
    row['scheduling_mode'] === 'day_flexible'
      ? { kind: 'day_flexible' }
      : {
          kind: row['scheduling_mode'],
          wallTime: row['wall_time'],
          durationMinutes: row['duration_minutes'],
          zonePolicy:
            row['zone_policy'] === 'fixed_zone'
              ? { kind: 'fixed_zone', timeZone: row['anchor_time_zone'] }
              : { kind: row['zone_policy'] },
          gapPolicy: row['dst_gap_policy'],
          overlapPolicy: row['repeated_time_policy'],
        };
  return { generation: row['generation'], rule: rule.value, schedulingMode: mode };
}

/** Candidate Routine document from its row and every generation row (ascending). */
export function decodeRoutineRows(
  row: Readonly<Record<string, unknown>>,
  generations: readonly Readonly<Record<string, unknown>>[],
): unknown {
  if (generations.length === 0 || !contiguous(generations as { generation: number }[])) {
    throw new DataAdapterError('invalid_persisted_record');
  }
  return {
    title: row['title'],
    ...optional('description', row['description']),
    ...optional('axisId', row['axis_id']),
    orderKey: row['sort_key'],
    state: row['state'],
    ...optional('stateBeforeArchive', row['state_before_archive']),
    ...optional('pauseEffectiveOn', row['paused_effective_date']),
    ...optional('archivedAt', row['archived_at']),
    generations: generations.map(decodeGenerationRow),
  };
}

const generationsKey = '__routine_generations';

class RoutineCodec extends BaseCodec<RoutineDocument> {
  readonly entityType = 'routine' as const;
  readonly table = 'routines';
  protected readonly schema = routineDocumentSchema;

  protected override async delete(
    connection: SqliteQueryConnection,
    mutation: DeleteMutation,
    context: CommandContext,
  ): Promise<number> {
    const changes = await super.delete(connection, mutation, context);
    if (changes === 1) {
      // Generations are internal to the Routine document. Explicit canonical dependents
      // (Occurrences/defaults) remain protected by their foreign keys and are never cascaded.
      await connection.run(
        'DELETE FROM routine_generations WHERE owner_id = ? AND routine_id = ?;',
        [mutation.ref.ownerId, mutation.ref.id],
      );
    }
    return changes;
  }

  async readDocument(connection: SqliteQueryConnection, ref: EntityRef): Promise<Row | undefined> {
    const row = await selectById(connection, this.table, ref);
    if (row === undefined) return undefined;
    const generations = await connection.all<Record<string, unknown>>(
      `SELECT * FROM routine_generations
       WHERE owner_id = ? AND routine_id = ? AND deleted_at IS NULL
       ORDER BY generation ASC;`,
      [ref.ownerId, ref.id],
    );
    return { ...row, [generationsKey]: generations };
  }

  protected decodeRow(row: Row) {
    const generations = row[generationsKey];
    if (!Array.isArray(generations)) throw new DataAdapterError('invalid_persisted_record');
    return decodeRoutineRows(row, generations as Record<string, unknown>[]);
  }

  /** Decode a routine row plus its generation rows fetched in bulk by a query adapter. */
  decodeWithGenerations(
    row: Readonly<Record<string, unknown>>,
    generations: readonly Readonly<Record<string, unknown>>[],
  ): RoutineDocument {
    const parsed = this.schema.safeParse(decodeRoutineRows(row, generations));
    if (!parsed.success) throw new DataAdapterError('invalid_persisted_record');
    return parsed.data;
  }

  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: RoutineDocument,
  ) {
    if (!contiguous(document.generations)) throw new DataAdapterError('write_conflict');
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO routines (
         id, owner_id, axis_id, title, description, state, state_before_archive, sort_key,
         paused_effective_date, archived_at, created_at, updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...this.#routineColumns(document),
        context.now,
        context.now,
        context.now,
      ],
    );
    if (result.changes !== 1) return result.changes;
    for (const generation of document.generations) {
      await this.#insertGeneration(connection, mutation.ref, generation, context);
    }
    return 1;
  }

  async update(
    connection: SqliteQueryConnection,
    mutation: UpdateMutation,
    context: CommandContext,
    document: RoutineDocument,
  ) {
    if (!contiguous(document.generations)) throw new DataAdapterError('write_conflict');
    const result = await connection.run(
      `UPDATE routines SET axis_id = ?, title = ?, description = ?, state = ?,
         state_before_archive = ?, sort_key = ?, paused_effective_date = ?, archived_at = ?,
         updated_at = ?, client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [...this.#routineColumns(document), context.now, context.now, ...syncWhere(mutation)],
    );
    if (result.changes !== 1) return result.changes;

    const rows = await connection.all<Record<string, unknown>>(
      `SELECT * FROM routine_generations
       WHERE owner_id = ? AND routine_id = ?
       ORDER BY generation ASC;`,
      [mutation.ref.ownerId, mutation.ref.id],
    );
    const active = rows.filter((row) => row['deleted_at'] === null);
    if (!contiguous(active as { generation: number }[])) {
      throw new DataAdapterError('write_conflict');
    }
    // Earlier generations are never removed. Only the exact undo of a This-and-future split or of
    // a resume may retire the trailing generations it added, and only while no occurrence history
    // refers to them. The row is retired with `deleted_at` (foreign keys stay satisfied) and is
    // revived if a later change starts the same generation number again.
    for (const row of active.slice(document.generations.length)) {
      const history = await connection.get<{ readonly found: number }>(
        `SELECT 1 AS found FROM routine_occurrences
         WHERE owner_id = ? AND routine_id = ? AND generation = ? AND deleted_at IS NULL
         LIMIT 1;`,
        [mutation.ref.ownerId, mutation.ref.id, row['generation'] as number],
      );
      if (history !== undefined) throw new DataAdapterError('write_conflict');
      const retired = await connection.run(
        `UPDATE routine_generations SET deleted_at = ?, updated_at = ?, client_updated_at = ?,
           local_revision = local_revision + 1
         WHERE owner_id = ? AND routine_id = ? AND generation = ? AND deleted_at IS NULL
           AND local_revision = ?;`,
        [
          context.now,
          context.now,
          context.now,
          mutation.ref.ownerId,
          mutation.ref.id,
          row['generation'] as number,
          row['local_revision'] as number,
        ],
      );
      if (retired.changes !== 1) throw new DataAdapterError('write_conflict');
    }
    for (const generation of document.generations) {
      const current = rows.find((row) => row['generation'] === generation.generation);
      if (current === undefined) {
        await this.#insertGeneration(connection, mutation.ref, generation, context);
        continue;
      }
      const revived = current['deleted_at'] !== null;
      const next = generationColumns(generation);
      const unchanged = generationColumnNames.every(
        (column, index) => (current[column] ?? null) === next[index],
      );
      if (unchanged && !revived) continue;
      const updated = await connection.run(
        `UPDATE routine_generations SET ${generationColumnNames
          .map((column) => `${column} = ?`)
          .join(', ')}, deleted_at = NULL, updated_at = ?, client_updated_at = ?,
           local_revision = local_revision + 1
         WHERE owner_id = ? AND routine_id = ? AND generation = ? AND local_revision = ?;`,
        [
          ...next,
          context.now,
          context.now,
          mutation.ref.ownerId,
          mutation.ref.id,
          generation.generation,
          current['local_revision'] as number,
        ],
      );
      if (updated.changes !== 1) throw new DataAdapterError('write_conflict');
    }
    return 1;
  }

  #routineColumns(document: RoutineDocument): SqliteParameter[] {
    return [
      document.axisId ?? null,
      document.title,
      document.description ?? null,
      document.state,
      document.stateBeforeArchive ?? null,
      document.orderKey,
      document.pauseEffectiveOn ?? null,
      document.archivedAt ?? null,
    ];
  }

  async #insertGeneration(
    connection: SqliteQueryConnection,
    routine: EntityRef,
    generation: RoutineGenerationDocument,
    context: CommandContext,
  ): Promise<void> {
    const result = await connection.run(
      `INSERT INTO routine_generations (
         id, owner_id, routine_id, generation, ${generationColumnNames.join(', ')},
         created_at, updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        routineGenerationId(routine.id, generation.generation),
        routine.ownerId,
        routine.id,
        generation.generation,
        ...generationColumns(generation),
        context.now,
        context.now,
        context.now,
      ],
    );
    if (result.changes !== 1) throw new DataAdapterError('write_conflict');
  }
}

/* ───────────────────────── Routine Occurrence ───────────────────────── */

const occurrenceOverride = z.custom<OccurrenceOverrideV1>(
  (value) => parseOccurrenceOverride(value).ok,
);

export const routineOccurrenceDocumentSchema = z
  .strictObject({
    routineId: uuid,
    generation: z.number().int().positive(),
    periodKey: z.string(),
    period: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('date'), date: calendarDate }),
      z.strictObject({
        kind: z.literal('week'),
        start: calendarDate,
        end: calendarDate,
        weekStart: weekday,
        targetCount: z.number().int().positive(),
      }),
    ]),
    state: z.enum(['planned', 'completed', 'skipped']),
    targetCount: z.number().int().positive().optional(),
    completedCount: z.number().int().nonnegative().optional(),
    extraCompletionsConfirmed: z.boolean().optional(),
    override: occurrenceOverride.optional(),
    completedAt: instant.optional(),
  })
  .refine(
    (value) => value.periodKey === occurrencePeriodKey(value.period as GeneratedOccurrencePeriod),
  )
  .refine((value) =>
    value.period.kind === 'date'
      ? value.targetCount === undefined &&
        value.completedCount === undefined &&
        value.extraCompletionsConfirmed !== true
      : value.period.start <= value.period.end &&
        value.targetCount === value.period.targetCount &&
        value.completedCount !== undefined,
  );
export type RoutineOccurrenceDocument = z.infer<typeof routineOccurrenceDocumentSchema>;

/** The only valid id for an occurrence document: derived from its logical key. */
export function occurrenceIdFor(document: {
  readonly routineId: string;
  readonly generation: number;
  readonly period: unknown;
}): UUID {
  return routineOccurrenceId(
    occurrenceLogicalKey(
      document.routineId as UUID,
      document.generation,
      document.period as GeneratedOccurrencePeriod,
    ),
  );
}

/** Candidate occurrence document from one `routine_occurrences` row. */
export function decodeOccurrenceRow(row: Readonly<Record<string, unknown>>): unknown {
  const key = row['logical_period_key'];
  if (typeof key !== 'string' || row['ordinal'] !== 0) {
    throw new DataAdapterError('invalid_persisted_record');
  }
  let period: unknown;
  if (row['occurrence_kind'] === 'dated') {
    period = { kind: 'date', date: key };
  } else {
    const [start, end, weekStart, ...rest] = key.split('/');
    if (rest.length > 0) throw new DataAdapterError('invalid_persisted_record');
    period = { kind: 'week', start, end, weekStart, targetCount: row['target_count'] };
  }
  let override: unknown;
  if (row['override_payload_json'] !== null) {
    if (row['override_schema_version'] !== 1 || typeof row['override_payload_json'] !== 'string') {
      throw new DataAdapterError('invalid_persisted_record');
    }
    const parsed = parseOccurrenceOverride(decodeJson(row['override_payload_json']));
    if (!parsed.ok) throw new DataAdapterError('invalid_persisted_record');
    override = parsed.value;
  }
  return {
    routineId: row['routine_id'],
    generation: row['generation'],
    periodKey: key,
    period,
    state: row['state'],
    ...optional('targetCount', row['target_count']),
    ...optional('completedCount', row['completed_count']),
    ...(row['extra_completions_confirmed'] === 1 ? { extraCompletionsConfirmed: true } : {}),
    ...optional('override', override),
    ...optional('completedAt', row['completed_at']),
  };
}

function occurrenceColumns(document: RoutineOccurrenceDocument): SqliteParameter[] {
  return [
    document.routineId,
    document.generation,
    document.periodKey,
    document.period.kind === 'date' ? 'dated' : 'weekly_count',
    document.state,
    document.period.kind === 'week' ? document.period.targetCount : null,
    document.period.kind === 'week' ? (document.completedCount ?? 0) : null,
    document.extraCompletionsConfirmed === true ? 1 : 0,
    document.override === undefined ? null : 1,
    document.override === undefined ? null : encodeJson(document.override),
    document.completedAt ?? null,
  ];
}

class RoutineOccurrenceCodec extends BaseCodec<RoutineOccurrenceDocument> {
  readonly entityType = 'routine_occurrence' as const;
  readonly table = 'routine_occurrences';
  protected readonly schema = routineOccurrenceDocumentSchema;

  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }

  protected decodeRow(row: Row) {
    const candidate = decodeOccurrenceRow(row) as {
      routineId: string;
      generation: number;
      period: unknown;
    };
    if (occurrenceIdFor(candidate) !== row.id) {
      throw new DataAdapterError('invalid_persisted_record');
    }
    return candidate;
  }

  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: RoutineOccurrenceDocument,
  ) {
    if (occurrenceIdFor(document) !== mutation.ref.id) throw new DataAdapterError('write_conflict');
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO routine_occurrences (
         id, owner_id, routine_id, generation, logical_period_key, occurrence_kind, state,
         target_count, completed_count, extra_completions_confirmed, override_schema_version,
         override_payload_json, completed_at, ordinal, created_at, updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...occurrenceColumns(document),
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
    document: RoutineOccurrenceDocument,
  ) {
    if (occurrenceIdFor(document) !== mutation.ref.id) throw new DataAdapterError('write_conflict');
    const result = await connection.run(
      `UPDATE routine_occurrences SET routine_id = ?, generation = ?, logical_period_key = ?,
         occurrence_kind = ?, state = ?, target_count = ?, completed_count = ?,
         extra_completions_confirmed = ?, override_schema_version = ?, override_payload_json = ?,
         completed_at = ?, updated_at = ?, client_updated_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [...occurrenceColumns(document), context.now, context.now, ...syncWhere(mutation)],
    );
    return result.changes;
  }
}

/* ───────────────────────── Routine Action defaults ───────────────────────── */

export const routineActionDefaultsDocumentSchema = z.strictObject({
  routineId: uuid,
  generation: z.number().int().positive(),
  projectId: uuid.optional(),
  note: z.string().max(10_000).optional(),
  estimateMinutes: z.number().int().positive().max(10_080).optional(),
  energy: z.enum(energyLabels).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
});
export type RoutineActionDefaultsDocument = z.infer<typeof routineActionDefaultsDocumentSchema>;

/** Candidate defaults document from one `routine_action_defaults` row. */
export function decodeDefaultsRow(row: Readonly<Record<string, unknown>>): unknown {
  return {
    routineId: row['routine_id'],
    generation: row['generation'],
    ...optional('projectId', row['project_id']),
    ...optional('note', row['note_text']),
    ...optional('estimateMinutes', row['estimate_minutes']),
    ...optional('energy', row['energy']),
    ...optional('priority', row['priority']),
  };
}

function defaultsColumns(document: RoutineActionDefaultsDocument): SqliteParameter[] {
  return [
    document.routineId,
    document.generation,
    document.projectId ?? null,
    document.note ?? null,
    document.estimateMinutes ?? null,
    document.energy ?? null,
    document.priority ?? null,
  ];
}

class RoutineActionDefaultsCodec extends BaseCodec<RoutineActionDefaultsDocument> {
  readonly entityType = 'routine_action_defaults' as const;
  readonly table = 'routine_action_defaults';
  protected readonly schema = routineActionDefaultsDocumentSchema;

  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }

  protected decodeRow(row: Row) {
    return decodeDefaultsRow(row);
  }

  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: RoutineActionDefaultsDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO routine_action_defaults (
         id, owner_id, routine_id, generation, project_id, note_text, estimate_minutes, energy,
         priority, created_at, updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...defaultsColumns(document),
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
    document: RoutineActionDefaultsDocument,
  ) {
    const result = await connection.run(
      `UPDATE routine_action_defaults SET routine_id = ?, generation = ?, project_id = ?,
         note_text = ?, estimate_minutes = ?, energy = ?, priority = ?, updated_at = ?,
         client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [...defaultsColumns(document), context.now, context.now, ...syncWhere(mutation)],
    );
    return result.changes;
  }
}

const contractShape: readonly true[] = [
  true satisfies SameKeys<RoutineDocument, ContractRoutineDocument>,
  true satisfies SameKeys<RoutineOccurrenceDocument, ContractRoutineOccurrenceDocument>,
  true satisfies SameKeys<RoutineActionDefaultsDocument, ContractRoutineActionDefaultsDocument>,
];
void contractShape;

export const routineCanonicalCodec = new RoutineCodec();
export const routineOccurrenceCanonicalCodec = new RoutineOccurrenceCodec();
export const routineActionDefaultsCanonicalCodec = new RoutineActionDefaultsCodec();

export const routineCanonicalCodecs: readonly CanonicalRecordCodec[] = [
  routineCanonicalCodec,
  routineOccurrenceCanonicalCodec,
  routineActionDefaultsCanonicalCodec,
];
