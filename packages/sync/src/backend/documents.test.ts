import { randomUUID } from 'node:crypto';

import {
  actionCanonicalDocumentSchema,
  axisDocumentSchema,
  constraintValueSchema,
  projectDocumentSchema,
  timeBlockDocumentSchema,
} from '@yelaxis/data';
import { parseTemplateBlueprint } from '@yelaxis/domain';
import { afterAll, describe, expect, it } from 'vitest';

import { documentHash as clientDocumentHash, type SyncEntityType } from '../protocol';
import { codecAccepts } from './record-codecs';
import {
  create,
  createTestUser,
  deleteTestUsers,
  documents,
  group,
  pullAll,
  pushAccepted,
  pushRejected,
  queryDatabase,
  rawRpc,
  update,
  type Document,
} from './stack';

afterAll(async () => {
  await deleteTestUsers();
});

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Whether the stored JSON Schema of `entityType`, at `path` inside it, accepts each value. */
function serverAccepts(
  entityType: SyncEntityType,
  path: readonly (string | number)[],
  values: readonly unknown[],
): boolean[] {
  return queryDatabase<{ accepted: boolean }>(
    `select extensions.jsonb_matches_schema(
              (select json_schema #> ${sqlText(`{${path.join(',')}}`)}
                 from yelaxis_sync.document_schemas
                where entity_type = ${sqlText(entityType)})::json,
              item.value) as accepted
       from jsonb_array_elements(${sqlText(JSON.stringify(values))}::jsonb)
         with ordinality as item(value, position)
      order by item.position`,
  ).map((row) => row.accepted);
}

/** The values a verdict differs on, so a failure names them. */
function disagreements(
  values: readonly string[],
  server: readonly boolean[],
  client: (value: string) => boolean,
): string[] {
  return values.filter((value, index) => server[index] !== client(value));
}

const two = (value: number) => String(value).padStart(2, '0');

const block: Document = {
  target: { kind: 'custom', title: 'Block' },
  startsAt: '2026-10-01T09:00:00Z',
  endsAt: '2026-10-01T10:00:00Z',
  timeZone: 'Europe/Berlin',
  state: 'planned',
  overlapAcknowledged: false,
};

function routine(generation: Document = {}): Document {
  return {
    title: 'Routine',
    orderKey: 'a0',
    state: 'active',
    generations: [
      {
        generation: 1,
        rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-10-01' },
        schedulingMode: { kind: 'day_flexible' },
        ...generation,
      },
    ],
  };
}

function occurrence(extra: Document = {}): Document {
  return {
    routineId: randomUUID(),
    generation: 1,
    periodKey: '2026-10-01',
    period: { kind: 'date', date: '2026-10-01' },
    state: 'planned',
    ...extra,
  };
}

const template = (blueprint: unknown): Document => ({
  title: 'Template',
  blueprint,
  state: 'active',
});
const item = { templateKey: 'first', kind: 'action', title: 'Item' };
const timed = {
  kind: 'time_specific',
  wallTime: '07:30',
  durationMinutes: 30,
  zonePolicy: { kind: 'follow_profile' },
  gapPolicy: 'skip',
  overlapPolicy: 'earlier_offset',
};

describe('server document schemas', () => {
  it('refuses the values every replica refuses: dates, instants, zones, times, blank text, and parsed fields', async () => {
    const user = await createTestUser('documents-refused');
    const cases: readonly (readonly [string, SyncEntityType, Document])[] = [
      [
        'a date that does not exist',
        'project',
        documents.project('P', { targetStart: '2026-02-30' }),
      ],
      ['a leap day in a common year', 'routine', { ...routine(), pauseEffectiveOn: '2023-02-29' }],
      [
        'not a date',
        'action',
        documents.action('A', { due: { kind: 'date', date: 'not-a-date' } }),
      ],
      [
        'not an instant',
        'action',
        documents.action('A', { state: 'completed', completedAt: 'whenever' }),
      ],
      [
        'an instant the Action codec never writes',
        'action',
        documents.action('A', {
          due: {
            kind: 'instant',
            instant: '2026-10-02T09:00:00Z',
            authoredTimeZone: 'Europe/Berlin',
          },
        }),
      ],
      ['not a zone name', 'profile', { ...documents.profile(), planningTimeZone: 'Not a zone' }],
      ['an offset written with a colon', 'time_block', { ...block, timeZone: '+05:30' }],
      [
        'no zone',
        'action',
        documents.action('A', {
          due: { kind: 'instant', instant: '2026-10-02T09:00:00.000Z', authoredTimeZone: '' },
        }),
      ],
      [
        'a wall time that does not exist',
        'constraint',
        {
          ...documents.constraint(),
          constraintKind: 'availability',
          value: {
            kind: 'availability',
            windows: [{ weekday: 'monday', start: '24:00', end: '23:00' }],
          },
        },
      ],
      ['blank text', 'axis', documents.axis('   ')],
      [
        'invisible spaces only',
        'commitment',
        { title: '\u3000\u00a0\ufeff', strength: 'soft', state: 'planned' },
      ],
      ['a blank order key', 'action', { ...documents.action(), orderKey: '\t\n' }],
      [
        'cleared lists out of order',
        'review',
        {
          profileId: randomUUID(),
          reviewType: 'weekly',
          periodKey: '2026-09-28',
          periodStart: '2026-09-28',
          periodEnd: '2026-10-04',
          weekStart: 'monday',
          clearedLists: ['first_day_focus', 'commitments'],
          state: 'draft',
        },
      ],
      [
        'an unknown rule kind',
        'routine',
        routine({ rule: { version: 1, kind: 'hourly', intervalHours: 1, startsOn: '2026-10-01' } }),
      ],
      [
        'an unknown weekday in a rule',
        'routine',
        routine({
          rule: {
            version: 1,
            kind: 'weekly_days',
            intervalWeeks: 1,
            weekdays: ['monday', 'funday'],
            startsOn: '2026-10-01',
          },
        }),
      ],
      [
        'a weekday twice in a rule',
        'routine',
        routine({
          rule: {
            version: 1,
            kind: 'weekly_days',
            intervalWeeks: 1,
            weekdays: ['monday', 'monday'],
            startsOn: '2026-10-01',
          },
        }),
      ],
      [
        'an unknown missing-day policy',
        'routine',
        routine({
          rule: {
            version: 1,
            kind: 'monthly_day',
            intervalMonths: 1,
            dayOfMonth: 31,
            missingDayPolicy: 'first_day',
            startsOn: '2026-10-01',
          },
        }),
      ],
      [
        'a field of another rule kind',
        'routine',
        routine({
          rule: {
            version: 1,
            kind: 'daily',
            intervalDays: 1,
            weekStart: 'monday',
            startsOn: '2026-10-01',
          },
        }),
      ],
      [
        'a fractional interval',
        'routine',
        routine({ rule: { version: 1, kind: 'daily', intervalDays: 1.5, startsOn: '2026-10-01' } }),
      ],
      [
        'a rule starting on a date that does not exist',
        'routine',
        routine({ rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-02-30' } }),
      ],
      [
        'an unknown gap policy',
        'routine',
        routine({ schedulingMode: { ...timed, gapPolicy: 'later' } }),
      ],
      [
        'a fixed zone that is not a zone name',
        'routine',
        routine({
          schedulingMode: { ...timed, zonePolicy: { kind: 'fixed_zone', timeZone: 'Not a zone' } },
        }),
      ],
      [
        'a moved occurrence of no length',
        'routine_occurrence',
        occurrence({ override: { durationMinutes: 0 } }),
      ],
      [
        'a moved occurrence on no date',
        'routine_occurrence',
        occurrence({ override: { date: 'soon' } }),
      ],
      ['a blueprint without items', 'template', template({ version: 1, items: [] })],
      ['an unknown blueprint version', 'template', template({ version: 3, items: [item] })],
      [
        'an unknown template item kind',
        'template',
        template({ version: 1, items: [{ ...item, kind: 'meeting' }] }),
      ],
      [
        'a template item field of a later version',
        'template',
        template({ version: 1, items: [{ ...item, relativeDayOffset: 1 }] }),
      ],
      [
        'a template start time with seconds',
        'template',
        template({
          version: 2,
          items: [{ ...item, relativeDayOffset: 0, localStartTime: '09:00:00' }],
        }),
      ],
      [
        'a template title too long once trimmed',
        'template',
        template({ version: 1, items: [{ ...item, title: ` ${'x'.repeat(201)} ` }] }),
      ],
    ];
    for (const [label, entityType, document] of cases) {
      // Every replica refuses the document (Profile documents have no exported codec schema).
      expect(codecAccepts(entityType, document), label).not.toBe(true);
      const operation = create(entityType, randomUUID(), document);
      const response = await pushRejected(
        user.client,
        group([create('axis', randomUUID(), documents.axis()), operation]),
      );
      expect(response, label).toMatchObject({
        code: 'schema_mismatch',
        operationId: operation.operationId,
      });
    }
  });

  it('accepts every form of the parsed fields and cleared lists that the replicas accept', async () => {
    const user = await createTestUser('documents-parsed');
    const profileId = randomUUID();
    const routines = [
      routine({
        rule: {
          version: 1,
          kind: 'weekly_days',
          intervalWeeks: 2,
          weekdays: ['friday', 'monday'],
          startsOn: '2024-02-29',
          endsOn: '2026-12-31',
        },
      }),
      routine({
        rule: {
          version: 1,
          kind: 'weekly_count',
          targetCount: 3,
          weekStart: 'sunday',
          startsOn: '2026-10-01',
        },
      }),
      routine({
        rule: {
          version: 1,
          kind: 'monthly_day',
          intervalMonths: 1,
          dayOfMonth: 31,
          missingDayPolicy: 'last_day',
          startsOn: '2026-10-01',
        },
        schedulingMode: { ...timed, wallTime: '23:59:59', durationMinutes: 1440 },
      }),
      routine({
        schedulingMode: {
          ...timed,
          zonePolicy: { kind: 'fixed_zone', timeZone: 'America/Argentina/Buenos_Aires' },
          gapPolicy: 'shift_forward',
          overlapPolicy: 'later_offset',
        },
      }),
    ];
    const routineId = randomUUID();
    const operations = [
      ...routines.map((document, index) =>
        create('routine', index === 0 ? routineId : randomUUID(), document),
      ),
      create('routine_occurrence', randomUUID(), occurrence({ routineId, override: {} })),
      create(
        'routine_occurrence',
        randomUUID(),
        occurrence({
          routineId,
          periodKey: '2026-10-02',
          period: { kind: 'date', date: '2026-10-02' },
          override: {
            date: '2026-10-03',
            wallTime: '06:15',
            durationMinutes: 45,
            overlapAcknowledged: true,
          },
        }),
      ),
      create(
        'template',
        randomUUID(),
        template({
          version: 2,
          items: [
            { templateKey: 'goal', kind: 'project', title: '  Goal  ', relativeDayOffset: 0 },
            {
              templateKey: 'step',
              kind: 'action',
              parentTemplateKey: 'goal',
              title: 'x'.repeat(200),
              note: 'Note',
              estimateMinutes: 30,
              energy: 'focused',
              priority: 'high',
              relativeDayOffset: -365,
              localStartTime: '09:30',
              durationMinutes: 5,
            },
          ],
        }),
      ),
      create('profile', profileId, documents.profile()),
      create('review', randomUUID(), {
        profileId,
        reviewType: 'daily',
        periodKey: '2026-10-01',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-01',
        clearedLists: ['next_focus'],
        state: 'draft',
      }),
    ];
    for (const operation of operations) {
      expect(codecAccepts(operation.entityType, operation.document), operation.entityType).not.toBe(
        false,
      );
    }
    const accepted = await pushAccepted(user.client, group(operations));
    expect(accepted.acknowledgments).toHaveLength(operations.length);
  });

  it('checks calendar dates, Action instants, and wall times exactly as the client codecs do', () => {
    const dates = ['0000', '0004', '0100', '0400', '1900', '2000', '2023', '2024', '9999'].flatMap(
      (year) =>
        Array.from({ length: 14 }, (_, month) =>
          Array.from({ length: 33 }, (_, day) => `${year}-${two(month)}-${two(day)}`),
        ).flat(),
    );
    dates.push('not-a-date', '2026-1-01', '20261001', '2026-10-01T00:00:00Z', '', '٢٠٢٦-١٠-٠١');
    const dateNode = projectDocumentSchema.shape.targetStart;
    expect(
      disagreements(
        dates,
        serverAccepts('project', ['properties', 'targetStart'], dates),
        (value) => dateNode.safeParse(value).success,
      ),
    ).toEqual([]);

    const instants = ['2024-02-29', '2023-02-29', '2026-10-01', '0000-01-01', '9999-12-31'].flatMap(
      (date) =>
        ['00:00:00', '23:59:59', '24:00:00', '23:60:00', '23:59:60', '9:30:00'].flatMap((time) =>
          ['', '.0', '.000', '.120', '.1234', '.999999999'].flatMap((fraction) =>
            ['Z', 'z', '+00:00', ''].map((zone) => `${date}T${time}${fraction}${zone}`),
          ),
        ),
    );
    instants.push('whenever', '2026-10-01 09:00:00.000Z', '');
    const instantNode = actionCanonicalDocumentSchema.shape.completedAt;
    expect(
      disagreements(
        instants,
        serverAccepts('action', ['properties', 'completedAt'], instants),
        (value) => instantNode.safeParse(value).success,
      ),
    ).toEqual([]);

    const times = Array.from({ length: 26 }, (_, hour) =>
      Array.from({ length: 62 }, (_, minute) => `${two(hour)}:${two(minute)}`),
    ).flat();
    times.push('00:00:00', '23:59:59', '23:59:60', '12:30:5', '7:30', '12.30', '', '12:30:00.000');
    const [availability] = constraintValueSchema.options;
    const timeNode = availability.shape.windows.element.shape.start;
    const windowStart = ['properties', 'value', 'oneOf', 0, 'properties', 'windows', 'items'];
    expect(
      disagreements(
        times,
        serverAccepts('constraint', [...windowStart, 'properties', 'start'], times),
        (value) => timeNode.safeParse(value).success,
      ),
    ).toEqual([]);
  });

  it('checks zone name syntax and non-blank text, and accepts every zone the client knows', () => {
    const zones = [
      ...Intl.supportedValuesOf('timeZone'),
      'UTC',
      'utc',
      'Etc/GMT+5',
      'EST5EDT',
      'America/Port-au-Prince',
      '+05',
      '+0530',
      '-00',
    ];
    const zoneNode = timeBlockDocumentSchema.shape.timeZone;
    expect(zones.filter((zone) => !zoneNode.safeParse(zone).success)).toEqual([]);
    const known = serverAccepts('time_block', ['properties', 'timeZone'], zones);
    expect(zones.filter((_, index) => known[index] !== true)).toEqual([]);
    // Not zone names. Whether a well-formed name exists (`Not/AZone`) stays the client's check, and
    // the server refuses the date-time text Temporal would also read a zone out of; commands store
    // the zone identifier itself.
    const notNames = [
      '',
      'Not a zone',
      'Europe/Berlin ',
      '/Europe/Berlin',
      'Europe//Berlin',
      '+05:30',
    ];
    expect(
      serverAccepts(
        'time_block',
        ['properties', 'timeZone'],
        [...notNames, 'Not/AZone', '2020-01-01T00:00Z'],
      ),
    ).toEqual([...notNames.map(() => false), true, false]);

    const trimmed = [
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
      0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
      0xfeff,
    ].map((codePoint) => String.fromCodePoint(codePoint));
    const texts = [
      ...trimmed,
      trimmed.join(''),
      '',
      'a',
      ' a ',
      '\u3000x\u3000',
      '\u0085',
      '\u180e',
      '\u200b',
      '\u00ad',
      '😀',
    ];
    const titleNode = axisDocumentSchema.shape.title;
    expect(
      disagreements(
        texts,
        serverAccepts('axis', ['properties', 'title'], texts),
        (value) => titleNode.safeParse(value).success,
      ),
    ).toEqual([]);

    const titles = [
      'x',
      ' x ',
      'x'.repeat(200),
      ` ${'x'.repeat(200)} `,
      `\u3000${'x'.repeat(200)}\n`,
      `x${' '.repeat(198)}x`,
      `x${' '.repeat(199)}x`,
      'x'.repeat(201),
      '   ',
      '',
    ];
    const itemTitle = ['properties', 'blueprint', 'oneOf', 0, 'properties', 'items', 'items'];
    expect(
      disagreements(
        titles,
        serverAccepts('template', [...itemTitle, 'properties', 'title'], titles),
        (title) =>
          parseTemplateBlueprint({
            version: 1,
            items: [{ templateKey: 'k', kind: 'action', title }],
          }).ok,
      ),
    ).toEqual([]);
  });
});

describe('canonical JSON', () => {
  it('writes every number as JavaScript does, whatever form it arrived in', () => {
    // Forms `JSON.stringify` never writes; a client reads each one as the nearest double.
    const written = [
      '30.0',
      '1E2',
      '0.10',
      '-0',
      '-0.0',
      '100e-2',
      '0.1e1',
      '1e21',
      '1e-7',
      // On a tie between two doubles: JavaScript writes the shorter form that reads back.
      '7250000000000000000000',
      '-7.25e21',
      '123456789012345678901234567890',
      '9007199254740993',
      '1e400',
      '-1e400',
      '1e-400',
      '2.4703282292062327e-324',
      '2.4703282292062328e-324',
      '1.7976931348623157e308',
      '1.7976931348623158e308',
      '1.7976931348623159e308',
    ];
    const [row] = queryDatabase<{ canonical: string }>(
      `select yelaxis_sync.canonical_json('[${written.join(',')}]'::jsonb) as canonical`,
    );
    expect(row?.canonical).toBe(
      `[${written.map((text) => JSON.stringify(JSON.parse(text))).join(',')}]`,
    );

    // Doubles across the whole range: the shortest digits, positional or exponential.
    const doubles = [0, 1, -1, 0.1, 0.2, 0.3, 1 / 3, Math.PI, 4.35, Number.MIN_VALUE];
    doubles.push(
      Number.MAX_VALUE,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
      2 ** 53,
      2 ** 60,
    );
    for (let exponent = -30; exponent <= 30; exponent += 1) {
      doubles.push(10 ** exponent, 1.5 * 10 ** exponent, -(7.25 * 10 ** exponent));
    }
    const view = new DataView(new ArrayBuffer(8));
    let state = 0x9e3779b97f4a7c15n;
    while (doubles.length < 700) {
      state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      view.setBigUint64(0, state);
      const value = view.getFloat64(0);
      if (Number.isFinite(value)) doubles.push(value);
    }
    const [sampled] = queryDatabase<{ canonical: string }>(
      `select yelaxis_sync.canonical_json(${sqlText(JSON.stringify(doubles))}::jsonb) as canonical`,
    );
    expect(sampled?.canonical).toBe(JSON.stringify(doubles));
  });

  it('hashes the client’s snapshot vectors to the client’s hashes', async () => {
    // The vectors of `protocol.test.ts` and `hasher.test.ts`, shared with the server.
    const vectors: readonly Readonly<Record<string, unknown>>[] = [
      {},
      { title: 'Write the plan', state: 'planned', orderKey: '000000001' },
      { b: 1, a: { d: [3, { z: null, y: 'é' }], c: 'tab\tquote"' }, skipped: undefined },
      { emoji: 'Plan 🌱', unicode: 'naïve – “quotes”', escape: ' line' },
      { nested: [{ k2: 2, k1: 1 }, [true, false, 0.5, -1e-7]] },
      { n: 1.5, m: -0, big: 1e21 },
    ];
    const hashes = queryDatabase<{ hash: string }>(
      `select yelaxis_sync.document_hash(item.value) as hash
         from jsonb_array_elements(${sqlText(JSON.stringify(vectors))}::jsonb)
           with ordinality as item(value, position)
        order by item.position`,
    ).map((row) => row.hash);
    expect(hashes).toEqual(await Promise.all(vectors.map((vector) => clientDocumentHash(vector))));
  });

  it('stores a whole number written with a fraction and hashes it as clients read it back', async () => {
    const user = await createTestUser('documents-fraction');
    const actionId = randomUUID();
    const document = documents.action('Thirty minutes', { estimateMinutes: 30 });
    const request = group([create('action', actionId, document)]);
    const body = JSON.stringify({ request }).replace(
      /"estimateMinutes":30(?=[,}])/u,
      '"estimateMinutes":30.0',
    );
    expect(body).toContain('"estimateMinutes":30.0');
    const response = await rawRpc(user.accessToken, 'sync_push', body);
    expect(response).toMatchObject({ status: 200, data: { status: 'accepted' } });
    // A retry of the same bytes is the same group.
    expect(await rawRpc(user.accessToken, 'sync_push', body)).toEqual(response);

    const [stored] = queryDatabase<{ minutes: string; hash: string }>(
      `select document ->> 'estimateMinutes' as minutes,
              yelaxis_sync.document_hash(document) as hash
         from yelaxis_sync.records
        where owner_id = '${user.id}' and entity_id = '${actionId}'`,
    );
    expect(stored).toEqual({ minutes: '30.0', hash: await clientDocumentHash(document) });

    // A client edits what it read back from its own hash, and the base matches.
    const [pulled] = (await pullAll(user.client)).changes;
    expect(pulled?.document).toEqual(document);
    const edited = await pushAccepted(
      user.client,
      group([
        update('action', actionId, { revision: 1, document }, { ...document, title: 'Edited' }),
      ]),
    );
    expect(edited.acknowledgments[0]?.serverRevision).toBe(2);
  });
});
