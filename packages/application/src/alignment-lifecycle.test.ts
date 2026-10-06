import {
  createEntityRef,
  createMonthPeriod,
  createWeekPeriod,
  entityRefKey,
  type AlignmentKind,
  type CalendarDate,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AlignmentLifecycleMethods,
  AlignmentQueryPort,
  RevisionRef,
} from './alignment-contracts';
import { createAlignmentKit } from './alignment-kit';
import { createAlignmentLifecycleCommands } from './alignment-lifecycle';
import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import type { PlanProfile } from './planning-contracts';
import { createPlanningApplication } from './planning';
import { updateFrom } from './planning-kit';
import { createTestPlanningQueries } from './planning-routines-test-queries';
import type { UnitOfWorkPort } from './ports';
import {
  createAlignmentSeeder,
  createAlignmentTestQueries,
  type AlignmentSeeder,
} from './testing/alignment-test-queries';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const otherOwnerId = '10000000-0000-4000-8000-000000000002' as OwnerId;
const now = '2026-09-28T13:00:00.000Z' as Instant;
const earlier = '2026-09-01T08:00:00.000Z' as Instant;
const missingId = 'a0000000-0000-4000-8000-000000000404' as UUID;
const commandId = '90000000-0000-4000-8000-000000000001' as UUID;
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: 'Asia/Tashkent' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
const archived = { state: 'archived', archivedAt: earlier } as const;
const month = createMonthPeriod('2026-10-01' as CalendarDate);
const week = createWeekPeriod('2026-09-28' as CalendarDate, 'monday');
const kinds: readonly AlignmentKind[] = ['axis', 'outcome', 'project', 'milestone'];

let harness: InMemoryHarness;
let seed: AlignmentSeeder;
let queries: AlignmentQueryPort;
let lifecycle: AlignmentLifecycleMethods;

const lifecycleWith = (port: AlignmentQueryPort) =>
  createAlignmentLifecycleCommands(createAlignmentKit(harness.dependencies, port));

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  seed = createAlignmentSeeder(harness.unitOfWork, ownerId);
  queries = createAlignmentTestQueries(harness.unitOfWork);
  lifecycle = lifecycleWith(queries);
});

function valueOf<T>(result: ApplicationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const errorOf = (result: ApplicationResult<unknown>) => (result.ok ? null : result.error);

const read = (record: CanonicalRecordState) =>
  harness.unitOfWork.get(entityRefKey(record.ref)) ?? null;

const events = () =>
  harness.unitOfWork.state.events.map(({ event }) => ({
    eventType: event.eventType,
    aggregate: event.aggregate,
    payload: event.payload,
  }));

/** Everything a rejected command must leave exactly as it was. */
const persisted = () => ({
  records: [...harness.unitOfWork.state.records.entries()],
  events: harness.unitOfWork.state.events.length,
  undo: harness.unitOfWork.state.undo.length,
  receipts: harness.unitOfWork.state.receipts.size,
});

async function undo(receipt: CommandReceipt): Promise<CommandReceipt> {
  if (!receipt.undo.available) throw new Error('Expected an undoable change.');
  return valueOf(
    await createPlanningApplication(
      harness.dependencies,
      createTestPlanningQueries(harness.unitOfWork, profile),
    ).undo(receipt.undo.undoId),
  );
}

const refOf = <K extends AlignmentKind>(kind: K, record: CanonicalRecordState): RevisionRef<K> => ({
  kind,
  id: record.ref.id,
  revision: record.localRevision,
});

const without = (record: CanonicalRecordState, ...fields: readonly string[]) =>
  Object.fromEntries(Object.entries(record.document).filter(([key]) => !fields.includes(key)));

/** A live target plus records that archiving it must leave untouched. */
function archiveFixture(kind: AlignmentKind): {
  readonly target: CanonicalRecordState;
  readonly others: readonly CanonicalRecordState[];
  readonly state: string;
} {
  switch (kind) {
    case 'axis': {
      const target = seed.axis({ title: 'Private axis title' });
      const outcome = seed.outcome({ axisId: target.ref.id });
      const action = seed.action({ axisId: target.ref.id });
      return { target, others: [outcome, action], state: 'active' };
    }
    case 'outcome': {
      const target = seed.outcome({ title: 'Private outcome title', state: 'paused' });
      const milestone = seed.milestone(target.ref.id);
      const placement = seed.placement('outcome', target.ref.id, month);
      return { target, others: [milestone, placement], state: 'paused' };
    }
    case 'project': {
      const target = seed.project({
        title: 'Private project title',
        state: 'blocked',
        desiredResult: 'A result',
      });
      const action = seed.action({ projectId: target.ref.id });
      const placement = seed.placement('project', target.ref.id, week);
      const selection = seed.weekSelection('project', target.ref.id);
      return { target, others: [action, placement, selection], state: 'blocked' };
    }
    case 'milestone': {
      const outcome = seed.outcome();
      const target = seed.milestone(outcome.ref.id, {
        title: 'Private milestone title',
        state: 'completed',
      });
      const project = seed.project();
      const link = seed.link('milestone_project', target.ref.id, project.ref.id);
      const placement = seed.placement('milestone', target.ref.id, week);
      return { target, others: [outcome, project, link, placement], state: 'completed' };
    }
  }
}

describe('archive', () => {
  it.each(kinds)(
    'archives only the %s, keeps its placement and children, and undo restores it',
    async (kind) => {
      const { target, others, state } = archiveFixture(kind);

      const receipt = valueOf(await lifecycle.archive(refOf(kind, target), commandId));

      expect(receipt.canonical).toEqual([{ ref: target.ref, localRevision: 2 }]);
      expect(read(target)?.document).toEqual({
        ...target.document,
        state: 'archived',
        stateBeforeArchive: state,
        archivedAt: now,
      });
      for (const other of others) expect(read(other)).toEqual(other);
      expect(events()).toEqual([
        { eventType: `${kind}.archived`, aggregate: target.ref, payload: { operation: 'update' } },
      ]);
      expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private');
      await expect(lifecycle.archive(refOf(kind, target), commandId)).resolves.toEqual({
        ok: true,
        value: receipt,
      });

      await undo(receipt);
      expect(read(target)?.document).toEqual(target.document);
      for (const other of others) expect(read(other)).toEqual(other);
    },
  );

  it('refuses to archive what is already archived, a stale revision, or a bad target', async () => {
    const outcome = seed.outcome({ ...archived, stateBeforeArchive: 'active' });
    const axis = seed.axis({}, { revision: 2 });
    const before = persisted();

    expect(errorOf(await lifecycle.archive(refOf('outcome', outcome)))).toEqual({
      code: 'domain_rejected',
      domainError: {
        code: 'invalid_transition',
        message: 'This Outcome is already archived.',
        details: { reason: 'already_archived', entityType: 'outcome' },
      },
    });
    expect(
      errorOf(await lifecycle.archive({ kind: 'axis', id: axis.ref.id, revision: 1 })),
    ).toEqual({ code: 'revision_conflict', ref: axis.ref, expectedRevision: 1, actualRevision: 2 });
    expect(errorOf(await lifecycle.archive({ kind: 'axis', id: missingId, revision: 1 }))).toEqual({
      code: 'entity_not_found',
      ref: createEntityRef('axis', missingId, ownerId),
    });
    expect(
      errorOf(await lifecycle.archive({ kind: 'axis', id: 'not-an-id', revision: 1 })),
    ).toMatchObject({
      code: 'domain_rejected',
      domainError: { code: 'invalid_uuid', message: 'That item is no longer available.' },
    });
    expect(
      errorOf(
        await lifecycle.archive({
          kind: 'action',
          id: axis.ref.id,
          revision: 2,
        } as unknown as RevisionRef),
      ),
    ).toMatchObject({ code: 'domain_rejected', domainError: { code: 'invalid_value' } });
    expect(persisted()).toEqual(before);
  });
});

describe('restore', () => {
  it('returns to the recorded state; undo archives it again', async () => {
    const outcome = seed.outcome({
      ...archived,
      stateBeforeArchive: 'paused',
      title: 'Private outcome title',
    });

    const receipt = valueOf(await lifecycle.restore(refOf('outcome', outcome), commandId));

    expect(read(outcome)?.document).toEqual({
      ...without(outcome, 'stateBeforeArchive', 'archivedAt'),
      state: 'paused',
    });
    expect(events()).toEqual([
      { eventType: 'outcome.restored', aggregate: outcome.ref, payload: { operation: 'update' } },
    ]);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private');
    await expect(lifecycle.restore(refOf('outcome', outcome), commandId)).resolves.toEqual({
      ok: true,
      value: receipt,
    });

    await undo(receipt);
    expect(read(outcome)?.document).toEqual(outcome.document);
  });

  it('falls back to active, and to idea for a Project without a desired result', async () => {
    const idea = seed.project({ ...archived, stateBeforeArchive: 'active' });
    const withResult = seed.project({ ...archived, desiredResult: 'A result' });
    const axis = seed.axis({ ...archived });
    const parent = seed.outcome({ ...archived, stateBeforeArchive: 'active' });
    const milestone = seed.milestone(parent.ref.id, {
      ...archived,
      stateBeforeArchive: 'canceled',
    });

    for (const [kind, record, state] of [
      ['project', idea, 'idea'],
      ['project', withResult, 'active'],
      ['axis', axis, 'active'],
      ['milestone', milestone, 'canceled'],
    ] as const) {
      valueOf(await lifecycle.restore(refOf(kind, record)));
      expect(read(record)?.document).toEqual({
        ...without(record, 'stateBeforeArchive', 'archivedAt'),
        state,
      });
    }
    expect(read(parent)).toEqual(parent);
  });

  it('refuses to restore what is not archived or a Milestone whose Outcome is gone', async () => {
    const axis = seed.axis();
    const orphan = seed.milestone(missingId, { ...archived, stateBeforeArchive: 'active' });
    const before = persisted();

    expect(errorOf(await lifecycle.restore(refOf('axis', axis)))).toMatchObject({
      code: 'domain_rejected',
      domainError: { code: 'invalid_transition', message: 'This Axis is not archived.' },
    });
    expect(errorOf(await lifecycle.restore(refOf('milestone', orphan)))).toEqual({
      code: 'domain_rejected',
      domainError: {
        code: 'required_relationship',
        message: 'Its Outcome is no longer available, so this Milestone cannot be restored.',
        details: { reason: 'required_parent_missing' },
      },
    });
    expect(persisted()).toEqual(before);
  });
});

describe('previewArchive and previewRestore', () => {
  it('lists the active children that stay and whether a placement is kept', async () => {
    const outcome = seed.outcome({ title: 'Run' });
    seed.milestone(outcome.ref.id);
    seed.milestone(outcome.ref.id, { state: 'completed' });
    seed.milestone(outcome.ref.id, { ...archived, stateBeforeArchive: 'active' });
    seed.project({ primaryOutcomeId: outcome.ref.id });
    seed.placement('outcome', outcome.ref.id, month);
    const project = seed.project({ title: 'Launch site' });
    seed.placement('project', project.ref.id, week, { archivedAt: earlier });
    const axis = seed.axis({ title: 'Health' });
    const before = persisted();

    await expect(
      lifecycle.previewArchive({ kind: 'outcome', id: outcome.ref.id }),
    ).resolves.toEqual({
      target: {
        id: outcome.ref.id,
        kind: 'outcome',
        title: 'Run',
        state: 'active',
        archived: false,
        localRevision: 1,
      },
      activeChildren: { milestone: 2, project: 1 },
      placementKept: true,
      remindersToDisable: 0,
    });
    await expect(
      lifecycle.previewArchive({ kind: 'project', id: project.ref.id }),
    ).resolves.toMatchObject({ activeChildren: {}, placementKept: false });
    await expect(
      lifecycle.previewArchive({ kind: 'axis', id: axis.ref.id }),
    ).resolves.toMatchObject({
      target: { kind: 'axis', title: 'Health' },
      activeChildren: {},
      placementKept: false,
    });
    expect(persisted()).toEqual(before);
  });

  it('previews the state a restore returns to and what blocks it', async () => {
    const project = seed.project({ ...archived, stateBeforeArchive: 'active' });
    const outcome = seed.outcome({ ...archived, stateBeforeArchive: 'achieved' });
    const live = seed.outcome();
    const orphan = seed.milestone(missingId, { ...archived, stateBeforeArchive: 'active' });

    await expect(
      lifecycle.previewRestore({ kind: 'project', id: project.ref.id }),
    ).resolves.toEqual({ allowed: true, blockers: [], restoresTo: 'idea' });
    await expect(
      lifecycle.previewRestore({ kind: 'outcome', id: outcome.ref.id }),
    ).resolves.toEqual({ allowed: true, blockers: [], restoresTo: 'achieved' });
    await expect(lifecycle.previewRestore({ kind: 'outcome', id: live.ref.id })).resolves.toEqual({
      allowed: false,
      blockers: [],
      restoresTo: 'active',
    });
    await expect(
      lifecycle.previewRestore({ kind: 'milestone', id: orphan.ref.id }),
    ).resolves.toEqual({
      allowed: false,
      blockers: ['required_parent_missing'],
      restoresTo: 'active',
    });
  });

  it('returns null for malformed, unknown, mistyped, and foreign targets', async () => {
    const foreign = createAlignmentSeeder(
      harness.unitOfWork,
      otherOwnerId,
      'e0000000-0000-4000-8000-',
    ).axis();
    const axis = seed.axis();
    for (const target of [
      { kind: 'axis', id: 'not-an-id' },
      { kind: 'axis', id: missingId },
      { kind: 'axis', id: foreign.ref.id },
      { kind: 'outcome', id: axis.ref.id },
      { kind: 'action', id: axis.ref.id },
    ] as const) {
      const request = target as unknown as { readonly kind: AlignmentKind; readonly id: string };
      await expect(lifecycle.previewArchive(request)).resolves.toBeNull();
      await expect(lifecycle.previewRestore(request)).resolves.toBeNull();
      await expect(lifecycle.previewDelete(request, 'restrict')).resolves.toBeNull();
    }
  });
});

/** A Project with every kind of optional reference, plus its own history rows. */
function projectGraph() {
  const project = seed.project({ title: 'Launch site', state: 'active', desiredResult: 'Live' });
  const action = seed.action({ title: 'Draft copy', projectId: project.ref.id });
  const note = seed.note({ title: 'Idea list', projectId: project.ref.id });
  const outcome = seed.outcome({ title: 'Grow reach' });
  const milestone = seed.milestone(outcome.ref.id, { title: 'Beta' });
  const oldMilestone = seed.milestone(outcome.ref.id, { title: 'Alpha' });
  const supporting = seed.link('outcome_secondary_project', outcome.ref.id, project.ref.id);
  const milestoneLink = seed.link('milestone_project', milestone.ref.id, project.ref.id);
  const oldLink = seed.link('milestone_project', oldMilestone.ref.id, project.ref.id, {
    unlinkedAt: earlier,
  });
  const placement = seed.placement('project', project.ref.id, week);
  const oldPlacement = seed.placement('project', project.ref.id, month, { archivedAt: earlier });
  const selection = seed.weekSelection('project', project.ref.id);
  const oldSelection = seed.weekSelection('project', project.ref.id, { archivedAt: earlier });
  return {
    project,
    action,
    note,
    outcome,
    milestone,
    oldMilestone,
    supporting,
    milestoneLink,
    oldLink,
    placement,
    oldPlacement,
    selection,
    oldSelection,
  };
}

describe('previewDelete', () => {
  it('shows what each policy would remove and what always goes with the target', async () => {
    const graph = projectGraph();
    const before = persisted();

    const restrict = await lifecycle.previewDelete(
      { kind: 'project', id: graph.project.ref.id },
      'restrict',
    );
    expect(restrict).toEqual({
      target: {
        id: graph.project.ref.id,
        kind: 'project',
        title: 'Launch site',
        state: 'active',
        archived: false,
        localRevision: 1,
      },
      policy: 'restrict',
      allowed: false,
      blockers: ['live_optional_relationships', 'placements', 'selections'],
      requiredChildren: { items: [], total: 0 },
      optionalLinks: {
        items: [
          {
            kind: 'action',
            id: graph.action.ref.id,
            title: 'Draft copy',
            relationship: 'project_action',
            archived: false,
          },
          {
            kind: 'note',
            id: graph.note.ref.id,
            title: 'Idea list',
            relationship: 'project_note',
            archived: false,
          },
          {
            kind: 'outcome',
            id: graph.outcome.ref.id,
            title: 'Grow reach',
            relationship: 'outcome_secondary_project',
            archived: false,
          },
          {
            kind: 'milestone',
            id: graph.milestone.ref.id,
            title: 'Beta',
            relationship: 'milestone_project',
            archived: false,
          },
          { kind: 'placement', id: graph.placement.ref.id, archived: false },
          { kind: 'selection', id: graph.selection.ref.id, archived: false },
        ],
        total: 6,
      },
      placements: 1,
      selections: 1,
      historyReferences: { reviews: 0, routineDefaults: 0 },
      removedHistory: { inactiveLinks: 1, archivedPlacements: 1, archivedSelections: 1 },
      pendingSync: false,
      openConflict: false,
      confirmationText: 'Launch site',
    });
    await expect(
      lifecycle.previewDelete({ kind: 'project', id: graph.project.ref.id }, 'unlink_and_delete'),
    ).resolves.toMatchObject({ policy: 'unlink_and_delete', allowed: true, blockers: [] });
    expect(persisted()).toEqual(before);
  });

  it('lists at most 200 optional links with their full total', async () => {
    const project = seed.project({ title: 'Big project' });
    for (let index = 0; index < 203; index += 1) seed.action({ projectId: project.ref.id });
    seed.placement('project', project.ref.id, week);

    const preview = await lifecycle.previewDelete(
      { kind: 'project', id: project.ref.id },
      'unlink_and_delete',
    );

    expect(preview?.optionalLinks.items).toHaveLength(200);
    expect(preview?.optionalLinks.total).toBe(204);
    expect(preview?.optionalLinks.items.every((item) => item.kind === 'action')).toBe(true);
    expect(preview?.placements).toBe(1);
  });

  it('shows blockers that no policy lifts', async () => {
    const outcome = seed.outcome({ title: 'Run' });
    const first = seed.milestone(outcome.ref.id, { title: 'First 5k' });
    seed.milestone(outcome.ref.id, { ...archived, stateBeforeArchive: 'active', title: 'Old' });
    const project = seed.project({ title: 'Plan' });
    seed.reviewItem({ kind: 'project', id: project.ref.id }, { reviewId: seed.review().ref.id });
    seed.routineDefaults(project.ref.id);

    for (const policy of ['restrict', 'unlink_and_delete'] as const) {
      await expect(
        lifecycle.previewDelete({ kind: 'outcome', id: outcome.ref.id }, policy),
      ).resolves.toMatchObject({
        allowed: false,
        blockers: ['required_children'],
        requiredChildren: {
          total: 2,
          items: [
            {
              kind: 'milestone',
              id: first.ref.id,
              title: 'First 5k',
              relationship: 'outcome_milestone',
              archived: false,
            },
            { kind: 'milestone', title: 'Old', archived: true },
          ],
        },
      });
      await expect(
        lifecycle.previewDelete({ kind: 'project', id: project.ref.id }, policy),
      ).resolves.toMatchObject({
        allowed: false,
        blockers: ['history_references'],
        historyReferences: { reviews: 1, routineDefaults: 1 },
      });
    }
  });
});

describe('deletePermanently', () => {
  it('deletes the target with its own history rows, never another object, and without undo', async () => {
    const outcome = seed.outcome({ title: 'Private outcome title' });
    const milestone = seed.milestone(outcome.ref.id, { title: 'Private checkpoint' });
    const project = seed.project();
    const action = seed.action();
    const oldProjectLink = seed.link('milestone_project', milestone.ref.id, project.ref.id, {
      unlinkedAt: earlier,
    });
    const oldActionLink = seed.link('milestone_action', milestone.ref.id, action.ref.id, {
      unlinkedAt: earlier,
    });
    const oldPlacement = seed.placement('milestone', milestone.ref.id, week, {
      archivedAt: earlier,
    });
    const oldSelection = seed.weekSelection('milestone', milestone.ref.id, {
      archivedAt: earlier,
    });

    const receipt = valueOf(
      await lifecycle.deletePermanently(
        {
          target: refOf('milestone', milestone),
          policy: 'restrict',
          confirmation: 'Private checkpoint',
        },
        commandId,
      ),
    );

    expect(receipt.undo).toEqual({ available: false });
    expect(harness.unitOfWork.state.undo).toEqual([]);
    for (const gone of [milestone, oldProjectLink, oldActionLink, oldPlacement, oldSelection])
      expect(read(gone)).toBeNull();
    for (const kept of [outcome, project, action]) expect(read(kept)).toEqual(kept);
    expect(events()).toEqual([
      {
        eventType: 'milestone.deleted',
        aggregate: oldProjectLink.ref,
        payload: { operation: 'delete', relationship: 'milestone_project' },
      },
      {
        eventType: 'milestone.deleted',
        aggregate: oldActionLink.ref,
        payload: { operation: 'delete', relationship: 'milestone_action' },
      },
      {
        eventType: 'milestone.deleted',
        aggregate: oldPlacement.ref,
        payload: { operation: 'delete' },
      },
      {
        eventType: 'milestone.deleted',
        aggregate: oldSelection.ref,
        payload: { operation: 'delete' },
      },
      {
        eventType: 'milestone.deleted',
        aggregate: milestone.ref,
        payload: { operation: 'delete' },
      },
    ]);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private');
    expect(harness.unitOfWork.state.receipts.size).toBe(1);

    await expect(
      lifecycle.deletePermanently(
        {
          target: refOf('milestone', milestone),
          policy: 'restrict',
          confirmation: 'Private checkpoint',
        },
        commandId,
      ),
    ).resolves.toEqual({ ok: true, value: receipt });
    await expect(
      lifecycle.deletePermanently({
        target: refOf('milestone', milestone),
        policy: 'restrict',
        confirmation: 'Private checkpoint',
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'entity_not_found', ref: milestone.ref } });
  });

  it('keeps everything under restrict while links, placements, or selections remain', async () => {
    const graph = projectGraph();
    const before = persisted();

    expect(
      errorOf(
        await lifecycle.deletePermanently({
          target: refOf('project', graph.project),
          policy: 'restrict',
          confirmation: 'Launch site',
        }),
      ),
    ).toEqual({
      code: 'domain_rejected',
      domainError: {
        code: 'delete_restricted',
        message:
          'This Project is still linked to other items or placed in your plan. Remove those first, or choose to remove them with it.',
        details: {
          reason: 'delete_restricted',
          blockers: ['live_optional_relationships', 'placements', 'selections'],
        },
      },
    });
    expect(persisted()).toEqual(before);
  });

  it('with unlink_and_delete clears optional links and removes join rows, placements, and selections', async () => {
    const graph = projectGraph();

    const receipt = valueOf(
      await lifecycle.deletePermanently({
        target: refOf('project', graph.project),
        policy: 'unlink_and_delete',
        confirmation: 'Launch site',
      }),
    );

    expect(receipt.undo).toEqual({ available: false });
    expect(read(graph.project)).toBeNull();
    expect(read(graph.action)).toMatchObject({
      localRevision: 2,
      document: without(graph.action, 'projectId'),
    });
    expect(read(graph.note)).toMatchObject({
      localRevision: 2,
      document: without(graph.note, 'projectId'),
    });
    for (const kept of [graph.outcome, graph.milestone, graph.oldMilestone])
      expect(read(kept)).toEqual(kept);
    for (const gone of [
      graph.supporting,
      graph.milestoneLink,
      graph.oldLink,
      graph.placement,
      graph.oldPlacement,
      graph.selection,
      graph.oldSelection,
    ])
      expect(read(gone)).toBeNull();
    const projectId = graph.project.ref.id;
    expect(events()).toEqual([
      {
        eventType: 'project.deleted',
        aggregate: graph.action.ref,
        payload: { operation: 'update', relationship: 'project_action', previousId: projectId },
      },
      {
        eventType: 'project.deleted',
        aggregate: graph.note.ref,
        payload: { operation: 'update', relationship: 'project_note', previousId: projectId },
      },
      {
        eventType: 'project.deleted',
        aggregate: graph.supporting.ref,
        payload: { operation: 'delete', relationship: 'outcome_secondary_project' },
      },
      {
        eventType: 'project.deleted',
        aggregate: graph.milestoneLink.ref,
        payload: { operation: 'delete', relationship: 'milestone_project' },
      },
      {
        eventType: 'project.deleted',
        aggregate: graph.oldLink.ref,
        payload: { operation: 'delete', relationship: 'milestone_project' },
      },
      {
        eventType: 'project.deleted',
        aggregate: graph.placement.ref,
        payload: { operation: 'delete' },
      },
      {
        eventType: 'project.deleted',
        aggregate: graph.oldPlacement.ref,
        payload: { operation: 'delete' },
      },
      {
        eventType: 'project.deleted',
        aggregate: graph.selection.ref,
        payload: { operation: 'delete' },
      },
      {
        eventType: 'project.deleted',
        aggregate: graph.oldSelection.ref,
        payload: { operation: 'delete' },
      },
      {
        eventType: 'project.deleted',
        aggregate: graph.project.ref,
        payload: { operation: 'delete' },
      },
    ]);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toMatch(
      /Launch site|Draft copy|Idea list|Grow reach/,
    );
  });

  it('clears the Axis of every member, archived ones included, and deletes only the Axis', async () => {
    const axis = seed.axis({ title: 'Health' });
    const outcome = seed.outcome({
      axisId: axis.ref.id,
      ...archived,
      stateBeforeArchive: 'active',
    });
    const project = seed.project({ axisId: axis.ref.id });
    const routine = seed.routine({ axisId: axis.ref.id });
    const action = seed.action({ axisId: axis.ref.id });
    const note = seed.note({ axisId: axis.ref.id });
    const target = refOf('axis', axis);
    const before = persisted();

    expect(
      errorOf(
        await lifecycle.deletePermanently({ target, policy: 'restrict', confirmation: 'Health' }),
      ),
    ).toMatchObject({
      domainError: {
        code: 'delete_restricted',
        details: { blockers: ['live_optional_relationships'] },
      },
    });
    expect(persisted()).toEqual(before);

    valueOf(
      await lifecycle.deletePermanently({
        target,
        policy: 'unlink_and_delete',
        confirmation: 'Health',
      }),
    );

    expect(read(axis)).toBeNull();
    for (const member of [outcome, project, routine, action, note]) {
      expect(read(member)).toMatchObject({
        localRevision: 2,
        document: without(member, 'axisId'),
      });
    }
    expect(read(outcome)?.document['state']).toBe('archived');
    expect(events().map(({ aggregate, payload }) => [aggregate.type, payload])).toEqual([
      ['outcome', { operation: 'update', relationship: 'axis_outcome', previousId: axis.ref.id }],
      ['project', { operation: 'update', relationship: 'axis_project', previousId: axis.ref.id }],
      ['routine', { operation: 'update', relationship: 'axis_routine', previousId: axis.ref.id }],
      ['action', { operation: 'update', previousId: axis.ref.id }],
      ['note', { operation: 'update', previousId: axis.ref.id }],
      ['axis', { operation: 'delete' }],
    ]);
  });

  it('clears the primary Outcome of its Projects and removes supporting links', async () => {
    const outcome = seed.outcome({ title: 'Grow reach' });
    const primary = seed.project({ primaryOutcomeId: outcome.ref.id, title: 'Launch' });
    const supported = seed.project({ title: 'Blog' });
    const supporting = seed.link('outcome_secondary_project', outcome.ref.id, supported.ref.id);
    const placement = seed.placement('outcome', outcome.ref.id, month);

    valueOf(
      await lifecycle.deletePermanently({
        target: refOf('outcome', outcome),
        policy: 'unlink_and_delete',
        confirmation: 'Grow reach',
      }),
    );

    expect(read(outcome)).toBeNull();
    expect(read(primary)?.document).toEqual(without(primary, 'primaryOutcomeId'));
    expect(read(supported)).toEqual(supported);
    expect(read(supporting)).toBeNull();
    expect(read(placement)).toBeNull();
    expect(events().map(({ aggregate, payload }) => [aggregate.type, payload])).toEqual([
      [
        'project',
        {
          operation: 'update',
          relationship: 'outcome_primary_project',
          previousId: outcome.ref.id,
        },
      ],
      [
        'project_secondary_outcome',
        { operation: 'delete', relationship: 'outcome_secondary_project' },
      ],
      ['planning_placement', { operation: 'delete' }],
      ['outcome', { operation: 'delete' }],
    ]);
  });

  it('keeps an Outcome that still owns Milestones under every policy', async () => {
    const outcome = seed.outcome({ title: 'Run' });
    seed.milestone(outcome.ref.id);
    seed.milestone(outcome.ref.id, { state: 'canceled' });
    seed.milestone(outcome.ref.id, { ...archived, stateBeforeArchive: 'active' });
    const before = persisted();

    for (const policy of ['restrict', 'unlink_and_delete'] as const) {
      expect(
        errorOf(
          await lifecycle.deletePermanently({
            target: refOf('outcome', outcome),
            policy,
            confirmation: 'Run',
          }),
        ),
      ).toEqual({
        code: 'domain_rejected',
        domainError: {
          code: 'delete_restricted',
          message: 'This Outcome still owns 3 milestones. Move or delete each one first.',
          details: { reason: 'delete_restricted', blockers: ['required_children'] },
        },
      });
    }
    expect(persisted()).toEqual(before);
  });

  it('keeps a Project that Routine defaults still name under every policy', async () => {
    const project = seed.project({ title: 'Plan' });
    const item = seed.reviewItem({ kind: 'project', id: project.ref.id });
    seed.routineDefaults(project.ref.id);
    const before = persisted();

    for (const policy of ['restrict', 'unlink_and_delete'] as const) {
      expect(
        errorOf(
          await lifecycle.deletePermanently({
            target: refOf('project', project),
            policy,
            confirmation: 'Plan',
          }),
        ),
      ).toEqual({
        code: 'domain_rejected',
        domainError: {
          code: 'delete_restricted',
          message:
            'Routine defaults still refer to this Project. Archive it instead to keep that history.',
          details: { reason: 'delete_restricted', blockers: ['history_references'] },
        },
      });
    }
    expect(read(item)).toEqual(item);
    expect(persisted()).toEqual(before);
  });

  it('waits while a change to the target has not synced yet', async () => {
    const axis = seed.axis({ title: 'Health' });
    const groupId = '80000000-0000-4000-8000-000000000001' as UUID;
    harness.unitOfWork.state.outbox.push({
      mutationGroupId: groupId,
      ownerId,
      commandId,
      actor: 'user',
      createdAt: earlier,
      operations: [
        {
          operationId: '80000000-0000-4000-8000-000000000002' as UUID,
          mutationGroupId: groupId,
          sequence: 0,
          state: 'pending',
          attemptCount: 0,
          nextAttemptAt: earlier,
          mutation: updateFrom(axis, axis.document),
        },
      ],
    });

    expect(
      errorOf(
        await lifecycle.deletePermanently({
          target: refOf('axis', axis),
          policy: 'unlink_and_delete',
          confirmation: 'Health',
        }),
      ),
    ).toMatchObject({
      domainError: {
        code: 'delete_restricted',
        message: 'This Axis has changes that have not synced yet. Try again after they sync.',
        details: { blockers: ['pending_mutation'] },
      },
    });
    expect(read(axis)).toEqual(axis);
  });

  it('requires the exact current title and a known policy', async () => {
    const axis = seed.axis({ title: 'Health' });
    const before = persisted();

    for (const confirmation of ['health', 'Health ', ' Health', '']) {
      expect(
        errorOf(
          await lifecycle.deletePermanently({
            target: refOf('axis', axis),
            policy: 'restrict',
            confirmation,
          }),
        ),
      ).toEqual({
        code: 'domain_rejected',
        domainError: {
          code: 'invalid_value',
          message: 'Type the exact title to confirm.',
          details: { reason: 'delete_confirmation', field: 'confirmation' },
        },
      });
    }
    expect(
      errorOf(
        await lifecycle.deletePermanently({
          target: refOf('axis', axis),
          policy: 'cascade' as never,
          confirmation: 'Health',
        }),
      ),
    ).toMatchObject({ domainError: { code: 'invalid_value', details: { reason: 'policy' } } });
    expect(persisted()).toEqual(before);
  });

  it('rejects stale, malformed, and unknown targets without writing', async () => {
    const axis = seed.axis({ title: 'Health' }, { revision: 3 });
    const before = persisted();

    expect(
      errorOf(
        await lifecycle.deletePermanently({
          target: { kind: 'axis', id: axis.ref.id, revision: 2 },
          policy: 'restrict',
          confirmation: 'Health',
        }),
      ),
    ).toEqual({ code: 'revision_conflict', ref: axis.ref, expectedRevision: 2, actualRevision: 3 });
    expect(
      errorOf(
        await lifecycle.deletePermanently({
          target: { kind: 'axis', id: 'not-an-id', revision: 1 },
          policy: 'restrict',
          confirmation: 'Health',
        }),
      ),
    ).toMatchObject({ domainError: { code: 'invalid_uuid' } });
    expect(
      errorOf(
        await lifecycle.deletePermanently({
          target: { kind: 'axis', id: missingId, revision: 1 },
          policy: 'restrict',
          confirmation: 'Health',
        }),
      ),
    ).toEqual({ code: 'entity_not_found', ref: createEntityRef('axis', missingId, ownerId) });
    expect(persisted()).toEqual(before);
  });

  it('fails closed without writing when a referrer changes after the impact was read', async () => {
    const graph = projectGraph();
    const changed = { ...graph.action, localRevision: 2 };
    const racing: AlignmentQueryPort = {
      ...queries,
      async getDeleteImpact(owner, ref) {
        const impact = await queries.getDeleteImpact(owner, ref);
        harness.unitOfWork.seed(changed);
        return impact;
      },
    };

    expect(
      errorOf(
        await lifecycleWith(racing).deletePermanently({
          target: refOf('project', graph.project),
          policy: 'unlink_and_delete',
          confirmation: 'Launch site',
        }),
      ),
    ).toEqual({
      code: 'revision_conflict',
      ref: graph.action.ref,
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(read(graph.project)).toEqual(graph.project);
    expect(read(graph.action)).toEqual(changed);
    for (const kept of [graph.supporting, graph.milestoneLink, graph.oldLink, graph.placement])
      expect(read(kept)).toEqual(kept);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });
});

/**
 * A delete target named by review decisions in every state (an active and a removed choice in a
 * draft, and a decision in an archived review), plus records the delete must leave as they are.
 */
function reviewedTarget(kind: AlignmentKind) {
  const title = `Private ${kind} title`;
  const create = (overrides: { readonly title?: string } = {}) => {
    switch (kind) {
      case 'axis':
        return seed.axis(overrides);
      case 'outcome':
        return seed.outcome(overrides);
      case 'project':
        return seed.project(overrides);
      case 'milestone':
        return seed.milestone(seed.outcome().ref.id, overrides);
    }
  };
  const target = create({ title });
  const other = create();
  const draft = seed.review();
  const archivedReview = seed.review({
    state: 'archived',
    stateBeforeArchive: 'completed',
    completedAt: earlier,
    archivedAt: earlier,
  });
  const named = { kind, id: target.ref.id };
  const items = [
    seed.reviewItem(named, { reviewId: draft.ref.id }),
    seed.reviewItem(named, { reviewId: draft.ref.id, archivedAt: earlier }),
    seed.reviewItem(named, { reviewId: archivedReview.ref.id }),
  ];
  const unrelated = seed.reviewItem({ kind, id: other.ref.id }, { reviewId: draft.ref.id });
  return { target, title, items, kept: [other, draft, archivedReview, unrelated] };
}

const clearedTarget = (kind: AlignmentKind) => ({
  kind: 'deleted',
  deletedKind: kind,
  deletedAt: now,
});

describe('permanent delete keeps review decisions', () => {
  it.each(kinds)(
    'keeps every review decision about a deleted %s and clears only its reference',
    async (kind) => {
      const { target, title, items, kept } = reviewedTarget(kind);
      const request = {
        target: refOf(kind, target),
        policy: 'restrict',
        confirmation: title,
      } as const;

      const receipt = valueOf(await lifecycle.deletePermanently(request, commandId));

      expect(receipt.undo).toEqual({ available: false });
      expect(harness.unitOfWork.state.undo).toEqual([]);
      expect(read(target)).toBeNull();
      for (const item of items) {
        expect(read(item)).toEqual({
          ...item,
          localRevision: 2,
          document: { ...item.document, target: clearedTarget(kind) },
        });
      }
      for (const record of kept) expect(read(record)).toEqual(record);
      expect(events()).toEqual([
        ...items.map((item) => ({
          eventType: 'review_item.target_cleared',
          aggregate: item.ref,
          payload: { operation: 'update' },
        })),
        { eventType: `${kind}.deleted`, aggregate: target.ref, payload: { operation: 'delete' } },
      ]);
      // Nothing keeps the deleted title or a reference to it.
      const stored = JSON.stringify([...harness.unitOfWork.state.records.values()]);
      expect(stored).not.toContain(title);
      expect(stored).not.toContain(target.ref.id);
      expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private');

      // A repeated command id returns its receipt and changes nothing again.
      const after = persisted();
      await expect(lifecycle.deletePermanently(request, commandId)).resolves.toEqual({
        ok: true,
        value: receipt,
      });
      expect(persisted()).toEqual(after);
    },
  );

  it('keeps review decisions in the same transaction as the links unlink_and_delete removes', async () => {
    const graph = projectGraph();
    const item = seed.reviewItem({ kind: 'project', id: graph.project.ref.id });

    valueOf(
      await lifecycle.deletePermanently({
        target: refOf('project', graph.project),
        policy: 'unlink_and_delete',
        confirmation: 'Launch site',
      }),
    );

    expect(read(graph.project)).toBeNull();
    expect(read(item)?.document).toEqual({ ...item.document, target: clearedTarget('project') });
    expect(events().map(({ eventType, aggregate }) => [aggregate.type, eventType])).toEqual([
      ['action', 'project.deleted'],
      ['note', 'project.deleted'],
      ['review_item', 'review_item.target_cleared'],
      ['project_secondary_outcome', 'project.deleted'],
      ['milestone_project', 'project.deleted'],
      ['milestone_project', 'project.deleted'],
      ['planning_placement', 'project.deleted'],
      ['planning_placement', 'project.deleted'],
      ['focus_selection', 'project.deleted'],
      ['focus_selection', 'project.deleted'],
      ['project', 'project.deleted'],
    ]);
  });

  it('discloses kept review decisions in the preview and never lists them as a blocker', async () => {
    const { target } = reviewedTarget('axis');
    const before = persisted();

    for (const policy of ['restrict', 'unlink_and_delete'] as const) {
      await expect(
        lifecycle.previewDelete({ kind: 'axis', id: target.ref.id }, policy),
      ).resolves.toMatchObject({
        policy,
        allowed: true,
        blockers: [],
        // Only the draft's choice is listed; the removed choice and the archived review's are not.
        historyReferences: { reviews: 1, routineDefaults: 0 },
      });
    }
    expect(persisted()).toEqual(before);
  });

  it('counts only the review decisions history lists, never a removed choice or an archived review', async () => {
    const target = seed.project({ title: 'Listed project' });
    const named = { kind: 'project', id: target.ref.id } as const;
    const weekFrom = (start: string, end: string) => ({
      periodKey: start,
      periodStart: start as CalendarDate,
      periodEnd: end as CalendarDate,
    });
    const completed = seed.review({
      ...weekFrom('2026-09-07', '2026-09-13'),
      state: 'completed',
      completedAt: earlier,
    });
    const skipped = seed.review({ ...weekFrom('2026-09-14', '2026-09-20'), state: 'skipped' });
    const draft = seed.review();
    const undone = seed.review({ state: 'archived', stateBeforeArchive: 'draft', archivedAt: now });
    const listed = [
      seed.reviewItem(named, { reviewId: completed.ref.id }),
      seed.reviewItem(named, { reviewId: skipped.ref.id }),
      seed.reviewItem(named, { reviewId: draft.ref.id }),
    ];
    // Cleared too, but nothing lists them: a removed choice, and a choice in an undone review.
    const unlisted = [
      seed.reviewItem(named, { reviewId: draft.ref.id, decision: 'pause', archivedAt: earlier }),
      seed.reviewItem(named, { reviewId: undone.ref.id }),
    ];
    const before = persisted();

    for (const policy of ['restrict', 'unlink_and_delete'] as const) {
      await expect(
        lifecycle.previewDelete({ kind: 'project', id: target.ref.id }, policy),
      ).resolves.toMatchObject({
        allowed: true,
        blockers: [],
        historyReferences: { reviews: listed.length, routineDefaults: 0 },
      });
    }
    expect(persisted()).toEqual(before);

    valueOf(
      await lifecycle.deletePermanently({
        target: refOf('project', target),
        policy: 'restrict',
        confirmation: 'Listed project',
      }),
    );
    for (const item of [...listed, ...unlisted]) {
      expect(read(item)?.document['target']).toEqual(clearedTarget('project'));
    }
  });

  it('rolls back every kept review decision when the delete transaction fails', async () => {
    const { target, title, items } = reviewedTarget('project');
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
    const failingLifecycle = createAlignmentLifecycleCommands(
      createAlignmentKit({ ...harness.dependencies, unitOfWork: failing }, queries),
    );
    const request = {
      target: refOf('project', target),
      policy: 'restrict',
      confirmation: title,
    } as const;
    const before = persisted();

    expect(errorOf(await failingLifecycle.deletePermanently(request, commandId))).toEqual({
      code: 'transaction_failed',
    });
    expect(persisted()).toEqual(before);

    // Nothing was spent: the same command id deletes once storage recovers.
    valueOf(await lifecycle.deletePermanently(request, commandId));
    expect(read(target)).toBeNull();
    for (const item of items) expect(read(item)?.localRevision).toBe(2);
  });

  it('fails closed without writing when a review decision changes after the impact was read', async () => {
    const { target, title, items } = reviewedTarget('milestone');
    const [first, ...rest] = items;
    if (first === undefined) throw new Error('Expected review items.');
    const changedItem = {
      ...first,
      localRevision: 2,
      document: { ...first.document, decision: 'archive' },
    };
    const racing: AlignmentQueryPort = {
      ...queries,
      async getDeleteImpact(owner, ref) {
        const impact = await queries.getDeleteImpact(owner, ref);
        harness.unitOfWork.seed(changedItem);
        return impact;
      },
    };

    expect(
      errorOf(
        await lifecycleWith(racing).deletePermanently({
          target: refOf('milestone', target),
          policy: 'restrict',
          confirmation: title,
        }),
      ),
    ).toEqual({
      code: 'revision_conflict',
      ref: first.ref,
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(read(target)).toEqual(target);
    expect(read(changedItem)).toEqual(changedItem);
    for (const item of rest) expect(read(item)).toEqual(item);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('keeps the target while a review item cannot be cleared, under every policy', async () => {
    const { target, title } = reviewedTarget('axis');
    const stranger = seed.reviewItem({ kind: 'axis', id: seed.axis().ref.id });
    const tombstoned = lifecycleWith({
      ...queries,
      async getDeleteImpact(owner, ref) {
        const impact = await queries.getDeleteImpact(owner, ref);
        return { ...impact, reviewReferences: impact.reviewReferences + 1 };
      },
    });
    const mismatched = lifecycleWith({
      ...queries,
      async getDeleteImpact(owner, ref) {
        const impact = await queries.getDeleteImpact(owner, ref);
        return {
          ...impact,
          reviewItems: [...impact.reviewItems, stranger],
          reviewReferences: impact.reviewReferences + 1,
        };
      },
    });
    const before = persisted();

    for (const policy of ['restrict', 'unlink_and_delete'] as const) {
      const request = { target: refOf('axis', target), policy, confirmation: title };
      await expect(
        tombstoned.previewDelete({ kind: 'axis', id: target.ref.id }, policy),
      ).resolves.toMatchObject({
        allowed: false,
        blockers: ['history_references'],
        historyReferences: { reviews: 1, routineDefaults: 0 },
      });
      expect(errorOf(await tombstoned.deletePermanently(request))).toEqual({
        code: 'domain_rejected',
        domainError: {
          code: 'delete_restricted',
          message:
            'Some history still refers to this Axis. Archive it instead to keep that history.',
          details: { reason: 'delete_restricted', blockers: ['history_references'] },
        },
      });
      expect(errorOf(await mismatched.deletePermanently(request))).toEqual({
        code: 'domain_rejected',
        domainError: {
          code: 'delete_restricted',
          message: 'This Axis cannot be deleted safely right now. Archive it instead.',
          details: { reason: 'delete_restricted', blockers: [] },
        },
      });
    }
    expect(persisted()).toEqual(before);
  });
});
