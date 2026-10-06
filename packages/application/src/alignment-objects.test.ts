import {
  entityRefKey,
  type AlignmentKind,
  type CalendarDate,
  type EntityRef,
  type IanaTimeZone,
  type Instant,
  type MilestoneState,
  type OutcomeState,
  type OwnerId,
  type ProjectState,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AlignmentObjectMethods,
  AxisInput,
  OutcomeInput,
  ProjectInput,
  ReorderScope,
  RevisionRef,
} from './alignment-contracts';
import { createAlignmentKit } from './alignment-kit';
import { createAlignmentObjectCommands } from './alignment-objects';
import type {
  ApplicationError,
  ApplicationResult,
  CanonicalRecordState,
  CommandReceipt,
} from './contracts';
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
const now = '2026-09-28T13:00:00.000Z' as Instant;
const commandId = '90000000-0000-4000-8000-000000000001' as UUID;
const unknownId = '20000000-0000-4000-8000-00000000abcd' as UUID;
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: 'Asia/Tashkent' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
const archivedFields = { state: 'archived', archivedAt: now } as const;

let harness: InMemoryHarness;
let commands: AlignmentObjectMethods;
let seed: AlignmentSeeder;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  commands = createAlignmentObjectCommands(
    createAlignmentKit(harness.dependencies, createAlignmentTestQueries(harness.unitOfWork)),
  );
  seed = createAlignmentSeeder(harness.unitOfWork, ownerId);
});

/* ───────────────────────── Helpers ───────────────────────── */

const receiptOf = (result: ApplicationResult<CommandReceipt>): CommandReceipt => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const rejection = (result: ApplicationResult<CommandReceipt>): ApplicationError => {
  if (result.ok) throw new Error('Expected the command to be rejected.');
  return result.error;
};

const domainError = (result: ApplicationResult<CommandReceipt>) => {
  const error = rejection(result);
  if (error.code !== 'domain_rejected') throw new Error(JSON.stringify(error));
  return error.domainError;
};

const createdRef = (receipt: CommandReceipt): EntityRef => {
  const first = receipt.canonical[0];
  if (first === undefined) throw new Error('Expected a created record.');
  return first.ref;
};

const stored = (ref: EntityRef): CanonicalRecordState | undefined =>
  harness.unitOfWork.get(entityRefKey(ref));

const documentOf = (ref: EntityRef): Readonly<Record<string, unknown>> | undefined =>
  stored(ref)?.document;

const orderKeyOf = (record: CanonicalRecordState): unknown => documentOf(record.ref)?.['orderKey'];

const rev = <K extends AlignmentKind | 'action'>(
  kind: K,
  record: CanonicalRecordState,
  revision = stored(record.ref)?.localRevision ?? record.localRevision,
): RevisionRef<K> => ({ kind, id: record.ref.id, revision });

const events = () =>
  harness.unitOfWork.state.events.map(({ event }) => ({
    type: event.eventType,
    id: event.aggregate.id,
    payload: event.payload,
  }));

const eventText = () => JSON.stringify(harness.unitOfWork.state.events);

/** Everything a command could write, to prove a rejection wrote nothing. */
const snapshot = () => ({
  records: new Map(harness.unitOfWork.state.records),
  events: harness.unitOfWork.state.events.length,
  receipts: harness.unitOfWork.state.receipts.size,
  undo: harness.unitOfWork.state.undo.length,
  outbox: harness.unitOfWork.state.outbox.length,
  notifications: harness.notifications.length,
});

const expectNothingWritten = (before: ReturnType<typeof snapshot>) =>
  expect(snapshot()).toEqual(before);

const undo = async (receipt: CommandReceipt): Promise<CommandReceipt> => {
  if (!receipt.undo.available) throw new Error('Expected undo to be available.');
  return receiptOf(
    await createPlanningApplication(
      harness.dependencies,
      createTestPlanningQueries(harness.unitOfWork, profile),
    ).undo(receipt.undo.undoId),
  );
};

const recordsOfType = (type: string) =>
  [...harness.unitOfWork.state.records.values()].filter((record) => record.ref.type === type);

/* ───────────────────────── Axes ───────────────────────── */

describe('createAxis', () => {
  it('appends a trimmed active Axis in one minimized transaction with an archive undo', async () => {
    const health = seed.axis({ title: 'Health' });
    const work = seed.axis({ title: 'Work' });

    const receipt = receiptOf(
      await commands.createAxis({
        title: '  Private axis title  ',
        purpose: ' Private purpose ',
        color: 'cyan',
        icon: 'leaf',
      }),
    );

    const ref = createdRef(receipt);
    expect(ref).toMatchObject({ type: 'axis', ownerId });
    expect(documentOf(ref)).toEqual({
      title: 'Private axis title',
      purpose: 'Private purpose',
      color: 'cyan',
      icon: 'leaf',
      orderKey: '000003000000000',
      state: 'active',
    });
    expect(receipt.canonical).toEqual([{ ref, localRevision: 1 }]);
    expect(events()).toEqual([
      { type: 'axis.created', id: ref.id, payload: { operation: 'create' } },
    ]);
    expect(eventText()).not.toContain('Private');
    expect(harness.notifications.map(({ touched }) => touched)).toEqual([[ref]]);
    expect(stored(health.ref)).toEqual(health);
    expect(stored(work.ref)).toEqual(work);

    await undo(receipt);
    expect(documentOf(ref)).toEqual({
      title: 'Private axis title',
      purpose: 'Private purpose',
      color: 'cyan',
      icon: 'leaf',
      orderKey: '000003000000000',
      state: 'archived',
      stateBeforeArchive: 'active',
      archivedAt: now,
    });
  });

  it('normalizes onboarding order keys in the same command and records siblings as reordered', async () => {
    const health = seed.axis({ title: 'Health', orderKey: 'onboarding-01' });
    const work = seed.axis({ title: 'Work', orderKey: 'onboarding-02' });
    const archived = seed.axis({
      title: 'Old',
      orderKey: 'onboarding-03',
      stateBeforeArchive: 'active',
      ...archivedFields,
    });

    const receipt = receiptOf(await commands.createAxis({ title: 'Learning' }));
    const ref = createdRef(receipt);

    expect(orderKeyOf(health)).toBe('000001000000000');
    expect(orderKeyOf(work)).toBe('000002000000000');
    expect(documentOf(ref)?.['orderKey']).toBe('000003000000000');
    expect(stored(archived.ref)).toEqual(archived);
    expect(receipt.canonical.map(({ ref: changed }) => changed.id)).toEqual([
      ref.id,
      health.ref.id,
      work.ref.id,
    ]);
    expect(events()).toEqual([
      { type: 'axis.created', id: ref.id, payload: { operation: 'create' } },
      { type: 'axis.reordered', id: health.ref.id, payload: { operation: 'update' } },
      { type: 'axis.reordered', id: work.ref.id, payload: { operation: 'update' } },
    ]);

    await undo(receipt);
    expect(stored(health.ref)?.document).toEqual(health.document);
    expect(stored(work.ref)?.document).toEqual(work.document);
    expect(documentOf(ref)).toMatchObject({ state: 'archived', stateBeforeArchive: 'active' });
  });

  it('returns the original receipt for a repeated command id', async () => {
    const first = receiptOf(await commands.createAxis({ title: 'Health' }, commandId));
    const second = receiptOf(await commands.createAxis({ title: 'Health' }, commandId));
    expect(second).toEqual(first);
    expect(recordsOfType('axis')).toHaveLength(1);
    expect(harness.unitOfWork.state.events).toHaveLength(1);
  });

  const invalidAxes: readonly (readonly [AxisInput, string])[] = [
    [{ title: '   ' }, 'title_required'],
    [{ title: 'x'.repeat(81) }, 'title_too_long'],
    [{ title: 'Health', purpose: 'x'.repeat(2001) }, 'text_too_long'],
    [{ title: 'Health', color: 'blue' }, 'color'],
    [{ title: 'Health', icon: 'Leaf!' }, 'icon'],
  ];
  it.each(invalidAxes)('rejects invalid input without writing (%#)', async (input, reason) => {
    seed.axis();
    const before = snapshot();
    expect(domainError(await commands.createAxis(input))).toMatchObject({
      code: 'invalid_value',
      details: { reason },
    });
    expectNothingWritten(before);
  });

  it('accepts the longest allowed title', async () => {
    const receipt = receiptOf(await commands.createAxis({ title: 'x'.repeat(80) }));
    expect(documentOf(createdRef(receipt))?.['title']).toHaveLength(80);
  });
});

describe('editAxis', () => {
  it('replaces the editable fields, keeps order and state, and undoes to the prior document', async () => {
    const axis = seed.axis({
      title: 'Health',
      purpose: 'Old purpose',
      color: 'cyan',
      icon: 'leaf',
    });

    const receipt = receiptOf(
      await commands.editAxis(rev('axis', axis), { title: ' Private health ', color: 'violet' }),
    );

    expect(stored(axis.ref)).toMatchObject({
      localRevision: 2,
      document: {
        title: 'Private health',
        color: 'violet',
        orderKey: axis.document['orderKey'],
        state: 'active',
      },
    });
    expect(documentOf(axis.ref)).not.toHaveProperty('purpose');
    expect(documentOf(axis.ref)).not.toHaveProperty('icon');
    expect(events()).toEqual([
      { type: 'axis.edited', id: axis.ref.id, payload: { operation: 'update' } },
    ]);
    expect(eventText()).not.toContain('Private');

    await undo(receipt);
    expect(documentOf(axis.ref)).toEqual(axis.document);
  });

  it('reports a stale revision and writes nothing', async () => {
    const axis = seed.axis({}, { revision: 3 });
    const before = snapshot();
    expect(rejection(await commands.editAxis(rev('axis', axis, 2), { title: 'New' }))).toEqual({
      code: 'revision_conflict',
      ref: axis.ref,
      expectedRevision: 2,
      actualRevision: 3,
    });
    expectNothingWritten(before);
  });

  it('refuses an edit that changes nothing', async () => {
    const axis = seed.axis({ title: 'Health' });
    const before = snapshot();
    expect(
      domainError(await commands.editAxis(rev('axis', axis), { title: ' Health ' })),
    ).toMatchObject({
      code: 'invalid_value',
      message: 'Nothing changed.',
      details: { reason: 'no_change' },
    });
    expectNothingWritten(before);
  });

  it('keeps an archived Axis read-only', async () => {
    const axis = seed.axis({ stateBeforeArchive: 'active', ...archivedFields });
    const before = snapshot();
    expect(domainError(await commands.editAxis(rev('axis', axis), { title: 'New' }))).toEqual({
      code: 'invalid_value',
      message: 'Restore this Axis before editing it.',
      details: { reason: 'archived_target' },
    });
    expectNothingWritten(before);
  });

  it('rejects malformed, unknown, and mismatched targets calmly', async () => {
    const outcome = seed.outcome();
    const before = snapshot();
    expect(
      domainError(
        await commands.editAxis({ kind: 'axis', id: 'not-an-id', revision: 1 }, { title: 'X' }),
      ),
    ).toEqual({
      code: 'invalid_uuid',
      message: 'This item is unavailable. Refresh and try again.',
      details: { reason: 'invalid_id', field: 'id' },
    });
    expect(
      rejection(
        await commands.editAxis({ kind: 'axis', id: unknownId, revision: 1 }, { title: 'X' }),
      ),
    ).toEqual({ code: 'entity_not_found', ref: { type: 'axis', id: unknownId, ownerId } });
    expect(
      domainError(
        await commands.editAxis(rev('outcome', outcome) as unknown as RevisionRef<'axis'>, {
          title: 'X',
        }),
      ),
    ).toMatchObject({ code: 'invalid_value', details: { reason: 'target_kind' } });
    expectNothingWritten(before);
  });
});

/* ───────────────────────── Outcomes ───────────────────────── */

describe('createOutcome', () => {
  it('appends an active Outcome to its Axis with a target window and chosen progress', async () => {
    const axis = seed.axis();
    seed.outcome({ axisId: axis.ref.id });
    seed.outcome({ orderKey: '000009000000000' });

    const receipt = receiptOf(
      await commands.createOutcome({
        title: ' Private outcome ',
        successDefinition: ' Private success ',
        axisId: axis.ref.id.toUpperCase(),
        targetStart: '2026-10-01',
        targetEnd: '2026-12-31',
        progress: { mode: 'manual', percentage: 10 },
      }),
    );

    const ref = createdRef(receipt);
    expect(documentOf(ref)).toEqual({
      title: 'Private outcome',
      successDefinition: 'Private success',
      axisId: axis.ref.id,
      progress: { mode: 'manual', percentage: 10 },
      targetStart: '2026-10-01',
      targetEnd: '2026-12-31',
      orderKey: '000003000000000',
      state: 'active',
    });
    expect(events()).toEqual([
      { type: 'outcome.created', id: ref.id, payload: { operation: 'create' } },
    ]);
    expect(eventText()).not.toContain('Private');

    await undo(receipt);
    expect(documentOf(ref)).toMatchObject({ state: 'archived', stateBeforeArchive: 'active' });
  });

  it('appends an Outcome with no Axis to "Not in an Axis" with no progress measure', async () => {
    const axis = seed.axis();
    seed.outcome({ axisId: axis.ref.id, orderKey: '000009000000000' });
    seed.outcome({ orderKey: '000004000000000' });

    const receipt = receiptOf(
      await commands.createOutcome({ title: 'Read more', successDefinition: 'Twelve books' }),
    );

    expect(documentOf(createdRef(receipt))).toEqual({
      title: 'Read more',
      successDefinition: 'Twelve books',
      progress: { mode: 'none' },
      orderKey: '000005000000000',
      state: 'active',
    });
  });

  it('refuses an archived Axis without writing', async () => {
    const archived = seed.axis({ stateBeforeArchive: 'active', ...archivedFields });
    const before = snapshot();
    expect(
      domainError(
        await commands.createOutcome({
          title: 'Run',
          successDefinition: 'Finish',
          axisId: archived.ref.id,
        }),
      ),
    ).toMatchObject({
      code: 'archived_endpoint',
      message: 'Restore this Axis before adding an Outcome to it.',
    });
    expectNothingWritten(before);
  });

  it('reports a missing or malformed Axis without writing', async () => {
    const before = snapshot();
    expect(
      rejection(
        await commands.createOutcome({
          title: 'Run',
          successDefinition: 'Finish',
          axisId: unknownId,
        }),
      ),
    ).toEqual({ code: 'entity_not_found', ref: { type: 'axis', id: unknownId, ownerId } });
    expect(
      domainError(
        await commands.createOutcome({ title: 'Run', successDefinition: 'Finish', axisId: 'nope' }),
      ),
    ).toMatchObject({ code: 'invalid_uuid', details: { field: 'axisId' } });
    expectNothingWritten(before);
  });

  const invalidOutcomes: readonly (readonly [OutcomeInput, string])[] = [
    [{ title: '', successDefinition: 'Finish' }, 'title_required'],
    [{ title: 'x'.repeat(121), successDefinition: 'Finish' }, 'title_too_long'],
    [{ title: 'Run', successDefinition: '  ' }, 'text_required'],
    [{ title: 'Run', successDefinition: 'x'.repeat(2001) }, 'text_too_long'],
    [
      {
        title: 'Run',
        successDefinition: 'Finish',
        targetStart: '2026-12-31',
        targetEnd: '2026-10-01',
      },
      'target_window',
    ],
    [{ title: 'Run', successDefinition: 'Finish', targetStart: '2026-02-30' }, 'target_window'],
    [
      { title: 'Run', successDefinition: 'Finish', progress: { mode: 'manual', percentage: 101 } },
      'progress_percentage',
    ],
  ];
  it.each(invalidOutcomes)('rejects invalid input without writing (%#)', async (input, reason) => {
    const before = snapshot();
    expect(domainError(await commands.createOutcome(input))).toMatchObject({
      code: 'invalid_value',
      details: { reason },
    });
    expectNothingWritten(before);
  });
});

describe('editOutcome', () => {
  it('edits text and target window without touching progress, Axis, order, or state', async () => {
    const axis = seed.axis();
    const outcome = seed.outcome({
      axisId: axis.ref.id,
      state: 'paused',
      progress: { mode: 'manual', percentage: 30 },
      targetStart: '2026-10-01' as CalendarDate,
      targetEnd: '2026-10-31' as CalendarDate,
    });

    const receipt = receiptOf(
      await commands.editOutcome(rev('outcome', outcome), {
        title: 'Private title',
        successDefinition: 'Private success',
        targetEnd: '2026-11-30',
      }),
    );

    expect(documentOf(outcome.ref)).toEqual({
      title: 'Private title',
      successDefinition: 'Private success',
      axisId: axis.ref.id,
      progress: { mode: 'manual', percentage: 30 },
      targetEnd: '2026-11-30',
      orderKey: outcome.document['orderKey'],
      state: 'paused',
    });
    expect(events()).toEqual([
      { type: 'outcome.edited', id: outcome.ref.id, payload: { operation: 'update' } },
    ]);
    expect(eventText()).not.toContain('Private');
    await undo(receipt);
    expect(documentOf(outcome.ref)).toEqual(outcome.document);
  });

  it('keeps an archived Outcome read-only and validates input first', async () => {
    const outcome = seed.outcome({ stateBeforeArchive: 'active', ...archivedFields });
    const before = snapshot();
    expect(
      domainError(
        await commands.editOutcome(rev('outcome', outcome), { title: 'X', successDefinition: 'Y' }),
      ),
    ).toMatchObject({ message: 'Restore this Outcome before editing it.' });
    expect(
      domainError(
        await commands.editOutcome(rev('outcome', outcome), { title: 'X', successDefinition: '' }),
      ),
    ).toMatchObject({ details: { reason: 'text_required', field: 'successDefinition' } });
    expectNothingWritten(before);
  });
});

describe('setOutcomeProgress', () => {
  it('switches modes, drops the manual percentage, never changes state, and undoes', async () => {
    const outcome = seed.outcome({ state: 'paused' });

    receiptOf(
      await commands.setOutcomeProgress(rev('outcome', outcome), {
        mode: 'manual',
        percentage: 40,
      }),
    );
    expect(documentOf(outcome.ref)).toMatchObject({
      progress: { mode: 'manual', percentage: 40 },
      state: 'paused',
    });

    const derived = receiptOf(
      await commands.setOutcomeProgress(rev('outcome', outcome), {
        mode: 'milestone_derived',
        percentage: 40,
      } as never),
    );
    expect(documentOf(outcome.ref)?.['progress']).toEqual({ mode: 'milestone_derived' });
    expect(documentOf(outcome.ref)?.['state']).toBe('paused');
    expect(events().map(({ type }) => type)).toEqual([
      'outcome.progress_set',
      'outcome.progress_set',
    ]);

    await undo(derived);
    expect(documentOf(outcome.ref)?.['progress']).toEqual({ mode: 'manual', percentage: 40 });
  });

  it('refuses an unchanged, invalid, or archived progress change without writing', async () => {
    const outcome = seed.outcome({ progress: { mode: 'manual', percentage: 25 } });
    const archived = seed.outcome({ stateBeforeArchive: 'active', ...archivedFields });
    const before = snapshot();
    expect(
      domainError(
        await commands.setOutcomeProgress(rev('outcome', outcome), {
          mode: 'manual',
          percentage: 25,
        }),
      ),
    ).toMatchObject({ details: { reason: 'no_change' } });
    for (const percentage of [-1, 101, 40.5, Number.NaN]) {
      expect(
        domainError(
          await commands.setOutcomeProgress(rev('outcome', outcome), {
            mode: 'manual',
            percentage,
          }),
        ),
      ).toMatchObject({
        code: 'invalid_value',
        message: 'Enter a whole number from 0 to 100.',
        details: { reason: 'progress_percentage' },
      });
    }
    expect(
      domainError(
        await commands.setOutcomeProgress(rev('outcome', outcome), { mode: 'score' } as never),
      ),
    ).toMatchObject({ details: { reason: 'progress_mode' } });
    expect(
      domainError(await commands.setOutcomeProgress(rev('outcome', archived), { mode: 'none' })),
    ).toMatchObject({ message: 'Restore this Outcome before changing its progress.' });
    expectNothingWritten(before);
  });
});

/* ───────────────────────── Transitions ───────────────────────── */

const outcomeMoves: Readonly<Record<string, readonly string[]>> = {
  active: ['paused', 'achieved', 'abandoned'],
  paused: ['active', 'achieved', 'abandoned'],
  achieved: ['active'],
  abandoned: ['active'],
};
const projectMoves: Readonly<Record<string, readonly string[]>> = {
  idea: ['active', 'paused'],
  active: ['blocked', 'paused', 'completed'],
  blocked: ['active', 'paused', 'completed'],
  paused: ['active', 'completed'],
  completed: ['active'],
};
const milestoneMoves: Readonly<Record<string, readonly string[]>> = {
  active: ['completed', 'canceled'],
  completed: ['active'],
  canceled: ['active'],
};

describe('transitionOutcome', () => {
  it('allows exactly the state-machine pairs and writes nothing for the rest', async () => {
    for (const [from, allowed] of Object.entries(outcomeMoves)) {
      for (const to of Object.keys(outcomeMoves)) {
        const outcome = seed.outcome({ state: from as OutcomeState });
        const before = snapshot();
        const result = await commands.transitionOutcome(
          rev('outcome', outcome),
          to as Exclude<OutcomeState, 'archived'>,
        );
        if (allowed.includes(to)) {
          receiptOf(result);
          expect(documentOf(outcome.ref), `${from} → ${to}`).toEqual({
            ...outcome.document,
            state: to,
          });
        } else {
          expect(domainError(result), `${from} → ${to}`).toMatchObject({
            code: 'invalid_transition',
          });
          expectNothingWritten(before);
        }
      }
    }
  });

  it('records one minimized event and undoes to the prior state', async () => {
    const outcome = seed.outcome({ title: 'Private outcome' });
    const receipt = receiptOf(
      await commands.transitionOutcome(rev('outcome', outcome), 'abandoned'),
    );
    expect(events()).toEqual([
      { type: 'outcome.transitioned', id: outcome.ref.id, payload: { operation: 'update' } },
    ]);
    expect(eventText()).not.toContain('Private');
    await undo(receipt);
    expect(documentOf(outcome.ref)).toEqual(outcome.document);
  });

  it('leaves archiving and restoring to their own commands', async () => {
    const outcome = seed.outcome();
    const archived = seed.outcome({ stateBeforeArchive: 'paused', ...archivedFields });
    const before = snapshot();
    expect(
      domainError(await commands.transitionOutcome(rev('outcome', outcome), 'archived' as never)),
    ).toMatchObject({ code: 'invalid_transition', details: { reason: 'archive_command' } });
    expect(
      domainError(await commands.transitionOutcome(rev('outcome', archived), 'active')),
    ).toMatchObject({
      code: 'invalid_transition',
      message: 'Restore this Outcome before changing its state.',
      details: { reason: 'restore_first' },
    });
    expectNothingWritten(before);
  });

  it('returns the original receipt for a repeated command id', async () => {
    const outcome = seed.outcome();
    const first = receiptOf(
      await commands.transitionOutcome(rev('outcome', outcome), 'paused', commandId),
    );
    const second = receiptOf(
      await commands.transitionOutcome(rev('outcome', outcome, 1), 'paused', commandId),
    );
    expect(second).toEqual(first);
    expect(stored(outcome.ref)?.localRevision).toBe(2);
  });
});

describe('transitionProject', () => {
  it('allows exactly the state-machine pairs when a desired result exists', async () => {
    for (const [from, allowed] of Object.entries(projectMoves)) {
      for (const to of Object.keys(projectMoves).filter((state) => state !== 'idea')) {
        const project = seed.project({ state: from as ProjectState, desiredResult: 'Live site' });
        const before = snapshot();
        const result = await commands.transitionProject(
          rev('project', project),
          to as Exclude<ProjectState, 'archived' | 'idea'>,
        );
        if (allowed.includes(to)) {
          receiptOf(result);
          expect(documentOf(project.ref), `${from} → ${to}`).toEqual({
            ...project.document,
            state: to,
          });
        } else {
          expect(domainError(result), `${from} → ${to}`).toMatchObject({
            code: 'invalid_transition',
          });
          expectNothingWritten(before);
        }
      }
    }
  });

  it('never returns a Project to idea and needs a desired result to leave idea', async () => {
    const active = seed.project({ state: 'active', desiredResult: 'Live site' });
    const idea = seed.project({ state: 'idea' });
    const before = snapshot();
    expect(
      domainError(await commands.transitionProject(rev('project', active), 'idea' as never)),
    ).toMatchObject({ code: 'invalid_transition' });
    expect(domainError(await commands.transitionProject(rev('project', idea), 'active'))).toEqual({
      code: 'invalid_transition',
      message: 'Add a desired result before activating this Project.',
      details: {
        entityType: 'project',
        from: 'idea',
        to: 'active',
        reason: 'desired_result_required',
      },
    });
    expect(
      domainError(await commands.transitionProject(rev('project', idea), 'paused')),
    ).toMatchObject({ details: { reason: 'desired_result_required' } });
    expectNothingWritten(before);
  });

  it('undoes a completion without touching the Project Actions', async () => {
    const project = seed.project({ state: 'active', desiredResult: 'Live site' });
    const action = seed.action({ projectId: project.ref.id });
    const receipt = receiptOf(
      await commands.transitionProject(rev('project', project), 'completed'),
    );
    expect(stored(action.ref)).toEqual(action);
    expect(events()).toEqual([
      { type: 'project.transitioned', id: project.ref.id, payload: { operation: 'update' } },
    ]);
    await undo(receipt);
    expect(documentOf(project.ref)).toEqual(project.document);
  });
});

describe('transitionMilestone', () => {
  it('allows exactly the state-machine pairs and writes nothing for the rest', async () => {
    const outcome = seed.outcome();
    for (const [from, allowed] of Object.entries(milestoneMoves)) {
      for (const to of Object.keys(milestoneMoves)) {
        const milestone = seed.milestone(outcome.ref.id, { state: from as MilestoneState });
        const before = snapshot();
        const result = await commands.transitionMilestone(
          rev('milestone', milestone),
          to as Exclude<MilestoneState, 'archived'>,
        );
        if (allowed.includes(to)) {
          receiptOf(result);
          expect(documentOf(milestone.ref), `${from} → ${to}`).toEqual({
            ...milestone.document,
            state: to,
          });
        } else {
          expect(domainError(result), `${from} → ${to}`).toMatchObject({
            code: 'invalid_transition',
          });
          expectNothingWritten(before);
        }
      }
    }
    expect(stored(outcome.ref)).toEqual(outcome);
  });

  it('records a minimized event and undoes a completion', async () => {
    const outcome = seed.outcome();
    const milestone = seed.milestone(outcome.ref.id, { title: 'Private milestone' });
    const receipt = receiptOf(
      await commands.transitionMilestone(rev('milestone', milestone), 'completed'),
    );
    expect(events()).toEqual([
      { type: 'milestone.transitioned', id: milestone.ref.id, payload: { operation: 'update' } },
    ]);
    expect(eventText()).not.toContain('Private');
    await undo(receipt);
    expect(documentOf(milestone.ref)).toEqual(milestone.document);
  });
});

/* ───────────────────────── Projects ───────────────────────── */

describe('createProject', () => {
  it('creates an idea by default, appended to its Axis, with optional text and links', async () => {
    const axis = seed.axis();
    const outcome = seed.outcome({ axisId: axis.ref.id, state: 'achieved' });
    seed.project({ axisId: axis.ref.id, orderKey: '000007000000000' });
    seed.project({ orderKey: '000009000000000' });

    const receipt = receiptOf(
      await commands.createProject({
        title: ' Private project ',
        description: ' Private description ',
        notes: ' Private notes ',
        axisId: axis.ref.id,
        primaryOutcomeId: outcome.ref.id,
        targetStart: '2026-10-01',
      }),
    );

    const ref = createdRef(receipt);
    expect(documentOf(ref)).toEqual({
      title: 'Private project',
      description: 'Private description',
      notes: 'Private notes',
      axisId: axis.ref.id,
      primaryOutcomeId: outcome.ref.id,
      targetStart: '2026-10-01',
      orderKey: '000008000000000',
      state: 'idea',
    });
    expect(events()).toEqual([
      { type: 'project.created', id: ref.id, payload: { operation: 'create' } },
    ]);
    expect(eventText()).not.toContain('Private');
    expect(stored(outcome.ref)).toEqual(outcome);

    await undo(receipt);
    expect(documentOf(ref)).toMatchObject({ state: 'archived', stateBeforeArchive: 'idea' });
  });

  it('creates an active Project only with a desired result', async () => {
    const before = snapshot();
    expect(
      domainError(await commands.createProject({ title: 'Launch', state: 'active' })),
    ).toMatchObject({
      code: 'invalid_transition',
      message: 'Add a desired result before activating this Project.',
    });
    expect(
      domainError(await commands.createProject({ title: 'Launch', state: 'paused' } as never)),
    ).toMatchObject({ code: 'invalid_value', details: { reason: 'project_state' } });
    expectNothingWritten(before);

    const receipt = receiptOf(
      await commands.createProject({
        title: 'Launch',
        desiredResult: 'Live site',
        state: 'active',
      }),
    );
    expect(documentOf(createdRef(receipt))).toEqual({
      title: 'Launch',
      desiredResult: 'Live site',
      orderKey: '000001000000000',
      state: 'active',
    });
  });

  it('refuses archived or missing parents without writing', async () => {
    const archivedAxis = seed.axis({ stateBeforeArchive: 'active', ...archivedFields });
    const archivedOutcome = seed.outcome({ stateBeforeArchive: 'active', ...archivedFields });
    const before = snapshot();
    expect(
      domainError(await commands.createProject({ title: 'Launch', axisId: archivedAxis.ref.id })),
    ).toMatchObject({
      code: 'archived_endpoint',
      message: 'Restore this Axis before adding a Project to it.',
    });
    expect(
      domainError(
        await commands.createProject({ title: 'Launch', primaryOutcomeId: archivedOutcome.ref.id }),
      ),
    ).toMatchObject({
      code: 'archived_endpoint',
      message: 'Restore this Outcome before adding a Project to it.',
    });
    expect(
      rejection(await commands.createProject({ title: 'Launch', primaryOutcomeId: unknownId })),
    ).toEqual({ code: 'entity_not_found', ref: { type: 'outcome', id: unknownId, ownerId } });
    expectNothingWritten(before);
  });

  const invalidProjects: readonly (readonly [ProjectInput, string])[] = [
    [{ title: 'x'.repeat(201) }, 'title_too_long'],
    [{ title: 'Launch', description: 'x'.repeat(2001) }, 'text_too_long'],
    [{ title: 'Launch', desiredResult: 'x'.repeat(2001) }, 'text_too_long'],
    [{ title: 'Launch', notes: 'x'.repeat(10_001) }, 'text_too_long'],
    [{ title: 'Launch', targetStart: '2026-10-02', targetEnd: '2026-10-01' }, 'target_window'],
  ];
  it.each(invalidProjects)('rejects invalid input without writing (%#)', async (input, reason) => {
    const before = snapshot();
    expect(domainError(await commands.createProject(input))).toMatchObject({
      code: 'invalid_value',
      details: { reason },
    });
    expectNothingWritten(before);
  });

  it('accepts notes up to 10,000 characters', async () => {
    const receipt = receiptOf(
      await commands.createProject({ title: 'Launch', notes: 'x'.repeat(10_000) }),
    );
    expect(documentOf(createdRef(receipt))?.['notes']).toHaveLength(10_000);
  });
});

describe('editProject', () => {
  it('edits text and target window and keeps links, order, and state', async () => {
    const axis = seed.axis();
    const outcome = seed.outcome();
    const project = seed.project({
      axisId: axis.ref.id,
      primaryOutcomeId: outcome.ref.id,
      state: 'blocked',
      desiredResult: 'Old result',
      notes: 'Old notes',
    });

    const receipt = receiptOf(
      await commands.editProject(rev('project', project), {
        title: 'Private title',
        desiredResult: 'Private result',
        description: 'Private description',
        targetStart: '2026-10-01',
        targetEnd: '2026-10-31',
      }),
    );

    expect(documentOf(project.ref)).toEqual({
      title: 'Private title',
      desiredResult: 'Private result',
      description: 'Private description',
      axisId: axis.ref.id,
      primaryOutcomeId: outcome.ref.id,
      targetStart: '2026-10-01',
      targetEnd: '2026-10-31',
      orderKey: project.document['orderKey'],
      state: 'blocked',
    });
    expect(events()).toEqual([
      { type: 'project.edited', id: project.ref.id, payload: { operation: 'update' } },
    ]);
    expect(eventText()).not.toContain('Private');
    await undo(receipt);
    expect(documentOf(project.ref)).toEqual(project.document);
  });

  it('keeps the desired result of a Project that is not an idea', async () => {
    const active = seed.project({ state: 'active', desiredResult: 'Live site' });
    const idea = seed.project({ state: 'idea', desiredResult: 'Maybe' });
    const archived = seed.project({
      desiredResult: 'Live site',
      stateBeforeArchive: 'active',
      ...archivedFields,
    });
    const before = snapshot();
    expect(
      domainError(await commands.editProject(rev('project', active), { title: 'Launch' })),
    ).toEqual({
      code: 'invalid_value',
      message: 'Add a desired result. Only a Project that is still an idea can go without one.',
      details: { reason: 'text_required', field: 'desiredResult' },
    });
    expect(
      domainError(
        await commands.editProject(rev('project', archived), {
          title: 'Launch',
          desiredResult: 'Live site',
        }),
      ),
    ).toMatchObject({ message: 'Restore this Project before editing it.' });
    expectNothingWritten(before);

    receiptOf(await commands.editProject(rev('project', idea), { title: 'Launch site' }));
    expect(documentOf(idea.ref)).toEqual({
      title: 'Launch site',
      orderKey: idea.document['orderKey'],
      state: 'idea',
    });
  });
});

/* ───────────────────────── Milestones ───────────────────────── */

describe('createMilestone', () => {
  it('appends an active Milestone to its Outcome, including a finished one', async () => {
    const outcome = seed.outcome({ state: 'achieved' });
    const other = seed.outcome();
    seed.milestone(outcome.ref.id, { orderKey: '000005000000000' });
    seed.milestone(other.ref.id, { orderKey: '000009000000000' });

    const receipt = receiptOf(
      await commands.createMilestone({
        outcomeId: outcome.ref.id,
        title: ' Private milestone ',
        measurableCheckpoint: ' Private checkpoint ',
        targetEnd: '2026-11-15',
      }),
    );

    const ref = createdRef(receipt);
    expect(documentOf(ref)).toEqual({
      title: 'Private milestone',
      measurableCheckpoint: 'Private checkpoint',
      outcomeId: outcome.ref.id,
      targetEnd: '2026-11-15',
      orderKey: '000006000000000',
      state: 'active',
    });
    expect(stored(outcome.ref)).toEqual(outcome);
    expect(events()).toEqual([
      { type: 'milestone.created', id: ref.id, payload: { operation: 'create' } },
    ]);
    expect(eventText()).not.toContain('Private');
    await undo(receipt);
    expect(documentOf(ref)).toMatchObject({ state: 'archived', stateBeforeArchive: 'active' });
  });

  it('needs an available Outcome and valid details', async () => {
    const archived = seed.outcome({ stateBeforeArchive: 'active', ...archivedFields });
    const outcome = seed.outcome();
    const before = snapshot();
    const input = { title: 'First 5k', measurableCheckpoint: 'Run 5k' };
    expect(
      domainError(await commands.createMilestone({ ...input, outcomeId: archived.ref.id })),
    ).toMatchObject({
      code: 'archived_endpoint',
      message: 'Restore this Outcome before adding a Milestone to it.',
    });
    expect(rejection(await commands.createMilestone({ ...input, outcomeId: unknownId }))).toEqual({
      code: 'entity_not_found',
      ref: { type: 'outcome', id: unknownId, ownerId },
    });
    expect(domainError(await commands.createMilestone({ ...input, outcomeId: ' ' }))).toEqual({
      code: 'invalid_value',
      message: 'Choose the Outcome this Milestone belongs to.',
      details: { reason: 'outcome_required', field: 'outcomeId' },
    });
    expect(
      domainError(
        await commands.createMilestone({
          outcomeId: outcome.ref.id,
          title: 'First 5k',
          measurableCheckpoint: '',
        }),
      ),
    ).toMatchObject({ details: { reason: 'text_required', field: 'measurableCheckpoint' } });
    expect(
      domainError(
        await commands.createMilestone({
          ...input,
          outcomeId: outcome.ref.id,
          title: 'x'.repeat(201),
        }),
      ),
    ).toMatchObject({ details: { reason: 'title_too_long' } });
    expectNothingWritten(before);
  });
});

describe('editMilestone', () => {
  it('moves the target window of a completed Milestone without reopening it', async () => {
    const outcome = seed.outcome();
    const milestone = seed.milestone(outcome.ref.id, { state: 'completed' });

    const receipt = receiptOf(
      await commands.editMilestone(rev('milestone', milestone), {
        title: 'Private title',
        measurableCheckpoint: 'Private checkpoint',
        targetStart: '2026-11-01',
        targetEnd: '2026-11-30',
      }),
    );

    expect(documentOf(milestone.ref)).toEqual({
      title: 'Private title',
      measurableCheckpoint: 'Private checkpoint',
      outcomeId: outcome.ref.id,
      targetStart: '2026-11-01',
      targetEnd: '2026-11-30',
      orderKey: milestone.document['orderKey'],
      state: 'completed',
    });
    expect(events()).toEqual([
      { type: 'milestone.edited', id: milestone.ref.id, payload: { operation: 'update' } },
    ]);
    expect(eventText()).not.toContain('Private');
    await undo(receipt);
    expect(documentOf(milestone.ref)).toEqual(milestone.document);
  });

  it('keeps an archived Milestone read-only', async () => {
    const outcome = seed.outcome();
    const milestone = seed.milestone(outcome.ref.id, {
      stateBeforeArchive: 'active',
      ...archivedFields,
    });
    const before = snapshot();
    expect(
      domainError(
        await commands.editMilestone(rev('milestone', milestone), {
          title: 'New',
          measurableCheckpoint: 'Run',
        }),
      ),
    ).toMatchObject({ message: 'Restore this Milestone before editing it.' });
    expectNothingWritten(before);
  });
});

/* ───────────────────────── Reorder ───────────────────────── */

describe('reorder', () => {
  const axes: ReorderScope = { container: 'axes' };

  it('swaps an Axis with its neighbor, records reordered events, and undoes', async () => {
    const first = seed.axis({ title: 'Private first' });
    const second = seed.axis();
    const third = seed.axis();

    const receipt = receiptOf(
      await commands.reorder({ target: rev('axis', second), direction: 'up', scope: axes }),
    );

    expect(orderKeyOf(second)).toBe(first.document['orderKey']);
    expect(orderKeyOf(first)).toBe(second.document['orderKey']);
    expect(stored(third.ref)).toEqual(third);
    expect(events()).toEqual([
      { type: 'axis.reordered', id: first.ref.id, payload: { operation: 'update' } },
      { type: 'axis.reordered', id: second.ref.id, payload: { operation: 'update' } },
    ]);
    expect(eventText()).not.toContain('Private');

    await undo(receipt);
    expect(stored(first.ref)?.document).toEqual(first.document);
    expect(stored(second.ref)?.document).toEqual(second.document);
  });

  it('normalizes onboarding keys and the container in the same command', async () => {
    const health = seed.axis({ orderKey: 'onboarding-01' });
    const work = seed.axis({ orderKey: 'onboarding-02' });
    const learning = seed.axis({ orderKey: 'onboarding-03' });

    receiptOf(
      await commands.reorder({ target: rev('axis', learning), direction: 'up', scope: axes }),
    );

    expect([orderKeyOf(health), orderKeyOf(learning), orderKeyOf(work)]).toEqual([
      '000001000000000',
      '000002000000000',
      '000003000000000',
    ]);
    expect(events().map(({ type }) => type)).toEqual([
      'axis.reordered',
      'axis.reordered',
      'axis.reordered',
    ]);
  });

  it('breaks tied keys by id before moving', async () => {
    const lower = seed.axis({ orderKey: '500000000000000' });
    const higher = seed.axis({ orderKey: '500000000000000' });
    expect(lower.ref.id < higher.ref.id).toBe(true);

    receiptOf(
      await commands.reorder({ target: rev('axis', higher), direction: 'up', scope: axes }),
    );

    expect(orderKeyOf(higher)).toBe('000001000000000');
    expect(orderKeyOf(lower)).toBe('000002000000000');
  });

  it('refuses a move past either edge without writing', async () => {
    const first = seed.axis();
    const last = seed.axis();
    const before = snapshot();
    expect(
      domainError(
        await commands.reorder({ target: rev('axis', first), direction: 'up', scope: axes }),
      ),
    ).toEqual({
      code: 'invalid_value',
      message: 'It is already first in this list.',
      details: { reason: 'order_edge' },
    });
    expect(
      domainError(
        await commands.reorder({ target: rev('axis', last), direction: 'down', scope: axes }),
      ),
    ).toMatchObject({ message: 'It is already last in this list.' });
    expectNothingWritten(before);
  });

  it('skips archived rows and refuses to move an archived item', async () => {
    const first = seed.axis();
    const archived = seed.axis({ stateBeforeArchive: 'active', ...archivedFields });
    const third = seed.axis();

    receiptOf(await commands.reorder({ target: rev('axis', third), direction: 'up', scope: axes }));
    expect(orderKeyOf(third)).toBe(first.document['orderKey']);
    expect(orderKeyOf(first)).toBe(third.document['orderKey']);
    expect(stored(archived.ref)).toEqual(archived);

    const before = snapshot();
    expect(
      domainError(
        await commands.reorder({ target: rev('axis', archived), direction: 'up', scope: axes }),
      ),
    ).toEqual({
      code: 'invalid_value',
      message: 'This item is no longer in that list. Refresh it and try again.',
      details: { reason: 'order_target' },
    });
    expectNothingWritten(before);
  });

  it('moves Outcomes within their visible section of an Axis', async () => {
    const axis = seed.axis();
    const active = seed.outcome({ axisId: axis.ref.id, state: 'active' });
    const achieved = seed.outcome({ axisId: axis.ref.id, state: 'achieved' });
    const paused = seed.outcome({ axisId: axis.ref.id, state: 'paused' });
    const scope: ReorderScope = { container: 'axis_outcomes', axisId: axis.ref.id };

    receiptOf(await commands.reorder({ target: rev('outcome', paused), direction: 'up', scope }));
    expect(orderKeyOf(paused)).toBe(active.document['orderKey']);
    expect(orderKeyOf(active)).toBe(paused.document['orderKey']);
    expect(stored(achieved.ref)).toEqual(achieved);
    expect(events().map(({ type }) => type)).toEqual(['outcome.reordered', 'outcome.reordered']);

    const before = snapshot();
    expect(
      domainError(
        await commands.reorder({ target: rev('outcome', achieved), direction: 'up', scope }),
      ),
    ).toMatchObject({ details: { reason: 'order_edge' } });
    expectNothingWritten(before);
  });

  it('moves finished Projects among themselves and keeps "Not in an Axis" separate', async () => {
    const axis = seed.axis();
    const inAxis = seed.project({ axisId: axis.ref.id, state: 'completed', desiredResult: 'A' });
    const completed = seed.project({ state: 'completed', desiredResult: 'B' });
    const idea = seed.project({ state: 'idea' });
    const done = seed.project({ state: 'completed', desiredResult: 'C' });
    const scope: ReorderScope = { container: 'axis_projects', axisId: null };

    receiptOf(await commands.reorder({ target: rev('project', done), direction: 'up', scope }));

    expect(orderKeyOf(done)).toBe(completed.document['orderKey']);
    expect(orderKeyOf(completed)).toBe(done.document['orderKey']);
    expect(stored(idea.ref)).toEqual(idea);
    expect(stored(inAxis.ref)).toEqual(inAxis);
    expect(events().map(({ type }) => type)).toEqual(['project.reordered', 'project.reordered']);
  });

  it('reorders the Milestones of one Outcome', async () => {
    const outcome = seed.outcome();
    const other = seed.outcome();
    const first = seed.milestone(outcome.ref.id);
    const foreign = seed.milestone(other.ref.id);
    const second = seed.milestone(outcome.ref.id, { state: 'canceled' });
    const scope: ReorderScope = { container: 'outcome_milestones', outcomeId: outcome.ref.id };

    receiptOf(
      await commands.reorder({ target: rev('milestone', first), direction: 'down', scope }),
    );

    expect(orderKeyOf(first)).toBe(second.document['orderKey']);
    expect(orderKeyOf(second)).toBe(first.document['orderKey']);
    expect(stored(foreign.ref)).toEqual(foreign);
    expect(events().map(({ type }) => type)).toEqual([
      'milestone.reordered',
      'milestone.reordered',
    ]);
  });

  it('reorders the Actions of one Project by their own order keys only', async () => {
    const project = seed.project({ state: 'active', desiredResult: 'Live site' });
    const first = seed.action({ projectId: project.ref.id, orderKey: '499999999999998' });
    const outside = seed.action({ orderKey: '499999999999999' });
    const second = seed.action({
      projectId: project.ref.id,
      orderKey: '500000000000000',
      state: 'completed',
      title: 'Private action',
    });
    const scope: ReorderScope = { container: 'project_actions', projectId: project.ref.id };

    const receipt = receiptOf(
      await commands.reorder({ target: rev('action', second), direction: 'up', scope }),
    );

    expect(documentOf(second.ref)).toEqual({ ...second.document, orderKey: '499999999999998' });
    expect(documentOf(first.ref)).toEqual({ ...first.document, orderKey: '500000000000000' });
    expect(stored(outside.ref)).toEqual(outside);
    expect(stored(project.ref)).toEqual(project);
    expect(events().map(({ type }) => type)).toEqual(['action.reordered', 'action.reordered']);
    expect(eventText()).not.toContain('Private');

    await undo(receipt);
    expect(stored(first.ref)?.document).toEqual(first.document);
    expect(stored(second.ref)?.document).toEqual(second.document);
  });

  it('breaks tied Project Action keys in place so no Action jumps in the Inbox or Backlog', async () => {
    const project = seed.project({ state: 'active', desiredResult: 'Live site' });
    const first = seed.action({ projectId: project.ref.id, orderKey: '500000000000000' });
    const second = seed.action({ projectId: project.ref.id, orderKey: '500000000000000' });
    const scope: ReorderScope = { container: 'project_actions', projectId: project.ref.id };
    const [earlier, later] = [first, second].sort((left, right) =>
      left.ref.id < right.ref.id ? -1 : 1,
    );

    receiptOf(await commands.reorder({ target: rev('action', later!), direction: 'up', scope }));

    const keys = [first, second].map((action) =>
      Number((documentOf(action.ref) as { orderKey: string }).orderKey),
    );
    for (const key of keys) {
      expect(key).toBeGreaterThanOrEqual(500000000000000);
      expect(key).toBeLessThan(500000000000010);
    }
    expect(Number((documentOf(later!.ref) as { orderKey: string }).orderKey)).toBeLessThan(
      Number((documentOf(earlier!.ref) as { orderKey: string }).orderKey),
    );
  });

  it('refuses a mismatched, foreign, stale, or malformed move without writing', async () => {
    const axis = seed.axis();
    const other = seed.axis();
    const outcome = seed.outcome({ axisId: axis.ref.id });
    seed.outcome({ axisId: axis.ref.id });
    const before = snapshot();

    expect(
      domainError(
        await commands.reorder({ target: rev('outcome', outcome), direction: 'down', scope: axes }),
      ),
    ).toEqual({
      code: 'invalid_value',
      message: 'This item cannot be moved in that list.',
      details: { reason: 'order_scope' },
    });
    expect(
      domainError(
        await commands.reorder({
          target: rev('outcome', outcome),
          direction: 'down',
          scope: { container: 'axis_outcomes', axisId: other.ref.id },
        }),
      ),
    ).toMatchObject({ details: { reason: 'order_target' } });
    expect(
      rejection(
        await commands.reorder({
          target: rev('outcome', outcome, 7),
          direction: 'down',
          scope: { container: 'axis_outcomes', axisId: axis.ref.id },
        }),
      ),
    ).toMatchObject({ code: 'revision_conflict', expectedRevision: 7, actualRevision: 1 });
    expect(
      domainError(
        await commands.reorder({
          target: rev('outcome', outcome),
          direction: 'down',
          scope: { container: 'axis_outcomes', axisId: 'nope' },
        }),
      ),
    ).toMatchObject({ code: 'invalid_uuid', details: { field: 'axisId' } });
    expect(
      domainError(
        await commands.reorder({
          target: rev('outcome', outcome),
          direction: 'sideways' as never,
          scope: { container: 'axis_outcomes', axisId: axis.ref.id },
        }),
      ),
    ).toMatchObject({ details: { reason: 'direction' } });
    expect(
      rejection(
        await commands.reorder({
          target: { kind: 'outcome', id: unknownId, revision: 1 },
          direction: 'up',
          scope: { container: 'axis_outcomes', axisId: axis.ref.id },
        }),
      ),
    ).toEqual({ code: 'entity_not_found', ref: { type: 'outcome', id: unknownId, ownerId } });
    expectNothingWritten(before);
  });

  it('returns the original receipt when a move is repeated with its command id', async () => {
    const first = seed.axis();
    const second = seed.axis();
    const move = () =>
      commands.reorder({ target: rev('axis', second, 1), direction: 'up', scope: axes }, commandId);
    const receipt = receiptOf(await move());
    expect(receiptOf(await move())).toEqual(receipt);
    expect(orderKeyOf(second)).toBe(first.document['orderKey']);
    expect(harness.unitOfWork.state.events).toHaveLength(2);
  });
});
