import { describe, expect, it } from 'vitest';

import {
  applyOccurrenceExceptions,
  generateRoutineOccurrences,
  parseCalendarDate,
  parseRecurrenceRuleV1,
  parseUUID,
  splitRecurrenceGeneration,
  type CalendarDate,
  type DomainResult,
  type RecurrenceRuleV1,
} from './index.js';

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const date = (value: string): CalendarDate => expectValue(parseCalendarDate(value));
const routineId = expectValue(parseUUID('0190c2b1-7d9a-7cc1-8be5-b88620c57f5a'));

const parseRule = (value: unknown): RecurrenceRuleV1 => expectValue(parseRecurrenceRuleV1(value));

const generatedDates = (rule: RecurrenceRuleV1, start: string, end: string) => {
  const result = generateRoutineOccurrences({
    routineId,
    generation: 3,
    rule,
    windowStart: date(start),
    windowEnd: date(end),
  });
  return expectValue(result);
};

describe('RecurrenceRuleV1 runtime validation', () => {
  it('normalizes selected weekdays and rejects duplicates, invalid bounds, and unknown rules', () => {
    expect(
      parseRecurrenceRuleV1({
        version: 1,
        kind: 'weekly_days',
        intervalWeeks: 2,
        weekdays: ['friday', 'monday'],
        startsOn: '2026-07-01',
      }),
    ).toEqual({
      ok: true,
      value: {
        version: 1,
        kind: 'weekly_days',
        intervalWeeks: 2,
        weekdays: ['monday', 'friday'],
        startsOn: '2026-07-01',
      },
    });
    expect(
      parseRecurrenceRuleV1({
        version: 1,
        kind: 'weekly_days',
        intervalWeeks: 1,
        weekdays: ['monday', 'monday'],
        startsOn: '2026-07-01',
      }).ok,
    ).toBe(false);
    expect(
      parseRecurrenceRuleV1({
        version: 1,
        kind: 'daily',
        intervalDays: 1,
        startsOn: '2026-08-01',
        endsOn: '2026-07-31',
      }).ok,
    ).toBe(false);
    expect(parseRecurrenceRuleV1({ version: 1, kind: 'yearly', startsOn: '2026-07-01' }).ok).toBe(
      false,
    );
    expect(parseRecurrenceRuleV1('FREQ=DAILY').ok).toBe(false);
  });
});

describe('bounded deterministic occurrence generation', () => {
  it('generates interval-day occurrences only inside the requested inclusive window', () => {
    const occurrences = generatedDates(
      parseRule({
        version: 1,
        kind: 'daily',
        intervalDays: 2,
        startsOn: '2026-07-01',
        endsOn: '2026-07-10',
      }),
      '2026-07-04',
      '2026-07-12',
    );
    expect(occurrences.map((item) => item.period)).toEqual([
      { kind: 'date', date: '2026-07-05' },
      { kind: 'date', date: '2026-07-07' },
      { kind: 'date', date: '2026-07-09' },
    ]);
  });

  it('generates selected weekdays in interval weeks anchored to startsOn', () => {
    const occurrences = generatedDates(
      parseRule({
        version: 1,
        kind: 'weekly_days',
        intervalWeeks: 2,
        weekdays: ['monday', 'friday'],
        startsOn: '2026-07-02',
      }),
      '2026-07-01',
      '2026-07-31',
    );
    expect(occurrences.map((item) => item.period)).toEqual([
      { kind: 'date', date: '2026-07-03' },
      { kind: 'date', date: '2026-07-06' },
      { kind: 'date', date: '2026-07-17' },
      { kind: 'date', date: '2026-07-20' },
      { kind: 'date', date: '2026-07-31' },
    ]);
  });

  it('generates one weekly-count occurrence per exact Week, never one per day', () => {
    const occurrences = generatedDates(
      parseRule({
        version: 1,
        kind: 'weekly_count',
        targetCount: 4,
        weekStart: 'monday',
        startsOn: '2026-07-23',
      }),
      '2026-07-20',
      '2026-08-09',
    );
    expect(occurrences).toHaveLength(3);
    expect(occurrences.map((item) => item.period)).toEqual([
      {
        kind: 'week',
        start: '2026-07-20',
        end: '2026-07-26',
        weekStart: 'monday',
        targetCount: 4,
      },
      {
        kind: 'week',
        start: '2026-07-27',
        end: '2026-08-02',
        weekStart: 'monday',
        targetCount: 4,
      },
      {
        kind: 'week',
        start: '2026-08-03',
        end: '2026-08-09',
        weekStart: 'monday',
        targetCount: 4,
      },
    ]);
  });

  it('applies explicit monthly missing-day policies', () => {
    const base = {
      version: 1,
      kind: 'monthly_day',
      intervalMonths: 1,
      dayOfMonth: 31,
      startsOn: '2026-01-31',
    } as const;
    expect(
      generatedDates(
        parseRule({ ...base, missingDayPolicy: 'skip' }),
        '2026-01-01',
        '2026-04-30',
      ).map((item) => item.period),
    ).toEqual([
      { kind: 'date', date: '2026-01-31' },
      { kind: 'date', date: '2026-03-31' },
    ]);
    expect(
      generatedDates(
        parseRule({ ...base, missingDayPolicy: 'last_day' }),
        '2026-01-01',
        '2026-04-30',
      ).map((item) => item.period),
    ).toEqual([
      { kind: 'date', date: '2026-01-31' },
      { kind: 'date', date: '2026-02-28' },
      { kind: 'date', date: '2026-03-31' },
      { kind: 'date', date: '2026-04-30' },
    ]);
  });

  it('crosses leap-day and year boundaries without implying a yearly rule', () => {
    expect(
      generatedDates(
        parseRule({
          version: 1,
          kind: 'daily',
          intervalDays: 1,
          startsOn: '2024-02-28',
        }),
        '2024-02-28',
        '2024-03-01',
      ).map((item) => item.period),
    ).toEqual([
      { kind: 'date', date: '2024-02-28' },
      { kind: 'date', date: '2024-02-29' },
      { kind: 'date', date: '2024-03-01' },
    ]);
    expect(
      generatedDates(
        parseRule({
          version: 1,
          kind: 'monthly_day',
          intervalMonths: 1,
          dayOfMonth: 31,
          missingDayPolicy: 'skip',
          startsOn: '2025-12-31',
        }),
        '2025-12-01',
        '2026-01-31',
      ).map((item) => item.period),
    ).toEqual([
      { kind: 'date', date: '2025-12-31' },
      { kind: 'date', date: '2026-01-31' },
    ]);
  });

  it('rejects reversed generation windows instead of guessing an unbounded range', () => {
    expect(
      generateRoutineOccurrences({
        routineId,
        generation: 1,
        rule: parseRule({
          version: 1,
          kind: 'daily',
          intervalDays: 1,
          startsOn: '2026-07-01',
        }),
        windowStart: date('2026-07-10'),
        windowEnd: date('2026-07-01'),
      }).ok,
    ).toBe(false);
  });

  it('derives stable device-independent logical keys', () => {
    const rule = parseRule({
      version: 1,
      kind: 'daily',
      intervalDays: 1,
      startsOn: '2026-07-23',
    });
    const first = generatedDates(rule, '2026-07-23', '2026-07-24');
    const second = generatedDates(rule, '2026-07-23', '2026-07-24');
    expect(first).toEqual(second);
    expect(first[0]?.logicalKey).toBe('0190c2b1-7d9a-7cc1-8be5-b88620c57f5a:g3:date:2026-07-23:o0');
  });
});

describe('occurrence exceptions and generation splits', () => {
  it('applies a this-occurrence exclusion/override without mutating the rule', () => {
    const rule = parseRule({
      version: 1,
      kind: 'daily',
      intervalDays: 1,
      startsOn: '2026-07-23',
    });
    const occurrences = generatedDates(rule, '2026-07-23', '2026-07-25');
    const adjusted = applyOccurrenceExceptions(occurrences, [
      { logicalKey: occurrences[0]!.logicalKey, kind: 'exclude' },
      {
        logicalKey: occurrences[1]!.logicalKey,
        kind: 'move_date',
        date: date('2026-07-27'),
      },
    ]);
    expect(adjusted).toHaveLength(2);
    expect(adjusted[0]?.period).toEqual({ kind: 'date', date: '2026-07-27' });
    expect(rule.startsOn).toBe('2026-07-23');
  });

  it('closes history and increments generation for This-and-future', () => {
    const result = splitRecurrenceGeneration({
      generation: 4,
      currentRule: parseRule({
        version: 1,
        kind: 'daily',
        intervalDays: 1,
        startsOn: '2026-07-01',
      }),
      selectedOn: date('2026-07-23'),
      futureRule: {
        version: 1,
        kind: 'weekly_days',
        intervalWeeks: 1,
        weekdays: ['monday'],
        startsOn: '1999-01-01',
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        previous: {
          generation: 4,
          rule: {
            version: 1,
            kind: 'daily',
            intervalDays: 1,
            startsOn: '2026-07-01',
            endsOn: '2026-07-22',
          },
        },
        next: {
          generation: 5,
          rule: {
            version: 1,
            kind: 'weekly_days',
            intervalWeeks: 1,
            weekdays: ['monday'],
            startsOn: '2026-07-23',
          },
        },
      },
    });
  });
});
