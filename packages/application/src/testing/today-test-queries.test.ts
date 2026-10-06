import {
  createWeekPeriod,
  type CalendarDate,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PlanProfile } from '../planning-contracts';
import { createInMemoryHarness, type InMemoryHarness } from './in-memory-unit-of-work';
import {
  createTodaySeeder,
  createTodayTestQueries,
  type TodaySeeder,
  type TodayTestQueries,
} from './today-test-queries';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const otherOwner = '10000000-0000-4000-8000-000000000002' as OwnerId;
const now = '2026-09-28T13:00:00.000Z' as Instant;
const d = (value: string) => value as CalendarDate;
const t = (value: string) => value as Instant;
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: 'America/New_York' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
const week = createWeekPeriod(d('2026-09-28'), 'monday');
const day = { kind: 'day' as const, date: d('2026-09-28') };

let harness: InMemoryHarness;
let queries: TodayTestQueries;
let seed: TodaySeeder;

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  queries = createTodayTestQueries(harness.unitOfWork, profile);
  seed = createTodaySeeder(harness.unitOfWork, ownerId, profile);
});

describe('Today test queries', () => {
  it('lists day blocks within the 48-hour lookback, in start order, and logs the bounds', async () => {
    const custom = (title: string) => ({ kind: 'custom' as const, title });
    const late = seed.block(custom('Late'), '2026-09-28T20:00:00.000Z', '2026-09-28T21:00:00.000Z');
    const long = seed.block(custom('Long'), '2026-09-27T05:00:00.000Z', '2026-09-28T05:00:00.000Z');
    seed.block(custom('Too early'), '2026-09-26T03:00:00.000Z', '2026-09-28T05:00:00.000Z');
    seed.block(custom('Canceled'), '2026-09-28T10:00:00.000Z', '2026-09-28T11:00:00.000Z', {
      state: 'canceled',
    });
    const skipped = seed.block(
      custom('Skipped'),
      '2026-09-28T10:00:00.000Z',
      '2026-09-28T11:00:00.000Z',
      {
        state: 'skipped',
      },
    );
    const bounds = {
      startsAt: t('2026-09-28T04:00:00.000Z'),
      endsAt: t('2026-09-29T04:00:00.000Z'),
    };
    const rows = await queries.listDayBlocks(ownerId, bounds);
    expect(rows.map((row) => row.id)).toEqual([long.ref.id, skipped.ref.id, late.ref.id]);
    expect(queries.calls).toEqual([{ method: 'listDayBlocks', args: [ownerId, bounds] }]);
    expect(await queries.listDayBlocks(otherOwner, bounds)).toEqual([]);
  });

  it('lists the day’s Action placements and this week’s unscheduled Week Actions', async () => {
    const second = seed.action({ title: 'Second' });
    const first = seed.action({ title: 'First' });
    const archived = seed.action({ title: 'Archived', state: 'archived' });
    seed.placement(second.ref.id, day, { orderKey: '000000002000000' });
    seed.placement(first.ref.id, day, { orderKey: '000000001000000' });
    seed.placement(archived.ref.id, day);
    const weekly = seed.action({ title: 'Weekly' });
    seed.placement(weekly.ref.id, week);
    const scheduledWeekly = seed.action({ title: 'Scheduled weekly' });
    seed.placement(scheduledWeekly.ref.id, week);
    seed.block(
      { kind: 'action', actionId: scheduledWeekly.ref.id },
      '2026-09-30T14:00:00.000Z',
      '2026-09-30T15:00:00.000Z',
    );
    const doneWeekly = seed.action({ title: 'Done weekly', state: 'completed' });
    seed.placement(doneWeekly.ref.id, week);
    const placements = await queries.listDayActionPlacements(ownerId, d('2026-09-28'));
    expect(
      placements.map((row) => (row.target.kind === 'action' ? row.target.action.title : '')),
    ).toEqual(['First', 'Second']);
    const weekRows = await queries.listWeekActionPlacements(ownerId, d('2026-10-01'), 10);
    expect(weekRows.total).toBe(1);
    expect(
      weekRows.items.map((row) => (row.target.kind === 'action' ? row.target.action.title : '')),
    ).toEqual(['Weekly']);
    expect((await queries.listWeekActionPlacements(ownerId, d('2026-10-01'), 0)).items).toEqual([]);
  });

  it('lists unfinished Week-commitment Actions of the week containing a date', async () => {
    const open = seed.action({ title: 'Open', state: 'inbox' });
    const done = seed.action({ title: 'Done', state: 'completed' });
    const removed = seed.action({ title: 'Removed' });
    seed.weekCommitment(open.ref.id, week);
    seed.weekCommitment(done.ref.id, week);
    seed.weekCommitment(removed.ref.id, week, { archivedAt: now });
    const nextWeek = seed.action({ title: 'Next week' });
    seed.weekCommitment(nextWeek.ref.id, createWeekPeriod(d('2026-10-05'), 'monday'));
    const result = await queries.listWeekCommitmentActions(ownerId, d('2026-10-04'), 10);
    expect(result).toMatchObject({ total: 1, items: [{ title: 'Open', state: 'inbox' }] });
  });

  it('maps day focus rows of one profile and date, with occurrence details', async () => {
    const action = seed.action({ title: 'Focus Action' });
    const routine = seed.routine(
      { version: 1, kind: 'daily', intervalDays: 1, startsOn: d('2026-09-01') },
      { title: 'Walk' },
    );
    const occurrence = seed.occurrence(
      routine.ref.id,
      { kind: 'date', date: d('2026-09-28') },
      {},
      {
        revision: 2,
      },
    );
    const second = seed.focus(
      { kind: 'routine_occurrence', routineOccurrenceId: occurrence.ref.id },
      '2026-09-28',
      { orderKey: '000000002000000' },
    );
    const first = seed.focus({ kind: 'action', actionId: action.ref.id }, '2026-09-28', {
      orderKey: '000000001000000',
    });
    seed.focus({ kind: 'action', actionId: action.ref.id }, '2026-09-28', { archivedAt: now });
    seed.focus({ kind: 'action', actionId: action.ref.id }, '2026-09-28', {
      profileId: '10000000-0000-4000-8000-0000000000bb' as UUID,
    });
    const rows = await queries.listDayFocus(ownerId, profile.profileId, d('2026-09-28'));
    expect(rows.map((row) => row.id)).toEqual([first.ref.id, second.ref.id]);
    expect(rows[0]?.target).toMatchObject({ kind: 'action', action: { title: 'Focus Action' } });
    expect(rows[1]?.target).toEqual({
      kind: 'routine_occurrence',
      occurrenceId: occurrence.ref.id,
      routineId: routine.ref.id,
      routineTitle: 'Walk',
      routineState: 'active',
      generation: 1,
      period: { kind: 'date', date: '2026-09-28' },
      occurrenceRevision: 2,
      state: 'planned',
    });
  });

  it('reads a Focus mode Action with its note and planned block', async () => {
    const action = seed.action({ title: 'Write', note: 'Outline first', state: 'scheduled' });
    const block = seed.block(
      { kind: 'action', actionId: action.ref.id },
      '2026-09-29T14:00:00.000Z',
      '2026-09-29T15:00:00.000Z',
    );
    const row = await queries.getFocusAction(ownerId, action.ref.id);
    expect(row).toMatchObject({
      id: action.ref.id,
      title: 'Write',
      note: 'Outline first',
      plannedBlock: { id: block.ref.id, state: 'planned' },
    });
    expect(await queries.getFocusAction(otherOwner, action.ref.id)).toBeNull();
  });

  it('lists only active availability and capacity constraints', async () => {
    const active = seed.constraint({
      constraintKind: 'capacity',
      strength: 'soft',
      value: { kind: 'capacity', period: 'day', minutes: 240 },
      state: 'active',
    });
    seed.constraint({
      constraintKind: 'capacity',
      strength: 'soft',
      value: { kind: 'capacity', period: 'week', minutes: 600 },
      state: 'archived',
      archivedAt: now,
    });
    expect((await queries.listCapacityConstraints(ownerId)).map((row) => row.id)).toEqual([
      active.ref.id,
    ]);
  });
});
