import { Temporal } from '@js-temporal/polyfill';

import { err, ok, type Brand, type DomainResult, type EntityId } from './contracts.js';
import {
  createWeekPeriod,
  parseCalendarDate,
  type CalendarDate,
  type Weekday,
  type WeekPeriod,
} from './time.js';

interface RecurrenceRuleBase {
  readonly version: 1;
  readonly startsOn: CalendarDate;
  readonly endsOn?: CalendarDate;
}

export interface DailyRecurrenceRuleV1 extends RecurrenceRuleBase {
  readonly kind: 'daily';
  readonly intervalDays: number;
}

export interface WeeklyDaysRecurrenceRuleV1 extends RecurrenceRuleBase {
  readonly kind: 'weekly_days';
  readonly intervalWeeks: number;
  readonly weekdays: readonly Weekday[];
}

export interface WeeklyCountRecurrenceRuleV1 extends RecurrenceRuleBase {
  readonly kind: 'weekly_count';
  readonly targetCount: number;
  readonly weekStart: Weekday;
}

export type MonthlyMissingDayPolicy = 'skip' | 'last_day';

export interface MonthlyDayRecurrenceRuleV1 extends RecurrenceRuleBase {
  readonly kind: 'monthly_day';
  readonly intervalMonths: number;
  readonly dayOfMonth: number;
  readonly missingDayPolicy: MonthlyMissingDayPolicy;
}

export type RecurrenceRuleV1 =
  | DailyRecurrenceRuleV1
  | WeeklyDaysRecurrenceRuleV1
  | WeeklyCountRecurrenceRuleV1
  | MonthlyDayRecurrenceRuleV1;

export type RoutineOccurrenceKey = Brand<string, 'RoutineOccurrenceKey'>;

export type GeneratedOccurrencePeriod =
  | { readonly kind: 'date'; readonly date: CalendarDate }
  | (WeekPeriod & { readonly targetCount: number });

export interface GeneratedRoutineOccurrence {
  readonly routineId: EntityId;
  readonly generation: number;
  readonly logicalKey: RoutineOccurrenceKey;
  readonly ordinal: number;
  readonly period: GeneratedOccurrencePeriod;
}

export interface GenerateRoutineOccurrencesInput {
  readonly routineId: EntityId;
  readonly generation: number;
  readonly rule: RecurrenceRuleV1;
  readonly windowStart: CalendarDate;
  readonly windowEnd: CalendarDate;
}

const weekdayOrder: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const recurrenceError = (reason: string): DomainResult<never> =>
  err({
    code: 'invalid_recurrence',
    message: 'The recurrence rule is invalid.',
    details: { reason },
  });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const readBoundaries = (
  value: Readonly<Record<string, unknown>>,
): DomainResult<{ readonly startsOn: CalendarDate; readonly endsOn?: CalendarDate }> => {
  const startValue = value['startsOn'];
  if (typeof startValue !== 'string') return recurrenceError('startsOn');
  const start = parseCalendarDate(startValue);
  if (!start.ok) return recurrenceError('startsOn');

  const endValue = value['endsOn'];
  if (endValue === undefined) return ok({ startsOn: start.value });
  if (typeof endValue !== 'string') return recurrenceError('endsOn');
  const end = parseCalendarDate(endValue);
  if (!end.ok || end.value < start.value) return recurrenceError('endsOn');
  return ok({ startsOn: start.value, endsOn: end.value });
};

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const withBounds = <Rule extends Omit<RecurrenceRuleBase, 'startsOn' | 'endsOn'>>(
  rule: Rule,
  boundaries: { readonly startsOn: CalendarDate; readonly endsOn?: CalendarDate },
): Rule & RecurrenceRuleBase =>
  boundaries.endsOn === undefined
    ? { ...rule, startsOn: boundaries.startsOn }
    : { ...rule, startsOn: boundaries.startsOn, endsOn: boundaries.endsOn };

export const parseRecurrenceRuleV1 = (value: unknown): DomainResult<RecurrenceRuleV1> => {
  if (!isRecord(value) || value['version'] !== 1 || typeof value['kind'] !== 'string') {
    return recurrenceError('shape');
  }

  const boundaries = readBoundaries(value);
  if (!boundaries.ok) return boundaries;

  switch (value['kind']) {
    case 'daily': {
      if (
        !hasOnlyKeys(value, ['version', 'kind', 'intervalDays', 'startsOn', 'endsOn']) ||
        !isPositiveInteger(value['intervalDays'])
      ) {
        return recurrenceError('daily');
      }
      return ok(
        withBounds(
          { version: 1, kind: 'daily', intervalDays: value['intervalDays'] },
          boundaries.value,
        ),
      );
    }
    case 'weekly_days': {
      const weekdayValues = value['weekdays'];
      if (
        !hasOnlyKeys(value, [
          'version',
          'kind',
          'intervalWeeks',
          'weekdays',
          'startsOn',
          'endsOn',
        ]) ||
        !isPositiveInteger(value['intervalWeeks']) ||
        !Array.isArray(weekdayValues) ||
        weekdayValues.length === 0 ||
        !weekdayValues.every(
          (weekday): weekday is Weekday =>
            typeof weekday === 'string' && weekdayOrder.includes(weekday as Weekday),
        ) ||
        new Set(weekdayValues).size !== weekdayValues.length
      ) {
        return recurrenceError('weekly_days');
      }
      const weekdays = [...weekdayValues].sort(
        (left, right) => weekdayOrder.indexOf(left) - weekdayOrder.indexOf(right),
      );
      return ok(
        withBounds(
          {
            version: 1,
            kind: 'weekly_days',
            intervalWeeks: value['intervalWeeks'],
            weekdays,
          },
          boundaries.value,
        ),
      );
    }
    case 'weekly_count': {
      const weekStart = value['weekStart'];
      if (
        !hasOnlyKeys(value, [
          'version',
          'kind',
          'targetCount',
          'weekStart',
          'startsOn',
          'endsOn',
        ]) ||
        !isPositiveInteger(value['targetCount']) ||
        typeof weekStart !== 'string' ||
        !weekdayOrder.includes(weekStart as Weekday)
      ) {
        return recurrenceError('weekly_count');
      }
      return ok(
        withBounds(
          {
            version: 1,
            kind: 'weekly_count',
            targetCount: value['targetCount'],
            weekStart: weekStart as Weekday,
          },
          boundaries.value,
        ),
      );
    }
    case 'monthly_day': {
      const policy = value['missingDayPolicy'];
      const dayOfMonth = value['dayOfMonth'];
      if (
        !hasOnlyKeys(value, [
          'version',
          'kind',
          'intervalMonths',
          'dayOfMonth',
          'missingDayPolicy',
          'startsOn',
          'endsOn',
        ]) ||
        !isPositiveInteger(value['intervalMonths']) ||
        !isPositiveInteger(dayOfMonth) ||
        dayOfMonth > 31 ||
        (policy !== 'skip' && policy !== 'last_day')
      ) {
        return recurrenceError('monthly_day');
      }
      return ok(
        withBounds(
          {
            version: 1,
            kind: 'monthly_day',
            intervalMonths: value['intervalMonths'],
            dayOfMonth,
            missingDayPolicy: policy,
          },
          boundaries.value,
        ),
      );
    }
    default:
      return recurrenceError('unsupported_kind');
  }
};

const maxDate = (left: Temporal.PlainDate, right: Temporal.PlainDate): Temporal.PlainDate =>
  Temporal.PlainDate.compare(left, right) >= 0 ? left : right;

const minDate = (left: Temporal.PlainDate, right: Temporal.PlainDate): Temporal.PlainDate =>
  Temporal.PlainDate.compare(left, right) <= 0 ? left : right;

const dayDistance = (from: Temporal.PlainDate, to: Temporal.PlainDate): number =>
  from.until(to, { largestUnit: 'day' }).days;

export const routineOccurrenceKey = (
  routineId: EntityId,
  generation: number,
  periodKind: 'date' | 'week',
  periodKey: string,
  ordinal = 0,
): RoutineOccurrenceKey =>
  `${routineId}:g${generation}:${periodKind}:${periodKey}:o${ordinal}` as RoutineOccurrenceKey;

const dateOccurrence = (
  routineId: EntityId,
  generation: number,
  date: Temporal.PlainDate,
): GeneratedRoutineOccurrence => {
  const dateValue = date.toString() as CalendarDate;
  return {
    routineId,
    generation,
    logicalKey: routineOccurrenceKey(routineId, generation, 'date', dateValue),
    ordinal: 0,
    period: { kind: 'date', date: dateValue },
  };
};

const effectiveGenerationRange = (
  rule: RecurrenceRuleV1,
  windowStart: CalendarDate,
  windowEnd: CalendarDate,
): DomainResult<
  | { readonly empty: true }
  | { readonly empty: false; readonly start: Temporal.PlainDate; readonly end: Temporal.PlainDate }
> => {
  const parsedStart = parseCalendarDate(windowStart);
  const parsedEnd = parseCalendarDate(windowEnd);
  if (!parsedStart.ok || !parsedEnd.ok || parsedStart.value > parsedEnd.value) {
    return recurrenceError('window');
  }

  const start = maxDate(
    Temporal.PlainDate.from(rule.startsOn),
    Temporal.PlainDate.from(windowStart),
  );
  const ruleEnd = Temporal.PlainDate.from(rule.endsOn ?? windowEnd);
  const end = minDate(ruleEnd, Temporal.PlainDate.from(windowEnd));
  if (Temporal.PlainDate.compare(start, end) > 0) return ok({ empty: true });
  return ok({ empty: false, start, end });
};

const generateDaily = (
  input: GenerateRoutineOccurrencesInput,
  rule: DailyRecurrenceRuleV1,
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
): readonly GeneratedRoutineOccurrence[] => {
  const anchor = Temporal.PlainDate.from(rule.startsOn);
  let cursor = start;
  const remainder = dayDistance(anchor, cursor) % rule.intervalDays;
  if (remainder !== 0) cursor = cursor.add({ days: rule.intervalDays - remainder });
  const output: GeneratedRoutineOccurrence[] = [];
  while (Temporal.PlainDate.compare(cursor, end) <= 0) {
    output.push(dateOccurrence(input.routineId, input.generation, cursor));
    cursor = cursor.add({ days: rule.intervalDays });
  }
  return output;
};

const generateWeeklyDays = (
  input: GenerateRoutineOccurrencesInput,
  rule: WeeklyDaysRecurrenceRuleV1,
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
): readonly GeneratedRoutineOccurrence[] => {
  const anchor = Temporal.PlainDate.from(rule.startsOn);
  const selected = new Set(rule.weekdays);
  const output: GeneratedRoutineOccurrence[] = [];
  let cursor = start;
  while (Temporal.PlainDate.compare(cursor, end) <= 0) {
    const days = dayDistance(anchor, cursor);
    const intervalWeek = Math.floor(days / 7);
    const weekday = weekdayOrder[cursor.dayOfWeek - 1];
    if (intervalWeek % rule.intervalWeeks === 0 && weekday !== undefined && selected.has(weekday)) {
      output.push(dateOccurrence(input.routineId, input.generation, cursor));
    }
    cursor = cursor.add({ days: 1 });
  }
  return output;
};

const generateWeeklyCount = (
  input: GenerateRoutineOccurrencesInput,
  rule: WeeklyCountRecurrenceRuleV1,
): readonly GeneratedRoutineOccurrence[] => {
  const first = createWeekPeriod(rule.startsOn, rule.weekStart);
  let weekStart = Temporal.PlainDate.from(first.start);
  const windowStart = Temporal.PlainDate.from(input.windowStart);
  const windowEnd = Temporal.PlainDate.from(input.windowEnd);
  const seriesEnd = Temporal.PlainDate.from(rule.endsOn ?? input.windowEnd);
  while (Temporal.PlainDate.compare(weekStart.add({ days: 6 }), windowStart) < 0) {
    weekStart = weekStart.add({ days: 7 });
  }

  const output: GeneratedRoutineOccurrence[] = [];
  while (
    Temporal.PlainDate.compare(weekStart, windowEnd) <= 0 &&
    Temporal.PlainDate.compare(weekStart, seriesEnd) <= 0
  ) {
    const end = weekStart.add({ days: 6 });
    if (
      Temporal.PlainDate.compare(end, Temporal.PlainDate.from(rule.startsOn)) >= 0 &&
      Temporal.PlainDate.compare(weekStart, seriesEnd) <= 0
    ) {
      const startValue = weekStart.toString() as CalendarDate;
      const endValue = end.toString() as CalendarDate;
      const periodKey = `${startValue}/${endValue}/${rule.weekStart}`;
      output.push({
        routineId: input.routineId,
        generation: input.generation,
        logicalKey: routineOccurrenceKey(input.routineId, input.generation, 'week', periodKey),
        ordinal: 0,
        period: {
          kind: 'week',
          start: startValue,
          end: endValue,
          weekStart: rule.weekStart,
          targetCount: rule.targetCount,
        },
      });
    }
    weekStart = weekStart.add({ days: 7 });
  }
  return output;
};

const generateMonthly = (
  input: GenerateRoutineOccurrencesInput,
  rule: MonthlyDayRecurrenceRuleV1,
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
): readonly GeneratedRoutineOccurrence[] => {
  const anchorMonth = Temporal.PlainYearMonth.from(rule.startsOn.slice(0, 7));
  let month = anchorMonth;
  const startMonth = Temporal.PlainYearMonth.from(start.toString().slice(0, 7));
  const monthsFromAnchor = anchorMonth.until(startMonth, { largestUnit: 'month' }).months;
  const remainder = monthsFromAnchor % rule.intervalMonths;
  if (monthsFromAnchor > 0) {
    month = anchorMonth.add({
      months:
        remainder === 0 ? monthsFromAnchor : monthsFromAnchor + rule.intervalMonths - remainder,
    });
  }

  const output: GeneratedRoutineOccurrence[] = [];
  const endMonth = Temporal.PlainYearMonth.from(end.toString().slice(0, 7));
  while (Temporal.PlainYearMonth.compare(month, endMonth) <= 0) {
    const missing = rule.dayOfMonth > month.daysInMonth;
    if (!missing || rule.missingDayPolicy === 'last_day') {
      const day = missing ? month.daysInMonth : rule.dayOfMonth;
      const occurrenceDate = month.toPlainDate({ day });
      if (
        Temporal.PlainDate.compare(occurrenceDate, start) >= 0 &&
        Temporal.PlainDate.compare(occurrenceDate, end) <= 0
      ) {
        output.push(dateOccurrence(input.routineId, input.generation, occurrenceDate));
      }
    }
    month = month.add({ months: rule.intervalMonths });
  }
  return output;
};

export const generateRoutineOccurrences = (
  input: GenerateRoutineOccurrencesInput,
): DomainResult<readonly GeneratedRoutineOccurrence[]> => {
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    return recurrenceError('generation');
  }
  const validatedRule = parseRecurrenceRuleV1(input.rule);
  if (!validatedRule.ok) return validatedRule;
  const range = effectiveGenerationRange(validatedRule.value, input.windowStart, input.windowEnd);
  if (!range.ok) return range;
  if (range.value.empty) return ok([]);

  switch (validatedRule.value.kind) {
    case 'daily':
      return ok(generateDaily(input, validatedRule.value, range.value.start, range.value.end));
    case 'weekly_days':
      return ok(generateWeeklyDays(input, validatedRule.value, range.value.start, range.value.end));
    case 'weekly_count':
      return ok(generateWeeklyCount(input, validatedRule.value));
    case 'monthly_day':
      return ok(generateMonthly(input, validatedRule.value, range.value.start, range.value.end));
  }
};

export type OccurrenceException =
  | { readonly kind: 'exclude'; readonly logicalKey: RoutineOccurrenceKey }
  | {
      readonly kind: 'move_date';
      readonly logicalKey: RoutineOccurrenceKey;
      readonly date: CalendarDate;
    };

export const applyOccurrenceExceptions = (
  occurrences: readonly GeneratedRoutineOccurrence[],
  exceptions: readonly OccurrenceException[],
): readonly GeneratedRoutineOccurrence[] => {
  const byKey = new Map(exceptions.map((exception) => [exception.logicalKey, exception]));
  return occurrences.flatMap((occurrence) => {
    const exception = byKey.get(occurrence.logicalKey);
    if (exception?.kind === 'exclude') return [];
    if (exception?.kind === 'move_date' && occurrence.period.kind === 'date') {
      return [{ ...occurrence, period: { kind: 'date' as const, date: exception.date } }];
    }
    return [occurrence];
  });
};

export interface RecurrenceGeneration {
  readonly generation: number;
  readonly rule: RecurrenceRuleV1;
}

export interface SplitRecurrenceGenerationInput {
  readonly generation: number;
  readonly currentRule: RecurrenceRuleV1;
  readonly selectedOn: CalendarDate;
  readonly futureRule: unknown;
}

export interface SplitRecurrenceGenerationResult {
  readonly previous: RecurrenceGeneration;
  readonly next: RecurrenceGeneration;
}

export const splitRecurrenceGeneration = (
  input: SplitRecurrenceGenerationInput,
): DomainResult<SplitRecurrenceGenerationResult> => {
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    return recurrenceError('generation');
  }
  const current = parseRecurrenceRuleV1(input.currentRule);
  if (!current.ok) return current;
  if (
    input.selectedOn <= current.value.startsOn ||
    (current.value.endsOn !== undefined && input.selectedOn > current.value.endsOn)
  ) {
    return recurrenceError('selectedOn');
  }
  if (!isRecord(input.futureRule)) return recurrenceError('futureRule');

  const future = parseRecurrenceRuleV1({ ...input.futureRule, startsOn: input.selectedOn });
  if (!future.ok) return future;
  const priorEnd = Temporal.PlainDate.from(input.selectedOn)
    .subtract({ days: 1 })
    .toString() as CalendarDate;
  const previousRule = { ...current.value, endsOn: priorEnd } as RecurrenceRuleV1;

  return ok({
    previous: { generation: input.generation, rule: previousRule },
    next: { generation: input.generation + 1, rule: future.value },
  });
};
