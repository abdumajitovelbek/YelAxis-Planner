import { describe, expect, it } from 'vitest';

import type { ReviewPeriod } from '@yelaxis/domain';

import { reviewPeriod, reviewProfile } from './__fixtures__/review-fake';
import {
  checkpointLinkLabel,
  characterCountText,
  decisionCountText,
  decisionWords,
  dueText,
  finishedText,
  listWords,
  movePeriodWords,
  periodPhrase,
  periodRange,
  periodTitle,
  reviewNoticeText,
  reviewStatusLabel,
  reviewTitle,
  targetTitle,
  weekRangeWords,
} from './review-text';

const today = '2026-09-30';

describe('review periods in words', () => {
  it.each([
    [reviewPeriod('daily', '2026-09-30'), 'Today, Wednesday, September 30'],
    [reviewPeriod('daily', '2026-09-29'), 'Yesterday, Tuesday, September 29'],
    [reviewPeriod('daily', '2026-09-22'), 'Tuesday, September 22, 2026'],
    [reviewPeriod('weekly', '2026-09-21'), 'Week of September 21–27'],
    [reviewPeriod('weekly', '2026-09-28'), 'Week of September 28 – October 4'],
    [reviewPeriod('weekly', '2025-09-22'), 'Week of September 22–28, 2025'],
    [reviewPeriod('weekly', '2025-12-29'), 'Week of December 29, 2025 – January 4, 2026'],
    [reviewPeriod('monthly', '2026-09'), 'September 2026'],
    [reviewPeriod('yearly', '2026'), '2026'],
  ] as const)('titles %o as “%s”', (period: ReviewPeriod, words) => {
    expect(periodTitle(period, today)).toBe(words);
  });

  it('names periods inside sentences and by their dates alone', () => {
    const week = reviewPeriod('weekly', '2026-09-21');
    expect(periodPhrase(week, today)).toBe('the week of September 21–27');
    expect(periodRange(week, today)).toBe('September 21–27');
    expect(periodPhrase(reviewPeriod('monthly', '2026-08'), today)).toBe('August 2026');
    expect(periodRange(reviewPeriod('daily', '2026-09-29'), today)).toBe(
      'Tuesday, September 29, 2026',
    );
    expect(weekRangeWords('2027-01-04', '2027-01-10', today)).toBe('January 4–10, 2027');
  });

  it('says when a review was finished, in the planning zone', () => {
    expect(
      finishedText('2026-09-27T18:30:00.000Z' as Parameters<typeof finishedText>[0], reviewProfile),
    ).toBe('Finished Sunday, September 27, 2026 at 18:30');
  });
});

describe('review status, due, and links', () => {
  it('names each status calmly, never as a score', () => {
    expect(reviewStatusLabel('not_started')).toBe('Not started');
    expect(reviewStatusLabel('draft')).toBe('Saved for later');
    expect(reviewStatusLabel('skipped')).toBe('Skipped');
    expect(reviewStatusLabel('completed')).toBe('Done');
    expect(reviewTitle('weekly')).toBe('Weekly review');
  });

  it('says when a review is due without pressure', () => {
    const week = reviewPeriod('weekly', '2026-09-28');
    expect(dueText(week, 'due')).toBe('Due today');
    expect(dueText(week, 'ended')).toBe('Ready when you are');
    expect(dueText(week, 'not_due')).toBe('Due Sunday, October 4');
  });

  it.each([
    ['not_started', 'due', 'Start review'],
    ['not_started', 'ended', 'Start review'],
    ['not_started', 'not_due', 'Start early'],
    ['draft', 'not_due', 'Resume review'],
    ['draft', 'ended', 'Resume review'],
    ['skipped', 'ended', 'Open review'],
    ['completed', 'due', 'Open review'],
  ] as const)('offers one link for %s and %s: %s', (status, due, label) => {
    expect(checkpointLinkLabel({ status, due })).toBe(label);
  });

  it('writes one quiet notice for the reviews that are ready', () => {
    const due = (key: string, type: 'weekly' | 'monthly' | 'yearly') => ({
      period: reviewPeriod(type, key),
    });
    expect(reviewNoticeText([])).toBeNull();
    expect(reviewNoticeText([due('2026-09-21', 'weekly')])).toBe('Your weekly review is ready.');
    expect(reviewNoticeText([due('2026-09', 'monthly'), due('2026-09-21', 'weekly')])).toBe(
      'Your weekly and monthly reviews are ready.',
    );
    expect(
      reviewNoticeText([
        due('2026-09-21', 'weekly'),
        due('2026-09', 'monthly'),
        due('2025', 'yearly'),
      ]),
    ).toBe('Your weekly, monthly, and yearly reviews are ready.');
    expect(listWords(['a'])).toBe('a');
  });
});

describe('review decisions in words', () => {
  it('names chosen and applied decisions, and a deleted object', () => {
    expect(decisionWords('project', 'pause', false)).toBe('Pause');
    expect(decisionWords('project', 'pause', true)).toBe('Paused');
    expect(decisionWords('outcome', 'complete', true)).toBe('Achieved');
    expect(decisionWords('outcome', 'cancel', false)).toBe('Abandon');
    expect(decisionWords('outcome', 'cancel', true)).toBe('Abandoned');
    expect(decisionWords('milestone', 'cancel', true)).toBe('Canceled');
    expect(decisionWords('action', 'carry', true)).toBe('Carried');
    expect(decisionWords('action', 'move', true, 'October 2026')).toBe('Moved to October 2026');
    expect(decisionWords('deleted', 'archive', true)).toBe('Archived');
    expect(targetTitle({ kind: 'deleted' })).toBe('Deleted object');
    expect(decisionCountText(1)).toBe('1 decision');
    expect(decisionCountText(3)).toBe('3 decisions');
  });

  it('says where a move goes', () => {
    expect(movePeriodWords({ kind: 'day', date: '2026-10-06' }, 'monday', today)).toBe(
      'Tuesday, October 6, 2026',
    );
    expect(movePeriodWords({ kind: 'week', date: '2026-10-07' }, 'monday', today)).toBe(
      'the week of October 5–11',
    );
    expect(movePeriodWords({ kind: 'month', date: '2026-10-01' }, 'monday', today)).toBe(
      'October 2026',
    );
  });

  it('states a character limit', () => {
    expect(characterCountText(0, 10_000)).toBe('0 of 10,000 characters');
    expect(characterCountText(2_001, 2_000)).toBe('2,001 of 2,000 characters');
  });
});
