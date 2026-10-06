import {
  createEntityRef,
  createMonthPeriod,
  createYearPeriod,
  type CalendarDate,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AlignmentQueryPort } from '../alignment-contracts';
import type { CanonicalRecordState } from '../contracts';
import { createAlignmentSeeder, createAlignmentTestQueries } from './alignment-test-queries';
import { createInMemoryHarness, type InMemoryHarness } from './in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const otherOwnerId = '10000000-0000-4000-8000-000000000002' as OwnerId;
const now = '2026-09-28T13:00:00.000Z' as Instant;
const archivedAt = { state: 'archived', archivedAt: now } as const;

let harness: InMemoryHarness;
let queries: AlignmentQueryPort;
let graph: ReturnType<typeof seedGraph>;

function seedGraph(unitOfWork: InMemoryHarness['unitOfWork']) {
  const seed = createAlignmentSeeder(unitOfWork, ownerId);
  const health = seed.axis({ title: 'Health' });
  const old = seed.axis({ title: 'Old', ...archivedAt, stateBeforeArchive: 'active' });
  const work = seed.axis({ title: 'Work' });
  const run = seed.outcome({
    title: 'Run a 10k',
    axisId: health.ref.id,
    progress: { mode: 'milestone_derived' },
  });
  const rest = seed.outcome({ title: 'Rest more', state: 'paused' });
  const swim = seed.outcome({ title: 'Swim', axisId: health.ref.id, state: 'achieved' });
  const first5k = seed.milestone(run.ref.id, { title: 'First 5k' });
  const second5k = seed.milestone(run.ref.id, { title: 'Second 5k', state: 'completed' });
  const trail = seed.milestone(run.ref.id, { title: 'Trail', state: 'canceled' });
  const oldRace = seed.milestone(run.ref.id, {
    title: 'Old race',
    ...archivedAt,
    stateBeforeArchive: 'active',
  });
  const plan = seed.project({
    title: 'Training plan',
    axisId: health.ref.id,
    primaryOutcomeId: run.ref.id,
    state: 'active',
    desiredResult: 'A plan I follow',
  });
  const site = seed.project({ title: 'Launch site' });
  const shoes = seed.project({
    title: 'Buy shoes',
    axisId: health.ref.id,
    state: 'completed',
    desiredResult: 'Shoes',
  });
  const schedule = seed.action({ title: 'Draft schedule', projectId: plan.ref.id });
  const warmup = seed.action({ title: 'Warm-up list', projectId: plan.ref.id, state: 'completed' });
  const stretch = seed.action({ title: 'Stretch', axisId: health.ref.id });
  const noteRecord = seed.note({ title: 'Route idea', projectId: plan.ref.id });
  const walk = seed.routine({ title: 'Morning walk', axisId: health.ref.id });
  const supporting = seed.link('outcome_secondary_project', rest.ref.id, plan.ref.id);
  const milestoneProject = seed.link('milestone_project', first5k.ref.id, plan.ref.id);
  const milestoneAction = seed.link('milestone_action', first5k.ref.id, schedule.ref.id);
  const unlinked = seed.link('milestone_action', first5k.ref.id, warmup.ref.id, {
    unlinkedAt: now,
  });
  const month = seed.placement(
    'outcome',
    run.ref.id,
    createMonthPeriod('2026-10-01' as CalendarDate),
  );
  const year = seed.placement(
    'outcome',
    run.ref.id,
    createYearPeriod('2026-01-01' as CalendarDate),
    {
      archivedAt: now,
    },
  );
  const selection = seed.weekSelection('project', plan.ref.id);
  const oldSelection = seed.weekSelection('project', plan.ref.id, { archivedAt: now });
  const planReview = seed.reviewItem({ kind: 'project', id: plan.ref.id });
  const healthReview = seed.reviewItem({ kind: 'axis', id: health.ref.id }, { archivedAt: now });
  seed.routineDefaults(plan.ref.id);
  return {
    planReview,
    healthReview,
    health,
    old,
    work,
    run,
    rest,
    swim,
    first5k,
    second5k,
    trail,
    oldRace,
    plan,
    site,
    shoes,
    schedule,
    warmup,
    stretch,
    noteRecord,
    walk,
    supporting,
    milestoneProject,
    milestoneAction,
    unlinked,
    month,
    year,
    selection,
    oldSelection,
  };
}

const ids = (records: readonly CanonicalRecordState[]) => records.map((record) => record.ref.id);
const itemIds = (items: readonly { readonly id: string }[]) => items.map((item) => item.id);

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  queries = createAlignmentTestQueries(harness.unitOfWork);
  graph = seedGraph(harness.unitOfWork);
});

describe('in-memory alignment queries', () => {
  it('lists Axes with neutral current counts, archived ones last only on request', async () => {
    const active = await queries.listAxes(ownerId, { includeArchived: false, limit: 200 });
    expect(itemIds(active.items)).toEqual(ids([graph.health, graph.work]));
    expect(active.items[0]?.counts).toEqual({ outcomes: 1, projects: 1, routines: 1 });
    const everything = await queries.listAxes(ownerId, { includeArchived: true, limit: 200 });
    expect(itemIds(everything.items)).toEqual(ids([graph.health, graph.work, graph.old]));
    const first = await queries.listAxes(ownerId, { includeArchived: true, limit: 1 });
    expect(first).toMatchObject({ total: 3, items: [{ id: graph.health.ref.id }] });
  });

  it('lists Outcomes and Projects without an Axis', async () => {
    const unassigned = await queries.listUnassigned(ownerId, 200);
    expect(itemIds(unassigned.outcomes.items)).toEqual(ids([graph.rest]));
    expect(itemIds(unassigned.projects.items)).toEqual(ids([graph.site]));
  });

  it('shows finished members of an Axis only when asked', async () => {
    const current = await queries.getAxis(ownerId, graph.health.ref.id, {
      includeFinished: false,
      limit: 200,
    });
    expect(itemIds(current?.outcomes.items ?? [])).toEqual(ids([graph.run]));
    expect(itemIds(current?.projects.items ?? [])).toEqual(ids([graph.plan]));
    expect(itemIds(current?.routines.items ?? [])).toEqual(ids([graph.walk]));
    expect(current?.reviewNote).toBeNull();
    const all = await queries.getAxis(ownerId, graph.health.ref.id, {
      includeFinished: true,
      limit: 200,
    });
    expect(itemIds(all?.outcomes.items ?? [])).toEqual(ids([graph.run, graph.swim]));
    expect(itemIds(all?.projects.items ?? [])).toEqual(ids([graph.plan, graph.shoes]));
    await expect(
      queries.getAxis(ownerId, graph.old.ref.id, { includeFinished: false, limit: 200 }),
    ).resolves.toMatchObject({ axis: { state: 'archived' } });
    await expect(
      queries.getAxis(ownerId, graph.run.ref.id, { includeFinished: false, limit: 200 }),
    ).resolves.toBeNull();
  });

  it('counts Milestone progress as completed of active plus completed, canceled apart', async () => {
    const detail = await queries.getOutcome(ownerId, graph.run.ref.id, 200);
    expect(detail?.outcome).toMatchObject({
      progress: { mode: 'milestone_derived', completed: 1, total: 2, canceled: 1 },
      canceledMilestones: 1,
      axis: { id: graph.health.ref.id, title: 'Health', archived: false },
      placement: { id: graph.month.ref.id },
    });
    expect(itemIds(detail?.milestones.items ?? [])).toEqual(
      ids([graph.first5k, graph.second5k, graph.trail]),
    );
    expect(itemIds(detail?.primaryProjects.items ?? [])).toEqual(ids([graph.plan]));
    const rest = await queries.getOutcome(ownerId, graph.rest.ref.id, 200);
    expect(rest?.supportingProjects.items).toEqual([
      expect.objectContaining({
        id: graph.plan.ref.id,
        kind: 'project',
        linkId: graph.supporting.ref.id,
        linkRevision: 1,
      }),
    ]);
  });

  it('assembles Project and Milestone details from active links only', async () => {
    const project = await queries.getProject(ownerId, graph.plan.ref.id, {
      actionLimit: 1,
      limit: 200,
    });
    expect(project?.project.nextAction).toEqual({
      status: 'present',
      action: { id: graph.schedule.ref.id, title: 'Draft schedule', state: 'planned' },
    });
    expect(itemIds(project?.secondaryOutcomes ?? [])).toEqual(ids([graph.rest]));
    expect(itemIds(project?.milestones.items ?? [])).toEqual(ids([graph.first5k]));
    expect(project?.actions).toMatchObject({ total: 2, items: [{ id: graph.schedule.ref.id }] });
    expect(itemIds(project?.capturedNotes.items ?? [])).toEqual(ids([graph.noteRecord]));
    const site = await queries.getProject(ownerId, graph.site.ref.id, {
      actionLimit: 50,
      limit: 50,
    });
    expect(site?.project.nextAction).toEqual({ status: 'not_applicable' });

    const milestone = await queries.getMilestone(ownerId, graph.first5k.ref.id, 200);
    expect(milestone?.axis?.id).toBe(graph.health.ref.id);
    expect(milestone?.milestone.outcome.id).toBe(graph.run.ref.id);
    expect(itemIds(milestone?.projects.items ?? [])).toEqual(ids([graph.plan]));
    expect(itemIds(milestone?.actions.items ?? [])).toEqual(ids([graph.schedule]));
  });

  it('builds a neighborhood with the primary chain, parents, children, and totals', async () => {
    const neighborhood = await queries.getNeighborhood(
      ownerId,
      { kind: 'project', id: graph.plan.ref.id },
      1,
    );
    expect(neighborhood?.focus).toMatchObject({ kind: 'project', title: 'Training plan' });
    expect(neighborhood?.chain.map((node) => [node.kind, node.id])).toEqual([
      ['axis', graph.health.ref.id],
      ['outcome', graph.run.ref.id],
    ]);
    expect(
      neighborhood?.above.map((edge) => [edge.relationship, edge.other.id, edge.linkId]),
    ).toEqual([
      ['axis_project', graph.health.ref.id, undefined],
      ['outcome_primary_project', graph.run.ref.id, undefined],
      ['outcome_secondary_project', graph.rest.ref.id, graph.supporting.ref.id],
      ['milestone_project', graph.first5k.ref.id, graph.milestoneProject.ref.id],
    ]);
    expect(neighborhood?.below.map((edge) => [edge.relationship, edge.other.id])).toEqual([
      ['project_action', graph.schedule.ref.id],
      ['project_note', graph.noteRecord.ref.id],
    ]);
    expect(neighborhood?.totals).toEqual({ project_action: 2, project_note: 1 });

    const milestone = await queries.getNeighborhood(
      ownerId,
      { kind: 'milestone', id: graph.first5k.ref.id },
      10,
    );
    expect(milestone?.above).toEqual([
      expect.objectContaining({
        relationship: 'outcome_milestone',
        required: true,
        direction: 'up',
      }),
    ]);
    const outcome = await queries.getNeighborhood(
      ownerId,
      { kind: 'outcome', id: graph.run.ref.id },
      10,
    );
    expect(outcome?.focus.progress).toMatchObject({ mode: 'milestone_derived', total: 2 });
    expect(
      outcome?.below.find((edge) => edge.other.id === graph.oldRace.ref.id)?.other.archived,
    ).toBe(true);
  });

  it('lists every non-archived row of each ordering container with its state', async () => {
    const container = async (scope: Parameters<AlignmentQueryPort['listContainer']>[1]) =>
      (await queries.listContainer(ownerId, scope)).map((row) => [row.ref.id, row.state]);
    expect(await container({ container: 'axes' })).toEqual([
      [graph.health.ref.id, 'active'],
      [graph.work.ref.id, 'active'],
    ]);
    expect(await container({ container: 'axis_outcomes', axisId: graph.health.ref.id })).toEqual([
      [graph.run.ref.id, 'active'],
      [graph.swim.ref.id, 'achieved'],
    ]);
    expect(await container({ container: 'axis_outcomes', axisId: null })).toEqual([
      [graph.rest.ref.id, 'paused'],
    ]);
    expect(
      await container({ container: 'outcome_milestones', outcomeId: graph.run.ref.id }),
    ).toEqual([
      [graph.first5k.ref.id, 'active'],
      [graph.second5k.ref.id, 'completed'],
      [graph.trail.ref.id, 'canceled'],
    ]);
    expect(await container({ container: 'project_actions', projectId: graph.plan.ref.id })).toEqual(
      [
        [graph.schedule.ref.id, 'planned'],
        [graph.warmup.ref.id, 'completed'],
      ],
    );
  });

  it('finds a join record by its endpoints in any state', async () => {
    await expect(
      queries.findLink(ownerId, 'milestone_action', graph.first5k.ref.id, graph.warmup.ref.id),
    ).resolves.toEqual(graph.unlinked);
    await expect(
      queries.findLink(ownerId, 'milestone_action', graph.warmup.ref.id, graph.first5k.ref.id),
    ).resolves.toBeNull();
  });

  it('counts the non-archived children an archive leaves in place', async () => {
    await expect(queries.getArchiveImpact(ownerId, graph.health.ref)).resolves.toEqual({
      outcome: 2,
      project: 2,
      routine: 1,
      action: 1,
    });
    await expect(queries.getArchiveImpact(ownerId, graph.run.ref)).resolves.toEqual({
      milestone: 3,
      project: 1,
    });
    await expect(queries.getArchiveImpact(ownerId, graph.first5k.ref)).resolves.toEqual({
      project: 1,
      action: 1,
    });
  });

  it('classifies permanent-delete impact per kind', async () => {
    const project = await queries.getDeleteImpact(ownerId, graph.plan.ref);
    expect(
      project.optionalReferrers.map((item) => [item.relationship, item.record.ref.id]),
    ).toEqual([
      ['project_action', graph.schedule.ref.id],
      ['project_action', graph.warmup.ref.id],
      ['project_note', graph.noteRecord.ref.id],
    ]);
    expect(ids(project.activeLinks)).toEqual(ids([graph.supporting, graph.milestoneProject]));
    expect(project).toMatchObject({
      inactiveLinks: [],
      activeSelections: [graph.selection],
      archivedSelections: [graph.oldSelection],
      reviewItems: [graph.planReview],
      reviewReferences: 1,
      routineDefaultReferences: 1,
      requiredChildren: { total: 0, items: [] },
      pendingMutation: false,
      openConflict: false,
    });

    const outcome = await queries.getDeleteImpact(ownerId, graph.run.ref);
    expect(outcome.requiredChildren.total).toBe(4);
    expect(outcome.requiredChildren.items.find((item) => item.id === graph.oldRace.ref.id)).toEqual(
      {
        id: graph.oldRace.ref.id,
        title: 'Old race',
        archived: true,
      },
    );
    expect(outcome.optionalReferrers.map((item) => item.record.ref.id)).toEqual(ids([graph.plan]));
    expect(outcome.activePlacements).toEqual([graph.month]);
    expect(outcome.archivedPlacements).toEqual([graph.year]);

    const milestone = await queries.getDeleteImpact(ownerId, graph.first5k.ref);
    expect(ids(milestone.activeLinks).sort()).toEqual(
      ids([graph.milestoneProject, graph.milestoneAction]).sort(),
    );
    expect(milestone.inactiveLinks).toEqual([graph.unlinked]);
    expect(milestone).toMatchObject({ reviewItems: [], reviewReferences: 0 });

    const axis = await queries.getDeleteImpact(ownerId, graph.health.ref);
    // Review items in any state, including a removed choice.
    expect(axis).toMatchObject({ reviewItems: [graph.healthReview], reviewReferences: 1 });
    expect(axis.optionalReferrers.map((item) => item.relationship)).toEqual([
      'axis_outcome',
      'axis_outcome',
      'axis_project',
      'axis_project',
      'axis_routine',
      'axis_action',
    ]);
  });

  it('reads history newest first, owner-scoped records, and titled candidates', async () => {
    harness.unitOfWork.state.events.push(
      ...(['axis.created', 'axis.edited'] as const).map((eventType, index) => ({
        eventId: `90000000-0000-4000-8000-00000000000${String(index + 1)}` as UUID,
        ownerId,
        event: {
          aggregate: graph.health.ref,
          eventType,
          version: 1 as const,
          actor: 'user' as const,
          commandId: `91000000-0000-4000-8000-00000000000${String(index + 1)}` as UUID,
          occurredAt: now,
          payload: { operation: 'update' },
        },
      })),
    );
    await expect(queries.listHistory(ownerId, graph.health.ref, 10)).resolves.toEqual([
      { eventType: 'axis.edited', occurredAt: now },
      { eventType: 'axis.created', occurredAt: now },
    ]);
    await expect(
      queries.readRecord(ownerId, createEntityRef('axis', graph.health.ref.id, otherOwnerId)),
    ).resolves.toBeNull();
    const candidates = await queries.listCandidates(ownerId, 'project', 'PLAN', 10);
    expect(candidates).toMatchObject({
      total: 1,
      items: [{ id: graph.plan.ref.id, kind: 'project', axisId: graph.health.ref.id }],
    });
    const actions = await queries.listCandidates(ownerId, 'action', undefined, 10);
    expect(actions.total).toBe(3);
  });
});
