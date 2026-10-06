import {
  alignmentLinkId,
  createEntityRef,
  entityRefKey,
  ok,
  type CommandContext,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  alreadyLinked,
  createAlignmentKit,
  isActiveLink,
  linkDocument,
  linkEndpoints,
  linkRef,
  noChange,
  parseAlignmentRef,
  type AlignmentKit,
} from './alignment-kit';
import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import type { PlanProfile } from './planning-contracts';
import { createPlanningApplication } from './planning';
import {
  createMutation,
  deleteFrom,
  planPlanningUndo,
  updateFrom,
  type PlanningEventDetails,
} from './planning-kit';
import { createTestPlanningQueries } from './planning-routines-test-queries';
import {
  createAlignmentSeeder,
  createAlignmentTestQueries,
  type AlignmentSeeder,
} from './testing/alignment-test-queries';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const now = '2026-09-28T13:00:00.000Z' as Instant;
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: 'Asia/Tashkent' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};

let harness: InMemoryHarness;
let kit: AlignmentKit;
let seed: AlignmentSeeder;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  kit = createAlignmentKit(harness.dependencies, createAlignmentTestQueries(harness.unitOfWork));
  seed = createAlignmentSeeder(harness.unitOfWork, ownerId);
});

const receiptOf = (result: ApplicationResult<CommandReceipt>): CommandReceipt => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const read = (record: CanonicalRecordState) =>
  harness.unitOfWork.get(entityRefKey(record.ref)) ?? null;

const undo = (undoId: UUID) =>
  createPlanningApplication(
    harness.dependencies,
    createTestPlanningQueries(harness.unitOfWork, profile),
  ).undo(undoId);

describe('alignment kit command runner', () => {
  it('links through one transaction with minimized events, a receipt, and unlink on undo', async () => {
    const outcome = seed.outcome();
    const milestone = seed.milestone(outcome.ref.id);
    const action = seed.action({ title: 'Private plan text' });
    const ref = linkRef(ownerId, 'milestone_action', milestone.ref.id, action.ref.id);

    const receipt = receiptOf(
      await kit.run(
        ownerId,
        undefined,
        'alignment.linked',
        [],
        () =>
          ok({
            mutations: [
              createMutation(
                ref,
                linkDocument('milestone_action', milestone.ref.id, action.ref.id),
              ),
            ],
            created: [{ ref, kind: 'milestone_action' }],
          }),
        { eventPayload: { relationship: 'milestone_action', nextId: milestone.ref.id } },
      ),
    );

    expect(receipt.canonical).toEqual([{ ref, localRevision: 1 }]);
    expect(harness.unitOfWork.state.events.map(({ event }) => event.payload)).toEqual([
      { operation: 'create', relationship: 'milestone_action', nextId: milestone.ref.id },
    ]);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private plan text');
    expect(harness.notifications.map(({ touched }) => touched)).toEqual([[ref]]);
    expect(receipt.undo.available).toBe(true);
    if (!receipt.undo.available) return;

    receiptOf(await undo(receipt.undo.undoId));
    const link = harness.unitOfWork.get(entityRefKey(ref));
    expect(link?.document).toEqual({
      milestoneId: milestone.ref.id,
      actionId: action.ref.id,
      unlinkedAt: now,
    });
    expect(link?.localRevision).toBe(2);
    expect(read(milestone)).toEqual(milestone);
    expect(read(action)).toEqual(action);
  });

  it('records per-record details and restores every prior document on undo', async () => {
    const previous = seed.project({ title: 'Old' });
    const next = seed.project({ title: 'New' });
    const action = seed.action({ projectId: previous.ref.id });
    const details = (mutation: { readonly ref: { readonly id: string } }) =>
      mutation.ref.id === action.ref.id
        ? ({
            relationship: 'project_action',
            previousId: previous.ref.id,
            nextId: next.ref.id,
          } satisfies PlanningEventDetails)
        : undefined;

    const receipt = receiptOf(
      await kit.run(
        ownerId,
        undefined,
        'alignment.linked',
        [{ ref: action.ref, revision: 1 }],
        async ({ records }) => {
          const current = await records.read(action.ref);
          if (current === null) return noChange();
          return ok({
            mutations: [updateFrom(current, { ...current.document, projectId: next.ref.id })],
            eventPayload: details,
          });
        },
        { eventPayload: { relationship: 'axis_project' } },
      ),
    );
    expect(harness.unitOfWork.state.events.map(({ event }) => event.payload)).toEqual([
      {
        operation: 'update',
        relationship: 'project_action',
        previousId: previous.ref.id,
        nextId: next.ref.id,
      },
    ]);
    if (!receipt.undo.available) throw new Error('Expected undo.');
    receiptOf(await undo(receipt.undo.undoId));
    expect(read(action)?.document).toEqual(action.document);
  });

  it('refuses an empty plan as no change and writes nothing', async () => {
    const result = await kit.run(ownerId, undefined, 'axis.edited', [], () =>
      ok({ mutations: [] }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: { code: 'invalid_value', message: 'Nothing changed.' },
      },
    });
    expect(harness.unitOfWork.state.events).toEqual([]);
    expect(harness.unitOfWork.state.receipts.size).toBe(0);
  });

  it('rejects a stale revision before planning and writes nothing', async () => {
    const axis = seed.axis({}, { revision: 3 });
    let planned = false;
    const result = await kit.run(
      ownerId,
      undefined,
      'axis.edited',
      [{ ref: axis.ref, revision: 2 }],
      () => {
        planned = true;
        return ok({ mutations: [updateFrom(axis, { ...axis.document, title: 'Moved' })] });
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'revision_conflict', expectedRevision: 2, actualRevision: 3 },
    });
    expect(planned).toBe(false);
    expect(read(axis)).toEqual(axis);
  });

  it('returns the original receipt for a repeated command id', async () => {
    const axis = seed.axis();
    const commandId = '90000000-0000-4000-8000-000000000001' as UUID;
    const edit = () =>
      kit.run(
        ownerId,
        commandId,
        'axis.edited',
        [{ ref: axis.ref, revision: 1 }],
        async ({ records }) => {
          const current = await records.read(axis.ref);
          if (current === null) return noChange();
          return ok({
            mutations: [updateFrom(current, { ...current.document, title: 'Renamed' })],
          });
        },
      );
    const first = receiptOf(await edit());
    const second = receiptOf(await edit());
    expect(second).toEqual(first);
    expect(harness.unitOfWork.state.events).toHaveLength(1);
    expect(read(axis)?.localRevision).toBe(2);
  });

  it('fails closed when event details would carry anything but ids and a relationship', async () => {
    const axis = seed.axis();
    for (const details of [
      { previousId: 'Private plan text' },
      { relationship: 'free text' },
      { nextId: axis.ref.id.toUpperCase() },
    ]) {
      const result = await kit.run(
        ownerId,
        undefined,
        'axis.edited',
        [{ ref: axis.ref, revision: 1 }],
        () => ok({ mutations: [updateFrom(axis, { ...axis.document, title: 'Renamed' })] }),
        { eventPayload: details as PlanningEventDetails },
      );
      expect(result).toEqual({ ok: false, error: { code: 'transaction_failed' } });
    }
    expect(read(axis)).toEqual(axis);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('copies only known detail keys into event payloads', async () => {
    const axis = seed.axis();
    receiptOf(
      await kit.run(
        ownerId,
        undefined,
        'axis.edited',
        [{ ref: axis.ref, revision: 1 }],
        () => ok({ mutations: [updateFrom(axis, { ...axis.document, title: 'Renamed' })] }),
        { eventPayload: { nextId: axis.ref.id, title: 'Renamed' } as PlanningEventDetails },
      ),
    );
    expect(harness.unitOfWork.state.events[0]?.event.payload).toEqual({
      operation: 'update',
      nextId: axis.ref.id,
    });
  });

  it('deletes with a content-free tombstone and records no undo', async () => {
    const outcome = seed.outcome();
    const project = seed.project();
    const link = seed.link('outcome_secondary_project', outcome.ref.id, project.ref.id, {
      unlinkedAt: now,
    });
    const receipt = receiptOf(
      await kit.run(
        ownerId,
        undefined,
        'project.deleted',
        [{ ref: link.ref, revision: 1 }],
        ({ context }) => ok({ mutations: [deleteFrom(link, context.now)] }),
      ),
    );
    expect(receipt.undo).toEqual({ available: false });
    expect(read(link)).toBeNull();
    expect(harness.unitOfWork.state.undo).toEqual([]);
    expect(harness.unitOfWork.state.events.map(({ event }) => event.payload)).toEqual([
      { operation: 'delete' },
    ]);
  });
});

describe('planning kit helpers', () => {
  it('builds an exact five-field tombstone from the current revision', () => {
    const axis = createEntityRef('axis', '20000000-0000-4000-8000-000000000001' as UUID, ownerId);
    const mutation = deleteFrom(
      {
        ref: axis,
        localRevision: 4,
        serverRevision: 2,
        baseSnapshotHash: 'hash',
        document: { title: 'Private title' },
      },
      now,
    );
    expect(mutation).toEqual({
      operation: 'delete',
      ref: axis,
      expectedRevision: 4,
      baseServerRevision: 2,
      baseSnapshotHash: 'hash',
      tombstone: {
        ownerId,
        entityType: 'axis',
        entityId: axis.id,
        revision: 5,
        deletedAt: now,
      },
    });
    expect(JSON.stringify(mutation)).not.toContain('Private title');
  });

  it('leaves an already unlinked created link alone during undo', async () => {
    const outcome = seed.outcome();
    const project = seed.project();
    const link = seed.link('milestone_project', outcome.ref.id, project.ref.id, {
      unlinkedAt: now,
    });
    const context: CommandContext = {
      ownerId,
      actor: 'user',
      commandId: '90000000-0000-4000-8000-000000000002' as UUID,
      now,
    };
    const result = await planPlanningUndo(
      { prior: [], created: [{ ref: link.ref, kind: 'milestone_project' }] },
      { read: (ref) => Promise.resolve(harness.unitOfWork.get(entityRefKey(ref)) ?? null) },
      context,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { message: 'There is nothing left to undo.' },
    });
  });
});

describe('join link helpers', () => {
  const outcomeId = '20000000-0000-4000-8000-000000000001' as UUID;
  const milestoneId = '20000000-0000-4000-8000-000000000002' as UUID;
  const projectId = '30000000-0000-4000-8000-000000000001' as UUID;
  const actionId = '40000000-0000-4000-8000-000000000001' as UUID;

  it('derives one owner-scoped ref and document per pair, parent first', () => {
    expect(linkRef(ownerId, 'outcome_secondary_project', outcomeId, projectId)).toEqual(
      createEntityRef(
        'project_secondary_outcome',
        alignmentLinkId('outcome_secondary_project', outcomeId, projectId),
        ownerId,
      ),
    );
    expect(linkRef(ownerId, 'milestone_action', milestoneId, actionId).type).toBe(
      'milestone_action',
    );
    const cases = [
      ['outcome_secondary_project', outcomeId, projectId, { projectId, outcomeId }],
      ['milestone_project', milestoneId, projectId, { milestoneId, projectId }],
      ['milestone_action', milestoneId, actionId, { milestoneId, actionId }],
    ] as const;
    for (const [relationship, parentId, childId, document] of cases) {
      expect(linkDocument(relationship, parentId, childId)).toEqual(document);
      expect(linkEndpoints(relationship, document)).toEqual({ parentId, childId });
      expect(isActiveLink(document)).toBe(true);
      expect(isActiveLink({ ...document, unlinkedAt: now })).toBe(false);
    }
    expect(linkEndpoints('milestone_action', { milestoneId, projectId })).toBeNull();
    expect(linkEndpoints('milestone_project', { milestoneId: 'x', projectId })).toBeNull();
  });

  it('parses user ids into owner-scoped refs and reports the no-change receipt', () => {
    expect(parseAlignmentRef('outcome', outcomeId.toUpperCase(), ownerId)).toEqual({
      ok: true,
      value: createEntityRef('outcome', outcomeId, ownerId),
    });
    expect(parseAlignmentRef('outcome', 'not-an-id', ownerId)).toMatchObject({
      ok: false,
      error: { code: 'invalid_uuid' },
    });
    expect(alreadyLinked).toEqual({ status: 'no_change', reason: 'already_linked' });
    expect(noChange()).toMatchObject({ ok: false, error: { details: { reason: 'no_change' } } });
  });
});
