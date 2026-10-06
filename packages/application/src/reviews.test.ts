import { describe, expect, expectTypeOf, it } from 'vitest';

import type { SerialQueue } from './planning-kit';
import type { ReviewApplication } from './review-contracts';
import { createReviewApplication } from './reviews';
import { createReviewFixture } from './testing/review-fixtures';

const methods = [
  'getOverview',
  'listHistory',
  'getReview',
  'getNotice',
  'saveReview',
  'skipReview',
  'finishReview',
  'setReviewReminder',
  'turnOffReviewReminder',
] as const;

describe('createReviewApplication', () => {
  it('exposes exactly the Review facade', () => {
    expectTypeOf<keyof ReviewApplication>().toEqualTypeOf<(typeof methods)[number]>();
    const { reviews } = createReviewFixture();
    expect(Object.keys(reviews).sort()).toEqual([...methods].sort());
  });

  it('runs every call through the shared queue', async () => {
    const { harness, queries } = createReviewFixture();
    const queued: string[] = [];
    const queue: SerialQueue = {
      run: <Result>(): Promise<Result> => {
        queued.push('call');
        return Promise.resolve('queued' as Result);
      },
    };
    const application = createReviewApplication(harness.dependencies, queries, { queue });
    for (const name of methods) {
      const call = (): Promise<unknown> =>
        (application[name] as (this: void, ...args: unknown[]) => Promise<unknown>)();
      await expect(call()).resolves.toBe('queued');
    }
    expect(queued).toHaveLength(methods.length);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('serializes overlapping calls on its own queue when none is shared', async () => {
    const { reviews } = createReviewFixture();
    const order: string[] = [];
    await Promise.all([
      reviews.getOverview().then(() => order.push('overview')),
      reviews.getNotice().then(() => order.push('notice')),
      reviews.listHistory().then(() => order.push('history')),
    ]);
    expect(order).toEqual(['overview', 'notice', 'history']);
  });
});
