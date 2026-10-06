import { describe, expect, it } from 'vitest';

import {
  appendDayFocus,
  compareOrder,
  createEntityRef,
  createWeekPeriod,
  dayBlockLookbackHours,
  dayFocusLimit,
  dayRelation,
  endDayCarryDate,
  endDayDecisionKinds,
  endDayLimits,
  focusTargetKey,
  focusableActionStates,
  isFocusableActionState,
  isOccurrenceOnDate,
  planDayFocus,
  planEndDayAction,
  spacedOrderKey,
  validateEndDayPeriod,
  validateFocusDate,
  validateFocusSelection,
  validateFocusTarget,
  type ActionState,
  type CalendarDate,
  type DayFocusItem,
  type DayFocusPlan,
  type DomainResult,
  type EndDayActionFacts,
  type EndDayActionOutcome,
  type EndDayDecisionKind,
  type EntityId,
  type ExistingFocusSelection,
  type FocusTargetKey,
  type GeneratedOccurrencePeriod,
  type HorizonPeriod,
  type MonthKey,
  type OwnerId,
  type RoutineOccurrenceState,
  type YearKey,
} from './index.js';

const d = (value: string) => value as CalendarDate;
const today = d('2026-09-28');

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** The rejection's reason, or its code when it has none. */
const rejection = (result: DomainResult<unknown>): unknown => {
  if (result.ok) throw new Error('Expected a rejection.');
  return result.error.details?.['reason'] ?? result.error.code;
};

const key = (id: string): FocusTargetKey =>
  focusTargetKey({ kind: 'action', actionId: id as EntityId });
const item = (id: string, target: string, orderKey: string): DayFocusItem => ({
  id,
  targetKey: key(target),
  orderKey,
});

/**
 * Apply a plan in its documented order (archive, reorder, create) and return the day's focus in
 * display order plus the most active rows it ever held.
 */
function applyPlan(
  existing: readonly DayFocusItem[],
  plan: DayFocusPlan,
): { readonly order: readonly FocusTargetKey[]; readonly peak: number } {
  let rows = existing.filter((row) => !plan.archive.includes(row.id));
  let peak = rows.length;
  rows = rows.map((row) => ({
    ...row,
    orderKey: plan.reorder.find((change) => change.id === row.id)?.orderKey ?? row.orderKey,
  }));
  for (const [index, created] of plan.create.entries()) {
    rows = [...rows, { id: `created-${String(index)}`, ...created }];
    peak = Math.max(peak, rows.length);
  }
  return { order: [...rows].sort(compareOrder).map((row) => row.targetKey), peak };
}

describe('the planning day', () => {
  it.each([
    ['2026-09-27', 'past'],
    ['2026-09-28', 'today'],
    ['2026-09-29', 'future'],
    ['2025-12-31', 'past'],
  ] as const)('relates %s to today as %s', (date, relation) => {
    expect(dayRelation(d(date), today)).toBe(relation);
  });

  it.each([
    ['an earlier day carries to today', '2026-09-20', '2026-09-28', '2026-09-28'],
    ['yesterday carries to today', '2026-09-27', '2026-09-28', '2026-09-28'],
    ['today carries to tomorrow', '2026-09-28', '2026-09-28', '2026-09-29'],
    ['today carries across a month', '2026-09-30', '2026-09-30', '2026-10-01'],
    ['today carries across a year', '2026-12-31', '2026-12-31', '2027-01-01'],
  ])('%s', (_name, date, now, carry) => {
    expect(expectValue(endDayCarryDate(d(date), d(now)))).toBe(carry);
  });

  it('has nothing to end on a later day', () => {
    const result = endDayCarryDate(d('2026-09-29'), today);
    expect(rejection(result)).toBe('end_day_future');
    expect(result.ok ? '' : result.error.message).toBe(
      'End day is available for today or earlier days.',
    );
  });

  it('looks back two days for blocks that reach into a day', () => {
    expect(dayBlockLookbackHours).toBe(48);
  });
});

describe('day focus eligibility', () => {
  it('chooses focus for today or a later day only', () => {
    expect(expectValue(validateFocusDate(today, today))).toBe(today);
    expect(expectValue(validateFocusDate(d('2026-10-05'), today))).toBe('2026-10-05');
    const past = validateFocusDate(d('2026-09-27'), today);
    expect(rejection(past)).toBe('focus_date_past');
    expect(past.ok ? '' : past.error.message).toBe('Focus can be chosen for today or a later day.');
  });

  it.each([
    ['inbox', true],
    ['planned', true],
    ['scheduled', true],
    ['in_progress', true],
    ['completed', false],
    ['canceled', false],
    ['archived', false],
  ] as const satisfies readonly (readonly [ActionState, boolean])[])(
    'treats an Action in %s as focusable: %s',
    (state, focusable) => {
      expect(isFocusableActionState(state)).toBe(focusable);
      expect(focusableActionStates.includes(state)).toBe(focusable);
      const result = validateFocusTarget({ kind: 'action', state });
      if (focusable) expect(result).toEqual({ ok: true, value: true });
      else expect(rejection(result)).toBe('focus_target_finished');
    },
  );

  it.each([
    ['planned', true],
    ['completed', false],
    ['skipped', false],
  ] as const satisfies readonly (readonly [RoutineOccurrenceState, boolean])[])(
    'treats a Routine Occurrence in %s as focusable: %s',
    (state, focusable) => {
      const result = validateFocusTarget({ kind: 'routine_occurrence', state });
      expect(result.ok).toBe(focusable);
      if (!result.ok) {
        expect(rejection(result)).toBe('focus_target_finished');
        expect(result.error.message).toBe('Only unfinished work can be chosen as focus.');
      }
    },
  );

  const dated = (date: string): GeneratedOccurrencePeriod => ({ kind: 'date', date: d(date) });
  const week = { ...createWeekPeriod(d('2026-09-28'), 'monday'), targetCount: 3 };

  it.each([
    ['a dated occurrence on its logical date', { period: dated('2026-09-28') }, true],
    ['a dated occurrence on another date', { period: dated('2026-09-29') }, false],
    [
      'a moved occurrence on its override date',
      { period: dated('2026-09-27'), override: { date: d('2026-09-28') } },
      true,
    ],
    [
      'a moved occurrence on its old logical date',
      { period: dated('2026-09-28'), override: { date: d('2026-09-29') } },
      false,
    ],
    ['a weekly count on the first day of its week', { period: week }, true],
    [
      'a weekly count on the last day of its week',
      { period: { ...week, start: d('2026-09-22'), end: d('2026-09-28') } },
      true,
    ],
    [
      'a weekly count of another week',
      { period: { ...week, start: d('2026-09-29'), end: d('2026-10-05') } },
      false,
    ],
  ] as const)('places %s: %s', (_name, occurrence, expected) => {
    expect(isOccurrenceOnDate(occurrence, today)).toBe(expected);
  });

  it('keys targets by kind and id', () => {
    expect(focusTargetKey({ kind: 'action', actionId: 'a1' as EntityId })).toBe('action:a1');
    expect(focusTargetKey({ kind: 'routine_occurrence', occurrenceId: 'o1' as EntityId })).toBe(
      'routine_occurrence:o1',
    );
  });
});

describe('planning a day focus', () => {
  const full = [
    item('f1', 'a', spacedOrderKey(0)),
    item('f2', 'b', spacedOrderKey(1)),
    item('f3', 'c', spacedOrderKey(2)),
  ];

  it('holds at most three items', () => {
    expect(dayFocusLimit).toBe(3);
    const result = planDayFocus([], [key('a'), key('b'), key('c'), key('d')]);
    expect(rejection(result)).toBe('selection_limit');
    expect(result.ok ? '' : result.error.message).toBe(
      "A day's focus holds up to three items. Remove one to choose another.",
    );
  });

  it('chooses each target once', () => {
    expect(rejection(planDayFocus([], [key('a'), key('a')]))).toBe('focus_duplicate');
  });

  it('changes nothing when the same list is chosen again, even with older keys', () => {
    expect(expectValue(planDayFocus(full, [key('a'), key('b'), key('c')]))).toEqual({
      archive: [],
      reorder: [],
      create: [],
    });
    const onboarding = [item('f1', 'a', 'onboarding-01')];
    expect(expectValue(planDayFocus(onboarding, [key('a')]))).toEqual({
      archive: [],
      reorder: [],
      create: [],
    });
    expect(expectValue(planDayFocus([], []))).toEqual({ archive: [], reorder: [], create: [] });
  });

  it('archives removed items and leaves the remaining order untouched', () => {
    const plan = expectValue(planDayFocus(full, [key('a'), key('c')]));
    expect(plan).toEqual({ archive: ['f2'], reorder: [], create: [] });
    expect(expectValue(planDayFocus(full, []))).toEqual({
      archive: ['f1', 'f2', 'f3'],
      reorder: [],
      create: [],
    });
  });

  it('appends new items after kept ones without changing kept keys', () => {
    const existing = [item('f1', 'a', spacedOrderKey(0)), item('f2', 'b', spacedOrderKey(4))];
    const plan = expectValue(planDayFocus(existing, [key('a'), key('b'), key('c')]));
    expect(plan).toEqual({
      archive: [],
      reorder: [],
      create: [{ targetKey: key('c'), orderKey: spacedOrderKey(5) }],
    });
    expect(applyPlan(existing, plan).order).toEqual([key('a'), key('b'), key('c')]);
  });

  it('archives before it creates, so a replaced full day never holds four', () => {
    const plan = expectValue(planDayFocus(full, [key('d'), key('e'), key('f')]));
    expect(plan.archive).toEqual(['f1', 'f2', 'f3']);
    expect(plan.create.map((created) => created.targetKey)).toEqual([key('d'), key('e'), key('f')]);
    const applied = applyPlan(full, plan);
    expect(applied.order).toEqual([key('d'), key('e'), key('f')]);
    expect(applied.peak).toBeLessThanOrEqual(dayFocusLimit);
  });

  it('reorders by giving each chosen item the spaced key of its position', () => {
    const plan = expectValue(planDayFocus(full, [key('c'), key('a'), key('b')]));
    expect(plan).toEqual({
      archive: [],
      reorder: [
        { id: 'f3', orderKey: spacedOrderKey(0) },
        { id: 'f1', orderKey: spacedOrderKey(1) },
        { id: 'f2', orderKey: spacedOrderKey(2) },
      ],
      create: [],
    });
    expect(applyPlan(full, plan).order).toEqual([key('c'), key('a'), key('b')]);
    const inserted = expectValue(planDayFocus(full.slice(0, 2), [key('d'), key('a'), key('b')]));
    expect(inserted.create).toEqual([{ targetKey: key('d'), orderKey: spacedOrderKey(0) }]);
    expect(applyPlan(full.slice(0, 2), inserted).order).toEqual([key('d'), key('a'), key('b')]);
  });

  it('normalizes the onboarding key when an item is added', () => {
    const onboarding = [item('f1', 'a', 'onboarding-01')];
    const plan = expectValue(planDayFocus(onboarding, [key('a'), key('b')]));
    expect(plan).toEqual({
      archive: [],
      reorder: [{ id: 'f1', orderKey: spacedOrderKey(0) }],
      create: [{ targetKey: key('b'), orderKey: spacedOrderKey(1) }],
    });
    expect(applyPlan(onboarding, plan).order).toEqual([key('a'), key('b')]);
  });

  it('orders ties by id and keeps the first of a duplicated target', () => {
    const tied = [item('f2', 'b', 'x'), item('f1', 'a', 'x')];
    expect(expectValue(planDayFocus(tied, [key('a'), key('b')]))).toEqual({
      archive: [],
      reorder: [],
      create: [],
    });
    const duplicated = [item('f1', 'a', spacedOrderKey(0)), item('f2', 'a', spacedOrderKey(1))];
    expect(expectValue(planDayFocus(duplicated, [key('a')]))).toEqual({
      archive: ['f2'],
      reorder: [],
      create: [],
    });
  });

  it('adds one item at the end, never twice and never as a fourth', () => {
    expect(expectValue(appendDayFocus([], key('a')))).toEqual([key('a')]);
    const two = [item('f2', 'b', spacedOrderKey(1)), item('f1', 'a', spacedOrderKey(0))];
    expect(expectValue(appendDayFocus(two, key('c')))).toEqual([key('a'), key('b'), key('c')]);
    const already = appendDayFocus(two, key('b'));
    expect(rejection(already)).toBe('already_in_focus');
    expect(already.ok ? '' : already.error.message).toBe("This is already in the day's focus.");
    expect(rejection(appendDayFocus(full, key('d')))).toBe('selection_limit');
    expect(rejection(appendDayFocus(full, key('a')))).toBe('already_in_focus');
  });

  it('refuses a fourth item exactly as the onboarding focus selection rule does', () => {
    const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
    const target = (id: string) => createEntityRef('action', id as EntityId, owner);
    const existing: ExistingFocusSelection[] = ['a', 'b', 'c'].map((id) => ({
      kind: 'day_focus',
      target: target(id),
      period: { kind: 'day', date: today },
    }));
    const candidate = (id: string, index: number) => ({
      kind: 'day_focus' as const,
      ownerId: owner,
      target: target(id),
      period: { kind: 'day' as const, date: today },
      orderKey: spacedOrderKey(index),
    });
    expect(rejection(validateFocusSelection(candidate('d', 3), existing))).toBe('selection_limit');
    expect(rejection(appendDayFocus(full, key('d')))).toBe('selection_limit');
    expect(rejection(planDayFocus(full, [key('a'), key('b'), key('c'), key('d')]))).toBe(
      'selection_limit',
    );
    expect(validateFocusSelection(candidate('c', 2), existing.slice(0, 2)).ok).toBe(true);
    expect(expectValue(appendDayFocus(full.slice(0, 2), key('c')))).toHaveLength(3);
  });
});

describe('End Day decisions', () => {
  const blockPositions = ['none', 'on_day', 'elsewhere'] as const;
  const unfinished: readonly ActionState[] = ['inbox', 'planned', 'scheduled', 'in_progress'];
  const finished: readonly ActionState[] = ['completed', 'canceled', 'archived'];

  /** The decision table of, written out per state and block position. */
  const expected = (
    facts: EndDayActionFacts,
    decision: EndDayDecisionKind,
  ): EndDayActionOutcome | string => {
    if (finished.includes(facts.state)) return 'already_finished';
    if (facts.plannedBlock === 'elsewhere') return 'scheduled_elsewhere';
    const onDay = facts.plannedBlock === 'on_day';
    switch (decision) {
      case 'carry':
      case 'move':
        return {
          ...(facts.state === 'inbox' || facts.state === 'scheduled'
            ? { actionState: 'planned' as const }
            : {}),
          ...(onDay ? { blockState: 'skipped' as const } : {}),
          movesPlacement: true,
        };
      case 'complete':
        return {
          actionState: 'completed',
          ...(onDay ? { blockState: 'completed' as const } : {}),
          movesPlacement: false,
        };
      case 'cancel':
        return {
          actionState: 'canceled',
          ...(onDay ? { blockState: 'canceled' as const } : {}),
          movesPlacement: false,
        };
    }
  };

  const cases = [...unfinished, ...finished].flatMap((state) =>
    blockPositions.flatMap((plannedBlock) =>
      endDayDecisionKinds.map((decision) => [state, plannedBlock, decision] as const),
    ),
  );

  it('covers every state, block position, and decision', () => {
    expect(cases).toHaveLength(7 * 3 * 4);
  });

  it.each(cases)('plans %s with a %s block and %s', (state, plannedBlock, decision) => {
    const result = planEndDayAction({ state, plannedBlock }, decision);
    const outcome = expected({ state, plannedBlock }, decision);
    if (typeof outcome === 'string') expect(rejection(result)).toBe(outcome);
    else expect(expectValue(result)).toEqual(outcome);
  });

  it('spells out the main rows of the table', () => {
    expect(
      expectValue(planEndDayAction({ state: 'inbox', plannedBlock: 'none' }, 'carry')),
    ).toEqual({ actionState: 'planned', movesPlacement: true });
    expect(
      expectValue(planEndDayAction({ state: 'in_progress', plannedBlock: 'none' }, 'move')),
    ).toEqual({ movesPlacement: true });
    expect(
      expectValue(planEndDayAction({ state: 'scheduled', plannedBlock: 'on_day' }, 'carry')),
    ).toEqual({ actionState: 'planned', blockState: 'skipped', movesPlacement: true });
    expect(
      expectValue(planEndDayAction({ state: 'scheduled', plannedBlock: 'on_day' }, 'complete')),
    ).toEqual({ actionState: 'completed', blockState: 'completed', movesPlacement: false });
    expect(
      expectValue(planEndDayAction({ state: 'scheduled', plannedBlock: 'on_day' }, 'cancel')),
    ).toEqual({ actionState: 'canceled', blockState: 'canceled', movesPlacement: false });
    const elsewhere = planEndDayAction({ state: 'scheduled', plannedBlock: 'elsewhere' }, 'carry');
    expect(elsewhere.ok ? '' : elsewhere.error.message).toBe(
      'This Action has a planned time on another day. Change it from that day.',
    );
  });

  it('refuses an unknown decision', () => {
    expect(
      rejection(
        planEndDayAction(
          { state: 'planned', plannedBlock: 'none' },
          'decide_later' as EndDayDecisionKind,
        ),
      ),
    ).toBe('end_day_decision');
  });

  const week = (start: string): HorizonPeriod => createWeekPeriod(d(start), 'monday');
  it.each([
    ['yesterday', { kind: 'day', date: d('2026-09-27') }, 'move_period_past'],
    ['today', { kind: 'day', date: today }, true],
    ['a later day', { kind: 'day', date: d('2026-10-02') }, true],
    ['a week that ended yesterday', week('2026-09-21'), 'move_period_past'],
    [
      'a week that ends today',
      { kind: 'week', start: d('2026-09-22'), end: today, weekStart: 'tuesday' },
      true,
    ],
    ['this week', week('2026-09-28'), true],
    ['last month', { kind: 'month', month: '2026-08' as MonthKey }, 'move_period_past'],
    ['this month', { kind: 'month', month: '2026-09' as MonthKey }, true],
    ['next month', { kind: 'month', month: '2026-10' as MonthKey }, true],
    ['a year', { kind: 'year', year: '2026' as YearKey }, 'placement_not_allowed'],
  ] as const)('moves to %s: %s', (_name, period, outcome) => {
    const result = validateEndDayPeriod(period, today);
    if (outcome === true) expect(expectValue(result)).toEqual(period);
    else expect(rejection(result)).toBe(outcome);
  });

  it('says why a past period is refused', () => {
    const result = validateEndDayPeriod({ kind: 'day', date: d('2026-09-01') }, today);
    expect(result.ok ? '' : result.error.message).toBe('Choose today or a later day.');
  });

  it('caps one End Day command', () => {
    expect(endDayLimits).toEqual({ actions: 200, occurrences: 100 });
    expect(Object.isFrozen(endDayLimits)).toBe(true);
  });
});
