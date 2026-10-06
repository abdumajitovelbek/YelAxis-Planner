import { describe, expect, it } from 'vitest';

import { syncBackoffDelay, syncBackoffPolicy } from './sync-backoff';

describe('retry backoff', () => {
  it('doubles from 5 seconds and stops at 15 minutes', () => {
    const middle = () => 0.5;
    expect(Array.from({ length: 10 }, (_, index) => syncBackoffDelay(index + 1, middle))).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 900_000, 900_000,
    ]);
    expect(syncBackoffDelay(1_000, middle)).toBe(syncBackoffPolicy.maximumMs);
  });

  it('jitters by ±20% and never passes the cap', () => {
    expect(syncBackoffDelay(1, () => 0)).toBe(4_000);
    expect(syncBackoffDelay(1, () => 0.999_999)).toBe(6_000);
    expect(syncBackoffDelay(3, () => 0)).toBe(16_000);
    expect(syncBackoffDelay(9, () => 0)).toBe(720_000);
    expect(syncBackoffDelay(9, () => 0.999_999)).toBe(900_000);
    for (let sample = 0; sample < 1; sample += 0.05) {
      const delay = syncBackoffDelay(4, () => sample);
      expect(delay).toBeGreaterThanOrEqual(32_000);
      expect(delay).toBeLessThanOrEqual(48_000);
    }
  });

  it('treats out-of-range inputs safely', () => {
    expect(syncBackoffDelay(0, () => 0.5)).toBe(5_000);
    expect(syncBackoffDelay(2, () => 7)).toBe(12_000);
    expect(syncBackoffDelay(2, () => -1)).toBe(8_000);
  });
});
