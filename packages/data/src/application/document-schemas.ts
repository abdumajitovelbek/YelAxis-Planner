import {
  energyLabels,
  routineLimits,
  templateItemKinds,
  templateLimits,
  type EntityType,
} from '@yelaxis/domain';
import { z } from 'zod';

import { actionCanonicalDocumentSchema } from './action-codec';
import { calendarDate, ianaTimeZone, nonBlank, wallTime, weekday } from './base-codec';
import { contextDocumentSchema } from './context-codec';
import {
  axisDocumentSchema,
  constraintDocumentSchema,
  milestoneDocumentSchema,
  outcomeDocumentSchema,
} from './horizon-codecs';
import {
  commitmentDocumentSchema,
  focusSelectionDocumentSchema,
  monthThemeDocumentSchema,
  noteDocumentSchema,
  planningPlacementDocumentSchema,
  projectDocumentSchema,
  reminderDocumentSchema,
  templateDocumentSchema,
  timeBlockDocumentSchema,
  yearDirectionDocumentSchema,
} from './planning-codecs';
import { profilePlanningDocumentSchema } from './profile-codec';
import {
  milestoneActionDocumentSchema,
  milestoneProjectDocumentSchema,
  projectSecondaryOutcomeDocumentSchema,
} from './relationship-codecs';
import { reviewDocumentSchema, reviewItemDocumentSchema } from './review-codecs';
import {
  routineActionDefaultsDocumentSchema,
  routineDocumentSchema,
  routineGenerationDocumentSchema,
  routineOccurrenceDocumentSchema,
} from './routine-codecs';

/*
 * account sync server document contract. The cloud replica validates every pushed document
 * against a JSON Schema generated from the record codec schema of its entity type, and checks every
 * id-valued field against the reference map below. `scripts/generate-sync-document-schemas.ts`
 * renders both into a Supabase migration; a test fails when that migration differs from what these
 * codecs generate.
 *
 * zod cannot convert a refinement, so the codec value rules that JSON Schema can express are added
 * here: calendar dates, instants, wall times, zone name syntax, and non-blank text as patterns (see
 * `serverValuePatterns`), and the fields the domain parses (recurrence rules, scheduling modes,
 * occurrence overrides, template blueprints) as the schemas in `serverOpenFieldSchemas`. Rules that
 * relate fields to each other (an end after its start, archive metadata, a period and its key) stay
 * with the codecs, which every replica runs on what it pulls.
 */

/**
 * Entity types that replicate but have no record codec yet. The server holds no schema for them,
 * so it refuses their documents (`schema_mismatch`) until a codec exists and the migration is
 * regenerated.
 */
export const entityTypesWithoutDocumentSchema = [] as const satisfies readonly EntityType[];

export type SyncDocumentEntityType = Exclude<
  EntityType,
  (typeof entityTypesWithoutDocumentSchema)[number]
>;

const documentSchemas = {
  profile: profilePlanningDocumentSchema,
  axis: axisDocumentSchema,
  outcome: outcomeDocumentSchema,
  milestone: milestoneDocumentSchema,
  project: projectDocumentSchema,
  action: actionCanonicalDocumentSchema,
  note: noteDocumentSchema,
  commitment: commitmentDocumentSchema,
  time_block: timeBlockDocumentSchema,
  routine: routineDocumentSchema,
  routine_occurrence: routineOccurrenceDocumentSchema,
  routine_action_defaults: routineActionDefaultsDocumentSchema,
  template: templateDocumentSchema,
  review: reviewDocumentSchema,
  review_item: reviewItemDocumentSchema,
  reminder: reminderDocumentSchema,
  constraint: constraintDocumentSchema,
  context: contextDocumentSchema,
  planning_placement: planningPlacementDocumentSchema,
  focus_selection: focusSelectionDocumentSchema,
  theme: monthThemeDocumentSchema,
  direction: yearDirectionDocumentSchema,
  project_secondary_outcome: projectSecondaryOutcomeDocumentSchema,
  milestone_project: milestoneProjectDocumentSchema,
  milestone_action: milestoneActionDocumentSchema,
} satisfies Record<SyncDocumentEntityType, z.ZodType>;

/** The record codec schema of every syncable entity type that has one. */
export const syncDocumentSchemas: Readonly<typeof documentSchemas> = Object.freeze(documentSchemas);

/** One id-valued document field and the entity type it names. */
export interface SyncDocumentReference {
  readonly entityType: SyncDocumentEntityType;
  /** Path of the id inside the document; absent when the optional field or union branch is. */
  readonly path: readonly string[];
  readonly targetType: EntityType;
  /** The id names `targetType` only when this sibling path holds this value. */
  readonly when?: { readonly path: readonly string[]; readonly equals: string };
  /**
   * The target must exist, undeleted, for the same owner (checked when a group commits, like the
   * deferred SQLite foreign keys), and a target with references cannot be deleted. Mirrors the
   * SQLite foreign keys exactly, so the server is never stricter than a valid local plan.
   */
  readonly enforced: boolean;
}

const ref = (
  entityType: SyncDocumentEntityType,
  path: readonly string[],
  targetType: EntityType,
): SyncDocumentReference => ({ entityType, path, targetType, enforced: true });

/** Every id-valued field of every document, including nested `target` unions and `profileId`. */
export const syncDocumentReferences: readonly SyncDocumentReference[] = Object.freeze([
  ref('outcome', ['axisId'], 'axis'),
  ref('milestone', ['outcomeId'], 'outcome'),
  ref('project', ['axisId'], 'axis'),
  ref('project', ['primaryOutcomeId'], 'outcome'),
  ref('action', ['axisId'], 'axis'),
  ref('action', ['projectId'], 'project'),
  // `converted_to_id` has no SQLite foreign key: the converted Note or Project may later be
  // permanently deleted while the archived Action keeps naming it.
  {
    entityType: 'action',
    path: ['convertedTo', 'id'],
    targetType: 'note',
    when: { path: ['convertedTo', 'type'], equals: 'note' },
    enforced: false,
  },
  {
    entityType: 'action',
    path: ['convertedTo', 'id'],
    targetType: 'project',
    when: { path: ['convertedTo', 'type'], equals: 'project' },
    enforced: false,
  },
  ref('note', ['axisId'], 'axis'),
  ref('note', ['projectId'], 'project'),
  ref('time_block', ['target', 'actionId'], 'action'),
  ref('time_block', ['target', 'commitmentId'], 'commitment'),
  ref('time_block', ['target', 'routineOccurrenceId'], 'routine_occurrence'),
  ref('time_block', ['supersededById'], 'time_block'),
  ref('routine', ['axisId'], 'axis'),
  ref('routine_occurrence', ['routineId'], 'routine'),
  ref('routine_action_defaults', ['routineId'], 'routine'),
  ref('routine_action_defaults', ['projectId'], 'project'),
  ref('review', ['profileId'], 'profile'),
  ref('review_item', ['reviewId'], 'review'),
  ref('review_item', ['target', 'axisId'], 'axis'),
  ref('review_item', ['target', 'outcomeId'], 'outcome'),
  ref('review_item', ['target', 'milestoneId'], 'milestone'),
  ref('review_item', ['target', 'projectId'], 'project'),
  ref('review_item', ['target', 'actionId'], 'action'),
  // Both the `routine` and the `routine_occurrence` target name the Routine.
  ref('review_item', ['target', 'routineId'], 'routine'),
  ref('review_item', ['target', 'commitmentId'], 'commitment'),
  ref('reminder', ['actionId'], 'action'),
  ref('reminder', ['timeBlockId'], 'time_block'),
  ref('reminder', ['routineId'], 'routine'),
  ref('reminder', ['reviewId'], 'review'),
  ref('constraint', ['contextId'], 'context'),
  ref('planning_placement', ['target', 'outcomeId'], 'outcome'),
  ref('planning_placement', ['target', 'projectId'], 'project'),
  ref('planning_placement', ['target', 'milestoneId'], 'milestone'),
  ref('planning_placement', ['target', 'actionId'], 'action'),
  ref('focus_selection', ['profileId'], 'profile'),
  ref('focus_selection', ['target', 'actionId'], 'action'),
  ref('focus_selection', ['target', 'projectId'], 'project'),
  ref('focus_selection', ['target', 'milestoneId'], 'milestone'),
  ref('focus_selection', ['target', 'routineOccurrenceId'], 'routine_occurrence'),
  ref('theme', ['profileId'], 'profile'),
  ref('direction', ['profileId'], 'profile'),
  ref('project_secondary_outcome', ['projectId'], 'project'),
  ref('project_secondary_outcome', ['outcomeId'], 'outcome'),
  ref('milestone_project', ['milestoneId'], 'milestone'),
  ref('milestone_project', ['projectId'], 'project'),
  ref('milestone_action', ['milestoneId'], 'milestone'),
  ref('milestone_action', ['actionId'], 'action'),
]);

/* ───────────────────────── Server value rules ───────────────────────── */

/** The code points `String.prototype.trim` removes: ECMAScript WhiteSpace and LineTerminator. */
const trimmedCodePoints =
  '\\t\\n\\u000b\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const blank = `[${trimmedCodePoints}]`;
const visible = `[^${trimmedCodePoints}]`;

/** `YYYY-MM-DD` on the proleptic Gregorian calendar: real month lengths and leap days. */
const gregorianDate =
  '(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)' +
  '|02-(?:0[1-9]|1[0-9]|2[0-8]))' +
  '|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:0[048]|[2468][048]|[13579][26])00)-02-29)';

/**
 * Patterns of the codec value rules. Each accepts exactly what its codec accepts, with ASCII digits
 * as `\d` means in the codecs, except `timeZone`: it checks the IANA name syntax only (`Area/City`,
 * `UTC`, `Etc/GMT+5`, offset names such as `+05`), and whether the zone exists stays the client's
 * check. Character classes are spelled out because server regex engines differ on `\s` and `\d`.
 */
export const serverValuePatterns = Object.freeze({
  calendarDate: `^${gregorianDate}$`,
  /** An Action's instants: milliseconds and `Z`, exactly as `parseInstant` writes them. */
  canonicalInstant: `^${gregorianDate}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$`,
  wallTime: '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$',
  /** A template item's local start time: hours and minutes only. */
  minuteWallTime: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
  timeZone: '^[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*$',
  /** Text that `trim()` leaves non-empty: one code point it does not remove is enough. */
  nonBlank: visible,
});

/**
 * Non-blank text at most `maximum` long once trimmed (a template item title). The server counts
 * code points, so text with characters outside the BMP may be longer there than `trim()` allows.
 */
export function trimmedTextPattern(maximum: number): string {
  const inner = `(?:${blank}|${visible}){0,${String(maximum - 2)}}`;
  return `^${blank}*${visible}(?:${inner}${visible})?${blank}*$`;
}

type JsonSchemaKeywords = Readonly<Record<string, unknown>>;

/** Keywords added to the generated node of a codec value whose rule zod cannot convert. */
const serverKeywords = new Map<unknown, JsonSchemaKeywords>();

function addKeywords(nodes: readonly unknown[], keywords: JsonSchemaKeywords): void {
  for (const node of nodes) serverKeywords.set(node, keywords);
}

const actionShape = actionCanonicalDocumentSchema.shape;
const [actionDueOnDate, actionDueAtInstant] = actionShape.due.unwrap().options;

// The codecs' own refined values: the shared ones from the base codec, and the ones a codec
// declares itself (the Action codec's strict values, and each bounded text).
addKeywords([calendarDate, actionDueOnDate.shape.date], {
  pattern: serverValuePatterns.calendarDate,
});
addKeywords([actionDueAtInstant.shape.instant], { pattern: serverValuePatterns.canonicalInstant });
addKeywords([wallTime], { pattern: serverValuePatterns.wallTime });
addKeywords([ianaTimeZone, actionDueAtInstant.shape.authoredTimeZone], {
  pattern: serverValuePatterns.timeZone,
});
addKeywords(
  [
    nonBlank,
    actionShape.title,
    commitmentDocumentSchema.shape.title,
    timeBlockDocumentSchema.shape.target.options[3].shape.title,
    routineDocumentSchema.shape.title,
    templateDocumentSchema.shape.title,
    monthThemeDocumentSchema.shape.text,
    yearDirectionDocumentSchema.shape.text,
    reviewDocumentSchema.shape.notes.unwrap(),
    reviewDocumentSchema.shape.themeText.unwrap(),
    reviewDocumentSchema.shape.directionText.unwrap(),
    reviewItemDocumentSchema.shape.note.unwrap(),
  ],
  { pattern: serverValuePatterns.nonBlank },
);

// A Review's cleared lists are non-empty and strictly increasing: every ordered selection of keys.
const clearedLists = reviewDocumentSchema.shape.clearedLists.unwrap();
addKeywords([clearedLists], {
  enum: [...clearedLists.element.options]
    .sort()
    .reduce<string[][]>(
      (lists, key) => [...lists, ...lists.map((list) => [...list, key]), [key]],
      [],
    ),
});

/* ───────────────────────── Domain-parsed fields ───────────────────────── */

/** A string matching one of `serverValuePatterns`, checked by that same pattern in JavaScript. */
const matching = (pattern: string) => z.string().regex(new RegExp(pattern, 'u'));

/** A whole number above `minimum` with no upper bound, as `Number.isInteger` checks it. */
function wholeNumberAbove(minimum: number) {
  const node = z.number().gt(minimum).refine(Number.isInteger);
  serverKeywords.set(node, { type: 'integer' });
  return node;
}

/** An array of pairwise different items. */
function distinctItems<Item extends z.ZodType>(node: z.ZodArray<Item>) {
  const distinct = node.refine((items) => new Set(items).size === items.length);
  serverKeywords.set(distinct, { uniqueItems: true });
  return distinct;
}

const serverDate = matching(serverValuePatterns.calendarDate);
const serverWallTime = matching(serverValuePatterns.wallTime);
const routineMinutes = z.number().int().min(1).max(routineLimits.durationMinutes);
const ruleBounds = { version: z.literal(1), startsOn: serverDate, endsOn: serverDate.optional() };

/** `parseRecurrenceRuleV1`: version 1, a supported kind, and exactly that kind's fields. */
const recurrenceRuleV1 = z.discriminatedUnion('kind', [
  z.strictObject({ ...ruleBounds, kind: z.literal('daily'), intervalDays: wholeNumberAbove(0) }),
  z.strictObject({
    ...ruleBounds,
    kind: z.literal('weekly_days'),
    intervalWeeks: wholeNumberAbove(0),
    weekdays: distinctItems(z.array(weekday).min(1)),
  }),
  z.strictObject({
    ...ruleBounds,
    kind: z.literal('weekly_count'),
    targetCount: wholeNumberAbove(0),
    weekStart: weekday,
  }),
  z.strictObject({
    ...ruleBounds,
    kind: z.literal('monthly_day'),
    intervalMonths: wholeNumberAbove(0),
    dayOfMonth: z.number().int().min(1).max(31),
    missingDayPolicy: z.enum(['skip', 'last_day']),
  }),
]);

/** `parseRoutineSchedulingMode`: any day, or a wall time with its duration and zone policies. */
const routineSchedulingMode = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('day_flexible') }),
  z.strictObject({
    kind: z.literal('time_specific'),
    wallTime: serverWallTime,
    durationMinutes: routineMinutes,
    zonePolicy: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('follow_profile') }),
      z.strictObject({
        kind: z.literal('fixed_zone'),
        timeZone: matching(serverValuePatterns.timeZone),
      }),
    ]),
    gapPolicy: z.enum(['shift_forward', 'skip']),
    overlapPolicy: z.enum(['earlier_offset', 'later_offset']),
  }),
]);

/** `parseOccurrenceOverride`: one occurrence's moved date, time, or duration. */
const occurrenceOverride = z.strictObject({
  date: serverDate.optional(),
  wallTime: serverWallTime.optional(),
  durationMinutes: routineMinutes.optional(),
  overlapAcknowledged: z.literal(true).optional(),
});

const templateItemV1 = {
  templateKey: matching(serverValuePatterns.nonBlank).max(templateLimits.templateKey),
  kind: z.enum(templateItemKinds),
  parentTemplateKey: matching(serverValuePatterns.nonBlank).optional(),
  title: matching(trimmedTextPattern(templateLimits.title)),
  note: z.string().max(templateLimits.note).optional(),
  estimateMinutes: z.number().int().min(1).max(templateLimits.estimateMinutes).optional(),
  energy: z.enum(energyLabels).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
};
const templateItemV2 = {
  ...templateItemV1,
  relativeDayOffset: z
    .number()
    .int()
    .min(-templateLimits.dayOffset)
    .max(templateLimits.dayOffset)
    .optional(),
  localStartTime: matching(serverValuePatterns.minuteWallTime).optional(),
  durationMinutes: z
    .number()
    .int()
    .min(templateLimits.minDurationMinutes)
    .max(templateLimits.durationMinutes)
    .optional(),
};

/** `parseTemplateBlueprint`: version 1 or 2, and 1 to 50 items with that version's fields. */
const templateBlueprint = z.discriminatedUnion('version', [
  z.strictObject({
    version: z.literal(1),
    items: z.array(z.strictObject(templateItemV1)).min(1).max(templateLimits.items),
  }),
  z.strictObject({
    version: z.literal(2),
    items: z.array(z.strictObject(templateItemV2)).min(1).max(templateLimits.items),
  }),
]);

/**
 * The server's schemas of the codec fields the domain parses. Each accepts what its parser accepts
 * except the parser's checks across fields and items (an end on or after the start; a template
 * item's time needs its day and duration its time; unique template keys and resolvable parents);
 * a zone is checked by its name syntax only.
 */
export const serverOpenFieldSchemas = Object.freeze({
  recurrenceRule: recurrenceRuleV1,
  schedulingMode: routineSchedulingMode,
  occurrenceOverride,
  templateBlueprint,
});

const openFieldMirrors = new Map<unknown, z.ZodType>([
  [routineGenerationDocumentSchema.shape.rule, recurrenceRuleV1],
  [routineGenerationDocumentSchema.shape.schedulingMode, routineSchedulingMode],
  [routineOccurrenceDocumentSchema.shape.override.unwrap(), occurrenceOverride],
  [templateDocumentSchema.shape.blueprint, templateBlueprint],
]);

function serverJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
    reused: 'inline',
    override: ({ zodSchema, jsonSchema }) => {
      const mirror = openFieldMirrors.get(zodSchema);
      if (mirror !== undefined) {
        const converted = serverJsonSchema(mirror);
        delete converted['$schema'];
        Object.assign(jsonSchema, converted);
      }
      const keywords = serverKeywords.get(zodSchema);
      if (keywords !== undefined) Object.assign(jsonSchema, keywords);
    },
  });
}

/**
 * The JSON Schema of every document schema: the codec input shape with every value rule above.
 * Refinements that compare fields are dropped; the replicas keep checking them.
 */
export function syncDocumentJsonSchemas(): Readonly<Record<SyncDocumentEntityType, unknown>> {
  const entries = Object.entries(syncDocumentSchemas).map(([entityType, schema]) => [
    entityType,
    serverJsonSchema(schema),
  ]);
  return Object.freeze(Object.fromEntries(entries)) as Record<SyncDocumentEntityType, unknown>;
}

/* ───────────────────────── Migration rendering ───────────────────────── */

/** Migration file names end with this suffix; the latest one is the server's current contract. */
export const documentSchemaMigrationSuffix = '_sync_document_schemas.sql';

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlTextArray(values: readonly string[]): string {
  return `array[${values.map(sqlText).join(', ')}]::text[]`;
}

/**
 * The full migration that replaces the server's document schemas and reference map. Deterministic:
 * the same codecs always render the same text.
 */
export function renderDocumentSchemaMigration(): string {
  const schemas = Object.entries(syncDocumentJsonSchemas()).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const schemaRows = schemas.map(
    ([entityType, schema]) =>
      `  (${sqlText(entityType)}, ${sqlText(JSON.stringify(schema))}::jsonb)`,
  );
  const referenceRows = syncDocumentReferences.map(
    (reference) =>
      `  (${[
        sqlText(reference.entityType),
        sqlTextArray(reference.path),
        sqlText(reference.targetType),
        reference.when === undefined ? 'null' : sqlTextArray(reference.when.path),
        reference.when === undefined ? 'null' : sqlText(reference.when.equals),
        String(reference.enforced),
      ].join(', ')})`,
  );
  return [
    '-- Generated by `pnpm exec tsx scripts/generate-sync-document-schemas.ts` from the record codecs',
    '-- (packages/data/src/application/document-schemas.ts). Do not edit by hand: change the codecs,',
    '-- regenerate, and commit the new migration. A test fails when the latest generated migration',
    '-- differs from what the codecs generate.',
    '',
    'insert into yelaxis_sync.document_schemas (entity_type, json_schema) values',
    schemaRows.join(',\n'),
    'on conflict (entity_type) do update set json_schema = excluded.json_schema;',
    '',
    '-- An entity type without a generated schema keeps none, so its documents are refused.',
    'delete from yelaxis_sync.document_schemas',
    ` where entity_type not in (${schemas.map(([entityType]) => sqlText(entityType)).join(', ')});`,
    '',
    'delete from yelaxis_sync.reference_map;',
    '',
    'insert into yelaxis_sync.reference_map',
    '  (entity_type, field_path, target_entity_type, when_path, when_value, enforced)',
    'values',
    `${referenceRows.join(',\n')};`,
    '',
  ].join('\n');
}
