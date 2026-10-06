import { Temporal } from '@js-temporal/polyfill';

import { err, ok, type DomainResult, type EntityId, type Instant } from './contracts.js';
import type { RoutineSchedulingMode, RoutineZonePolicy } from './entities.js';
import { addDays, weekdayOf, type DateRange } from './horizons.js';
import {
  generateRoutineOccurrences,
  parseRecurrenceRuleV1,
  routineOccurrenceKey,
  type GeneratedOccurrencePeriod,
  type RecurrenceRuleV1,
  type RoutineOccurrenceKey,
} from './recurrence.js';
import type { RoutineOccurrenceState, RoutineState } from './states.js';
import {
  parseCalendarDate,
  parseIanaTimeZone,
  parseWallTime,
  resolveFloatingDateTime,
  type CalendarDate,
  type DstGapPolicy,
  type DstOverlapPolicy,
  type IanaTimeZone,
  type WallTime,
} from './time.js';
import { deriveNameBasedUuid, yelaxisDerivedIdNamespace } from './uuid.js';
import { isInputRecord } from './input-record.js';

export const routineLimits = Object.freeze({
  title: 200,
  description: 10_000,
  durationMinutes: 1_440,
});

export interface RoutineGenerationSpec {
  readonly generation: number;
  readonly rule: RecurrenceRuleV1;
  readonly schedulingMode: RoutineSchedulingMode;
}

export interface RoutineSeriesSnapshot {
  readonly id: EntityId;
  readonly state: RoutineState;
  readonly pauseEffectiveOn?: CalendarDate;
  /** Ascending, contiguous generations starting at 1. */
  readonly generations: readonly RoutineGenerationSpec[];
}

/** Version 1 of a This-occurrence override. The Routine rule itself is never changed by it. */
export interface OccurrenceOverrideV1 {
  readonly date?: CalendarDate;
  readonly wallTime?: WallTime;
  readonly durationMinutes?: number;
  readonly overlapAcknowledged?: true;
}

export interface MaterializedOccurrenceSnapshot {
  readonly id: EntityId;
  readonly routineId: EntityId;
  readonly generation: number;
  readonly logicalKey: RoutineOccurrenceKey;
  readonly period: GeneratedOccurrencePeriod;
  readonly state: RoutineOccurrenceState;
  readonly localRevision: number;
  readonly targetCount?: number;
  readonly completedCount?: number;
  readonly extraCompletionsConfirmed?: boolean;
  readonly override?: OccurrenceOverrideV1;
  readonly completedAt?: Instant;
}

export type OccurrenceTiming =
  | { readonly kind: 'flexible' }
  | { readonly kind: 'weekly_count' }
  | {
      readonly kind: 'timed';
      readonly startsAt: Instant;
      readonly endsAt: Instant;
      readonly timeZone: IanaTimeZone;
      readonly wallTime: WallTime;
      readonly durationMinutes: number;
    }
  | { readonly kind: 'dst_skipped'; readonly wallTime: WallTime; readonly timeZone: IanaTimeZone };

export interface ProjectedOccurrence {
  readonly id: EntityId;
  readonly routineId: EntityId;
  readonly generation: number;
  readonly logicalKey: RoutineOccurrenceKey;
  readonly period: GeneratedOccurrencePeriod;
  /** Effective local date for dated occurrences (override date when moved). */
  readonly date?: CalendarDate;
  readonly moved: boolean;
  readonly state: RoutineOccurrenceState;
  readonly materialized: boolean;
  readonly localRevision?: number;
  readonly timing: OccurrenceTiming;
  readonly targetCount?: number;
  readonly completedCount?: number;
  readonly extraCompletionsConfirmed?: boolean;
  readonly override?: OccurrenceOverrideV1;
  readonly overlapAcknowledged: boolean;
}

const routineError = (
  reason: string,
  message = 'The Routine request is invalid.',
): DomainResult<never> =>
  err({
    code: 'invalid_value',
    message,
    details: { reason },
  });

const transitionError = (reason: string): DomainResult<never> =>
  err({
    code: 'invalid_transition',
    message: 'The Routine Occurrence change is not allowed.',
    details: { reason },
  });

/** Deterministic occurrence identity so repeated or concurrent materialization never duplicates. */
export const routineOccurrenceId = (logicalKey: RoutineOccurrenceKey): EntityId =>
  deriveNameBasedUuid(yelaxisDerivedIdNamespace, `routine-occurrence:${logicalKey}`);

export const occurrencePeriodKey = (period: GeneratedOccurrencePeriod): string =>
  period.kind === 'date' ? period.date : `${period.start}/${period.end}/${period.weekStart}`;

export const occurrenceLogicalKey = (
  routineId: EntityId,
  generation: number,
  period: GeneratedOccurrencePeriod,
  ordinal = 0,
): RoutineOccurrenceKey =>
  routineOccurrenceKey(routineId, generation, period.kind, occurrencePeriodKey(period), ordinal);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseOccurrenceOverride = (value: unknown): DomainResult<OccurrenceOverrideV1> => {
  if (!isRecord(value)) return routineError('override_shape');
  const allowed = ['date', 'wallTime', 'durationMinutes', 'overlapAcknowledged'];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    return routineError('override_shape');
  const output: {
    date?: CalendarDate;
    wallTime?: WallTime;
    durationMinutes?: number;
    overlapAcknowledged?: true;
  } = {};
  if (value['date'] !== undefined) {
    if (typeof value['date'] !== 'string') return routineError('override_date');
    const parsed = parseCalendarDate(value['date']);
    if (!parsed.ok) return routineError('override_date');
    output.date = parsed.value;
  }
  if (value['wallTime'] !== undefined) {
    if (typeof value['wallTime'] !== 'string') return routineError('override_time');
    const parsed = parseWallTime(value['wallTime']);
    if (!parsed.ok) return routineError('override_time');
    output.wallTime = parsed.value;
  }
  const duration = value['durationMinutes'];
  if (duration !== undefined) {
    if (
      typeof duration !== 'number' ||
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > routineLimits.durationMinutes
    )
      return routineError('override_duration');
    output.durationMinutes = duration;
  }
  if (value['overlapAcknowledged'] !== undefined) {
    if (value['overlapAcknowledged'] !== true) return routineError('override_overlap');
    output.overlapAcknowledged = true;
  }
  return ok(output);
};

export interface RoutineDefinitionInput {
  readonly title: string;
  readonly description?: string;
  readonly rule: unknown;
  readonly schedulingMode: unknown;
}

export interface RoutineDefinition {
  readonly title: string;
  readonly description?: string;
  readonly rule: RecurrenceRuleV1;
  readonly schedulingMode: RoutineSchedulingMode;
}

export const parseRoutineSchedulingMode = (value: unknown): DomainResult<RoutineSchedulingMode> => {
  if (!isRecord(value)) return routineError('scheduling_mode');
  if (value['kind'] === 'day_flexible') {
    return Object.keys(value).length === 1
      ? ok({ kind: 'day_flexible' })
      : routineError('scheduling_mode');
  }
  if (value['kind'] !== 'time_specific') return routineError('scheduling_mode');
  const allowed = [
    'kind',
    'wallTime',
    'durationMinutes',
    'zonePolicy',
    'gapPolicy',
    'overlapPolicy',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    return routineError('scheduling_mode');
  const wallTime = typeof value['wallTime'] === 'string' ? parseWallTime(value['wallTime']) : null;
  if (wallTime === null || !wallTime.ok) return routineError('wall_time');
  const duration = value['durationMinutes'];
  if (
    typeof duration !== 'number' ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > routineLimits.durationMinutes
  )
    return routineError('duration_minutes');
  const policy = value['zonePolicy'];
  let zonePolicy: RoutineZonePolicy;
  if (isRecord(policy) && policy['kind'] === 'follow_profile' && Object.keys(policy).length === 1) {
    zonePolicy = { kind: 'follow_profile' };
  } else if (
    isRecord(policy) &&
    policy['kind'] === 'fixed_zone' &&
    typeof policy['timeZone'] === 'string' &&
    Object.keys(policy).length === 2
  ) {
    const zone = parseIanaTimeZone(policy['timeZone']);
    if (!zone.ok) return routineError('zone_policy');
    zonePolicy = { kind: 'fixed_zone', timeZone: zone.value };
  } else {
    return routineError('zone_policy');
  }
  const gap = value['gapPolicy'];
  const repeated = value['overlapPolicy'];
  if (gap !== 'shift_forward' && gap !== 'skip') return routineError('gap_policy');
  if (repeated !== 'earlier_offset' && repeated !== 'later_offset')
    return routineError('overlap_policy');
  return ok({
    kind: 'time_specific',
    wallTime: wallTime.value,
    durationMinutes: duration,
    zonePolicy,
    gapPolicy: gap,
    overlapPolicy: repeated,
  });
};

export const parseRoutineDefinition = (
  input: RoutineDefinitionInput,
): DomainResult<RoutineDefinition> => {
  if (
    !isInputRecord(input, ['title', 'description', 'rule', 'schedulingMode']) ||
    typeof input.title !== 'string' ||
    (input.description !== undefined && typeof input.description !== 'string')
  )
    return routineError('input_shape');
  const title = input.title.trim();
  if (title.length === 0 || title.length > routineLimits.title) return routineError('title');
  const description = input.description?.trim();
  if (description !== undefined && description.length > routineLimits.description)
    return routineError('description');
  const rule = parseRecurrenceRuleV1(input.rule);
  if (!rule.ok) return rule;
  const mode = parseRoutineSchedulingMode(input.schedulingMode);
  if (!mode.ok) return mode;
  if (rule.value.kind === 'weekly_count' && mode.value.kind !== 'day_flexible')
    return routineError('weekly_count_is_day_flexible');
  return ok({
    title,
    ...(description === undefined || description.length === 0 ? {} : { description }),
    rule: rule.value,
    schedulingMode: mode.value,
  });
};

export const currentGeneration = (
  series: Pick<RoutineSeriesSnapshot, 'generations'>,
): RoutineGenerationSpec => {
  const last = series.generations.at(-1);
  if (last === undefined) throw new RangeError('A Routine needs at least one generation.');
  return last;
};

const occurrenceDate = (period: GeneratedOccurrencePeriod): CalendarDate =>
  period.kind === 'date' ? period.date : period.start;

const resolveTiming = (
  mode: RoutineSchedulingMode,
  date: CalendarDate | undefined,
  override: OccurrenceOverrideV1 | undefined,
  planningTimeZone: IanaTimeZone,
  weekly: boolean,
): OccurrenceTiming => {
  if (weekly) return { kind: 'weekly_count' };
  if (mode.kind === 'day_flexible' || date === undefined) {
    if (
      override?.wallTime !== undefined &&
      override.durationMinutes !== undefined &&
      date !== undefined
    ) {
      return resolveTimed(
        date,
        override.wallTime,
        override.durationMinutes,
        planningTimeZone,
        'shift_forward',
        'earlier_offset',
      );
    }
    return { kind: 'flexible' };
  }
  const timeZone =
    mode.zonePolicy.kind === 'fixed_zone' ? mode.zonePolicy.timeZone : planningTimeZone;
  return resolveTimed(
    date,
    override?.wallTime ?? mode.wallTime,
    override?.durationMinutes ?? mode.durationMinutes,
    timeZone,
    mode.gapPolicy,
    mode.overlapPolicy,
  );
};

const resolveTimed = (
  date: CalendarDate,
  wallTime: WallTime,
  durationMinutes: number,
  timeZone: IanaTimeZone,
  gapPolicy: DstGapPolicy,
  overlapPolicy: DstOverlapPolicy,
): OccurrenceTiming => {
  const start = resolveFloatingDateTime({ date, wallTime, timeZone, gapPolicy, overlapPolicy });
  if (!start.ok || start.value === null) return { kind: 'dst_skipped', wallTime, timeZone };
  return {
    kind: 'timed',
    startsAt: start.value,
    endsAt: Temporal.Instant.from(start.value)
      .add({ minutes: durationMinutes })
      .toString({ smallestUnit: 'millisecond' }) as Instant,
    timeZone,
    wallTime,
    durationMinutes,
  };
};

/**
 * Merge lazily generated occurrences with materialized rows for a bounded window. Generated
 * occurrences stop at the pause date; materialized history always remains. A moved occurrence
 * appears on its override date and keeps its logical key.
 */
export const projectRoutineOccurrences = (input: {
  readonly series: RoutineSeriesSnapshot;
  readonly materialized: readonly MaterializedOccurrenceSnapshot[];
  readonly window: DateRange;
  readonly planningTimeZone: IanaTimeZone;
}): DomainResult<readonly ProjectedOccurrence[]> => {
  const { series, window } = input;
  const byKey = new Map<RoutineOccurrenceKey, ProjectedOccurrence>();
  const generationByNumber = new Map(series.generations.map((spec) => [spec.generation, spec]));
  // A pristine row (planned, never changed) carries no user decision. Once its generation no
  // longer generates that period (after a split or resume) it is ignored, so the next generation's
  // occurrence shows instead of a stale copy of the old rule.
  const outsideGeneration = (row: MaterializedOccurrenceSnapshot): boolean => {
    const spec = generationByNumber.get(row.generation);
    if (spec === undefined) return false;
    const date = occurrenceDate(row.period);
    return date < spec.rule.startsOn || (spec.rule.endsOn !== undefined && date > spec.rule.endsOn);
  };
  const ownRows = input.materialized.filter(
    (row) =>
      row.routineId === series.id &&
      generationByNumber.has(row.generation) &&
      !(isPristineOccurrence(row) && outsideGeneration(row)),
  );
  if (series.state !== 'archived') {
    for (const spec of series.generations) {
      const generated = generateRoutineOccurrences({
        routineId: series.id,
        generation: spec.generation,
        rule: spec.rule,
        windowStart: window.start,
        windowEnd: window.end,
      });
      if (!generated.ok) return generated;
      for (const occurrence of generated.value) {
        if (
          series.state === 'paused' &&
          series.pauseEffectiveOn !== undefined &&
          occurrenceDate(occurrence.period) >= series.pauseEffectiveOn
        )
          continue;
        // A period an earlier generation already materialized is never generated again, so a
        // split or resume can never count one date or week twice (materialized history wins).
        if (coveredByEarlierGeneration(ownRows, spec.generation, occurrence.period)) continue;
        const weekly = occurrence.period.kind === 'week';
        const date = occurrence.period.kind === 'date' ? occurrence.period.date : undefined;
        byKey.set(occurrence.logicalKey, {
          id: routineOccurrenceId(occurrence.logicalKey),
          routineId: series.id,
          generation: spec.generation,
          logicalKey: occurrence.logicalKey,
          period: occurrence.period,
          ...(date === undefined ? {} : { date }),
          moved: false,
          state: 'planned',
          materialized: false,
          timing: resolveTiming(
            spec.schedulingMode,
            date,
            undefined,
            input.planningTimeZone,
            weekly,
          ),
          ...(weekly && occurrence.period.kind === 'week'
            ? { targetCount: occurrence.period.targetCount, completedCount: 0 }
            : {}),
          overlapAcknowledged: false,
        });
      }
    }
  }
  for (const row of ownRows) {
    const spec = generationByNumber.get(row.generation);
    if (spec === undefined) continue;
    const weekly = row.period.kind === 'week';
    const logicalDate = row.period.kind === 'date' ? row.period.date : undefined;
    const date = row.override?.date ?? logicalDate;
    const inWindow =
      row.period.kind === 'week'
        ? row.period.start <= window.end && row.period.end >= window.start
        : date !== undefined && date >= window.start && date <= window.end;
    if (!inWindow) {
      byKey.delete(row.logicalKey);
      continue;
    }
    byKey.set(row.logicalKey, {
      id: row.id,
      routineId: row.routineId,
      generation: row.generation,
      logicalKey: row.logicalKey,
      period: row.period,
      ...(date === undefined ? {} : { date }),
      moved: row.override?.date !== undefined && row.override.date !== logicalDate,
      state: row.state,
      materialized: true,
      localRevision: row.localRevision,
      timing: resolveTiming(
        spec.schedulingMode,
        date,
        row.override,
        input.planningTimeZone,
        weekly,
      ),
      ...(row.targetCount === undefined ? {} : { targetCount: row.targetCount }),
      ...(row.completedCount === undefined ? {} : { completedCount: row.completedCount }),
      ...(row.extraCompletionsConfirmed === undefined
        ? {}
        : { extraCompletionsConfirmed: row.extraCompletionsConfirmed }),
      ...(row.override === undefined ? {} : { override: row.override }),
      overlapAcknowledged: row.override?.overlapAcknowledged === true,
    });
  }
  return ok(
    [...byKey.values()].sort(
      (left, right) =>
        (left.date ?? occurrenceDate(left.period)).localeCompare(
          right.date ?? occurrenceDate(right.period),
        ) ||
        timingStart(left).localeCompare(timingStart(right)) ||
        left.logicalKey.localeCompare(right.logicalKey),
    ),
  );
};

const coveredByEarlierGeneration = (
  rows: readonly MaterializedOccurrenceSnapshot[],
  generation: number,
  period: GeneratedOccurrencePeriod,
): boolean =>
  rows.some((row) => {
    if (row.generation >= generation) return false;
    if (period.kind === 'date')
      return row.period.kind === 'date'
        ? row.period.date === period.date
        : row.period.start <= period.date && row.period.end >= period.date;
    const start = occurrenceDate(row.period);
    const end = row.period.kind === 'date' ? row.period.date : row.period.end;
    return start <= period.end && end >= period.start;
  });

/**
 * A materialized occurrence that carries no user decision: still planned, never moved, retimed,
 * acknowledged, or counted. Such a row can be left behind by an early completion followed by
 * Reopen; it must never block a series edit or outlive its generation.
 */
export const isPristineOccurrence = (
  row: Pick<
    MaterializedOccurrenceSnapshot,
    'state' | 'override' | 'completedCount' | 'extraCompletionsConfirmed'
  >,
): boolean =>
  row.state === 'planned' &&
  (row.completedCount ?? 0) === 0 &&
  row.extraCompletionsConfirmed !== true &&
  (row.override === undefined ||
    (row.override.date === undefined &&
      row.override.wallTime === undefined &&
      row.override.durationMinutes === undefined &&
      row.override.overlapAcknowledged !== true));

/**
 * Materialized rows of one generation whose logical period starts on or after a date (a week
 * compares its first day) and that carry a user decision. A split or resume at that date would
 * otherwise leave them outside their generation while the next generation generates the same
 * periods again. Pristine rows are ignored: they hold nothing to preserve.
 */
export const materializedOnOrAfter = <
  Row extends Pick<
    MaterializedOccurrenceSnapshot,
    'generation' | 'period' | 'state' | 'override' | 'completedCount' | 'extraCompletionsConfirmed'
  >,
>(
  rows: readonly Row[],
  generation: number,
  effectiveOn: CalendarDate,
): readonly Row[] =>
  rows
    .filter(
      (row) =>
        row.generation === generation &&
        occurrenceDate(row.period) >= effectiveOn &&
        !isPristineOccurrence(row),
    )
    .sort((left, right) => occurrenceDate(left.period).localeCompare(occurrenceDate(right.period)));

const timingStart = (occurrence: ProjectedOccurrence): string =>
  occurrence.timing.kind === 'timed' ? occurrence.timing.startsAt : '';

export interface OccurrenceProgress {
  readonly state: RoutineOccurrenceState;
  readonly period: GeneratedOccurrencePeriod;
  readonly targetCount?: number;
  readonly completedCount?: number;
  readonly extraCompletionsConfirmed?: boolean;
}

/** Explicit completion. Weekly-count occurrences increment toward their target; extra counts need confirmation. */
export const completeOccurrenceProgress = (
  current: OccurrenceProgress,
  options: { readonly confirmExtra: boolean },
): DomainResult<OccurrenceProgress> => {
  if (current.period.kind === 'date') {
    return current.state === 'planned'
      ? ok({ state: 'completed', period: current.period })
      : transitionError('occurrence_not_planned');
  }
  if (current.state === 'skipped') return transitionError('occurrence_skipped');
  const target = current.period.targetCount;
  const next = (current.completedCount ?? 0) + 1;
  if (next > target && !options.confirmExtra)
    return transitionError('extra_completion_confirmation');
  return ok({
    state: next >= target ? 'completed' : 'planned',
    period: current.period,
    targetCount: target,
    completedCount: next,
    ...(next > target ? { extraCompletionsConfirmed: true } : {}),
  });
};

export const skipOccurrenceProgress = (
  current: OccurrenceProgress,
): DomainResult<OccurrenceProgress> => {
  if (current.state !== 'planned') return transitionError('occurrence_not_planned');
  return ok({
    ...current,
    state: 'skipped',
    ...(current.period.kind === 'week'
      ? { targetCount: current.period.targetCount, completedCount: current.completedCount ?? 0 }
      : {}),
  });
};

/** Explicit reopen/undo. A weekly-count completion is reopened one count at a time. */
export const reopenOccurrenceProgress = (
  current: OccurrenceProgress,
): DomainResult<OccurrenceProgress> => {
  if (
    current.state === 'planned' &&
    (current.period.kind === 'date' || (current.completedCount ?? 0) === 0)
  )
    return transitionError('occurrence_already_planned');
  if (current.period.kind === 'date') return ok({ state: 'planned', period: current.period });
  if (current.state === 'skipped') {
    return ok({
      state: 'planned',
      period: current.period,
      targetCount: current.period.targetCount,
      completedCount: current.completedCount ?? 0,
    });
  }
  const target = current.period.targetCount;
  const next = Math.max(0, (current.completedCount ?? 0) - 1);
  return ok({
    state: next >= target ? 'completed' : 'planned',
    period: current.period,
    targetCount: target,
    completedCount: next,
    ...(next > target ? { extraCompletionsConfirmed: true } : {}),
  });
};

const isWeekStart = (date: CalendarDate, rule: RecurrenceRuleV1): boolean =>
  rule.kind !== 'weekly_count' || weekdayOf(date) === rule.weekStart;

/** Pause stops future generation from an explicit date; completed history is untouched. */
export const planRoutinePause = (
  series: RoutineSeriesSnapshot,
  pauseOn: CalendarDate,
  today: CalendarDate,
): DomainResult<{ readonly pauseEffectiveOn: CalendarDate }> => {
  if (series.state !== 'active') return transitionError('routine_not_active');
  if (pauseOn < today) return routineError('pause_in_past');
  if (!isWeekStart(pauseOn, currentGeneration(series).rule))
    return routineError('week_start_required');
  return ok({ pauseEffectiveOn: pauseOn });
};

/**
 * Resume chooses a new effective date. When it is later than the pause date, the current generation
 * closes the day before the pause and a new generation starts on the resume date so missed dates
 * are never backfilled.
 */
export const planRoutineResume = (
  series: RoutineSeriesSnapshot,
  resumeOn: CalendarDate,
  today: CalendarDate,
): DomainResult<{ readonly generations: readonly RoutineGenerationSpec[] }> => {
  if (series.state !== 'paused' || series.pauseEffectiveOn === undefined)
    return transitionError('routine_not_paused');
  if (resumeOn < today) return routineError('resume_in_past');
  const current = currentGeneration(series);
  if (!isWeekStart(resumeOn, current.rule)) return routineError('week_start_required');
  const pauseOn = series.pauseEffectiveOn;
  if (resumeOn <= pauseOn) return ok({ generations: series.generations });
  const earlier = series.generations.slice(0, -1);
  if (current.rule.endsOn !== undefined && current.rule.endsOn < resumeOn) {
    return ok({ generations: series.generations });
  }
  if (pauseOn <= current.rule.startsOn) {
    const shifted = parseRecurrenceRuleV1({ ...current.rule, startsOn: resumeOn });
    if (!shifted.ok) return shifted;
    return ok({ generations: [...earlier, { ...current, rule: shifted.value }] });
  }
  const closed = parseRecurrenceRuleV1({ ...current.rule, endsOn: addDays(pauseOn, -1) });
  const next = parseRecurrenceRuleV1({ ...current.rule, startsOn: resumeOn });
  if (!closed.ok) return closed;
  if (!next.ok) return next;
  return ok({
    generations: [
      ...earlier,
      { ...current, rule: closed.value },
      {
        generation: current.generation + 1,
        rule: next.value,
        schedulingMode: current.schedulingMode,
      },
    ],
  });
};

/**
 * This-and-future: close the current generation before the selected date and start a new
 * generation there with the new rule/scheduling. Past occurrences keep their identity.
 */
export const planRoutineSplit = (
  series: RoutineSeriesSnapshot,
  selectedOn: CalendarDate,
  futureRule: unknown,
  futureMode: RoutineSchedulingMode,
  today: CalendarDate,
): DomainResult<{ readonly generations: readonly RoutineGenerationSpec[] }> => {
  if (series.state === 'archived') return transitionError('routine_archived');
  if (selectedOn < today)
    return routineError(
      'split_in_past',
      'The change date cannot be in the past. Choose today or a later date.',
    );
  const current = currentGeneration(series);
  if (selectedOn <= current.rule.startsOn) return routineError('split_before_generation');
  if (current.rule.endsOn !== undefined && selectedOn > current.rule.endsOn)
    return routineError('split_after_generation');
  if (!isRecord(futureRule)) return routineError('future_rule');
  const next = parseRecurrenceRuleV1({ ...futureRule, startsOn: selectedOn });
  if (!next.ok) return next;
  if (!isWeekStart(selectedOn, current.rule) || !isWeekStart(selectedOn, next.value))
    return routineError('week_start_required');
  if (next.value.kind === 'weekly_count' && futureMode.kind !== 'day_flexible')
    return routineError('weekly_count_is_day_flexible');
  const closed = parseRecurrenceRuleV1({ ...current.rule, endsOn: addDays(selectedOn, -1) });
  if (!closed.ok) return closed;
  return ok({
    generations: [
      ...series.generations.slice(0, -1),
      { ...current, rule: closed.value },
      { generation: current.generation + 1, rule: next.value, schedulingMode: futureMode },
    ],
  });
};

/** An occurrence time resolved in the zone its Routine uses, with any clock-change handling. */
export type OccurrenceTimeResolution =
  | { readonly kind: 'flexible' }
  | { readonly kind: 'dst_skipped'; readonly wallTime: WallTime; readonly timeZone: IanaTimeZone }
  | {
      readonly kind: 'timed';
      readonly startsAt: Instant;
      readonly endsAt: Instant;
      readonly timeZone: IanaTimeZone;
      readonly wallTime: WallTime;
      readonly durationMinutes: number;
      /** Local start/end in `timeZone`. */
      readonly localStart: WallTime;
      readonly localEnd: WallTime;
      readonly localEndDate: CalendarDate;
      readonly utcOffset: string;
      readonly adjustment?: 'dst_gap_shifted' | 'dst_repeated_earlier' | 'dst_repeated_later';
    };

/** The zone an occurrence time is read in: a fixed Routine zone, otherwise the planning zone. */
export const occurrenceTimeZone = (
  mode: RoutineSchedulingMode,
  planningTimeZone: IanaTimeZone,
): IanaTimeZone =>
  mode.kind === 'time_specific' && mode.zonePolicy.kind === 'fixed_zone'
    ? mode.zonePolicy.timeZone
    : planningTimeZone;

const detailTiming = (date: CalendarDate, timing: OccurrenceTiming): OccurrenceTimeResolution => {
  if (timing.kind !== 'timed')
    return timing.kind === 'dst_skipped'
      ? { kind: 'dst_skipped', wallTime: timing.wallTime, timeZone: timing.timeZone }
      : { kind: 'flexible' };
  const start = Temporal.Instant.from(timing.startsAt).toZonedDateTimeISO(timing.timeZone);
  const end = Temporal.Instant.from(timing.endsAt).toZonedDateTimeISO(timing.timeZone);
  const requested = Temporal.PlainDate.from(date).toPlainDateTime(
    Temporal.PlainTime.from(timing.wallTime),
  );
  let adjustment: 'dst_gap_shifted' | 'dst_repeated_earlier' | 'dst_repeated_later' | undefined;
  if (!start.toPlainDateTime().equals(requested)) adjustment = 'dst_gap_shifted';
  else {
    const earlier = requested.toZonedDateTime(timing.timeZone, { disambiguation: 'earlier' });
    const later = requested.toZonedDateTime(timing.timeZone, { disambiguation: 'later' });
    if (!earlier.equals(later))
      adjustment = start.equals(earlier) ? 'dst_repeated_earlier' : 'dst_repeated_later';
  }
  return {
    ...timing,
    localStart: start.toPlainTime().toString({ smallestUnit: 'minute' }) as WallTime,
    localEnd: end.toPlainTime().toString({ smallestUnit: 'minute' }) as WallTime,
    localEndDate: end.toPlainDate().toString() as CalendarDate,
    utcOffset: start.offset,
    ...(adjustment === undefined ? {} : { adjustment }),
  };
};

export interface OccurrenceEditInput {
  readonly mode: RoutineSchedulingMode;
  /** The occurrence's own (generated) date. */
  readonly logicalDate: CalendarDate;
  /** The requested date for this occurrence. */
  readonly date: CalendarDate;
  /** Requested start in the Routine's zone; omitted keeps the current one. */
  readonly wallTime?: WallTime;
  readonly durationMinutes?: number;
  /** The occurrence's current override, when it is already materialized. */
  readonly existing?: OccurrenceOverrideV1;
  readonly planningTimeZone: IanaTimeZone;
}

/**
 * This-occurrence edit plan shared by the save command and its live preview. A time-specific
 * occurrence is read in its Routine's zone with its gap/overlap policies; a start or duration that
 * is not sent keeps the occurrence's current value, and a value equal to the Routine's own is not
 * stored. A day-flexible occurrence takes a start and a duration together, in the planning zone,
 * or neither.
 */
export const planOccurrenceEdit = (
  input: OccurrenceEditInput,
): DomainResult<{
  readonly override: Omit<OccurrenceOverrideV1, 'overlapAcknowledged'>;
  readonly timeZone: IanaTimeZone;
  readonly time: OccurrenceTimeResolution;
}> => {
  const { mode } = input;
  const duration = input.durationMinutes;
  if (
    duration !== undefined &&
    (!Number.isInteger(duration) || duration < 1 || duration > routineLimits.durationMinutes)
  )
    return routineError('duration_minutes', 'Enter a duration from 1 minute to 24 hours.');
  const override: { date?: CalendarDate; wallTime?: WallTime; durationMinutes?: number } = {};
  if (input.date !== input.logicalDate) override.date = input.date;
  if (mode.kind === 'day_flexible') {
    if ((input.wallTime === undefined) !== (duration === undefined))
      return routineError(
        'time_requires_duration',
        'A time for this occurrence needs both a start and a duration.',
      );
    if (input.wallTime !== undefined && duration !== undefined) {
      override.wallTime = input.wallTime;
      override.durationMinutes = duration;
    }
  } else {
    const wallTime = input.wallTime ?? input.existing?.wallTime;
    const minutes = duration ?? input.existing?.durationMinutes;
    if (wallTime !== undefined && wallTime !== mode.wallTime) override.wallTime = wallTime;
    if (minutes !== undefined && minutes !== mode.durationMinutes)
      override.durationMinutes = minutes;
  }
  const checked = parseOccurrenceOverride(override);
  if (!checked.ok) return checked;
  return ok({
    override: checked.value,
    timeZone: occurrenceTimeZone(mode, input.planningTimeZone),
    time: detailTiming(
      input.date,
      resolveTiming(mode, input.date, checked.value, input.planningTimeZone, false),
    ),
  });
};
