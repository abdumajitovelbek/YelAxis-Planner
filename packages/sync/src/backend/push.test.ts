import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { syncEntityTypes, type PushOperation, type SyncEntityType } from '../protocol';
import { codecAccepts } from './record-codecs';
import {
  accountStatus,
  canonicalJson,
  create,
  createTestUser,
  deleteTestUsers,
  documentHash,
  documents,
  group,
  openConflicts,
  ownerRowCounts,
  pullAll,
  push,
  pushAccepted,
  pushConflict,
  pushRejected,
  queryDatabase,
  remove,
  rpc,
  update,
  type Document,
} from './stack';

type Operation = Omit<PushOperation, 'sequence'>;

function first<Item>(items: readonly Item[]): Item {
  const [item] = items;
  if (item === undefined) throw new Error('Expected at least one item.');
  return item;
}

function omit(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

afterAll(async () => {
  await deleteTestUsers();
});

describe('sync_push acceptance', () => {
  it('applies a group in order and acknowledges every operation with its new revision', async () => {
    const user = await createTestUser('push-accept');
    const outcomeId = randomUUID();
    const milestoneId = randomUUID();
    const actionId = randomUUID();
    const linkId = randomUUID();
    const request = group([
      create('outcome', outcomeId, documents.outcome()),
      create('milestone', milestoneId, documents.milestone(outcomeId)),
      create('action', actionId, documents.action()),
      create('milestone_action', linkId, documents.milestoneAction(milestoneId, actionId)),
    ]);
    const response = await pushAccepted(user.client, request);
    expect(response.mutationGroupId).toBe(request.mutationGroupId);
    expect(response.acknowledgments).toEqual(
      request.operations.map((operation) => ({
        operationId: operation.operationId,
        entityType: operation.entityType,
        entityId: operation.entityId,
        serverRevision: 1,
      })),
    );
    const { changes, cursor } = await pullAll(user.client);
    expect(changes.map((change) => change.entityId)).toEqual([
      outcomeId,
      milestoneId,
      actionId,
      linkId,
    ]);
    expect(cursor).toBe(response.cursor);
    expect(ownerRowCounts(user.id)).toMatchObject({
      records: 4,
      change_log: 4,
      idempotency_receipts: 4,
      replicas: 2,
    });
  });

  it('accepts a codec-shaped document of every syncable entity type', async () => {
    const user = await createTestUser('push-every-type');
    const id = () => randomUUID();
    const profileId = id();
    const axisId = id();
    const outcomeId = id();
    const secondOutcomeId = id();
    const milestoneId = id();
    const projectId = id();
    const actionId = id();
    const routineId = id();
    const occurrenceId = id();
    const reviewId = id();
    const canceledBlockId = id();
    const blockId = id();
    const contextId = id();
    const operations: Operation[] = [
      create('profile', profileId, documents.profile()),
      create('axis', axisId, documents.axis()),
      create('outcome', outcomeId, { ...documents.outcome(), axisId }),
      create('outcome', secondOutcomeId, documents.outcome('Second outcome')),
      create('milestone', milestoneId, documents.milestone(outcomeId)),
      create('project', projectId, {
        title: 'Project',
        desiredResult: 'Result',
        axisId,
        primaryOutcomeId: outcomeId,
        targetStart: '2026-10-01',
        targetEnd: '2026-12-31',
        orderKey: 'a0',
        state: 'active',
      }),
      create('action', actionId, {
        title: 'Action',
        captureOrigin: 'plan',
        note: 'Note',
        axisId,
        projectId,
        due: {
          kind: 'instant',
          instant: '2026-10-02T09:00:00.000Z',
          authoredTimeZone: 'Europe/Berlin',
        },
        estimateMinutes: 30,
        energy: 'low',
        priority: 'high',
        orderKey: 'a0',
        state: 'planned',
      }),
      create('note', id(), {
        title: 'Note',
        body: 'Body',
        axisId,
        projectId,
        orderKey: 'a0',
        state: 'active',
      }),
      create('commitment', id(), { title: 'Commitment', strength: 'hard', state: 'planned' }),
      create('routine', routineId, {
        title: 'Routine',
        axisId,
        orderKey: 'a0',
        state: 'active',
        generations: [
          {
            generation: 1,
            rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-10-01' },
            schedulingMode: { kind: 'day_flexible' },
          },
        ],
      }),
      create('routine_occurrence', occurrenceId, {
        routineId,
        generation: 1,
        periodKey: '2026-10-01',
        period: { kind: 'date', date: '2026-10-01' },
        state: 'planned',
      }),
      create('routine_action_defaults', id(), {
        routineId,
        generation: 1,
        projectId,
        estimateMinutes: 15,
      }),
      // A canceled block names the block that supersedes it, created later in the same group.
      create('time_block', canceledBlockId, {
        target: { kind: 'action', actionId },
        startsAt: '2026-10-01T09:00:00Z',
        endsAt: '2026-10-01T10:00:00Z',
        timeZone: 'Europe/Berlin',
        state: 'canceled',
        supersededById: blockId,
        overlapAcknowledged: false,
      }),
      create('time_block', blockId, {
        target: { kind: 'routine_occurrence', routineOccurrenceId: occurrenceId },
        startsAt: '2026-10-01T11:00:00Z',
        endsAt: '2026-10-01T12:00:00Z',
        timeZone: 'Europe/Berlin',
        state: 'planned',
        overlapAcknowledged: true,
      }),
      create('template', id(), {
        title: 'Template',
        blueprint: { version: 1, items: [{ templateKey: 'first', kind: 'action', title: 'Item' }] },
        state: 'active',
      }),
      create('review', reviewId, {
        profileId,
        reviewType: 'daily',
        periodKey: '2026-10-01',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-01',
        state: 'draft',
      }),
      create('review_item', id(), {
        reviewId,
        target: { kind: 'action', actionId },
        decision: 'complete',
        orderKey: 'a0',
      }),
      create('review_item', id(), {
        reviewId,
        target: {
          kind: 'routine_occurrence',
          routineId,
          generation: 1,
          period: { kind: 'date', date: '2026-10-01' },
        },
        decision: 'note',
        note: 'Item note',
        orderKey: 'a1',
      }),
      create('reminder', id(), {
        actionId,
        schedule: { kind: 'at', remindAt: '2026-10-01T08:00:00Z', timeZone: 'Europe/Berlin' },
        state: 'scheduled',
      }),
      create('reminder', id(), {
        reviewId,
        schedule: {
          kind: 'relative',
          remindAt: '2026-10-01T18:00:00Z',
          offsetMinutes: -30,
          timeZone: 'Europe/Berlin',
        },
        state: 'scheduled',
      }),
      create('context', contextId, documents.context()),
      create('constraint', id(), documents.constraint(contextId)),
      create('planning_placement', id(), {
        target: { kind: 'project', projectId },
        period: { kind: 'week', start: '2026-09-28', end: '2026-10-04', weekStart: 'monday' },
        orderKey: 'a0',
      }),
      create('focus_selection', id(), {
        kind: 'day_focus',
        profileId,
        target: { kind: 'action', actionId },
        periodStart: '2026-10-01',
        periodEnd: '2026-10-01',
        orderKey: 'a0',
      }),
      create('focus_selection', id(), {
        kind: 'week_commitment',
        profileId,
        target: { kind: 'milestone', milestoneId },
        periodStart: '2026-09-28',
        periodEnd: '2026-10-04',
        weekStart: 'monday',
        orderKey: 'a0',
      }),
      create('theme', id(), { profileId, month: '2026-10', text: 'Theme' }),
      create('direction', id(), { profileId, year: '2026', text: 'Direction' }),
      create('project_secondary_outcome', id(), { projectId, outcomeId: secondOutcomeId }),
      create('milestone_project', id(), { milestoneId, projectId }),
      create('milestone_action', id(), { milestoneId, actionId }),
    ];
    // Every replica accepts these documents too.
    for (const operation of operations) {
      expect(codecAccepts(operation.entityType, operation.document), operation.entityType).not.toBe(
        false,
      );
    }
    const response = await pushAccepted(user.client, group(operations));
    expect(response.acknowledgments).toHaveLength(operations.length);
    const covered = new Set(operations.map((operation) => operation.entityType));
    expect([...syncEntityTypes].filter((type) => !covered.has(type))).toEqual([]);
    const status = await accountStatus(user.client);
    expect(status.recordCount).toBe(operations.length);
    expect(status.recordCounts).toMatchObject({ time_block: 2, review_item: 2, reminder: 2 });
  });

  it('loads a schema for every syncable entity type', () => {
    const rows = queryDatabase<{ entity_type: SyncEntityType }>(
      'select entity_type from yelaxis_sync.document_schemas order by entity_type collate "C"',
    );
    expect(rows.map((row) => row.entity_type)).toEqual([...syncEntityTypes].sort());
  });

  it('hashes documents exactly like the client: SHA-256 of canonical JSON', async () => {
    const tricky: Document[] = [
      documents.axis(),
      {
        title: 'Quote " backslash \\ slash / newline \n tab \t bell \u0007 apostrophe \' end',
        purpose: 'Emoji 😀, umlaut ü, CJK 漢字, separator  , html </script> & <b>',
        orderKey: 'a0',
        state: 'active',
      },
      { zeta: 1, alpha: { beta: [3, 2, 1], aardvark: null }, Alpha: true, ä: 'non-ASCII key' },
      { nested: [{ b: 1, a: 2 }, [], {}], empty: '', negative: -42, big: 9007199254740991 },
    ];
    for (const document of tricky) {
      const [row] = queryDatabase<{ hash: string; canonical: string }>(
        `select yelaxis_sync.document_hash(${sqlText(JSON.stringify(document))}::jsonb) as hash,
                yelaxis_sync.canonical_json(${sqlText(JSON.stringify(document))}::jsonb) as canonical`,
      );
      expect(row?.canonical).toBe(canonicalJson(document));
      expect(row?.hash).toBe(documentHash(document));
    }
    const user = await createTestUser('push-hash');
    const axisId = randomUUID();
    const document = tricky[1] ?? documents.axis();
    await pushAccepted(user.client, group([create('axis', axisId, document)]));
    const edited = await pushAccepted(
      user.client,
      group([update('axis', axisId, { revision: 1, document }, { ...document, title: 'Edited' })]),
    );
    expect(first(edited.acknowledgments).serverRevision).toBe(2);
  });

  it('applies a full 500-operation group in one request', async () => {
    const user = await createTestUser('push-full-group');
    const operations = Array.from({ length: 500 }, (_, index) =>
      create('action', randomUUID(), documents.action(`Action ${String(index)}`)),
    );
    const started = performance.now();
    const response = await pushAccepted(user.client, group(operations));
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(response.acknowledgments).toHaveLength(500);
    expect((await accountStatus(user.client)).recordCount).toBe(500);
  });
});

describe('sync_push idempotency', () => {
  it('returns the stored acknowledgment for a repeated group and never duplicates a row or change', async () => {
    const user = await createTestUser('push-retry');
    const axisId = randomUUID();
    const axis = documents.axis();
    const request = group([
      create('axis', axisId, axis),
      create('action', randomUUID(), documents.action('Retry', { axisId })),
    ]);
    const accepted = await pushAccepted(user.client, request);
    expect(await pushAccepted(user.client, request)).toEqual(accepted);
    // A lost acknowledgment retried after later changes still gets its original answer.
    await pushAccepted(
      user.client,
      group([update('axis', axisId, { revision: 1, document: axis }, { ...axis, title: 'Later' })]),
    );
    expect(await pushAccepted(user.client, request)).toEqual(accepted);
    expect(ownerRowCounts(user.id)).toMatchObject({
      records: 2,
      change_log: 3,
      idempotency_receipts: 3,
      conflicts: 0,
    });
    const { changes } = await pullAll(user.client);
    expect(changes).toHaveLength(2);
    expect(changes.find((change) => change.entityId === axisId)?.serverRevision).toBe(2);
  });

  it('refuses a reused operation or group id that carries anything else', async () => {
    const user = await createTestUser('push-reuse');
    const request = group([create('axis', randomUUID(), documents.axis())]);
    await pushAccepted(user.client, request);
    const operation = first(request.operations);
    const changedDocument = await pushRejected(user.client, {
      ...request,
      operations: [{ ...operation, document: { ...documents.axis(), title: 'Changed' } }],
    });
    expect(changedDocument).toMatchObject({
      code: 'invalid_payload',
      operationId: operation.operationId,
    });
    const movedGroup = await pushRejected(user.client, {
      ...request,
      mutationGroupId: randomUUID(),
    });
    expect(movedGroup.code).toBe('invalid_payload');
    const partial = await pushRejected(
      user.client,
      group([operation, create('axis', randomUUID(), documents.axis())], {
        mutationGroupId: request.mutationGroupId,
      }),
    );
    expect(partial.code).toBe('invalid_payload');
    const reusedGroup = await pushRejected(
      user.client,
      group([create('axis', randomUUID(), documents.axis())], {
        mutationGroupId: request.mutationGroupId,
      }),
    );
    expect(reusedGroup.code).toBe('invalid_payload');
    expect(ownerRowCounts(user.id)).toMatchObject({
      records: 1,
      change_log: 1,
      idempotency_receipts: 1,
    });
  });
});

describe('sync_push validation', () => {
  it('rejects malformed payloads before applying anything', async () => {
    const user = await createTestUser('push-malformed');
    const base = group([
      create('axis', randomUUID(), documents.axis()),
      create('axis', randomUUID(), documents.axis()),
    ]);
    const [firstOperation, second] = base.operations;
    if (firstOperation === undefined || second === undefined) throw new Error('Two operations.');
    const withSecond = (operation: unknown) => ({
      ...base,
      operations: [firstOperation, operation],
    });
    const asUpdate = { kind: 'update', baseServerRevision: 1, baseSnapshotHash: 'a' };
    const cases: readonly (readonly [string, unknown, string, string?])[] = [
      ['protocol version', { ...base, protocolVersion: 2 }, 'unsupported_protocol'],
      ['protocol version as text', { ...base, protocolVersion: '1' }, 'unsupported_protocol'],
      ['extra request key', { ...base, extra: true }, 'invalid_payload'],
      ['replica id', { ...base, replicaId: 'replica-1' }, 'invalid_payload'],
      ['no operations', { ...base, operations: [] }, 'invalid_payload'],
      ['operations not a list', { ...base, operations: { 0: firstOperation } }, 'invalid_payload'],
      ['operation not an object', withSecond('create'), 'invalid_payload'],
      [
        'extra operation key',
        withSecond({ ...second, extra: 1 }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'missing operation key',
        withSecond(omit(second, 'baseSnapshotHash')),
        'invalid_payload',
        second.operationId,
      ],
      [
        'sequence order',
        withSecond({ ...second, sequence: 5 }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'unknown entity type',
        withSecond({ ...second, entityType: 'calendar_event' }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'unknown operation kind',
        withSecond({ ...second, kind: 'upsert' }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'uppercase id',
        withSecond({ ...second, entityId: second.entityId.toUpperCase() }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'not an id',
        withSecond({ ...second, entityId: 'axis-2' }),
        'invalid_payload',
        second.operationId,
      ],
      ['operation id', withSecond({ ...second, operationId: 'op-2' }), 'invalid_payload'],
      [
        'create with a base revision',
        withSecond({ ...second, baseServerRevision: 1 }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'create with a base hash',
        withSecond({ ...second, baseSnapshotHash: 'abc' }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'negative revision',
        withSecond({ ...second, ...asUpdate, baseServerRevision: -1 }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'fractional revision',
        withSecond({ ...second, ...asUpdate, baseServerRevision: 1.5 }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'revision as text',
        withSecond({ ...second, ...asUpdate, baseServerRevision: '1' }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'hash too long',
        withSecond({ ...second, ...asUpdate, baseSnapshotHash: 'a'.repeat(129) }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'empty hash',
        withSecond({ ...second, ...asUpdate, baseSnapshotHash: '' }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'delete with a document',
        withSecond({ ...second, ...asUpdate, kind: 'delete' }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'update without a document',
        withSecond({ ...second, ...asUpdate, document: null }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'document not an object',
        withSecond({ ...second, document: [] }),
        'invalid_payload',
        second.operationId,
      ],
      [
        'duplicate operation id',
        withSecond({ ...second, operationId: firstOperation.operationId }),
        'invalid_payload',
        firstOperation.operationId,
      ],
      [
        'same record twice',
        withSecond({ ...second, entityId: firstOperation.entityId }),
        'invalid_payload',
        second.operationId,
      ],
    ];
    for (const [label, request, code, operationId] of cases) {
      const response = await pushRejected(user.client, request);
      expect(response.code, label).toBe(code);
      expect(response.mutationGroupId, label).toBe(base.mutationGroupId);
      expect(response.operationId, label).toBe(operationId);
    }
    // Without a usable group id there is no group to answer for.
    for (const request of [
      null,
      [],
      'request',
      { ...base, mutationGroupId: 'group-1' },
      omit(base, 'mutationGroupId'),
    ]) {
      const outcome = await rpc(user.client, 'sync_push', { request });
      expect(outcome, JSON.stringify(request)).toMatchObject({
        status: 400,
        code: '22023',
        data: null,
      });
    }
    expect(ownerRowCounts(user.id)).toMatchObject({
      records: 0,
      change_log: 0,
      idempotency_receipts: 0,
      conflicts: 0,
    });
  });

  it('enforces the operation, document, and request size limits', async () => {
    const user = await createTestUser('push-limits');
    const tooMany = group(
      Array.from({ length: 501 }, () => create('axis', randomUUID(), documents.axis())),
    );
    expect(await pushRejected(user.client, tooMany)).toMatchObject({ code: 'limit_exceeded' });

    const atLimit = documents.project('At limit', { notes: '' });
    const remaining = 65_536 - Buffer.byteLength(canonicalJson(atLimit));
    const notes = `${'é'.repeat(Math.floor(remaining / 2))}${'x'.repeat(remaining % 2)}`;
    const exact = { ...atLimit, notes };
    expect(Buffer.byteLength(canonicalJson(exact))).toBe(65_536);
    await pushAccepted(user.client, group([create('project', randomUUID(), exact)]));

    const oversized = create('project', randomUUID(), { ...exact, notes: `${notes}x` });
    expect(
      await pushRejected(
        user.client,
        group([create('axis', randomUUID(), documents.axis()), oversized]),
      ),
    ).toMatchObject({ code: 'limit_exceeded', operationId: oversized.operationId });

    const note = 'n'.repeat(4_300);
    const large = group(
      Array.from({ length: 500 }, () =>
        create('action', randomUUID(), documents.action('Large', { note })),
      ),
    );
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(2 * 1024 * 1024);
    expect(await pushRejected(user.client, large)).toMatchObject({ code: 'limit_exceeded' });
    expect(ownerRowCounts(user.id)).toMatchObject({ records: 1, change_log: 1 });
  });

  it('validates every document against the JSON Schema of its entity type', async () => {
    const user = await createTestUser('push-schemas');
    const cases: readonly (readonly [string, SyncEntityType, Document])[] = [
      ['missing required field', 'axis', { orderKey: 'a0', state: 'active' }],
      ['unknown field', 'axis', { ...documents.axis(), colour: 'red' }],
      ['unknown state', 'axis', { ...documents.axis(), state: 'deleted' }],
      ['wrong type', 'action', { ...documents.action(), estimateMinutes: 'ten' }],
      ['fractional integer', 'action', { ...documents.action(), estimateMinutes: 2.5 }],
      ['too long', 'action', { ...documents.action(), title: 'x'.repeat(201) }],
      ['not an id', 'action', { ...documents.action(), axisId: 'axis-1' }],
      [
        'wrong union branch',
        'planning_placement',
        {
          target: { kind: 'action', projectId: randomUUID() },
          period: { kind: 'day', date: '2026-10-01' },
          orderKey: 'a0',
        },
      ],
      [
        'bad instant',
        'time_block',
        {
          target: { kind: 'custom', title: 'Block' },
          startsAt: '2026-10-01 09:00',
          endsAt: '2026-10-01T10:00:00Z',
          timeZone: 'Europe/Berlin',
          state: 'planned',
          overlapAcknowledged: false,
        },
      ],
      ['no record codec', 'context', { category: 'preferences', key: 'k', value: 'v' }],
    ];
    for (const [label, entityType, document] of cases) {
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
    const axisId = randomUUID();
    const axis = documents.axis();
    await pushAccepted(user.client, group([create('axis', axisId, axis)]));
    const invalidEdit = update(
      'axis',
      axisId,
      { revision: 1, document: axis },
      { title: 'Only title' },
    );
    expect(await pushRejected(user.client, group([invalidEdit]))).toMatchObject({
      code: 'schema_mismatch',
      operationId: invalidEdit.operationId,
    });
    expect(ownerRowCounts(user.id)).toMatchObject({ records: 1, change_log: 1 });
  });
});

describe('sync_push references', () => {
  it('requires every enforced reference to name a live record of the same owner', async () => {
    const user = await createTestUser('push-references');
    const other = await createTestUser('push-references-other');
    const otherAxisId = randomUUID();
    await pushAccepted(other.client, group([create('axis', otherAxisId, documents.axis())]));
    const axisId = randomUUID();
    const deletedAxisId = randomUUID();
    const deletedAxis = documents.axis('Deleted');
    await pushAccepted(
      user.client,
      group([create('axis', axisId, documents.axis()), create('axis', deletedAxisId, deletedAxis)]),
    );
    await pushAccepted(
      user.client,
      group([remove('axis', deletedAxisId, { revision: 1, document: deletedAxis })]),
    );
    const cases: readonly (readonly [string, Operation])[] = [
      [
        'missing record',
        create('action', randomUUID(), documents.action('A', { axisId: randomUUID() })),
      ],
      [
        'another owner’s record',
        create('action', randomUUID(), documents.action('A', { axisId: otherAxisId })),
      ],
      [
        'a record of another type',
        create('action', randomUUID(), documents.action('A', { projectId: axisId })),
      ],
      [
        'a deleted record',
        create('action', randomUUID(), documents.action('A', { axisId: deletedAxisId })),
      ],
      [
        'a nested target',
        create('planning_placement', randomUUID(), {
          target: { kind: 'action', actionId: randomUUID() },
          period: { kind: 'day', date: '2026-10-01' },
          orderKey: 'a0',
        }),
      ],
      [
        'a profile',
        create('theme', randomUUID(), { profileId: randomUUID(), month: '2026-10', text: 'Theme' }),
      ],
      ['a missing context', create('constraint', randomUUID(), documents.constraint(randomUUID()))],
      [
        'one endpoint of a link',
        create(
          'milestone_action',
          randomUUID(),
          documents.milestoneAction(randomUUID(), randomUUID()),
        ),
      ],
    ];
    for (const [label, operation] of cases) {
      expect(await pushRejected(user.client, group([operation])), label).toMatchObject({
        code: 'missing_reference',
        operationId: operation.operationId,
      });
    }
    // The converted-to pair has no SQLite foreign key, so its target need not exist.
    await pushAccepted(
      user.client,
      group([
        create('action', randomUUID(), {
          ...documents.action('Converted'),
          state: 'archived',
          stateBeforeArchive: 'inbox',
          archivedAt: '2026-10-01T10:00:00.000Z',
          convertedTo: { type: 'project', id: randomUUID() },
        }),
      ]),
    );
    expect(ownerRowCounts(user.id)).toMatchObject({ records: 3 });
  });

  it('checks references once the whole group is applied, like deferred foreign keys', async () => {
    const user = await createTestUser('push-deferred');
    const axisId = randomUUID();
    const axis = documents.axis();
    const actionId = randomUUID();
    const action = documents.action('Linked', { axisId });
    // Created earlier in the same group.
    await pushAccepted(
      user.client,
      group([create('axis', axisId, axis), create('action', actionId, action)]),
    );
    // Created later in the same group (a canceled block names its replacement).
    const replacementId = randomUUID();
    const block = {
      target: { kind: 'action', actionId },
      startsAt: '2026-10-01T09:00:00Z',
      endsAt: '2026-10-01T10:00:00Z',
      timeZone: 'Europe/Berlin',
      overlapAcknowledged: false,
    };
    await pushAccepted(
      user.client,
      group([
        create('time_block', randomUUID(), {
          ...block,
          state: 'canceled',
          supersededById: replacementId,
        }),
        create('time_block', replacementId, { ...block, state: 'planned' }),
      ]),
    );
    // Deleted earlier in the same group.
    const goneId = randomUUID();
    const gone = documents.axis('Gone');
    await pushAccepted(user.client, group([create('axis', goneId, gone)]));
    const late = create('action', randomUUID(), documents.action('Late', { axisId: goneId }));
    expect(
      await pushRejected(
        user.client,
        group([remove('axis', goneId, { revision: 1, document: gone }), late]),
      ),
    ).toMatchObject({ code: 'missing_reference', operationId: late.operationId });
    // A record still named by a live document cannot be deleted.
    const deleteAxis = remove('axis', axisId, { revision: 1, document: axis });
    expect(await pushRejected(user.client, group([deleteAxis]))).toMatchObject({
      code: 'missing_reference',
      operationId: deleteAxis.operationId,
    });
    // Unless the same group first stops naming it.
    const detached = omit(action, 'axisId');
    await pushAccepted(
      user.client,
      group([update('action', actionId, { revision: 1, document: action }, detached), deleteAxis]),
    );
    const { changes } = await pullAll(user.client);
    expect(changes.find((change) => change.entityId === axisId)).toMatchObject({
      deleted: true,
      document: null,
      serverRevision: 2,
    });
    expect(changes.find((change) => change.entityId === goneId)).toMatchObject({ deleted: false });
  });

  it('removes a link and its endpoint together', async () => {
    const user = await createTestUser('push-link');
    const outcomeId = randomUUID();
    const milestoneId = randomUUID();
    const actionId = randomUUID();
    const linkId = randomUUID();
    const milestone = documents.milestone(outcomeId);
    const action = documents.action();
    const link = documents.milestoneAction(milestoneId, actionId);
    await pushAccepted(
      user.client,
      group([
        create('outcome', outcomeId, documents.outcome()),
        create('milestone', milestoneId, milestone),
        create('action', actionId, action),
        create('milestone_action', linkId, link),
      ]),
    );
    // An unlinked join row still names both endpoints.
    const unlinked = { ...link, unlinkedAt: '2026-10-01T10:00:00Z' };
    await pushAccepted(
      user.client,
      group([update('milestone_action', linkId, { revision: 1, document: link }, unlinked)]),
    );
    const deleteAction = remove('action', actionId, { revision: 1, document: action });
    expect(await pushRejected(user.client, group([deleteAction]))).toMatchObject({
      code: 'missing_reference',
    });
    await pushAccepted(
      user.client,
      group([
        remove('milestone_action', linkId, { revision: 2, document: unlinked }),
        deleteAction,
      ]),
    );
    expect((await accountStatus(user.client)).recordCounts).toEqual({ outcome: 1, milestone: 1 });
  });
});

describe('sync_push atomicity and conflicts', () => {
  it('applies nothing from a group with one invalid or conflicting operation', async () => {
    const user = await createTestUser('push-atomic');
    const axisId = randomUUID();
    const axis = documents.axis();
    await pushAccepted(user.client, group([create('axis', axisId, axis)]));
    await pushAccepted(
      user.client,
      group([update('axis', axisId, { revision: 1, document: axis }, { ...axis, title: 'Two' })]),
    );
    const baseline = ownerRowCounts(user.id);
    const fresh = () => create('axis', randomUUID(), documents.axis('Fresh'));
    const groups: readonly (readonly [string, Operation[], string])[] = [
      [
        'missing reference',
        [fresh(), create('action', randomUUID(), documents.action('A', { axisId: randomUUID() }))],
        'rejected',
      ],
      ['schema', [fresh(), create('axis', randomUUID(), { title: 'No order' })], 'rejected'],
      [
        'unknown record',
        [fresh(), update('axis', randomUUID(), { revision: 1, document: axis }, axis)],
        'rejected',
      ],
      [
        'stale base',
        [
          fresh(),
          update('axis', axisId, { revision: 1, document: axis }, { ...axis, title: 'Stale' }),
        ],
        'conflict',
      ],
    ];
    for (const [label, operations, status] of groups) {
      const response = await push(user.client, group(operations));
      expect(response.status, label).toBe(status);
    }
    const after = ownerRowCounts(user.id);
    expect({ ...after, conflicts: 0, replicas: 0 }).toEqual({
      ...baseline,
      conflicts: 0,
      replicas: 0,
    });
    expect(after.conflicts).toBe(1);
    expect((await accountStatus(user.client)).recordCount).toBe(1);
  });

  it('returns structured conflicts for stale bases and never overwrites a newer revision', async () => {
    const user = await createTestUser('push-stale');
    const actionId = randomUUID();
    const a = documents.action('A');
    const b = { ...a, title: 'B' };
    const c = { ...a, title: 'C' };
    const d = { ...a, title: 'D' };
    await pushAccepted(user.client, group([create('action', actionId, a)]));
    const firstEdit = group([update('action', actionId, { revision: 1, document: a }, b)]);
    const firstAck = await pushAccepted(user.client, firstEdit);
    expect(first(firstAck.acknowledgments).serverRevision).toBe(2);

    const stale = group([update('action', actionId, { revision: 1, document: a }, c)]);
    const conflict = await pushConflict(user.client, stale);
    // Retrying the same group reuses its conflict while the remote is unchanged.
    expect(first((await pushConflict(user.client, stale)).conflicts).conflictId).toBe(
      first(conflict.conflicts).conflictId,
    );
    expect(conflict.mutationGroupId).toBe(stale.mutationGroupId);
    expect(conflict.conflicts).toEqual([
      {
        conflictId: expect.any(String) as string,
        operationId: first(stale.operations).operationId,
        entityType: 'action',
        entityId: actionId,
        kind: 'stale_base',
        baseServerRevision: 1,
        remote: { serverRevision: 2, deleted: false, document: b },
      },
    ]);
    // The right revision with another base document is still stale.
    const wrongHash = await pushConflict(
      user.client,
      group([update('action', actionId, { revision: 2, document: a }, c)]),
    );
    expect(first(wrongHash.conflicts).kind).toBe('stale_base');
    const missingHash = await pushConflict(
      user.client,
      group([
        { ...update('action', actionId, { revision: 2, document: b }, c), baseSnapshotHash: null },
      ]),
    );
    expect(first(missingHash.conflicts).kind).toBe('stale_base');

    const secondAck = await pushAccepted(
      user.client,
      group([update('action', actionId, { revision: 2, document: b }, d)]),
    );
    expect(first(secondAck.acknowledgments).serverRevision).toBe(3);
    // An out-of-order retry of the first edit returns its acknowledgment and changes nothing.
    expect(await pushAccepted(user.client, firstEdit)).toEqual(firstAck);
    // Retried after the remote changed again, the old conflict is superseded by a new one.
    const retried = await pushConflict(user.client, stale);
    expect(first(retried.conflicts).conflictId).not.toBe(first(conflict.conflicts).conflictId);
    expect(first(retried.conflicts).remote).toEqual({
      serverRevision: 3,
      deleted: false,
      document: d,
    });

    const { changes } = await pullAll(user.client);
    expect(changes).toEqual([
      expect.objectContaining({ entityId: actionId, serverRevision: 3, document: d }),
    ]);
    const open = await openConflicts(user.client);
    expect(open.map((item) => item.conflictId)).toContain(first(retried.conflicts).conflictId);
    expect(open.map((item) => item.conflictId)).not.toContain(first(conflict.conflicts).conflictId);
  });

  it('turns a delete against a newer edit into a delete_versus_edit conflict', async () => {
    const user = await createTestUser('push-delete-edit');
    const actionId = randomUUID();
    const a = documents.action('A');
    const b = { ...a, title: 'Edited on another device' };
    await pushAccepted(user.client, group([create('action', actionId, a)]));
    await pushAccepted(
      user.client,
      group([update('action', actionId, { revision: 1, document: a }, b)]),
    );
    const deletion = group([remove('action', actionId, { revision: 1, document: a })]);
    const response = await pushConflict(user.client, deletion);
    expect(first(response.conflicts)).toMatchObject({
      kind: 'delete_versus_edit',
      baseServerRevision: 1,
      remote: { serverRevision: 2, deleted: false, document: b },
    });
    const [open] = await openConflicts(user.client);
    expect(open).toMatchObject({
      kind: 'delete_versus_edit',
      local: { deleted: true, document: null },
      remote: { serverRevision: 2, deleted: false, document: b },
      blockedMutationGroupId: deletion.mutationGroupId,
    });
    expect((await pullAll(user.client)).changes).toEqual([
      expect.objectContaining({ entityId: actionId, deleted: false, serverRevision: 2 }),
    ]);
  });

  it('keeps a content-cleared tombstone and never resurrects a deleted id', async () => {
    const user = await createTestUser('push-tombstone');
    const actionId = randomUUID();
    const a = documents.action('A');
    await pushAccepted(user.client, group([create('action', actionId, a)]));
    const deleted = await pushAccepted(
      user.client,
      group([remove('action', actionId, { revision: 1, document: a })]),
    );
    expect(first(deleted.acknowledgments).serverRevision).toBe(2);
    const tombstone = { entityId: actionId, deleted: true, document: null, serverRevision: 2 };
    expect((await pullAll(user.client)).changes).toEqual([expect.objectContaining(tombstone)]);
    expect((await accountStatus(user.client)).recordCount).toBe(0);

    const recreate = await pushConflict(user.client, group([create('action', actionId, a)]));
    expect(first(recreate.conflicts)).toMatchObject({
      kind: 'create_collision',
      remote: { serverRevision: 2, deleted: true, document: null },
    });
    const staleEdit = await pushConflict(
      user.client,
      group([update('action', actionId, { revision: 1, document: a }, { ...a, title: 'B' })]),
    );
    expect(first(staleEdit.conflicts).kind).toBe('edit_versus_delete');
    const staleDelete = await pushConflict(
      user.client,
      group([remove('action', actionId, { revision: 1, document: a })]),
    );
    expect(first(staleDelete.conflicts).kind).toBe('stale_base');
    // Deleting again from the tombstone converges without a new change.
    const changesBefore = ownerRowCounts(user.id).change_log;
    const again = await pushAccepted(
      user.client,
      group([
        { ...remove('action', actionId, { revision: 2, document: a }), baseSnapshotHash: null },
      ]),
    );
    expect(first(again.acknowledgments).serverRevision).toBe(2);
    expect(ownerRowCounts(user.id).change_log).toBe(changesBefore);
    expect((await pullAll(user.client)).changes).toEqual([expect.objectContaining(tombstone)]);
  });

  it('restores a tombstone only through an edit made from the tombstone revision', async () => {
    const user = await createTestUser('push-restore');
    const actionId = randomUUID();
    const a = documents.action('A');
    await pushAccepted(user.client, group([create('action', actionId, a)]));
    await pushAccepted(
      user.client,
      group([remove('action', actionId, { revision: 1, document: a })]),
    );
    const restored = { ...a, title: 'Restored' };
    const response = await pushAccepted(
      user.client,
      group([
        {
          ...update('action', actionId, { revision: 2, document: a }, restored),
          baseSnapshotHash: null,
        },
      ]),
    );
    expect(first(response.acknowledgments).serverRevision).toBe(3);
    expect((await pullAll(user.client)).changes).toEqual([
      expect.objectContaining({
        entityId: actionId,
        deleted: false,
        serverRevision: 3,
        document: restored,
      }),
    ]);
  });

  it('accepts an identical create once and turns a different create with an existing id into a conflict', async () => {
    const user = await createTestUser('push-collision');
    const axisId = randomUUID();
    const axis = documents.axis();
    await pushAccepted(user.client, group([create('axis', axisId, axis)]));
    const identical = await pushAccepted(user.client, group([create('axis', axisId, { ...axis })]));
    expect(first(identical.acknowledgments).serverRevision).toBe(1);
    expect(ownerRowCounts(user.id).change_log).toBe(1);
    const different = await pushConflict(
      user.client,
      group([create('axis', axisId, { ...axis, title: 'Other' })]),
    );
    expect(first(different.conflicts)).toMatchObject({
      kind: 'create_collision',
      baseServerRevision: 0,
      remote: { serverRevision: 1, deleted: false, document: axis },
    });
  });
});
