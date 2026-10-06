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
  alignmentLinkId,
  createDeletionTombstone,
  ok,
  type AlignmentJoinRelationship,
  type AlignmentLinkEntityType,
  type CommandContext,
  type EntityRef,
  type EntityType,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import type { SqliteParameter } from '../sqlite/driver';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { alignmentLinkTables } from './relationship-codecs';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

/*
 * alignment join-link codecs and the Project target window against real SQLite: strict documents,
 * `deleted_at` as "link inactive", revival, permanent delete with a ledger entry, the database
 * guards, and immediate RESTRICT foreign keys. Synthetic fixtures only.
 */
const now = '2026-09-28T09:00:00.000Z' as Instant;
const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const otherOwnerId = '10000000-0000-4000-8000-000000000002' as OwnerId;
const temporaryDirectories: string[] = [];

type Document = Readonly<Record<string, unknown>>;

const id = (group: number, index: number) =>
  `${group.toString(16).padStart(2, '0')}000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}` as UUID;

const ids = {
  axis: id(0x21, 1),
  outcome: id(0x22, 1),
  otherOutcome: id(0x22, 2),
  project: id(0x23, 1),
  milestone: id(0x24, 1),
  action: id(0x25, 1),
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-relationship-codecs-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(driver, schemaMigrations, () => now);
  const insert = async (table: string, row: Record<string, SqliteParameter>) => {
    const values = { created_at: now, updated_at: now, ...row };
    const columns = Object.keys(values);
    await driver.run(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')});`,
      Object.values(values),
    );
  };
  for (const [owner, profile] of [
    [ownerId, id(0x11, 1)],
    [otherOwnerId, id(0x11, 2)],
  ] as const) {
    await insert('planning_identities', { id: owner, identity_kind: 'local' });
    await insert('profiles', {
      id: profile,
      owner_id: owner,
      planning_time_zone: 'Asia/Tashkent',
      week_start: 'monday',
      time_format: '24_hour',
    });
  }
  await insert('axes', {
    id: ids.axis,
    owner_id: ownerId,
    title: 'Health',
    state: 'active',
    sort_key: 'a',
  });
  for (const outcome of [ids.outcome, ids.otherOutcome]) {
    await insert('outcomes', {
      id: outcome,
      owner_id: ownerId,
      axis_id: ids.axis,
      title: 'Run a 10k',
      success_definition: 'Finish a 10k run',
      state: 'active',
      progress_mode: 'none',
      sort_key: outcome,
    });
  }
  await insert('projects', {
    id: ids.project,
    owner_id: ownerId,
    title: 'Training plan',
    state: 'idea',
    sort_key: 'a',
  });
  await insert('milestones', {
    id: ids.milestone,
    owner_id: ownerId,
    outcome_id: ids.outcome,
    title: 'First 5k',
    measurable_checkpoint: 'Run 5k without stopping',
    state: 'active',
    sort_key: 'a',
  });
  await insert('actions', {
    id: ids.action,
    owner_id: ownerId,
    title: 'Book a track session',
    state: 'planned',
    capture_origin: 'plan',
    sort_key: 'a',
  });

  let counter = 1;
  const nextId = () => id(0x90, counter++);
  const adapters = createSqliteApplicationAdapters(driver, { ownerId });
  const dependencies: ApplicationDependencies = {
    ...adapters,
    ids: { next: nextId },
    clock: { now: () => now },
    projections: { notifyCommitted() {} },
  };

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
            eventType: 'alignment.test_changed',
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
  const applyDirect = (mutation: CanonicalMutation, owner: OwnerId = ownerId) =>
    adapters.unitOfWork.runInTransaction((work) => {
      const context: CommandContext = { ownerId: owner, actor: 'user', commandId: nextId(), now };
      return work.records.apply(mutation, context);
    });

  const row = (table: string, rowId: string) =>
    driver.get<Record<string, SqliteParameter>>(`SELECT * FROM ${table} WHERE id = ?;`, [rowId]);

  return { driver, insert, commit, read, applyDirect, row, nextId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

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

type UpdateMutation = Extract<CanonicalMutation, { readonly operation: 'update' }>;
type DeleteMutation = Extract<CanonicalMutation, { readonly operation: 'delete' }>;

function update(record: CanonicalRecordState, document: Document): UpdateMutation {
  return {
    operation: 'update',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    document,
  };
}

function remove(record: CanonicalRecordState): DeleteMutation {
  return {
    operation: 'delete',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    tombstone: createDeletionTombstone(record.ref, record.localRevision + 1, now),
  };
}

interface LinkCase {
  readonly relationship: AlignmentJoinRelationship;
  readonly parentId: UUID;
  readonly childId: UUID;
  readonly document: Document;
}

const linkCases: readonly LinkCase[] = [
  {
    relationship: 'outcome_secondary_project',
    parentId: ids.outcome,
    childId: ids.project,
    document: { projectId: ids.project, outcomeId: ids.outcome },
  },
  {
    relationship: 'milestone_project',
    parentId: ids.milestone,
    childId: ids.project,
    document: { milestoneId: ids.milestone, projectId: ids.project },
  },
  {
    relationship: 'milestone_action',
    parentId: ids.milestone,
    childId: ids.action,
    document: { milestoneId: ids.milestone, actionId: ids.action },
  },
];

function linkRef(
  relationship: AlignmentJoinRelationship,
  parentId: UUID,
  childId: UUID,
  owner: OwnerId = ownerId,
): EntityRef<AlignmentLinkEntityType> {
  return {
    type: alignmentLinkTables[relationship].entityType,
    id: alignmentLinkId(relationship, parentId, childId),
    ownerId: owner,
  };
}

async function readRequired(context: Fixture, target: EntityRef): Promise<CanonicalRecordState> {
  const record = await context.read(target);
  if (record === null) throw new Error(`Missing ${target.type} ${target.id}`);
  return record;
}

describe('alignment SQLite alignment link codecs', () => {
  it.each(linkCases)(
    'links, unlinks, and revives $relationship with unlinkedAt mirroring deleted_at',
    async ({ relationship, parentId, childId, document }) => {
      const context = await fixture();
      const target = linkRef(relationship, parentId, childId);
      const { table } = alignmentLinkTables[relationship];
      expect(await context.commit([create(target, document)])).toMatchObject({ ok: true });
      const created = await readRequired(context, target);
      expect(created).toMatchObject({ localRevision: 1, serverRevision: 0, document });
      expect(created.document).toEqual(document);
      expect(await context.row(table, target.id)).toMatchObject({
        owner_id: ownerId,
        deleted_at: null,
        client_updated_at: now,
      });

      const unlinked = { ...document, unlinkedAt: now };
      expect(await context.commit([update(created, unlinked)])).toMatchObject({ ok: true });
      const inactive = await readRequired(context, target);
      expect(inactive).toMatchObject({ localRevision: 2, document: unlinked });
      expect(await context.row(table, target.id)).toMatchObject({ deleted_at: now });

      expect(await context.commit([update(inactive, document)])).toMatchObject({ ok: true });
      const revived = await readRequired(context, target);
      expect(revived).toMatchObject({ localRevision: 3 });
      expect(revived.document).toEqual(document);
      expect(await context.row(table, target.id)).toMatchObject({ deleted_at: null });
      // Unlinking never touches either endpoint.
      await expect(
        context.driver.get<{ count: number }>(
          `SELECT (SELECT COUNT(*) FROM outcomes) + (SELECT COUNT(*) FROM projects)
             + (SELECT COUNT(*) FROM milestones) + (SELECT COUNT(*) FROM actions) AS count;`,
        ),
      ).resolves.toEqual({ count: 5 });
      await context.driver.close();
    },
  );

  it('rejects unknown fields, malformed values, a non-derived id, and endpoint changes', async () => {
    const context = await fixture();
    const target = linkRef('milestone_action', ids.milestone, ids.action);
    const document = { milestoneId: ids.milestone, actionId: ids.action };
    await expect(
      context.applyDirect(create(target, { ...document, note: 'private text' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      context.applyDirect(create(target, { ...document, actionId: 'not-a-uuid' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      context.applyDirect(create(target, { ...document, unlinkedAt: 'yesterday' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      context.applyDirect(create({ ...target, id: context.nextId() }, document)),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      context.applyDirect(
        create({ ...target, type: 'milestone_project' }, { ...document, projectId: ids.project }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(context.read(target)).resolves.toBeNull();

    expect(await context.commit([create(target, document)])).toMatchObject({ ok: true });
    const created = await readRequired(context, target);
    const moved = { milestoneId: ids.milestone, actionId: id(0x25, 9) };
    await expect(context.applyDirect(update(created, moved))).rejects.toMatchObject({
      code: 'write_conflict',
    });
    await expect(
      context.applyDirect({ ...update(created, document), expectedRevision: 7 }),
    ).rejects.toMatchObject({ code: 'write_conflict' });

    await context.driver.run(`UPDATE milestone_actions SET deleted_at = 'soon' WHERE id = ?;`, [
      target.id,
    ]);
    await expect(context.read(target)).rejects.toMatchObject({ code: 'invalid_persisted_record' });
    await context.driver.close();
  });

  it('permanently deletes active and unlinked rows with a ledger entry and never recreates them', async () => {
    const context = await fixture();
    const active = linkRef('milestone_project', ids.milestone, ids.project);
    const unlinked = linkRef('milestone_action', ids.milestone, ids.action);
    expect(
      await context.commit([
        create(active, { milestoneId: ids.milestone, projectId: ids.project }),
        create(unlinked, { milestoneId: ids.milestone, actionId: ids.action, unlinkedAt: now }),
      ]),
    ).toMatchObject({ ok: true });
    await context.insert('undo_records', {
      id: id(0x91, 1),
      owner_id: ownerId,
      command_id: id(0x91, 2),
      state: 'available',
      descriptor_schema_version: 1,
      descriptor_payload_json: JSON.stringify({
        commandType: 'planning.restore_v1',
        payload: {},
        expectedRevisions: { [`${ownerId}:milestone_action:${unlinked.id}`]: 1 },
      }),
    });

    const activeRecord = await readRequired(context, active);
    const unlinkedRecord = await readRequired(context, unlinked);
    await expect(
      context.applyDirect({ ...remove(unlinkedRecord), expectedRevision: 3 }),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    await expect(
      context.applyDirect({
        ...remove(unlinkedRecord),
        tombstone: createDeletionTombstone(active, 2, now),
      }),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    expect(await context.commit([remove(activeRecord), remove(unlinkedRecord)])).toMatchObject({
      ok: true,
    });

    await expect(context.read(active)).resolves.toBeNull();
    await expect(context.read(unlinked)).resolves.toBeNull();
    await expect(
      context.driver.all<{ entity_type: string; entity_id: string; local_revision: number }>(
        `SELECT entity_type, entity_id, local_revision FROM deletion_ledger ORDER BY entity_type;`,
      ),
    ).resolves.toEqual([
      { entity_type: 'milestone_action', entity_id: unlinked.id, local_revision: 2 },
      { entity_type: 'milestone_project', entity_id: active.id, local_revision: 2 },
    ]);
    // Earlier link history keeps its type and time with a redacted payload; only the delete
    // events themselves (content-free) remain readable.
    const payloads = await context.driver.all<{ event_type: string; payload_json: string }>(
      `SELECT event_type, payload_json FROM domain_events WHERE entity_id IN (?, ?)
       ORDER BY rowid;`,
      [active.id, unlinked.id],
    );
    expect(payloads.map(({ payload_json }) => payload_json)).toEqual([
      '{}',
      '{}',
      '{"operation":"delete"}',
      '{"operation":"delete"}',
    ]);
    await expect(
      context.driver.get<{ state: string }>('SELECT state FROM undo_records WHERE id = ?;', [
        id(0x91, 1),
      ]),
    ).resolves.toEqual({ state: 'expired' });

    // A deleted pair can never be linked again under the same identity.
    await expect(
      context.applyDirect(create(active, { milestoneId: ids.milestone, projectId: ids.project })),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    expect(
      await context.commit([
        create(unlinked, { milestoneId: ids.milestone, actionId: ids.action }),
      ]),
    ).toMatchObject({ ok: false, error: { code: 'transaction_failed' } });
    await expect(
      context.driver.get<{ count: number }>(
        `SELECT (SELECT COUNT(*) FROM milestone_projects) + (SELECT COUNT(*) FROM milestone_actions)
           AS count;`,
      ),
    ).resolves.toEqual({ count: 0 });
    await context.driver.close();
  });

  it('rolls back a secondary Outcome that equals the primary Outcome, on create and on revive', async () => {
    const context = await fixture();
    const project = await readRequired(context, {
      type: 'project',
      id: ids.project,
      ownerId,
    });
    expect(
      await context.commit([
        update(project, { ...project.document, primaryOutcomeId: ids.outcome }),
      ]),
    ).toMatchObject({ ok: true });
    const same = linkRef('outcome_secondary_project', ids.outcome, ids.project);
    expect(
      await context.commit([create(same, { projectId: ids.project, outcomeId: ids.outcome })]),
    ).toMatchObject({ ok: false, error: { code: 'transaction_failed' } });
    await expect(context.read(same)).resolves.toBeNull();

    const other = linkRef('outcome_secondary_project', ids.otherOutcome, ids.project);
    const otherDocument = { projectId: ids.project, outcomeId: ids.otherOutcome };
    expect(
      await context.commit([create(other, { ...otherDocument, unlinkedAt: now })]),
    ).toMatchObject({ ok: true });
    const primaryNow = await readRequired(context, project.ref);
    expect(
      await context.commit([
        update(primaryNow, { ...primaryNow.document, primaryOutcomeId: ids.otherOutcome }),
      ]),
    ).toMatchObject({ ok: true });
    const inactive = await readRequired(context, other);
    expect(await context.commit([update(inactive, otherDocument)])).toMatchObject({
      ok: false,
      error: { code: 'transaction_failed' },
    });
    await expect(context.read(other)).resolves.toMatchObject({
      localRevision: 1,
      document: { ...otherDocument, unlinkedAt: now },
    });
    await context.driver.close();
  });

  it('checks foreign keys at COMMIT: an inactive link blocks deleting its endpoint unless removed too', async () => {
    const context = await fixture();
    const target = linkRef('milestone_action', ids.milestone, ids.action);
    expect(
      await context.commit([
        create(target, { milestoneId: ids.milestone, actionId: ids.action, unlinkedAt: now }),
      ]),
    ).toMatchObject({ ok: true });
    const action = await readRequired(context, { type: 'action', id: ids.action, ownerId });
    const link = await readRequired(context, target);

    // The row is inactive but still holds the RESTRICT foreign key.
    expect(await context.commit([remove(action)])).toMatchObject({
      ok: false,
      error: { code: 'transaction_failed' },
    });
    await expect(context.read(action.ref)).resolves.not.toBeNull();
    await expect(context.read(target)).resolves.not.toBeNull();

    // The unit of work defers foreign keys (RESTRICT included) to COMMIT, so the order of the
    // deletes inside one command does not matter.
    expect(await context.commit([remove(action), remove(link)])).toMatchObject({ ok: true });
    await expect(context.read(action.ref)).resolves.toBeNull();
    await expect(context.read(target)).resolves.toBeNull();
    await expect(
      context.driver.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM milestones WHERE id = ?;',
        [ids.milestone],
      ),
    ).resolves.toEqual({ count: 1 });
    await context.driver.close();
  });

  it('rolls back an endpoint delete when a referrer appears before it runs', async () => {
    const context = await fixture();
    const outcome = await readRequired(context, { type: 'outcome', id: ids.otherOutcome, ownerId });
    // The preview saw no referrer; a Project names the Outcome before the command runs.
    await context.insert('projects', {
      id: id(0x23, 2),
      owner_id: ownerId,
      primary_outcome_id: ids.otherOutcome,
      title: 'Late referrer',
      state: 'idea',
      sort_key: 'b',
    });
    expect(await context.commit([remove(outcome)])).toMatchObject({
      ok: false,
      error: { code: 'transaction_failed' },
    });
    await expect(context.read(outcome.ref)).resolves.toMatchObject({ localRevision: 1 });
    await expect(
      context.driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM deletion_ledger;'),
    ).resolves.toEqual({ count: 0 });
    await context.driver.close();
  });

  it('scopes link reads and writes to the owning identity', async () => {
    const context = await fixture();
    const target = linkRef('milestone_action', ids.milestone, ids.action);
    expect(
      await context.commit([create(target, { milestoneId: ids.milestone, actionId: ids.action })]),
    ).toMatchObject({ ok: true });
    await expect(context.read({ ...target, ownerId: otherOwnerId })).resolves.toBeNull();
    await expect(
      context.applyDirect(
        create(linkRef('milestone_project', ids.milestone, ids.project, otherOwnerId), {
          milestoneId: ids.milestone,
          projectId: ids.project,
        }),
      ),
    ).rejects.toMatchObject({ code: 'write_conflict' });
    // The composite (owner_id, milestone_id) foreign key rejects another owner's endpoints.
    await expect(
      context.applyDirect(
        create(linkRef('milestone_project', ids.milestone, ids.project, otherOwnerId), {
          milestoneId: ids.milestone,
          projectId: ids.project,
        }),
        otherOwnerId,
      ),
    ).rejects.toThrow();
    await context.driver.close();
  });
});

describe('alignment SQLite Project target window and persisted text', () => {
  it('round-trips, clears, and validates the Project target window', async () => {
    const context = await fixture();
    const project = await readRequired(context, { type: 'project', id: ids.project, ownerId });
    const targeted = {
      ...project.document,
      desiredResult: 'A plan I can follow',
      state: 'active',
      targetStart: '2026-10-01',
      targetEnd: '2026-10-31',
    };
    expect(await context.commit([update(project, targeted)])).toMatchObject({ ok: true });
    const saved = await readRequired(context, project.ref);
    expect(saved.document).toEqual(targeted);
    await expect(context.row('projects', ids.project)).resolves.toMatchObject({
      target_start_date: '2026-10-01',
      target_end_date: '2026-10-31',
    });

    const endOnly: Record<string, unknown> = { ...targeted };
    Reflect.deleteProperty(endOnly, 'targetStart');
    expect(await context.commit([update(saved, endOnly)])).toMatchObject({ ok: true });
    const trimmed = await readRequired(context, project.ref);
    expect(trimmed.document).toEqual(endOnly);

    await expect(
      context.applyDirect(update(trimmed, { ...endOnly, targetStart: '2026-11-01' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await expect(
      context.applyDirect(update(trimmed, { ...endOnly, targetEnd: '2026-02-30' })),
    ).rejects.toMatchObject({ code: 'invalid_canonical_document' });
    await context.driver.close();
  });

  it('decodes and archives persisted rows longer than the alignment input caps', async () => {
    const context = await fixture();
    await context.driver.run('UPDATE axes SET title = ?, purpose = ? WHERE id = ?;', [
      'A'.repeat(300),
      'P'.repeat(5_000),
      ids.axis,
    ]);
    await context.driver.run('UPDATE outcomes SET title = ? WHERE id = ?;', [
      'O'.repeat(500),
      ids.outcome,
    ]);
    await context.driver.run('UPDATE projects SET title = ?, notes = ? WHERE id = ?;', [
      'T'.repeat(500),
      'N'.repeat(20_000),
      ids.project,
    ]);
    const records: [EntityType, UUID][] = [
      ['axis', ids.axis],
      ['outcome', ids.outcome],
      ['project', ids.project],
    ];
    for (const [type, recordId] of records) {
      const record = await readRequired(context, { type, id: recordId, ownerId });
      expect(
        await context.commit([
          update(record, {
            ...record.document,
            state: 'archived',
            stateBeforeArchive: record.document['state'],
            archivedAt: now,
          }),
        ]),
      ).toMatchObject({ ok: true });
      await expect(context.read(record.ref)).resolves.toMatchObject({
        document: { state: 'archived', title: record.document['title'] },
      });
    }
    await context.driver.close();
  });
});
