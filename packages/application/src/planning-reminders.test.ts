import {
  entityRefKey,
  type CalendarDate,
  type CommandId,
  type EntityRef,
  type EntityType,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type RecurrenceRuleV1,
  type RoutineSchedulingMode,
  type UUID,
  type WallTime,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import { createPlanningApplication } from './planning';
import type {
  PlanProfile,
  PlanningApplication,
  PlanningReminderDocument,
  TimeBlockDocument,
} from './planning-contracts';
import { createTestPlanningQueries } from './planning-routines-test-queries';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';
import { createTodaySeeder, type TodaySeeder } from './testing/today-test-queries';

/*
 * Review Time Block and timed Routine reminder definitions through the planning
 * facade: set, replace, turn off, the rules for which targets accept one, a block's reminder
 * following a superseding block, a Routine archive turning its reminder off, grouped undo, command
 * ids, stale revisions, and strict input.
 */

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const zone = 'Asia/Tashkent' as IanaTimeZone;
/** Wednesday 2026-09-30, 09:00 in Tashkent (UTC+5, no clock changes). */
const now = '2026-09-30T04:00:00.000Z' as Instant;
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: zone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};

const daily = (startsOn: string): RecurrenceRuleV1 => ({
  version: 1,
  kind: 'daily',
  intervalDays: 1,
  startsOn: startsOn as CalendarDate,
});
const morning = (
  zonePolicy: { kind: 'follow_profile' } | { kind: 'fixed_zone'; timeZone: string },
) =>
  ({
    kind: 'time_specific',
    wallTime: '07:00' as WallTime,
    durationMinutes: 30,
    zonePolicy,
    gapPolicy: 'shift_forward',
    overlapPolicy: 'earlier_offset',
  }) as RoutineSchedulingMode;

let harness: InMemoryHarness;
let planning: PlanningApplication;
let plan: TodaySeeder;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  planning = createPlanningApplication(harness.dependencies, {
    ...createTestPlanningQueries(harness.unitOfWork, profile),
    listOccurrenceHistory: () => Promise.resolve([]),
  });
  plan = createTodaySeeder(harness.unitOfWork, ownerId, profile);
});

const commandId = (value: number): CommandId =>
  `c0000000-0000-4000-8000-${String(value).padStart(12, '0')}` as CommandId;

function accepted(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function reason(result: ApplicationResult<CommandReceipt>): unknown {
  if (result.ok) throw new Error('Expected a rejection.');
  if (result.error.code !== 'domain_rejected') return result.error.code;
  return result.error.domainError.details?.['reason'] ?? result.error.domainError.code;
}

/** Run a command that must be refused; prove it wrote nothing, and return its reason. */
async function refused(run: () => Promise<ApplicationResult<CommandReceipt>>): Promise<unknown> {
  const snapshot = (): string => {
    const state = harness.unitOfWork.state;
    return JSON.stringify([
      [...state.records.entries()],
      state.events.length,
      state.undo.length,
      state.receipts.size,
    ]);
  };
  const before = snapshot();
  const result = await run();
  expect(snapshot()).toBe(before);
  return reason(result);
}

const current = (ref: EntityRef): CanonicalRecordState | undefined =>
  harness.unitOfWork.get(entityRefKey(ref));

const recordsOf = (type: EntityType): CanonicalRecordState[] =>
  [...harness.unitOfWork.state.records.values()].filter((record) => record.ref.type === type);

const reminders = (): CanonicalRecordState[] => recordsOf('reminder');
const reminder = (): CanonicalRecordState => {
  const [only, ...others] = reminders();
  if (only === undefined || others.length > 0) throw new Error('Expected exactly one reminder.');
  return only;
};
const reminderDocument = (): PlanningReminderDocument =>
  reminder().document as unknown as PlanningReminderDocument;

/** Event types and payloads of the events since `from`. */
const eventsSince = (from: number) =>
  harness.unitOfWork.state.events
    .slice(from)
    .map(({ event }) => [event.eventType, event.aggregate.type, event.payload] as const);

async function undo(receipt: CommandReceipt): Promise<CommandReceipt> {
  if (!receipt.undo.available) throw new Error('No undo.');
  const descriptor = harness.unitOfWork.state.undo.find(
    (record) => record.undoId === (receipt.undo.available ? receipt.undo.undoId : ''),
  );
  expect(descriptor?.descriptor.commandType).toBe('planning.restore_v1');
  return accepted(await planning.undo(receipt.undo.undoId));
}

/** A planned custom block on Thursday 2026-10-01, 10:00-11:00 in Tashkent. */
function seedBlock(options: Parameters<TodaySeeder['block']>[3] = {}): CanonicalRecordState {
  return plan.block(
    { kind: 'custom', title: 'Deep work' },
    '2026-10-01T05:00:00.000Z',
    '2026-10-01T06:00:00.000Z',
    options,
  );
}

const relative15 = { kind: 'relative', minutesBefore: 15 } as const;

describe('Time Block reminders', () => {
  it('sets, replaces, turns off, and sets again one reminder record', async () => {
    const block = seedBlock();
    const first = accepted(
      await planning.setTimeBlockReminder({
        blockId: block.ref.id,
        revision: 1,
        reminder: relative15,
      }),
    );
    expect(reminderDocument()).toEqual({
      timeBlockId: block.ref.id,
      schedule: {
        kind: 'relative',
        remindAt: '2026-10-01T04:45:00.000Z',
        offsetMinutes: -15,
        timeZone: zone,
      },
      state: 'scheduled',
    });
    expect(first.canonical.map(({ ref }) => ref.type)).toEqual(['reminder']);
    expect(eventsSince(0)).toEqual([['reminder.set', 'reminder', { operation: 'create' }]]);
    await expect(planning.getTimeBlockReminder(block.ref.id)).resolves.toEqual({
      reminderId: reminder().ref.id,
      localRevision: 1,
      kind: 'relative',
      remindAt: '2026-10-01T04:45:00.000Z',
      timeZone: zone,
      date: '2026-10-01',
      time: '09:45',
      minutesBefore: 15,
    });
    // The block itself never changes.
    expect(current(block.ref)).toEqual(block);

    accepted(
      await planning.setTimeBlockReminder({
        blockId: block.ref.id,
        revision: 1,
        reminderRevision: 1,
        reminder: { kind: 'at', date: '2026-10-01', time: '08:30' },
      }),
    );
    expect(reminder()).toMatchObject({
      localRevision: 2,
      document: {
        timeBlockId: block.ref.id,
        schedule: { kind: 'at', remindAt: '2026-10-01T03:30:00.000Z', timeZone: zone },
        state: 'scheduled',
      },
    });
    await expect(planning.getTimeBlockReminder(block.ref.id)).resolves.toMatchObject({
      kind: 'at',
      date: '2026-10-01',
      time: '08:30',
    });
    expect((await planning.getTimeBlockReminder(block.ref.id))?.minutesBefore).toBeUndefined();

    accepted(
      await planning.turnOffTimeBlockReminder({ blockId: block.ref.id, reminderRevision: 2 }),
    );
    expect(reminder()).toMatchObject({ localRevision: 3, document: { state: 'canceled' } });
    await expect(planning.getTimeBlockReminder(block.ref.id)).resolves.toBeNull();

    // Setting it again schedules the same record: no second reminder for the block.
    accepted(
      await planning.setTimeBlockReminder({
        blockId: block.ref.id,
        revision: 1,
        reminder: { kind: 'relative', minutesBefore: 0 },
      }),
    );
    expect(reminder()).toMatchObject({
      localRevision: 4,
      document: {
        state: 'scheduled',
        schedule: { kind: 'relative', remindAt: '2026-10-01T05:00:00.000Z', offsetMinutes: 0 },
      },
    });
    expect(eventsSince(0).map(([type, , payload]) => [type, payload])).toEqual([
      ['reminder.set', { operation: 'create' }],
      ['reminder.set', { operation: 'update' }],
      ['reminder.canceled', { operation: 'update' }],
      ['reminder.set', { operation: 'update' }],
    ]);
    for (const { event } of harness.unitOfWork.state.events)
      expect(Object.keys(event.payload)).toEqual(['operation']);
  });

  it('undoes a set, a replace, and a turn-off as one grouped undo each', async () => {
    const block = seedBlock();
    const created = accepted(
      await planning.setTimeBlockReminder({
        blockId: block.ref.id,
        revision: 1,
        reminder: relative15,
      }),
    );
    await undo(created);
    expect(reminder()).toMatchObject({ localRevision: 2, document: { state: 'canceled' } });
    await expect(planning.getTimeBlockReminder(block.ref.id)).resolves.toBeNull();

    accepted(
      await planning.setTimeBlockReminder({
        blockId: block.ref.id,
        revision: 1,
        reminder: relative15,
      }),
    );
    const scheduled = reminder().document;
    const replaced = accepted(
      await planning.setTimeBlockReminder({
        blockId: block.ref.id,
        revision: 1,
        reminderRevision: 3,
        reminder: { kind: 'at', date: '2026-10-01', time: '07:00' },
      }),
    );
    await undo(replaced);
    expect(reminder().document).toEqual(scheduled);

    const off = accepted(
      await planning.turnOffTimeBlockReminder({ blockId: block.ref.id, reminderRevision: 5 }),
    );
    await undo(off);
    expect(reminder().document).toEqual(scheduled);
    await expect(planning.getTimeBlockReminder(block.ref.id)).resolves.toMatchObject({
      minutesBefore: 15,
    });
  });

  it.each([
    ['completed', {}],
    ['skipped', {}],
    ['canceled', {}],
    ['canceled', { supersededById: '50000000-0000-4000-8000-0000000000ff' as UUID }],
  ] as const)('refuses a new reminder for a %s block %j', async (state, extra) => {
    const block = seedBlock({ state, ...extra });
    expect(
      await refused(() =>
        planning.setTimeBlockReminder({
          blockId: block.ref.id,
          revision: 1,
          reminder: relative15,
        }),
      ),
    ).toBe('reminder_block_not_planned');
  });

  it('keeps the reminder when its block is completed, skipped, or canceled', async () => {
    for (const [index, to] of (['completed', 'skipped', 'canceled'] as const).entries()) {
      const block = plan.block(
        { kind: 'custom', title: `Block ${String(index)}` },
        `2026-10-0${String(index + 1)}T05:00:00.000Z`,
        `2026-10-0${String(index + 1)}T06:00:00.000Z`,
      );
      accepted(
        await planning.setTimeBlockReminder({
          blockId: block.ref.id,
          revision: 1,
          reminder: relative15,
        }),
      );
      const before = reminders().find((record) => record.document['timeBlockId'] === block.ref.id);
      accepted(await planning.setBlockState({ blockId: block.ref.id, revision: 1, to }));
      expect(reminders().find((record) => record.document['timeBlockId'] === block.ref.id)).toEqual(
        before,
      );
      // Turning it off is still the person's explicit choice, in any block state.
      accepted(
        await planning.turnOffTimeBlockReminder({ blockId: block.ref.id, reminderRevision: 1 }),
      );
    }
    expect(reminders().every((record) => record.document['state'] === 'canceled')).toBe(true);
  });

  it('moves the reminder to the moved block, resolving a relative one from the new start', async () => {
    const block = seedBlock();
    accepted(
      await planning.setTimeBlockReminder({
        blockId: block.ref.id,
        revision: 1,
        reminder: relative15,
      }),
    );
    const before = reminder();
    const from = harness.unitOfWork.state.events.length;
    const moved = accepted(
      await planning.moveBlock({
        blockId: block.ref.id,
        revision: 1,
        date: '2026-10-02',
        startTime: '14:00',
        durationMinutes: 60,
        overlapAcknowledged: false,
      }),
    );
    const replacement = recordsOf('time_block').find((record) => record.ref.id !== block.ref.id);
    expect(current(block.ref)?.document).toMatchObject({
      state: 'canceled',
      supersededById: replacement?.ref.id,
    });
    expect(reminder()).toMatchObject({
      ref: before.ref,
      localRevision: 2,
      document: {
        timeBlockId: replacement?.ref.id,
        schedule: { kind: 'relative', remindAt: '2026-10-02T08:45:00.000Z', offsetMinutes: -15 },
        state: 'scheduled',
      },
    });
    expect(moved.canonical.map(({ ref }) => ref.type).sort()).toEqual([
      'reminder',
      'time_block',
      'time_block',
    ]);
    expect(
      eventsSince(from).every(
        ([type, , payload]) => type === 'planning.block_moved' && Object.keys(payload).length === 1,
      ),
    ).toBe(true);
    await expect(planning.getTimeBlockReminder(block.ref.id)).resolves.toBeNull();
    await expect(planning.getTimeBlockReminder(replacement?.ref.id ?? '')).resolves.toMatchObject({
      minutesBefore: 15,
      date: '2026-10-02',
      time: '13:45',
    });

    // One undo restores the block and its reminder exactly.
    await undo(moved);
    expect(current(block.ref)?.document).toEqual(block.document);
    expect(reminder().document).toEqual(before.document);
  });

  it('keeps a reminder at a chosen time where it is when its block moves', async () => {
    const block = seedBlock();
    accepted(
      await planning.setTimeBlockReminder({
        blockId: block.ref.id,
        revision: 1,
        reminder: { kind: 'at', date: '2026-09-30', time: '20:00' },
      }),
    );
    const schedule = reminderDocument().schedule;
    accepted(
      await planning.moveBlock({
        blockId: block.ref.id,
        revision: 1,
        date: '2026-10-03',
        startTime: '09:00',
        durationMinutes: 30,
        overlapAcknowledged: false,
      }),
    );
    expect(reminderDocument().schedule).toEqual(schedule);
    expect(reminderDocument()).not.toHaveProperty('timeBlockId', block.ref.id);
  });

  it('moves the reminder to a shortened block, and when an Action is rescheduled', async () => {
    const block = seedBlock();
    accepted(
      await planning.setTimeBlockReminder({
        blockId: block.ref.id,
        revision: 1,
        reminder: relative15,
      }),
    );
    const schedule = reminderDocument().schedule;
    const shortened = accepted(
      await planning.shortenBlock({ blockId: block.ref.id, revision: 1, durationMinutes: 30 }),
    );
    const shorter = shortened.canonical.find(
      ({ ref }) => ref.type === 'time_block' && ref.id !== block.ref.id,
    );
    expect(reminderDocument()).toEqual({
      timeBlockId: shorter?.ref.id,
      schedule,
      state: 'scheduled',
    });

    const action = plan.action({ state: 'scheduled' });
    const actionBlock = plan.block(
      { kind: 'action', actionId: action.ref.id },
      '2026-10-05T05:00:00.000Z',
      '2026-10-05T06:00:00.000Z',
    );
    accepted(
      await planning.setTimeBlockReminder({
        blockId: actionBlock.ref.id,
        revision: 1,
        reminder: { kind: 'relative', minutesBefore: 60 },
      }),
    );
    accepted(
      await planning.scheduleAction({
        actionId: action.ref.id,
        revision: 1,
        date: '2026-10-06',
        startTime: '08:00',
        durationMinutes: 45,
        overlapAcknowledged: false,
      }),
    );
    const rescheduled = recordsOf('time_block').find(
      (record) =>
        (record.document as unknown as TimeBlockDocument).target.kind === 'action' &&
        record.ref.id !== actionBlock.ref.id,
    );
    expect(
      reminders().find((record) => record.document['timeBlockId'] === rescheduled?.ref.id)
        ?.document,
    ).toMatchObject({
      schedule: { kind: 'relative', remindAt: '2026-10-06T02:00:00.000Z', offsetMinutes: -60 },
      state: 'scheduled',
    });
    await expect(planning.getTimeBlockReminder(actionBlock.ref.id)).resolves.toBeNull();
  });

  it('leaves a reminder that is off with the old block', async () => {
    const block = seedBlock();
    accepted(
      await planning.setTimeBlockReminder({
        blockId: block.ref.id,
        revision: 1,
        reminder: relative15,
      }),
    );
    accepted(
      await planning.turnOffTimeBlockReminder({ blockId: block.ref.id, reminderRevision: 1 }),
    );
    const off = reminder();
    accepted(
      await planning.moveBlock({
        blockId: block.ref.id,
        revision: 1,
        date: '2026-10-02',
        startTime: '10:00',
        durationMinutes: 60,
        overlapAcknowledged: false,
      }),
    );
    expect(reminder()).toEqual(off);
  });

  it('returns the receipt of a repeated command id and refuses stale revisions', async () => {
    const block = seedBlock();
    const input = { blockId: block.ref.id, revision: 1, reminder: relative15 };
    const first = accepted(await planning.setTimeBlockReminder(input, commandId(1)));
    const again = accepted(await planning.setTimeBlockReminder(input, commandId(1)));
    expect(again).toEqual(first);
    expect(reminders()).toHaveLength(1);
    expect(harness.unitOfWork.state.events).toHaveLength(1);

    // The person saw no reminder, but one is scheduled now.
    expect(await refused(() => planning.setTimeBlockReminder(input))).toBe('reminder_changed');
    // The person saw a reminder that is no longer the current revision.
    expect(
      await refused(() => planning.setTimeBlockReminder({ ...input, reminderRevision: 7 })),
    ).toBe('revision_conflict');
    expect(
      await refused(() =>
        planning.turnOffTimeBlockReminder({ blockId: block.ref.id, reminderRevision: 2 }),
      ),
    ).toBe('revision_conflict');
    // The block changed since the person saw it.
    expect(
      await refused(() =>
        planning.setTimeBlockReminder({ ...input, revision: 2, reminderRevision: 1 }),
      ),
    ).toBe('revision_conflict');
    // Nothing is shown, so nothing can be turned off; and the same time again changes nothing.
    accepted(
      await planning.turnOffTimeBlockReminder({ blockId: block.ref.id, reminderRevision: 1 }),
    );
    expect(
      await refused(() =>
        planning.turnOffTimeBlockReminder({ blockId: block.ref.id, reminderRevision: 2 }),
      ),
    ).toBe('reminder_not_scheduled');
    expect(
      await refused(() => planning.setTimeBlockReminder({ ...input, reminderRevision: 2 })),
    ).toBe('reminder_changed');
    accepted(await planning.setTimeBlockReminder(input));
    expect(
      await refused(() => planning.setTimeBlockReminder({ ...input, reminderRevision: 3 })),
    ).toBe('no_change');
    expect(
      await refused(() =>
        planning.setTimeBlockReminder({
          ...input,
          blockId: '50000000-0000-4000-8000-0000000000ee',
        }),
      ),
    ).toBe('entity_not_found');
  });

  it.each([
    ['a malformed date', { kind: 'at', date: '2026-02-30', time: '08:00' }, 'reminder_date'],
    ['a malformed time', { kind: 'at', date: '2026-10-01', time: '8 am' }, 'reminder_time'],
    // Midnight on 1 January 0000 in Tashkent is the year before in UTC: no instant to store.
    [
      'a date with no storable instant',
      { kind: 'at', date: '0000-01-01', time: '00:00' },
      'reminder_date',
    ],
    ['an offset above seven days', { kind: 'relative', minutesBefore: 10_081 }, 'reminder_offset'],
    ['a negative offset', { kind: 'relative', minutesBefore: -5 }, 'reminder_offset'],
    ['a fractional offset', { kind: 'relative', minutesBefore: 2.5 }, 'reminder_offset'],
    ['an unexpected reminder field', { ...relative15, remindAt: now }, 'reminder_fields'],
    ['an unknown reminder kind', { kind: 'daily', minutesBefore: 15 }, 'reminder_kind'],
    ['no reminder object', 'in 15 minutes', 'reminder_shape'],
  ])('refuses %s without writing', async (_name, value, expected) => {
    const block = seedBlock();
    expect(
      await refused(() =>
        planning.setTimeBlockReminder({
          blockId: block.ref.id,
          revision: 1,
          reminder: value as never,
        }),
      ),
    ).toBe(expected);
  });

  it.each([
    ['an unexpected field', { extra: true }],
    ['a malformed block id', { blockId: 'block-1' }],
    ['a zero revision', { revision: 0 }],
    ['a fractional reminder revision', { reminderRevision: 1.5 }],
  ])('refuses a request with %s', async (_name, change) => {
    const block = seedBlock();
    expect(
      await refused(() =>
        planning.setTimeBlockReminder({
          blockId: block.ref.id,
          revision: 1,
          reminder: relative15,
          ...change,
        }),
      ),
    ).toBe('reminder_input');
    expect(
      await refused(() =>
        planning.turnOffTimeBlockReminder({
          blockId: block.ref.id,
          reminderRevision: 1,
          ...change,
        }),
      ),
    ).toBe('reminder_input');
  });

  it('reads no reminder for a malformed or unknown block id', async () => {
    await expect(planning.getTimeBlockReminder('not-a-block')).resolves.toBeNull();
    await expect(
      planning.getTimeBlockReminder('50000000-0000-4000-8000-0000000000ee'),
    ).resolves.toBeNull();
  });
});

describe('timed Routine reminders', () => {
  const routineRef = (record: CanonicalRecordState) => record.ref as EntityRef<'routine'>;

  it('sets a reminder before each occurrence from the next one whose reminder is ahead', async () => {
    const routine = plan.routine(daily('2026-09-01'), {
      schedulingMode: morning({ kind: 'follow_profile' }),
    });
    // 09:00 local: today's 07:00 occurrence has passed, so tomorrow's anchors the reminder.
    const receipt = accepted(
      await planning.setRoutineReminder({
        routineId: routine.ref.id,
        revision: 1,
        reminder: { minutesBefore: 15 },
      }),
    );
    expect(reminderDocument()).toEqual({
      routineId: routine.ref.id,
      schedule: {
        kind: 'relative',
        remindAt: '2026-10-01T01:45:00.000Z',
        offsetMinutes: -15,
        timeZone: zone,
      },
      state: 'scheduled',
    });
    expect(receipt.canonical.map(({ ref }) => ref.type)).toEqual(['reminder']);
    const detail = await planning.getRoutine(routine.ref.id);
    expect(detail?.reminder).toEqual({
      reminderId: reminder().ref.id,
      localRevision: 1,
      kind: 'relative',
      remindAt: '2026-10-01T01:45:00.000Z',
      timeZone: zone,
      date: '2026-10-01',
      time: '06:45',
      minutesBefore: 15,
    });
    expect(current(routineRef(routine))).toEqual(routine);
  });

  it.each([
    // 06:50 local: a 5-minute reminder for today's 07:00 is still ahead; a 15-minute one is not.
    ['2026-09-30T01:50:00.000Z', 5, '2026-09-30T01:55:00.000Z'],
    ['2026-09-30T01:50:00.000Z', 15, '2026-10-01T01:45:00.000Z'],
    ['2026-09-30T01:45:00.000Z', 15, '2026-09-30T01:45:00.000Z'],
    // A week ahead.
    // A week ahead: the 7 October occurrence is less than a week away, so the 8th anchors it.
    ['2026-09-30T04:00:00.000Z', 10_080, '2026-10-01T02:00:00.000Z'],
  ])('at %s, %i minutes before is due at %s', async (at, minutesBefore, remindAt) => {
    harness.setNow(at as Instant);
    const routine = plan.routine(daily('2026-09-01'), {
      schedulingMode: morning({ kind: 'follow_profile' }),
    });
    accepted(
      await planning.setRoutineReminder({
        routineId: routine.ref.id,
        revision: 1,
        reminder: { minutesBefore },
      }),
    );
    expect(reminderDocument().schedule).toMatchObject({ remindAt, offsetMinutes: -minutesBefore });
  });

  it('skips a skipped occurrence and uses the occurrence zone of a fixed-zone Routine', async () => {
    const routine = plan.routine(daily('2026-09-01'), {
      schedulingMode: morning({ kind: 'fixed_zone', timeZone: 'Europe/Berlin' }),
    });
    // 07:00 in Berlin (UTC+2) is 05:00Z, still ahead at 04:00Z; it is skipped, so tomorrow's
    // occurrence anchors the reminder, in Berlin time.
    plan.occurrence(
      routine.ref.id,
      { kind: 'date', date: '2026-09-30' as CalendarDate },
      {
        state: 'skipped',
      },
    );
    accepted(
      await planning.setRoutineReminder({
        routineId: routine.ref.id,
        revision: 1,
        reminder: { minutesBefore: 30 },
      }),
    );
    expect(reminderDocument().schedule).toEqual({
      kind: 'relative',
      remindAt: '2026-10-01T04:30:00.000Z',
      offsetMinutes: -30,
      timeZone: 'Europe/Berlin',
    });
  });

  it('anchors on an occurrence still ahead in a zone more than a day behind the planning zone', async () => {
    // 10:30Z on 1 October is 00:30 on 2 October in Kiritimati (UTC+14), the planning zone, but
    // 23:30 on 30 September in Pago Pago (UTC-11), where that day's 23:45 occurrence is still ahead.
    const farProfile: PlanProfile = {
      ...profile,
      planningTimeZone: 'Pacific/Kiritimati' as IanaTimeZone,
    };
    const far = createInMemoryHarness(ownerId, '2026-10-01T10:30:00.000Z' as Instant);
    const farPlanning = createPlanningApplication(far.dependencies, {
      ...createTestPlanningQueries(far.unitOfWork, farProfile),
      listOccurrenceHistory: () => Promise.resolve([]),
    });
    const routine = createTodaySeeder(far.unitOfWork, ownerId, farProfile).routine(
      daily('2026-09-01'),
      {
        schedulingMode: {
          ...morning({ kind: 'fixed_zone', timeZone: 'Pacific/Pago_Pago' }),
          wallTime: '23:45' as WallTime,
        } as RoutineSchedulingMode,
      },
    );
    accepted(
      await farPlanning.setRoutineReminder({
        routineId: routine.ref.id,
        revision: 1,
        reminder: { minutesBefore: 0 },
      }),
    );
    const stored = [...far.unitOfWork.state.records.values()].find(
      (record) => record.ref.type === 'reminder',
    );
    expect(stored?.document['schedule']).toEqual({
      kind: 'relative',
      remindAt: '2026-10-01T10:45:00.000Z',
      offsetMinutes: 0,
      timeZone: 'Pacific/Pago_Pago',
    });
  });

  it('finds the next occurrence of a Routine that repeats less often than once a year', async () => {
    // Every twelve months on the 29th, skipping months without one (the form's default), from a
    // February: only 29 February happens, so after 30 September 2026 the next is 29 February 2028.
    const routine = plan.routine(
      {
        version: 1,
        kind: 'monthly_day',
        intervalMonths: 12,
        dayOfMonth: 29,
        missingDayPolicy: 'skip',
        startsOn: '2024-02-01' as CalendarDate,
      },
      { schedulingMode: morning({ kind: 'follow_profile' }) },
    );
    accepted(
      await planning.setRoutineReminder({
        routineId: routine.ref.id,
        revision: 1,
        reminder: { minutesBefore: 15 },
      }),
    );
    expect(reminderDocument().schedule).toEqual({
      kind: 'relative',
      remindAt: '2028-02-29T01:45:00.000Z',
      offsetMinutes: -15,
      timeZone: zone,
    });

    // A skipped 29 February 2028 is passed over for 2032, and a new Routine finds it too.
    const skipped = plan.routine(
      {
        version: 1,
        kind: 'monthly_day',
        intervalMonths: 12,
        dayOfMonth: 29,
        missingDayPolicy: 'skip',
        startsOn: '2024-02-01' as CalendarDate,
      },
      { title: 'Leap day walk', schedulingMode: morning({ kind: 'follow_profile' }) },
    );
    plan.occurrence(
      skipped.ref.id,
      { kind: 'date', date: '2028-02-29' as CalendarDate },
      { state: 'skipped' },
    );
    accepted(
      await planning.setRoutineReminder({
        routineId: skipped.ref.id,
        revision: 1,
        reminder: { minutesBefore: 15 },
      }),
    );
    expect(
      reminders().find((record) => record.document['routineId'] === skipped.ref.id)?.document,
    ).toMatchObject({ schedule: { remindAt: '2032-02-29T01:45:00.000Z' } });
    const created = accepted(
      await planning.createRoutine({
        title: 'Leap day run',
        rule: {
          version: 1,
          kind: 'monthly_day',
          intervalMonths: 12,
          dayOfMonth: 29,
          missingDayPolicy: 'skip',
          startsOn: '2026-02-01',
        },
        schedulingMode: morning({ kind: 'follow_profile' }),
        reminder: { minutesBefore: 15 },
      }),
    );
    const createdId = created.canonical.find(({ ref }) => ref.type === 'routine')?.ref.id;
    expect(
      reminders().find((record) => record.document['routineId'] === createdId)?.document,
    ).toMatchObject({ schedule: { remindAt: '2028-02-29T01:45:00.000Z' } });
  });

  it.each([
    [
      'a Routine any time of day',
      { schedulingMode: { kind: 'day_flexible' } },
      'reminder_routine_not_timed',
    ],
    [
      'a paused Routine',
      {
        schedulingMode: morning({ kind: 'follow_profile' }),
        state: 'paused',
        pauseEffectiveOn: '2026-09-30',
      },
      'reminder_routine_not_active',
    ],
    [
      'an archived Routine',
      { schedulingMode: morning({ kind: 'follow_profile' }), state: 'archived' },
      'reminder_routine_not_active',
    ],
  ] as const)('refuses a reminder for %s', async (_name, options, expected) => {
    const routine = plan.routine(daily('2026-09-01'), options as never);
    expect(
      await refused(() =>
        planning.setRoutineReminder({
          routineId: routine.ref.id,
          revision: 1,
          reminder: { minutesBefore: 10 },
        }),
      ),
    ).toBe(expected);
  });

  it('refuses a Routine whose occurrences have all ended', async () => {
    const routine = plan.routine(
      { ...daily('2026-09-01'), endsOn: '2026-09-29' as CalendarDate },
      { schedulingMode: morning({ kind: 'follow_profile' }) },
    );
    expect(
      await refused(() =>
        planning.setRoutineReminder({
          routineId: routine.ref.id,
          revision: 1,
          reminder: { minutesBefore: 10 },
        }),
      ),
    ).toBe('reminder_no_upcoming_occurrence');
  });

  it('turns the reminder off as part of an archive, and a restore leaves it off', async () => {
    const routine = plan.routine(daily('2026-09-01'), {
      schedulingMode: morning({ kind: 'follow_profile' }),
    });
    accepted(
      await planning.setRoutineReminder({
        routineId: routine.ref.id,
        revision: 1,
        reminder: { minutesBefore: 15 },
      }),
    );
    const scheduled = reminder();
    const from = harness.unitOfWork.state.events.length;
    const archived = accepted(
      await planning.archiveRoutine({ routineId: routine.ref.id, revision: 1 }),
    );
    // The receipt names the reminder it turned off: the archive's stated sub-operation.
    expect(archived.canonical.map(({ ref }) => ref.type)).toEqual(['routine', 'reminder']);
    expect(eventsSince(from)).toEqual([
      ['routine.archived', 'routine', { operation: 'update' }],
      ['reminder.canceled', 'reminder', { operation: 'update' }],
    ]);
    expect(reminder()).toMatchObject({ localRevision: 2, document: { state: 'canceled' } });

    accepted(await planning.restoreRoutine({ routineId: routine.ref.id, revision: 2 }));
    expect(current(routineRef(routine))?.document).toMatchObject({ state: 'active' });
    expect(reminder()).toMatchObject({ localRevision: 2, document: { state: 'canceled' } });
    expect((await planning.getRoutine(routine.ref.id))?.reminder).toBeUndefined();

    // Undo of the archive (when nothing else changed) restores both, exactly.
    const other = plan.routine(daily('2026-09-01'), {
      title: 'Evening stretch',
      schedulingMode: morning({ kind: 'follow_profile' }),
    });
    accepted(
      await planning.setRoutineReminder({
        routineId: other.ref.id,
        revision: 1,
        reminder: { minutesBefore: 5 },
      }),
    );
    const otherReminder = reminders().find(
      (record) => record.document['routineId'] === other.ref.id,
    );
    const archivedOther = accepted(
      await planning.archiveRoutine({ routineId: other.ref.id, revision: 1 }),
    );
    await undo(archivedOther);
    expect(current(routineRef(other))?.document).toEqual(other.document);
    expect(
      reminders().find((record) => record.document['routineId'] === other.ref.id)?.document,
    ).toEqual(otherReminder?.document);
    expect(scheduled.document).toMatchObject({ state: 'scheduled' });
  });

  it('archives a Routine without a reminder exactly as before', async () => {
    const routine = plan.routine(daily('2026-09-01'));
    const archived = accepted(
      await planning.archiveRoutine({ routineId: routine.ref.id, revision: 1 }),
    );
    expect(archived.canonical.map(({ ref }) => ref.type)).toEqual(['routine']);
    expect(reminders()).toEqual([]);
  });

  it('creates a Routine with its reminder in one command and undoes both', async () => {
    const created = accepted(
      await planning.createRoutine({
        title: 'Morning run',
        rule: daily('2026-10-01'),
        schedulingMode: morning({ kind: 'follow_profile' }),
        reminder: { minutesBefore: 20 },
      }),
    );
    const routineId = created.canonical.find(({ ref }) => ref.type === 'routine')?.ref.id;
    expect(reminderDocument()).toEqual({
      routineId,
      schedule: {
        kind: 'relative',
        remindAt: '2026-10-01T01:40:00.000Z',
        offsetMinutes: -20,
        timeZone: zone,
      },
      state: 'scheduled',
    });
    expect(eventsSince(0)).toEqual([
      ['routine.created', 'routine', { operation: 'create' }],
      ['reminder.set', 'reminder', { operation: 'create' }],
    ]);
    await undo(created);
    expect(reminderDocument()).toMatchObject({ state: 'canceled' });
    expect(recordsOf('routine')[0]?.document).toMatchObject({ state: 'archived' });
  });

  it('refuses a new Routine with a reminder unless it is at a set time, writing nothing', async () => {
    expect(
      await refused(() =>
        planning.createRoutine({
          title: 'Read',
          rule: daily('2026-10-01'),
          schedulingMode: { kind: 'day_flexible' },
          reminder: { minutesBefore: 20 },
        }),
      ),
    ).toBe('reminder_routine_not_timed');
    expect(
      await refused(() =>
        planning.createRoutine({
          title: 'Read',
          rule: daily('2026-10-01'),
          schedulingMode: morning({ kind: 'follow_profile' }),
          reminder: { minutesBefore: 20, when: 'before' } as never,
        }),
      ),
    ).toBe('reminder_fields');
  });

  it('replaces and turns off a Routine reminder with stale and repeated commands refused', async () => {
    const routine = plan.routine(daily('2026-09-01'), {
      schedulingMode: morning({ kind: 'follow_profile' }),
    });
    const input = { routineId: routine.ref.id, revision: 1, reminder: { minutesBefore: 15 } };
    const first = accepted(await planning.setRoutineReminder(input, commandId(2)));
    expect(accepted(await planning.setRoutineReminder(input, commandId(2)))).toEqual(first);
    expect(await refused(() => planning.setRoutineReminder(input))).toBe('reminder_changed');
    accepted(
      await planning.setRoutineReminder({
        ...input,
        reminderRevision: 1,
        reminder: { minutesBefore: 45 },
      }),
    );
    expect(reminderDocument().schedule).toMatchObject({ offsetMinutes: -45 });
    expect(
      await refused(() =>
        planning.turnOffRoutineReminder({ routineId: routine.ref.id, reminderRevision: 1 }),
      ),
    ).toBe('revision_conflict');
    const off = accepted(
      await planning.turnOffRoutineReminder({ routineId: routine.ref.id, reminderRevision: 2 }),
    );
    expect(reminderDocument().state).toBe('canceled');
    await undo(off);
    expect(reminderDocument()).toMatchObject({
      state: 'scheduled',
      schedule: { offsetMinutes: -45 },
    });
    expect(
      await refused(() =>
        planning.setRoutineReminder({ ...input, revision: 4, reminderRevision: 4 }),
      ),
    ).toBe('revision_conflict');
    expect(
      await refused(() =>
        planning.setRoutineReminder({
          ...input,
          reminderRevision: 4,
          reminder: { minutesBefore: 10_081 },
        }),
      ),
    ).toBe('reminder_offset');
    expect(
      await refused(() =>
        planning.setRoutineReminder({
          ...input,
          reminderRevision: 4,
          reminder: { minutesBefore: 15, timeZone: zone } as never,
        }),
      ),
    ).toBe('reminder_fields');
  });
});
