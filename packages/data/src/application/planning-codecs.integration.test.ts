import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeCommand,
  type ApplicationDependencies,
  type CanonicalMutation,
  type CanonicalRecordState,
} from '@yelaxis/application';
import {
  occurrenceLogicalKey,
  ok,
  routineOccurrenceId,
  type CommandContext,
  type EntityRef,
  type EntityType,
  type GeneratedOccurrencePeriod,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { routineGenerationId } from './routine-codecs';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

const now = '2026-09-27T09:00:00.000Z' as Instant;
const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const otherOwnerId = '10000000-0000-4000-8000-000000000002' as OwnerId;
const profileId = '11000000-0000-4000-8000-000000000001' as UUID;
const temporaryDirectories: string[] = [];

type Document = Readonly<Record<string, unknown>>;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-planning-codecs-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(driver, schemaMigrations, () => now);
  for (const [owner, profile] of [
    [ownerId, profileId],
    [otherOwnerId, '11000000-0000-4000-8000-000000000002'],
  ] as const) {
    await driver.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
       VALUES (?, 'local', ?, ?);`,
      [owner, now, now],
    );
    await driver.run(
      `INSERT INTO profiles (id, owner_id, planning_time_zone, week_start, time_format,
         created_at, updated_at)
       VALUES (?, ?, 'Asia/Tashkent', 'monday', '24_hour', ?, ?);`,
      [profile, owner, now, now],
    );
  }
  let counter = 1;
  const nextId = () => {
    const suffix = counter.toString(16).padStart(12, '0');
    counter += 1;
    return `90000000-0000-4000-8000-${suffix}` as UUID;
  };
  const adapters = createSqliteApplicationAdapters(driver, { ownerId });
  const dependencies: ApplicationDependencies = {
    ...adapters,
    ids: { next: nextId },
    clock: { now: () => now },
    projections: { notifyCommitted() {} },
  };

  const ref = <Type extends EntityType>(type: Type, id: UUID = nextId()): EntityRef<Type> => ({
    type,
    id,
    ownerId,
  });

  /** Commit mutations through the real command pipeline with one minimized event per record. */
  const commit = (mutations: readonly CanonicalMutation[]) =>
    executeCommand(
      dependencies,
      {
        commandId: nextId(),
        ownerId,
        actor: 'user',
        expectedRevisions: mutations.flatMap((mutation) =>
          mutation.operation === 'create'
            ? []
            : [{ ref: mutation.ref, revision: mutation.expectedRevision }],
        ),
        input: {},
      },
      ({ context }) =>
        ok({
          value: mutations,
          touched: mutations.map((mutation) => mutation.ref),
          events: mutations.map((mutation) => ({
            aggregate: mutation.ref,
            eventType: 'planning.test_changed',
            version: 1 as const,
            actor: context.actor,
            commandId: context.commandId,
            occurredAt: context.now,
            payload: { operation: mutation.operation },
          })),
        }),
    );

  const read = (target: EntityRef) =>
    adapters.unitOfWork.runInTransaction((work) => work.records.read(target));

  /** Apply one mutation directly through the codec registry to observe the adapter error. */
  const applyDirect = (mutation: CanonicalMutation) =>
    adapters.unitOfWork.runInTransaction((work) => {
      const context: CommandContext = {
        ownerId,
        actor: 'user',
        commandId: nextId(),
        now,
      };
      return work.records.apply(mutation, context);
    });

  const insertAction = async (id: UUID, state = 'planned', owner: OwnerId = ownerId) => {
    await driver.run(
      `INSERT INTO actions (id, owner_id, title, state, capture_origin, sort_key, created_at,
         updated_at)
       VALUES (?, ?, 'Synthetic Action', ?, 'plan', ?, ?, ?);`,
      [id, owner, state, id, now, now],
    );
  };

  return { driver, dependencies, ref, commit, read, applyDirect, insertAction, nextId };
}

function create(target: EntityRef, document: Document): CanonicalMutation {
  return {
    operation: 'create',
    ref: target,
    expectedRevision: null,
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document,
  };
}

function update(record: CanonicalRecordState, document: Document): CanonicalMutation {
  return {
    operation: 'update',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    document,
  };
}

async function count(driver: NodeSqliteDriver, table: string): Promise<number> {
  const row = await driver.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table};`);
  return row?.count ?? -1;
}

const weeklyRule = {
  version: 1,
  kind: 'weekly_days',
  intervalWeeks: 1,
  weekdays: ['monday', 'wednesday'],
  startsOn: '2026-09-28',
};
const timedMode = {
  kind: 'time_specific',
  wallTime: '07:30',
  durationMinutes: 30,
  zonePolicy: { kind: 'fixed_zone', timeZone: 'Asia/Tashkent' },
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
};

function routineDocument(generations: readonly Document[]): Document {
  return {
    title: 'Morning walk',
    description: 'Around the park',
    orderKey: 'a0',
    state: 'active',
    generations,
  };
}

describe('planning SQLite canonical codecs', () => {
  it('round-trips Time Blocks for every target kind', async () => {
    const { commit, read, ref, insertAction, driver } = await fixture();
    const actionId = '20000000-0000-4000-8000-000000000001' as UUID;
    await insertAction(actionId);
    const commitmentRef = ref('commitment');
    const commitment = { title: 'Dentist', strength: 'hard', state: 'planned' };
    const routineRef = ref('routine');
    const period = { kind: 'date', date: '2026-09-28' } as const;
    const occurrenceRef = ref(
      'routine_occurrence',
      routineOccurrenceId(
        occurrenceLogicalKey(routineRef.id, 1, period as GeneratedOccurrencePeriod),
      ),
    );
    expect(
      await commit([
        create(commitmentRef, commitment),
        create(
          routineRef,
          routineDocument([{ generation: 1, rule: weeklyRule, schedulingMode: timedMode }]),
        ),
        create(occurrenceRef, {
          routineId: routineRef.id,
          generation: 1,
          periodKey: '2026-09-28',
          period,
          state: 'planned',
        }),
      ]),
    ).toMatchObject({ ok: true });

    const targets = [
      { kind: 'action', actionId },
      { kind: 'commitment', commitmentId: commitmentRef.id },
      { kind: 'routine_occurrence', routineOccurrenceId: occurrenceRef.id },
      { kind: 'custom', title: 'Focus time' },
    ];
    for (const [index, target] of targets.entries()) {
      const blockRef = ref('time_block');
      const document = {
        target,
        startsAt: `2026-09-28T0${String(index)}:00:00.000Z`,
        endsAt: `2026-09-28T0${String(index)}:45:00.000Z`,
        timeZone: 'Asia/Tashkent',
        state: 'planned',
        overlapAcknowledged: index % 2 === 0,
      };
      expect(await commit([create(blockRef, document)])).toMatchObject({ ok: true });
      const saved = await read(blockRef);
      expect(saved?.document).toEqual(document);
      const completed = { ...document, state: 'completed' };
      expect(await commit([update(saved!, completed)])).toMatchObject({ ok: true });
      expect((await read(blockRef))?.document).toEqual(completed);
    }
    expect(await read(commitmentRef)).toMatchObject({ document: commitment, localRevision: 1 });
    const clientUpdated = await driver.all<{ client_updated_at: string | null }>(
      'SELECT client_updated_at FROM time_blocks;',
    );
    expect(clientUpdated.every((row) => row.client_updated_at === now)).toBe(true);
  });

  it('supersedes an Action block before creating its replacement, never the reverse', async () => {
    const { commit, read, ref, insertAction, driver } = await fixture();
    const actionId = '20000000-0000-4000-8000-000000000002' as UUID;
    await insertAction(actionId, 'scheduled');
    const oldRef = ref('time_block');
    const base = {
      target: { kind: 'action', actionId },
      startsAt: '2026-09-28T04:00:00.000Z',
      endsAt: '2026-09-28T05:00:00.000Z',
      timeZone: 'Asia/Tashkent',
      state: 'planned',
      overlapAcknowledged: false,
    };
    expect(await commit([create(oldRef, base)])).toMatchObject({ ok: true });
    const old = await read(oldRef);

    const newRef = ref('time_block');
    const moved = {
      ...base,
      startsAt: '2026-09-28T08:00:00.000Z',
      endsAt: '2026-09-28T09:00:00.000Z',
    };
    expect(
      await commit([
        update(old!, { ...base, state: 'canceled', supersededById: newRef.id }),
        create(newRef, moved),
      ]),
    ).toMatchObject({ ok: true });
    expect((await read(oldRef))?.document).toMatchObject({
      state: 'canceled',
      supersededById: newRef.id,
    });
    expect((await read(newRef))?.document).toEqual(moved);

    const before = {
      blocks: await count(driver, 'time_blocks'),
      events: await count(driver, 'domain_events'),
      receipts: await count(driver, 'command_receipts'),
    };
    const current = await read(newRef);
    const thirdRef = ref('time_block');
    // Creating the replacement first collides with the one-planned-block-per-Action index.
    expect(
      await commit([
        create(thirdRef, moved),
        update(current!, { ...moved, state: 'canceled', supersededById: thirdRef.id }),
      ]),
    ).toEqual({ ok: false, error: { code: 'transaction_failed' } });
    expect({
      blocks: await count(driver, 'time_blocks'),
      events: await count(driver, 'domain_events'),
      receipts: await count(driver, 'command_receipts'),
    }).toEqual(before);
    expect(await read(newRef)).toMatchObject({ localRevision: 1, document: moved });

    // Deferred foreign keys are still enforced at COMMIT: a dangling replacement id fails.
    expect(
      await commit([
        update(current!, {
          ...moved,
          state: 'canceled',
          supersededById: '90000000-0000-4000-8000-0000000fffff',
        }),
      ]),
    ).toEqual({ ok: false, error: { code: 'transaction_failed' } });
    expect(await read(newRef)).toMatchObject({ localRevision: 1, document: moved });
    await expect(
      driver.get<{ defer_foreign_keys: number }>('PRAGMA defer_foreign_keys;'),
    ).resolves.toEqual({ defer_foreign_keys: 0 });
  });

  it('keeps Commitments free of block pointers and rejects unknown fields', async () => {
    const { applyDirect, ref, read } = await fixture();
    const commitmentRef = ref('commitment');
    await expect(
      applyDirect(
        create(commitmentRef, {
          title: 'Call',
          strength: 'soft',
          state: 'planned',
          currentTimeBlockId: '90000000-0000-4000-8000-0000000fffff',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    const archived = {
      title: 'Call',
      strength: 'soft',
      state: 'archived',
      stateBeforeArchive: 'planned',
      archivedAt: now,
    };
    await applyDirect(create(commitmentRef, archived));
    expect((await read(commitmentRef))?.document).toEqual(archived);
  });

  it('persists Routine generations, splits them, retires only history-free trailing ones, and rejects gaps', async () => {
    const { commit, read, ref, applyDirect, driver } = await fixture();
    const routineRef = ref('routine');
    const first = { generation: 1, rule: weeklyRule, schedulingMode: timedMode };
    const initial = routineDocument([first]);
    expect(await commit([create(routineRef, initial)])).toMatchObject({ ok: true });
    expect((await read(routineRef))?.document).toEqual(initial);

    const closed = { ...first, rule: { ...weeklyRule, endsOn: '2026-10-11' } };
    const second = {
      generation: 2,
      rule: { version: 1, kind: 'daily', intervalDays: 2, startsOn: '2026-10-12' },
      schedulingMode: { kind: 'day_flexible' },
    };
    const split = { ...initial, generations: [closed, second] };
    const current = await read(routineRef);
    expect(await commit([update(current!, split)])).toMatchObject({ ok: true });
    const saved = await read(routineRef);
    expect(saved).toMatchObject({ localRevision: 2, document: split });

    const rows = await driver.all<{
      id: string;
      generation: number;
      starts_on: string;
      ends_on: string | null;
      wall_time: string | null;
      zone_policy: string | null;
      anchor_time_zone: string | null;
      local_revision: number;
    }>(
      `SELECT id, generation, starts_on, ends_on, wall_time, zone_policy, anchor_time_zone,
              local_revision
       FROM routine_generations ORDER BY generation;`,
    );
    expect(rows).toEqual([
      {
        id: routineGenerationId(routineRef.id, 1),
        generation: 1,
        starts_on: '2026-09-28',
        ends_on: '2026-10-11',
        wall_time: '07:30',
        zone_policy: 'fixed_zone',
        anchor_time_zone: 'Asia/Tashkent',
        local_revision: 2,
      },
      {
        id: routineGenerationId(routineRef.id, 2),
        generation: 2,
        starts_on: '2026-10-12',
        ends_on: null,
        wall_time: null,
        zone_policy: null,
        anchor_time_zone: null,
        local_revision: 1,
      },
    ]);

    await expect(
      applyDirect(
        update(saved!, { ...split, generations: [closed, { ...second, generation: 3 }] }),
      ),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    await expect(
      applyDirect(
        update(saved!, {
          ...split,
          generations: [
            closed,
            {
              ...second,
              rule: {
                version: 1,
                kind: 'weekly_count',
                targetCount: 2,
                weekStart: 'monday',
                startsOn: '2026-10-12',
              },
              schedulingMode: timedMode,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    expect(await read(routineRef)).toMatchObject({ localRevision: 2, document: split });

    // The exact undo of a split may retire the trailing generation while it has no occurrence
    // history; a later split revives the same derived row instead of duplicating it.
    expect(await commit([update(saved!, initial)])).toMatchObject({ ok: true });
    const retired = await read(routineRef);
    expect(retired).toMatchObject({ localRevision: 3, document: initial });
    await expect(
      driver.get(
        'SELECT deleted_at IS NOT NULL AS retired FROM routine_generations WHERE generation = 2;',
      ),
    ).resolves.toEqual({ retired: 1 });
    expect(await commit([update(retired!, split)])).toMatchObject({ ok: true });
    const revived = await read(routineRef);
    expect(revived).toMatchObject({ localRevision: 4, document: split });
    await expect(
      driver.get('SELECT COUNT(*) AS count FROM routine_generations WHERE deleted_at IS NULL;'),
    ).resolves.toEqual({ count: 2 });

    // Once the later generation has occurrence history it can no longer be retired.
    const period = { kind: 'date', date: '2026-10-12' } as const;
    expect(
      await commit([
        create(
          ref(
            'routine_occurrence',
            routineOccurrenceId(
              occurrenceLogicalKey(routineRef.id, 2, period as GeneratedOccurrencePeriod),
            ),
          ),
          {
            routineId: routineRef.id,
            generation: 2,
            periodKey: '2026-10-12',
            period,
            state: 'skipped',
          },
        ),
      ]),
    ).toMatchObject({ ok: true });
    await expect(
      applyDirect(update(revived!, { ...split, generations: [closed] })),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    expect(await read(routineRef)).toMatchObject({ localRevision: 4, document: split });
  });

  it('round-trips occurrence overrides and rejects ids that differ from the logical key', async () => {
    const { commit, read, ref, applyDirect } = await fixture();
    const routineRef = ref('routine');
    await commit([
      create(
        routineRef,
        routineDocument([
          { generation: 1, rule: weeklyRule, schedulingMode: { kind: 'day_flexible' } },
        ]),
      ),
    ]);
    const period = { kind: 'date', date: '2026-09-30' } as const;
    const occurrenceRef = ref(
      'routine_occurrence',
      routineOccurrenceId(
        occurrenceLogicalKey(routineRef.id, 1, period as GeneratedOccurrencePeriod),
      ),
    );
    const document = {
      routineId: routineRef.id,
      generation: 1,
      periodKey: '2026-09-30',
      period,
      state: 'completed',
      override: {
        date: '2026-10-01',
        wallTime: '18:15',
        durationMinutes: 40,
        overlapAcknowledged: true,
      },
      completedAt: now,
    };
    expect(await commit([create(occurrenceRef, document)])).toMatchObject({ ok: true });
    expect((await read(occurrenceRef))?.document).toEqual(document);
    const reopened = { ...document, state: 'planned' };
    Reflect.deleteProperty(reopened, 'completedAt');
    const saved = await read(occurrenceRef);
    expect(await commit([update(saved!, reopened)])).toMatchObject({ ok: true });
    expect((await read(occurrenceRef))?.document).toEqual(reopened);

    await expect(
      applyDirect(create(ref('routine_occurrence'), { ...document, override: undefined })),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    await expect(
      applyDirect(create(ref('routine_occurrence'), { ...document, periodKey: '2026-10-01' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      applyDirect(update((await read(occurrenceRef))!, { ...reopened, override: { extra: true } })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
  });

  it('enforces weekly-count occurrence counts in the codec and the table', async () => {
    const { commit, read, ref, applyDirect } = await fixture();
    const routineRef = ref('routine');
    const rule = {
      version: 1,
      kind: 'weekly_count',
      targetCount: 3,
      weekStart: 'monday',
      startsOn: '2026-09-28',
    };
    await commit([
      create(
        routineRef,
        routineDocument([{ generation: 1, rule, schedulingMode: { kind: 'day_flexible' } }]),
      ),
    ]);
    const period = {
      kind: 'week',
      start: '2026-09-28',
      end: '2026-10-04',
      weekStart: 'monday',
      targetCount: 3,
    } as const;
    const occurrenceRef = ref(
      'routine_occurrence',
      routineOccurrenceId(
        occurrenceLogicalKey(routineRef.id, 1, period as GeneratedOccurrencePeriod),
      ),
    );
    const planned = {
      routineId: routineRef.id,
      generation: 1,
      periodKey: '2026-09-28/2026-10-04/monday',
      period,
      state: 'planned',
      targetCount: 3,
      completedCount: 1,
    };
    expect(await commit([create(occurrenceRef, planned)])).toMatchObject({ ok: true });
    expect((await read(occurrenceRef))?.document).toEqual(planned);

    let current = await read(occurrenceRef);
    // Completed below the target violates the table CHECK.
    await expect(
      applyDirect(update(current!, { ...planned, state: 'completed', completedCount: 2 })),
    ).rejects.toThrow();
    // Above the target without explicit confirmation also violates it.
    await expect(
      applyDirect(update(current!, { ...planned, state: 'completed', completedCount: 4 })),
    ).rejects.toThrow();
    // A target count different from the period is rejected before SQL.
    await expect(
      applyDirect(update(current!, { ...planned, targetCount: 2 })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });

    const extra = {
      ...planned,
      state: 'completed',
      completedCount: 4,
      extraCompletionsConfirmed: true,
      completedAt: now,
    };
    expect(await commit([update(current!, extra)])).toMatchObject({ ok: true });
    current = await read(occurrenceRef);
    expect(current?.document).toEqual(extra);
  });

  it('round-trips Routine Action defaults', async () => {
    const { commit, read, ref, driver } = await fixture();
    const routineRef = ref('routine');
    await commit([
      create(
        routineRef,
        routineDocument([
          { generation: 1, rule: weeklyRule, schedulingMode: { kind: 'day_flexible' } },
        ]),
      ),
    ]);
    const projectId = '30000000-0000-4000-8000-000000000001';
    await driver.run(
      `INSERT INTO projects (id, owner_id, title, state, sort_key, created_at, updated_at)
       VALUES (?, ?, 'Garden', 'idea', 'a', ?, ?);`,
      [projectId, ownerId, now, now],
    );
    const defaultsRef = ref('routine_action_defaults');
    const defaults = {
      routineId: routineRef.id,
      generation: 1,
      projectId,
      note: 'Bring water',
      estimateMinutes: 25,
      energy: 'focused',
      priority: 'high',
    };
    expect(await commit([create(defaultsRef, defaults)])).toMatchObject({ ok: true });
    expect((await read(defaultsRef))?.document).toEqual(defaults);
    const saved = await read(defaultsRef);
    const lighter = { routineId: routineRef.id, generation: 1, energy: 'low' };
    expect(await commit([update(saved!, lighter)])).toMatchObject({ ok: true });
    expect((await read(defaultsRef))?.document).toEqual(lighter);
  });

  it('stores version 1 and version 2 template blueprints in the version-1 envelope', async () => {
    const { commit, read, ref, driver, applyDirect } = await fixture();
    const v1Ref = ref('template');
    const v1 = {
      title: 'Launch',
      blueprint: {
        version: 1,
        items: [
          { templateKey: 'project', kind: 'project', title: 'Launch site' },
          {
            templateKey: 'draft',
            kind: 'action',
            parentTemplateKey: 'project',
            title: 'Draft copy',
            estimateMinutes: 30,
          },
        ],
      },
      state: 'active',
    };
    const v2Ref = ref('template');
    const v2 = {
      title: 'Week start',
      blueprint: {
        version: 2,
        items: [
          {
            templateKey: 'plan',
            kind: 'action',
            title: 'Plan the week',
            relativeDayOffset: 0,
            localStartTime: '09:00',
            durationMinutes: 30,
          },
        ],
      },
      state: 'active',
    };
    expect(await commit([create(v1Ref, v1), create(v2Ref, v2)])).toMatchObject({ ok: true });
    expect((await read(v1Ref))?.document).toEqual(v1);
    expect((await read(v2Ref))?.document).toEqual(v2);
    await expect(
      driver.all<{ template_schema_version: number }>(
        'SELECT template_schema_version FROM templates ORDER BY id;',
      ),
    ).resolves.toEqual([{ template_schema_version: 1 }, { template_schema_version: 1 }]);

    const archived = { ...v1, state: 'archived', stateBeforeArchive: 'active', archivedAt: now };
    expect(await commit([update((await read(v1Ref))!, archived)])).toMatchObject({ ok: true });
    expect((await read(v1Ref))?.document).toEqual(archived);

    await expect(
      applyDirect(create(ref('template'), { ...v2, description: 'Not a column' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      applyDirect(
        create(ref('template'), {
          ...v1,
          blueprint: { version: 1, items: [{ ...v2.blueprint.items[0] }] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await driver.run('UPDATE templates SET template_payload_json = ? WHERE id = ?;', [
      '{"version":3,"items":[]}',
      v2Ref.id,
    ]);
    await expect(read(v2Ref)).rejects.toMatchObject({ code: 'invalid_persisted_record' });
  });

  it('round-trips every Constraint kind and rejects invalid values', async () => {
    const { commit, read, ref, applyDirect, driver } = await fixture();
    const contextId = '40000000-0000-4000-8000-000000000001';
    await driver.run(
      `INSERT INTO contexts (id, owner_id, category, context_key, value_text, source,
         sensitivity, strength, state, created_at, updated_at)
       VALUES (?, ?, 'availability', 'work_hours', 'Office hours', 'user', 'normal', 'soft',
         'active', ?, ?);`,
      [contextId, ownerId, now, now],
    );
    const documents = [
      {
        contextId,
        constraintKind: 'availability',
        strength: 'soft',
        value: {
          kind: 'availability',
          windows: [
            { weekday: 'monday', start: '09:00', end: '12:00' },
            { weekday: 'monday', start: '13:00', end: '17:30' },
            { weekday: 'friday', start: '18:00', end: '00:00' },
          ],
        },
        state: 'active',
      },
      {
        constraintKind: 'capacity',
        strength: 'hard',
        value: { kind: 'capacity', period: 'week', minutes: 1_200 },
        state: 'active',
      },
      {
        constraintKind: 'protected_interval',
        strength: 'hard',
        value: {
          kind: 'protected_interval',
          interval: {
            startsAt: '2026-10-01T10:00:00.000Z',
            endsAt: '2026-10-01T12:00:00.000Z',
            timeZone: 'Asia/Tashkent',
          },
        },
        state: 'archived',
        stateBeforeArchive: 'active',
        archivedAt: now,
      },
      {
        constraintKind: 'other',
        strength: 'unknown',
        value: { kind: 'other', description: 'Quiet evenings' },
        state: 'active',
      },
    ];
    const refs = documents.map(() => ref('constraint'));
    expect(
      await commit(documents.map((document, index) => create(refs[index]!, document))),
    ).toMatchObject({ ok: true });
    for (const [index, document] of documents.entries()) {
      expect((await read(refs[index]!))?.document).toEqual(document);
    }
    const invalid = [
      {
        ...documents[0],
        value: {
          kind: 'availability',
          windows: [{ weekday: 'monday', start: '12:00', end: '09:00' }],
        },
      },
      {
        ...documents[0],
        value: {
          kind: 'availability',
          windows: [{ weekday: 'monday', start: '00:00', end: '00:00' }],
        },
      },
      { ...documents[1], value: { kind: 'capacity', period: 'day', minutes: -1 } },
      { ...documents[1], constraintKind: 'availability' },
      { ...documents[3], value: { kind: 'other', description: '   ' } },
    ];
    for (const document of invalid) {
      await expect(applyDirect(create(ref('constraint'), document))).rejects.toMatchObject({
        code: 'invalid_canonical_document',
      });
    }
  });

  it('sets, replaces, and archives Month themes and Year directions', async () => {
    const { commit, read, ref, applyDirect, driver } = await fixture();
    const themeRef = ref('theme');
    const theme = { profileId, month: '2026-10', text: 'Finish the garden' };
    const directionRef = ref('direction');
    const direction = { profileId, year: '2026', text: 'Calmer weeks' };
    expect(await commit([create(themeRef, theme), create(directionRef, direction)])).toMatchObject({
      ok: true,
    });
    expect((await read(themeRef))?.document).toEqual(theme);
    expect((await read(directionRef))?.document).toEqual(direction);
    await expect(
      driver.get<{ client_updated_at: string }>('SELECT client_updated_at FROM month_themes;'),
    ).resolves.toEqual({ client_updated_at: now });

    const replaced = { ...theme, text: 'x'.repeat(2_000) };
    expect(await commit([update((await read(themeRef))!, replaced)])).toMatchObject({ ok: true });
    const cleared = { ...replaced, archivedAt: now };
    expect(await commit([update((await read(themeRef))!, cleared)])).toMatchObject({ ok: true });
    expect(await read(themeRef)).toMatchObject({ localRevision: 3, document: cleared });

    await expect(
      applyDirect(create(ref('theme'), { ...theme, text: 'x'.repeat(2_001) })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      applyDirect(create(ref('theme'), { ...theme, month: '2026-13' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      applyDirect(create(ref('direction'), { ...direction, text: '  ' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
  });

  it('creates and archives week commitments and still decodes onboarding selections', async () => {
    const { commit, read, ref, insertAction, driver, applyDirect } = await fixture();
    const actionId = '20000000-0000-4000-8000-000000000003' as UUID;
    await insertAction(actionId);
    const projectId = '30000000-0000-4000-8000-000000000002';
    await driver.run(
      `INSERT INTO projects (id, owner_id, title, state, sort_key, created_at, updated_at)
       VALUES (?, ?, 'Garden', 'idea', 'a', ?, ?);`,
      [projectId, ownerId, now, now],
    );
    const onboardingWeek = '24000000-0000-4000-8000-000000000001' as UUID;
    const onboardingDay = '23000000-0000-4000-8000-000000000001' as UUID;
    await driver.run(
      `INSERT INTO week_selections (id, owner_id, profile_id, action_id, period_start_date,
         period_end_date, week_start, sort_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-09-21', '2026-09-27', 'monday', 'a', ?, ?);`,
      [onboardingWeek, ownerId, profileId, actionId, now, now],
    );
    await driver.run(
      `INSERT INTO focus_selections (id, owner_id, profile_id, action_id, local_date, sort_key,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-09-27', 'a', ?, ?);`,
      [onboardingDay, ownerId, profileId, actionId, now, now],
    );
    expect((await read(ref('focus_selection', onboardingWeek)))?.document).toEqual({
      kind: 'week_commitment',
      profileId,
      target: { kind: 'action', actionId },
      periodStart: '2026-09-21',
      periodEnd: '2026-09-27',
      weekStart: 'monday',
      orderKey: 'a',
    });
    expect((await read(ref('focus_selection', onboardingDay)))?.document).toEqual({
      kind: 'day_focus',
      profileId,
      target: { kind: 'action', actionId },
      periodStart: '2026-09-27',
      periodEnd: '2026-09-27',
      orderKey: 'a',
    });

    const weekRef = ref('focus_selection');
    const week = {
      kind: 'week_commitment',
      profileId,
      target: { kind: 'project', projectId },
      periodStart: '2026-09-28',
      periodEnd: '2026-10-04',
      weekStart: 'monday',
      orderKey: 'b',
    };
    const dayRef = ref('focus_selection');
    const day = {
      kind: 'day_focus',
      profileId,
      target: { kind: 'action', actionId },
      periodStart: '2026-09-28',
      periodEnd: '2026-09-28',
      orderKey: 'a',
    };
    expect(await commit([create(weekRef, week), create(dayRef, day)])).toMatchObject({ ok: true });
    expect((await read(weekRef))?.document).toEqual(week);
    expect((await read(dayRef))?.document).toEqual(day);
    const archived = { ...week, archivedAt: now };
    expect(await commit([update((await read(weekRef))!, archived)])).toMatchObject({ ok: true });
    expect((await read(weekRef))?.document).toEqual(archived);
    await expect(
      driver.get<{ archived_at: string }>('SELECT archived_at FROM week_selections WHERE id = ?;', [
        weekRef.id,
      ]),
    ).resolves.toEqual({ archived_at: now });

    await expect(
      applyDirect(
        create(ref('focus_selection'), { ...day, target: { kind: 'project', projectId } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      applyDirect(create(ref('focus_selection'), { ...week, weekStart: undefined })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
  });

  it('round-trips Axes, Outcomes, and Milestones', async () => {
    const { commit, read, ref, applyDirect } = await fixture();
    const axisRef = ref('axis');
    const axis = {
      title: 'Health',
      purpose: 'Feel steady',
      color: 'green',
      icon: 'leaf',
      orderKey: 'a',
      state: 'active',
    };
    const outcomeRef = ref('outcome');
    const outcome = {
      title: 'Run a 10k',
      successDefinition: 'Finish a 10k run',
      axisId: axisRef.id,
      progress: { mode: 'manual', percentage: 40 },
      targetStart: '2026-10-01',
      targetEnd: '2026-12-31',
      orderKey: 'a',
      state: 'active',
    };
    const milestoneRef = ref('milestone');
    const milestone = {
      title: 'First 5k',
      measurableCheckpoint: 'Run 5k without stopping',
      outcomeId: outcomeRef.id,
      targetEnd: '2026-10-31',
      orderKey: 'a',
      state: 'active',
    };
    expect(
      await commit([
        create(axisRef, axis),
        create(outcomeRef, outcome),
        create(milestoneRef, milestone),
      ]),
    ).toMatchObject({ ok: true });
    expect((await read(axisRef))?.document).toEqual(axis);
    expect((await read(outcomeRef))?.document).toEqual(outcome);
    expect((await read(milestoneRef))?.document).toEqual(milestone);

    const derived = { ...outcome, progress: { mode: 'milestone_derived' } };
    Reflect.deleteProperty(derived, 'targetStart');
    expect(await commit([update((await read(outcomeRef))!, derived)])).toMatchObject({ ok: true });
    expect((await read(outcomeRef))?.document).toEqual(derived);
    const done = {
      ...milestone,
      state: 'archived',
      stateBeforeArchive: 'completed',
      archivedAt: now,
    };
    expect(await commit([update((await read(milestoneRef))!, done)])).toMatchObject({ ok: true });
    expect((await read(milestoneRef))?.document).toEqual(done);

    await expect(
      applyDirect(create(ref('outcome'), { ...outcome, targetStart: '2027-01-01' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      applyDirect(
        create(ref('outcome'), { ...outcome, progress: { mode: 'manual', percentage: 101 } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      applyDirect(create(ref('axis'), { ...axis, state: 'archived' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
  });

  it('never recreates a permanently deleted identity', async () => {
    const { applyDirect, ref, driver, read } = await fixture();
    const cases: [EntityType, Document][] = [
      [
        'template',
        {
          title: 'Gone',
          blueprint: { version: 1, items: [{ templateKey: 'a', kind: 'action', title: 'A' }] },
          state: 'active',
        },
      ],
      [
        'constraint',
        {
          constraintKind: 'other',
          strength: 'soft',
          value: { kind: 'other', description: 'Gone' },
          state: 'active',
        },
      ],
      ['theme', { profileId, month: '2026-11', text: 'Gone' }],
      ['axis', { title: 'Gone', orderKey: 'a', state: 'active' }],
      ['commitment', { title: 'Gone', strength: 'soft', state: 'planned' }],
      [
        'routine',
        routineDocument([
          { generation: 1, rule: weeklyRule, schedulingMode: { kind: 'day_flexible' } },
        ]),
      ],
    ];
    for (const [type, document] of cases) {
      const target = ref(type);
      await driver.run(
        `INSERT INTO deletion_ledger (id, owner_id, entity_type, entity_id, local_revision,
           deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 2, ?, ?, ?);`,
        [`${ownerId}:${type}:${target.id}`, ownerId, type, target.id, now, now, now],
      );
      await expect(applyDirect(create(target, document))).rejects.toMatchObject({
        code: 'write_conflict',
      });
      await expect(read(target)).resolves.toBeNull();
    }
  });

  it('scopes reads and writes to the owning identity', async () => {
    const { applyDirect, read, driver } = await fixture();
    const foreignAction = '20000000-0000-4000-8000-0000000000ff' as UUID;
    await driver.run(
      `INSERT INTO actions (id, owner_id, title, state, capture_origin, sort_key, created_at,
         updated_at)
       VALUES (?, ?, 'Other owner', 'planned', 'plan', 'a', ?, ?);`,
      [foreignAction, otherOwnerId, now, now],
    );
    const blockRef: EntityRef<'time_block'> = {
      type: 'time_block',
      id: '90000000-0000-4000-8000-0000000000aa' as UUID,
      ownerId,
    };
    // The composite (owner_id, action_id) foreign key rejects a cross-owner target at COMMIT.
    await expect(
      applyDirect(
        create(blockRef, {
          target: { kind: 'action', actionId: foreignAction },
          startsAt: '2026-09-28T04:00:00.000Z',
          endsAt: '2026-09-28T05:00:00.000Z',
          timeZone: 'Asia/Tashkent',
          state: 'planned',
          overlapAcknowledged: false,
        }),
      ),
    ).rejects.toThrow();
    await expect(read(blockRef)).resolves.toBeNull();
    await expect(
      applyDirect(
        create(
          {
            type: 'commitment',
            id: '90000000-0000-4000-8000-0000000000ab' as UUID,
            ownerId: otherOwnerId,
          },
          { title: 'Other', strength: 'soft', state: 'planned' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'write_conflict' });
  });
});
