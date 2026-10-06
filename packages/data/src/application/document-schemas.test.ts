import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCalendarDate,
  parseIanaTimeZone,
  parseInstant,
  parseOccurrenceOverride,
  parseRecurrenceRuleV1,
  parseRoutineSchedulingMode,
  parseTemplateBlueprint,
  parseWallTime,
  type EntityType,
} from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  documentSchemaMigrationSuffix,
  entityTypesWithoutDocumentSchema,
  renderDocumentSchemaMigration,
  serverOpenFieldSchemas,
  serverValuePatterns,
  syncDocumentJsonSchemas,
  syncDocumentReferences,
  syncDocumentSchemas,
  trimmedTextPattern,
} from './document-schemas';

const everyEntityType = [
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
const entityTypeParity: [Exclude<EntityType, (typeof everyEntityType)[number]>] extends [never]
  ? true
  : never = true;
void entityTypeParity;

const migrations = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url));

type JsonSchema = Readonly<Record<string, unknown>>;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every property path whose key names an entity id (`…Id` or a typed pair's `id`). */
function idPaths(schema: unknown, path: readonly string[] = []): string[] {
  if (!isSchema(schema)) return [];
  const found: string[] = [];
  const properties = schema['properties'];
  if (isSchema(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      if (key === 'id' || key.endsWith('Id')) found.push([...path, key].join('.'));
      found.push(...idPaths(child, [...path, key]));
    }
  }
  for (const keyword of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) found.push(...idPaths(branch, path));
    }
  }
  for (const keyword of ['items', 'additionalProperties', 'not']) {
    const child = schema[keyword];
    if (isSchema(child)) found.push(...idPaths(child, [...path, '*']));
  }
  return found;
}

describe('sync document schemas', () => {
  it('map every syncable entity type to its record codec schema', () => {
    expect(
      [...Object.keys(syncDocumentSchemas), ...entityTypesWithoutDocumentSchema].sort(),
    ).toEqual([...everyEntityType].sort());
    // account sync: Context has its record codec, so every syncable type validates on the server.
    expect(entityTypesWithoutDocumentSchema).toEqual([]);
  });

  it('render JSON Schemas that keep strict objects and id patterns', () => {
    const schemas = syncDocumentJsonSchemas() as Readonly<Record<string, JsonSchema>>;
    for (const [entityType, schema] of Object.entries(schemas)) {
      expect(schema['$schema'], entityType).toBe('https://json-schema.org/draft/2020-12/schema');
    }
    const action = schemas['action'];
    expect(action?.['type']).toBe('object');
    expect(action?.['additionalProperties']).toBe(false);
    const axisId = (action?.['properties'] as Record<string, JsonSchema>)['axisId'];
    expect(axisId?.['pattern']).toEqual(expect.stringContaining('[1-8]'));
  });

  it('keep the latest generated migration identical to what the record codecs generate', () => {
    const generated = readdirSync(migrations)
      .filter((name) => name.endsWith(documentSchemaMigrationSuffix))
      .sort();
    const latest = generated.at(-1);
    expect(latest, 'no generated sync document schema migration').toBeDefined();
    const committed = readFileSync(join(migrations, latest ?? ''), 'utf8');
    expect(
      committed === renderDocumentSchemaMigration(),
      'The committed sync document schemas differ from the record codecs. Run ' +
        '`pnpm exec tsx scripts/generate-sync-document-schemas.ts` and commit the new migration.',
    ).toBe(true);
  });

  it('render deterministically', () => {
    expect(renderDocumentSchemaMigration()).toBe(renderDocumentSchemaMigration());
  });

  it('cover every id-valued field of every schema with a reference row', () => {
    const schemas = syncDocumentJsonSchemas() as Readonly<Record<string, unknown>>;
    const fields = new Set(
      Object.entries(schemas).flatMap(([entityType, schema]) =>
        idPaths(schema).map((path) => `${entityType}:${path}`),
      ),
    );
    const references = new Set(
      syncDocumentReferences.map(
        (reference) => `${reference.entityType}:${reference.path.join('.')}`,
      ),
    );
    // Profile ids and nested `target` union ids are included.
    expect(fields).toContain('focus_selection:profileId');
    expect(fields).toContain('planning_placement:target.actionId');
    expect(fields).toContain('review_item:target.routineId');
    expect([...fields].filter((field) => !references.has(field)).sort()).toEqual([]);
    expect([...references].filter((reference) => !fields.has(reference)).sort()).toEqual([]);
    expect([...fields].filter((field) => field.includes('*'))).toEqual([]);
  });

  it('name known target types, and enforce exactly the SQLite foreign keys', () => {
    const known = new Set<string>(everyEntityType);
    for (const reference of syncDocumentReferences) {
      expect(known.has(reference.targetType), reference.targetType).toBe(true);
    }
    const unenforced = syncDocumentReferences
      .filter((reference) => !reference.enforced)
      .map(
        (reference) =>
          `${reference.entityType}:${reference.path.join('.')}:${reference.targetType}`,
      );
    expect(unenforced).toEqual(['action:convertedTo.id:note', 'action:convertedTo.id:project']);
    const keys = syncDocumentReferences.map(
      (reference) => `${reference.entityType}:${reference.path.join('.')}:${reference.targetType}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/* ───────────────────────── Server value rules ───────────────────────── */

interface ZodNode {
  readonly _zod: { readonly def: Readonly<Record<string, unknown>> & { readonly type: string } };
  safeParse(value: unknown): { readonly success: boolean };
}

function schemaAt(schema: JsonSchema, ...path: readonly (string | number)[]): JsonSchema {
  let node: unknown = schema;
  for (const key of path) node = (node as Record<string | number, unknown> | undefined)?.[key];
  if (!isSchema(node)) throw new Error(`No JSON Schema at ${path.join('/')}.`);
  return node;
}

/** Visits every zod node of a codec schema with the generated JSON Schema node it became. */
function walk(
  node: ZodNode,
  json: JsonSchema,
  path: string,
  visit: (node: ZodNode, json: JsonSchema, path: string) => void,
): void {
  visit(node, json, path);
  const def = node._zod.def;
  switch (def.type) {
    case 'object':
      for (const [key, child] of Object.entries(def['shape'] as Record<string, ZodNode>)) {
        walk(child, schemaAt(json, 'properties', key), `${path}.${key}`, visit);
      }
      break;
    case 'optional':
      walk(def['innerType'] as ZodNode, json, path, visit);
      break;
    case 'array':
      walk(def['element'] as ZodNode, schemaAt(json, 'items'), `${path}[]`, visit);
      break;
    case 'union': {
      const keyword = Array.isArray(json['oneOf']) ? 'oneOf' : 'anyOf';
      (def['options'] as readonly ZodNode[]).forEach((option, index) => {
        walk(option, schemaAt(json, keyword, index), `${path}|${String(index)}`, visit);
      });
      break;
    }
    case 'pipe':
      walk(def['in'] as ZodNode, json, path, visit);
      break;
    default:
      break;
  }
}

/** Whether a codec value carries a rule zod cannot convert (a refinement or a custom type). */
function refined(node: ZodNode): boolean {
  const checks = (node._zod.def['checks'] ?? []) as readonly ZodNode[];
  return (
    node._zod.def.type === 'custom' || checks.some((check) => check._zod.def['check'] === 'custom')
  );
}

/** A generated string schema applied as the server applies it (code points, ECMAScript regex). */
function stringAccepts(json: JsonSchema, value: string): boolean {
  const length = [...value].length;
  return (
    (typeof json['maxLength'] !== 'number' || length <= json['maxLength']) &&
    (typeof json['minLength'] !== 'number' || length >= json['minLength']) &&
    (typeof json['pattern'] !== 'string' || new RegExp(json['pattern'], 'u').test(value))
  );
}

const matches = (pattern: string, value: string) => new RegExp(pattern, 'u').test(value);
const two = (value: number) => String(value).padStart(2, '0');
const four = (value: number) => String(value).padStart(4, '0');

describe('sync document schemas on the server', () => {
  const schemas = syncDocumentJsonSchemas() as Readonly<Record<string, JsonSchema>>;

  it('carry a server rule for every refined codec value; only rules across fields are left out', () => {
    const missing: string[] = [];
    const clientOnly: string[] = [];
    for (const [entityType, schema] of Object.entries(syncDocumentSchemas)) {
      walk(
        schema as unknown as ZodNode,
        schemas[entityType] ?? {},
        entityType,
        (node, json, path) => {
          if (!refined(node)) return;
          const type = node._zod.def.type;
          if (type === 'object') clientOnly.push(path);
          else if (type === 'string' && typeof json['pattern'] !== 'string') missing.push(path);
          else if (type === 'array' && !Array.isArray(json['enum'])) missing.push(path);
          else if (type === 'custom' && json['oneOf'] === undefined && json['type'] !== 'object') {
            missing.push(path);
          }
        },
      );
    }
    expect(missing).toEqual([]);
    // Each of these objects refines its fields together (archive metadata, windows, periods).
    expect(clientOnly).toContain('time_block');
    expect(clientOnly).toContain('routine.generations[]');
  });

  it('leave no value open', () => {
    const open: string[] = [];
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          visit(item, `${path}/${String(index)}`);
        });
        return;
      }
      if (!isSchema(value)) return;
      if (Object.keys(value).length === 0) open.push(path);
      for (const [key, child] of Object.entries(value)) {
        if (key !== 'enum' && key !== 'const') visit(child, `${path}/${key}`);
      }
    };
    for (const [entityType, schema] of Object.entries(schemas)) visit(schema, entityType);
    expect(open).toEqual([]);
  });

  it('apply each value rule exactly as its codec does, and a zone name syntax the codec never refuses', () => {
    const samples = [
      ...['2024-02-29', '2023-02-29', '2026-02-30', '2026-13-01', '0000-02-29', '1900-02-29'],
      ...['not-a-date', '2026-1-01', '2026-10-02T09:00:00.000Z', '2026-10-02T09:00:00Z'],
      ...['2026-10-02T24:00:00.000Z', '2023-02-29T09:00:00.000Z', '2026-10-02T09:00:00.1Z'],
      ...['00:00', '23:59', '24:00', '23:59:59', '23:59:60', '7:30', '12:30:00.000', 'whenever'],
      ...['Europe/Berlin', 'UTC', 'Etc/GMT+5', '+05', '+05:30', 'Not/AZone', 'Not a zone'],
      ...['', ' ', '\t\n', '\u3000\u00a0\ufeff', 'a', ' a ', '\u0085', 'x'.repeat(201)],
    ];
    let checked = 0;
    for (const [entityType, schema] of Object.entries(syncDocumentSchemas)) {
      walk(
        schema as unknown as ZodNode,
        schemas[entityType] ?? {},
        entityType,
        (node, json, path) => {
          if (!refined(node) || node._zod.def.type !== 'string') return;
          checked += 1;
          const zone = json['pattern'] === serverValuePatterns.timeZone;
          for (const sample of samples) {
            const client = node.safeParse(sample).success;
            const server = stringAccepts(json, sample);
            const label = `${path} ${JSON.stringify(sample)}`;
            if (!zone) expect(server, label).toBe(client);
            // Temporal also reads a zone out of date-time text (`…Z` is UTC), which the shared
            // zone check lets through; commands store the zone's identifier, which is what the
            // server checks.
            else if (!/^\d{4}-\d{2}-\d{2}T/u.test(sample))
              expect(!client || server, label).toBe(true);
          }
        },
      );
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('list exactly the cleared-list selections a Review codec accepts', () => {
    const keys = ['commitments', 'first_day_focus', 'next_focus', 'unknown'];
    let sequences: string[][] = [[]];
    const samples: string[][] = [[]];
    for (let length = 1; length <= 3; length += 1) {
      sequences = sequences.flatMap((sequence) => keys.map((key) => [...sequence, key]));
      samples.push(...sequences);
    }
    const node = syncDocumentSchemas.review.shape.clearedLists;
    const json = schemaAt(schemas['review'] ?? {}, 'properties', 'clearedLists');
    const listed = new Set(
      (json['enum'] as readonly unknown[]).map((list) => JSON.stringify(list)),
    );
    expect(
      samples.filter(
        (sample) => node.safeParse(sample).success !== listed.has(JSON.stringify(sample)),
      ),
    ).toEqual([]);
    expect(listed.size).toBe(7);
  });

  it('match calendar dates, Action instants, and wall times exactly as the domain parses them', () => {
    const dates: string[] = [];
    for (let year = 0; year <= 9999; year += 1) dates.push(`${four(year)}-02-29`);
    for (const year of [0, 4, 100, 400, 1900, 2000, 2023, 2024, 9999]) {
      for (let month = 0; month <= 13; month += 1) {
        for (let day = 0; day <= 32; day += 1)
          dates.push(`${four(year)}-${two(month)}-${two(day)}`);
      }
    }
    dates.push('٢٠٢٦-١٠-٠١', '2026-10-01 ', '+002026-10-01', '2026-10-1', '');
    expect(
      dates.filter(
        (date) => matches(serverValuePatterns.calendarDate, date) !== parseCalendarDate(date).ok,
      ),
    ).toEqual([]);

    const instants = ['2024-02-29', '2023-02-29', '2026-10-01', '0000-01-01', '9999-12-31'].flatMap(
      (date) =>
        ['00:00:00', '23:59:59', '24:00:00', '23:60:00', '23:59:60', '9:30:00', '12:30'].flatMap(
          (time) =>
            ['', '.0', '.000', '.120', '.1234', '.999999999'].flatMap((fraction) =>
              ['Z', 'z', '+00:00', ''].map((zone) => `${date}T${time}${fraction}${zone}`),
            ),
        ),
    );
    const canonical = (value: string) => {
      const parsed = parseInstant(value);
      return parsed.ok && parsed.value === value;
    };
    expect(
      instants.filter(
        (value) => matches(serverValuePatterns.canonicalInstant, value) !== canonical(value),
      ),
    ).toEqual([]);

    const times: string[] = [];
    for (let hour = 0; hour <= 99; hour += 1) {
      for (let minute = 0; minute <= 99; minute += 1) times.push(`${two(hour)}:${two(minute)}`);
    }
    for (let hour = 0; hour <= 25; hour += 1) {
      for (const minute of [0, 30, 59, 60]) {
        for (let second = 0; second <= 61; second += 1) {
          times.push(`${two(hour)}:${two(minute)}:${two(second)}`);
        }
      }
    }
    times.push('7:30', '07:3', '07:30:', '07:30:00.0', '0730', '');
    expect(
      times.filter(
        (value) => matches(serverValuePatterns.wallTime, value) !== parseWallTime(value).ok,
      ),
    ).toEqual([]);
    // A template item's start: hours and minutes only (`parseTemplateBlueprint`).
    expect(
      times.filter(
        (value) =>
          matches(serverValuePatterns.minuteWallTime, value) !==
          (/^\d{2}:\d{2}$/u.test(value) && parseWallTime(value).ok),
      ),
    ).toEqual([]);
  });

  it('match non-blank and trimmed-length text exactly as trim() measures it', () => {
    const singles = Array.from({ length: 0x10000 }, (_, codeUnit) => String.fromCharCode(codeUnit));
    expect(
      singles
        .filter((value) => matches(serverValuePatterns.nonBlank, value) !== value.trim().length > 0)
        .map((value) => value.charCodeAt(0).toString(16)),
    ).toEqual([]);

    const pads = ['', ' ', '\t\n', '\u3000\u00a0\ufeff'];
    const titles = pads.flatMap((before) =>
      pads.flatMap((after) =>
        [0, 1, 2, 199, 200, 201, 250].flatMap((length) => [
          `${before}${'x'.repeat(length)}${after}`,
          length < 2
            ? `${before}${'x'.repeat(length)}${after}`
            : `${before}x${' '.repeat(length - 2)}x${after}`,
        ]),
      ),
    );
    const titlePattern = trimmedTextPattern(200);
    expect(
      titles.filter((title) => {
        const trimmedLength = title.trim().length;
        return matches(titlePattern, title) !== (trimmedLength >= 1 && trimmedLength <= 200);
      }),
    ).toEqual([]);
  });

  it('accept every zone the client knows and refuse what is not zone name syntax', () => {
    const zones = [
      ...Intl.supportedValuesOf('timeZone'),
      ...['UTC', 'utc', 'GMT', 'Etc/GMT+5', 'Etc/GMT-14', 'EST5EDT', 'America/Port-au-Prince'],
      ...['America/Argentina/Buenos_Aires', 'Antarctica/DumontDUrville', 'Asia/Calcutta'],
      ...['+05', '+0530', '-00', '+2359'],
    ];
    expect(zones.filter((zone) => !parseIanaTimeZone(zone).ok)).toEqual([]);
    expect(zones.filter((zone) => !matches(serverValuePatterns.timeZone, zone))).toEqual([]);
    const notNames = ['', ' ', 'Not a zone', 'Europe/Berlin ', '/Europe', 'Europe/', 'A//B'];
    expect(notNames.filter((value) => matches(serverValuePatterns.timeZone, value))).toEqual([]);
    // The client refuses these too; the server's syntax check cannot tell `Not/AZone` apart.
    expect([...notNames, '+05:30'].filter((value) => parseIanaTimeZone(value).ok)).toEqual([]);
    expect(matches(serverValuePatterns.timeZone, 'Not/AZone')).toBe(true);
  });
});

describe('server schemas of the domain-parsed fields', () => {
  /** Fixtures on which a server schema and its domain parser disagree. */
  function disagreements(
    schema: z.ZodType,
    parse: (value: unknown) => { readonly ok: boolean },
    fixtures: readonly unknown[],
  ): unknown[] {
    return fixtures.filter((fixture) => schema.safeParse(fixture).success !== parse(fixture).ok);
  }

  /** Fixtures the parser refuses for a rule across fields, which the server leaves to replicas. */
  function clientOnly(
    schema: z.ZodType,
    parse: (value: unknown) => { readonly ok: boolean },
    fixtures: readonly unknown[],
  ): void {
    for (const fixture of fixtures) {
      expect(parse(fixture).ok, JSON.stringify(fixture)).toBe(false);
      expect(schema.safeParse(fixture).success, JSON.stringify(fixture)).toBe(true);
    }
  }

  it('accept exactly the recurrence rules the domain accepts, except an end before the start', () => {
    const base = { version: 1, startsOn: '2026-10-01' };
    const daily = { ...base, kind: 'daily', intervalDays: 1 };
    const weekly = {
      ...base,
      kind: 'weekly_days',
      intervalWeeks: 1,
      weekdays: ['friday', 'monday'],
    };
    const count = { ...base, kind: 'weekly_count', targetCount: 3, weekStart: 'monday' };
    const monthly = {
      ...base,
      kind: 'monthly_day',
      intervalMonths: 1,
      dayOfMonth: 31,
      missingDayPolicy: 'skip',
    };
    const fixtures: readonly unknown[] = [
      daily,
      weekly,
      count,
      monthly,
      { ...daily, endsOn: '2026-10-01' },
      { ...daily, intervalDays: 1e300 },
      { ...monthly, missingDayPolicy: 'last_day', dayOfMonth: 1 },
      null,
      [],
      'daily',
      { ...daily, version: 2 },
      { ...daily, version: '1' },
      { ...daily, kind: 'hourly' },
      { ...daily, startsOn: '2026-02-30' },
      { ...daily, startsOn: undefined },
      { ...daily, endsOn: 'never' },
      { ...daily, intervalDays: 0 },
      { ...daily, intervalDays: 1.5 },
      { ...daily, intervalDays: '1' },
      { ...daily, interval: 1 },
      { ...daily, weekStart: 'monday' },
      { ...weekly, weekdays: [] },
      { ...weekly, weekdays: ['funday'] },
      { ...weekly, weekdays: ['monday', 'monday'] },
      { ...count, weekStart: 'someday' },
      { ...count, targetCount: -1 },
      { ...monthly, dayOfMonth: 32 },
      { ...monthly, dayOfMonth: 0 },
      { ...monthly, missingDayPolicy: 'first_day' },
    ];
    const schema = serverOpenFieldSchemas.recurrenceRule;
    expect(disagreements(schema, parseRecurrenceRuleV1, fixtures)).toEqual([]);
    clientOnly(schema, parseRecurrenceRuleV1, [{ ...daily, endsOn: '2026-09-30' }]);
  });

  it('accept exactly the scheduling modes and overrides the domain accepts, except an unknown zone', () => {
    const timed = {
      kind: 'time_specific',
      wallTime: '07:30',
      durationMinutes: 30,
      zonePolicy: { kind: 'follow_profile' },
      gapPolicy: 'skip',
      overlapPolicy: 'earlier_offset',
    };
    const modes: readonly unknown[] = [
      { kind: 'day_flexible' },
      timed,
      { ...timed, wallTime: '23:59:59', durationMinutes: 1440 },
      { ...timed, durationMinutes: 1 },
      { ...timed, zonePolicy: { kind: 'fixed_zone', timeZone: 'Europe/Berlin' } },
      { ...timed, gapPolicy: 'shift_forward', overlapPolicy: 'later_offset' },
      { kind: 'day_flexible', wallTime: '07:30' },
      { kind: 'weekly' },
      { ...timed, wallTime: '24:00' },
      { ...timed, wallTime: undefined },
      { ...timed, durationMinutes: 0 },
      { ...timed, durationMinutes: 1441 },
      { ...timed, durationMinutes: 1.5 },
      { ...timed, zonePolicy: { kind: 'device' } },
      { ...timed, zonePolicy: { kind: 'fixed_zone' } },
      { ...timed, zonePolicy: { kind: 'follow_profile', timeZone: 'UTC' } },
      { ...timed, zonePolicy: { kind: 'fixed_zone', timeZone: 'Not a zone' } },
      { ...timed, gapPolicy: 'later' },
      { ...timed, overlapPolicy: 'both' },
      { ...timed, extra: true },
    ];
    const mode = serverOpenFieldSchemas.schedulingMode;
    expect(disagreements(mode, parseRoutineSchedulingMode, modes)).toEqual([]);
    clientOnly(mode, parseRoutineSchedulingMode, [
      { ...timed, zonePolicy: { kind: 'fixed_zone', timeZone: 'Not/AZone' } },
    ]);

    const overrides: readonly unknown[] = [
      {},
      { date: '2024-02-29' },
      { wallTime: '07:00' },
      { durationMinutes: 1440 },
      { overlapAcknowledged: true },
      { date: '2026-10-02', wallTime: '06:15:30', durationMinutes: 1, overlapAcknowledged: true },
      null,
      [],
      { date: '2023-02-29' },
      { wallTime: '7:00' },
      { durationMinutes: 0 },
      { durationMinutes: 1441 },
      { overlapAcknowledged: false },
      { extra: 1 },
    ];
    expect(
      disagreements(serverOpenFieldSchemas.occurrenceOverride, parseOccurrenceOverride, overrides),
    ).toEqual([]);
  });

  it('accept exactly the template blueprints the domain accepts, except rules across items', () => {
    const item = { templateKey: 'k', kind: 'action', title: 'Item' };
    const v1 = (...items: readonly unknown[]) => ({ version: 1, items });
    const v2 = (...items: readonly unknown[]) => ({ version: 2, items });
    const timedAction = {
      ...item,
      relativeDayOffset: -365,
      localStartTime: '23:59',
      durationMinutes: 5,
    };
    const fixtures: readonly unknown[] = [
      v1(item),
      v1({
        ...item,
        title: `  ${'x'.repeat(200)}  `,
        note: 'n'.repeat(10_000),
        estimateMinutes: 10_080,
        energy: 'focused',
        priority: 'low',
      }),
      v1(
        { templateKey: 'p', kind: 'project', title: 'Project' },
        { ...item, parentTemplateKey: 'p' },
      ),
      v1(
        ...Array.from({ length: 50 }, (_, index) => ({
          ...item,
          templateKey: `k${String(index)}`,
        })),
      ),
      v2(timedAction, {
        templateKey: 'o',
        kind: 'outcome',
        title: 'Outcome',
        relativeDayOffset: 365,
      }),
      v2({ ...timedAction, durationMinutes: 1440 }),
      null,
      v1(),
      v1(
        ...Array.from({ length: 51 }, (_, index) => ({
          ...item,
          templateKey: `k${String(index)}`,
        })),
      ),
      { version: 3, items: [item] },
      { ...v1(item), title: 'Extra' },
      v1({ ...item, extra: true }),
      v1({ ...item, relativeDayOffset: 0 }),
      v1({ ...item, templateKey: ' ' }),
      v1({ ...item, templateKey: 'k'.repeat(51) }),
      v1({ ...item, kind: 'meeting' }),
      v1({ ...item, title: '\u3000' }),
      v1({ ...item, title: 'x'.repeat(201) }),
      v1({ ...item, parentTemplateKey: '' }),
      v1({ ...item, note: 'n'.repeat(10_001) }),
      v1({ ...item, estimateMinutes: 0 }),
      v1({ ...item, estimateMinutes: 10_081 }),
      v1({ ...item, estimateMinutes: 1.5 }),
      v1({ ...item, energy: 'tired' }),
      v1({ ...item, priority: 'urgent' }),
      v2({ ...timedAction, relativeDayOffset: 366 }),
      v2({ ...timedAction, localStartTime: '9:00' }),
      v2({ ...timedAction, localStartTime: '24:00' }),
      v2({ ...timedAction, localStartTime: '09:00:00' }),
      v2({ ...timedAction, durationMinutes: 4 }),
      v2({ ...timedAction, durationMinutes: 1441 }),
    ];
    const schema = serverOpenFieldSchemas.templateBlueprint;
    expect(disagreements(schema, parseTemplateBlueprint, fixtures)).toEqual([]);
    clientOnly(schema, parseTemplateBlueprint, [
      v1(item, item),
      v1({ ...item, parentTemplateKey: 'missing' }),
      v1(
        { templateKey: 'o', kind: 'outcome', title: 'Outcome' },
        { ...item, parentTemplateKey: 'o' },
      ),
      v1({ templateKey: 'm', kind: 'milestone', title: 'Milestone' }),
      v2({ ...item, localStartTime: '09:00' }),
      v2({ ...item, relativeDayOffset: 0, durationMinutes: 30 }),
      v2({ templateKey: 'n', kind: 'note', title: 'Note', relativeDayOffset: 0 }),
      v2({
        templateKey: 'p',
        kind: 'project',
        title: 'Project',
        relativeDayOffset: 0,
        localStartTime: '09:00',
      }),
    ]);
  });
});
