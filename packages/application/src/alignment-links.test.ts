import {
  alignmentLinkId,
  createEntityRef,
  entityRefKey,
  type EntityType,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AlignmentLinkMethods,
  LinkInput,
  NoChangeReceipt,
  RevisionRef,
  UnlinkInput,
} from './alignment-contracts';
import { createAlignmentKit } from './alignment-kit';
import { createAlignmentLinkCommands } from './alignment-links';
import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import type { PlanProfile } from './planning-contracts';
import { createPlanningApplication } from './planning';
import { createTestPlanningQueries } from './planning-routines-test-queries';
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
const later = '2026-09-28T15:30:00.000Z' as Instant;
const missingId = 'a0000000-0000-4000-8000-000000000404' as UUID;
const commandId = '90000000-0000-4000-8000-000000000001' as UUID;
const secondCommandId = '90000000-0000-4000-8000-000000000002' as UUID;
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: 'Asia/Tashkent' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
const archived = { state: 'archived', archivedAt: earlier } as const;

let harness: InMemoryHarness;
let seed: AlignmentSeeder;
let links: AlignmentLinkMethods;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  seed = createAlignmentSeeder(harness.unitOfWork, ownerId);
  links = createAlignmentLinkCommands(
    createAlignmentKit(harness.dependencies, createAlignmentTestQueries(harness.unitOfWork)),
  );
});

function valueOf<T>(result: ApplicationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** A link result that committed a change (not the no-change receipt). */
function committed(result: ApplicationResult<CommandReceipt | NoChangeReceipt>): CommandReceipt {
  const value = valueOf(result);
  if ('status' in value) throw new Error('Expected a committed change.');
  return value;
}

const errorOf = (result: ApplicationResult<unknown>) => (result.ok ? null : result.error);

const read = (record: CanonicalRecordState) =>
  harness.unitOfWork.get(entityRefKey(record.ref)) ?? null;

const ofType = (type: EntityType) =>
  [...harness.unitOfWork.state.records.values()].filter((record) => record.ref.type === type);

const events = () =>
  harness.unitOfWork.state.events.map(({ event }) => ({
    eventType: event.eventType,
    aggregate: event.aggregate,
    payload: event.payload,
  }));

/** Everything a rejected or no-change command must leave exactly as it was. */
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

const revisionRef = <K extends 'outcome' | 'project' | 'action' | 'milestone'>(
  kind: K,
  record: CanonicalRecordState,
) => ({ kind, id: record.ref.id, revision: record.localRevision });

type ForeignKeyRelationship =
  'axis_outcome' | 'axis_project' | 'outcome_primary_project' | 'project_action';

const foreignKeyRelationships: readonly ForeignKeyRelationship[] = [
  'axis_outcome',
  'axis_project',
  'outcome_primary_project',
  'project_action',
];

/** A parent, an unlinked child, the child's foreign-key field, and the link input. */
function foreignKeyFixture(relationship: ForeignKeyRelationship): {
  readonly parent: CanonicalRecordState;
  readonly child: CanonicalRecordState;
  readonly field: string;
  readonly input: LinkInput;
} {
  switch (relationship) {
    case 'axis_outcome': {
      const parent = seed.axis({ title: 'Private axis title' });
      const child = seed.outcome({ title: 'Private outcome title' });
      return {
        parent,
        child,
        field: 'axisId',
        input: { relationship, axisId: parent.ref.id, outcome: revisionRef('outcome', child) },
      };
    }
    case 'axis_project': {
      const parent = seed.axis({ title: 'Private axis title' });
      const child = seed.project({ title: 'Private project title' });
      return {
        parent,
        child,
        field: 'axisId',
        input: { relationship, axisId: parent.ref.id, project: revisionRef('project', child) },
      };
    }
    case 'outcome_primary_project': {
      const parent = seed.outcome({ title: 'Private outcome title' });
      const child = seed.project({ title: 'Private project title' });
      return {
        parent,
        child,
        field: 'primaryOutcomeId',
        input: { relationship, outcomeId: parent.ref.id, project: revisionRef('project', child) },
      };
    }
    case 'project_action': {
      const parent = seed.project({ title: 'Private project title' });
      const child = seed.action({ title: 'Private action title' });
      return {
        parent,
        child,
        field: 'projectId',
        input: { relationship, projectId: parent.ref.id, action: revisionRef('action', child) },
      };
    }
  }
}

type JoinRelationship = 'outcome_secondary_project' | 'milestone_project' | 'milestone_action';

/** A parent, a child, the join input, and the join document the link writes. */
function joinFixture(relationship: JoinRelationship): {
  readonly parent: CanonicalRecordState;
  readonly child: CanonicalRecordState;
  readonly input: LinkInput;
  readonly document: Readonly<Record<string, unknown>>;
} {
  switch (relationship) {
    case 'outcome_secondary_project': {
      const parent = seed.outcome({ title: 'Private outcome title' });
      const child = seed.project({ title: 'Private project title' });
      return {
        parent,
        child,
        input: { relationship, outcomeId: parent.ref.id, projectId: child.ref.id },
        document: { projectId: child.ref.id, outcomeId: parent.ref.id },
      };
    }
    case 'milestone_project': {
      const parent = seed.milestone(seed.outcome().ref.id, { title: 'Private milestone title' });
      const child = seed.project({ title: 'Private project title' });
      return {
        parent,
        child,
        input: { relationship, milestoneId: parent.ref.id, projectId: child.ref.id },
        document: { milestoneId: parent.ref.id, projectId: child.ref.id },
      };
    }
    case 'milestone_action': {
      const parent = seed.milestone(seed.outcome().ref.id, { title: 'Private milestone title' });
      const child = seed.action({ title: 'Private action title' });
      return {
        parent,
        child,
        input: { relationship, milestoneId: parent.ref.id, actionId: child.ref.id },
        document: { milestoneId: parent.ref.id, actionId: child.ref.id },
      };
    }
  }
}

const joinEntityType = (relationship: JoinRelationship) =>
  relationship === 'outcome_secondary_project' ? 'project_secondary_outcome' : relationship;

describe('link', () => {
  it.each(foreignKeyRelationships)(
    'links %s in one transaction with minimized events, a receipt, and undo',
    async (relationship) => {
      const { parent, child, field, input } = foreignKeyFixture(relationship);

      const receipt = committed(await links.link(input, commandId));

      expect(receipt.canonical).toEqual([{ ref: child.ref, localRevision: 2 }]);
      expect(read(child)?.document).toEqual({ ...child.document, [field]: parent.ref.id });
      expect(read(parent)).toEqual(parent);
      expect(events()).toEqual([
        {
          eventType: 'alignment.linked',
          aggregate: child.ref,
          payload: { operation: 'update', relationship, nextId: parent.ref.id },
        },
      ]);
      expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private');
      expect(harness.unitOfWork.state.receipts.size).toBe(1);
      expect(harness.notifications.map(({ touched }) => touched)).toEqual([[child.ref]]);

      await undo(receipt);
      expect(read(child)?.document).toEqual(child.document);
      expect(read(parent)).toEqual(parent);
    },
  );

  it.each(['outcome_secondary_project', 'milestone_project', 'milestone_action'] as const)(
    'creates the %s join record with its derived id; undo only marks it unlinked',
    async (relationship) => {
      const { parent, child, input, document } = joinFixture(relationship);
      const ref = createEntityRef(
        joinEntityType(relationship),
        alignmentLinkId(relationship, parent.ref.id, child.ref.id),
        ownerId,
      );

      const receipt = committed(await links.link(input));

      expect(receipt.canonical).toEqual([{ ref, localRevision: 1 }]);
      expect(harness.unitOfWork.get(entityRefKey(ref))?.document).toEqual(document);
      expect(events()).toEqual([
        {
          eventType: 'alignment.linked',
          aggregate: ref,
          payload: { operation: 'create', relationship, nextId: parent.ref.id },
        },
      ]);
      expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private');

      harness.setNow(later);
      await undo(receipt);
      expect(harness.unitOfWork.get(entityRefKey(ref))).toMatchObject({
        localRevision: 2,
        document: { ...document, unlinkedAt: later },
      });
      expect(read(parent)).toEqual(parent);
      expect(read(child)).toEqual(child);
    },
  );

  it('revives an unlinked join record instead of adding a second one', async () => {
    const outcome = seed.outcome();
    const project = seed.project();
    const link = seed.link('outcome_secondary_project', outcome.ref.id, project.ref.id, {
      unlinkedAt: earlier,
    });

    const receipt = committed(
      await links.link({
        relationship: 'outcome_secondary_project',
        outcomeId: outcome.ref.id,
        projectId: project.ref.id,
      }),
    );

    expect(receipt.canonical).toEqual([{ ref: link.ref, localRevision: 2 }]);
    expect(read(link)?.document).toEqual({ projectId: project.ref.id, outcomeId: outcome.ref.id });
    expect(ofType('project_secondary_outcome')).toHaveLength(1);
    expect(events()).toEqual([
      {
        eventType: 'alignment.linked',
        aggregate: link.ref,
        payload: {
          operation: 'update',
          relationship: 'outcome_secondary_project',
          nextId: outcome.ref.id,
        },
      },
    ]);

    await undo(receipt);
    expect(read(link)?.document).toEqual(link.document);
    expect(read(link)?.localRevision).toBe(3);
  });

  it('revives the join record found by its endpoints even when its id is not derived', async () => {
    const milestone = seed.milestone(seed.outcome().ref.id);
    const project = seed.project();
    const legacy: CanonicalRecordState = {
      ref: createEntityRef(
        'milestone_project',
        'e0000000-0000-4000-8000-000000000001' as UUID,
        ownerId,
      ),
      localRevision: 4,
      serverRevision: 0,
      baseSnapshotHash: null,
      document: { milestoneId: milestone.ref.id, projectId: project.ref.id, unlinkedAt: earlier },
    };
    harness.unitOfWork.seed(legacy);

    const receipt = committed(
      await links.link({
        relationship: 'milestone_project',
        milestoneId: milestone.ref.id,
        projectId: project.ref.id,
      }),
    );

    expect(receipt.canonical).toEqual([{ ref: legacy.ref, localRevision: 5 }]);
    expect(ofType('milestone_project')).toHaveLength(1);
    expect(read(legacy)?.document).toEqual({
      milestoneId: milestone.ref.id,
      projectId: project.ref.id,
    });
  });

  it('returns no change for an active duplicate and writes nothing', async () => {
    const axis = seed.axis();
    const outcome = seed.outcome({ axisId: axis.ref.id });
    const milestone = seed.milestone(outcome.ref.id);
    const project = seed.project();
    seed.link('milestone_project', milestone.ref.id, project.ref.id);
    const before = persisted();
    const noChange = { ok: true, value: { status: 'no_change', reason: 'already_linked' } };

    await expect(
      links.link({
        relationship: 'axis_outcome',
        axisId: axis.ref.id,
        outcome: revisionRef('outcome', outcome),
        replaceExisting: true,
      }),
    ).resolves.toEqual(noChange);
    await expect(
      links.link(
        {
          relationship: 'milestone_project',
          milestoneId: milestone.ref.id,
          projectId: project.ref.id,
        },
        commandId,
      ),
    ).resolves.toEqual(noChange);
    expect(persisted()).toEqual(before);
  });

  it('asks before replacing an occupied single-valued link and records both ids', async () => {
    const health = seed.axis({ title: 'Health' });
    const work = seed.axis({ title: 'Work' });
    const project = seed.project({ axisId: health.ref.id });
    const input = {
      relationship: 'axis_project',
      axisId: work.ref.id,
      project: revisionRef('project', project),
    } as const;
    const before = persisted();

    expect(errorOf(await links.link(input))).toMatchObject({
      code: 'domain_rejected',
      domainError: {
        code: 'cardinality_violation',
        message:
          'This Project is already linked to another Axis. Confirm the replacement to change it.',
      },
    });
    expect(persisted()).toEqual(before);

    const receipt = committed(await links.link({ ...input, replaceExisting: true }));
    expect(read(project)?.document['axisId']).toBe(work.ref.id);
    expect(events().map(({ payload }) => payload)).toEqual([
      {
        operation: 'update',
        relationship: 'axis_project',
        previousId: health.ref.id,
        nextId: work.ref.id,
      },
    ]);

    await undo(receipt);
    expect(read(project)?.document['axisId']).toBe(health.ref.id);
  });

  it('keeps the primary and the supporting Outcomes of a Project distinct', async () => {
    const run = seed.outcome({ title: 'Run' });
    const rest = seed.outcome({ title: 'Rest' });
    const project = seed.project({ primaryOutcomeId: run.ref.id });
    seed.link('outcome_secondary_project', rest.ref.id, project.ref.id);
    const before = persisted();

    expect(
      errorOf(
        await links.link({
          relationship: 'outcome_secondary_project',
          outcomeId: run.ref.id,
          projectId: project.ref.id,
        }),
      ),
    ).toMatchObject({
      domainError: {
        code: 'cardinality_violation',
        message: "This Outcome is already the Project's primary Outcome.",
      },
    });
    expect(
      errorOf(
        await links.link({
          relationship: 'outcome_primary_project',
          outcomeId: rest.ref.id,
          project: revisionRef('project', project),
          replaceExisting: true,
        }),
      ),
    ).toMatchObject({
      domainError: {
        code: 'cardinality_violation',
        message: expect.stringContaining('Remove it as a supporting Outcome first.') as unknown,
        details: { reason: 'primary_is_secondary' },
      },
    });
    expect(persisted()).toEqual(before);

    const formerlySupporting = seed.outcome();
    const other = seed.project();
    seed.link('outcome_secondary_project', formerlySupporting.ref.id, other.ref.id, {
      unlinkedAt: earlier,
    });
    committed(
      await links.link({
        relationship: 'outcome_primary_project',
        outcomeId: formerlySupporting.ref.id,
        project: revisionRef('project', other),
      }),
    );
    expect(read(other)?.document['primaryOutcomeId']).toBe(formerlySupporting.ref.id);
  });

  it('asks for cross-Axis confirmation only when an Action joins a Project of another Axis', async () => {
    const health = seed.axis();
    const work = seed.axis();
    const project = seed.project({ axisId: health.ref.id });
    const action = seed.action({ axisId: work.ref.id });
    const input = {
      relationship: 'project_action',
      projectId: project.ref.id,
      action: revisionRef('action', action),
    } as const;
    const before = persisted();

    expect(errorOf(await links.link(input))).toMatchObject({
      domainError: {
        code: 'cross_axis_confirmation_required',
        message: 'This Action is in a different Axis than the Project. Confirm to link them.',
      },
    });
    expect(persisted()).toEqual(before);

    committed(await links.link({ ...input, confirmCrossAxis: true }));
    expect(read(action)?.document).toMatchObject({
      projectId: project.ref.id,
      axisId: work.ref.id,
    });

    const unassigned = seed.action();
    committed(
      await links.link({
        relationship: 'project_action',
        projectId: project.ref.id,
        action: revisionRef('action', unassigned),
      }),
    );
    const milestone = seed.milestone(seed.outcome({ axisId: health.ref.id }).ref.id);
    const elsewhere = seed.action({ axisId: work.ref.id });
    committed(
      await links.link({
        relationship: 'milestone_action',
        milestoneId: milestone.ref.id,
        actionId: elsewhere.ref.id,
      }),
    );
  });

  it('blocks new links to archived endpoints but links finished ones', async () => {
    const outcome = seed.outcome();
    const archivedMilestone = seed.milestone(outcome.ref.id, {
      ...archived,
      stateBeforeArchive: 'active',
    });
    const completedMilestone = seed.milestone(outcome.ref.id, { state: 'completed' });
    const completedProject = seed.project({ state: 'completed', desiredResult: 'Shipped' });
    const archivedAxis = seed.axis({ ...archived, stateBeforeArchive: 'active' });
    const before = persisted();

    for (const result of [
      await links.link({
        relationship: 'milestone_project',
        milestoneId: archivedMilestone.ref.id,
        projectId: completedProject.ref.id,
      }),
      await links.link({
        relationship: 'axis_project',
        axisId: archivedAxis.ref.id,
        project: revisionRef('project', completedProject),
      }),
    ]) {
      expect(errorOf(result)).toMatchObject({
        code: 'domain_rejected',
        domainError: {
          code: 'archived_endpoint',
          message: 'Restore the archived item before linking it.',
        },
      });
    }
    expect(persisted()).toEqual(before);

    committed(
      await links.link({
        relationship: 'milestone_project',
        milestoneId: completedMilestone.ref.id,
        projectId: completedProject.ref.id,
      }),
    );
  });

  it('refuses unsupported, malformed, missing, and foreign links without writing', async () => {
    const axis = seed.axis();
    const outcome = seed.outcome();
    const routine = seed.routine();
    const milestone = seed.milestone(outcome.ref.id);
    const foreign = createAlignmentSeeder(
      harness.unitOfWork,
      otherOwnerId,
      'e0000000-0000-4000-8000-',
    ).project();
    const before = persisted();

    const unsupported = [
      {
        relationship: 'axis_routine',
        axisId: axis.ref.id,
        routine: { kind: 'routine', id: routine.ref.id, revision: 1 },
      },
      {
        relationship: 'outcome_milestone',
        outcomeId: outcome.ref.id,
        milestone: revisionRef('milestone', milestone),
      },
      { relationship: 'project_note', projectId: missingId, noteId: missingId },
      { relationship: 'axis_milestone', axisId: axis.ref.id, milestoneId: milestone.ref.id },
      // A swapped endpoint type is not a catalog pair.
      {
        relationship: 'axis_outcome',
        axisId: axis.ref.id,
        outcome: revisionRef('project', outcome),
      },
    ];
    for (const input of unsupported) {
      expect(errorOf(await links.link(input as unknown as LinkInput))).toMatchObject({
        code: 'domain_rejected',
        domainError: {
          code: 'unsupported_relationship',
          message: 'These items cannot be linked that way.',
        },
      });
    }
    expect(
      errorOf(
        await links.link({
          relationship: 'milestone_action',
          milestoneId: 'not-an-id',
          actionId: missingId,
        }),
      ),
    ).toMatchObject({
      code: 'domain_rejected',
      domainError: { code: 'invalid_uuid', message: 'That item is no longer available.' },
    });
    expect(
      errorOf(
        await links.link({
          relationship: 'milestone_project',
          milestoneId: milestone.ref.id,
          projectId: missingId,
        }),
      ),
    ).toEqual({ code: 'entity_not_found', ref: createEntityRef('project', missingId, ownerId) });
    expect(
      errorOf(
        await links.link({
          relationship: 'milestone_project',
          milestoneId: milestone.ref.id,
          projectId: foreign.ref.id,
        }),
      ),
    ).toEqual({
      code: 'entity_not_found',
      ref: createEntityRef('project', foreign.ref.id, ownerId),
    });
    expect(persisted()).toEqual(before);
  });

  it('rejects a stale child revision before writing', async () => {
    const axis = seed.axis();
    const outcome = seed.outcome({}, { revision: 3 });
    const before = persisted();

    expect(
      errorOf(
        await links.link({
          relationship: 'axis_outcome',
          axisId: axis.ref.id,
          outcome: { kind: 'outcome', id: outcome.ref.id, revision: 2 },
        }),
      ),
    ).toEqual({
      code: 'revision_conflict',
      ref: outcome.ref,
      expectedRevision: 2,
      actualRevision: 3,
    });
    expect(persisted()).toEqual(before);
  });

  it('returns the original receipt for a repeated command id', async () => {
    const { input } = joinFixture('milestone_project');
    const first = committed(await links.link(input, commandId));
    await expect(links.link(input, commandId)).resolves.toEqual({ ok: true, value: first });

    const { input: foreignKey } = foreignKeyFixture('axis_outcome');
    const second = committed(await links.link(foreignKey, secondCommandId));
    await expect(links.link(foreignKey, secondCommandId)).resolves.toEqual({
      ok: true,
      value: second,
    });
    expect(harness.unitOfWork.state.events).toHaveLength(2);
    expect(harness.unitOfWork.state.receipts.size).toBe(2);
  });
});

describe('previewLink', () => {
  it('previews creation, replacement, duplicates, and cross-Axis links without writing', async () => {
    const health = seed.axis({ title: 'Health' });
    const work = seed.axis({ title: 'Work' });
    const run = seed.outcome({ title: 'Run', axisId: health.ref.id });
    const rest = seed.outcome({ title: 'Rest' });
    const project = seed.project({ axisId: health.ref.id, primaryOutcomeId: run.ref.id });
    seed.link('outcome_secondary_project', rest.ref.id, project.ref.id);
    const action = seed.action({ axisId: work.ref.id });
    const before = persisted();

    await expect(
      links.previewLink({
        relationship: 'axis_outcome',
        axisId: work.ref.id,
        outcome: revisionRef('outcome', rest),
      }),
    ).resolves.toEqual({ allowed: true, alreadyLinked: false, crossAxis: false });
    await expect(
      links.previewLink({
        relationship: 'axis_project',
        axisId: work.ref.id,
        project: revisionRef('project', project),
      }),
    ).resolves.toEqual({
      allowed: true,
      alreadyLinked: false,
      crossAxis: false,
      replaces: {
        id: health.ref.id,
        kind: 'axis',
        title: 'Health',
        state: 'active',
        archived: false,
        localRevision: 1,
      },
    });
    await expect(
      links.previewLink({
        relationship: 'outcome_secondary_project',
        outcomeId: rest.ref.id,
        projectId: project.ref.id,
      }),
    ).resolves.toEqual({ allowed: true, alreadyLinked: true, crossAxis: false });
    await expect(
      links.previewLink({
        relationship: 'project_action',
        projectId: project.ref.id,
        action: revisionRef('action', action),
      }),
    ).resolves.toEqual({ allowed: true, alreadyLinked: false, crossAxis: true });
    expect(persisted()).toEqual(before);
  });

  it('explains every refusal with a reason', async () => {
    const run = seed.outcome({ title: 'Run' });
    const rest = seed.outcome({ title: 'Rest' });
    const project = seed.project({ primaryOutcomeId: run.ref.id });
    seed.link('outcome_secondary_project', rest.ref.id, project.ref.id);
    const archivedOutcome = seed.outcome({ ...archived, stateBeforeArchive: 'active' });
    const before = persisted();
    const refused = (reason: string) => ({
      allowed: false,
      alreadyLinked: false,
      reason,
      crossAxis: false,
    });

    await expect(
      links.previewLink({
        relationship: 'outcome_secondary_project',
        outcomeId: run.ref.id,
        projectId: project.ref.id,
      }),
    ).resolves.toEqual(refused('cardinality_violation'));
    await expect(
      links.previewLink({
        relationship: 'outcome_primary_project',
        outcomeId: rest.ref.id,
        project: revisionRef('project', project),
      }),
    ).resolves.toEqual(refused('primary_is_secondary'));
    await expect(
      links.previewLink({
        relationship: 'outcome_secondary_project',
        outcomeId: archivedOutcome.ref.id,
        projectId: project.ref.id,
      }),
    ).resolves.toEqual(refused('archived_endpoint'));
    await expect(
      links.previewLink({ relationship: 'axis_routine' } as unknown as LinkInput),
    ).resolves.toEqual(refused('unsupported_relationship'));
    await expect(
      links.previewLink({
        relationship: 'outcome_secondary_project',
        outcomeId: 'not-an-id',
        projectId: project.ref.id,
      }),
    ).resolves.toEqual(refused('not_found'));
    await expect(
      links.previewLink({
        relationship: 'outcome_secondary_project',
        outcomeId: missingId,
        projectId: project.ref.id,
      }),
    ).resolves.toEqual(refused('not_found'));
    expect(persisted()).toEqual(before);
  });
});

/** A child linked to its parent through a foreign key, and the unlink input. */
function linkedForeignKeyFixture(relationship: ForeignKeyRelationship): {
  readonly parent: CanonicalRecordState;
  readonly child: CanonicalRecordState;
  readonly field: string;
  readonly input: UnlinkInput;
} {
  switch (relationship) {
    case 'axis_outcome': {
      const parent = seed.axis();
      const child = seed.outcome({ axisId: parent.ref.id, title: 'Private outcome title' });
      return {
        parent,
        child,
        field: 'axisId',
        input: { relationship, outcome: revisionRef('outcome', child) },
      };
    }
    case 'axis_project': {
      const parent = seed.axis();
      const child = seed.project({ axisId: parent.ref.id, title: 'Private project title' });
      return {
        parent,
        child,
        field: 'axisId',
        input: { relationship, project: revisionRef('project', child) },
      };
    }
    case 'outcome_primary_project': {
      const parent = seed.outcome();
      const child = seed.project({ primaryOutcomeId: parent.ref.id });
      return {
        parent,
        child,
        field: 'primaryOutcomeId',
        input: { relationship, project: revisionRef('project', child) },
      };
    }
    case 'project_action': {
      const parent = seed.project();
      const child = seed.action({ projectId: parent.ref.id, title: 'Private action title' });
      return {
        parent,
        child,
        field: 'projectId',
        input: { relationship, action: revisionRef('action', child) },
      };
    }
  }
}

const withoutField = (record: CanonicalRecordState, field: string) =>
  Object.fromEntries(Object.entries(record.document).filter(([key]) => key !== field));

describe('unlink', () => {
  it.each(foreignKeyRelationships)(
    'clears the %s foreign key, keeps both endpoints, and undo links again',
    async (relationship) => {
      const { parent, child, field, input } = linkedForeignKeyFixture(relationship);

      const receipt = valueOf(await links.unlink(input, commandId));

      expect(receipt.canonical).toEqual([{ ref: child.ref, localRevision: 2 }]);
      expect(read(child)?.document).toEqual(withoutField(child, field));
      expect(read(parent)).toEqual(parent);
      expect(events()).toEqual([
        {
          eventType: 'alignment.unlinked',
          aggregate: child.ref,
          payload: { operation: 'update', relationship, previousId: parent.ref.id },
        },
      ]);
      expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private');

      await undo(receipt);
      expect(read(child)?.document).toEqual(child.document);
    },
  );

  it('marks a join link unlinked, keeps both endpoints, and undo links it again', async () => {
    const outcome = seed.outcome();
    const milestone = seed.milestone(outcome.ref.id);
    const action = seed.action();
    const link = seed.link('milestone_action', milestone.ref.id, action.ref.id);

    const receipt = valueOf(
      await links.unlink({
        relationship: 'milestone_action',
        linkId: link.ref.id,
        revision: 1,
      }),
    );

    expect(read(link)).toMatchObject({
      localRevision: 2,
      document: { milestoneId: milestone.ref.id, actionId: action.ref.id, unlinkedAt: now },
    });
    expect(read(milestone)).toEqual(milestone);
    expect(read(action)).toEqual(action);
    expect(events()).toEqual([
      {
        eventType: 'alignment.unlinked',
        aggregate: link.ref,
        payload: {
          operation: 'update',
          relationship: 'milestone_action',
          previousId: milestone.ref.id,
        },
      },
    ]);

    await undo(receipt);
    expect(read(link)?.document).toEqual(link.document);
  });

  it('unlinks even when an endpoint is archived and never changes its state', async () => {
    const archivedOutcome = seed.outcome({ ...archived, stateBeforeArchive: 'paused' });
    const project = seed.project({ ...archived, stateBeforeArchive: 'idea' });
    const link = seed.link('outcome_secondary_project', archivedOutcome.ref.id, project.ref.id);
    const archivedAxis = seed.axis({ ...archived, stateBeforeArchive: 'active' });
    const member = seed.outcome({ axisId: archivedAxis.ref.id });

    valueOf(
      await links.unlink({
        relationship: 'outcome_secondary_project',
        linkId: link.ref.id,
        revision: 1,
      }),
    );
    valueOf(
      await links.unlink({ relationship: 'axis_outcome', outcome: revisionRef('outcome', member) }),
    );

    expect(read(link)?.document['unlinkedAt']).toBe(now);
    expect(read(member)?.document['axisId']).toBeUndefined();
    expect(read(archivedOutcome)).toEqual(archivedOutcome);
    expect(read(project)).toEqual(project);
    expect(read(archivedAxis)).toEqual(archivedAxis);
  });

  it("refuses to remove a Milestone's Outcome and points to moving it instead", async () => {
    const outcome = seed.outcome();
    const milestone = seed.milestone(outcome.ref.id);
    const routine = seed.routine();
    const note = seed.note();
    const before = persisted();

    expect(
      errorOf(
        await links.unlink({
          relationship: 'outcome_milestone',
          milestone: revisionRef('milestone', milestone),
        } as unknown as UnlinkInput),
      ),
    ).toEqual({
      code: 'domain_rejected',
      domainError: {
        code: 'required_relationship',
        message: 'A milestone always belongs to one Outcome. Move it to another Outcome instead.',
        details: { reason: 'required_relationship', relationship: 'outcome_milestone' },
      },
    });
    for (const input of [
      {
        relationship: 'axis_routine',
        routine: { kind: 'routine', id: routine.ref.id, revision: 1 },
      },
      { relationship: 'project_note', note: { kind: 'note', id: note.ref.id, revision: 1 } },
      { relationship: 'anything' },
    ]) {
      expect(errorOf(await links.unlink(input as unknown as UnlinkInput))).toMatchObject({
        domainError: { code: 'unsupported_relationship' },
      });
    }
    expect(persisted()).toEqual(before);
  });

  it('reports an already removed link as no change and writes nothing', async () => {
    const outcome = seed.outcome();
    const project = seed.project();
    const unlinked = seed.link('outcome_secondary_project', outcome.ref.id, project.ref.id, {
      unlinkedAt: earlier,
    });
    const before = persisted();
    const alreadyRemoved = {
      code: 'domain_rejected',
      domainError: {
        code: 'invalid_value',
        message: 'This link is already removed. Nothing changed.',
        details: { reason: 'no_change' },
      },
    };

    expect(
      errorOf(
        await links.unlink({
          relationship: 'outcome_secondary_project',
          linkId: unlinked.ref.id,
          revision: 1,
        }),
      ),
    ).toEqual(alreadyRemoved);
    expect(
      errorOf(
        await links.unlink({
          relationship: 'outcome_primary_project',
          project: revisionRef('project', project),
        }),
      ),
    ).toEqual(alreadyRemoved);
    expect(persisted()).toEqual(before);
  });

  it('rejects stale, malformed, and unknown links without writing', async () => {
    const outcome = seed.outcome();
    const milestone = seed.milestone(outcome.ref.id);
    const project = seed.project();
    const link = seed.link('milestone_project', milestone.ref.id, project.ref.id, { revision: 2 });
    const before = persisted();

    expect(
      errorOf(
        await links.unlink({ relationship: 'milestone_project', linkId: link.ref.id, revision: 1 }),
      ),
    ).toEqual({ code: 'revision_conflict', ref: link.ref, expectedRevision: 1, actualRevision: 2 });
    expect(
      errorOf(
        await links.unlink({ relationship: 'milestone_project', linkId: 'nope', revision: 1 }),
      ),
    ).toMatchObject({ domainError: { code: 'invalid_uuid' } });
    expect(
      errorOf(
        await links.unlink({ relationship: 'milestone_project', linkId: missingId, revision: 1 }),
      ),
    ).toEqual({
      code: 'entity_not_found',
      ref: createEntityRef('milestone_project', missingId, ownerId),
    });
    expect(persisted()).toEqual(before);
  });

  it('returns the original receipt for a repeated command id', async () => {
    const { input } = linkedForeignKeyFixture('project_action');
    const first = valueOf(await links.unlink(input, commandId));
    await expect(links.unlink(input, commandId)).resolves.toEqual({ ok: true, value: first });
    expect(harness.unitOfWork.state.events).toHaveLength(1);
  });
});

describe('reparentMilestone', () => {
  it('moves a Milestone to another Outcome without reopening, reordering, or unlinking it', async () => {
    const from = seed.outcome({ title: 'Private first outcome' });
    const to = seed.outcome({ title: 'Private second outcome' });
    const milestone = seed.milestone(from.ref.id, { state: 'completed', title: 'Private title' });
    const project = seed.project();
    const link = seed.link('milestone_project', milestone.ref.id, project.ref.id);

    const receipt = valueOf(
      await links.reparentMilestone(revisionRef('milestone', milestone), to.ref.id, commandId),
    );

    expect(receipt.canonical).toEqual([{ ref: milestone.ref, localRevision: 2 }]);
    expect(read(milestone)?.document).toEqual({ ...milestone.document, outcomeId: to.ref.id });
    expect(read(link)).toEqual(link);
    expect(read(from)).toEqual(from);
    expect(read(to)).toEqual(to);
    expect(events()).toEqual([
      {
        eventType: 'milestone.reparented',
        aggregate: milestone.ref,
        payload: {
          operation: 'update',
          relationship: 'outcome_milestone',
          previousId: from.ref.id,
          nextId: to.ref.id,
        },
      },
    ]);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private');

    await expect(
      links.reparentMilestone(revisionRef('milestone', milestone), to.ref.id, commandId),
    ).resolves.toEqual({ ok: true, value: receipt });

    await undo(receipt);
    expect(read(milestone)?.document).toEqual(milestone.document);
  });

  it('moves a Milestone out of an archived Outcome', async () => {
    const from = seed.outcome({ ...archived, stateBeforeArchive: 'active' });
    const to = seed.outcome();
    const milestone = seed.milestone(from.ref.id);

    valueOf(await links.reparentMilestone(revisionRef('milestone', milestone), to.ref.id));
    expect(read(milestone)?.document['outcomeId']).toBe(to.ref.id);
  });

  it('refuses moves that would change nothing or reach an archived endpoint', async () => {
    const outcome = seed.outcome();
    const archivedOutcome = seed.outcome({ ...archived, stateBeforeArchive: 'active' });
    const milestone = seed.milestone(outcome.ref.id);
    const archivedMilestone = seed.milestone(outcome.ref.id, {
      ...archived,
      stateBeforeArchive: 'active',
    });
    const other = seed.outcome();
    const before = persisted();

    expect(
      errorOf(await links.reparentMilestone(revisionRef('milestone', milestone), outcome.ref.id)),
    ).toEqual({
      code: 'domain_rejected',
      domainError: {
        code: 'invalid_value',
        message: 'This Milestone already belongs to that Outcome.',
        details: { reason: 'no_change' },
      },
    });
    expect(
      errorOf(
        await links.reparentMilestone(revisionRef('milestone', milestone), archivedOutcome.ref.id),
      ),
    ).toMatchObject({
      domainError: {
        code: 'archived_endpoint',
        message: 'Restore that Outcome before moving a Milestone to it.',
      },
    });
    expect(
      errorOf(
        await links.reparentMilestone(revisionRef('milestone', archivedMilestone), other.ref.id),
      ),
    ).toMatchObject({
      domainError: {
        code: 'archived_endpoint',
        message: 'Restore this Milestone before moving it.',
      },
    });
    expect(persisted()).toEqual(before);
  });

  it('rejects missing, malformed, mistyped, and stale requests without writing', async () => {
    const outcome = seed.outcome();
    const other = seed.outcome();
    const milestone = seed.milestone(outcome.ref.id, {}, { revision: 2 });
    const before = persisted();

    expect(
      errorOf(await links.reparentMilestone(revisionRef('milestone', milestone), missingId)),
    ).toEqual({ code: 'entity_not_found', ref: createEntityRef('outcome', missingId, ownerId) });
    expect(
      errorOf(
        await links.reparentMilestone(
          { kind: 'milestone', id: missingId, revision: 1 },
          other.ref.id,
        ),
      ),
    ).toEqual({ code: 'entity_not_found', ref: createEntityRef('milestone', missingId, ownerId) });
    expect(
      errorOf(await links.reparentMilestone(revisionRef('milestone', milestone), 'not-an-id')),
    ).toMatchObject({ domainError: { code: 'invalid_uuid' } });
    expect(
      errorOf(
        await links.reparentMilestone(
          {
            kind: 'project',
            id: milestone.ref.id,
            revision: 2,
          } as unknown as RevisionRef<'milestone'>,
          other.ref.id,
        ),
      ),
    ).toMatchObject({ domainError: { code: 'unsupported_relationship' } });
    expect(
      errorOf(
        await links.reparentMilestone(
          { kind: 'milestone', id: milestone.ref.id, revision: 1 },
          other.ref.id,
        ),
      ),
    ).toEqual({
      code: 'revision_conflict',
      ref: milestone.ref,
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(persisted()).toEqual(before);
  });
});
