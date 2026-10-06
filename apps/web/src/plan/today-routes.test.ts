import { describe, expect, it } from 'vitest';

import {
  endDayPath,
  focusPath,
  isAxisAreaPath,
  isReviewAreaPath,
  isTodayAreaPath,
  reviewPath,
  reviewPeriodPath,
  todayPath,
} from './routes';

describe('Today routes', () => {
  it('writes the live today as `/` and any other date as a selected date', () => {
    expect(todayPath()).toBe('/');
    expect(todayPath('2026-09-28', '2026-09-28')).toBe('/');
    expect(todayPath('2026-09-29', '2026-09-28')).toBe('/?date=2026-09-29');
    expect(todayPath('2026-09-27')).toBe('/?date=2026-09-27');
  });

  it('writes Focus mode and End Day paths', () => {
    expect(focusPath('0f000000-0000-4000-8000-000000000001')).toBe(
      '/focus/0f000000-0000-4000-8000-000000000001',
    );
    expect(endDayPath('2026-09-28')).toBe('/end-day/2026-09-28');
  });

  it.each([
    ['/', true],
    ['/focus/0f000000-0000-4000-8000-000000000001', true],
    ['/end-day/2026-09-28', true],
    ['/focus', false],
    ['/focused', false],
    ['/end-day', false],
    ['/plan/day/2026-09-28', false],
    ['/axis', false],
    ['/inbox', false],
  ])('treats %s as part of Today: %s', (pathname, expected) => {
    expect(isTodayAreaPath(pathname)).toBe(expected);
    if (expected) expect(isAxisAreaPath(pathname)).toBe(false);
  });
});

describe('Review routes', () => {
  it('writes the overview and each review period, with the daily review as End Day', () => {
    expect(reviewPath()).toBe('/review');
    expect(reviewPeriodPath('weekly', '2026-09-21')).toBe('/review/weekly/2026-09-21');
    expect(reviewPeriodPath('monthly', '2026-09')).toBe('/review/monthly/2026-09');
    expect(reviewPeriodPath('yearly', '2026')).toBe('/review/yearly/2026');
    expect(reviewPeriodPath('daily', '2026-09-30')).toBe('/end-day/2026-09-30');
  });

  it.each([
    ['/review', true],
    ['/review/weekly/2026-09-21', true],
    ['/review/monthly/2026-09', true],
    ['/review/unknown', true],
    ['/reviews', false],
    ['/reviewed', false],
    ['/end-day/2026-09-30', false],
    ['/', false],
    ['/axis', false],
  ])('treats %s as part of Review: %s', (pathname, expected) => {
    expect(isReviewAreaPath(pathname)).toBe(expected);
    if (expected) {
      expect(isTodayAreaPath(pathname)).toBe(false);
      expect(isAxisAreaPath(pathname)).toBe(false);
    }
  });
});
