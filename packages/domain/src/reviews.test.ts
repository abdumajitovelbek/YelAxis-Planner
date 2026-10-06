import { describe, expect, it } from 'vitest';

import {
  addDays,
  currentReviewCheckpoint,
  energyLabels,
  isAlignedReviewPeriod,
  isAllowedReviewDecision,
  isReviewablePeriod,
  isReviewDecisionKind,
  isReviewType,
  nextReviewPeriod,
  normalizeReviewText,
  parseReviewDirection,
  parseReviewEnergy,
  parseReviewPeriodKey,
  planReviewFinish,
  planReviewSave,
  planReviewSkip,
  previousReviewPeriod,
  reviewDecisionKinds,
  reviewDecisionMatrix,
  reviewDecisionSlot,
  reviewDue,
  reviewHorizonPeriod,
  reviewLimits,
  reviewObjectState,
  reviewPeriodContaining,
  reviewPlanningPeriod,
  reviewTypes,
  sameReviewPeriod,
  weekdays,
  type CalendarDate,
  type DomainResult,
  type ReviewDecisionKind,
  type ReviewPeriod,
  type ReviewStatus,
  type ReviewTargetKind,
  type ReviewType,
  type Weekday,
} from './index.js';

const d = (value: string) => value as CalendarDate;

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** The rejection's reason, or its code when it has none. */
const rejection = (result: DomainResult<unknown>): unknown => {
  if (result.ok) throw new Error('Expected a rejection.');
  return result.error.details?.['reason'] ?? result.error.code;
};

const messageOf = (result: DomainResult<unknown>): string => {
  if (result.ok) throw new Error('Expected a rejection.');
  return result.error.message;
};

/** A compact `type key start..end [weekStart]` form, so tables stay readable. */
const shape = (period: ReviewPeriod): string =>
  `${period.type} ${period.key} ${period.start}..${period.end}${
    period.weekStart === undefined ? '' : ` ${period.weekStart}`
  }`;

const period = (type: ReviewType, key: string): ReviewPeriod =>
  expectValue(parseReviewPeriodKey(type, key));

/* ───────────────────────── Types and keys ───────────────────────── */

describe('review types', () => {
  it('names the four review types in order', () => {
    expect(reviewTypes).toEqual(['daily', 'weekly', 'monthly', 'yearly']);
  });

  it.each([
    ['daily', true],
    ['weekly', true],
    ['monthly', true],
    ['yearly', true],
    ['quarterly', false],
    ['Daily', false],
    ['', false],
    [null, false],
    [7, false],
  ] as const)('recognizes %s as a review type: %s', (value, expected) => {
    expect(isReviewType(value)).toBe(expected);
  });
});

describe('review period keys', () => {
  it.each([
    ['daily', '2026-09-28', 'daily 2026-09-28 2026-09-28..2026-09-28'],
    ['daily', '2028-02-29', 'daily 2028-02-29 2028-02-29..2028-02-29'],
    ['weekly', '2026-09-28', 'weekly 2026-09-28 2026-09-28..2026-10-04 monday'],
    // A weekly key starts on its own weekday: the key alone names exactly seven days.
    ['weekly', '2026-09-27', 'weekly 2026-09-27 2026-09-27..2026-10-03 sunday'],
    ['weekly', '2026-09-30', 'weekly 2026-09-30 2026-09-30..2026-10-06 wednesday'],
    ['weekly', '2026-12-31', 'weekly 2026-12-31 2026-12-31..2027-01-06 thursday'],
    ['monthly', '2026-09', 'monthly 2026-09 2026-09-01..2026-09-30'],
    ['monthly', '2026-02', 'monthly 2026-02 2026-02-01..2026-02-28'],
    ['monthly', '2028-02', 'monthly 2028-02 2028-02-01..2028-02-29'],
    ['monthly', '2026-12', 'monthly 2026-12 2026-12-01..2026-12-31'],
    ['yearly', '2026', 'yearly 2026 2026-01-01..2026-12-31'],
    ['yearly', '2028', 'yearly 2028 2028-01-01..2028-12-31'],
  ] as const)('parses a %s key %s', (type, key, expected) => {
    expect(shape(period(type, key))).toBe(expected);
  });

  // Monday 2026-09-28 through Sunday 2026-10-04.
  it.each(weekdays.map((weekday, index) => [weekday, addDays(d('2026-09-28'), index)] as const))(
    'accepts a weekly key on a %s (%s)',
    (weekday, key) => {
      const parsed = period('weekly', key);
      expect(parsed.weekStart).toBe(weekday);
      expect(parsed.end).toBe(addDays(key, 6));
      expect(isAlignedReviewPeriod(parsed, weekday)).toBe(true);
    },
  );

  it.each([
    ['quarterly', '2026-09-28', 'review_type'],
    ['', '2026-09-28', 'review_type'],
    [3, '2026-09-28', 'review_type'],
    [null, '2026', 'review_type'],
    ['daily', '2026-02-30', 'review_period'],
    ['daily', '2026-9-28', 'review_period'],
    ['daily', '2026-09-28T00:00', 'review_period'],
    ['daily', '', 'review_period'],
    ['daily', 20260928, 'review_period'],
    ['daily', null, 'review_period'],
    ['weekly', '2026-13-01', 'review_period'],
    ['weekly', '2026-09', 'review_period'],
    ['monthly', '2026-13', 'review_period'],
    ['monthly', '2026-00', 'review_period'],
    ['monthly', '2026-9', 'review_period'],
    ['monthly', '2026-09-01', 'review_period'],
    ['monthly', '202609', 'review_period'],
    ['yearly', '26', 'review_period'],
    ['yearly', '0000', 'review_period'],
    ['yearly', '2026-01', 'review_period'],
    ['yearly', ' 2026', 'review_period'],
    ['yearly', 2026, 'review_period'],
  ] as const)('refuses type %s with key %s (%s)', (type, key, reason) => {
    expect(rejection(parseReviewPeriodKey(type, key))).toBe(reason);
  });

  it('explains a refused type and period calmly', () => {
    expect(messageOf(parseReviewPeriodKey('hourly', '2026'))).toBe(
      'Choose a daily, weekly, monthly, or yearly review.',
    );
    expect(messageOf(parseReviewPeriodKey('daily', 'soon'))).toBe('Choose a valid review period.');
  });
});

/* ───────────────────────── Containing, previous, next ───────────────────────── */

describe('the review period that contains a date', () => {
  it.each([
    ['daily', '2026-09-30', 'daily 2026-09-30 2026-09-30..2026-09-30'],
    ['monthly', '2026-09-30', 'monthly 2026-09 2026-09-01..2026-09-30'],
    ['monthly', '2026-10-01', 'monthly 2026-10 2026-10-01..2026-10-31'],
    ['monthly', '2028-02-29', 'monthly 2028-02 2028-02-01..2028-02-29'],
    ['yearly', '2026-12-31', 'yearly 2026 2026-01-01..2026-12-31'],
    ['yearly', '2027-01-01', 'yearly 2027 2027-01-01..2027-12-31'],
  ] as const)('%s on %s is %s', (type, date, expected) => {
    expect(shape(reviewPeriodContaining(type, d(date), 'monday'))).toBe(expected);
  });

  // Wednesday 2026-09-30 under every first weekday.
  it.each([
    ['monday', '2026-09-28..2026-10-04'],
    ['tuesday', '2026-09-29..2026-10-05'],
    ['wednesday', '2026-09-30..2026-10-06'],
    ['thursday', '2026-09-24..2026-09-30'],
    ['friday', '2026-09-25..2026-10-01'],
    ['saturday', '2026-09-26..2026-10-02'],
    ['sunday', '2026-09-27..2026-10-03'],
  ] as const)('a week that starts on %s holds Wednesday 2026-09-30 in %s', (weekStart, range) => {
    const week = reviewPeriodContaining('weekly', d('2026-09-30'), weekStart);
    expect(`${week.start}..${week.end}`).toBe(range);
    expect(week.key).toBe(week.start);
    expect(week.weekStart).toBe(weekStart);
    expect(isAlignedReviewPeriod(week, weekStart)).toBe(true);
  });

  it('keeps a week that crosses the year together', () => {
    expect(shape(reviewPeriodContaining('weekly', d('2027-01-01'), 'monday'))).toBe(
      'weekly 2026-12-28 2026-12-28..2027-01-03 monday',
    );
  });

  it('round-trips every period through its key', () => {
    for (const type of reviewTypes)
      for (const weekStart of weekdays) {
        const found = reviewPeriodContaining(type, d('2026-09-30'), weekStart);
        expect(expectValue(parseReviewPeriodKey(type, found.key))).toEqual(found);
      }
  });
});

describe('previous and next review periods', () => {
  it.each([
    [
      'daily',
      '2026-03-01',
      'daily 2026-02-28 2026-02-28..2026-02-28',
      'daily 2026-03-02 2026-03-02..2026-03-02',
    ],
    [
      'daily',
      '2026-12-31',
      'daily 2026-12-30 2026-12-30..2026-12-30',
      'daily 2027-01-01 2027-01-01..2027-01-01',
    ],
    [
      'weekly',
      '2026-09-27',
      'weekly 2026-09-20 2026-09-20..2026-09-26 sunday',
      'weekly 2026-10-04 2026-10-04..2026-10-10 sunday',
    ],
    [
      'weekly',
      '2026-09-30',
      'weekly 2026-09-23 2026-09-23..2026-09-29 wednesday',
      'weekly 2026-10-07 2026-10-07..2026-10-13 wednesday',
    ],
    [
      'monthly',
      '2026-01',
      'monthly 2025-12 2025-12-01..2025-12-31',
      'monthly 2026-02 2026-02-01..2026-02-28',
    ],
    [
      'monthly',
      '2026-12',
      'monthly 2026-11 2026-11-01..2026-11-30',
      'monthly 2027-01 2027-01-01..2027-01-31',
    ],
    ['yearly', '2026', 'yearly 2025 2025-01-01..2025-12-31', 'yearly 2027 2027-01-01..2027-12-31'],
  ] as const)('%s %s follows %s and precedes %s', (type, key, previous, next) => {
    const current = period(type, key);
    expect(shape(previousReviewPeriod(current))).toBe(previous);
    expect(shape(nextReviewPeriod(current))).toBe(next);
    expect(sameReviewPeriod(nextReviewPeriod(previousReviewPeriod(current)), current)).toBe(true);
  });

  it('compares periods by type and exact dates', () => {
    const week = period('weekly', '2026-09-28');
    expect(
      sameReviewPeriod(week, reviewPeriodContaining('weekly', d('2026-10-04'), 'monday')),
    ).toBe(true);
    expect(
      sameReviewPeriod(week, reviewPeriodContaining('weekly', d('2026-10-04'), 'sunday')),
    ).toBe(false);
    expect(sameReviewPeriod(period('daily', '2026-09-28'), week)).toBe(false);
  });

  it('reads the plan of a review period on the Horizon with the same dates', () => {
    expect(reviewHorizonPeriod(period('daily', '2026-09-28'))).toEqual({
      kind: 'day',
      date: '2026-09-28',
    });
    expect(reviewHorizonPeriod(period('weekly', '2026-09-30'))).toEqual({
      kind: 'week',
      start: '2026-09-30',
      end: '2026-10-06',
      weekStart: 'wednesday',
    });
    expect(reviewHorizonPeriod(period('monthly', '2026-09'))).toEqual({
      kind: 'month',
      month: '2026-09',
    });
    expect(reviewHorizonPeriod(period('yearly', '2026'))).toEqual({ kind: 'year', year: '2026' });
  });

  it('aligns a weekly period only with its own first weekday; other types always align', () => {
    const week = period('weekly', '2026-09-28');
    expect(isAlignedReviewPeriod(week, 'monday')).toBe(true);
    expect(isAlignedReviewPeriod(week, 'sunday')).toBe(false);
    for (const type of ['daily', 'monthly', 'yearly'] as const)
      expect(
        isAlignedReviewPeriod(reviewPeriodContaining(type, d('2026-09-30'), 'monday'), 'sunday'),
      ).toBe(true);
  });
});

/* ───────────────────────── Due and the checkpoint ───────────────────────── */

describe('due is derived from the period and planning today', () => {
  const week = period('weekly', '2026-09-28');
  it.each([
    ['2026-09-27', 'not_due', false],
    ['2026-09-28', 'not_due', true],
    ['2026-10-03', 'not_due', true],
    ['2026-10-04', 'due', true],
    ['2026-10-05', 'ended', true],
    ['2027-06-01', 'ended', true],
  ] as const)('on %s the week is %s (reviewable: %s)', (today, due, reviewable) => {
    expect(reviewDue(week, d(today))).toBe(due);
    expect(isReviewablePeriod(week, d(today))).toBe(reviewable);
  });

  it('makes a day due on itself and ended the next day', () => {
    const day = period('daily', '2026-09-30');
    expect(reviewDue(day, d('2026-09-29'))).toBe('not_due');
    expect(reviewDue(day, d('2026-09-30'))).toBe('due');
    expect(reviewDue(day, d('2026-10-01'))).toBe('ended');
  });
});

describe('the one checkpoint offered per type', () => {
  const checkpoint = (
    type: ReviewType,
    today: string,
    previousSettled: boolean,
    weekStart: Weekday = 'monday',
  ) => shape(currentReviewCheckpoint({ type, today: d(today), weekStart, previousSettled }));

  it.each([false, true])(
    'offers today as the daily checkpoint (previous settled: %s)',
    (settled) => {
      expect(checkpoint('daily', '2026-09-30', settled)).toBe(
        'daily 2026-09-30 2026-09-30..2026-09-30',
      );
    },
  );

  it.each([
    ['on its last day', '2026-10-04', false, 'weekly 2026-09-28 2026-09-28..2026-10-04 monday'],
    [
      'mid-week, previous open',
      '2026-09-30',
      false,
      'weekly 2026-09-21 2026-09-21..2026-09-27 monday',
    ],
    [
      'mid-week, previous settled',
      '2026-09-30',
      true,
      'weekly 2026-09-28 2026-09-28..2026-10-04 monday',
    ],
    [
      'on its first day, previous open',
      '2026-09-28',
      false,
      'weekly 2026-09-21 2026-09-21..2026-09-27 monday',
    ],
  ] as const)('weekly %s', (_name, today, settled, expected) => {
    expect(checkpoint('weekly', today, settled)).toBe(expected);
  });

  it.each([
    ['monday', 'weekly 2026-09-21 2026-09-21..2026-09-27 monday'],
    ['tuesday', 'weekly 2026-09-22 2026-09-22..2026-09-28 tuesday'],
    ['wednesday', 'weekly 2026-09-23 2026-09-23..2026-09-29 wednesday'],
    // Wednesday is the last day of a week that starts on Thursday: that week is offered.
    ['thursday', 'weekly 2026-09-24 2026-09-24..2026-09-30 thursday'],
    ['friday', 'weekly 2026-09-18 2026-09-18..2026-09-24 friday'],
    ['saturday', 'weekly 2026-09-19 2026-09-19..2026-09-25 saturday'],
    ['sunday', 'weekly 2026-09-20 2026-09-20..2026-09-26 sunday'],
  ] as const)('follows a %s first weekday on Wednesday 2026-09-30', (weekStart, expected) => {
    expect(checkpoint('weekly', '2026-09-30', false, weekStart)).toBe(expected);
  });

  it.each([
    ['monthly', '2026-09-30', false, 'monthly 2026-09 2026-09-01..2026-09-30'],
    ['monthly', '2026-10-15', false, 'monthly 2026-09 2026-09-01..2026-09-30'],
    ['monthly', '2026-10-15', true, 'monthly 2026-10 2026-10-01..2026-10-31'],
    ['monthly', '2026-03-01', false, 'monthly 2026-02 2026-02-01..2026-02-28'],
    ['yearly', '2026-12-31', false, 'yearly 2026 2026-01-01..2026-12-31'],
    ['yearly', '2027-03-01', false, 'yearly 2026 2026-01-01..2026-12-31'],
    ['yearly', '2027-03-01', true, 'yearly 2027 2027-01-01..2027-12-31'],
  ] as const)('%s on %s (previous settled: %s) is %s', (type, today, settled, expected) => {
    expect(checkpoint(type, today, settled)).toBe(expected);
  });

  it.each([
    // A Profile created on Monday 5 October: September and 2025 hold nothing planned here.
    ['weekly', '2026-10-07', 'weekly 2026-10-05 2026-10-05..2026-10-11 monday'],
    ['monthly', '2026-10-11', 'monthly 2026-10 2026-10-01..2026-10-31'],
    ['yearly', '2026-10-11', 'yearly 2026 2026-01-01..2026-12-31'],
    // The previous period overlaps the Profile's first days, so it is still offered.
    ['weekly', '2026-10-13', 'weekly 2026-10-05 2026-10-05..2026-10-11 monday'],
    ['monthly', '2026-11-02', 'monthly 2026-10 2026-10-01..2026-10-31'],
  ] as const)(
    'never reaches back before the Profile existed (%s on %s is %s)',
    (type, today, expected) => {
      expect(
        shape(
          currentReviewCheckpoint({
            type,
            today: d(today),
            weekStart: 'monday',
            previousSettled: false,
            startedOn: d('2026-10-05'),
          }),
        ),
      ).toBe(expected);
    },
  );

  it('offers a period on its last day even when the Profile began that day', () => {
    expect(
      shape(
        currentReviewCheckpoint({
          type: 'weekly',
          today: d('2026-10-11'),
          weekStart: 'monday',
          previousSettled: false,
          startedOn: d('2026-10-11'),
        }),
      ),
    ).toBe('weekly 2026-10-05 2026-10-05..2026-10-11 monday');
  });

  it('never offers an earlier missed period', () => {
    // Nothing was reviewed for months: only last month is offered, never an older one.
    expect(checkpoint('monthly', '2026-12-10', false)).toBe(
      'monthly 2026-11 2026-11-01..2026-11-30',
    );
  });
});

describe('the period a review plans for', () => {
  const planning = (key: string, type: ReviewType, today: string, weekStart: Weekday = 'monday') =>
    shape(expectValue(reviewPlanningPeriod(period(type, key), d(today), weekStart)));

  it.each([
    ['today plans tomorrow', '2026-09-30', '2026-09-30', 'daily 2026-10-01 2026-10-01..2026-10-01'],
    [
      'yesterday plans today',
      '2026-09-29',
      '2026-09-30',
      'daily 2026-09-30 2026-09-30..2026-09-30',
    ],
    [
      'an older day plans today',
      '2026-09-01',
      '2026-09-30',
      'daily 2026-09-30 2026-09-30..2026-09-30',
    ],
    [
      'New Year’s Eve plans the new year',
      '2026-12-31',
      '2026-12-31',
      'daily 2027-01-01 2027-01-01..2027-01-01',
    ],
  ] as const)('daily: %s (the End Day carry date)', (_name, key, today, expected) => {
    expect(planning(key, 'daily', today)).toBe(expected);
  });

  it.each([
    [
      'this week on its last day plans next week',
      '2026-09-28',
      '2026-10-04',
      'weekly 2026-10-05 2026-10-05..2026-10-11 monday',
    ],
    [
      'this week started early plans next week',
      '2026-09-28',
      '2026-09-30',
      'weekly 2026-10-05 2026-10-05..2026-10-11 monday',
    ],
    [
      'last week plans this week',
      '2026-09-21',
      '2026-09-30',
      'weekly 2026-09-28 2026-09-28..2026-10-04 monday',
    ],
    [
      'an older week plans this week',
      '2026-08-31',
      '2026-09-30',
      'weekly 2026-09-28 2026-09-28..2026-10-04 monday',
    ],
  ] as const)('weekly: %s', (_name, key, today, expected) => {
    expect(planning(key, 'weekly', today)).toBe(expected);
  });

  it('plans a week of the current first weekday after a first-weekday change', () => {
    // Reviewed as a Monday week; weeks now start on Sunday.
    expect(planning('2026-09-21', 'weekly', '2026-09-30', 'sunday')).toBe(
      'weekly 2026-09-27 2026-09-27..2026-10-03 sunday',
    );
    expect(planning('2026-09-28', 'weekly', '2026-10-04', 'sunday')).toBe(
      'weekly 2026-10-04 2026-10-04..2026-10-10 sunday',
    );
  });

  it.each([
    ['monthly', '2026-09', '2026-09-30', 'monthly 2026-10 2026-10-01..2026-10-31'],
    ['monthly', '2026-09', '2026-10-05', 'monthly 2026-10 2026-10-01..2026-10-31'],
    ['monthly', '2026-07', '2026-10-05', 'monthly 2026-10 2026-10-01..2026-10-31'],
    ['monthly', '2026-12', '2026-12-31', 'monthly 2027-01 2027-01-01..2027-01-31'],
    ['yearly', '2026', '2026-12-31', 'yearly 2027 2027-01-01..2027-12-31'],
    ['yearly', '2026', '2026-06-01', 'yearly 2027 2027-01-01..2027-12-31'],
    ['yearly', '2025', '2026-06-01', 'yearly 2026 2026-01-01..2026-12-31'],
    ['yearly', '2023', '2026-06-01', 'yearly 2026 2026-01-01..2026-12-31'],
  ] as const)('%s %s on %s plans %s', (type, key, today, expected) => {
    expect(planning(key, type, today)).toBe(expected);
  });

  it.each([
    ['daily', '2026-10-01'],
    ['weekly', '2026-10-01'],
    ['monthly', '2026-10'],
    ['yearly', '2027'],
  ] as const)('has nothing to plan for a %s period that has not started', (type, key) => {
    const result = reviewPlanningPeriod(period(type, key), d('2026-09-30'), 'monday');
    expect(rejection(result)).toBe('review_future');
    expect(messageOf(result)).toBe('This period has not started yet.');
  });
});

/* ───────────────────────── States ───────────────────────── */

describe('review state planners', () => {
  const statuses: readonly ReviewStatus[] = ['not_started', 'draft', 'skipped', 'completed'];

  it.each([
    ['not_started', 'draft'],
    ['draft', 'draft'],
    ['skipped', 'draft'],
    ['completed', 'review_finished'],
  ] as const)('saving a %s review gives %s', (status, expected) => {
    const result = planReviewSave(status);
    expect(result.ok ? result.value : rejection(result)).toBe(expected);
  });

  it.each([
    ['not_started', 'skipped'],
    ['draft', 'skipped'],
    ['skipped', 'no_change'],
    ['completed', 'review_finished'],
  ] as const)('skipping a %s review gives %s', (status, expected) => {
    const result = planReviewSkip(status);
    expect(result.ok ? result.value : rejection(result)).toBe(expected);
  });

  it.each([
    ['not_started', 'completed'],
    ['draft', 'completed'],
    ['skipped', 'completed'],
    ['completed', 'review_finished'],
  ] as const)('finishing a %s review gives %s', (status, expected) => {
    const result = planReviewFinish(status);
    expect(result.ok ? result.value : rejection(result)).toBe(expected);
  });

  it('keeps a finished review as history, calmly', () => {
    for (const plan of [planReviewSave, planReviewSkip, planReviewFinish])
      expect(messageOf(plan('completed'))).toBe(
        'This review is finished. Its decisions are kept in history.',
      );
    expect(statuses.filter((status) => planReviewSave(status).ok)).toHaveLength(3);
  });
});

/* ───────────────────────── Decisions ───────────────────────── */

describe('decision kinds and slots', () => {
  it.each([
    ['complete', 'state'],
    ['carry', 'state'],
    ['move', 'state'],
    ['pause', 'state'],
    ['cancel', 'state'],
    ['skip', 'state'],
    ['continue', 'state'],
    ['archive', 'state'],
    ['focus', 'focus'],
    ['commit', 'commit'],
    ['note', 'note'],
  ] as const)('%s is a %s decision', (decision, slot) => {
    expect(isReviewDecisionKind(decision)).toBe(true);
    expect(reviewDecisionSlot(decision)).toBe(slot);
  });

  it('covers every stored decision kind and nothing else', () => {
    expect([...reviewDecisionKinds].sort()).toEqual(
      [
        'archive',
        'cancel',
        'carry',
        'commit',
        'complete',
        'continue',
        'focus',
        'move',
        'note',
        'pause',
        'skip',
      ].sort(),
    );
    for (const value of ['resume', 'grade', '', null, 1])
      expect(isReviewDecisionKind(value)).toBe(false);
  });
});

describe('the decision matrix', () => {
  const allowed: readonly (readonly [
    ReviewType,
    ReviewTargetKind,
    readonly ReviewDecisionKind[],
  ])[] = [
    ['daily', 'action', ['complete', 'carry', 'move', 'cancel', 'focus']],
    ['daily', 'routine_occurrence', ['complete', 'skip', 'focus']],
    ['weekly', 'project', ['continue', 'pause', 'commit']],
    ['weekly', 'axis', ['note']],
    ['weekly', 'action', ['commit', 'focus']],
    ['weekly', 'milestone', ['commit']],
    ['weekly', 'routine_occurrence', ['focus']],
    ['monthly', 'outcome', ['continue', 'pause', 'complete', 'cancel', 'archive']],
    ['monthly', 'milestone', ['continue', 'complete', 'cancel', 'archive']],
    ['monthly', 'project', ['continue', 'pause', 'complete', 'archive']],
    ['yearly', 'outcome', ['continue', 'pause', 'complete', 'cancel', 'archive']],
  ];
  const targets: readonly ReviewTargetKind[] = [
    'axis',
    'outcome',
    'milestone',
    'project',
    'action',
    'routine_occurrence',
  ];

  it.each(allowed)('%s reviews offer a %s: %j', (type, target, decisions) => {
    expect(reviewDecisionMatrix[type][target]).toEqual(decisions);
  });

  it('allows exactly the listed pairs and refuses every other combination', () => {
    for (const type of reviewTypes)
      for (const target of targets)
        for (const decision of reviewDecisionKinds) {
          const listed =
            allowed
              .find(([rowType, rowTarget]) => rowType === type && rowTarget === target)?.[2]
              .includes(decision) ?? false;
          expect(
            isAllowedReviewDecision(type, target, decision),
            `${type} ${target} ${decision}`,
          ).toBe(listed);
        }
  });

  it.each([
    ['daily', 'project', 'pause'],
    ['daily', 'action', 'skip'],
    ['daily', 'routine_occurrence', 'carry'],
    ['weekly', 'outcome', 'pause'],
    ['weekly', 'project', 'complete'],
    ['weekly', 'axis', 'continue'],
    ['monthly', 'action', 'complete'],
    ['monthly', 'milestone', 'pause'],
    ['monthly', 'project', 'cancel'],
    ['yearly', 'milestone', 'complete'],
    ['yearly', 'project', 'archive'],
  ] as const)('refuses a %s %s %s decision', (type, target, decision) => {
    expect(isAllowedReviewDecision(type, target, decision)).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(reviewDecisionMatrix)).toBe(true);
    expect(Object.isFrozen(reviewDecisionMatrix.monthly)).toBe(true);
    expect(Object.isFrozen(reviewDecisionMatrix.monthly.outcome)).toBe(true);
  });
});

describe('the state an object decision asks for', () => {
  it.each([
    ['outcome', 'continue', null],
    ['outcome', 'pause', 'paused'],
    ['outcome', 'complete', 'achieved'],
    ['outcome', 'cancel', 'abandoned'],
    ['outcome', 'archive', 'archived'],
    ['milestone', 'continue', null],
    ['milestone', 'complete', 'completed'],
    ['milestone', 'cancel', 'canceled'],
    ['milestone', 'archive', 'archived'],
    ['project', 'continue', null],
    ['project', 'pause', 'paused'],
    ['project', 'complete', 'completed'],
    ['project', 'archive', 'archived'],
  ] as const)('a %s %s decision asks for %s', (kind, decision, state) => {
    expect(expectValue(reviewObjectState(kind, decision))).toBe(state);
  });

  it.each([
    ['milestone', 'pause'],
    ['project', 'cancel'],
    ['outcome', 'carry'],
    ['project', 'focus'],
    ['milestone', 'note'],
  ] as const)('refuses a %s %s decision', (kind, decision) => {
    const result = reviewObjectState(kind, decision);
    expect(rejection(result)).toBe('review_decision');
    expect(messageOf(result)).toBe('This decision is not available here.');
  });
});

/* ───────────────────────── Text, energy, direction ───────────────────────── */

describe('review text and limits', () => {
  it('keeps the documented limits', () => {
    expect(reviewLimits).toEqual({
      notes: 10_000,
      itemNote: 2_000,
      themeText: 2_000,
      directionText: 2_000,
      items: 400,
      focus: 3,
      commitments: 3,
    });
    expect(Object.isFrozen(reviewLimits)).toBe(true);
  });

  it.each([
    ['absent', undefined, undefined],
    ['null', null, undefined],
    ['empty', '', undefined],
    ['blank', ' \n\t ', undefined],
    ['text', 'Slept well.', 'Slept well.'],
    ['text with surrounding space kept as written', '  Calm week. ', '  Calm week. '],
  ] as const)('normalizes %s notes', (_name, value, expected) => {
    expect(expectValue(normalizeReviewText(value, reviewLimits.notes, 'notes'))).toBe(expected);
  });

  it('accepts text at the limit and refuses longer text instead of truncating it', () => {
    const atLimit = 'a'.repeat(reviewLimits.notes);
    expect(expectValue(normalizeReviewText(atLimit, reviewLimits.notes, 'notes'))).toBe(atLimit);
    const longer = normalizeReviewText(`${atLimit}a`, reviewLimits.notes, 'notes');
    expect(rejection(longer)).toBe('notes_too_long');
    expect(messageOf(longer)).toBe('Keep this to 10,000 characters or fewer.');
    // Surrounding spaces count: nothing is trimmed away to make text fit.
    expect(rejection(normalizeReviewText(` ${'a'.repeat(2_000)}`, 2_000, 'note'))).toBe(
      'note_too_long',
    );
  });

  it.each([
    [42, 'notes_invalid'],
    [['text'], 'notes_invalid'],
    [{ text: 'x' }, 'notes_invalid'],
    [true, 'notes_invalid'],
  ] as const)('refuses %j as notes', (value, reason) => {
    expect(rejection(normalizeReviewText(value, reviewLimits.notes, 'notes'))).toBe(reason);
  });
});

describe('review energy', () => {
  it.each(energyLabels)('accepts %s energy', (label) => {
    expect(expectValue(parseReviewEnergy(label))).toBe(label);
  });

  it.each([undefined, null])('treats %s as no energy', (value) => {
    expect(expectValue(parseReviewEnergy(value))).toBeUndefined();
  });

  it.each(['tired', 'LOW', '', 3, ['low'], { label: 'low' }])('refuses %j', (value) => {
    const result = parseReviewEnergy(value);
    expect(rejection(result)).toBe('review_energy');
    expect(messageOf(result)).toBe('Choose low, medium, high, or focused energy.');
  });
});

describe('the yearly direction decision', () => {
  it.each([
    [{ choice: 'continue' }, { choice: 'continue' }],
    [{ choice: 'outdated' }, { choice: 'outdated' }],
    [{ choice: 'continue', text: undefined }, { choice: 'continue' }],
    [
      { choice: 'new', text: 'Build a calmer year.' },
      { choice: 'new', text: 'Build a calmer year.' },
    ],
  ] as const)('accepts %j', (value, expected) => {
    expect(expectValue(parseReviewDirection(value))).toEqual(expected);
  });

  it.each([undefined, null])('treats %s as no decision', (value) => {
    expect(expectValue(parseReviewDirection(value))).toBeUndefined();
  });

  it.each([
    ['a string', 'continue', 'review_direction'],
    ['an array', ['continue'], 'review_direction'],
    ['an unknown choice', { choice: 'keep' }, 'review_direction'],
    ['a missing choice', {}, 'review_direction'],
    ['an unexpected field', { choice: 'continue', reason: 'x' }, 'review_direction'],
    ['text on a continued direction', { choice: 'continue', text: 'x' }, 'review_direction'],
    ['text on an outdated direction', { choice: 'outdated', text: '' }, 'review_direction'],
    ['a new direction without text', { choice: 'new' }, 'direction_required'],
    ['a new direction with blank text', { choice: 'new', text: '   ' }, 'direction_required'],
    ['a new direction with non-text', { choice: 'new', text: 7 }, 'direction_invalid'],
    [
      'a new direction that is too long',
      { choice: 'new', text: 'a'.repeat(2_001) },
      'direction_too_long',
    ],
  ] as const)('refuses %s', (_name, value, reason) => {
    expect(rejection(parseReviewDirection(value))).toBe(reason);
  });

  it('asks calmly for the missing text of a new direction', () => {
    expect(messageOf(parseReviewDirection({ choice: 'new' }))).toBe(
      'Write the new direction, or choose another option.',
    );
  });
});
