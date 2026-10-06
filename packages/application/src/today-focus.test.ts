import {
  entityRefKey,
  focusTargetKey,
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
  type TodayTestQueries,
} from './testing/today-test-queries';
import type { FocusTargetInput, TodayFocusMethods, TodayQueryPort } from './today-contracts';
import { createTodayFocus, focusSetEventType } from './today-focus';
import { focusEventTypes } from './today-focus-plan';
import { createTodayKit } from './today-kit';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
// 09:00 in New York: planning today is Monday 2026-09-28.
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
const commandId = (value: number): CommandId =>
  `c0000000-0000-4000-8000-${String(value).padStart(12, '0')}` as CommandId;

let harness: InMemoryHarness;
let queries: TodayTestQueries;
let focus: TodayFocusMethods;
let seed: TodaySeeder;

function build(port: TodayQueryPort = queries): TodayFocusMethods {
  return createTodayFocus(createTodayKit(harness.dependencies, port));
}

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  queries = createTodayTestQueries(harness.unitOfWork, profile);
  focus = build();
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
const actionKey = (record: CanonicalRecordState) =>
  focusTargetKey({ kind: 'action', actionId: record.ref.id });

const accepted = (result: ApplicationResult<CommandReceipt>): CommandReceipt => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const rejection = (result: ApplicationResult<CommandReceipt>): unknown => {
  if (result.ok) throw new Error('Expected a rejection.');
  if (result.error.code !== 'domain_rejected') return result.error.code;
  return result.error.domainError.details?.['reason'] ?? result.error.domainError.code;
};

const current = (record: CanonicalRecordState): CanonicalRecordState => {
  const stored = harness.unitOfWork.get(entityRefKey(record.ref));
  if (stored === undefined) throw new Error('Missing record.');
  return stored;
};

const activeFocus = (date = day) =>
  [...harness.unitOfWork.state.records.values()]
    .map((record) => ({ record, document: record.document as FocusSelectionDocument }))
    .filter(
      ({ document, record }) =>
        record.ref.type === 'focus_selection' &&
        document.kind === 'day_focus' &&
        document.periodStart === date &&
        document.archivedAt === undefined,
    )
    .sort(
      (left, right) =>
        left.document.orderKey.localeCompare(right.document.orderKey) ||
        left.record.ref.id.localeCompare(right.record.ref.id),
    );

const focusKeys = (date = day) =>
  activeFocus(date).map(({ document }) =>
    document.target.kind === 'action'
      ? focusTargetKey({ kind: 'action', actionId: document.target.actionId })
      : document.target.kind === 'routine_occurrence'
        ? focusTargetKey({
            kind: 'routine_occurrence',
            occurrenceId: document.target.routineOccurrenceId,
          })
        : null,
  );

const events = () =>
  harness.unitOfWork.state.events.map(({ event }) => [event.eventType, event.payload]);

const undo = (receipt: CommandReceipt) => {
  if (!receipt.undo.available) throw new Error('No undo.');
  return createPlanningApplication(
    harness.dependencies,
    createTestPlanningQueries(harness.unitOfWork, profile),
  ).undo(receipt.undo.undoId);
};

/** Seed a date's focus rows in the given order (spaced keys unless given). */
function seedFocus(
  actions: readonly CanonicalRecordState[],
  date = '2026-09-28',
  keys?: readonly string[],
): CanonicalRecordState[] {
  return actions.map((action, index) =>
    seed.focus({ kind: 'action', actionId: action.ref.id }, date, {
      orderKey: keys?.[index] ?? spacedOrderKey(index),
    }),
  );
}

const onlyTodayPortCalls = () => {
  const allowed = new Set<string>([
    'getPlanProfile',
    'readRecord',
    'listRoutines',
    'listMaterializedOccurrences',
    'listCapacityConstraints',
    'listDayBlocks',
    'listDayActionPlacements',
    'listWeekActionPlacements',
    'listWeekCommitmentActions',
    'listDayFocus',
    'getFocusAction',
  ]);
  return queries.calls.every((call) => allowed.has(call.method));
};

/* ───────────────────────── Queries ───────────────────────── */

describe('getFocusChoices', () => {
  it('lists the date’s candidates in plan order with nothing preselected', async () => {
    const flexible = seed.action({ title: 'Flexible' });
    seed.placement(flexible.ref.id, { kind: 'day', date: day });
    const scheduled = seed.action({ title: 'Scheduled', state: 'scheduled' });
    seed.placement(scheduled.ref.id, { kind: 'day', date: day });
    seed.block(
      { kind: 'action', actionId: scheduled.ref.id },
      '2026-09-28T18:00:00.000Z',
      '2026-09-28T19:00:00.000Z',
    );
    const walk = seed.routine(daily, { title: 'Walk' });
    const chosen = seed.action({ title: 'Chosen' });
    seed.placement(chosen.ref.id, { kind: 'day', date: day });
    seedFocus([chosen]);

    const choices = await focus.getFocusChoices('2026-09-28');
    expect(choices.editable).toBe(true);
    expect(choices.current.map((item) => item.key)).toEqual([actionKey(chosen)]);
    expect(
      choices.candidates.map((candidate) => [
        candidate.source,
        candidate.kind === 'action'
          ? candidate.action.title
          : candidate.occurrence.ref.routineTitle,
        candidate.selected,
      ]),
    ).toEqual([
      ['scheduled', 'Scheduled', false],
      ['flexible', 'Flexible', false],
      ['flexible', 'Chosen', true],
      ['routine', 'Walk', false],
    ]);
    expect(choices.candidates[3]?.target).toEqual(occurrenceTarget(walk));
    expect(onlyTodayPortCalls()).toBe(true);
    expect(queries.calls.find((call) => call.method === 'listDayBlocks')?.args[1]).toEqual({
      startsAt: '2026-09-28T04:00:00.000Z',
      endsAt: '2026-09-29T04:00:00.000Z',
    });
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('is read-only for an earlier day and rejects an invalid date', async () => {
    expect((await focus.getFocusChoices('2026-09-27')).editable).toBe(false);
    await expect(focus.getFocusChoices('2026-02-30')).rejects.toThrow(
      new RangeError('Choose a valid date.'),
    );
  });
});

describe('getFocusSession', () => {
  it('returns null for a malformed or unknown id without writing', async () => {
    expect(await focus.getFocusSession('not-an-id')).toBeNull();
    expect(queries.calls).toEqual([]);
    expect(await focus.getFocusSession('a0000000-0000-4000-8000-000000000099')).toBeNull();
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('shows one Action with its note and planned block, and never its planning text in state', async () => {
    const action = seed.action({
      title: 'Outline the chapter',
      note: 'Start with the opening scene.',
      estimateMinutes: 50,
      state: 'scheduled',
    });
    seed.block(
      { kind: 'action', actionId: action.ref.id },
      '2026-09-29T14:00:00.000Z',
      '2026-09-29T15:00:00.000Z',
    );
    const view = await focus.getFocusSession(action.ref.id);
    expect(view?.action).toMatchObject({
      id: action.ref.id,
      title: 'Outline the chapter',
      note: 'Start with the opening scene.',
      estimateMinutes: 50,
      state: 'scheduled',
    });
    expect(view?.action).not.toHaveProperty('plannedBlock');
    expect(view?.plannedBlock).toMatchObject({
      startsAt: '2026-09-29T14:00:00.000Z',
      endsAt: '2026-09-29T15:00:00.000Z',
      state: 'planned',
    });
    expect(view?.today).toBe(day);
    expect(view?.profile).toEqual(profile);
    expect(view?.todayFocus).toBeUndefined();
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('works out overdue with the injected clock in the planning zone', async () => {
    const yesterday = seed.action({ due: { kind: 'date', date: d('2026-09-27') } });
    const today = seed.action({ due: { kind: 'date', date: d('2026-09-28') } });
    const done = seed.action({ state: 'completed', due: { kind: 'date', date: d('2026-09-01') } });
    expect((await focus.getFocusSession(yesterday.ref.id))?.overdue).toBe(true);
    expect((await focus.getFocusSession(today.ref.id))?.overdue).toBe(false);
    expect((await focus.getFocusSession(done.ref.id))?.overdue).toBe(false);
    // 23:30 on the 28th in New York is still the 28th there (03:30 UTC on the 29th).
    harness.setNow('2026-09-29T03:30:00.000Z' as Instant);
    expect((await focus.getFocusSession(today.ref.id))?.overdue).toBe(false);
    harness.setNow('2026-09-29T04:30:00.000Z' as Instant);
    expect((await focus.getFocusSession(today.ref.id))?.overdue).toBe(true);
  });

  it('names its place in today’s focus and the next unfinished focus Action in order', async () => {
    const first = seed.action({ title: 'First' });
    const second = seed.action({ title: 'Second', state: 'completed' });
    const walk = seed.routine(daily, { title: 'Walk' });
    const occurrence = seed.occurrence(walk.ref.id, dated('2026-09-28'));
    const third = seed.action({ title: 'Third' });
    seedFocus([first, second]);
    seed.focus({ kind: 'routine_occurrence', routineOccurrenceId: occurrence.ref.id }, day, {
      orderKey: spacedOrderKey(2),
    });
    const [, , , fourth] = [
      null,
      null,
      null,
      seed.focus({ kind: 'action', actionId: third.ref.id }, day, {
        orderKey: spacedOrderKey(3),
      }),
    ];
    const firstView = await focus.getFocusSession(first.ref.id);
    expect(firstView?.todayFocus).toMatchObject({
      position: 1,
      next: { actionId: third.ref.id, title: 'Third' },
    });
    // After the last item the order continues from the start.
    const thirdView = await focus.getFocusSession(third.ref.id);
    expect(thirdView?.todayFocus).toEqual({
      selectionId: fourth.ref.id,
      position: 4,
      next: { actionId: first.ref.id, title: 'First' },
    });
    // Tomorrow's focus is not today's.
    const later = seed.action({ title: 'Later' });
    seedFocus([later], '2026-09-29');
    expect((await focus.getFocusSession(later.ref.id))?.todayFocus).toBeUndefined();
  });

  it('omits the next item when no other unfinished focus Action exists', async () => {
    const only = seed.action({ title: 'Only' });
    const done = seed.action({ title: 'Done', state: 'canceled' });
    seedFocus([only, done]);
    const view = await focus.getFocusSession(only.ref.id);
    expect(view?.todayFocus?.position).toBe(1);
    expect(view?.todayFocus).not.toHaveProperty('next');
  });

  it('returns finished Actions with their state so the page can say so', async () => {
    const archived = seed.action({ state: 'archived' });
    expect((await focus.getFocusSession(archived.ref.id))?.action.state).toBe('archived');
  });
});

/* ───────────────────────── addFocus ───────────────────────── */

describe('addFocus', () => {
  it('adds an Action last in one command with a minimized event, receipt, and undo', async () => {
    const first = seed.action({ title: 'Private plan text' });
    const second = seed.action();
    const [selection] = seedFocus([first]);
    const receipt = accepted(await focus.addFocus({ date: day, target: actionTarget(second) }));
    expect(receipt.canonical.map(({ ref }) => ref.type)).toEqual(['focus_selection']);
    expect(focusKeys()).toEqual([actionKey(first), actionKey(second)]);
    expect(activeFocus()[1]?.document.orderKey).toBe(spacedOrderKey(1));
    expect(events()).toEqual([[focusEventTypes.added, { operation: 'create' }]]);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private plan text');
    expect(receipt.undo.available).toBe(true);
    // The target and the kept selection never change.
    expect(current(second)).toEqual(second);
    expect(current(selection ?? first)).toEqual(selection);

    accepted(await undo(receipt));
    expect(focusKeys()).toEqual([actionKey(first)]);
  });

  it('materializes a Routine Occurrence once; adding it again is refused', async () => {
    const walk = seed.routine(daily, { title: 'Walk' });
    const receipt = accepted(await focus.addFocus({ date: day, target: occurrenceTarget(walk) }));
    expect(receipt.canonical.map(({ ref }) => ref.type)).toEqual([
      'routine_occurrence',
      'focus_selection',
    ]);
    expect(events()).toEqual([
      [focusEventTypes.materialized, { operation: 'create' }],
      [focusEventTypes.added, { operation: 'create' }],
    ]);
    const again = await focus.addFocus({ date: day, target: occurrenceTarget(walk, day, 1) });
    expect(rejection(again)).toBe('already_in_focus');
    expect(events()).toHaveLength(2);
  });

  it('refuses a fourth item with selection_limit and writes nothing', async () => {
    seedFocus([seed.action(), seed.action(), seed.action()]);
    const fourth = seed.action();
    const result = await focus.addFocus({ date: day, target: actionTarget(fourth) });
    expect(rejection(result)).toBe('selection_limit');
    expect(
      !result.ok && result.error.code === 'domain_rejected' && result.error.domainError,
    ).toEqual(
      expect.objectContaining({
        message: "A day's focus holds up to three items. Remove one to choose another.",
      }),
    );
    expect(harness.unitOfWork.state.events).toEqual([]);
    expect(activeFocus()).toHaveLength(3);
  });

  it.each([
    ['a duplicate', 'already_in_focus'],
    ['a finished Action', 'focus_target_finished'],
    ['an earlier day', 'focus_date_past'],
    ['an invalid date', 'date'],
    ['a malformed target', 'focus_target'],
    ['a missing Action', 'target_missing'],
  ])('refuses %s without writing', async (name, reason) => {
    const action = seed.action();
    seedFocus([action]);
    const finished = seed.action({ state: 'completed' });
    const inputs: Record<string, { readonly date: string; readonly target: FocusTargetInput }> = {
      'a duplicate': { date: day, target: actionTarget(action) },
      'a finished Action': { date: day, target: actionTarget(finished) },
      'an earlier day': { date: '2026-09-27', target: actionTarget(seed.action()) },
      'an invalid date': { date: '2026-9-30', target: actionTarget(seed.action()) },
      'a malformed target': {
        date: day,
        target: { kind: 'milestone' } as unknown as FocusTargetInput,
      },
      'a missing Action': {
        date: day,
        target: { kind: 'action', actionId: 'a0000000-0000-4000-8000-000000000099' },
      },
    };
    const input = inputs[name];
    if (input === undefined) throw new Error('Missing case.');
    expect(rejection(await focus.addFocus(input))).toBe(reason);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('adds for a later day and accepts any unfinished Action, including Inbox', async () => {
    const inbox = seed.action({ state: 'inbox' });
    accepted(await focus.addFocus({ date: '2026-10-05', target: actionTarget(inbox) }));
    expect(focusKeys(d('2026-10-05'))).toEqual([actionKey(inbox)]);
    expect(current(inbox)).toEqual(inbox);
  });

  it('normalizes onboarding keys with expected revisions in the same command', async () => {
    const onboarding = seed.action();
    const [selection] = seedFocus([onboarding], day, ['onboarding-01']);
    const added = seed.action();
    const receipt = accepted(await focus.addFocus({ date: day, target: actionTarget(added) }));
    expect(receipt.canonical).toEqual([
      { ref: selection?.ref, localRevision: 2 },
      { ref: expect.objectContaining({ type: 'focus_selection' }) as unknown, localRevision: 1 },
    ]);
    expect(activeFocus().map(({ document }) => document.orderKey)).toEqual([
      spacedOrderKey(0),
      spacedOrderKey(1),
    ]);
    expect(events().map(([type]) => type)).toEqual([
      focusEventTypes.reordered,
      focusEventTypes.added,
    ]);
  });

  it('fails closed when a focus row changes after the pre-read', async () => {
    const kept = seed.action();
    const [selection] = seedFocus([kept]);
    const racing: TodayQueryPort = {
      ...queries,
      async readRecord(owner, ref) {
        const record = await queries.readRecord(owner, ref);
        // Another command bumps the selection right after this read.
        if (record !== null && selection !== undefined && ref.id === selection.ref.id)
          harness.unitOfWork.seed({ ...record, localRevision: record.localRevision + 1 });
        return record;
      },
    };
    const result = await build(racing).addFocus({ date: day, target: actionTarget(seed.action()) });
    expect(rejection(result)).toBe('revision_conflict');
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('returns the stored receipt for a repeated command id', async () => {
    const action = seed.action();
    const input = { date: day, target: actionTarget(action) };
    const first = accepted(await focus.addFocus(input, commandId(1)));
    const second = accepted(await focus.addFocus(input, commandId(1)));
    expect(second).toEqual(first);
    expect(activeFocus()).toHaveLength(1);
    expect(events()).toHaveLength(1);
  });

  it('queues one outbox group when sync is on', async () => {
    const synced = createTodayFocus(
      createTodayKit(
        {
          ...harness.dependencies,
          identityContext: {
            getActiveIdentity: () => Promise.resolve({ ownerId, syncEnabled: true }),
          },
        },
        queries,
      ),
    );
    const action = seed.action();
    const receipt = accepted(await synced.addFocus({ date: day, target: actionTarget(action) }));
    expect(receipt.sync.queued).toBe(true);
    expect(harness.unitOfWork.state.outbox).toHaveLength(1);
  });
});

/* ───────────────────────── removeFocus ───────────────────────── */

describe('removeFocus', () => {
  it('archives the selection only; undo brings it back in its place', async () => {
    const actions = [seed.action(), seed.action(), seed.action()];
    const rows = seedFocus(actions);
    const middle = rows[1];
    if (middle === undefined) throw new Error('Missing row.');
    const receipt = accepted(
      await focus.removeFocus({ selectionId: middle.ref.id, revision: middle.localRevision }),
    );
    expect(receipt.canonical).toEqual([{ ref: middle.ref, localRevision: 2 }]);
    expect(current(middle).document).toEqual({ ...middle.document, archivedAt: now });
    expect(events()).toEqual([[focusEventTypes.removed, { operation: 'update' }]]);
    expect(focusKeys()).toEqual([actionKey(actions[0] ?? middle), actionKey(actions[2] ?? middle)]);
    for (const action of actions) expect(current(action)).toEqual(action);

    accepted(await undo(receipt));
    expect(focusKeys()).toEqual(actions.map(actionKey));
  });

  it('removes finished targets and changed Routine Occurrences', async () => {
    const done = seed.action({ state: 'completed' });
    const ended = seed.routine({ ...daily, endsOn: d('2026-09-27') });
    const stale = seed.occurrence(ended.ref.id, dated('2026-09-28'));
    const [finished] = seedFocus([done]);
    const changed = seed.focus(
      { kind: 'routine_occurrence', routineOccurrenceId: stale.ref.id },
      day,
    );
    accepted(await focus.removeFocus({ selectionId: finished?.ref.id ?? '', revision: 1 }));
    accepted(await focus.removeFocus({ selectionId: changed.ref.id, revision: 1 }));
    expect(activeFocus()).toEqual([]);
    expect(current(stale)).toEqual(stale);
  });

  it('returns the stored receipt for a repeated command id', async () => {
    const [row] = seedFocus([seed.action()]);
    if (row === undefined) throw new Error('Missing row.');
    const input = { selectionId: row.ref.id, revision: 1 };
    const receipt = accepted(await focus.removeFocus(input, commandId(4)));
    expect(accepted(await focus.removeFocus(input, commandId(4)))).toEqual(receipt);
    expect(events()).toHaveLength(1);
  });

  it.each([
    ['an earlier day', 'focus_date_past'],
    ['a Week commitment', 'not_day_focus'],
    ['an archived selection', 'not_day_focus'],
    ['a stale revision', 'revision_conflict'],
    ['a malformed id', 'not_day_focus'],
    ['an unknown id', 'entity_not_found'],
    ['an invalid revision', 'revision'],
  ])('refuses %s without writing', async (name, reason) => {
    const action = seed.action();
    const [past] = seedFocus([action], '2026-09-27');
    const commitment = seed.weekCommitment(action.ref.id, {
      kind: 'week',
      start: d('2026-09-28'),
      end: d('2026-10-04'),
      weekStart: 'monday',
    });
    const archived = seed.focus({ kind: 'action', actionId: action.ref.id }, day, {
      archivedAt: '2026-09-28T12:00:00.000Z' as Instant,
      revision: 2,
    });
    const [active] = seedFocus([seed.action()]);
    const inputs: Record<string, { readonly selectionId: string; readonly revision: number }> = {
      'an earlier day': { selectionId: past?.ref.id ?? '', revision: 1 },
      'a Week commitment': { selectionId: commitment.ref.id, revision: 1 },
      'an archived selection': { selectionId: archived.ref.id, revision: 2 },
      'a stale revision': { selectionId: active?.ref.id ?? '', revision: 7 },
      'a malformed id': { selectionId: 'nope', revision: 1 },
      'an unknown id': { selectionId: 'a0000000-0000-4000-8000-000000000099', revision: 1 },
      'an invalid revision': { selectionId: active?.ref.id ?? '', revision: 0 },
    };
    const input = inputs[name];
    if (input === undefined) throw new Error('Missing case.');
    expect(rejection(await focus.removeFocus(input))).toBe(reason);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });
});

/* ───────────────────────── reorderFocus ───────────────────────── */

describe('reorderFocus', () => {
  it('swaps order keys with the neighbor; undo restores the order', async () => {
    const actions = [seed.action(), seed.action(), seed.action()];
    const rows = seedFocus(actions);
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined) throw new Error('Missing rows.');
    const receipt = accepted(
      await focus.reorderFocus({ selectionId: first.ref.id, revision: 1, direction: 'down' }),
    );
    expect(receipt.canonical.map(({ ref }) => ref.id).sort()).toEqual(
      [first.ref.id, second.ref.id].sort(),
    );
    expect(focusKeys()).toEqual(
      [actions[1], actions[0], actions[2]].map((a) => actionKey(a ?? first)),
    );
    expect(events()).toEqual([
      [focusEventTypes.reordered, { operation: 'update' }],
      [focusEventTypes.reordered, { operation: 'update' }],
    ]);
    for (const action of actions) expect(current(action)).toEqual(action);

    accepted(await undo(receipt));
    expect(focusKeys()).toEqual(actions.map(actionKey));
  });

  it('normalizes onboarding keys to spaced keys in the same command', async () => {
    const actions = [seed.action(), seed.action()];
    const rows = seedFocus(actions, day, ['onboarding-01', 'onboarding-01']);
    const moving = [...rows].sort((left, right) => left.ref.id.localeCompare(right.ref.id))[1];
    if (moving === undefined) throw new Error('Missing row.');
    accepted(
      await focus.reorderFocus({ selectionId: moving.ref.id, revision: 1, direction: 'up' }),
    );
    const after = activeFocus();
    expect(after.map(({ document }) => document.orderKey)).toEqual([
      spacedOrderKey(0),
      spacedOrderKey(1),
    ]);
    expect(after[0]?.record.ref.id).toBe(moving.ref.id);
  });

  it.each([
    ['the first item up', 'order_edge'],
    ['an earlier day', 'focus_date_past'],
    ['a stale revision', 'revision_conflict'],
    ['an invalid direction', 'direction'],
    ['a malformed id', 'not_day_focus'],
    ['an unknown id', 'entity_not_found'],
  ])('refuses %s without writing', async (name, reason) => {
    const rows = seedFocus([seed.action(), seed.action()]);
    const [past] = seedFocus([seed.action(), seed.action()], '2026-09-27');
    const first = rows[0];
    if (first === undefined || past === undefined) throw new Error('Missing rows.');
    const inputs: Record<string, Parameters<TodayFocusMethods['reorderFocus']>[0]> = {
      'the first item up': { selectionId: first.ref.id, revision: 1, direction: 'up' },
      'an earlier day': { selectionId: past.ref.id, revision: 1, direction: 'down' },
      'a stale revision': { selectionId: first.ref.id, revision: 3, direction: 'down' },
      'an invalid direction': {
        selectionId: first.ref.id,
        revision: 1,
        direction: 'left' as 'up',
      },
      'a malformed id': { selectionId: 'nope', revision: 1, direction: 'down' },
      'an unknown id': {
        selectionId: 'a0000000-0000-4000-8000-000000000099',
        revision: 1,
        direction: 'down',
      },
    };
    const input = inputs[name];
    if (input === undefined) throw new Error('Missing case.');
    expect(rejection(await focus.reorderFocus(input))).toBe(reason);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('fails closed when the neighbor changed after the pre-read', async () => {
    const rows = seedFocus([seed.action(), seed.action()]);
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined) throw new Error('Missing rows.');
    const racing: TodayQueryPort = {
      ...queries,
      async readRecord(owner, ref) {
        const record = await queries.readRecord(owner, ref);
        // Another command changes the neighbor right after the pre-read reads it.
        if (ref.id === second.ref.id) harness.unitOfWork.seed({ ...second, localRevision: 2 });
        return record;
      },
    };
    const result = await build(racing).reorderFocus({
      selectionId: first.ref.id,
      revision: 1,
      direction: 'down',
    });
    expect(rejection(result)).toBe('revision_conflict');
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('returns the stored receipt for a repeated command id', async () => {
    const rows = seedFocus([seed.action(), seed.action()]);
    const first = rows[0];
    if (first === undefined) throw new Error('Missing row.');
    const input = { selectionId: first.ref.id, revision: 1, direction: 'down' as const };
    const receipt = accepted(await focus.reorderFocus(input, commandId(2)));
    expect(accepted(await focus.reorderFocus(input, commandId(2)))).toEqual(receipt);
    expect(events()).toHaveLength(2);
  });
});

/* ───────────────────────── setDayFocus ───────────────────────── */

describe('setDayFocus', () => {
  it('replaces the day’s focus in one command: archives first, then creates', async () => {
    const before = [seed.action(), seed.action(), seed.action()];
    seedFocus(before);
    const [first, second, third] = before;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error('Missing actions.');
    const walk = seed.routine(daily, { title: 'Walk' });
    const receipt = accepted(
      await focus.setDayFocus({
        date: day,
        items: [actionTarget(third), actionTarget(second), occurrenceTarget(walk)],
      }),
    );
    expect(
      events().map(([type, payload]) => [type, (payload as { operation: string }).operation]),
    ).toEqual([
      [focusEventTypes.removed, 'update'],
      [focusEventTypes.reordered, 'update'],
      [focusEventTypes.materialized, 'create'],
      [focusEventTypes.added, 'create'],
    ]);
    expect(
      harness.unitOfWork.state.events.every(({ event }) => event.commandId === receipt.commandId),
    ).toBe(true);
    expect(focusKeys().slice(0, 2)).toEqual([actionKey(third), actionKey(second)]);
    expect(focusKeys()[2]?.startsWith('routine_occurrence:')).toBe(true);
    for (const action of before) expect(current(action)).toEqual(action);

    accepted(await undo(receipt));
    expect(focusKeys()).toEqual(before.map(actionKey));
  });

  it('keeps chosen finished Actions and changed occurrences without checking them again', async () => {
    const done = seed.action({ state: 'completed' });
    const ended = seed.routine({ ...daily, endsOn: d('2026-09-27') });
    const stale = seed.occurrence(ended.ref.id, dated('2026-09-28'));
    seedFocus([done]);
    seed.focus({ kind: 'routine_occurrence', routineOccurrenceId: stale.ref.id }, day, {
      orderKey: spacedOrderKey(1),
    });
    const open = seed.action();
    accepted(
      await focus.setDayFocus({
        date: day,
        items: [actionTarget(done), occurrenceTarget(ended, day, 1), actionTarget(open)],
      }),
    );
    expect(focusKeys()).toEqual([
      actionKey(done),
      focusTargetKey({ kind: 'routine_occurrence', occurrenceId: stale.ref.id }),
      actionKey(open),
    ]);
    expect(events().map(([type]) => type)).toEqual([focusEventTypes.added]);
  });

  it('refuses the same list as no change, and clears the day with an empty list', async () => {
    const action = seed.action();
    seedFocus([action]);
    expect(rejection(await focus.setDayFocus({ date: day, items: [actionTarget(action)] }))).toBe(
      'no_change',
    );
    expect(harness.unitOfWork.state.events).toEqual([]);
    const receipt = accepted(await focus.setDayFocus({ date: day, items: [] }));
    expect(activeFocus()).toEqual([]);
    expect(events()).toEqual([[focusEventTypes.removed, { operation: 'update' }]]);
    expect(receipt.undo.available).toBe(true);
  });

  it.each([
    ['four items', 'selection_limit'],
    ['a duplicate', 'focus_duplicate'],
    ['an earlier day', 'focus_date_past'],
    ['a missing list', 'focus_items'],
    ['a finished new target', 'focus_target_finished'],
  ])('refuses %s without writing', async (name, reason) => {
    const actions = [seed.action(), seed.action(), seed.action(), seed.action()];
    const finished = seed.action({ state: 'canceled' });
    const inputs: Record<string, { readonly date: string; readonly items: FocusTargetInput[] }> = {
      'four items': { date: day, items: actions.map(actionTarget) },
      'a duplicate': {
        date: day,
        items: [actionTarget(actions[0] ?? finished), actionTarget(actions[0] ?? finished)],
      },
      'an earlier day': { date: '2026-09-27', items: [actionTarget(actions[0] ?? finished)] },
      'a missing list': { date: day, items: null as unknown as FocusTargetInput[] },
      'a finished new target': { date: day, items: [actionTarget(finished)] },
    };
    const input = inputs[name];
    if (input === undefined) throw new Error('Missing case.');
    expect(rejection(await focus.setDayFocus(input))).toBe(reason);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('uses the focus.set command type and returns the stored receipt on a retry', async () => {
    const action = seed.action();
    const input = { date: day, items: [actionTarget(action)] };
    const receipt = accepted(await focus.setDayFocus(input, commandId(3)));
    expect(accepted(await focus.setDayFocus(input, commandId(3)))).toEqual(receipt);
    expect(focusSetEventType).toBe('focus.set');
    expect(activeFocus()).toHaveLength(1);
  });
});
