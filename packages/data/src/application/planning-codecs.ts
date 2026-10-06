import type {
  CommitmentDocument as ContractCommitmentDocument,
  FocusSelectionDocument as ContractFocusSelectionDocument,
  MonthThemeDocument as ContractMonthThemeDocument,
  NoteDocument as ContractNoteDocument,
  PlanningPlacementDocument as ContractPlacementDocument,
  ProjectDocument as ContractProjectDocument,
  TemplateDocument as ContractTemplateDocument,
  TimeBlockDocument as ContractTimeBlockDocument,
  YearDirectionDocument as ContractYearDirectionDocument,
} from '@yelaxis/application';
import {
  parseTemplateBlueprint,
  type CommandContext,
  type EntityRef,
  type TemplateBlueprint,
} from '@yelaxis/domain';
import { z } from 'zod';

import type { SqliteParameter, SqliteQueryConnection } from '../sqlite/driver';
import {
  archiveMetadataConsistent,
  assertCreatable,
  BaseCodec,
  boundedText,
  calendarDate,
  ianaTimeZone,
  instant,
  monthKey,
  nonBlank,
  optional,
  permanentlyDelete,
  selectById,
  syncWhere,
  targetWindowOrdered,
  uuid,
  weekday,
  yearKey,
  type CreateMutation,
  type DeleteMutation,
  type Row,
  type SameKeys,
  type UpdateMutation,
} from './base-codec';
import type { CanonicalRecordCodec } from './canonical-codecs';
import { DataAdapterError } from './errors';
import { decodeJson, encodeJson } from './json-codec';

const date = calendarDate;

export const horizonPeriodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('day'), date }),
  z.strictObject({ kind: z.literal('week'), start: date, end: date, weekStart: weekday }),
  z.strictObject({ kind: z.literal('month'), month: monthKey }),
  z.strictObject({ kind: z.literal('year'), year: yearKey }),
]);

/* ───────────────────────── Schemas ───────────────────────── */

export const planningPlacementDocumentSchema = z.strictObject({
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('outcome'), outcomeId: uuid }),
    z.strictObject({ kind: z.literal('project'), projectId: uuid }),
    z.strictObject({ kind: z.literal('milestone'), milestoneId: uuid }),
    z.strictObject({ kind: z.literal('action'), actionId: uuid }),
  ]),
  period: horizonPeriodSchema,
  orderKey: nonBlank,
  archivedAt: instant.optional(),
});
export type PlanningPlacementDocument = z.infer<typeof planningPlacementDocumentSchema>;

export const timeBlockDocumentSchema = z
  .strictObject({
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('action'), actionId: uuid }),
      z.strictObject({ kind: z.literal('commitment'), commitmentId: uuid }),
      z.strictObject({ kind: z.literal('routine_occurrence'), routineOccurrenceId: uuid }),
      z.strictObject({ kind: z.literal('custom'), title: boundedText(200) }),
    ]),
    startsAt: instant,
    endsAt: instant,
    timeZone: ianaTimeZone,
    state: z.enum(['planned', 'completed', 'skipped', 'canceled']),
    supersededById: uuid.optional(),
    overlapAcknowledged: z.boolean(),
  })
  .refine((value) => Date.parse(value.startsAt) < Date.parse(value.endsAt))
  .refine((value) => value.supersededById === undefined || value.state === 'canceled');
export type TimeBlockDocument = z.infer<typeof timeBlockDocumentSchema>;

const reminderSchedule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('at'), remindAt: instant, timeZone: nonBlank }),
  z.strictObject({
    kind: z.literal('relative'),
    remindAt: instant,
    offsetMinutes: z.number().int().min(-10_080).max(10_080),
    timeZone: nonBlank,
  }),
]);
const reminderState = z.enum(['scheduled', 'delivered', 'canceled']);

/**
 * A reminder targets exactly one Action, Time Block, Routine, or review, named by one id field;
 * a document with no target, two targets, or any other field
 * is refused.
 */
export const reminderDocumentSchema = z.union([
  z.strictObject({ actionId: uuid, schedule: reminderSchedule, state: reminderState }),
  z.strictObject({ timeBlockId: uuid, schedule: reminderSchedule, state: reminderState }),
  z.strictObject({ routineId: uuid, schedule: reminderSchedule, state: reminderState }),
  z.strictObject({ reviewId: uuid, schedule: reminderSchedule, state: reminderState }),
]);
export type ReminderDocument = z.infer<typeof reminderDocumentSchema>;

/** The four target columns of a reminder document, exactly one of them set. */
function reminderTargetColumns(document: ReminderDocument): SqliteParameter[] {
  return [
    'actionId' in document ? document.actionId : null,
    'timeBlockId' in document ? document.timeBlockId : null,
    'routineId' in document ? document.routineId : null,
    'reviewId' in document ? document.reviewId : null,
  ];
}

export const noteDocumentSchema = z
  .strictObject({
    title: z.string().optional(),
    body: z.string().optional(),
    axisId: uuid.optional(),
    projectId: uuid.optional(),
    orderKey: nonBlank,
    state: z.enum(['active', 'archived']),
    stateBeforeArchive: z.literal('active').optional(),
    archivedAt: instant.optional(),
  })
  .refine((value) => (value.title?.trim().length ?? 0) > 0 || (value.body?.trim().length ?? 0) > 0)
  .refine(archiveMetadataConsistent);
export type NoteDocument = z.infer<typeof noteDocumentSchema>;

export const commitmentDocumentSchema = z
  .strictObject({
    title: boundedText(200),
    strength: z.enum(['hard', 'soft']),
    state: z.enum(['planned', 'completed', 'canceled', 'archived']),
    stateBeforeArchive: z.enum(['planned', 'completed', 'canceled']).optional(),
    archivedAt: instant.optional(),
  })
  .refine(archiveMetadataConsistent);
export type CommitmentDocument = z.infer<typeof commitmentDocumentSchema>;

export const projectDocumentSchema = z
  .strictObject({
    title: nonBlank,
    description: z.string().optional(),
    desiredResult: nonBlank.optional(),
    notes: z.string().optional(),
    axisId: uuid.optional(),
    primaryOutcomeId: uuid.optional(),
    targetStart: calendarDate.optional(),
    targetEnd: calendarDate.optional(),
    orderKey: nonBlank,
    state: z.enum(['idea', 'active', 'blocked', 'paused', 'completed', 'archived']),
    stateBeforeArchive: z.enum(['idea', 'active', 'blocked', 'paused', 'completed']).optional(),
    archivedAt: instant.optional(),
  })
  .refine(archiveMetadataConsistent)
  .refine(targetWindowOrdered)
  .refine(
    (value) =>
      value.state === 'idea' ||
      (value.state === 'archived' && value.stateBeforeArchive === 'idea') ||
      value.desiredResult !== undefined,
  );
export type ProjectDocument = z.infer<typeof projectDocumentSchema>;

/**
 * `week_commitment` rows live in `week_selections` (Action, Project, or Milestone); `day_focus`
 * rows live in `focus_selections` (Action or Routine Occurrence) for exactly one local date.
 */
export const focusSelectionDocumentSchema = z
  .strictObject({
    kind: z.enum(['day_focus', 'week_commitment']),
    profileId: uuid,
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('action'), actionId: uuid }),
      z.strictObject({ kind: z.literal('project'), projectId: uuid }),
      z.strictObject({ kind: z.literal('milestone'), milestoneId: uuid }),
      z.strictObject({ kind: z.literal('routine_occurrence'), routineOccurrenceId: uuid }),
    ]),
    periodStart: date,
    periodEnd: date,
    weekStart: weekday.optional(),
    orderKey: nonBlank,
    archivedAt: instant.optional(),
  })
  .refine((value) =>
    value.kind === 'day_focus'
      ? (value.target.kind === 'action' || value.target.kind === 'routine_occurrence') &&
        value.periodStart === value.periodEnd &&
        value.weekStart === undefined
      : value.target.kind !== 'routine_occurrence' &&
        value.weekStart !== undefined &&
        value.periodStart <= value.periodEnd,
  );
export type FocusSelectionDocument = z.infer<typeof focusSelectionDocumentSchema>;

export const monthThemeDocumentSchema = z.strictObject({
  profileId: uuid,
  month: monthKey,
  text: boundedText(2_000),
  archivedAt: instant.optional(),
});
export type MonthThemeDocument = z.infer<typeof monthThemeDocumentSchema>;

export const yearDirectionDocumentSchema = z.strictObject({
  profileId: uuid,
  year: yearKey,
  text: boundedText(2_000),
  archivedAt: instant.optional(),
});
export type YearDirectionDocument = z.infer<typeof yearDirectionDocumentSchema>;

/** Blueprint version 1 or 2, validated and normalized by the domain parser. */
const templateBlueprint = z
  .custom<TemplateBlueprint>((value) => parseTemplateBlueprint(value).ok)
  .transform((value) => {
    const parsed = parseTemplateBlueprint(value);
    if (!parsed.ok) throw new DataAdapterError('invalid_canonical_document');
    return parsed.value;
  });

export const templateDocumentSchema = z
  .strictObject({
    title: boundedText(200),
    blueprint: templateBlueprint,
    state: z.enum(['active', 'archived']),
    stateBeforeArchive: z.literal('active').optional(),
    archivedAt: instant.optional(),
  })
  .refine(archiveMetadataConsistent);
export type TemplateDocument = z.infer<typeof templateDocumentSchema>;

const contractShape: readonly true[] = [
  true satisfies SameKeys<PlanningPlacementDocument, ContractPlacementDocument>,
  true satisfies SameKeys<TimeBlockDocument, ContractTimeBlockDocument>,
  true satisfies SameKeys<NoteDocument, ContractNoteDocument>,
  true satisfies SameKeys<CommitmentDocument, ContractCommitmentDocument>,
  true satisfies SameKeys<ProjectDocument, ContractProjectDocument>,
  true satisfies SameKeys<FocusSelectionDocument, ContractFocusSelectionDocument>,
  true satisfies SameKeys<MonthThemeDocument, ContractMonthThemeDocument>,
  true satisfies SameKeys<YearDirectionDocument, ContractYearDirectionDocument>,
  true satisfies SameKeys<TemplateDocument, ContractTemplateDocument>,
];
void contractShape;

/* ───────────────────────── Placement ───────────────────────── */

export function encodePeriod(value: PlanningPlacementDocument['period']): SqliteParameter[] {
  if (value.kind === 'day') return ['day', value.date, value.date, value.date, null];
  if (value.kind === 'week') return ['week', value.start, value.start, value.end, value.weekStart];
  if (value.kind === 'month') {
    const [year, month] = value.month.split('-').map(Number);
    const end = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
    return [
      'month',
      value.month,
      `${value.month}-01`,
      `${value.month}-${String(end).padStart(2, '0')}`,
      null,
    ];
  }
  return ['year', value.year, `${value.year}-01-01`, `${value.year}-12-31`, null];
}

/** Candidate period from placement columns (`horizon`, `period_key`, dates, `week_start`). */
export function decodePeriodColumns(columns: {
  readonly horizon: unknown;
  readonly periodKey: unknown;
  readonly start: unknown;
  readonly end: unknown;
  readonly weekStart: unknown;
}): unknown {
  switch (columns.horizon) {
    case 'day':
      return { kind: 'day', date: columns.start };
    case 'week':
      return { kind: 'week', start: columns.start, end: columns.end, weekStart: columns.weekStart };
    case 'month':
      return { kind: 'month', month: columns.periodKey };
    case 'year':
      return { kind: 'year', year: columns.periodKey };
    default:
      throw new DataAdapterError('invalid_persisted_record');
  }
}

function placementTargetColumns(target: PlanningPlacementDocument['target']): SqliteParameter[] {
  return [
    target.kind === 'outcome' ? target.outcomeId : null,
    target.kind === 'project' ? target.projectId : null,
    target.kind === 'milestone' ? target.milestoneId : null,
    target.kind === 'action' ? target.actionId : null,
  ];
}

class PlacementCodec extends BaseCodec<PlanningPlacementDocument> {
  readonly entityType = 'planning_placement' as const;
  readonly table = 'planning_placements';
  protected readonly schema = planningPlacementDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    const target =
      row['outcome_id'] !== null
        ? { kind: 'outcome', outcomeId: row['outcome_id'] }
        : row['project_id'] !== null
          ? { kind: 'project', projectId: row['project_id'] }
          : row['milestone_id'] !== null
            ? { kind: 'milestone', milestoneId: row['milestone_id'] }
            : { kind: 'action', actionId: row['action_id'] };
    return {
      target,
      period: decodePeriodColumns({
        horizon: row['horizon'],
        periodKey: row['period_key'],
        start: row['period_start_date'],
        end: row['period_end_date'],
        weekStart: row['week_start'],
      }),
      orderKey: row['sort_key'],
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: PlanningPlacementDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO planning_placements (
         id, owner_id, outcome_id, project_id, milestone_id, action_id, horizon, period_key,
         period_start_date, period_end_date, week_start, sort_key, archived_at, created_at,
         updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...placementTargetColumns(document.target),
        ...encodePeriod(document.period),
        document.orderKey,
        document.archivedAt ?? null,
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
    document: PlanningPlacementDocument,
  ) {
    const result = await connection.run(
      `UPDATE planning_placements SET outcome_id = ?, project_id = ?, milestone_id = ?,
         action_id = ?, horizon = ?, period_key = ?, period_start_date = ?, period_end_date = ?,
         week_start = ?, sort_key = ?, archived_at = ?, updated_at = ?, client_updated_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        ...placementTargetColumns(document.target),
        ...encodePeriod(document.period),
        document.orderKey,
        document.archivedAt ?? null,
        context.now,
        context.now,
        ...syncWhere(mutation),
      ],
    );
    return result.changes;
  }
}

/* ───────────────────────── Time Block ───────────────────────── */

function timeBlockTargetColumns(target: TimeBlockDocument['target']): SqliteParameter[] {
  return [
    target.kind === 'action' ? target.actionId : null,
    target.kind === 'routine_occurrence' ? target.routineOccurrenceId : null,
    target.kind === 'commitment' ? target.commitmentId : null,
    target.kind === 'custom' ? target.title : null,
  ];
}

export function decodeTimeBlockTargetColumns(row: Readonly<Record<string, unknown>>): unknown {
  if (row['action_id'] !== null) return { kind: 'action', actionId: row['action_id'] };
  if (row['routine_occurrence_id'] !== null) {
    return { kind: 'routine_occurrence', routineOccurrenceId: row['routine_occurrence_id'] };
  }
  if (row['commitment_id'] !== null) {
    return { kind: 'commitment', commitmentId: row['commitment_id'] };
  }
  return { kind: 'custom', title: row['custom_title'] };
}

class TimeBlockCodec extends BaseCodec<TimeBlockDocument> {
  readonly entityType = 'time_block' as const;
  readonly table = 'time_blocks';
  protected readonly schema = timeBlockDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      target: decodeTimeBlockTargetColumns(row),
      startsAt: row['starts_at_utc'],
      endsAt: row['ends_at_utc'],
      timeZone: row['time_zone'],
      state: row['state'],
      ...optional('supersededById', row['superseded_by_id']),
      overlapAcknowledged: row['overlap_confirmed'] === 1,
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: TimeBlockDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO time_blocks (
         id, owner_id, action_id, routine_occurrence_id, commitment_id, custom_title,
         starts_at_utc, ends_at_utc, time_zone, state, superseded_by_id, overlap_confirmed,
         created_at, updated_at, client_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...timeBlockTargetColumns(document.target),
        document.startsAt,
        document.endsAt,
        document.timeZone,
        document.state,
        document.supersededById ?? null,
        document.overlapAcknowledged ? 1 : 0,
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
    document: TimeBlockDocument,
  ) {
    const result = await connection.run(
      `UPDATE time_blocks SET action_id = ?, routine_occurrence_id = ?, commitment_id = ?,
         custom_title = ?, starts_at_utc = ?, ends_at_utc = ?, time_zone = ?, state = ?,
         superseded_by_id = ?, overlap_confirmed = ?, updated_at = ?, client_updated_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        ...timeBlockTargetColumns(document.target),
        document.startsAt,
        document.endsAt,
        document.timeZone,
        document.state,
        document.supersededById ?? null,
        document.overlapAcknowledged ? 1 : 0,
        context.now,
        context.now,
        ...syncWhere(mutation),
      ],
    );
    return result.changes;
  }
}

/* ───────────────────────── Reminder ───────────────────────── */

class ReminderCodec extends BaseCodec<ReminderDocument> {
  readonly entityType = 'reminder' as const;
  readonly table = 'reminders';
  protected readonly schema = reminderDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      ...optional('actionId', row['action_id']),
      ...optional('timeBlockId', row['time_block_id']),
      ...optional('routineId', row['routine_id']),
      ...optional('reviewId', row['review_id']),
      schedule:
        row['schedule_kind'] === 'at'
          ? { kind: 'at', remindAt: row['remind_at_utc'], timeZone: row['time_zone'] }
          : {
              kind: 'relative',
              remindAt: row['remind_at_utc'],
              offsetMinutes: row['offset_minutes'],
              timeZone: row['time_zone'],
            },
      state: row['state'],
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: ReminderDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO reminders (id, owner_id, action_id, time_block_id, routine_id, review_id,
         schedule_kind, remind_at_utc, offset_minutes, time_zone, state, created_at, updated_at,
         client_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        ...reminderTargetColumns(document),
        document.schedule.kind,
        document.schedule.remindAt,
        document.schedule.kind === 'relative' ? document.schedule.offsetMinutes : null,
        document.schedule.timeZone,
        document.state,
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
    document: ReminderDocument,
  ) {
    // A Time Block reminder may follow a superseding block, so its target column can change.
    const result = await connection.run(
      `UPDATE reminders SET action_id = ?, time_block_id = ?, routine_id = ?, review_id = ?,
         schedule_kind = ?, remind_at_utc = ?, offset_minutes = ?, time_zone = ?, state = ?,
         updated_at = ?, client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        ...reminderTargetColumns(document),
        document.schedule.kind,
        document.schedule.remindAt,
        document.schedule.kind === 'relative' ? document.schedule.offsetMinutes : null,
        document.schedule.timeZone,
        document.state,
        context.now,
        context.now,
        ...syncWhere(mutation),
      ],
    );
    return result.changes;
  }
}

/* ───────────────────────── Note ───────────────────────── */

class NoteCodec extends BaseCodec<NoteDocument> {
  readonly entityType = 'note' as const;
  readonly table = 'notes';
  protected readonly schema = noteDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      ...optional('title', row['title']),
      ...optional('body', row['body']),
      ...optional('axisId', row['axis_id']),
      ...optional('projectId', row['project_id']),
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
    document: NoteDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO notes (id, owner_id, axis_id, project_id, title, body, state,
         state_before_archive, sort_key, archived_at, created_at, updated_at, client_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        document.axisId ?? null,
        document.projectId ?? null,
        document.title ?? null,
        document.body ?? null,
        document.state,
        document.stateBeforeArchive ?? null,
        document.orderKey,
        document.archivedAt ?? null,
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
    document: NoteDocument,
  ) {
    const result = await connection.run(
      `UPDATE notes SET axis_id = ?, project_id = ?, title = ?, body = ?, state = ?,
         state_before_archive = ?, sort_key = ?, archived_at = ?, updated_at = ?,
         client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        document.axisId ?? null,
        document.projectId ?? null,
        document.title ?? null,
        document.body ?? null,
        document.state,
        document.stateBeforeArchive ?? null,
        document.orderKey,
        document.archivedAt ?? null,
        context.now,
        context.now,
        ...syncWhere(mutation),
      ],
    );
    return result.changes;
  }
}

/* ───────────────────────── Project ───────────────────────── */

class ProjectCodec extends BaseCodec<ProjectDocument> {
  readonly entityType = 'project' as const;
  readonly table = 'projects';
  protected readonly schema = projectDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      title: row['title'],
      ...optional('description', row['description']),
      ...optional('desiredResult', row['desired_result']),
      ...optional('notes', row['notes']),
      ...optional('axisId', row['axis_id']),
      ...optional('primaryOutcomeId', row['primary_outcome_id']),
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
    document: ProjectDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO projects (id, owner_id, axis_id, primary_outcome_id, title, description,
         desired_result, notes, target_start_date, target_end_date, state, state_before_archive,
         sort_key, archived_at, created_at, updated_at, client_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        document.axisId ?? null,
        document.primaryOutcomeId ?? null,
        document.title,
        document.description ?? null,
        document.desiredResult ?? null,
        document.notes ?? null,
        document.targetStart ?? null,
        document.targetEnd ?? null,
        document.state,
        document.stateBeforeArchive ?? null,
        document.orderKey,
        document.archivedAt ?? null,
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
    document: ProjectDocument,
  ) {
    const result = await connection.run(
      `UPDATE projects SET axis_id = ?, primary_outcome_id = ?, title = ?, description = ?,
         desired_result = ?, notes = ?, target_start_date = ?, target_end_date = ?, state = ?,
         state_before_archive = ?, sort_key = ?, archived_at = ?, updated_at = ?,
         client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        document.axisId ?? null,
        document.primaryOutcomeId ?? null,
        document.title,
        document.description ?? null,
        document.desiredResult ?? null,
        document.notes ?? null,
        document.targetStart ?? null,
        document.targetEnd ?? null,
        document.state,
        document.stateBeforeArchive ?? null,
        document.orderKey,
        document.archivedAt ?? null,
        context.now,
        context.now,
        ...syncWhere(mutation),
      ],
    );
    return result.changes;
  }
}

/* ───────────────────────── Focus selection ───────────────────────── */

function focusTable(kind: FocusSelectionDocument['kind']) {
  return kind === 'day_focus' ? 'focus_selections' : 'week_selections';
}

function targetId(
  target: FocusSelectionDocument['target'],
  kind: FocusSelectionDocument['target']['kind'],
): string | null {
  switch (target.kind) {
    case 'action':
      return kind === 'action' ? target.actionId : null;
    case 'project':
      return kind === 'project' ? target.projectId : null;
    case 'milestone':
      return kind === 'milestone' ? target.milestoneId : null;
    case 'routine_occurrence':
      return kind === 'routine_occurrence' ? target.routineOccurrenceId : null;
  }
}

class FocusSelectionCodec extends BaseCodec<FocusSelectionDocument> {
  readonly entityType = 'focus_selection' as const;
  readonly table = 'focus_selections';
  protected readonly schema = focusSelectionDocumentSchema;
  async readDocument(connection: SqliteQueryConnection, ref: EntityRef): Promise<Row | undefined> {
    const day = await connection.get<Row>(
      `SELECT *, 'day_focus' AS selection_kind FROM focus_selections
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
      [ref.ownerId, ref.id],
    );
    if (day !== undefined) return day;
    return connection.get<Row>(
      `SELECT *, 'week_commitment' AS selection_kind FROM week_selections
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
      [ref.ownerId, ref.id],
    );
  }
  protected decodeRow(row: Row) {
    const kind = row['selection_kind'];
    const target =
      row['action_id'] !== null && row['action_id'] !== undefined
        ? { kind: 'action', actionId: row['action_id'] }
        : kind === 'day_focus'
          ? { kind: 'routine_occurrence', routineOccurrenceId: row['routine_occurrence_id'] }
          : row['project_id'] !== null
            ? { kind: 'project', projectId: row['project_id'] }
            : { kind: 'milestone', milestoneId: row['milestone_id'] };
    return {
      kind,
      profileId: row['profile_id'],
      target,
      periodStart: kind === 'day_focus' ? row['local_date'] : row['period_start_date'],
      periodEnd: kind === 'day_focus' ? row['local_date'] : row['period_end_date'],
      ...(kind === 'week_commitment' ? { weekStart: row['week_start'] } : {}),
      orderKey: row['sort_key'],
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: FocusSelectionDocument,
  ) {
    await assertCreatable(connection, mutation);
    const { target } = document;
    const result =
      document.kind === 'day_focus'
        ? await connection.run(
            `INSERT INTO focus_selections (
               id, owner_id, profile_id, action_id, routine_occurrence_id, local_date, sort_key,
               archived_at, created_at, updated_at, client_updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
              mutation.ref.id,
              mutation.ref.ownerId,
              document.profileId,
              targetId(target, 'action'),
              targetId(target, 'routine_occurrence'),
              document.periodStart,
              document.orderKey,
              document.archivedAt ?? null,
              context.now,
              context.now,
              context.now,
            ],
          )
        : await connection.run(
            `INSERT INTO week_selections (
               id, owner_id, profile_id, action_id, project_id, milestone_id, period_start_date,
               period_end_date, week_start, sort_key, archived_at, created_at, updated_at,
               client_updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
              mutation.ref.id,
              mutation.ref.ownerId,
              document.profileId,
              targetId(target, 'action'),
              targetId(target, 'project'),
              targetId(target, 'milestone'),
              document.periodStart,
              document.periodEnd,
              document.weekStart ?? null,
              document.orderKey,
              document.archivedAt ?? null,
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
    document: FocusSelectionDocument,
  ) {
    const { target } = document;
    const result =
      document.kind === 'day_focus'
        ? await connection.run(
            `UPDATE focus_selections SET profile_id = ?, action_id = ?, routine_occurrence_id = ?,
               local_date = ?, sort_key = ?, archived_at = ?, updated_at = ?,
               client_updated_at = ?, local_revision = local_revision + 1
             WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
               AND server_revision = ? AND base_snapshot_hash IS ?;`,
            [
              document.profileId,
              targetId(target, 'action'),
              targetId(target, 'routine_occurrence'),
              document.periodStart,
              document.orderKey,
              document.archivedAt ?? null,
              context.now,
              context.now,
              ...syncWhere(mutation),
            ],
          )
        : await connection.run(
            `UPDATE week_selections SET profile_id = ?, action_id = ?, project_id = ?,
               milestone_id = ?, period_start_date = ?, period_end_date = ?, week_start = ?,
               sort_key = ?, archived_at = ?, updated_at = ?, client_updated_at = ?,
               local_revision = local_revision + 1
             WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
               AND server_revision = ? AND base_snapshot_hash IS ?;`,
            [
              document.profileId,
              targetId(target, 'action'),
              targetId(target, 'project'),
              targetId(target, 'milestone'),
              document.periodStart,
              document.periodEnd,
              document.weekStart ?? null,
              document.orderKey,
              document.archivedAt ?? null,
              context.now,
              context.now,
              ...syncWhere(mutation),
            ],
          );
    return result.changes;
  }
  protected override async delete(
    connection: SqliteQueryConnection,
    mutation: DeleteMutation,
    context: CommandContext,
  ): Promise<number> {
    const current = await this.read(connection, mutation.ref);
    if (current === null) throw new DataAdapterError('write_conflict');
    const document = this.parse(current.document);
    return permanentlyDelete(connection, focusTable(document.kind), mutation, context);
  }
}

/* ───────────────────────── Commitment ───────────────────────── */

export class CommitmentCodec extends BaseCodec<CommitmentDocument> {
  readonly entityType = 'commitment' as const;
  readonly table = 'commitments';
  protected readonly schema = commitmentDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      title: row['title'],
      strength: row['strength'],
      state: row['state'],
      ...optional('stateBeforeArchive', row['state_before_archive']),
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: CommitmentDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO commitments (id, owner_id, title, strength, state, state_before_archive,
         archived_at, created_at, updated_at, client_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        document.title,
        document.strength,
        document.state,
        document.stateBeforeArchive ?? null,
        document.archivedAt ?? null,
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
    document: CommitmentDocument,
  ) {
    const result = await connection.run(
      `UPDATE commitments SET title = ?, strength = ?, state = ?, state_before_archive = ?,
         archived_at = ?, updated_at = ?, client_updated_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        document.title,
        document.strength,
        document.state,
        document.stateBeforeArchive ?? null,
        document.archivedAt ?? null,
        context.now,
        context.now,
        ...syncWhere(mutation),
      ],
    );
    return result.changes;
  }
}

/* ───────────────────────── Template ───────────────────────── */

export class TemplateCodec extends BaseCodec<TemplateDocument> {
  readonly entityType = 'template' as const;
  readonly table = 'templates';
  protected readonly schema = templateDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    if (row['template_schema_version'] !== 1 || typeof row['template_payload_json'] !== 'string') {
      throw new DataAdapterError('invalid_persisted_record');
    }
    const blueprint = parseTemplateBlueprint(decodeJson(row['template_payload_json']));
    if (!blueprint.ok) throw new DataAdapterError('invalid_persisted_record');
    return {
      title: row['title'],
      blueprint: blueprint.value,
      state: row['state'],
      ...optional('stateBeforeArchive', row['state_before_archive']),
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: TemplateDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO templates (id, owner_id, title, template_schema_version, template_payload_json,
         state, state_before_archive, archived_at, created_at, updated_at, client_updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        document.title,
        encodeJson(document.blueprint),
        document.state,
        document.stateBeforeArchive ?? null,
        document.archivedAt ?? null,
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
    document: TemplateDocument,
  ) {
    const result = await connection.run(
      `UPDATE templates SET title = ?, template_schema_version = 1, template_payload_json = ?,
         state = ?, state_before_archive = ?, archived_at = ?, updated_at = ?,
         client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        document.title,
        encodeJson(document.blueprint),
        document.state,
        document.stateBeforeArchive ?? null,
        document.archivedAt ?? null,
        context.now,
        context.now,
        ...syncWhere(mutation),
      ],
    );
    return result.changes;
  }
}

/* ───────────────────────── Month theme and year direction ───────────────────────── */

class MonthThemeCodec extends BaseCodec<MonthThemeDocument> {
  readonly entityType = 'theme' as const;
  readonly table = 'month_themes';
  protected readonly schema = monthThemeDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      profileId: row['profile_id'],
      month: row['period_key'],
      text: row['theme_text'],
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: MonthThemeDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO month_themes (id, owner_id, profile_id, period_key, theme_text, archived_at,
         created_at, updated_at, client_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        document.profileId,
        document.month,
        document.text,
        document.archivedAt ?? null,
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
    document: MonthThemeDocument,
  ) {
    const result = await connection.run(
      `UPDATE month_themes SET profile_id = ?, period_key = ?, theme_text = ?, archived_at = ?,
         updated_at = ?, client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        document.profileId,
        document.month,
        document.text,
        document.archivedAt ?? null,
        context.now,
        context.now,
        ...syncWhere(mutation),
      ],
    );
    return result.changes;
  }
}

class YearDirectionCodec extends BaseCodec<YearDirectionDocument> {
  readonly entityType = 'direction' as const;
  readonly table = 'year_directions';
  protected readonly schema = yearDirectionDocumentSchema;
  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }
  protected decodeRow(row: Row) {
    return {
      profileId: row['profile_id'],
      year: row['period_key'],
      text: row['direction_text'],
      ...optional('archivedAt', row['archived_at']),
    };
  }
  async create(
    connection: SqliteQueryConnection,
    mutation: CreateMutation,
    context: CommandContext,
    document: YearDirectionDocument,
  ) {
    await assertCreatable(connection, mutation);
    const result = await connection.run(
      `INSERT INTO year_directions (id, owner_id, profile_id, period_key, direction_text,
         archived_at, created_at, updated_at, client_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.ref.id,
        mutation.ref.ownerId,
        document.profileId,
        document.year,
        document.text,
        document.archivedAt ?? null,
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
    document: YearDirectionDocument,
  ) {
    const result = await connection.run(
      `UPDATE year_directions SET profile_id = ?, period_key = ?, direction_text = ?,
         archived_at = ?, updated_at = ?, client_updated_at = ?,
         local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        document.profileId,
        document.year,
        document.text,
        document.archivedAt ?? null,
        context.now,
        context.now,
        ...syncWhere(mutation),
      ],
    );
    return result.changes;
  }
}

export const templateCanonicalCodec = new TemplateCodec();
export const timeBlockCanonicalCodec = new TimeBlockCodec();
export const reminderCanonicalCodec = new ReminderCodec();

export const planningCanonicalCodecs: readonly CanonicalRecordCodec[] = [
  new PlacementCodec(),
  timeBlockCanonicalCodec,
  reminderCanonicalCodec,
  new NoteCodec(),
  new ProjectCodec(),
  new FocusSelectionCodec(),
  new CommitmentCodec(),
  templateCanonicalCodec,
  new MonthThemeCodec(),
  new YearDirectionCodec(),
];
