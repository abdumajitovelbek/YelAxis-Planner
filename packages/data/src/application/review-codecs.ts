import type {
  ReviewDocument as ContractReviewDocument,
  ReviewItemDocument as ContractReviewItemDocument,
  ReviewListKey as ContractReviewListKey,
} from '@yelaxis/application';
import {
  energyLabels,
  parseReviewPeriodKey,
  reviewDecisionKinds,
  reviewLimits,
  type CommandContext,
  type EntityRef,
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
  type Row,
  type SameKeys,
  type UpdateMutation,
} from './base-codec';
import type { CanonicalRecordCodec } from './canonical-codecs';
import { DataAdapterError } from './errors';
import { decodeJson, encodeJson } from './json-codec';

/*
 * Review records: `review_checkpoints` (entity `review`) and `review_items`
 * (entity `review_item`). Text caps live here and on command input, never in SQL triggers;
 * longer text is refused, never truncated.
 */

/* ───────────────────────── Review ───────────────────────── */

/** The period is exactly the one its key names; a weekly one keeps the weekday it starts on. */
function reviewPeriodMatches(value: {
  readonly reviewType: string;
  readonly periodKey: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly weekStart?: string | undefined;
}): boolean {
  const period = parseReviewPeriodKey(value.reviewType, value.periodKey);
  return (
    period.ok &&
    period.value.start === value.periodStart &&
    period.value.end === value.periodEnd &&
    period.value.weekStart === value.weekStart
  );
}

/**
 * The ordered lists a review can clear on purpose, in their stored order: End Day's
 * next-day focus (daily), and the planning Week's commitments and first-day focus (weekly).
 */
const reviewListKey = z.enum(['commitments', 'first_day_focus', 'next_focus']);
type ReviewListKey = z.infer<typeof reviewListKey>;

/** The lists each review type may clear. */
const clearableLists: Readonly<Record<ContractReviewDocument['reviewType'], readonly string[]>> = {
  daily: ['next_focus'],
  weekly: ['commitments', 'first_day_focus'],
  monthly: [],
  yearly: [],
};

/** Non-empty and strictly increasing, so each list appears once and in the stored order. */
const clearedListsSchema = z
  .array(reviewListKey)
  .min(1)
  .refine((lists) => lists.every((list, index) => index === 0 || (lists[index - 1] ?? '') < list));

export const reviewDocumentSchema = z
  .strictObject({
    profileId: uuid,
    reviewType: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    periodKey: z.string(),
    periodStart: calendarDate,
    periodEnd: calendarDate,
    weekStart: weekday.optional(),
    notes: boundedText(reviewLimits.notes).optional(),
    energy: z.enum(energyLabels).optional(),
    themeText: boundedText(reviewLimits.themeText).optional(),
    directionChoice: z.enum(['continue', 'new', 'outdated']).optional(),
    directionText: boundedText(reviewLimits.directionText).optional(),
    clearedLists: clearedListsSchema.optional(),
    state: z.enum(['draft', 'skipped', 'completed', 'archived']),
    stateBeforeArchive: z.enum(['draft', 'skipped', 'completed']).optional(),
    completedAt: instant.optional(),
    archivedAt: instant.optional(),
  })
  .refine(archiveMetadataConsistent)
  .refine(reviewPeriodMatches)
  .refine((value) => value.energy === undefined || value.reviewType === 'daily')
  .refine((value) => value.themeText === undefined || value.reviewType === 'monthly')
  .refine((value) => value.directionChoice === undefined || value.reviewType === 'yearly')
  .refine((value) => (value.directionText !== undefined) === (value.directionChoice === 'new'))
  .refine(
    (value) =>
      value.clearedLists === undefined ||
      value.clearedLists.every((list) => clearableLists[value.reviewType].includes(list)),
  )
  // A completed review records when; a draft or skipped one has not been completed. An archived
  // review keeps whatever it had (Undo of a Finish that created the review archives it).
  .refine((value) =>
    value.state === 'completed'
      ? value.completedAt !== undefined
      : value.state === 'archived' || value.completedAt === undefined,
  );
export type ReviewDocument = z.infer<typeof reviewDocumentSchema>;

/**
 * `cleared_lists_json` (migration 13): the JSON array of cleared list keys, or NULL when no list was
 * cleared. The document schema validates what is read; text that is not JSON is refused here.
 */
function decodeClearedLists(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new DataAdapterError('invalid_persisted_record');
  return decodeJson(value);
}

function reviewColumns(document: ReviewDocument): SqliteParameter[] {
  return [
    document.profileId,
    document.reviewType,
    document.periodKey,
    document.periodStart,
    document.periodEnd,
    document.weekStart ?? null,
    document.notes ?? null,
    document.energy ?? null,
    document.themeText ?? null,
    document.directionChoice ?? null,
    document.directionText ?? null,
    document.clearedLists === undefined ? null : encodeJson(document.clearedLists),
    document.state,
    document.stateBeforeArchive ?? null,
    document.completedAt ?? null,
    document.archivedAt ?? null,
  ];
}

class ReviewCodec extends BaseCodec<ReviewDocument> {
  readonly entityType = 'review' as const;
  readonly table = 'review_checkpoints';
  protected readonly schema = reviewDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      profileId: row['profile_id'],
      reviewType: row['review_type'],
      periodKey: row['period_key'],
      periodStart: row['period_start_date'],
      periodEnd: row['period_end_date'],
      ...optional('weekStart', row['week_start']),
      ...optional('notes', row['notes']),
      ...optional('energy', row['energy']),
      ...optional('themeText', row['theme_text']),
      ...optional('directionChoice', row['direction_choice']),
      ...optional('directionText', row['direction_text']),
      ...optional('clearedLists', decodeClearedLists(row['cleared_lists_json'])),
      state: row['state'],
      ...optional('stateBeforeArchive', row['state_before_archive']),
      ...optional('completedAt', row['completed_at']),
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: ReviewDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO review_checkpoints (
         id, owner_id, profile_id, review_type, period_key, period_start_date, period_end_date,
         week_start, notes, energy, theme_text, direction_choice, direction_text,
         cleared_lists_json, state, state_before_archive, completed_at, archived_at, created_at,
         updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...reviewColumns(document),
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
    document: ReviewDocument,
  ) {
    const result = await connection.run(
      `UPDATE review_checkpoints SET profile_id = ?, review_type = ?, period_key = ?,
         period_start_date = ?, period_end_date = ?, week_start = ?, notes = ?, energy = ?,
         theme_text = ?, direction_choice = ?, direction_text = ?, cleared_lists_json = ?,
         state = ?, state_before_archive = ?, completed_at = ?, archived_at = ?, updated_at = ?,
         client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [...reviewColumns(document), context.now, context.now, ...syncWhere(mutation)],
    );
    return result.changes;
  }
}

/* ───────────────────────── Review item ───────────────────────── */

/** Stored `target_kind` values: the Review kinds plus the legacy Routine and Commitment kinds. */
export const reviewItemTargetKinds = [
  'axis',
  'outcome',
  'milestone',
  'project',
  'action',
  'routine_occurrence',
  'routine',
  'commitment',
] as const;

const occurrencePeriodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('date'), date: calendarDate }),
  z.strictObject({
    kind: z.literal('week'),
    start: calendarDate,
    end: calendarDate,
    weekStart: weekday,
    targetCount: z.number().int().positive(),
  }),
]);

/** A `move` decision's Day, Week, or Month, named by any date inside it (End Day). */
const movePeriodSchema = z.strictObject({
  kind: z.enum(['day', 'week', 'month']),
  date: calendarDate,
});

const reviewItemTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('axis'), axisId: uuid }),
  z.strictObject({ kind: z.literal('outcome'), outcomeId: uuid }),
  z.strictObject({ kind: z.literal('milestone'), milestoneId: uuid }),
  z.strictObject({ kind: z.literal('project'), projectId: uuid }),
  z.strictObject({ kind: z.literal('action'), actionId: uuid }),
  z.strictObject({
    kind: z.literal('routine_occurrence'),
    routineId: uuid,
    generation: z.number().int().positive(),
    period: occurrencePeriodSchema,
  }),
  z.strictObject({ kind: z.literal('routine'), routineId: uuid }),
  z.strictObject({ kind: z.literal('commitment'), commitmentId: uuid }),
  z.strictObject({
    kind: z.literal('deleted'),
    deletedKind: z.enum(reviewItemTargetKinds),
    deletedAt: instant,
  }),
]);

export const reviewItemDocumentSchema = z
  .strictObject({
    reviewId: uuid,
    target: reviewItemTargetSchema,
    decision: z.enum(reviewDecisionKinds),
    period: movePeriodSchema.optional(),
    note: boundedText(reviewLimits.itemNote).optional(),
    orderKey: nonBlank,
    archivedAt: instant.optional(),
  })
  .refine(
    ({ target }) =>
      target.kind !== 'routine_occurrence' ||
      target.period.kind === 'date' ||
      target.period.start <= target.period.end,
  )
  .refine((value) => (value.period !== undefined) === (value.decision === 'move'))
  .refine((value) => (value.note !== undefined) === (value.decision === 'note'));
export type ReviewItemDocument = z.infer<typeof reviewItemDocumentSchema>;
type ReviewItemTarget = ReviewItemDocument['target'];

/**
 * Version 1 of `review_items.detail_json`: the move period and, for a Routine Occurrence target,
 * the occurrence's generation and logical period (so a draft never materializes an occurrence).
 * Both keys share one object when both apply; a row with neither stores NULL. Unknown versions
 * and keys are refused.
 */
const reviewItemDetailSchema = z
  .strictObject({
    v: z.literal(1),
    occurrence: z
      .strictObject({ generation: z.number().int().positive(), period: occurrencePeriodSchema })
      .optional(),
    period: movePeriodSchema.optional(),
  })
  .refine((value) => value.occurrence !== undefined || value.period !== undefined);
type ReviewItemDetail = z.infer<typeof reviewItemDetailSchema>;

const targetIdColumns = [
  'axis_id',
  'outcome_id',
  'milestone_id',
  'project_id',
  'action_id',
  'routine_id',
  'commitment_id',
] as const;
type TargetIdColumn = (typeof targetIdColumns)[number];

function referencedColumn(target: ReviewItemTarget): readonly [TargetIdColumn, string] | null {
  switch (target.kind) {
    case 'axis':
      return ['axis_id', target.axisId];
    case 'outcome':
      return ['outcome_id', target.outcomeId];
    case 'milestone':
      return ['milestone_id', target.milestoneId];
    case 'project':
      return ['project_id', target.projectId];
    case 'action':
      return ['action_id', target.actionId];
    case 'routine_occurrence':
    case 'routine':
      return ['routine_id', target.routineId];
    case 'commitment':
      return ['commitment_id', target.commitmentId];
    case 'deleted':
      return null;
  }
}

/** `target_kind`, the seven target id columns, and `target_deleted_at`. */
function targetColumns(target: ReviewItemTarget): SqliteParameter[] {
  const reference = referencedColumn(target);
  return [
    target.kind === 'deleted' ? target.deletedKind : target.kind,
    ...targetIdColumns.map((column) => (reference?.[0] === column ? reference[1] : null)),
    target.kind === 'deleted' ? target.deletedAt : null,
  ];
}

type OccurrencePeriod = z.infer<typeof occurrencePeriodSchema>;

/** Canonical key order, whatever order the document arrived in. */
function occurrencePeriodJson(period: OccurrencePeriod): OccurrencePeriod {
  return period.kind === 'date'
    ? { kind: 'date', date: period.date }
    : {
        kind: 'week',
        start: period.start,
        end: period.end,
        weekStart: period.weekStart,
        targetCount: period.targetCount,
      };
}

function encodeDetail(document: ReviewItemDocument): string | null {
  const { target, period } = document;
  if (target.kind !== 'routine_occurrence' && period === undefined) return null;
  return encodeJson({
    v: 1,
    ...(target.kind === 'routine_occurrence'
      ? {
          occurrence: {
            generation: target.generation,
            period: occurrencePeriodJson(target.period),
          },
        }
      : {}),
    ...(period === undefined ? {} : { period: { kind: period.kind, date: period.date } }),
  });
}

function decodeDetail(value: unknown): ReviewItemDetail | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new DataAdapterError('invalid_persisted_record');
  const parsed = reviewItemDetailSchema.safeParse(decodeJson(value));
  if (!parsed.success) throw new DataAdapterError('invalid_persisted_record');
  return parsed.data;
}

/** Candidate target of a row whose reference is present. */
function decodeTarget(row: Row, occurrence: ReviewItemDetail['occurrence']): unknown {
  const kind = row['target_kind'];
  switch (kind) {
    case 'axis':
      return { kind, axisId: row['axis_id'] };
    case 'outcome':
      return { kind, outcomeId: row['outcome_id'] };
    case 'milestone':
      return { kind, milestoneId: row['milestone_id'] };
    case 'project':
      return { kind, projectId: row['project_id'] };
    case 'action':
      return { kind, actionId: row['action_id'] };
    case 'routine_occurrence':
      if (occurrence === undefined) throw new DataAdapterError('invalid_persisted_record');
      return {
        kind,
        routineId: row['routine_id'],
        generation: occurrence.generation,
        period: occurrence.period,
      };
    case 'routine':
      return { kind, routineId: row['routine_id'] };
    case 'commitment':
      return { kind, commitmentId: row['commitment_id'] };
    default:
      throw new DataAdapterError('invalid_persisted_record');
  }
}

function itemColumns(document: ReviewItemDocument): SqliteParameter[] {
  return [
    document.reviewId,
    ...targetColumns(document.target),
    document.decision,
    encodeDetail(document),
    document.note ?? null,
    document.orderKey,
    document.archivedAt ?? null,
  ];
}

class ReviewItemCodec extends BaseCodec<ReviewItemDocument> {
  readonly entityType = 'review_item' as const;
  readonly table = 'review_items';
  protected readonly schema = reviewItemDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    const detail = decodeDetail(row['detail_json']);
    const deletedAt = row['target_deleted_at'];
    const cleared = deletedAt !== null && deletedAt !== undefined;
    // Only a present Routine Occurrence target stores its occurrence identity.
    if (
      (detail?.occurrence !== undefined) !==
      (!cleared && row['target_kind'] === 'routine_occurrence')
    ) {
      throw new DataAdapterError('invalid_persisted_record');
    }
    return {
      reviewId: row['review_id'],
      target: cleared
        ? { kind: 'deleted', deletedKind: row['target_kind'], deletedAt }
        : decodeTarget(row, detail?.occurrence),
      decision: row['decision'],
      ...optional('period', detail?.period),
      ...optional('note', row['decision_note']),
      orderKey: row['sort_key'],
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: ReviewItemDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO review_items (
         id, owner_id, review_id, target_kind, axis_id, outcome_id, milestone_id, project_id,
         action_id, routine_id, commitment_id, target_deleted_at, decision, detail_json,
         decision_note, sort_key, archived_at, created_at, updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...itemColumns(document),
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
    document: ReviewItemDocument,
  ) {
    const result = await connection.run(
      `UPDATE review_items SET review_id = ?, target_kind = ?, axis_id = ?, outcome_id = ?,
         milestone_id = ?, project_id = ?, action_id = ?, routine_id = ?, commitment_id = ?,
         target_deleted_at = ?, decision = ?, detail_json = ?, decision_note = ?, sort_key = ?,
         archived_at = ?, updated_at = ?, client_updated_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [...itemColumns(document), context.now, context.now, ...syncWhere(mutation)],
    );
    return result.changes;
  }
}

/** Compile-time guard: two unions of string literals have exactly the same members. */
type SameMembers<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : never
  : never;

const contractShape: readonly true[] = [
  true satisfies SameKeys<ReviewDocument, ContractReviewDocument>,
  true satisfies SameKeys<ReviewItemDocument, ContractReviewItemDocument>,
  true satisfies SameMembers<ReviewListKey, ContractReviewListKey>,
];
void contractShape;

export const reviewCanonicalCodec = new ReviewCodec();
export const reviewItemCanonicalCodec = new ReviewItemCodec();

export const reviewCanonicalCodecs: readonly CanonicalRecordCodec[] = [
  reviewCanonicalCodec,
  reviewItemCanonicalCodec,
];
