/**
 * alignment Action integration: Inbox triage may link the planned Action to a
 * Milestone, permanent delete removes the Action's own unlinked Milestone links and keeps the
 * review decisions that name it with a cleared reference, and an explicit
 * cross-Axis Action/Project pair needs confirmation in capture, edit, triage, and bulk.
 */
import {
  alignmentLinkId,
  compareOrder,
  createEntityRef,
  entityRefKey,
  type CommandId,
  type EntityRef,
  type EntityType,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createActionApplication,
  type ActionApplication,
  type ActionChoice,
  type ActionPlanningQueryPort,
  type InboxActionItem,
  type MilestoneChoice,
  type ProfilePlanningContext,
  type TriageChoice,
} from './actions';
import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import type { UnitOfWorkPort } from './ports';
import { createAlignmentSeeder, type AlignmentSeeder } from './testing/alignment-test-queries';
import {
  createInMemoryHarness,
  type InMemoryHarness,
  type InMemoryUnitOfWork,
} from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const otherOwnerId = '10000000-0000-4000-8000-000000000002' as OwnerId;
const now = '2026-09-28T13:00:00.000Z' as Instant;
const later = '2026-09-28T14:00:00.000Z' as Instant;
const unknownId = '12000000-0000-4000-8000-000000000999';
const profile: ProfilePlanningContext = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: 'Asia/Tashkent' as IanaTimeZone,
  weekStart: 'monday',
};
const week = { kind: 'week', date: '2026-10-07' } as const;
const crossAxisMessage =
  'This Action is in a different Axis than the Project. Confirm to link them.';

type Doc = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Test-only Action planning queries over the in-memory unit of work, following the SQLite adapter's
 * documented semantics (owner-scoped, persisted order, active choices only). It never writes.
 */
function createActionTestQueries(
  unitOfWork: InMemoryUnitOfWork,
  context: ProfilePlanningContext,
  createdAt: Instant,
): ActionPlanningQueryPort {
  const all = (owner: OwnerId, type: EntityType): CanonicalRecordState[] =>
    [...unitOfWork.state.records.values()].filter(
      (record) => record.ref.ownerId === owner && record.ref.type === type,
    );
  const find = (owner: OwnerId, type: EntityType, id: unknown): CanonicalRecordState | null =>
    all(owner, type).find((record) => record.ref.id === id) ?? null;
  const byOrder = (left: CanonicalRecordState, right: CanonicalRecordState): number =>
    compareOrder(
      { id: left.ref.id, orderKey: text(left.document['orderKey']) ?? '' },
      { id: right.ref.id, orderKey: text(right.document['orderKey']) ?? '' },
    );
  const inbox = (owner: OwnerId) =>
    all(owner, 'action')
      .filter(
        (record) =>
          record.document['state'] === 'inbox' && record.document['archivedAt'] === undefined,
      )
      .sort(byOrder);
  const targetsAction = (record: CanonicalRecordState, actionId: string): boolean => {
    const target = record.document['target'];
    return (
      typeof target === 'object' &&
      target !== null &&
      (target as Doc)['kind'] === 'action' &&
      (target as Doc)['actionId'] === actionId
    );
  };
  const choice = (record: CanonicalRecordState): ActionChoice => ({
    id: record.ref.id,
    title: text(record.document['title']) ?? '',
    localRevision: record.localRevision,
  });
  const milestoneLinks = (owner: OwnerId, actionId: string) =>
    all(owner, 'milestone_action').filter((record) => record.document['actionId'] === actionId);

  return {
    getProfileContext: () => Promise.resolve(context),
    getInboxEdge: (owner, edge) => {
      const rows = inbox(owner);
      const row = edge === 'first' ? rows[0] : rows.at(-1);
      return Promise.resolve(row === undefined ? null : (text(row.document['orderKey']) ?? null));
    },
    listInbox: (owner, input) => {
      const rows = inbox(owner);
      const items = rows.slice(0, input.limit).map((record): InboxActionItem => ({
        id: record.ref.id,
        title: text(record.document['title']) ?? '',
        state: 'inbox',
        sortKey: text(record.document['orderKey']) ?? '',
        localRevision: record.localRevision,
        createdAt,
      }));
      return Promise.resolve({ items, total: rows.length });
    },
    listAllInbox: (owner) =>
      Promise.resolve(
        inbox(owner).map((record) => ({
          ref: record.ref as EntityRef<'action'>,
          revision: record.localRevision,
        })),
      ),
    getActionWorkspace: (owner, actionId) => {
      const action = find(owner, 'action', actionId);
      if (action === null) return Promise.resolve(null);
      const axis = find(owner, 'axis', action.document['axisId']);
      const project = find(owner, 'project', action.document['projectId']);
      return Promise.resolve({
        action,
        createdAt,
        placement:
          all(owner, 'planning_placement').find(
            (record) =>
              targetsAction(record, actionId) && record.document['archivedAt'] === undefined,
          ) ?? null,
        plannedBlock:
          all(owner, 'time_block').find(
            (record) => targetsAction(record, actionId) && record.document['state'] === 'planned',
          ) ?? null,
        reminder:
          all(owner, 'reminder').find((record) => record.document['actionId'] === actionId) ?? null,
        ...(axis === null ? {} : { axisTitle: text(axis.document['title']) ?? '' }),
        ...(project === null ? {} : { projectTitle: text(project.document['title']) ?? '' }),
      });
    },
    getActionDeleteImpact: (owner, actionId) => {
      const links = milestoneLinks(owner, actionId);
      // Review items naming the Action in any state, in id order, like the SQLite adapter.
      const reviewItems = all(owner, 'review_item')
        .filter((record) => targetsAction(record, actionId))
        .sort((left, right) => (left.ref.id < right.ref.id ? -1 : 1));
      return Promise.resolve({
        placements: all(owner, 'planning_placement').filter((record) =>
          targetsAction(record, actionId),
        ),
        // Its own reminders and those on its blocks, like the SQLite adapter.
        reminders: all(owner, 'reminder').filter(
          (record) =>
            record.document['actionId'] === actionId ||
            all(owner, 'time_block').some(
              (block) =>
                targetsAction(block, actionId) && record.document['timeBlockId'] === block.ref.id,
            ),
        ),
        focusSelections: all(owner, 'focus_selection').filter((record) =>
          targetsAction(record, actionId),
        ),
        timeBlocks: all(owner, 'time_block').filter((record) => targetsAction(record, actionId)),
        milestoneLinkCount: links.filter((record) => record.document['unlinkedAt'] === undefined)
          .length,
        inactiveMilestoneLinks: links.filter(
          (record) => record.document['unlinkedAt'] !== undefined,
        ),
        reviewItems,
        reviewReferences: reviewItems.length,
      });
    },
    listAxes: (owner) =>
      Promise.resolve(
        all(owner, 'axis')
          .filter((record) => record.document['state'] === 'active')
          .sort(byOrder)
          .map(choice),
      ),
    listProjects: (owner) =>
      Promise.resolve(
        all(owner, 'project')
          .filter((record) =>
            ['idea', 'active', 'blocked', 'paused'].includes(text(record.document['state']) ?? ''),
          )
          .sort(byOrder)
          .map((record) => {
            const axisId = text(record.document['axisId']);
            return {
              ...choice(record),
              ...(axisId === undefined ? {} : { axisId: axisId as UUID }),
            };
          }),
      ),
    listMilestones: (owner) =>
      Promise.resolve(
        all(owner, 'milestone')
          .filter((record) => record.document['state'] === 'active')
          .sort(byOrder)
          .flatMap((record): MilestoneChoice[] => {
            const outcome = find(owner, 'outcome', record.document['outcomeId']);
            return outcome === null
              ? []
              : [
                  {
                    ...choice(record),
                    outcomeId: outcome.ref.id,
                    outcomeTitle: text(outcome.document['title']) ?? '',
                  },
                ];
          }),
      ),
    findMilestoneActionLink: (owner, milestoneId, actionId) =>
      Promise.resolve(
        milestoneLinks(owner, actionId).find(
          (record) => record.document['milestoneId'] === milestoneId,
        ) ?? null,
      ),
  };
}

let harness: InMemoryHarness;
let seed: AlignmentSeeder;
let queries: ActionPlanningQueryPort;
let actions: ActionApplication;

const useQueries = (port: ActionPlanningQueryPort): void => {
  actions = createActionApplication(harness.dependencies, port);
};

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  seed = createAlignmentSeeder(harness.unitOfWork, ownerId);
  queries = createActionTestQueries(harness.unitOfWork, profile, now);
  useQueries(queries);
});

const record = (ref: EntityRef): CanonicalRecordState | null =>
  harness.unitOfWork.get(entityRefKey(ref)) ?? null;

const receiptOf = (result: ApplicationResult<CommandReceipt>): CommandReceipt => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const undoIdOf = (receipt: CommandReceipt): UUID => {
  if (!receipt.undo.available) throw new Error('Expected an undoable receipt');
  return receipt.undo.undoId;
};

const milestoneLinkRef = (milestoneId: UUID, actionId: UUID) =>
  createEntityRef(
    'milestone_action',
    alignmentLinkId('milestone_action', milestoneId, actionId),
    ownerId,
  );

const linkRecords = () =>
  [...harness.unitOfWork.state.records.values()].filter(
    (candidate) => candidate.ref.type === 'milestone_action',
  );

const snapshot = () => ({
  records: new Map(harness.unitOfWork.state.records),
  events: harness.unitOfWork.state.events.length,
  receipts: harness.unitOfWork.state.receipts.size,
  undo: harness.unitOfWork.state.undo.length,
});

const expectNoWrites = (before: ReturnType<typeof snapshot>): void => {
  expect(harness.unitOfWork.state.records).toEqual(before.records);
  expect(harness.unitOfWork.state.events).toHaveLength(before.events);
  expect(harness.unitOfWork.state.receipts.size).toBe(before.receipts);
  expect(harness.unitOfWork.state.undo).toHaveLength(before.undo);
};

const eventRows = () =>
  harness.unitOfWork.state.events.map(({ event }) => [
    event.aggregate.type,
    event.eventType,
    event.payload,
  ]);

function milestoneGraph() {
  const run = seed.outcome({ title: 'Run a 10k' });
  const first5k = seed.milestone(run.ref.id, { title: 'First 5k' });
  const done = seed.milestone(run.ref.id, { title: 'Done 5k', state: 'completed' });
  const oldRace = seed.milestone(run.ref.id, {
    title: 'Old race',
    state: 'archived',
    stateBeforeArchive: 'active',
    archivedAt: now,
  });
  const call = seed.action({ title: 'Book the track', state: 'inbox' });
  return { run, first5k, done, oldRace, call };
}

type PlanChoice = Extract<TriageChoice, { readonly kind: 'plan' }>;

const planWith = (
  milestoneId: string,
  extra: Pick<PlanChoice, 'projectId' | 'confirmCrossAxis'> = {},
): PlanChoice => ({ kind: 'plan', period: week, milestoneId, ...extra });

describe('Inbox triage to a Milestone', () => {
  it('lists active Milestones with their Outcome for the triage picker', async () => {
    const graph = milestoneGraph();
    await expect(actions.listMilestones()).resolves.toEqual([
      {
        id: graph.first5k.ref.id,
        title: 'First 5k',
        localRevision: 1,
        outcomeId: graph.run.ref.id,
        outcomeTitle: 'Run a 10k',
      },
    ]);
  });

  it('plans and links in one transaction with minimized events, and undo unlinks', async () => {
    const graph = milestoneGraph();
    const planned = receiptOf(
      await actions.triage(graph.call.ref.id, 1, planWith(graph.first5k.ref.id)),
    );
    const link = milestoneLinkRef(graph.first5k.ref.id, graph.call.ref.id);
    expect(planned.canonical.map(({ ref }) => ref.type).sort()).toEqual([
      'action',
      'milestone_action',
      'planning_placement',
    ]);
    expect(record(link)).toMatchObject({
      localRevision: 1,
      document: { milestoneId: graph.first5k.ref.id, actionId: graph.call.ref.id },
    });
    expect(record(link)?.document).not.toHaveProperty('unlinkedAt');
    expect(record(graph.call.ref)?.document).toMatchObject({ state: 'planned' });
    expect(record(graph.first5k.ref)).toEqual(graph.first5k);
    expect(eventRows()).toEqual(
      expect.arrayContaining([
        [
          'milestone_action',
          'action.plan',
          { operation: 'create', relationship: 'milestone_action', nextId: graph.first5k.ref.id },
        ],
        ['action', 'action.plan', { operation: 'update' }],
        ['planning_placement', 'action.plan', { operation: 'create' }],
      ]),
    );
    expect(harness.unitOfWork.state.events).toHaveLength(3);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toMatch(
      /Book the track|First 5k|Run a 10k/u,
    );

    harness.setNow(later);
    receiptOf(await actions.undo(undoIdOf(planned)));
    expect(record(link)).toMatchObject({
      localRevision: 2,
      document: {
        milestoneId: graph.first5k.ref.id,
        actionId: graph.call.ref.id,
        unlinkedAt: later,
      },
    });
    expect(record(graph.call.ref)?.document).toMatchObject({ state: 'inbox' });
    expect(record(graph.first5k.ref)).toEqual(graph.first5k);
  });

  it('revives an unlinked pair instead of adding a second link row, and undo restores it', async () => {
    const graph = milestoneGraph();
    const old = seed.link('milestone_action', graph.first5k.ref.id, graph.call.ref.id, {
      unlinkedAt: now,
      revision: 3,
    });
    harness.setNow(later);
    const planned = receiptOf(
      await actions.triage(graph.call.ref.id, 1, planWith(graph.first5k.ref.id)),
    );
    expect(old.ref).toEqual(milestoneLinkRef(graph.first5k.ref.id, graph.call.ref.id));
    expect(record(old.ref)).toMatchObject({
      localRevision: 4,
      document: { milestoneId: graph.first5k.ref.id, actionId: graph.call.ref.id },
    });
    expect(record(old.ref)?.document).not.toHaveProperty('unlinkedAt');
    expect(linkRecords()).toHaveLength(1);
    expect(eventRows()).toContainEqual([
      'milestone_action',
      'action.plan',
      { operation: 'update', relationship: 'milestone_action', nextId: graph.first5k.ref.id },
    ]);

    receiptOf(await actions.undo(undoIdOf(planned)));
    expect(record(old.ref)).toMatchObject({ localRevision: 5, document: { unlinkedAt: now } });
  });

  it('plans again after undo by reviving the same link', async () => {
    const graph = milestoneGraph();
    const first = receiptOf(
      await actions.triage(graph.call.ref.id, 1, planWith(graph.first5k.ref.id)),
    );
    receiptOf(await actions.undo(undoIdOf(first)));
    const current = record(graph.call.ref);
    receiptOf(
      await actions.triage(
        graph.call.ref.id,
        current?.localRevision ?? 0,
        planWith(graph.first5k.ref.id),
      ),
    );
    expect(linkRecords()).toHaveLength(1);
    expect(record(milestoneLinkRef(graph.first5k.ref.id, graph.call.ref.id))).toMatchObject({
      localRevision: 3,
    });
  });

  it('keeps an active link as it is and still plans the Action', async () => {
    const graph = milestoneGraph();
    const link = seed.link('milestone_action', graph.first5k.ref.id, graph.call.ref.id);
    const planned = receiptOf(
      await actions.triage(graph.call.ref.id, 1, planWith(graph.first5k.ref.id)),
    );
    expect(planned.canonical.map(({ ref }) => ref.type).sort()).toEqual([
      'action',
      'planning_placement',
    ]);
    expect(record(link.ref)).toEqual(link);
  });

  it('treats a blank Milestone choice as none', async () => {
    const graph = milestoneGraph();
    const planned = receiptOf(await actions.triage(graph.call.ref.id, 1, planWith('')));
    expect(planned.canonical.map(({ ref }) => ref.type).sort()).toEqual([
      'action',
      'planning_placement',
    ]);
    expect(linkRecords()).toEqual([]);
  });

  it('refuses a malformed, missing, finished, archived, or foreign Milestone without writing', async () => {
    const graph = milestoneGraph();
    const foreign = createAlignmentSeeder(
      harness.unitOfWork,
      otherOwnerId,
      'e0000000-0000-4000-8000-',
    );
    const theirs = foreign.milestone(foreign.outcome().ref.id);
    const before = snapshot();

    await expect(
      actions.triage(graph.call.ref.id, 1, planWith('not-a-uuid')),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'domain_rejected', domainError: { code: 'invalid_uuid' } },
    });
    for (const milestoneId of [unknownId, graph.done.ref.id, graph.oldRace.ref.id, theirs.ref.id]) {
      await expect(
        actions.triage(graph.call.ref.id, 1, planWith(milestoneId)),
        milestoneId,
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'domain_rejected',
          domainError: {
            code: 'invalid_value',
            message: 'This Milestone is not available. Choose an active Milestone.',
            details: { reason: 'parent_unavailable', field: 'milestoneId' },
          },
        },
      });
    }
    expectNoWrites(before);
  });

  it('fails closed when the Milestone stops being active before the transaction', async () => {
    const graph = milestoneGraph();
    useQueries({
      ...queries,
      listMilestones: () =>
        Promise.resolve([
          {
            id: graph.done.ref.id,
            title: 'Done 5k',
            localRevision: 1,
            outcomeId: graph.run.ref.id,
            outcomeTitle: 'Run a 10k',
          },
        ]),
    });
    const before = snapshot();
    await expect(
      actions.triage(graph.call.ref.id, 1, planWith(graph.done.ref.id)),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: { details: { reason: 'parent_unavailable' } },
      },
    });
    expectNoWrites(before);
  });

  it('replays an accepted triage by command id and rejects a stale revision without writing', async () => {
    const graph = milestoneGraph();
    const commandId = '13000000-0000-4000-8000-000000000001' as CommandId;
    const first = await actions.triage(
      graph.call.ref.id,
      1,
      planWith(graph.first5k.ref.id),
      commandId,
    );
    expect(first.ok).toBe(true);
    await expect(
      actions.triage(graph.call.ref.id, 1, planWith(graph.first5k.ref.id), commandId),
    ).resolves.toEqual(first);
    expect(linkRecords()).toHaveLength(1);

    const other = seed.action({ title: 'Another errand', state: 'inbox' });
    const before = snapshot();
    await expect(
      actions.triage(other.ref.id, 7, planWith(graph.first5k.ref.id)),
    ).resolves.toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    expectNoWrites(before);
  });

  it('rejects the whole triage when a stale unlinked link changed before the transaction', async () => {
    const graph = milestoneGraph();
    const old = seed.link('milestone_action', graph.first5k.ref.id, graph.call.ref.id, {
      unlinkedAt: now,
      revision: 2,
    });
    useQueries({
      ...queries,
      findMilestoneActionLink: () => Promise.resolve({ ...old, localRevision: 1 }),
    });
    const before = snapshot();
    await expect(
      actions.triage(graph.call.ref.id, 1, planWith(graph.first5k.ref.id)),
    ).resolves.toMatchObject({ ok: false, error: { code: 'revision_conflict', ref: old.ref } });
    expectNoWrites(before);
  });
});

describe('permanent Action delete and Milestone links', () => {
  it('removes the Action’s unlinked Milestone links in the same transaction', async () => {
    const graph = milestoneGraph();
    const errand = seed.action({ title: 'Old errand', state: 'canceled' });
    const unlinkedA = seed.link('milestone_action', graph.first5k.ref.id, errand.ref.id, {
      unlinkedAt: now,
    });
    const unlinkedB = seed.link('milestone_action', graph.done.ref.id, errand.ref.id, {
      unlinkedAt: now,
      revision: 2,
    });
    const otherLink = seed.link('milestone_action', graph.first5k.ref.id, graph.call.ref.id, {
      unlinkedAt: now,
    });

    const deleted = receiptOf(await actions.deletePermanently(errand.ref.id, 1, 'Old errand'));
    expect(deleted.undo).toEqual({ available: false });
    expect(deleted.canonical.map(({ ref }) => ref.type).sort()).toEqual([
      'action',
      'milestone_action',
      'milestone_action',
    ]);
    expect(record(errand.ref)).toBeNull();
    expect(record(unlinkedA.ref)).toBeNull();
    expect(record(unlinkedB.ref)).toBeNull();
    expect(record(otherLink.ref)).toEqual(otherLink);
    expect(record(graph.first5k.ref)).toEqual(graph.first5k);
    expect(record(graph.done.ref)).toEqual(graph.done);
    expect(eventRows()).toEqual([
      ['milestone_action', 'action.permanently_deleted', { operation: 'delete' }],
      ['milestone_action', 'action.permanently_deleted', { operation: 'delete' }],
      ['action', 'action.permanently_deleted', { operation: 'delete' }],
    ]);
  });

  it('is still blocked by an active Milestone link', async () => {
    const graph = milestoneGraph();
    const errand = seed.action({ title: 'Old errand', state: 'canceled' });
    seed.link('milestone_action', graph.first5k.ref.id, errand.ref.id);
    seed.link('milestone_action', graph.done.ref.id, errand.ref.id, { unlinkedAt: now });
    const before = snapshot();
    await expect(actions.deletePermanently(errand.ref.id, 1, 'Old errand')).resolves.toMatchObject({
      ok: false,
      error: { code: 'domain_rejected', domainError: { code: 'delete_restricted' } },
    });
    expectNoWrites(before);
  });

  it('fails closed when a disclosed unlinked link changed or is not unlinked', async () => {
    const graph = milestoneGraph();
    const errand = seed.action({ title: 'Old errand', state: 'canceled' });
    const unlinked = seed.link('milestone_action', graph.first5k.ref.id, errand.ref.id, {
      unlinkedAt: now,
      revision: 2,
    });
    const active = seed.link('milestone_action', graph.done.ref.id, graph.call.ref.id);
    const before = snapshot();

    const impact = await queries.getActionDeleteImpact(ownerId, errand.ref.id);
    useQueries({
      ...queries,
      getActionDeleteImpact: () =>
        Promise.resolve({
          ...impact,
          inactiveMilestoneLinks: [{ ...unlinked, localRevision: 1 }],
        }),
    });
    await expect(actions.deletePermanently(errand.ref.id, 1, 'Old errand')).resolves.toMatchObject({
      ok: false,
      error: { code: 'revision_conflict', ref: unlinked.ref },
    });

    for (const wrong of [
      active,
      { ...unlinked, document: { ...unlinked.document, unlinkedAt: undefined } },
    ]) {
      useQueries({
        ...queries,
        getActionDeleteImpact: () =>
          Promise.resolve({ ...impact, inactiveMilestoneLinks: [wrong] }),
      });
      await expect(
        actions.deletePermanently(errand.ref.id, 1, 'Old errand'),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'domain_rejected',
          domainError: { details: { reason: 'delete_impact_changed' } },
        },
      });
    }
    expectNoWrites(before);
  });
});

/**
 * An Action named by review decisions in every state (an active and a removed choice in a draft,
 * and a decision in an archived review), plus records its delete must leave as they are.
 */
function reviewedAction() {
  const errand = seed.action({ title: 'Private errand', state: 'canceled' });
  const other = seed.action({ title: 'Other errand' });
  const draft = seed.review();
  const archivedReview = seed.review({
    state: 'archived',
    stateBeforeArchive: 'completed',
    completedAt: now,
    archivedAt: now,
  });
  const named = { kind: 'action', id: errand.ref.id } as const;
  const items = [
    seed.reviewItem(named, { reviewId: draft.ref.id, decision: 'commit' }),
    seed.reviewItem(named, { reviewId: draft.ref.id, decision: 'focus', archivedAt: now }),
    seed.reviewItem(named, { reviewId: archivedReview.ref.id, decision: 'focus' }),
  ];
  const unrelated = seed.reviewItem(
    { kind: 'action', id: other.ref.id },
    { reviewId: draft.ref.id, decision: 'commit' },
  );
  return { errand, items, kept: [other, draft, archivedReview, unrelated] };
}

const deletedActionTarget = { kind: 'deleted', deletedKind: 'action', deletedAt: now };

describe('permanent Action delete keeps review decisions', () => {
  it('keeps every review decision about the Action and clears only its reference', async () => {
    const graph = milestoneGraph();
    const { errand, items, kept } = reviewedAction();
    const unlinked = seed.link('milestone_action', graph.first5k.ref.id, errand.ref.id, {
      unlinkedAt: now,
    });
    const block: CanonicalRecordState = {
      ref: createEntityRef('time_block', '14000000-0000-4000-8000-000000000001' as UUID, ownerId),
      localRevision: 1,
      serverRevision: 0,
      baseSnapshotHash: null,
      document: {
        target: { kind: 'action', actionId: errand.ref.id },
        startsAt: '2026-09-27T05:00:00.000Z',
        endsAt: '2026-09-27T06:00:00.000Z',
        timeZone: 'Asia/Tashkent',
        state: 'completed',
        overlapAcknowledged: false,
      },
    };
    harness.unitOfWork.seed(block);
    const commandId = '13000000-0000-4000-8000-000000000002' as CommandId;

    const first = await actions.deletePermanently(errand.ref.id, 1, 'Private errand', commandId);
    const deleted = receiptOf(first);

    expect(deleted.undo).toEqual({ available: false });
    expect(harness.unitOfWork.state.undo).toEqual([]);
    expect(record(errand.ref)).toBeNull();
    expect(record(unlinked.ref)).toBeNull();
    for (const item of items) {
      expect(record(item.ref)).toEqual({
        ...item,
        localRevision: 2,
        document: { ...item.document, target: deletedActionTarget },
      });
    }
    for (const unchanged of kept) expect(record(unchanged.ref)).toEqual(unchanged);
    expect(record(block.ref)?.document).toMatchObject({
      target: { kind: 'custom', title: 'Deleted Action' },
    });
    expect(eventRows()).toEqual([
      ['milestone_action', 'action.permanently_deleted', { operation: 'delete' }],
      ['time_block', 'action.permanently_deleted', { operation: 'update' }],
      ...items.map(() => ['review_item', 'review_item.target_cleared', { operation: 'update' }]),
      ['action', 'action.permanently_deleted', { operation: 'delete' }],
    ]);
    // Nothing keeps the deleted title or a reference to it.
    const stored = JSON.stringify([...harness.unitOfWork.state.records.values()]);
    expect(stored).not.toContain('Private errand');
    expect(stored).not.toContain(errand.ref.id);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private errand');

    // A repeated command id returns its receipt and writes nothing; a new one finds nothing.
    const before = snapshot();
    await expect(
      actions.deletePermanently(errand.ref.id, 1, 'Private errand', commandId),
    ).resolves.toEqual(first);
    await expect(actions.deletePermanently(errand.ref.id, 1, 'Private errand')).resolves.toEqual({
      ok: false,
      error: { code: 'entity_not_found', ref: errand.ref },
    });
    expectNoWrites(before);
  });

  it('rolls back every kept review decision when the delete transaction fails', async () => {
    const { errand, items } = reviewedAction();
    const failing: UnitOfWorkPort = {
      runInTransaction: (work) =>
        harness.unitOfWork.runInTransaction((unit) =>
          work({
            ...unit,
            records: {
              read: (ref) => unit.records.read(ref),
              apply: (mutation, context) =>
                mutation.operation === 'delete'
                  ? Promise.reject(new Error('Storage is full'))
                  : unit.records.apply(mutation, context),
            },
          }),
        ),
    };
    const commandId = '13000000-0000-4000-8000-000000000003' as CommandId;
    const before = snapshot();

    await expect(
      createActionApplication(
        { ...harness.dependencies, unitOfWork: failing },
        queries,
      ).deletePermanently(errand.ref.id, 1, 'Private errand', commandId),
    ).resolves.toEqual({ ok: false, error: { code: 'transaction_failed' } });
    expectNoWrites(before);

    // Nothing was spent: the same command id deletes once storage recovers.
    receiptOf(await actions.deletePermanently(errand.ref.id, 1, 'Private errand', commandId));
    expect(record(errand.ref)).toBeNull();
    for (const item of items) expect(record(item.ref)?.localRevision).toBe(2);
  });

  it('fails closed without writing when a review decision changed after the impact was read', async () => {
    const { errand, items } = reviewedAction();
    const [first] = items;
    if (first === undefined) throw new Error('Expected review items.');
    const changed = {
      ...first,
      localRevision: 2,
      document: { ...first.document, decision: 'focus' },
    };
    useQueries({
      ...queries,
      async getActionDeleteImpact(owner, actionId) {
        const impact = await queries.getActionDeleteImpact(owner, actionId);
        harness.unitOfWork.seed(changed);
        return impact;
      },
    });

    await expect(actions.deletePermanently(errand.ref.id, 1, 'Private errand')).resolves.toEqual({
      ok: false,
      error: { code: 'revision_conflict', ref: first.ref, expectedRevision: 1, actualRevision: 2 },
    });
    expect(record(errand.ref)).toEqual(errand);
    expect(record(first.ref)).toEqual(changed);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('refuses without writing while a review item cannot be cleared', async () => {
    const { errand } = reviewedAction();
    const stranger = seed.reviewItem({ kind: 'action', id: seed.action().ref.id });
    const impact = await queries.getActionDeleteImpact(ownerId, errand.ref.id);
    const before = snapshot();

    useQueries({
      ...queries,
      getActionDeleteImpact: () =>
        Promise.resolve({ ...impact, reviewReferences: impact.reviewReferences + 1 }),
    });
    await expect(actions.deletePermanently(errand.ref.id, 1, 'Private errand')).resolves.toEqual({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: {
          code: 'delete_restricted',
          message:
            'Some history still refers to this Action. Archive it instead to keep that history.',
          details: { reason: 'delete_restricted', blockers: ['history_references'] },
        },
      },
    });

    useQueries({
      ...queries,
      getActionDeleteImpact: () =>
        Promise.resolve({
          ...impact,
          reviewItems: [...impact.reviewItems, stranger],
          reviewReferences: impact.reviewReferences + 1,
        }),
    });
    await expect(
      actions.deletePermanently(errand.ref.id, 1, 'Private errand'),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: { details: { reason: 'delete_impact_changed' } },
      },
    });
    expectNoWrites(before);
  });
});

function axisGraph() {
  const health = seed.axis({ title: 'Health' });
  const work = seed.axis({ title: 'Work' });
  const home = seed.axis({ title: 'Home' });
  const site = seed.project({
    title: 'Launch site',
    axisId: work.ref.id,
    state: 'active',
    desiredResult: 'A live site',
  });
  const loose = seed.project({ title: 'Loose project' });
  return { health, work, home, site, loose };
}

const crossAxisRejection = {
  ok: false,
  error: {
    code: 'domain_rejected',
    domainError: {
      code: 'cross_axis_confirmation_required',
      message: crossAxisMessage,
      details: { reason: 'cross_axis_confirmation_required', relationship: 'project_action' },
    },
  },
} as const;

describe('cross-Axis Action and Project confirmation', () => {
  it('capture asks to confirm an Action Axis that differs from its Project Axis', async () => {
    const graph = axisGraph();
    const intent = actions.newCaptureIntent('inbox');
    const input = {
      title: 'Call venue',
      axisId: graph.health.ref.id,
      projectId: graph.site.ref.id,
    };
    const before = snapshot();
    await expect(actions.capture(intent, input)).resolves.toMatchObject(crossAxisRejection);
    expectNoWrites(before);

    receiptOf(await actions.capture(intent, { ...input, confirmCrossAxis: true }));
    expect(record(createEntityRef('action', intent.actionId, ownerId))?.document).toMatchObject({
      axisId: graph.health.ref.id,
      projectId: graph.site.ref.id,
    });
    for (const needsNoConfirmation of [
      { title: 'Same Axis', axisId: graph.work.ref.id, projectId: graph.site.ref.id },
      { title: 'Project Axis only', projectId: graph.site.ref.id },
      { title: 'Project without Axis', axisId: graph.health.ref.id, projectId: graph.loose.ref.id },
      { title: 'Axis only', axisId: graph.health.ref.id },
    ])
      receiptOf(await actions.capture(actions.newCaptureIntent('inbox'), needsNoConfirmation));
  });

  it('edit asks again only when the Axis or the Project changes', async () => {
    const graph = axisGraph();
    const errand = seed.action({ title: 'Errand', axisId: graph.health.ref.id });
    const linked = { title: 'Errand', axisId: graph.health.ref.id, projectId: graph.site.ref.id };
    const before = snapshot();
    await expect(actions.edit(errand.ref.id, 1, linked)).resolves.toMatchObject(crossAxisRejection);
    expectNoWrites(before);

    receiptOf(await actions.edit(errand.ref.id, 1, { ...linked, confirmCrossAxis: true }));
    receiptOf(await actions.edit(errand.ref.id, 2, { ...linked, title: 'Errand, renamed' }));
    expect(record(errand.ref)?.document).toMatchObject({
      title: 'Errand, renamed',
      axisId: graph.health.ref.id,
      projectId: graph.site.ref.id,
    });

    const moved = { ...linked, axisId: graph.home.ref.id };
    await expect(actions.edit(errand.ref.id, 3, moved)).resolves.toMatchObject(crossAxisRejection);
    receiptOf(await actions.edit(errand.ref.id, 3, { ...moved, confirmCrossAxis: true }));
    receiptOf(
      await actions.edit(errand.ref.id, 4, { title: 'Errand', projectId: graph.site.ref.id }),
    );
    expect(record(errand.ref)?.document).not.toHaveProperty('axisId');
  });

  it('never asks when a Project moved to another Axis after an unchanged pair was saved', async () => {
    const graph = axisGraph();
    const errand = seed.action({
      title: 'Errand',
      axisId: graph.health.ref.id,
      projectId: graph.site.ref.id,
    });
    receiptOf(
      await actions.edit(errand.ref.id, 1, {
        title: 'Errand with a note',
        note: 'Bring the plan',
        axisId: graph.health.ref.id,
        projectId: graph.site.ref.id,
      }),
    );
  });

  it('triage asks to confirm a Project in a different Axis, and nothing is linked until then', async () => {
    const graph = axisGraph();
    const run = seed.outcome({ title: 'Run a 10k' });
    const first5k = seed.milestone(run.ref.id, { title: 'First 5k' });
    const errand = seed.action({ title: 'Errand', axisId: graph.health.ref.id, state: 'inbox' });
    const choice = planWith(first5k.ref.id, { projectId: graph.site.ref.id });
    const before = snapshot();
    await expect(actions.triage(errand.ref.id, 1, choice)).resolves.toMatchObject(
      crossAxisRejection,
    );
    expectNoWrites(before);

    receiptOf(await actions.triage(errand.ref.id, 1, { ...choice, confirmCrossAxis: true }));
    expect(record(errand.ref)?.document).toMatchObject({
      state: 'planned',
      axisId: graph.health.ref.id,
      projectId: graph.site.ref.id,
    });
    expect(linkRecords()).toHaveLength(1);
  });

  it('bulk Project and Axis changes ask to confirm and write nothing until confirmed', async () => {
    const graph = axisGraph();
    const first = seed.action({ title: 'A', axisId: graph.health.ref.id, state: 'inbox' });
    const second = seed.action({ title: 'B', state: 'inbox' });
    const items = [
      { id: first.ref.id, revision: 1 },
      { id: second.ref.id, revision: 1 },
    ];
    const before = snapshot();
    await expect(
      actions.bulk(items, { kind: 'project', projectId: graph.site.ref.id }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: {
          code: 'cross_axis_confirmation_required',
          message:
            '1 selected Action is in a different Axis than this Project. Confirm to link it.',
          details: {
            reason: 'cross_axis_confirmation_required',
            relationship: 'project_action',
            count: 1,
          },
        },
      },
    });
    expectNoWrites(before);
    receiptOf(
      await actions.bulk(items, {
        kind: 'project',
        projectId: graph.site.ref.id,
        confirmCrossAxis: true,
      }),
    );
    expect(record(first.ref)?.document).toMatchObject({ projectId: graph.site.ref.id });
    expect(record(second.ref)?.document).toMatchObject({ projectId: graph.site.ref.id });

    const third = seed.action({ title: 'C', projectId: graph.site.ref.id, state: 'inbox' });
    const fourth = seed.action({ title: 'D', state: 'inbox' });
    const fifth = seed.action({ title: 'E', projectId: graph.site.ref.id, state: 'inbox' });
    const moving = [
      { id: third.ref.id, revision: 1 },
      { id: fourth.ref.id, revision: 1 },
      { id: fifth.ref.id, revision: 1 },
    ];
    const beforeAxis = snapshot();
    await expect(
      actions.bulk(moving, { kind: 'axis', axisId: graph.health.ref.id }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        domainError: {
          code: 'cross_axis_confirmation_required',
          message:
            '2 selected Actions belong to a Project in a different Axis. Confirm to change their Axis.',
          details: { count: 2 },
        },
      },
    });
    expectNoWrites(beforeAxis);
    receiptOf(
      await actions.bulk(moving, {
        kind: 'axis',
        axisId: graph.health.ref.id,
        confirmCrossAxis: true,
      }),
    );
    receiptOf(
      await actions.bulk(
        moving.map((item) => ({ ...item, revision: 2 })),
        { kind: 'axis', axisId: graph.work.ref.id },
      ),
    );
    receiptOf(
      await actions.bulk(
        moving.map((item) => ({ ...item, revision: 3 })),
        { kind: 'axis' },
      ),
    );
    expect(record(third.ref)?.document).not.toHaveProperty('axisId');
  });
});
