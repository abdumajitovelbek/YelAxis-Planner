import {
  createEntityRef,
  entityRefKey,
  focusTargetKey,
  ok,
  spacedOrderKey,
  type CalendarDate,
  type CommandId,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type RecurrenceRuleV1,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import type { FocusSelectionDocument, PlanProfile } from './planning-contracts';
import { createPlanningApplication } from './planning';
import { createTestPlanningQueries } from './planning-routines-test-queries';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';
import {
  createTodaySeeder,
  createTodayTestQueries,
  type TodaySeeder,
} from './testing/today-test-queries';
import type { FocusTargetInput } from './today-contracts';
import {
  focusEventTypes,
  focusSelectionKey,
  parseFocusTarget,
  planFocusMutations,
  readDayFocus,
} from './today-focus-plan';
import { createTodayKit, type TodayKit } from './today-kit';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const now = '2026-09-28T13:00:00.000Z' as Instant;
const d = (value: string) => value as CalendarDate;
const day = d('2026-09-28');
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: 'America/New_York' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
const daily: RecurrenceRuleV1 = {
  version: 1,
  kind: 'daily',
  intervalDays: 1,
  startsOn: d('2026-09-01'),
};
const dated = (date: string) => ({ kind: 'date' as const, date: d(date) });

let harness: InMemoryHarness;
let kit: TodayKit;
let seed: TodaySeeder;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  kit = createTodayKit(harness.dependencies, createTodayTestQueries(harness.unitOfWork, profile));
  seed = createTodaySeeder(harness.unitOfWork, ownerId, profile);
});

const actionTarget = (record: CanonicalRecordState): FocusTargetInput => ({
  kind: 'action',
  actionId: record.ref.id,
});
const occurrenceTarget = (
  routine: CanonicalRecordState,
  date = '2026-09-28',
  revision?: number,
): FocusTargetInput => ({
  kind: 'routine_occurrence',
  occurrence: {
    routineId: routine.ref.id,
    generation: 1,
    period: dated(date),
    ...(revision === undefined ? {} : { revision }),
  },
});

/** Replace a date's focus the way setDayFocus does: pre-read, then one planned command. */
async function setFocus(
  desired: readonly FocusTargetInput[],
  date = day,
  commandId?: CommandId,
): Promise<ApplicationResult<CommandReceipt>> {
  const current = await readDayFocus(kit, ownerId, profile.profileId, date);
  return kit.run(
    ownerId,
    commandId,
    'focus.set',
    current.expected,
    async ({ records, context }) => {
      const plan = await planFocusMutations(
        records,
        { ownerId, profileId: profile.profileId, date, existing: current.records, desired },
        kit.nextId,
        context,
      );
      if (!plan.ok) return plan;
      return ok({
        mutations: plan.value.mutations,
        created: plan.value.created,
        eventTypeFor: plan.value.eventTypeFor,
      });
    },
  );
}

const accepted = (result: ApplicationResult<CommandReceipt>): CommandReceipt => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const rejection = (result: ApplicationResult<CommandReceipt>): unknown => {
  if (result.ok) throw new Error('Expected a rejection.');
  if (result.error.code !== 'domain_rejected') return result.error.code;
  return result.error.domainError.details?.['reason'] ?? result.error.domainError.code;
};

const activeFocus = (date = day): FocusSelectionDocument[] =>
  [...harness.unitOfWork.state.records.values()]
    .filter((record) => record.ref.type === 'focus_selection')
    .map((record) => ({ record, document: record.document as FocusSelectionDocument }))
    .filter(
      ({ document }) =>
        document.kind === 'day_focus' &&
        document.periodStart === date &&
        document.archivedAt === undefined,
    )
    .sort((left, right) =>
      left.document.orderKey === right.document.orderKey
        ? left.record.ref.id.localeCompare(right.record.ref.id)
        : left.document.orderKey.localeCompare(right.document.orderKey),
    )
    .map(({ document }) => document);

const focusTargets = (date = day) =>
  activeFocus(date).map((document) => focusSelectionKey(document));

const undo = (receipt: CommandReceipt) => {
  if (!receipt.undo.available) throw new Error('No undo.');
  return createPlanningApplication(
    harness.dependencies,
    createTestPlanningQueries(harness.unitOfWork, profile),
  ).undo(receipt.undo.undoId);
};

describe('planFocusMutations', () => {
  it('adds an Action and materializes an occurrence once, occurrence row first', async () => {
    const action = seed.action({ title: 'Private plan text' });
    const walk = seed.routine(daily, { title: 'Walk' });
    const receipt = accepted(await setFocus([actionTarget(action), occurrenceTarget(walk)]));

    const types = receipt.canonical.map(({ ref }) => ref.type);
    expect(types).toEqual(['routine_occurrence', 'focus_selection', 'focus_selection']);
    const occurrenceRef = receipt.canonical[0]?.ref;
    const occurrence = harness.unitOfWork.get(entityRefKey(occurrenceRef ?? action.ref));
    expect(occurrence?.document).toEqual({
      routineId: walk.ref.id,
      generation: 1,
      periodKey: '2026-09-28',
      period: dated('2026-09-28'),
      state: 'planned',
    });
    expect(activeFocus()).toEqual([
      {
        kind: 'day_focus',
        profileId: profile.profileId,
        target: { kind: 'action', actionId: action.ref.id },
        periodStart: day,
        periodEnd: day,
        orderKey: spacedOrderKey(0),
      },
      {
        kind: 'day_focus',
        profileId: profile.profileId,
        target: { kind: 'routine_occurrence', routineOccurrenceId: occurrenceRef?.id },
        periodStart: day,
        periodEnd: day,
        orderKey: spacedOrderKey(1),
      },
    ]);
    expect(
      harness.unitOfWork.state.events.map(({ event }) => [event.eventType, event.payload]),
    ).toEqual([
      [focusEventTypes.materialized, { operation: 'create' }],
      [focusEventTypes.added, { operation: 'create' }],
      [focusEventTypes.added, { operation: 'create' }],
    ]);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private plan text');
    // The target itself never changes.
    expect(harness.unitOfWork.get(entityRefKey(action.ref))).toEqual(action);

    // Choosing the same focus again changes nothing and is not written.
    const again = await setFocus([actionTarget(action), occurrenceTarget(walk, '2026-09-28', 1)]);
    expect(rejection(again)).toBe('no_change');
    expect(harness.unitOfWork.state.events).toHaveLength(3);
  });

  it('undoes an add by archiving the selections and leaving the occurrence pristine', async () => {
    const action = seed.action();
    const walk = seed.routine(daily);
    const receipt = accepted(await setFocus([actionTarget(action), occurrenceTarget(walk)]));
    accepted(await undo(receipt));
    expect(activeFocus()).toEqual([]);
    const occurrence = harness.unitOfWork.get(
      entityRefKey(receipt.canonical[0]?.ref ?? action.ref),
    );
    expect(occurrence?.document).toMatchObject({ state: 'planned' });
    expect(harness.unitOfWork.get(entityRefKey(action.ref))).toEqual(action);
  });

  it('refuses a fourth item and a duplicate without writing', async () => {
    const first = seed.action();
    const actions = [first, seed.action(), seed.action(), seed.action()];
    expect(rejection(await setFocus(actions.map(actionTarget)))).toBe('selection_limit');
    expect(rejection(await setFocus([actionTarget(first), actionTarget(first)]))).toBe(
      'focus_duplicate',
    );
    const walk = seed.routine(daily);
    expect(rejection(await setFocus([occurrenceTarget(walk), occurrenceTarget(walk)]))).toBe(
      'focus_duplicate',
    );
    expect(harness.unitOfWork.state.events).toEqual([]);
    expect(activeFocus()).toEqual([]);
  });

  it.each([
    ['a completed Action', { state: 'completed' as const }, 'focus_target_finished'],
    ['a canceled Action', { state: 'canceled' as const }, 'focus_target_finished'],
    ['an archived Action', { state: 'archived' as const }, 'focus_target_finished'],
  ])('refuses %s as a new focus target', async (_name, overrides, reason) => {
    const action = seed.action(overrides);
    expect(rejection(await setFocus([actionTarget(action)]))).toBe(reason);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('refuses finished, moved, or off-day occurrences and an archived Routine', async () => {
    const walk = seed.routine(daily, { title: 'Walk' });
    seed.occurrence(walk.ref.id, dated('2026-09-28'), { state: 'skipped' });
    expect(rejection(await setFocus([occurrenceTarget(walk, '2026-09-28', 1)]))).toBe(
      'focus_target_finished',
    );
    const moved = seed.routine(daily, { title: 'Moved' });
    seed.occurrence(moved.ref.id, dated('2026-09-28'), { override: { date: d('2026-09-30') } });
    expect(rejection(await setFocus([occurrenceTarget(moved, '2026-09-28', 1)]))).toBe(
      'not_on_day',
    );
    const other = seed.routine(daily, { title: 'Other day' });
    expect(rejection(await setFocus([occurrenceTarget(other, '2026-09-29')]))).toBe('not_on_day');
    const archived = seed.routine(daily, { title: 'Archived', state: 'archived' });
    expect(rejection(await setFocus([occurrenceTarget(archived)]))).toBe('routine_archived');
    const unknownRevision = seed.routine(daily, { title: 'Materialized' });
    seed.occurrence(unknownRevision.ref.id, dated('2026-09-28'));
    const withoutRevision = await setFocus([occurrenceTarget(unknownRevision)]);
    expect(withoutRevision.ok).toBe(false);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('refuses an Action that no longer exists', async () => {
    const missing = createEntityRef(
      'action',
      'a0000000-0000-4000-8000-000000000001' as UUID,
      ownerId,
    );
    expect(rejection(await setFocus([{ kind: 'action', actionId: missing.id }]))).toBe(
      'target_missing',
    );
  });

  it('keeps finished and changed targets that stay chosen, and reorders them', async () => {
    const done = seed.action({ state: 'completed' });
    const open = seed.action();
    const ended = seed.routine({ ...daily, endsOn: d('2026-09-27') });
    const stale = seed.occurrence(ended.ref.id, dated('2026-09-28'));
    seed.focus({ kind: 'action', actionId: done.ref.id }, '2026-09-28', {
      orderKey: spacedOrderKey(0),
    });
    seed.focus({ kind: 'routine_occurrence', routineOccurrenceId: stale.ref.id }, '2026-09-28', {
      orderKey: spacedOrderKey(1),
    });
    seed.focus({ kind: 'action', actionId: open.ref.id }, '2026-09-28', {
      orderKey: spacedOrderKey(2),
    });
    const receipt = accepted(
      await setFocus([
        actionTarget(open),
        occurrenceTarget(ended, '2026-09-28', 1),
        actionTarget(done),
      ]),
    );
    expect(receipt.canonical.map(({ ref }) => ref.type)).toEqual([
      'focus_selection',
      'focus_selection',
    ]);
    expect(focusTargets()).toEqual([
      focusTargetKey({ kind: 'action', actionId: open.ref.id }),
      focusTargetKey({ kind: 'routine_occurrence', occurrenceId: stale.ref.id }),
      focusTargetKey({ kind: 'action', actionId: done.ref.id }),
    ]);
    expect(harness.unitOfWork.state.events.map(({ event }) => event.eventType)).toEqual([
      focusEventTypes.reordered,
      focusEventTypes.reordered,
    ]);
  });

  it('normalizes the onboarding key with an expected revision when adding', async () => {
    const onboarding = seed.action({ title: 'Onboarding Action' });
    const selection = seed.focus({ kind: 'action', actionId: onboarding.ref.id }, '2026-09-28', {
      orderKey: 'onboarding-01',
      revision: 4,
    });
    const next = seed.action();
    const receipt = accepted(await setFocus([actionTarget(onboarding), actionTarget(next)]));
    expect(receipt.canonical[0]).toEqual({ ref: selection.ref, localRevision: 5 });
    expect(activeFocus().map((document) => document.orderKey)).toEqual([
      spacedOrderKey(0),
      spacedOrderKey(1),
    ]);
    expect(harness.unitOfWork.state.events.map(({ event }) => event.eventType)).toEqual([
      focusEventTypes.reordered,
      focusEventTypes.added,
    ]);
  });

  it('replaces a full day by archiving first, and undo restores the original order', async () => {
    const original = [seed.action(), seed.action(), seed.action()];
    for (const [index, action] of original.entries())
      seed.focus({ kind: 'action', actionId: action.ref.id }, '2026-09-28', {
        orderKey: spacedOrderKey(index),
      });
    const before = focusTargets();
    const replacements = [seed.action(), seed.action(), seed.action()];
    const receipt = accepted(await setFocus(replacements.map(actionTarget)));
    const operations = harness.unitOfWork.state.events.map(({ event }) => [
      event.eventType,
      event.payload['operation'],
    ]);
    expect(operations).toEqual([
      [focusEventTypes.removed, 'update'],
      [focusEventTypes.removed, 'update'],
      [focusEventTypes.removed, 'update'],
      [focusEventTypes.added, 'create'],
      [focusEventTypes.added, 'create'],
      [focusEventTypes.added, 'create'],
    ]);
    expect(focusTargets()).toEqual(
      replacements.map((action) => focusTargetKey({ kind: 'action', actionId: action.ref.id })),
    );
    accepted(await undo(receipt));
    expect(focusTargets()).toEqual(before);
    expect(activeFocus()).toHaveLength(3);
  });

  it('removes items the person no longer chose', async () => {
    const first = seed.action();
    const second = seed.action();
    seed.focus({ kind: 'action', actionId: first.ref.id }, '2026-09-28');
    seed.focus({ kind: 'action', actionId: second.ref.id }, '2026-09-28');
    accepted(await setFocus([actionTarget(second)]));
    expect(focusTargets()).toEqual([focusTargetKey({ kind: 'action', actionId: second.ref.id })]);
    expect(harness.unitOfWork.state.events.map(({ event }) => event.eventType)).toEqual([
      focusEventTypes.removed,
    ]);
    accepted(await setFocus([]));
    expect(activeFocus()).toEqual([]);
  });

  it('fails on a changed selection instead of overwriting it', async () => {
    const action = seed.action();
    const selection = seed.focus({ kind: 'action', actionId: action.ref.id }, '2026-09-28');
    const current = await readDayFocus(kit, ownerId, profile.profileId, day);
    // Another command changes the selection after the pre-read.
    harness.unitOfWork.seed({ ...selection, localRevision: 2 });
    const result = await kit.run(
      ownerId,
      undefined,
      'focus.set',
      current.expected,
      async ({ records, context }) => {
        const plan = await planFocusMutations(
          records,
          {
            ownerId,
            profileId: profile.profileId,
            date: day,
            existing: current.records,
            desired: [],
          },
          kit.nextId,
          context,
        );
        return plan.ok ? ok({ mutations: plan.value.mutations }) : plan;
      },
    );
    expect(result.ok ? '' : result.error.code).toBe('revision_conflict');
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('refuses a selection of another date or profile as the existing focus', async () => {
    const action = seed.action();
    const other = seed.focus({ kind: 'action', actionId: action.ref.id }, '2026-09-29');
    const result = await kit.run(
      ownerId,
      undefined,
      'focus.set',
      [{ ref: other.ref, revision: 1 }],
      async ({ records, context }) => {
        const plan = await planFocusMutations(
          records,
          { ownerId, profileId: profile.profileId, date: day, existing: [other], desired: [] },
          kit.nextId,
          context,
        );
        return plan.ok ? ok({ mutations: plan.value.mutations }) : plan;
      },
    );
    expect(rejection(result)).toBe('focus_changed');
  });

  it('returns the stored receipt for a repeated command id', async () => {
    const action = seed.action();
    const commandId = 'c0000000-0000-4000-8000-000000000001' as CommandId;
    const first = accepted(await setFocus([actionTarget(action)], day, commandId));
    const second = accepted(await setFocus([actionTarget(action)], day, commandId));
    expect(second).toEqual(first);
    expect(activeFocus()).toHaveLength(1);
  });
});

describe('focus targets', () => {
  it('parses Action and occurrence inputs into day keys', () => {
    const actionId = 'a0000000-0000-4000-8000-000000000001';
    expect(parseFocusTarget(ownerId, { kind: 'action', actionId })).toEqual({
      ok: true,
      value: {
        kind: 'action',
        key: `action:${actionId}`,
        ref: createEntityRef('action', actionId as UUID, ownerId),
      },
    });
    const routineId = 'b0000000-0000-4000-8000-000000000001';
    const parsed = parseFocusTarget(ownerId, {
      kind: 'routine_occurrence',
      occurrence: { routineId, generation: 1, period: dated('2026-09-28') },
    });
    expect(parsed.ok && parsed.value.key.startsWith('routine_occurrence:')).toBe(true);
    expect(parsed.ok && parsed.value.ref.type).toBe('routine_occurrence');
  });

  it.each([
    ['a malformed Action id', { kind: 'action', actionId: 'nope' }, 'invalid_uuid'],
    ['an unknown kind', { kind: 'project', actionId: 'x' }, 'focus_target'],
    ['a missing input', null, 'focus_target'],
    [
      'a malformed period',
      {
        kind: 'routine_occurrence',
        occurrence: {
          routineId: 'b0000000-0000-4000-8000-000000000001',
          generation: 1,
          period: { kind: 'date', date: '2026-13-40' },
        },
      },
      'focus_target',
    ],
    [
      'a zero generation',
      {
        kind: 'routine_occurrence',
        occurrence: {
          routineId: 'b0000000-0000-4000-8000-000000000001',
          generation: 0,
          period: { kind: 'date', date: '2026-09-28' },
        },
      },
      'invalid_value',
    ],
  ])('refuses %s', (_name, input, reason) => {
    const result = parseFocusTarget(ownerId, input as FocusTargetInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.['reason'] ?? result.error.code).toBe(reason);
  });

  it('reads a date’s focus with records, expected revisions, and domain items in order', async () => {
    const first = seed.action();
    const second = seed.action();
    const later = seed.focus({ kind: 'action', actionId: second.ref.id }, '2026-09-28', {
      orderKey: spacedOrderKey(1),
      revision: 3,
    });
    const earlier = seed.focus({ kind: 'action', actionId: first.ref.id }, '2026-09-28', {
      orderKey: spacedOrderKey(0),
    });
    seed.focus({ kind: 'action', actionId: first.ref.id }, '2026-09-29');
    const read = await readDayFocus(kit, ownerId, profile.profileId, day);
    expect(read.rows.map((row) => row.id)).toEqual([earlier.ref.id, later.ref.id]);
    expect(read.records).toEqual([earlier, later]);
    expect(read.expected).toEqual([
      { ref: earlier.ref, revision: 1 },
      { ref: later.ref, revision: 3 },
    ]);
    expect(read.items).toEqual([
      {
        id: earlier.ref.id,
        orderKey: spacedOrderKey(0),
        targetKey: focusTargetKey({ kind: 'action', actionId: first.ref.id }),
      },
      {
        id: later.ref.id,
        orderKey: spacedOrderKey(1),
        targetKey: focusTargetKey({ kind: 'action', actionId: second.ref.id }),
      },
    ]);
  });
});
