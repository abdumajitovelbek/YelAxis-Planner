import {
  createWeekPeriod,
  entityRefKey,
  focusTargetKey,
  localDayBounds,
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
import { defaultPlacementOrderKey } from './planning-scheduling-support';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';
import {
  createTodaySeeder,
  createTodayTestQueries,
  type TodaySeeder,
  type TodayTestQueries,
} from './testing/today-test-queries';
import type {
  EndDayActionDecision,
  EndDayInput,
  EndDayItemView,
  FocusTargetInput,
  TodayEndDayMethods,
} from './today-contracts';
import { createTodayEndDay, endDayEventType } from './today-end-day';
import { createTodayKit } from './today-kit';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const zone = 'America/New_York' as IanaTimeZone;
// Monday 2026-09-28, 09:00 in New York.
const now = '2026-09-28T13:00:00.000Z' as Instant;
const d = (value: string) => value as CalendarDate;
const day = d('2026-09-28');
const tomorrow = d('2026-09-29');
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: zone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
const daily: RecurrenceRuleV1 = {
  version: 1,
  kind: 'daily',
  intervalDays: 1,
  startsOn: d('2026-09-01'),
};
const weeklyCount: RecurrenceRuleV1 = {
  version: 1,
  kind: 'weekly_count',
  targetCount: 3,
  weekStart: 'monday',
  startsOn: d('2026-09-01'),
};
const dated = (date: string) => ({ kind: 'date' as const, date: d(date) });
const onDay = (date: string = day) => ({ kind: 'day' as const, date: d(date) });
/** 14:00–15:00 in New York on the day (UTC−4). */
const afternoon = ['2026-09-28T18:00:00.000Z', '2026-09-28T19:00:00.000Z'] as const;

let harness: InMemoryHarness;
let queries: TodayTestQueries;
let endDay: TodayEndDayMethods;
let seed: TodaySeeder;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  queries = createTodayTestQueries(harness.unitOfWork, profile);
  endDay = createTodayEndDay(createTodayKit(harness.dependencies, queries));
  seed = createTodaySeeder(harness.unitOfWork, ownerId, profile);
});

/* ───────────────────────── Helpers ───────────────────────── */

const accepted = (result: ApplicationResult<CommandReceipt>): CommandReceipt => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const rejection = (result: ApplicationResult<CommandReceipt>): unknown => {
  if (result.ok) throw new Error('Expected a rejection.');
  if (result.error.code !== 'domain_rejected') return result.error.code;
  return result.error.domainError.details?.['reason'] ?? result.error.domainError.code;
};

const documentOf = (record: CanonicalRecordState) =>
  harness.unitOfWork.get(entityRefKey(record.ref))?.document;

const revisionOf = (record: CanonicalRecordState) =>
  harness.unitOfWork.get(entityRefKey(record.ref))?.localRevision;

const input = (overrides: Partial<EndDayInput> = {}): EndDayInput => ({
  date: day,
  carryTo: tomorrow,
  actions: [],
  occurrences: [],
  ...overrides,
});

const decide = (record: CanonicalRecordState, decision: EndDayActionDecision) => ({
  actionId: record.ref.id,
  revision: record.localRevision,
  decision,
});

const occurrenceTarget = (routine: CanonicalRecordState, date: string, revision?: number) => ({
  routineId: routine.ref.id,
  generation: 1,
  period: dated(date),
  ...(revision === undefined ? {} : { revision }),
});

const events = () =>
  harness.unitOfWork.state.events.map(({ event }) => [event.eventType, event.payload]);

const activeFocus = (date: string) =>
  [...harness.unitOfWork.state.records.values()]
    .filter((record) => record.ref.type === 'focus_selection')
    .map((record) => ({ record, document: record.document as FocusSelectionDocument }))
    .filter(
      ({ document }) =>
        document.kind === 'day_focus' &&
        document.periodStart === date &&
        document.archivedAt === undefined,
    )
    .sort((left, right) => left.document.orderKey.localeCompare(right.document.orderKey))
    .map(({ document }) =>
      document.target.kind === 'action' ? `action:${document.target.actionId}` : 'other',
    );

/** Run a command that must be refused and prove nothing was written. */
async function refusedWithoutWrites(
  run: () => Promise<ApplicationResult<CommandReceipt>>,
): Promise<unknown> {
  const before = [...harness.unitOfWork.state.records.entries()];
  const result = await run();
  expect([...harness.unitOfWork.state.records.entries()]).toEqual(before);
  expect(harness.unitOfWork.state.events).toEqual([]);
  expect(harness.unitOfWork.state.undo).toEqual([]);
  expect(harness.unitOfWork.state.receipts.size).toBe(0);
  return rejection(result);
}

const undo = (receipt: CommandReceipt) => {
  if (!receipt.undo.available) throw new Error('No undo.');
  return createPlanningApplication(
    harness.dependencies,
    createTestPlanningQueries(harness.unitOfWork, profile),
  ).undo(receipt.undo.undoId);
};

const titles = (items: readonly EndDayItemView[]) =>
  items.map((item) =>
    item.kind === 'action' ? item.action.title : `Routine: ${item.occurrence.ref.routineTitle}`,
  );

/* ───────────────────────── getEndDay ───────────────────────── */

describe('getEndDay', () => {
  it('reads dates strictly', async () => {
    await expect(endDay.getEndDay('2026-02-30')).rejects.toThrow(
      new RangeError('Choose a valid date.'),
    );
    await expect(endDay.getEndDay('tomorrow')).rejects.toThrow(RangeError);
  });

  it('is not available for a later day and reads nothing beyond the session', async () => {
    seed.placement(seed.action().ref.id, onDay(tomorrow));
    const view = await endDay.getEndDay(tomorrow);
    expect(view).toMatchObject({
      date: tomorrow,
      today: day,
      available: false,
      carryTo: tomorrow,
      completed: [],
      open: { items: [], total: 0 },
    });
    expect(view.nextFocus).toMatchObject({ date: tomorrow, current: [], candidates: [] });
    expect(queries.calls.map(({ method }) => method)).toEqual(['getPlanProfile']);
  });

  it('carries today to the next day and an earlier day to today', async () => {
    expect((await endDay.getEndDay(day)).carryTo).toBe(tomorrow);
    const earlier = await endDay.getEndDay('2026-09-20');
    expect(earlier).toMatchObject({ available: true, carryTo: day, today: day });
    expect(earlier.nextFocus.date).toBe(day);
  });

  it('lists what is done and what is still open, plan-scoped and in plan order', async () => {
    const scheduled = seed.action({ title: 'Scheduled', state: 'scheduled' });
    seed.placement(scheduled.ref.id, onDay());
    const block = seed.block({ kind: 'action', actionId: scheduled.ref.id }, ...afternoon);
    const flexible = seed.action({ title: 'Flexible' });
    seed.placement(flexible.ref.id, onDay());
    const started = seed.action({ title: 'Started', state: 'in_progress' });
    seed.placement(started.ref.id, onDay());
    const done = seed.action({ title: 'Done flexible', state: 'completed' });
    seed.placement(done.ref.id, onDay());
    const doneTimed = seed.action({ title: 'Done with block', state: 'completed' });
    seed.placement(doneTimed.ref.id, onDay());
    seed.block(
      { kind: 'action', actionId: doneTimed.ref.id },
      '2026-09-28T14:00:00.000Z',
      '2026-09-28T15:00:00.000Z',
      { state: 'completed' },
    );
    const canceled = seed.action({ title: 'Canceled', state: 'canceled' });
    seed.placement(canceled.ref.id, onDay());
    const elsewhere = seed.action({ title: 'Elsewhere', state: 'in_progress' });
    seed.placement(elsewhere.ref.id, onDay());
    const laterBlock = seed.block(
      { kind: 'action', actionId: elsewhere.ref.id },
      '2026-09-30T18:00:00.000Z',
      '2026-09-30T19:00:00.000Z',
    );
    // 22:00 the evening before until 01:00: its Day placement stays on the day before.
    const lateNight = seed.action({ title: 'Late night', state: 'scheduled' });
    seed.placement(lateNight.ref.id, onDay('2026-09-27'));
    seed.block(
      { kind: 'action', actionId: lateNight.ref.id },
      '2026-09-28T02:00:00.000Z',
      '2026-09-28T05:00:00.000Z',
    );
    const inbox = seed.action({ title: 'Inbox focus', state: 'inbox' });
    seed.focus({ kind: 'action', actionId: inbox.ref.id }, day);
    const weekly = seed.action({ title: 'Week focus' });
    seed.placement(weekly.ref.id, createWeekPeriod(day, 'monday'));
    seed.focus({ kind: 'action', actionId: weekly.ref.id }, day);
    const finishedFocus = seed.action({ title: 'Finished focus', state: 'completed' });
    seed.focus({ kind: 'action', actionId: finishedFocus.ref.id }, day);
    seed.placement(seed.action({ title: 'Tomorrow' }).ref.id, onDay(tomorrow));
    seed.routine(daily, { title: 'Walk' });
    const stretch = seed.routine(daily, { title: 'Stretch' });
    seed.occurrence(stretch.ref.id, dated(day), { state: 'completed' });
    const rest = seed.routine(daily, { title: 'Rest' });
    seed.occurrence(rest.ref.id, dated(day), { state: 'skipped' });
    seed.routine(weeklyCount, { title: 'Gym' });

    const view = await endDay.getEndDay(day);
    expect(titles(view.open.items)).toEqual([
      'Late night',
      'Scheduled',
      'Flexible',
      'Started',
      'Elsewhere',
      'Inbox focus',
      'Week focus',
      'Routine: Walk',
    ]);
    expect(view.open.total).toBe(8);
    expect(
      view.open.items.map((item) => (item.kind === 'action' ? item.source : 'routine')),
    ).toEqual([
      'scheduled',
      'scheduled',
      'flexible',
      'flexible',
      'flexible',
      'focus',
      'focus',
      'routine',
    ]);
    const blocks = view.open.items.map((item) =>
      item.kind === 'action' ? item.block?.id : undefined,
    );
    expect(blocks[1]).toBe(block.ref.id);
    expect(blocks[3]).toBeUndefined();
    // A planned time on another day is carried so the page can say where to change it.
    expect(blocks[4]).toBe(laterBlock.ref.id);
    expect(titles(view.completed)).toEqual([
      'Done with block',
      'Done flexible',
      'Routine: Stretch',
    ]);
    expect(
      view.completed.map((item) => (item.kind === 'action' ? item.source : 'routine')),
    ).toEqual(['scheduled', 'flexible', 'routine']);
  });

  it('shows at most 200 open items with the full count', async () => {
    for (let index = 0; index < 205; index += 1)
      seed.placement(seed.action({ title: `Item ${String(index)}` }).ref.id, onDay());
    const view = await endDay.getEndDay(day);
    expect(view.open.items).toHaveLength(200);
    expect(view.open.total).toBe(205);
  });

  it('offers the carry date’s focus and candidates, never preselected', async () => {
    const kept = seed.action({ title: 'Already chosen' });
    seed.placement(kept.ref.id, onDay(tomorrow));
    seed.focus({ kind: 'action', actionId: kept.ref.id }, tomorrow);
    const planned = seed.action({ title: 'Planned tomorrow' });
    seed.placement(planned.ref.id, onDay(tomorrow));
    const view = await endDay.getEndDay(day);
    expect(view.nextFocus.date).toBe(tomorrow);
    expect(view.nextFocus.editable).toBe(true);
    expect(view.nextFocus.current.map((item) => item.key)).toEqual([
      focusTargetKey({ kind: 'action', actionId: kept.ref.id }),
    ]);
    expect(
      view.nextFocus.candidates.map((candidate) => [
        candidate.kind === 'action' ? candidate.action.title : '',
        candidate.selected,
      ]),
    ).toEqual([
      ['Already chosen', true],
      ['Planned tomorrow', false],
    ]);
  });

  it('reads only the bounded day statements for the day and its carry date', async () => {
    await endDay.getEndDay(day);
    const methods = new Set(queries.calls.map(({ method }) => method));
    for (const method of methods)
      expect([
        'getPlanProfile',
        'listDayBlocks',
        'listDayActionPlacements',
        'listRoutines',
        'listMaterializedOccurrences',
        'listCapacityConstraints',
        'listDayFocus',
        'listWeekActionPlacements',
        'listWeekCommitmentActions',
        'getFocusAction',
      ]).toContain(method);
    const blockReads = queries.calls.filter(({ method }) => method === 'listDayBlocks');
    const bounds = (date: CalendarDate) => {
      const { endsAt, startsAt } = localDayBounds(date, zone);
      return { startsAt, endsAt };
    };
    expect(blockReads.map(({ args }) => args[1])).toEqual([bounds(day), bounds(tomorrow)]);
  });
});

/* ───────────────────────── applyEndDay ───────────────────────── */

describe('applyEndDay decisions', () => {
  it('carries a flexible Action, keeping its placement id and order key', async () => {
    const action = seed.action({ title: 'Private plan text' });
    const placement = seed.placement(action.ref.id, onDay(), { orderKey: '000000042000000' });
    const receipt = accepted(
      await endDay.applyEndDay(input({ actions: [decide(action, { kind: 'carry' })] })),
    );
    expect(receipt.canonical).toEqual([{ ref: placement.ref, localRevision: 2 }]);
    expect(documentOf(placement)).toEqual({
      target: { kind: 'action', actionId: action.ref.id },
      period: onDay(tomorrow),
      orderKey: '000000042000000',
    });
    expect(documentOf(action)).toEqual(action.document);
    expect(events()).toEqual([['planning.placed', { operation: 'update' }]]);
    expect(receipt.undo.available).toBe(true);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private plan text');
  });

  it('plans and places an Inbox Action that was only in the day’s focus', async () => {
    const action = seed.action({ state: 'inbox' });
    seed.focus({ kind: 'action', actionId: action.ref.id }, day);
    const receipt = accepted(
      await endDay.applyEndDay(input({ actions: [decide(action, { kind: 'carry' })] })),
    );
    expect(documentOf(action)).toMatchObject({ state: 'planned' });
    const created = receipt.canonical[1]?.ref;
    expect(created?.type).toBe('planning_placement');
    expect(harness.unitOfWork.get(entityRefKey(created ?? action.ref))?.document).toEqual({
      target: { kind: 'action', actionId: action.ref.id },
      period: onDay(tomorrow),
      orderKey: defaultPlacementOrderKey,
    });
    expect(events()).toEqual([
      ['action.carried', { operation: 'update' }],
      ['planning.placed', { operation: 'create' }],
    ]);
  });

  it('moves a scheduled Action: its block is skipped and it becomes planned', async () => {
    const action = seed.action({ state: 'scheduled' });
    const placement = seed.placement(action.ref.id, onDay());
    const block = seed.block({ kind: 'action', actionId: action.ref.id }, ...afternoon);
    accepted(
      await endDay.applyEndDay(
        input({
          actions: [decide(action, { kind: 'move', period: { kind: 'week', date: '2026-10-07' } })],
        }),
      ),
    );
    expect(documentOf(action)).toMatchObject({ state: 'planned' });
    expect(documentOf(block)).toMatchObject({ state: 'skipped' });
    expect(documentOf(placement)).toMatchObject({
      period: createWeekPeriod(d('2026-10-07'), 'monday'),
    });
    expect(events()).toEqual([
      ['action.moved', { operation: 'update' }],
      ['time_block.skipped', { operation: 'update' }],
      ['planning.placed', { operation: 'update' }],
    ]);
  });

  it('carries a scheduled Action to the carry date: block skipped, Action planned', async () => {
    const action = seed.action({ state: 'scheduled' });
    const placement = seed.placement(action.ref.id, onDay(), { orderKey: '000000007000000' });
    const block = seed.block({ kind: 'action', actionId: action.ref.id }, ...afternoon);
    const receipt = accepted(
      await endDay.applyEndDay(input({ actions: [decide(action, { kind: 'carry' })] })),
    );
    expect(receipt.canonical.map(({ ref }) => ref.type)).toEqual([
      'action',
      'time_block',
      'planning_placement',
    ]);
    expect(documentOf(action)).toMatchObject({ state: 'planned' });
    expect(documentOf(block)).toMatchObject({ state: 'skipped' });
    expect(documentOf(placement)).toEqual({
      target: { kind: 'action', actionId: action.ref.id },
      period: onDay(tomorrow),
      orderKey: '000000007000000',
    });
    expect(events()).toEqual([
      ['action.carried', { operation: 'update' }],
      ['time_block.skipped', { operation: 'update' }],
      ['planning.placed', { operation: 'update' }],
    ]);
  });

  it('keeps an in-progress Action in progress when it is carried past its block', async () => {
    const action = seed.action({ state: 'in_progress' });
    const placement = seed.placement(action.ref.id, onDay());
    const block = seed.block({ kind: 'action', actionId: action.ref.id }, ...afternoon);
    accepted(await endDay.applyEndDay(input({ actions: [decide(action, { kind: 'carry' })] })));
    expect(documentOf(action)).toEqual(action.document);
    expect(documentOf(block)).toMatchObject({ state: 'skipped' });
    expect(documentOf(placement)).toMatchObject({ period: onDay(tomorrow) });
  });

  it('completes or cancels an Action together with its block on the day, as chosen', async () => {
    const finish = seed.action({ state: 'scheduled' });
    seed.placement(finish.ref.id, onDay());
    const finishBlock = seed.block({ kind: 'action', actionId: finish.ref.id }, ...afternoon);
    const drop = seed.action({ state: 'scheduled' });
    const dropPlacement = seed.placement(drop.ref.id, onDay());
    const dropBlock = seed.block(
      { kind: 'action', actionId: drop.ref.id },
      '2026-09-28T20:00:00.000Z',
      '2026-09-28T21:00:00.000Z',
    );
    const flexible = seed.action();
    seed.placement(flexible.ref.id, onDay());
    accepted(
      await endDay.applyEndDay(
        input({
          actions: [
            decide(finish, { kind: 'complete' }),
            decide(drop, { kind: 'cancel' }),
            decide(flexible, { kind: 'complete' }),
          ],
        }),
      ),
    );
    expect(documentOf(finish)).toMatchObject({ state: 'completed', completedAt: now });
    expect(documentOf(finishBlock)).toMatchObject({ state: 'completed' });
    expect(documentOf(drop)).toMatchObject({ state: 'canceled' });
    expect(documentOf(dropBlock)).toMatchObject({ state: 'canceled' });
    expect(documentOf(dropPlacement)).toEqual(dropPlacement.document);
    expect(documentOf(flexible)).toMatchObject({ state: 'completed', completedAt: now });
    expect(events()).toEqual([
      ['action.completed', { operation: 'update' }],
      ['time_block.completed', { operation: 'update' }],
      ['action.canceled', { operation: 'update' }],
      ['time_block.canceled', { operation: 'update' }],
      ['action.completed', { operation: 'update' }],
    ]);
  });

  it('completes and skips the day’s dated occurrences, materializing when needed', async () => {
    const walk = seed.routine(daily, { title: 'Walk' });
    const stretch = seed.routine(daily, { title: 'Stretch' });
    const stored = seed.occurrence(stretch.ref.id, dated(day));
    const receipt = accepted(
      await endDay.applyEndDay(
        input({
          occurrences: [
            { occurrence: occurrenceTarget(walk, day), decision: { kind: 'complete' } },
            { occurrence: occurrenceTarget(stretch, day, 1), decision: { kind: 'skip' } },
          ],
        }),
      ),
    );
    const walkRef = receipt.canonical[0]?.ref;
    expect(walkRef?.type).toBe('routine_occurrence');
    expect(harness.unitOfWork.get(entityRefKey(walkRef ?? walk.ref))?.document).toMatchObject({
      routineId: walk.ref.id,
      state: 'completed',
      completedAt: now,
    });
    expect(documentOf(stored)).toMatchObject({ state: 'skipped' });
    expect(events()).toEqual([
      ['routine_occurrence.completed', { operation: 'create' }],
      ['routine_occurrence.skipped', { operation: 'update' }],
    ]);
  });

  it('writes the carry date’s focus in the same command, and omitting it leaves it alone', async () => {
    const kept = seed.action();
    seed.placement(kept.ref.id, onDay(tomorrow));
    seed.focus({ kind: 'action', actionId: kept.ref.id }, tomorrow, {
      orderKey: spacedOrderKey(0),
    });
    const carried = seed.action();
    seed.placement(carried.ref.id, onDay());
    const keptKey = `action:${kept.ref.id}`;
    const carriedKey = `action:${carried.ref.id}`;

    accepted(await endDay.applyEndDay(input({ actions: [decide(carried, { kind: 'carry' })] })));
    expect(activeFocus(tomorrow)).toEqual([keptKey]);

    harness.unitOfWork.state.events.length = 0;
    accepted(
      await endDay.applyEndDay(
        input({
          nextFocus: [
            { kind: 'action', actionId: carried.ref.id },
            { kind: 'action', actionId: kept.ref.id },
          ],
        }),
      ),
    );
    expect(activeFocus(tomorrow)).toEqual([carriedKey, keptKey]);
    expect(events()).toEqual([
      ['focus.reordered', { operation: 'update' }],
      ['focus.added', { operation: 'create' }],
    ]);
  });

  it('applies everything in one command whose events carry only the operation', async () => {
    const carried = seed.action({ title: 'Secret one' });
    seed.placement(carried.ref.id, onDay());
    const done = seed.action({ title: 'Secret two' });
    seed.placement(done.ref.id, onDay());
    const walk = seed.routine(daily, { title: 'Secret walk' });
    const receipt = accepted(
      await endDay.applyEndDay(
        input({
          actions: [decide(carried, { kind: 'carry' }), decide(done, { kind: 'complete' })],
          occurrences: [{ occurrence: occurrenceTarget(walk, day), decision: { kind: 'skip' } }],
          nextFocus: [{ kind: 'action', actionId: carried.ref.id }],
        }),
      ),
    );
    expect(harness.unitOfWork.state.receipts.size).toBe(1);
    expect(harness.unitOfWork.state.undo).toHaveLength(1);
    expect(harness.unitOfWork.state.undo[0]?.descriptor.commandType).toBe('planning.restore_v1');
    expect(receipt.eventIds).toHaveLength(harness.unitOfWork.state.events.length);
    for (const { event } of harness.unitOfWork.state.events)
      expect(Object.keys(event.payload)).toEqual(['operation']);
    expect(harness.unitOfWork.state.events.map(({ event }) => event.eventType)).not.toContain(
      endDayEventType,
    );
    const text = JSON.stringify(harness.unitOfWork.state.events);
    for (const secret of ['Secret one', 'Secret two', 'Secret walk'])
      expect(text).not.toContain(secret);
  });

  it('returns the stored receipt for a repeated command id', async () => {
    const action = seed.action();
    seed.placement(action.ref.id, onDay());
    const commandId = 'c0000000-0000-4000-8000-000000000001' as CommandId;
    const request = input({ actions: [decide(action, { kind: 'carry' })] });
    const first = accepted(await endDay.applyEndDay(request, commandId));
    const second = accepted(await endDay.applyEndDay(request, commandId));
    expect(second).toEqual(first);
    expect(harness.unitOfWork.state.events).toHaveLength(1);
  });
});

describe('applyEndDay undo', () => {
  it('restores everything in one step and leaves a later unrelated change untouched', async () => {
    const carried = seed.action();
    const carriedPlacement = seed.placement(carried.ref.id, onDay());
    const scheduled = seed.action({ state: 'scheduled' });
    const scheduledPlacement = seed.placement(scheduled.ref.id, onDay());
    const block = seed.block({ kind: 'action', actionId: scheduled.ref.id }, ...afternoon);
    const inbox = seed.action({ state: 'inbox' });
    seed.focus({ kind: 'action', actionId: inbox.ref.id }, day);
    const walk = seed.routine(daily, { title: 'Walk' });
    const tomorrowFocus = seed.action();
    const replaced = seed.focus({ kind: 'action', actionId: tomorrowFocus.ref.id }, tomorrow);
    const unrelated = seed.action({ title: 'Captured later' });
    const before = [carried, carriedPlacement, scheduled, scheduledPlacement, block, inbox];

    const receipt = accepted(
      await endDay.applyEndDay(
        input({
          actions: [
            decide(carried, { kind: 'carry' }),
            decide(scheduled, { kind: 'complete' }),
            decide(inbox, { kind: 'move', period: { kind: 'month', date: '2026-10-01' } }),
          ],
          occurrences: [
            { occurrence: occurrenceTarget(walk, day), decision: { kind: 'complete' } },
          ],
          nextFocus: [{ kind: 'action', actionId: carried.ref.id }],
        }),
      ),
    );
    const createdRefs = receipt.canonical
      .filter(({ localRevision }) => localRevision === 1)
      .map(({ ref }) => ref);
    expect(createdRefs.map((ref) => ref.type).sort()).toEqual([
      'focus_selection',
      'planning_placement',
      'routine_occurrence',
    ]);

    // A later, unrelated change: the person places another Action.
    const planning = createPlanningApplication(
      harness.dependencies,
      createTestPlanningQueries(harness.unitOfWork, profile),
    );
    accepted(
      await planning.place({
        target: { kind: 'action', id: unrelated.ref.id, revision: 1 },
        period: { kind: 'day', date: tomorrow },
      }),
    );
    const laterPlacement = [...harness.unitOfWork.state.records.values()].find(
      (record) =>
        record.ref.type === 'planning_placement' &&
        (record.document as { target: { actionId?: string } }).target.actionId === unrelated.ref.id,
    );
    const laterSnapshot = laterPlacement === undefined ? undefined : { ...laterPlacement };

    accepted(await undo(receipt));
    for (const record of before)
      expect(documentOf(record), record.ref.type).toEqual(record.document);
    expect(documentOf(replaced)).toEqual(replaced.document);
    expect(activeFocus(tomorrow)).toEqual([`action:${tomorrowFocus.ref.id}`]);
    for (const ref of createdRefs) {
      const document = harness.unitOfWork.get(entityRefKey(ref))?.document;
      if (ref.type === 'routine_occurrence') expect(document).toMatchObject({ state: 'planned' });
      else expect(document).toHaveProperty('archivedAt');
    }
    expect(
      harness.unitOfWork.get(
        entityRefKey(createdRefs.find((ref) => ref.type === 'routine_occurrence') ?? walk.ref),
      )?.document,
    ).not.toHaveProperty('completedAt');
    // The later placement and its Action are exactly as the later command left them.
    expect(laterPlacement).toBeDefined();
    expect(
      laterPlacement === undefined
        ? undefined
        : harness.unitOfWork.get(entityRefKey(laterPlacement.ref)),
    ).toEqual(laterSnapshot);
    expect(documentOf(unrelated)).toEqual(unrelated.document);
    expect(revisionOf(unrelated)).toBe(1);
  });
});

describe('applyEndDay refusals write nothing', () => {
  it('refuses a move into the past or onto a Year', async () => {
    const action = seed.action();
    seed.placement(action.ref.id, onDay());
    const move = (kind: 'day' | 'week' | 'month' | 'year', date: string) =>
      endDay.applyEndDay(
        input({ actions: [decide(action, { kind: 'move', period: { kind, date } })] }),
      );
    expect(await refusedWithoutWrites(() => move('day', '2026-09-27'))).toBe('move_period_past');
    expect(await refusedWithoutWrites(() => move('week', '2026-09-20'))).toBe('move_period_past');
    expect(await refusedWithoutWrites(() => move('month', '2026-08-15'))).toBe('move_period_past');
    expect(await refusedWithoutWrites(() => move('year', '2027-01-01'))).toBe(
      'placement_not_allowed',
    );
  });

  it('refuses a later day and a carry date the day has moved past', async () => {
    const action = seed.action();
    seed.placement(action.ref.id, onDay(tomorrow));
    expect(
      await refusedWithoutWrites(() =>
        endDay.applyEndDay(
          input({
            date: tomorrow,
            carryTo: '2026-09-30',
            actions: [decide(action, { kind: 'carry' })],
          }),
        ),
      ),
    ).toBe('end_day_future');
    // Yesterday's End Day was opened on the 28th (carry to the 28th); it is now the 29th.
    const earlier = seed.action();
    seed.placement(earlier.ref.id, onDay('2026-09-27'));
    harness.setNow('2026-09-29T13:00:00.000Z' as Instant);
    expect(
      await refusedWithoutWrites(() =>
        endDay.applyEndDay(
          input({
            date: '2026-09-27',
            carryTo: day,
            actions: [decide(earlier, { kind: 'carry' })],
          }),
        ),
      ),
    ).toBe('end_day_day_changed');
  });

  it('refuses an Action that is not on the day', async () => {
    const action = seed.action();
    seed.placement(action.ref.id, onDay(tomorrow));
    expect(
      await refusedWithoutWrites(() =>
        endDay.applyEndDay(input({ actions: [decide(action, { kind: 'carry' })] })),
      ),
    ).toBe('not_on_day');
  });

  it('refuses any choice for an Action with a planned time on another day', async () => {
    const action = seed.action({ state: 'in_progress' });
    seed.placement(action.ref.id, onDay());
    seed.block(
      { kind: 'action', actionId: action.ref.id },
      '2026-09-30T18:00:00.000Z',
      '2026-09-30T19:00:00.000Z',
    );
    for (const kind of ['carry', 'complete', 'cancel'] as const)
      expect(
        await refusedWithoutWrites(() =>
          endDay.applyEndDay(input({ actions: [decide(action, { kind })] })),
        ),
      ).toBe('scheduled_elsewhere');
  });

  it('refuses a finished Action, and a valid choice before it is not written either', async () => {
    const open = seed.action();
    seed.placement(open.ref.id, onDay());
    const done = seed.action({ state: 'completed' });
    seed.placement(done.ref.id, onDay());
    expect(
      await refusedWithoutWrites(() =>
        endDay.applyEndDay(
          input({
            actions: [decide(open, { kind: 'carry' }), decide(done, { kind: 'carry' })],
          }),
        ),
      ),
    ).toBe('already_finished');
  });

  it('refuses focus on an Action the same command completes or cancels', async () => {
    const action = seed.action();
    seed.placement(action.ref.id, onDay());
    for (const kind of ['complete', 'cancel'] as const)
      expect(
        await refusedWithoutWrites(() =>
          endDay.applyEndDay(
            input({
              actions: [decide(action, { kind })],
              nextFocus: [{ kind: 'action', actionId: action.ref.id }],
            }),
          ),
        ),
      ).toBe('focus_conflicts_decision');
  });

  it('refuses more focus than a day holds, and the same item twice', async () => {
    const actions = [seed.action(), seed.action(), seed.action(), seed.action()];
    const targets: FocusTargetInput[] = actions.map((record) => ({
      kind: 'action',
      actionId: record.ref.id,
    }));
    expect(
      await refusedWithoutWrites(() => endDay.applyEndDay(input({ nextFocus: targets }))),
    ).toBe('selection_limit');
    const first = targets[0];
    if (first === undefined) throw new Error('Missing target.');
    expect(
      await refusedWithoutWrites(() => endDay.applyEndDay(input({ nextFocus: [first, first] }))),
    ).toBe('focus_duplicate');
  });

  it('refuses more than the End Day limits before reading the plan', async () => {
    const action = seed.action();
    const many = Array.from({ length: 201 }, (_, index) => ({
      actionId: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      revision: 1,
      decision: { kind: 'carry' as const },
    }));
    expect(await refusedWithoutWrites(() => endDay.applyEndDay(input({ actions: many })))).toBe(
      'end_day_limit',
    );
    const walk = seed.routine(daily);
    const occurrences = Array.from({ length: 101 }, (_, index) => ({
      occurrence: occurrenceTarget(walk, `2026-09-${String((index % 28) + 1).padStart(2, '0')}`),
      decision: { kind: 'skip' as const },
    }));
    expect(await refusedWithoutWrites(() => endDay.applyEndDay(input({ occurrences })))).toBe(
      'end_day_limit',
    );
    expect(queries.calls.map(({ method }) => method)).toEqual(['getPlanProfile', 'getPlanProfile']);
    expect(documentOf(action)).toEqual(action.document);
  });

  it('refuses the same Action or occurrence twice, and a malformed choice', async () => {
    const action = seed.action();
    seed.placement(action.ref.id, onDay());
    const walk = seed.routine(daily);
    const twice = [decide(action, { kind: 'carry' }), decide(action, { kind: 'complete' })];
    expect(await refusedWithoutWrites(() => endDay.applyEndDay(input({ actions: twice })))).toBe(
      'duplicate_action',
    );
    const skip = { occurrence: occurrenceTarget(walk, day), decision: { kind: 'skip' as const } };
    expect(
      await refusedWithoutWrites(() => endDay.applyEndDay(input({ occurrences: [skip, skip] }))),
    ).toBe('duplicate_occurrence');
    const unknown = {
      ...decide(action, { kind: 'carry' }),
      decision: { kind: 'later' },
    } as unknown as EndDayInput['actions'][number];
    expect(
      await refusedWithoutWrites(() => endDay.applyEndDay(input({ actions: [unknown] }))),
    ).toBe('end_day_decision');
  });

  it('refuses an occurrence that is not a dated occurrence of the day', async () => {
    const walk = seed.routine(daily);
    expect(
      await refusedWithoutWrites(() =>
        endDay.applyEndDay(
          input({
            occurrences: [
              { occurrence: occurrenceTarget(walk, tomorrow), decision: { kind: 'complete' } },
            ],
          }),
        ),
      ),
    ).toBe('not_on_day');
    const gym = seed.routine(weeklyCount);
    const week = createWeekPeriod(day, 'monday');
    expect(
      await refusedWithoutWrites(() =>
        endDay.applyEndDay(
          input({
            occurrences: [
              {
                occurrence: {
                  routineId: gym.ref.id,
                  generation: 1,
                  period: {
                    kind: 'week',
                    start: week.start,
                    end: week.end,
                    weekStart: week.weekStart,
                    targetCount: 3,
                  },
                },
                decision: { kind: 'complete' },
              },
            ],
          }),
        ),
      ),
    ).toBe('not_on_day');
  });

  it('refuses a stale Action revision and an empty request', async () => {
    const action = seed.action({}, { revision: 3 });
    seed.placement(action.ref.id, onDay());
    expect(
      await refusedWithoutWrites(() =>
        endDay.applyEndDay(
          input({
            actions: [{ actionId: action.ref.id, revision: 2, decision: { kind: 'carry' } }],
          }),
        ),
      ),
    ).toBe('revision_conflict');
    expect(await refusedWithoutWrites(() => endDay.applyEndDay(input()))).toBe('no_change');
  });
});
