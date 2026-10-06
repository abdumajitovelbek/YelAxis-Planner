import type { AlignmentRelationship, Instant, OwnerId, UUID } from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AlignmentNodeKind,
  AlignmentProjectionMethods,
  AlignmentQueryPort,
} from './alignment-contracts';
import { createAlignmentKit } from './alignment-kit';
import { createAlignmentProjections } from './alignment-projections';
import type { CanonicalRecordState } from './contracts';
import {
  createAlignmentSeeder,
  createAlignmentTestQueries,
  type AlignmentSeeder,
} from './testing/alignment-test-queries';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const otherOwnerId = '10000000-0000-4000-8000-000000000002' as OwnerId;
const now = '2026-09-28T13:00:00.000Z' as Instant;
const archived = { state: 'archived', archivedAt: now } as const;
const unknownId = '12000000-0000-4000-8000-000000000999';

interface PortCall {
  readonly method: keyof AlignmentQueryPort;
  readonly args: readonly unknown[];
}

/** Wrap the fake port so tests can assert the ids, limits, and filters each query receives. */
function recordCalls(port: AlignmentQueryPort): {
  readonly port: AlignmentQueryPort;
  readonly calls: PortCall[];
} {
  const calls: PortCall[] = [];
  const wrapped: Record<string, unknown> = {};
  for (const method of Object.keys(port) as (keyof AlignmentQueryPort)[]) {
    const target = Reflect.get(port, method) as (...inner: unknown[]) => unknown;
    wrapped[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return Reflect.apply(target, port, args);
    };
  }
  return { port: wrapped as unknown as AlignmentQueryPort, calls };
}

let harness: InMemoryHarness;
let seed: AlignmentSeeder;
let calls: PortCall[];
let projections: AlignmentProjectionMethods;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  seed = createAlignmentSeeder(harness.unitOfWork, ownerId);
  const recorded = recordCalls(createAlignmentTestQueries(harness.unitOfWork));
  calls = recorded.calls;
  projections = createAlignmentProjections(createAlignmentKit(harness.dependencies, recorded.port));
});

const ids = (records: readonly CanonicalRecordState[]) => records.map((record) => record.ref.id);
const itemIds = (items: readonly { readonly id: string }[]) => items.map((item) => item.id);
const callsTo = (method: keyof AlignmentQueryPort) =>
  calls.filter((call) => call.method === method).map((call) => call.args);

/** A small graph across two Axes with FK and join links, one unlinked row, and archived rows. */
function seedGraph() {
  const health = seed.axis({ title: 'Health' });
  const work = seed.axis({ title: 'Work' });
  const oldAxis = seed.axis({ title: 'Old', ...archived, stateBeforeArchive: 'active' });
  const run = seed.outcome({ title: 'Run a 10k', axisId: health.ref.id });
  const rest = seed.outcome({ title: 'Rest more', state: 'paused' });
  const plan = seed.project({
    title: 'Training plan',
    axisId: health.ref.id,
    primaryOutcomeId: run.ref.id,
    state: 'active',
    desiredResult: 'A plan I follow',
  });
  const site = seed.project({ title: 'Launch site', axisId: work.ref.id });
  const shelved = seed.project({ title: 'Shelved', ...archived, stateBeforeArchive: 'idea' });
  const first5k = seed.milestone(run.ref.id, { title: 'First 5k' });
  const schedule = seed.action({
    title: 'Draft schedule',
    projectId: plan.ref.id,
    axisId: health.ref.id,
  });
  const stretch = seed.action({ title: 'Stretch', axisId: work.ref.id });
  const loose = seed.action({ title: 'Loose end' });
  const linked = seed.link('milestone_action', first5k.ref.id, schedule.ref.id);
  const unlinked = seed.link('milestone_action', first5k.ref.id, loose.ref.id, {
    unlinkedAt: now,
  });
  const supporting = seed.link('outcome_secondary_project', rest.ref.id, site.ref.id);
  const walk = seed.routine({ title: 'Morning walk', axisId: health.ref.id });
  const idea = seed.note({ title: 'Route idea', projectId: plan.ref.id });
  return {
    health,
    work,
    oldAxis,
    run,
    rest,
    plan,
    site,
    shelved,
    first5k,
    schedule,
    stretch,
    loose,
    linked,
    unlinked,
    supporting,
    walk,
    idea,
  };
}

type Graph = ReturnType<typeof seedGraph>;

describe('alignment projections: lists and details', () => {
  it('lists active Axes by default and archived ones last on request, with the hard cap', async () => {
    const graph = seedGraph();
    const active = await projections.listAxes();
    expect(itemIds(active.items)).toEqual(ids([graph.health, graph.work]));
    expect(active.total).toBe(2);
    expect(active.items[0]?.counts).toEqual({ outcomes: 1, projects: 1, routines: 1 });

    const everything = await projections.listAxes({ includeArchived: true });
    expect(itemIds(everything.items)).toEqual(ids([graph.health, graph.work, graph.oldAxis]));
    await projections.listAxes({ includeArchived: 'yes' as unknown as boolean });
    expect(callsTo('listAxes')).toEqual([
      [ownerId, { includeArchived: false, limit: 200 }],
      [ownerId, { includeArchived: true, limit: 200 }],
      [ownerId, { includeArchived: false, limit: 200 }],
    ]);
  });

  it('lists Outcomes and Projects that are in no Axis', async () => {
    const graph = seedGraph();
    const unassigned = await projections.listUnassigned();
    expect(itemIds(unassigned.outcomes.items)).toEqual(ids([graph.rest]));
    expect(itemIds(unassigned.projects.items)).toEqual([]);
    expect(callsTo('listUnassigned')).toEqual([[ownerId, 200]]);
  });

  it('opens an Axis with finished members only when asked', async () => {
    const graph = seedGraph();
    const swim = seed.outcome({ title: 'Swim', axisId: graph.health.ref.id, state: 'achieved' });
    const current = await projections.getAxis(graph.health.ref.id);
    expect(current?.axis.title).toBe('Health');
    expect(itemIds(current?.outcomes.items ?? [])).toEqual(ids([graph.run]));
    expect(itemIds(current?.routines.items ?? [])).toEqual(ids([graph.walk]));
    expect(current?.reviewNote).toBeNull();
    const all = await projections.getAxis(graph.health.ref.id, { includeFinished: true });
    expect(itemIds(all?.outcomes.items ?? [])).toEqual(ids([graph.run, swim]));
    await expect(projections.getAxis(graph.oldAxis.ref.id)).resolves.toMatchObject({
      axis: { state: 'archived' },
    });
    expect(callsTo('getAxis')).toEqual([
      [ownerId, graph.health.ref.id, { includeFinished: false, limit: 200 }],
      [ownerId, graph.health.ref.id, { includeFinished: true, limit: 200 }],
      [ownerId, graph.oldAxis.ref.id, { includeFinished: false, limit: 200 }],
    ]);
  });

  it('opens Outcome, Project, and Milestone details with their active links', async () => {
    const graph = seedGraph();
    const outcome = await projections.getOutcome(graph.run.ref.id);
    expect(outcome?.outcome).toMatchObject({ title: 'Run a 10k', axis: { title: 'Health' } });
    expect(itemIds(outcome?.milestones.items ?? [])).toEqual(ids([graph.first5k]));
    expect(itemIds(outcome?.primaryProjects.items ?? [])).toEqual(ids([graph.plan]));

    const project = await projections.getProject(graph.plan.ref.id);
    expect(project?.project).toMatchObject({
      title: 'Training plan',
      desiredResult: 'A plan I follow',
      nextAction: { status: 'present', action: { id: graph.schedule.ref.id } },
    });
    expect(itemIds(project?.actions.items ?? [])).toEqual(ids([graph.schedule]));
    expect(itemIds(project?.capturedNotes.items ?? [])).toEqual(ids([graph.idea]));

    const milestone = await projections.getMilestone(graph.first5k.ref.id);
    expect(milestone?.milestone.outcome).toMatchObject({ id: graph.run.ref.id });
    expect(milestone?.axis?.id).toBe(graph.health.ref.id);
    expect(milestone?.actions.items).toEqual([
      expect.objectContaining({
        id: graph.schedule.ref.id,
        linkId: graph.linked.ref.id,
        linkRevision: 1,
      }),
    ]);
    expect(callsTo('getOutcome')).toEqual([[ownerId, graph.run.ref.id, 200]]);
    expect(callsTo('getMilestone')).toEqual([[ownerId, graph.first5k.ref.id, 200]]);
  });

  it('returns null for malformed ids without asking the port', async () => {
    seedGraph();
    const malformed = [
      '',
      'axis',
      'not-a-uuid',
      '12000000-0000-4000-8000-00000000000z',
      ` ${unknownId}`,
      '12000000-0000-0000-8000-000000000001',
    ];
    for (const id of malformed) {
      await expect(projections.getAxis(id)).resolves.toBeNull();
      await expect(projections.getOutcome(id)).resolves.toBeNull();
      await expect(projections.getProject(id)).resolves.toBeNull();
      await expect(projections.getMilestone(id)).resolves.toBeNull();
      await expect(projections.getNeighborhood({ kind: 'outcome', id })).resolves.toBeNull();
    }
    await expect(projections.getAxis(42 as unknown as string)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null for unknown ids, ids of another kind, and another owner’s records', async () => {
    const graph = seedGraph();
    const foreign = createAlignmentSeeder(
      harness.unitOfWork,
      otherOwnerId,
      'e0000000-0000-4000-8000-',
    );
    const foreignAxis = foreign.axis({ title: 'Theirs' });
    const foreignOutcome = foreign.outcome({ axisId: foreignAxis.ref.id });
    const foreignProject = foreign.project();
    const foreignMilestone = foreign.milestone(foreignOutcome.ref.id);

    await expect(projections.getAxis(unknownId)).resolves.toBeNull();
    await expect(projections.getAxis(graph.run.ref.id)).resolves.toBeNull();
    await expect(projections.getOutcome(graph.plan.ref.id)).resolves.toBeNull();
    await expect(projections.getProject(graph.first5k.ref.id)).resolves.toBeNull();
    await expect(projections.getMilestone(graph.health.ref.id)).resolves.toBeNull();
    await expect(
      projections.getNeighborhood({ kind: 'axis', id: graph.run.ref.id }),
    ).resolves.toBeNull();

    await expect(projections.getAxis(foreignAxis.ref.id)).resolves.toBeNull();
    await expect(projections.getOutcome(foreignOutcome.ref.id)).resolves.toBeNull();
    await expect(projections.getProject(foreignProject.ref.id)).resolves.toBeNull();
    await expect(projections.getMilestone(foreignMilestone.ref.id)).resolves.toBeNull();
    await expect(
      projections.getNeighborhood({ kind: 'axis', id: foreignAxis.ref.id }),
    ).resolves.toBeNull();
    expect((await projections.listAxes()).items.map((axis) => axis.title)).not.toContain('Theirs');
    expect(calls.every((call) => call.args[0] === ownerId)).toBe(true);
  });

  it('accepts an uppercase id and reads it in canonical lowercase form', async () => {
    const graph = seedGraph();
    const detail = await projections.getAxis(graph.health.ref.id.toUpperCase());
    expect(detail?.axis.id).toBe(graph.health.ref.id);
    expect(callsTo('getAxis')[0]?.[1]).toBe(graph.health.ref.id);
  });

  it('bounds a Project’s Actions: 50 by default, at most 200, invalid limits fall back', async () => {
    const graph = seedGraph();
    for (let index = 0; index < 59; index += 1)
      seed.action({ title: `Step ${String(index)}`, projectId: graph.plan.ref.id });

    const first = await projections.getProject(graph.plan.ref.id);
    expect(first?.actions.items).toHaveLength(50);
    expect(first?.actions.total).toBe(60);
    const all = await projections.getProject(graph.plan.ref.id, { actionLimit: 10_000 });
    expect(all?.actions.items).toHaveLength(60);
    await projections.getProject(graph.plan.ref.id, { actionLimit: 0 });
    await projections.getProject(graph.plan.ref.id, { actionLimit: 7.9 });
    await projections.getProject(graph.plan.ref.id, { actionLimit: Number.NaN });
    await projections.getProject(graph.plan.ref.id, {
      actionLimit: Number.POSITIVE_INFINITY,
    });
    await projections.getProject(graph.plan.ref.id, { actionLimit: '5' as unknown as number });
    expect(callsTo('getProject').map((args) => args[2])).toEqual([
      { actionLimit: 50, limit: 200 },
      { actionLimit: 200, limit: 200 },
      { actionLimit: 1, limit: 200 },
      { actionLimit: 7, limit: 200 },
      { actionLimit: 50, limit: 200 },
      { actionLimit: 50, limit: 200 },
      { actionLimit: 50, limit: 200 },
    ]);
  });
});

describe('alignment projections: neighborhood', () => {
  it('bounds the neighborhood per relationship and keeps full totals', async () => {
    const graph = seedGraph();
    const neighborhood = await projections.getNeighborhood({
      kind: 'project',
      id: graph.plan.ref.id,
    });
    expect(neighborhood?.focus).toMatchObject({ kind: 'project', title: 'Training plan' });
    expect(neighborhood?.chain.map((node) => node.id)).toEqual(ids([graph.health, graph.run]));
    expect(neighborhood?.totals).toEqual({ project_action: 1, project_note: 1 });

    await projections.getNeighborhood({ kind: 'project', id: graph.plan.ref.id }, { limit: 500 });
    await projections.getNeighborhood({ kind: 'project', id: graph.plan.ref.id }, { limit: -3 });
    await projections.getNeighborhood({ kind: 'action', id: graph.schedule.ref.id }, { limit: 12 });
    expect(callsTo('getNeighborhood')).toEqual([
      [ownerId, { kind: 'project', id: graph.plan.ref.id }, 50],
      [ownerId, { kind: 'project', id: graph.plan.ref.id }, 200],
      [ownerId, { kind: 'project', id: graph.plan.ref.id }, 1],
      [ownerId, { kind: 'action', id: graph.schedule.ref.id }, 12],
    ]);
  });

  it('opens every node kind and refuses kinds outside the alignment map', async () => {
    const graph = seedGraph();
    const focuses: readonly [AlignmentNodeKind, CanonicalRecordState][] = [
      ['axis', graph.health],
      ['outcome', graph.run],
      ['project', graph.plan],
      ['milestone', graph.first5k],
      ['action', graph.schedule],
      ['routine', graph.walk],
      ['note', graph.idea],
    ];
    for (const [kind, record] of focuses) {
      const neighborhood = await projections.getNeighborhood({ kind, id: record.ref.id });
      expect(neighborhood?.focus, kind).toMatchObject({ kind, id: record.ref.id });
    }
    const before = calls.length;
    for (const kind of ['review', 'profile', 'placement', '', 'Axis'])
      await expect(
        projections.getNeighborhood({
          kind: kind as AlignmentNodeKind,
          id: graph.health.ref.id,
        }),
      ).resolves.toBeNull();
    await expect(
      projections.getNeighborhood(null as unknown as { kind: 'axis'; id: string }),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(before);
  });

  it('keeps archived endpoints inspectable in the neighborhood', async () => {
    const graph = seedGraph();
    const oldRace = seed.milestone(graph.run.ref.id, {
      title: 'Old race',
      ...archived,
      stateBeforeArchive: 'active',
    });
    const outcome = await projections.getNeighborhood({ kind: 'outcome', id: graph.run.ref.id });
    expect(outcome?.below.find((edge) => edge.other.id === oldRace.ref.id)?.other.archived).toBe(
      true,
    );
  });
});

describe('alignment projections: link candidates', () => {
  type Candidate = readonly [id: string, alreadyLinked: boolean, crossAxis: boolean];

  const candidates = async (
    focus: { readonly kind: AlignmentNodeKind; readonly id: string },
    relationship: AlignmentRelationship,
    options: { readonly search?: string; readonly limit?: number } = {},
  ): Promise<Candidate[]> =>
    (await projections.listLinkCandidates({ focus, relationship, ...options })).items.map(
      (item) => [item.id, item.alreadyLinked, item.crossAxis],
    );

  let graph: Graph;
  beforeEach(() => {
    graph = seedGraph();
  });

  it('lists children for a parent focus and marks the ones already linked by foreign key', async () => {
    expect(await candidates({ kind: 'axis', id: graph.health.ref.id }, 'axis_outcome')).toEqual([
      [graph.run.ref.id, true, false],
      [graph.rest.ref.id, false, false],
    ]);
    expect(await candidates({ kind: 'axis', id: graph.work.ref.id }, 'axis_project')).toEqual([
      [graph.plan.ref.id, false, false],
      [graph.site.ref.id, true, false],
    ]);
    expect(
      await candidates({ kind: 'outcome', id: graph.run.ref.id }, 'outcome_primary_project'),
    ).toEqual([
      [graph.plan.ref.id, true, false],
      [graph.site.ref.id, false, false],
    ]);
    expect(
      await candidates({ kind: 'outcome', id: graph.run.ref.id }, 'outcome_milestone'),
    ).toEqual([[graph.first5k.ref.id, true, false]]);
  });

  it('lists parents for a child focus and marks the current parent', async () => {
    expect(await candidates({ kind: 'outcome', id: graph.run.ref.id }, 'axis_outcome')).toEqual([
      [graph.health.ref.id, true, false],
      [graph.work.ref.id, false, false],
    ]);
    expect(
      await candidates({ kind: 'project', id: graph.site.ref.id }, 'outcome_primary_project'),
    ).toEqual([
      [graph.run.ref.id, false, false],
      [graph.rest.ref.id, false, false],
    ]);
    expect(
      await candidates({ kind: 'milestone', id: graph.first5k.ref.id }, 'outcome_milestone'),
    ).toEqual([
      [graph.run.ref.id, true, false],
      [graph.rest.ref.id, false, false],
    ]);
  });

  it('marks active join links only; an unlinked pair can be linked again', async () => {
    expect(
      await candidates({ kind: 'milestone', id: graph.first5k.ref.id }, 'milestone_action'),
    ).toEqual([
      [graph.schedule.ref.id, true, false],
      [graph.stretch.ref.id, false, false],
      [graph.loose.ref.id, false, false],
    ]);
    expect(
      await candidates({ kind: 'action', id: graph.schedule.ref.id }, 'milestone_action'),
    ).toEqual([[graph.first5k.ref.id, true, false]]);
    expect(
      await candidates({ kind: 'action', id: graph.loose.ref.id }, 'milestone_action'),
    ).toEqual([[graph.first5k.ref.id, false, false]]);
    expect(
      await candidates({ kind: 'outcome', id: graph.rest.ref.id }, 'outcome_secondary_project'),
    ).toEqual([
      [graph.plan.ref.id, false, false],
      [graph.site.ref.id, true, false],
    ]);
    expect(
      await candidates({ kind: 'project', id: graph.site.ref.id }, 'outcome_secondary_project'),
    ).toEqual([
      [graph.run.ref.id, false, false],
      [graph.rest.ref.id, true, false],
    ]);
  });

  it('flags cross-Axis Action and Project pairs in both directions', async () => {
    expect(await candidates({ kind: 'project', id: graph.plan.ref.id }, 'project_action')).toEqual([
      [graph.schedule.ref.id, true, false],
      [graph.stretch.ref.id, false, true],
      [graph.loose.ref.id, false, false],
    ]);
    expect(
      await candidates({ kind: 'action', id: graph.stretch.ref.id }, 'project_action'),
    ).toEqual([
      [graph.plan.ref.id, false, true],
      [graph.site.ref.id, false, false],
    ]);
    expect(await candidates({ kind: 'action', id: graph.loose.ref.id }, 'project_action')).toEqual([
      [graph.plan.ref.id, false, false],
      [graph.site.ref.id, false, false],
    ]);
  });

  it('never offers archived candidates and returns full node rows', async () => {
    const result = await projections.listLinkCandidates({
      focus: { kind: 'axis', id: graph.health.ref.id },
      relationship: 'axis_project',
    });
    expect(itemIds(result.items)).not.toContain(graph.shelved.ref.id);
    expect(result.total).toBe(2);
    expect(result.items[0]).toEqual({
      id: graph.plan.ref.id,
      kind: 'project',
      title: 'Training plan',
      state: 'active',
      archived: false,
      localRevision: 1,
      alreadyLinked: true,
      crossAxis: false,
    });
  });

  it('returns nothing for display-only, unrelated, unknown, or malformed requests', async () => {
    const empty = { items: [], total: 0 };
    const requests: readonly Parameters<AlignmentProjectionMethods['listLinkCandidates']>[0][] = [
      { focus: { kind: 'axis', id: graph.health.ref.id }, relationship: 'axis_routine' },
      { focus: { kind: 'project', id: graph.plan.ref.id }, relationship: 'project_note' },
      { focus: { kind: 'note', id: graph.idea.ref.id }, relationship: 'project_note' },
      { focus: { kind: 'axis', id: graph.health.ref.id }, relationship: 'milestone_action' },
      { focus: { kind: 'routine', id: graph.walk.ref.id }, relationship: 'axis_outcome' },
      {
        focus: { kind: 'axis', id: graph.health.ref.id },
        relationship: 'axis_everything' as AlignmentRelationship,
      },
      { focus: { kind: 'axis', id: 'not-a-uuid' }, relationship: 'axis_outcome' },
      {
        focus: { kind: 'review' as AlignmentNodeKind, id: graph.health.ref.id },
        relationship: 'axis_outcome',
      },
    ];
    for (const request of requests)
      await expect(projections.listLinkCandidates(request)).resolves.toEqual(empty);
    expect(calls).toEqual([]);
    await expect(
      projections.listLinkCandidates({
        focus: { kind: 'axis', id: unknownId },
        relationship: 'axis_outcome',
      }),
    ).resolves.toEqual(empty);
    await expect(
      projections.listLinkCandidates(
        null as unknown as Parameters<AlignmentProjectionMethods['listLinkCandidates']>[0],
      ),
    ).resolves.toEqual(empty);
  });

  it('offers nothing to link from an archived focus', async () => {
    await expect(
      projections.listLinkCandidates({
        focus: { kind: 'axis', id: graph.oldAxis.ref.id },
        relationship: 'axis_outcome',
      }),
    ).resolves.toEqual({ items: [], total: 0 });
    expect(callsTo('listCandidates')).toEqual([]);
  });

  it('passes a trimmed, bounded title search and clamps the candidate limit', async () => {
    const focus = { kind: 'axis', id: graph.health.ref.id } as const;
    expect(await candidates(focus, 'axis_project', { search: '  PLAN ' })).toEqual([
      [graph.plan.ref.id, true, false],
    ]);
    await candidates(focus, 'axis_project', { search: '   ' });
    await candidates(focus, 'axis_project', { search: 'x'.repeat(500), limit: 1_000 });
    await candidates(focus, 'axis_project', { limit: 3 });
    await candidates(focus, 'axis_project', { search: 7 as unknown as string, limit: -1 });
    expect(callsTo('listCandidates')).toEqual([
      [ownerId, 'project', 'PLAN', 50],
      [ownerId, 'project', undefined, 50],
      [ownerId, 'project', 'x'.repeat(200), 200],
      [ownerId, 'project', undefined, 3],
      [ownerId, 'project', undefined, 1],
    ]);
    const bounded = await projections.listLinkCandidates({
      focus,
      relationship: 'axis_project',
      limit: 1,
    });
    expect(bounded).toMatchObject({ total: 2, items: [{ id: graph.plan.ref.id }] });
  });
});

describe('alignment projections: choices and purity', () => {
  it('lists every non-archived object of a kind for form pickers', async () => {
    const graph = seedGraph();
    const done = seed.project({ title: 'Done', state: 'completed', desiredResult: 'Shipped' });
    const projects = await projections.listChoices('project');
    expect(itemIds(projects)).toEqual(ids([graph.plan, graph.site, done]));
    expect(projects[0]).toEqual({
      id: graph.plan.ref.id,
      kind: 'project',
      title: 'Training plan',
      state: 'active',
      archived: false,
      localRevision: 1,
    });
    expect(itemIds(await projections.listChoices('axis'))).toEqual(ids([graph.health, graph.work]));
    expect(itemIds(await projections.listChoices('milestone'))).toEqual(ids([graph.first5k]));
    expect(callsTo('listCandidates')).toEqual([
      [ownerId, 'project', undefined, 200],
      [ownerId, 'axis', undefined, 200],
      [ownerId, 'milestone', undefined, 200],
    ]);
    const before = calls.length;
    for (const kind of ['action', 'routine', 'note', 'review', ''])
      await expect(projections.listChoices(kind as 'axis')).resolves.toEqual([]);
    expect(calls).toHaveLength(before);
  });

  it('never writes records, events, receipts, undo entries, or notifications', async () => {
    const graph = seedGraph();
    const records = new Map(harness.unitOfWork.state.records);
    await projections.listAxes({ includeArchived: true });
    await projections.listUnassigned();
    await projections.getAxis(graph.health.ref.id, { includeFinished: true });
    await projections.getOutcome(graph.run.ref.id);
    await projections.getProject(graph.plan.ref.id);
    await projections.getMilestone(graph.first5k.ref.id);
    await projections.getNeighborhood({ kind: 'milestone', id: graph.first5k.ref.id });
    await projections.listLinkCandidates({
      focus: { kind: 'milestone', id: graph.first5k.ref.id },
      relationship: 'milestone_action',
    });
    await projections.listChoices('outcome');
    expect(harness.unitOfWork.state.records).toEqual(records);
    expect(harness.unitOfWork.state.events).toEqual([]);
    expect(harness.unitOfWork.state.receipts.size).toBe(0);
    expect(harness.unitOfWork.state.undo).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });

  it('uses the one active identity for every query', async () => {
    seedGraph();
    const noIdentity = createInMemoryHarness(ownerId, now);
    const orphaned = createAlignmentProjections(
      createAlignmentKit(
        {
          ...noIdentity.dependencies,
          identityContext: { getActiveIdentity: () => Promise.resolve(null) },
        },
        createAlignmentTestQueries(noIdentity.unitOfWork),
      ),
    );
    await expect(orphaned.listAxes()).rejects.toThrow('No active identity');
    const id: UUID = '12000000-0000-4000-8000-000000000001' as UUID;
    await expect(orphaned.getAxis(id)).rejects.toThrow('No active identity');
  });
});
