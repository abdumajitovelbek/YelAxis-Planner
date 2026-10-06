import {
  entityRefKey,
  ok,
  type CalendarDate,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import type { PlanProfile } from './planning-contracts';
import { createPlanningApplication } from './planning';
import { createMutation, updateFrom } from './planning-kit';
import { createTestPlanningQueries } from './planning-routines-test-queries';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';
import {
  createTodaySeeder,
  createTodayTestQueries,
  type TodaySeeder,
} from './testing/today-test-queries';
import { createTodayKit, eventTypesByRecord, requireTodayDate, type TodayKit } from './today-kit';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const profileFor = (zone: string): PlanProfile => ({
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: zone as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
});
const profile = profileFor('America/New_York');
// 23:30 on Sunday 2026-09-27 in New York; already Monday 2026-09-28 in Tashkent.
const now = '2026-09-28T03:30:00.000Z' as Instant;

let harness: InMemoryHarness;
let kit: TodayKit;
let seed: TodaySeeder;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  kit = createTodayKit(harness.dependencies, createTodayTestQueries(harness.unitOfWork, profile));
  seed = createTodaySeeder(harness.unitOfWork, ownerId, profile);
});

const accepted = (result: ApplicationResult<CommandReceipt>): CommandReceipt => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const current = (record: CanonicalRecordState) => harness.unitOfWork.get(entityRefKey(record.ref));

describe('Today kit session', () => {
  it('reads planning today from the injected clock in the Profile planning zone', async () => {
    expect(await kit.session()).toEqual({
      ownerId,
      profile,
      today: '2026-09-27' as CalendarDate,
    });
    const tashkent = createTodayKit(
      harness.dependencies,
      createTodayTestQueries(harness.unitOfWork, profileFor('Asia/Tashkent')),
    );
    expect((await tashkent.session()).today).toBe('2026-09-28');
    harness.setNow('2026-09-28T04:00:00.000Z' as Instant);
    expect((await kit.session()).today).toBe('2026-09-28');
  });

  it('fails without an active identity', async () => {
    const lonely = createTodayKit(
      {
        ...harness.dependencies,
        identityContext: { getActiveIdentity: () => Promise.resolve(null) },
      },
      createTodayTestQueries(harness.unitOfWork, profile),
    );
    await expect(lonely.ownerId()).rejects.toThrow('No active identity');
  });

  it('reads query dates strictly', () => {
    expect(requireTodayDate('2026-09-28')).toBe('2026-09-28');
    for (const value of ['2026-9-28', '2026-02-30', '', 'today'])
      expect(() => requireTodayDate(value)).toThrow(new RangeError('Choose a valid date.'));
  });
});

describe('Today kit commands', () => {
  it('refuses an empty plan as no change and writes nothing', async () => {
    const result = await kit.run(ownerId, undefined, 'focus.set', [], () => ok({ mutations: [] }));
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: {
          code: 'invalid_value',
          message: 'Nothing changed.',
          details: { reason: 'no_change' },
        },
      },
    });
    expect(harness.unitOfWork.state.events).toEqual([]);
    expect(harness.unitOfWork.state.receipts.size).toBe(0);
  });

  it('writes per-record event types with the operation only, and one grouped undo', async () => {
    const action = seed.action({ title: 'Private plan text' });
    const placement = seed.placement(action.ref.id, {
      kind: 'day',
      date: '2026-09-27' as CalendarDate,
    });
    const created = createMutation(
      { type: 'focus_selection', id: kit.nextId(), ownerId },
      {
        kind: 'day_focus',
        profileId: profile.profileId,
        target: { kind: 'action', actionId: action.ref.id },
        periodStart: '2026-09-28',
        periodEnd: '2026-09-28',
        orderKey: '000001000000000',
      },
    );
    const types = eventTypesByRecord();
    const receipt = accepted(
      await kit.run(
        ownerId,
        undefined,
        'day.ended',
        [
          { ref: action.ref, revision: 1 },
          { ref: placement.ref, revision: 1 },
          { ref: action.ref, revision: 1 },
        ],
        ({ records, context }) =>
          records.read(action.ref).then((record) => {
            if (record === null) throw new Error('missing');
            const complete = updateFrom(record, {
              ...record.document,
              state: 'completed',
              completedAt: context.now,
            });
            types.set(complete, 'action.completed');
            types.set(created, 'focus.added');
            return ok({
              mutations: [
                complete,
                updateFrom(placement, { ...placement.document, orderKey: '000009000000000' }),
                created,
              ],
              created: [{ ref: created.ref, kind: 'focus_selection' as const }],
              eventTypeFor: types.eventTypeFor,
            });
          }),
      ),
    );
    expect(
      harness.unitOfWork.state.events.map(({ event }) => [event.eventType, event.payload]),
    ).toEqual([
      ['action.completed', { operation: 'update' }],
      ['day.ended', { operation: 'update' }],
      ['focus.added', { operation: 'create' }],
    ]);
    expect(JSON.stringify(harness.unitOfWork.state.events)).not.toContain('Private plan text');
    expect(receipt.undo.available).toBe(true);
    if (!receipt.undo.available) return;

    const planning = createPlanningApplication(
      harness.dependencies,
      createTestPlanningQueries(harness.unitOfWork, profile),
    );
    accepted(await planning.undo(receipt.undo.undoId));
    expect(current(action)?.document).toEqual(action.document);
    expect(current(placement)?.document).toEqual(placement.document);
    expect(current({ ...action, ref: created.ref })?.document).toMatchObject({
      archivedAt: now,
    });
  });

  it('checks expected revisions before planning', async () => {
    const action = seed.action({}, { revision: 2 });
    let planned = false;
    const result = await kit.run(
      ownerId,
      undefined,
      'focus.set',
      [{ ref: action.ref, revision: 1 }],
      () => {
        planned = true;
        return ok({ mutations: [] });
      },
    );
    expect(result.ok ? '' : result.error.code).toBe('revision_conflict');
    expect(planned).toBe(false);
  });

  it('names the command event type for records without their own', () => {
    const types = eventTypesByRecord();
    const mutation = createMutation({ type: 'action', id: kit.nextId(), ownerId }, {});
    expect(types.eventTypeFor(mutation)).toBeUndefined();
    types.set(mutation, 'action.carried');
    expect(types.eventTypeFor(mutation)).toBe('action.carried');
  });
});
