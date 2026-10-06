import { describe, expect, it } from 'vitest';

import {
  completeOccurrenceProgress,
  deriveNameBasedUuid,
  occurrenceLogicalKey,
  parseOccurrenceOverride,
  parseRoutineDefinition,
  parseUUID,
  isPristineOccurrence,
  materializedOnOrAfter,
  planOccurrenceEdit,
  planRoutinePause,
  planRoutineResume,
  planRoutineSplit,
  projectRoutineOccurrences,
  reopenOccurrenceProgress,
  routineOccurrenceId,
  skipOccurrenceProgress,
  type CalendarDate,
  type DomainResult,
  type IanaTimeZone,
  type MaterializedOccurrenceSnapshot,
  type RecurrenceRuleV1,
  type RoutineSchedulingMode,
  type RoutineSeriesSnapshot,
  type UUID,
  type WallTime,
} from './index.js';

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.details)}`);
  return result.value;
};
const reason = (result: DomainResult<unknown>): unknown =>
  result.ok ? 'ok' : result.error.details?.['reason'];
const date = (value: string) => value as CalendarDate;
const routineId = expectValue(parseUUID('0190c2b1-7d9a-7cc1-8be5-b88620c57f5a'));
const newYork = 'America/New_York' as IanaTimeZone;
const flexible: RoutineSchedulingMode = { kind: 'day_flexible' };

describe('Routine definition runtime fields', () => {
  it.each([
    null,
    [],
    { title: 42 },
    { title: 'Synthetic', description: [] },
    { title: 'Synthetic', ownerId: 'unexpected' },
  ])('rejects malformed field types without throwing (%#)', (input) => {
    expect(
      parseRoutineDefinition(input as unknown as Parameters<typeof parseRoutineDefinition>[0]),
    ).toMatchObject({ ok: false });
  });
});
const daily = (startsOn: string, extra: Partial<RecurrenceRuleV1> = {}): RecurrenceRuleV1 =>
  ({ version: 1, kind: 'daily', intervalDays: 1, startsOn, ...extra }) as RecurrenceRuleV1;
const timed = (
  wallTime: string,
  extra: Partial<RoutineSchedulingMode> = {},
): RoutineSchedulingMode => ({
  kind: 'time_specific',
  wallTime: wallTime as WallTime,
  durationMinutes: 30,
  zonePolicy: { kind: 'follow_profile' },
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
  ...extra,
});
const series = (
  generations: RoutineSeriesSnapshot['generations'],
  extra: Partial<RoutineSeriesSnapshot> = {},
): RoutineSeriesSnapshot => ({ id: routineId, state: 'active', generations, ...extra });
const project = (
  value: RoutineSeriesSnapshot,
  start: string,
  end: string,
  materialized: MaterializedOccurrenceSnapshot[] = [],
  zone: IanaTimeZone = newYork,
) =>
  expectValue(
    projectRoutineOccurrences({
      series: value,
      materialized,
      window: { start: date(start), end: date(end) },
      planningTimeZone: zone,
    }),
  );

describe('derived identifiers', () => {
  it('implements RFC name-based UUID v5', () => {
    expect(
      deriveNameBasedUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8' as UUID, 'www.example.com'),
    ).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('derives one stable occurrence id per logical key', () => {
    const key = occurrenceLogicalKey(routineId, 1, { kind: 'date', date: date('2026-08-10') });
    expect(routineOccurrenceId(key)).toBe(routineOccurrenceId(key));
    expect(routineOccurrenceId(key)).not.toBe(
      routineOccurrenceId(
        occurrenceLogicalKey(routineId, 2, { kind: 'date', date: date('2026-08-10') }),
      ),
    );
    expect(parseUUID(routineOccurrenceId(key)).ok).toBe(true);
  });
});

describe('routine definition validation', () => {
  it('accepts day-flexible and time-specific definitions with explicit zone and DST policies', () => {
    expect(
      expectValue(
        parseRoutineDefinition({
          title: '  Stretch ',
          rule: daily('2026-08-10'),
          schedulingMode: timed('07:15', {
            zonePolicy: { kind: 'fixed_zone', timeZone: 'Asia/Tashkent' as IanaTimeZone },
          }),
        }),
      ),
    ).toMatchObject({
      title: 'Stretch',
      schedulingMode: { kind: 'time_specific', wallTime: '07:15' },
    });
  });

  it('rejects invalid titles, zone policies, durations, and timed weekly counts', () => {
    expect(
      reason(
        parseRoutineDefinition({ title: ' ', rule: daily('2026-08-10'), schedulingMode: flexible }),
      ),
    ).toBe('title');
    expect(
      reason(
        parseRoutineDefinition({
          title: 'Run',
          rule: daily('2026-08-10'),
          schedulingMode: {
            ...timed('07:00'),
            zonePolicy: { kind: 'fixed_zone', timeZone: '+05:00' },
          },
        }),
      ),
    ).toBe('zone_policy');
    expect(
      reason(
        parseRoutineDefinition({
          title: 'Run',
          rule: daily('2026-08-10'),
          schedulingMode: { ...timed('07:00'), durationMinutes: 0 },
        }),
      ),
    ).toBe('duration_minutes');
    expect(
      reason(
        parseRoutineDefinition({
          title: 'Run',
          rule: {
            version: 1,
            kind: 'weekly_count',
            targetCount: 3,
            weekStart: 'monday',
            startsOn: '2026-08-10',
          },
          schedulingMode: timed('07:00'),
        }),
      ),
    ).toBe('weekly_count_is_day_flexible');
  });
});

describe('lazy occurrence projection', () => {
  it('generates bounded dated occurrences with deterministic ids and idempotent re-projection', () => {
    const value = series([{ generation: 1, rule: daily('2026-08-10'), schedulingMode: flexible }]);
    const first = project(value, '2026-08-10', '2026-08-12');
    const second = project(value, '2026-08-10', '2026-08-12');
    expect(first.map((item) => item.date)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
    expect(first).toEqual(second);
    expect(first.every((item) => !item.materialized && item.timing.kind === 'flexible')).toBe(true);
  });

  it('merges materialized state, keeps a moved occurrence key, and shows it on its new date', () => {
    const value = series([{ generation: 1, rule: daily('2026-08-10'), schedulingMode: flexible }]);
    const movedKey = occurrenceLogicalKey(routineId, 1, { kind: 'date', date: date('2026-08-11') });
    const doneKey = occurrenceLogicalKey(routineId, 1, { kind: 'date', date: date('2026-08-10') });
    const projected = project(value, '2026-08-10', '2026-08-13', [
      {
        id: routineOccurrenceId(doneKey),
        routineId,
        generation: 1,
        logicalKey: doneKey,
        period: { kind: 'date', date: date('2026-08-10') },
        state: 'completed',
        localRevision: 2,
      },
      {
        id: routineOccurrenceId(movedKey),
        routineId,
        generation: 1,
        logicalKey: movedKey,
        period: { kind: 'date', date: date('2026-08-11') },
        state: 'planned',
        localRevision: 1,
        override: { date: date('2026-08-13') },
      },
    ]);
    expect(projected.map((item) => [item.date, item.state, item.moved])).toEqual([
      ['2026-08-10', 'completed', false],
      ['2026-08-12', 'planned', false],
      ['2026-08-13', 'planned', true],
      ['2026-08-13', 'planned', false],
    ]);
    expect(projected.find((item) => item.moved)?.logicalKey).toBe(movedKey);
  });

  it('stops generation at the pause date while keeping materialized history', () => {
    const doneKey = occurrenceLogicalKey(routineId, 1, { kind: 'date', date: date('2026-08-12') });
    const paused = series(
      [{ generation: 1, rule: daily('2026-08-10'), schedulingMode: flexible }],
      {
        state: 'paused',
        pauseEffectiveOn: date('2026-08-12'),
      },
    );
    const projected = project(paused, '2026-08-10', '2026-08-14', [
      {
        id: routineOccurrenceId(doneKey),
        routineId,
        generation: 1,
        logicalKey: doneKey,
        period: { kind: 'date', date: date('2026-08-12') },
        state: 'completed',
        localRevision: 2,
      },
    ]);
    expect(projected.map((item) => [item.date, item.state])).toEqual([
      ['2026-08-10', 'planned'],
      ['2026-08-11', 'planned'],
      ['2026-08-12', 'completed'],
    ]);
  });

  it('represents weekly-count work as one counter per week, never seven items', () => {
    const value = series([
      {
        generation: 1,
        rule: {
          version: 1,
          kind: 'weekly_count',
          targetCount: 3,
          weekStart: 'monday',
          startsOn: date('2026-08-10'),
        },
        schedulingMode: flexible,
      },
    ]);
    const projected = project(value, '2026-08-10', '2026-08-23');
    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      timing: { kind: 'weekly_count' },
      targetCount: 3,
      completedCount: 0,
      period: { kind: 'week', start: '2026-08-10', end: '2026-08-16' },
    });
  });

  it('resolves time-specific occurrences across DST with explicit policies and no loss', () => {
    const shift = series([
      { generation: 1, rule: daily('2026-03-07'), schedulingMode: timed('02:30') },
    ]);
    const shifted = project(shift, '2026-03-07', '2026-03-09');
    expect(shifted.map((item) => item.timing)).toEqual([
      expect.objectContaining({ kind: 'timed', startsAt: '2026-03-07T07:30:00.000Z' }),
      expect.objectContaining({ kind: 'timed', startsAt: '2026-03-08T07:30:00.000Z' }),
      expect.objectContaining({ kind: 'timed', startsAt: '2026-03-09T06:30:00.000Z' }),
    ]);
    const skip = series([
      {
        generation: 1,
        rule: daily('2026-03-08'),
        schedulingMode: timed('02:30', { gapPolicy: 'skip' }),
      },
    ]);
    expect(project(skip, '2026-03-08', '2026-03-08')[0]?.timing.kind).toBe('dst_skipped');
    const repeated = series([
      {
        generation: 1,
        rule: daily('2026-11-01'),
        schedulingMode: timed('01:30', { overlapPolicy: 'later_offset' }),
      },
    ]);
    const occurrence = project(repeated, '2026-11-01', '2026-11-01')[0];
    expect(occurrence?.timing).toMatchObject({
      kind: 'timed',
      startsAt: '2026-11-01T06:30:00.000Z',
    });
    expect(project(repeated, '2026-11-01', '2026-11-01')[0]?.id).toBe(occurrence?.id);
  });

  it('keeps fixed-zone wall time in the anchor zone and follows the profile zone otherwise', () => {
    const follow = series([
      { generation: 1, rule: daily('2026-08-10'), schedulingMode: timed('07:00') },
    ]);
    const fixed = series([
      {
        generation: 1,
        rule: daily('2026-08-10'),
        schedulingMode: timed('07:00', {
          zonePolicy: { kind: 'fixed_zone', timeZone: 'Asia/Tashkent' as IanaTimeZone },
        }),
      },
    ]);
    const tashkent = 'Asia/Tashkent' as IanaTimeZone;
    expect(project(follow, '2026-08-10', '2026-08-10', [], tashkent)[0]?.timing).toMatchObject({
      startsAt: '2026-08-10T02:00:00.000Z',
    });
    expect(project(follow, '2026-08-10', '2026-08-10', [], newYork)[0]?.timing).toMatchObject({
      startsAt: '2026-08-10T11:00:00.000Z',
    });
    expect(project(fixed, '2026-08-10', '2026-08-10', [], newYork)[0]?.timing).toMatchObject({
      startsAt: '2026-08-10T02:00:00.000Z',
      timeZone: 'Asia/Tashkent',
    });
  });
});

describe('occurrence progress', () => {
  const dated = {
    state: 'planned' as const,
    period: { kind: 'date' as const, date: date('2026-08-10') },
  };
  const weekly = {
    state: 'planned' as const,
    period: {
      kind: 'week' as const,
      start: date('2026-08-10'),
      end: date('2026-08-16'),
      weekStart: 'monday' as const,
      targetCount: 2,
    },
    targetCount: 2,
    completedCount: 0,
  };

  it('completes, skips, and reopens dated occurrences explicitly', () => {
    expect(expectValue(completeOccurrenceProgress(dated, { confirmExtra: false })).state).toBe(
      'completed',
    );
    expect(expectValue(skipOccurrenceProgress(dated)).state).toBe('skipped');
    expect(reason(reopenOccurrenceProgress(dated))).toBe('occurrence_already_planned');
    expect(expectValue(reopenOccurrenceProgress({ ...dated, state: 'completed' })).state).toBe(
      'planned',
    );
  });

  it('counts weekly completions and requires confirmation for extra completions', () => {
    const one = expectValue(completeOccurrenceProgress(weekly, { confirmExtra: false }));
    expect(one).toMatchObject({ state: 'planned', completedCount: 1 });
    const two = expectValue(completeOccurrenceProgress(one, { confirmExtra: false }));
    expect(two).toMatchObject({ state: 'completed', completedCount: 2 });
    expect(reason(completeOccurrenceProgress(two, { confirmExtra: false }))).toBe(
      'extra_completion_confirmation',
    );
    const three = expectValue(completeOccurrenceProgress(two, { confirmExtra: true }));
    expect(three).toMatchObject({
      state: 'completed',
      completedCount: 3,
      extraCompletionsConfirmed: true,
    });
    const back = expectValue(reopenOccurrenceProgress(three));
    expect(back).toMatchObject({ state: 'completed', completedCount: 2 });
    expect(back.extraCompletionsConfirmed).toBeUndefined();
    expect(expectValue(reopenOccurrenceProgress(back))).toMatchObject({
      state: 'planned',
      completedCount: 1,
    });
  });
});

describe('series lifecycle', () => {
  const base = series([{ generation: 1, rule: daily('2026-08-01'), schedulingMode: flexible }]);

  it('pauses from an explicit non-past date', () => {
    expect(expectValue(planRoutinePause(base, date('2026-08-12'), date('2026-08-10')))).toEqual({
      pauseEffectiveOn: '2026-08-12',
    });
    expect(reason(planRoutinePause(base, date('2026-08-09'), date('2026-08-10')))).toBe(
      'pause_in_past',
    );
  });

  it('resumes without backfilling missed dates by starting a new generation', () => {
    const paused = { ...base, state: 'paused' as const, pauseEffectiveOn: date('2026-08-12') };
    const resumed = expectValue(planRoutineResume(paused, date('2026-08-20'), date('2026-08-15')));
    expect(
      resumed.generations.map((item) => [item.generation, item.rule.startsOn, item.rule.endsOn]),
    ).toEqual([
      [1, '2026-08-01', '2026-08-11'],
      [2, '2026-08-20', undefined],
    ]);
    const projected = project(series(resumed.generations), '2026-08-10', '2026-08-21').map(
      (item) => item.date,
    );
    expect(projected).toEqual(['2026-08-10', '2026-08-11', '2026-08-20', '2026-08-21']);
  });

  it('splits This and future at the selected date and preserves prior identity', () => {
    const split = expectValue(
      planRoutineSplit(
        base,
        date('2026-08-12'),
        { version: 1, kind: 'daily', intervalDays: 2 },
        flexible,
        date('2026-08-10'),
      ),
    );
    expect(
      split.generations.map((item) => [item.generation, item.rule.startsOn, item.rule.endsOn]),
    ).toEqual([
      [1, '2026-08-01', '2026-08-11'],
      [2, '2026-08-12', undefined],
    ]);
    const before = project(base, '2026-08-10', '2026-08-11');
    const after = project(series(split.generations), '2026-08-10', '2026-08-16');
    expect(after.slice(0, 2).map((item) => item.id)).toEqual(before.map((item) => item.id));
    expect(after.map((item) => item.date)).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-14',
      '2026-08-16',
    ]);
    expect(
      reason(
        planRoutineSplit(
          base,
          date('2026-08-01'),
          { version: 1, kind: 'daily', intervalDays: 1 },
          flexible,
          date('2026-07-01'),
        ),
      ),
    ).toBe('split_before_generation');
  });

  it('keeps weekly-count edits on week boundaries so a week is never counted twice', () => {
    const weekly = series([
      {
        generation: 1,
        rule: {
          version: 1,
          kind: 'weekly_count',
          targetCount: 3,
          weekStart: 'monday',
          startsOn: date('2026-08-03'),
        },
        schedulingMode: flexible,
      },
    ]);
    expect(reason(planRoutinePause(weekly, date('2026-08-12'), date('2026-08-10')))).toBe(
      'week_start_required',
    );
    expect(
      reason(
        planRoutineSplit(
          weekly,
          date('2026-08-12'),
          { version: 1, kind: 'weekly_count', targetCount: 2, weekStart: 'monday' },
          flexible,
          date('2026-08-10'),
        ),
      ),
    ).toBe('week_start_required');
  });

  it('validates override payloads strictly', () => {
    expect(expectValue(parseOccurrenceOverride({ date: '2026-08-12', wallTime: '08:00' }))).toEqual(
      {
        date: '2026-08-12',
        wallTime: '08:00',
      },
    );
    expect(parseOccurrenceOverride({ date: '2026-02-30' }).ok).toBe(false);
    expect(parseOccurrenceOverride({ overlapAcknowledged: false }).ok).toBe(false);
    expect(parseOccurrenceOverride({ note: 'x' }).ok).toBe(false);
  });
});

describe('This-and-future splits never count a period twice', () => {
  const weeklyRule = (startsOn: string, targetCount: number): RecurrenceRuleV1 =>
    ({
      version: 1,
      kind: 'weekly_count',
      targetCount,
      weekStart: 'monday',
      startsOn,
    }) as RecurrenceRuleV1;
  const weekPeriod = (start: string, end: string, targetCount: number) =>
    ({
      kind: 'week',
      start: date(start),
      end: date(end),
      weekStart: 'monday',
      targetCount,
    }) as const;
  const row = (
    generation: number,
    period: MaterializedOccurrenceSnapshot['period'],
    extra: Partial<MaterializedOccurrenceSnapshot> = {},
  ): MaterializedOccurrenceSnapshot => {
    const logicalKey = occurrenceLogicalKey(routineId, generation, period);
    return {
      id: routineOccurrenceId(logicalKey),
      routineId,
      generation,
      logicalKey,
      period,
      state: 'completed',
      localRevision: 1,
      ...extra,
    };
  };

  it('rejects a split date in the past like pause and resume', () => {
    const base = series([{ generation: 1, rule: daily('2026-08-01'), schedulingMode: flexible }]);
    expect(
      reason(
        planRoutineSplit(
          base,
          date('2026-08-09'),
          { version: 1, kind: 'daily', intervalDays: 1 },
          flexible,
          date('2026-08-10'),
        ),
      ),
    ).toBe('split_in_past');
    expect(
      planRoutineSplit(
        base,
        date('2026-08-10'),
        { version: 1, kind: 'daily', intervalDays: 1 },
        flexible,
        date('2026-08-10'),
      ).ok,
    ).toBe(true);
  });

  it('finds current-generation rows at or after the effective date by logical period', () => {
    const rows = [
      row(1, weekPeriod('2026-09-14', '2026-09-20', 3)),
      row(1, weekPeriod('2026-09-21', '2026-09-27', 3), { state: 'planned', completedCount: 1 }),
      row(2, weekPeriod('2026-09-28', '2026-10-04', 3)),
      row(
        1,
        { kind: 'date', date: date('2026-09-10') },
        { override: { date: date('2026-09-30') } },
      ),
      row(
        1,
        { kind: 'date', date: date('2026-10-02') },
        { override: { date: date('2026-09-01') } },
      ),
    ];
    expect(
      materializedOnOrAfter(rows, 1, date('2026-09-21')).map((item) =>
        item.period.kind === 'week' ? item.period.start : item.period.date,
      ),
    ).toEqual(['2026-09-21', '2026-10-02']);
    expect(materializedOnOrAfter(rows, 1, date('2026-10-05'))).toEqual([]);
  });

  it('keeps one weekly counter when a later generation covers a week that already has progress', () => {
    // Week 2026-09-21..27 has one completion in generation 1; a split was recorded at 09-21.
    const progress = row(1, weekPeriod('2026-09-21', '2026-09-27', 3), {
      state: 'planned',
      targetCount: 3,
      completedCount: 1,
    });
    const split = series([
      {
        generation: 1,
        rule: { ...weeklyRule('2026-09-07', 3), endsOn: date('2026-09-20') },
        schedulingMode: flexible,
      },
      { generation: 2, rule: weeklyRule('2026-09-21', 5), schedulingMode: flexible },
    ]);
    const projected = project(split, '2026-09-21', '2026-10-04', [progress]);
    expect(
      projected.map((item) => [
        item.generation,
        item.period.kind === 'week' ? item.period.start : '',
        item.completedCount,
        item.materialized,
      ]),
    ).toEqual([
      [1, '2026-09-21', 1, true],
      [2, '2026-09-28', 0, false],
    ]);
  });

  it('keeps one occurrence when a later generation generates a date already completed early', () => {
    const completed = row(1, { kind: 'date', date: date('2026-10-03') });
    const moved = row(
      1,
      { kind: 'date', date: date('2026-10-04') },
      { state: 'planned', override: { date: date('2026-10-20') } },
    );
    const split = series([
      {
        generation: 1,
        rule: daily('2026-09-01', { endsOn: date('2026-10-01') }),
        schedulingMode: flexible,
      },
      { generation: 2, rule: daily('2026-10-02'), schedulingMode: timed('07:00') },
    ]);
    const projected = project(split, '2026-10-02', '2026-10-05', [completed, moved]);
    expect(projected.map((item) => [item.date, item.generation, item.state])).toEqual([
      ['2026-10-02', 2, 'planned'],
      ['2026-10-03', 1, 'completed'],
      ['2026-10-05', 2, 'planned'],
    ]);
    // Materialized history is never hidden, even outside its generation's closed rule.
    expect(project(split, '2026-10-20', '2026-10-20', [completed, moved])).toEqual([
      expect.objectContaining({ generation: 1, date: '2026-10-20', materialized: true }),
      expect.objectContaining({ generation: 2, date: '2026-10-20', materialized: false }),
    ]);
  });

  it('lets a reopened, unchanged occurrence give way to the next generation', () => {
    const reopened = row(1, { kind: 'date', date: date('2026-10-03') }, { state: 'planned' });
    expect(isPristineOccurrence(reopened)).toBe(true);
    const split = series([
      {
        generation: 1,
        rule: daily('2026-09-01', { endsOn: date('2026-10-01') }),
        schedulingMode: flexible,
      },
      { generation: 2, rule: daily('2026-10-02'), schedulingMode: timed('07:00') },
    ]);
    expect(
      project(split, '2026-10-03', '2026-10-03', [reopened]).map((item) => [
        item.date,
        item.generation,
        item.materialized,
      ]),
    ).toEqual([['2026-10-03', 2, false]]);
    expect(materializedOnOrAfter([reopened], 1, date('2026-10-02'))).toEqual([]);
    const acknowledged = { ...reopened, override: { overlapAcknowledged: true as const } };
    expect(isPristineOccurrence(acknowledged)).toBe(false);
    expect(materializedOnOrAfter([acknowledged], 1, date('2026-10-02'))).toHaveLength(1);
  });
});

describe('This-occurrence edits resolve in the Routine zone', () => {
  const london = 'Europe/London' as IanaTimeZone;
  const losAngeles = 'America/Los_Angeles' as IanaTimeZone;
  const fixed = timed('09:00', { zonePolicy: { kind: 'fixed_zone', timeZone: london } });

  it('keeps the fixed-zone time when only the duration changes', () => {
    const plan = expectValue(
      planOccurrenceEdit({
        mode: fixed,
        logicalDate: date('2026-10-05'),
        date: date('2026-10-05'),
        durationMinutes: 45,
        planningTimeZone: losAngeles,
      }),
    );
    expect(plan.override).toEqual({ durationMinutes: 45 });
    expect(plan.time).toMatchObject({
      kind: 'timed',
      timeZone: london,
      wallTime: '09:00',
      startsAt: '2026-10-05T08:00:00.000Z',
      endsAt: '2026-10-05T08:45:00.000Z',
      localStart: '09:00',
      localEnd: '09:45',
      localEndDate: '2026-10-05',
      utcOffset: '+01:00',
    });
  });

  it('keeps an existing time override when the start time is not sent', () => {
    const plan = expectValue(
      planOccurrenceEdit({
        mode: fixed,
        logicalDate: date('2026-10-05'),
        date: date('2026-10-06'),
        existing: { wallTime: '10:30' as WallTime, durationMinutes: 20 },
        planningTimeZone: losAngeles,
      }),
    );
    expect(plan.override).toEqual({
      date: '2026-10-06',
      wallTime: '10:30',
      durationMinutes: 20,
    });
    // Sending the Routine's own time and duration returns to the usual schedule.
    expect(
      expectValue(
        planOccurrenceEdit({
          mode: fixed,
          logicalDate: date('2026-10-05'),
          date: date('2026-10-05'),
          wallTime: '09:00' as WallTime,
          durationMinutes: 30,
          existing: { wallTime: '10:30' as WallTime, durationMinutes: 20 },
          planningTimeZone: losAngeles,
        }),
      ).override,
    ).toEqual({});
  });

  it('reports clock-change handling with the Routine policies', () => {
    const later = expectValue(
      planOccurrenceEdit({
        mode: timed('01:30', { overlapPolicy: 'later_offset' }),
        logicalDate: date('2026-11-01'),
        date: date('2026-11-01'),
        planningTimeZone: newYork,
      }),
    );
    expect(later.time).toMatchObject({
      kind: 'timed',
      startsAt: '2026-11-01T06:30:00.000Z',
      adjustment: 'dst_repeated_later',
    });
    const shifted = expectValue(
      planOccurrenceEdit({
        mode: timed('02:30'),
        logicalDate: date('2027-03-14'),
        date: date('2027-03-14'),
        planningTimeZone: newYork,
      }),
    );
    expect(shifted.time).toMatchObject({ localStart: '03:30', adjustment: 'dst_gap_shifted' });
    const skipped = expectValue(
      planOccurrenceEdit({
        mode: timed('02:30', { gapPolicy: 'skip' }),
        logicalDate: date('2027-03-14'),
        date: date('2027-03-14'),
        planningTimeZone: newYork,
      }),
    );
    expect(skipped.time).toEqual({ kind: 'dst_skipped', wallTime: '02:30', timeZone: newYork });
  });

  it('needs a start and a duration together for a day-flexible occurrence', () => {
    const request = {
      mode: flexible,
      logicalDate: date('2026-10-05'),
      date: date('2026-10-05'),
      planningTimeZone: losAngeles,
    };
    expect(reason(planOccurrenceEdit({ ...request, wallTime: '10:00' as WallTime }))).toBe(
      'time_requires_duration',
    );
    expect(expectValue(planOccurrenceEdit(request))).toMatchObject({
      override: {},
      timeZone: losAngeles,
      time: { kind: 'flexible' },
    });
    expect(
      expectValue(
        planOccurrenceEdit({ ...request, wallTime: '10:00' as WallTime, durationMinutes: 20 }),
      ),
    ).toMatchObject({
      override: { wallTime: '10:00', durationMinutes: 20 },
      time: { kind: 'timed', startsAt: '2026-10-05T17:00:00.000Z', localStart: '10:00' },
    });
  });
});
