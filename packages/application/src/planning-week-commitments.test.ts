import {
  entityRefKey,
  type CommandContext,
  type CommandId,
  type DomainResult,
  type Instant,
  type UUID,
  type WeekPeriod,
} from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import type { CanonicalRecordState } from './contracts';
import { createPlanningApplication } from './planning';
import type { FocusSelectionDocument } from './planning-contracts';
import { createTestPlanningQueries } from './planning-routines-test-queries';
import {
  appendWeekCommitmentKey,
  planWeekCommitmentMutations,
  removeWeekCommitmentMutation,
  weekCommitmentEventTypes,
  type WeekCommitmentPlan,
  type WeekCommitmentTarget,
} from './planning-week-commitments';
import type { PlanningRecordReader } from './ports';
import { createReviewFixture, reviewOwnerId, reviewProfile } from './testing/review-fixtures';

const now = '2026-09-30T13:00:00.000Z' as Instant;
const week: WeekPeriod = {
  kind: 'week',
  start: '2026-09-28',
  end: '2026-10-04',
  weekStart: 'monday',
} as WeekPeriod;
const context: CommandContext = {
  ownerId: reviewOwnerId,
  actor: 'user',
  commandId: 'c0000000-0000-4000-8000-000000000001' as CommandId,
  now,
};

function setup() {
  const f = createReviewFixture();
  const reader: PlanningRecordReader = {
    read: (ref) => Promise.resolve(f.harness.unitOfWork.get(entityRefKey(ref)) ?? null),
  };
  const commit = (
    target: FocusSelectionDocument['target'],
    orderKey: string,
  ): CanonicalRecordState => f.seed.commitment(target, week, orderKey);
  let sequence = 0;
  const nextId = (): UUID => {
    sequence += 1;
    return `d0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}` as UUID;
  };
  const plan = (
    existing: readonly CanonicalRecordState[],
    desired: readonly WeekCommitmentTarget[],
    options: { readonly keepKeys?: boolean } = {},
  ): Promise<DomainResult<WeekCommitmentPlan>> =>
    planWeekCommitmentMutations(
      reader,
      {
        ownerId: reviewOwnerId,
        profileId: reviewProfile.profileId,
        week,
        existing,
        desired,
        ...options,
      },
      nextId,
      context,
    );
  return { f, commit, plan };
}

const value = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const reason = (result: DomainResult<unknown>): unknown =>
  result.ok ? 'ok' : (result.error.details?.['reason'] ?? result.error.code);

/** Each mutation as [event type, target id or record id, order key, archived]. */
const describePlan = (plan: WeekCommitmentPlan) =>
  plan.mutations.map((mutation) => {
    const document = (
      mutation.operation === 'delete' ? {} : mutation.document
    ) as Partial<FocusSelectionDocument>;
    const target = document.target;
    const id =
      target?.kind === 'action'
        ? target.actionId
        : target?.kind === 'project'
          ? target.projectId
          : target?.kind === 'milestone'
            ? target.milestoneId
            : mutation.ref.id;
    return [plan.eventTypeFor(mutation), id, document.orderKey, document.archivedAt !== undefined];
  });

describe('Week-commitment rules', () => {
  it('appends after the highest 15-digit key, ignoring other keys', () => {
    expect(appendWeekCommitmentKey([])).toBe('000000000000001');
    expect(appendWeekCommitmentKey(['000000000000002', 'onboarding-01', '000000000000007'])).toBe(
      '000000000000008',
    );
  });

  it('removes only an active Week commitment', () => {
    const { f, commit } = setup();
    const project = f.seed.project();
    const selection = commit({ kind: 'project', projectId: project.ref.id }, '000000000000001');
    expect(value(removeWeekCommitmentMutation(selection, now))).toMatchObject({
      operation: 'update',
      document: { archivedAt: now },
    });
    const removed = { ...selection, document: { ...selection.document, archivedAt: now } };
    expect(reason(removeWeekCommitmentMutation(removed, now))).toBe('already_removed');
    const focus = f.plan.focus({ kind: 'action', actionId: f.plan.action().ref.id }, '2026-09-30');
    expect(reason(removeWeekCommitmentMutation(focus, now))).toBe('not_week_commitment');
  });
});

describe('planWeekCommitmentMutations', () => {
  it('changes nothing for the same list, and appends new targets with the next keys', async () => {
    const { f, commit, plan } = setup();
    const project = f.seed.project();
    const action = f.plan.action();
    const milestone = f.seed.milestone(f.seed.outcome().ref.id);
    const current = commit({ kind: 'project', projectId: project.ref.id }, '000000000000004');
    const kept: WeekCommitmentTarget = { kind: 'project', id: project.ref.id };
    expect(value(await plan([current], [kept])).mutations).toEqual([]);
    const appended = value(
      await plan(
        [current],
        [kept, { kind: 'action', id: action.ref.id }, { kind: 'milestone', id: milestone.ref.id }],
      ),
    );
    expect(describePlan(appended)).toEqual([
      [weekCommitmentEventTypes.added, action.ref.id, '000000000000005', false],
      [weekCommitmentEventTypes.added, milestone.ref.id, '000000000000006', false],
    ]);
    expect(appended.created.map((record) => record.kind)).toEqual([
      'focus_selection',
      'focus_selection',
    ]);
    expect(appended.mutations[0]).toMatchObject({
      operation: 'create',
      document: {
        kind: 'week_commitment',
        profileId: reviewProfile.profileId,
        periodStart: '2026-09-28',
        periodEnd: '2026-10-04',
        weekStart: 'monday',
      },
    });
  });

  it('replaces the list: removed first, then reordered, then added, in the chosen order', async () => {
    const { f, commit, plan } = setup();
    const [first, second, third] = [f.seed.project(), f.seed.project(), f.seed.project()];
    const action = f.plan.action();
    if (first === undefined || second === undefined || third === undefined) throw new Error();
    const rows = [
      commit({ kind: 'project', projectId: first.ref.id }, '000000000000001'),
      commit({ kind: 'project', projectId: second.ref.id }, '000000000000002'),
      commit({ kind: 'project', projectId: third.ref.id }, '000000000000003'),
    ];
    const replaced = value(
      await plan(rows, [
        { kind: 'project', id: third.ref.id },
        { kind: 'action', id: action.ref.id },
        { kind: 'project', id: first.ref.id },
      ]),
    );
    // A reordered list writes the chosen list's keys in order.
    expect(describePlan(replaced)).toEqual([
      [weekCommitmentEventTypes.removed, second.ref.id, '000000000000002', true],
      [weekCommitmentEventTypes.reordered, third.ref.id, '000000000000001', false],
      [weekCommitmentEventTypes.reordered, first.ref.id, '000000000000003', false],
      [weekCommitmentEventTypes.added, action.ref.id, '000000000000002', false],
    ]);
    expect(replaced.created).toHaveLength(1);
  });

  it('keeps the chosen order when an older key sorts after every 15-digit key', async () => {
    const { f, commit, plan } = setup();
    const project = f.seed.project();
    const action = f.plan.action();
    // Onboarding writes the starter Week commitment with the key `onboarding-01`.
    const onboarding = commit({ kind: 'project', projectId: project.ref.id }, 'onboarding-01');
    const kept: WeekCommitmentTarget = { kind: 'project', id: project.ref.id };
    const added: WeekCommitmentTarget = { kind: 'action', id: action.ref.id };
    expect(value(await plan([onboarding], [kept])).mutations).toEqual([]);
    // The next 15-digit key would sort before `onboarding-01`, so every key is written in order.
    expect(describePlan(value(await plan([onboarding], [kept, added])))).toEqual([
      [weekCommitmentEventTypes.reordered, project.ref.id, '000000000000001', false],
      [weekCommitmentEventTypes.added, action.ref.id, '000000000000002', false],
    ]);
    // `addWeekCommitment` keeps every existing key and appends exactly as planning always did.
    expect(
      describePlan(value(await plan([onboarding], [kept, added], { keepKeys: true }))),
    ).toEqual([[weekCommitmentEventTypes.added, action.ref.id, '000000000000001', false]]);
    // Equal keys sort by id: the same list again still changes nothing, and appending keeps them.
    const [first, second] = [f.seed.project(), f.seed.project()];
    if (first === undefined || second === undefined) throw new Error();
    const equal = [
      commit({ kind: 'project', projectId: first.ref.id }, '000000000000003'),
      commit({ kind: 'project', projectId: second.ref.id }, '000000000000003'),
    ];
    const both: WeekCommitmentTarget[] = [
      { kind: 'project', id: first.ref.id },
      { kind: 'project', id: second.ref.id },
    ];
    expect(value(await plan(equal, both)).mutations).toEqual([]);
    expect(describePlan(value(await plan(equal, [...both, added])))).toEqual([
      [weekCommitmentEventTypes.added, action.ref.id, '000000000000004', false],
    ]);
  });

  it('lets addWeekCommitment append beside an older key without touching it', async () => {
    const f = createReviewFixture();
    const planning = createPlanningApplication(f.harness.dependencies, {
      ...createTestPlanningQueries(f.harness.unitOfWork, reviewProfile),
      listWeekSelections: f.queries.listWeekSelections,
    });
    const project = f.seed.project();
    const action = f.plan.action();
    const onboarding = f.seed.commitment(
      { kind: 'project', projectId: project.ref.id },
      week,
      'onboarding-01',
    );
    const receipt = await planning.addWeekCommitment({
      weekDate: '2026-09-30',
      target: { kind: 'action', id: action.ref.id },
    });
    expect(receipt.ok).toBe(true);
    expect(f.document(onboarding)).toEqual(onboarding.document);
    expect(
      f
        .records('focus_selection')
        .map((record) => record.document as FocusSelectionDocument)
        .filter((document) => document.target.kind === 'action')
        .map((document) => document.orderKey),
    ).toEqual(['000000000000001']);
  });

  it('refuses a duplicate, a missing or archived target, and a changed commitment', async () => {
    const { f, commit, plan } = setup();
    const project = f.seed.project();
    const archived = f.seed.project({ state: 'archived' });
    const target: WeekCommitmentTarget = { kind: 'project', id: project.ref.id };
    expect(reason(await plan([], [target, target]))).toBe('duplicate_commitment');
    expect(
      reason(
        await plan([], [{ kind: 'action', id: 'a0000000-0000-4000-8000-00000000dead' as UUID }]),
      ),
    ).toBe('target_missing');
    expect(reason(await plan([], [{ kind: 'project', id: archived.ref.id }]))).toBe(
      'archived_target',
    );
    const row = commit({ kind: 'project', projectId: project.ref.id }, '000000000000001');
    f.harness.unitOfWork.seed({
      ...row,
      localRevision: 2,
      document: { ...row.document, archivedAt: now },
    });
    expect(reason(await plan([row], []))).toBe('commitments_changed');
    const focus = f.plan.focus({ kind: 'action', actionId: f.plan.action().ref.id }, '2026-09-30');
    expect(reason(await plan([focus], []))).toBe('commitments_changed');
  });
});
