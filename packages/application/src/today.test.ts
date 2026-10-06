import type { IanaTimeZone, Instant, OwnerId, UUID } from '@yelaxis/domain';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { PlanProfile } from './planning-contracts';
import type { SerialQueue } from './planning-kit';
import { createInMemoryHarness } from './testing/in-memory-unit-of-work';
import { createTodayTestQueries } from './testing/today-test-queries';
import { createTodayApplication } from './today';
import type {
  TodayApplication,
  TodayEndDayMethods,
  TodayFocusMethods,
  TodayViewMethods,
} from './today-contracts';
import { createTodayEndDay } from './today-end-day';
import { createTodayFocus } from './today-focus';
import { createTodayKit } from './today-kit';
import { createTodayView } from './today-view';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const now = '2026-09-28T13:00:00.000Z' as Instant;
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: 'America/New_York' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};

const methodSets = {
  view: ['getToday', 'reorderFlexible'],
  focus: [
    'getFocusChoices',
    'getFocusSession',
    'addFocus',
    'removeFocus',
    'reorderFocus',
    'setDayFocus',
  ],
  endDay: ['getEndDay', 'applyEndDay'],
} as const;

const setup = () => {
  const harness = createInMemoryHarness(ownerId, now);
  const queries = createTodayTestQueries(harness.unitOfWork, profile);
  return { harness, queries, kit: createTodayKit(harness.dependencies, queries) };
};

describe('createTodayApplication', () => {
  it('splits the facade into three disjoint part method sets that cover it exactly', () => {
    expectTypeOf<keyof TodayApplication>().toEqualTypeOf<
      keyof TodayViewMethods | keyof TodayFocusMethods | keyof TodayEndDayMethods
    >();
    const { kit } = setup();
    const factories = {
      view: createTodayView(kit),
      focus: createTodayFocus(kit),
      endDay: createTodayEndDay(kit),
    };
    for (const [name, methods] of Object.entries(methodSets))
      expect(Object.keys(factories[name as keyof typeof factories]).sort(), name).toEqual(
        [...methods].sort(),
      );
    const all = Object.values(methodSets).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(10);
  });

  it('runs every call through the shared queue', async () => {
    const { harness, queries } = setup();
    const queued: string[] = [];
    const queue: SerialQueue = {
      run: <Result>(): Promise<Result> => {
        queued.push('call');
        return Promise.resolve('queued' as Result);
      },
    };
    const application = createTodayApplication(harness.dependencies, queries, { queue });
    const names = Object.values(methodSets).flat();
    expect(Object.keys(application).sort()).toEqual([...names].sort());
    for (const name of names) {
      const call = (): Promise<unknown> =>
        (application[name] as (this: void, ...args: unknown[]) => Promise<unknown>)();
      await expect(call()).resolves.toBe('queued');
    }
    expect(queued).toHaveLength(10);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });
});
