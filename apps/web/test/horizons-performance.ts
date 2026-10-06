import {
  createPlanningApplication,
  type ApplicationDependencies,
  type PlanningApplication,
} from '@yelaxis/application';
import {
  createSqliteApplicationAdapters,
  runMigrations,
  schemaMigrations,
  SqlitePlanningQueries,
} from '@yelaxis/data';
import { BrowserSqliteDriver } from '@yelaxis/data/browser';
import type { Instant, OwnerId, UUID } from '@yelaxis/domain';

/*
 * planning large-plan gate: 10,000 Actions across three years of Day placements, multi-year Time Block
 * history, weekly Commitments, availability, and Routines. Synthetic fixtures only.
 */
const ownerId = '81000000-0000-4000-8000-000000000001' as OwnerId;
const profileId = '82000000-0000-4000-8000-000000000001';
const now = '2026-08-12T15:00:00.000Z' as Instant;
const zone = 'America/New_York';
const actionCount = 10_000;
const thresholds = Object.freeze({
  weekWorstMs: 500,
  historicalWeekWorstMs: 500,
  dayWorstMs: 300,
  monthWorstMs: 800,
  yearWorstMs: 800,
  scheduleMs: 1_500,
  moveMs: 1_500,
  undoMs: 1_500,
  templateApplyMs: 2_000,
  reopenWeekMs: 2_500,
});

const outputNode = document.querySelector('#result');
if (!(outputNode instanceof HTMLElement)) throw new Error('Missing result element.');
const output: HTMLElement = outputNode;

void verify().then(
  (result) => report('passed', result),
  (error: unknown) =>
    report('failed', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
);

async function verify() {
  const databaseName = new URLSearchParams(window.location.search).get('database');
  if (databaseName === null) throw new Error('database query parameter required');
  const opened = await BrowserSqliteDriver.open({ databaseName });
  let driver = opened.driver;
  let idCounter = 1;
  const ids = {
    next() {
      const suffix = idCounter.toString(16).padStart(12, '0');
      idCounter += 1;
      return `b0000000-0000-4000-8000-${suffix}` as UUID;
    },
  };
  const applicationFor = (): PlanningApplication => {
    const dependencies: ApplicationDependencies = {
      ...createSqliteApplicationAdapters(driver),
      ids,
      clock: { now: () => now },
      projections: { notifyCommitted() {} },
    };
    return createPlanningApplication(dependencies, new SqlitePlanningQueries(driver));
  };

  try {
    await runMigrations(driver, schemaMigrations, () => now);
    await driver.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
       VALUES (?, 'local', ?, ?);`,
      [ownerId, now, now],
    );
    await driver.run(
      `INSERT INTO profiles (
         id, owner_id, planning_time_zone, week_start, time_format, locale_override,
         onboarding_status, onboarding_step, created_at, updated_at
       ) VALUES (?, ?, ?, 'monday', '24_hour', 'en', 'completed', 'handbook', ?, ?);`,
      [profileId, ownerId, zone, now, now],
    );
    const seedStarted = performance.now();
    for (const statement of seedStatements()) await driver.executeScript(statement);
    const seedMs = performance.now() - seedStarted;
    let planning = applicationFor();

    const availability = await planning.addAvailability({
      strength: 'soft',
      windows: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((weekday) => ({
        weekday: weekday as 'monday',
        start: '09:00',
        end: '17:00',
      })),
    });
    assert(availability.ok, 'Availability setup failed.');
    for (const routine of routineFixtures()) {
      assert((await planning.createRoutine(routine)).ok, `Routine setup failed: ${routine.title}`);
    }

    const weekRuns = await samples(5, () => planning.getWeekPlan('2026-08-12'));
    const week = weekRuns.values[0];
    assert(week !== undefined, 'Week plan missing.');
    assert(week.days.length === 7, 'Week must render seven days.');
    assert(
      week.days.every((day) => day.flexibleActions.length + day.timed.length <= 60),
      'Week day columns must stay bounded.',
    );
    assert(week.backlog.items.length <= 50, 'Backlog must stay bounded to its page size.');
    assert(week.carryForward.items.length <= 50, 'Carry-forward must stay bounded.');
    assert(week.capacity.availability.status === 'partial', 'Weekend availability stays unknown.');
    const weekSummary = summarize(weekRuns.durations);
    assert(weekSummary.worstMs <= thresholds.weekWorstMs, 'Week plan exceeded threshold.');

    const historicalRuns = await samples(3, () => planning.getWeekPlan('2025-03-12'));
    const historicalWeek = summarize(historicalRuns.durations);
    assert(
      historicalWeek.worstMs <= thresholds.historicalWeekWorstMs,
      'Historical week exceeded threshold.',
    );

    const dayRuns = await samples(5, () => planning.getDayPlan('2026-08-12'));
    const day = summarize(dayRuns.durations);
    assert(day.worstMs <= thresholds.dayWorstMs, 'Day plan exceeded threshold.');

    const monthRuns = await samples(3, () => planning.getMonthPlan('2026-08'));
    assert(
      monthRuns.values.every((plan) => plan.weeks.length >= 5),
      'Month must list its weeks.',
    );
    const month = summarize(monthRuns.durations);
    assert(month.worstMs <= thresholds.monthWorstMs, 'Month plan exceeded threshold.');

    const yearRuns = await samples(3, () => planning.getYearPlan('2026'));
    assert(
      yearRuns.values.every((plan) => plan.months.length === 12),
      'Year must list twelve months.',
    );
    const year = summarize(yearRuns.durations);
    assert(year.worstMs <= thresholds.yearWorstMs, 'Year plan exceeded threshold.');

    const backlogAction = week.backlog.items[0];
    assert(backlogAction !== undefined, 'Backlog fixture missing.');
    const schedule = await timed(() =>
      planning.scheduleAction({
        actionId: backlogAction.id,
        revision: backlogAction.localRevision,
        date: '2026-08-13',
        startTime: '06:00',
        durationMinutes: 30,
        overlapAcknowledged: true,
      }),
    );
    assert(schedule.value.ok, 'Scheduling failed.');
    assert(schedule.duration <= thresholds.scheduleMs, 'Scheduling exceeded threshold.');

    const scheduledDay = await planning.getDayPlan('2026-08-13');
    const block = scheduledDay.day.timed.find(
      (entry) =>
        entry.block?.target.kind === 'action' && entry.block.target.actionId === backlogAction.id,
    )?.block;
    assert(block !== undefined, 'Scheduled block must appear on the Day.');
    const move = await timed(() =>
      planning.moveBlock({
        blockId: block.id,
        revision: block.localRevision,
        date: '2026-08-14',
        startTime: '06:30',
        durationMinutes: 30,
        overlapAcknowledged: true,
      }),
    );
    assert(move.value.ok, 'Moving the block failed.');
    assert(move.duration <= thresholds.moveMs, 'Moving exceeded threshold.');
    if (!move.value.ok || !move.value.value.undo.available) throw new Error('Move undo missing.');
    const moveUndoId = move.value.value.undo.undoId;
    const undo = await timed(() => planning.undo(moveUndoId));
    assert(undo.value.ok, 'Move undo failed.');
    assert(undo.duration <= thresholds.undoMs, 'Undo exceeded threshold.');

    const template = await timed(() =>
      planning.applyTemplate({
        templateId: '00000000-0000-4000-a000-000000000002',
        anchorDate: '2026-08-17',
        timeZone: zone,
        // The seeded week already has scheduled work; applying over it is an explicit choice.
        overlapAcknowledged: true,
        selectedKeys: [
          'project',
          'notes',
          'practice-1',
          'summary',
          'practice-2',
          'self-test',
          'light',
        ],
      }),
    );
    assert(template.value.ok, 'Template apply failed.');
    assert(template.duration <= thresholds.templateApplyMs, 'Template apply exceeded threshold.');

    const memoryBefore = browserHeap();
    for (let index = 0; index < 10; index += 1) {
      await planning.getWeekPlan('2026-08-12');
      await planning.getDayPlan('2026-08-12');
    }
    const memoryAfter = browserHeap();
    if (memoryBefore !== null && memoryAfter !== null) {
      assert(
        memoryAfter - memoryBefore < 64 * 1024 * 1024,
        'Repeated horizon navigation grew heap beyond the 64 MiB guardrail.',
      );
    }

    await driver.close();
    const reopenStarted = performance.now();
    const reopened = await BrowserSqliteDriver.open({ databaseName });
    driver = reopened.driver;
    await runMigrations(driver, schemaMigrations, () => now);
    planning = applicationFor();
    const reopenedWeek = await planning.getWeekPlan('2026-08-12');
    const reopenWeekMs = performance.now() - reopenStarted;
    assert(reopenedWeek.days.length === 7, 'Reopen must preserve the week.');
    assert(reopenWeekMs <= thresholds.reopenWeekMs, 'Reopen week exceeded threshold.');

    return {
      dataset: {
        actions: actionCount,
        pastDayPlacements: 6_000,
        futureDayPlacements: 3_000,
        backlogActions: 1_000,
        historicalBlocks: 11_000,
        weeklyCommitments: 104,
        routines: routineFixtures().length,
      },
      storage: opened.storage.durability,
      runtime: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      thresholds,
      results: {
        seedMs: rounded(seedMs),
        week: weekSummary,
        historicalWeek,
        day,
        month,
        year,
        scheduleMs: rounded(schedule.duration),
        moveMs: rounded(move.duration),
        undoMs: rounded(undo.duration),
        templateApplyMs: rounded(template.duration),
        reopenWeekMs: rounded(reopenWeekMs),
        heapDeltaBytes:
          memoryBefore === null || memoryAfter === null
            ? 'unavailable'
            : memoryAfter - memoryBefore,
      },
    };
  } finally {
    await driver.close().catch(() => undefined);
  }
}

function routineFixtures() {
  return [
    {
      title: 'Synthetic morning stretch',
      rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-01-05' },
      schedulingMode: {
        kind: 'time_specific',
        wallTime: '07:00',
        durationMinutes: 20,
        zonePolicy: { kind: 'follow_profile' },
        gapPolicy: 'shift_forward',
        overlapPolicy: 'earlier_offset',
      },
    },
    {
      title: 'Synthetic review',
      rule: {
        version: 1,
        kind: 'weekly_days',
        intervalWeeks: 1,
        weekdays: ['monday', 'thursday'],
        startsOn: '2026-01-05',
      },
      schedulingMode: { kind: 'day_flexible' },
    },
    {
      title: 'Synthetic runs',
      rule: {
        version: 1,
        kind: 'weekly_count',
        targetCount: 3,
        weekStart: 'monday',
        startsOn: '2026-01-05',
      },
      schedulingMode: { kind: 'day_flexible' },
    },
    {
      title: 'Synthetic monthly budget',
      rule: {
        version: 1,
        kind: 'monthly_day',
        intervalMonths: 1,
        dayOfMonth: 31,
        missingDayPolicy: 'last_day',
        startsOn: '2026-01-01',
      },
      schedulingMode: { kind: 'day_flexible' },
    },
  ];
}

function isoDate(base: string, offsetDays: number): string {
  const value = new Date(`${base}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function hex(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`;
}

function seedStatements(): string[] {
  const actions: string[] = [];
  const placements: string[] = [];
  const blocks: string[] = [];
  const sortKey = (index: number) => String(500_000_000_000_000 + index).padStart(15, '0');
  const placement = (index: number, actionId: string, date: string) =>
    `('${hex('84000000', index)}','${ownerId}','${actionId}','day','${date}','${date}','${date}',NULL,'${sortKey(index)}','${now}','${now}','${now}')`;
  for (let index = 0; index < actionCount; index += 1) {
    const id = hex('83000000', index);
    const title = `Synthetic Action ${String(index + 1).padStart(5, '0')}`;
    if (index < 5_000) {
      const date = isoDate('2024-08-12', Math.floor(index / 7));
      actions.push(
        `('${id}','${ownerId}','${title}','completed','plan','${sortKey(index)}','${date}T20:00:00.000Z','${now}','${now}','${now}')`,
      );
      placements.push(placement(index, id, date));
      blocks.push(
        `('${hex('85000000', index)}','${ownerId}','${id}',NULL,NULL,'${date}T14:00:00.000Z','${date}T15:00:00.000Z','${zone}','completed','${now}','${now}','${now}')`,
      );
    } else if (index < 6_000) {
      const date = isoDate('2026-01-05', (index - 5_000) % 210);
      actions.push(
        `('${id}','${ownerId}','${title}','planned','plan','${sortKey(index)}',NULL,'${now}','${now}','${now}')`,
      );
      placements.push(placement(index, id, date));
    } else if (index < 8_000) {
      const date = isoDate('2026-08-10', (index - 6_000) % 365);
      actions.push(
        `('${id}','${ownerId}','${title}','planned','plan','${sortKey(index)}',NULL,'${now}','${now}','${now}')`,
      );
      placements.push(placement(index, id, date));
    } else if (index < 9_000) {
      const offset = index - 8_000;
      const date = isoDate('2026-08-10', offset % 365);
      const hour = 12 + (offset % 8);
      actions.push(
        `('${id}','${ownerId}','${title}','scheduled','plan','${sortKey(index)}',NULL,'${now}','${now}','${now}')`,
      );
      placements.push(placement(index, id, date));
      blocks.push(
        `('${hex('85000000', index)}','${ownerId}','${id}',NULL,NULL,'${date}T${String(hour).padStart(2, '0')}:00:00.000Z','${date}T${String(hour).padStart(2, '0')}:45:00.000Z','${zone}','planned','${now}','${now}','${now}')`,
      );
    } else {
      actions.push(
        `('${id}','${ownerId}','${title}','planned','plan','${sortKey(index)}',NULL,'${now}','${now}','${now}')`,
      );
    }
  }
  for (let index = 0; index < 6_000; index += 1) {
    const date = isoDate('2024-08-12', Math.floor(index / 8));
    const hour = 12 + (index % 8);
    blocks.push(
      `('${hex('86000000', index)}','${ownerId}',NULL,NULL,'Synthetic history ${String(index)}','${date}T${String(hour).padStart(2, '0')}:10:00.000Z','${date}T${String(hour).padStart(2, '0')}:40:00.000Z','${zone}','completed','${now}','${now}','${now}')`,
    );
  }
  const commitments: string[] = [];
  const commitmentBlocks: string[] = [];
  for (let index = 0; index < 104; index += 1) {
    const id = hex('87000000', index);
    const date = isoDate('2025-08-12', index * 7);
    commitments.push(
      `('${id}','${ownerId}','Synthetic class ${String(index + 1)}','${index % 2 === 0 ? 'hard' : 'soft'}','planned','${now}','${now}','${now}')`,
    );
    commitmentBlocks.push(
      `('${hex('88000000', index)}','${ownerId}','${id}','${date}T18:00:00.000Z','${date}T19:30:00.000Z','${zone}','planned','${now}','${now}','${now}')`,
    );
  }
  const chunks = <T>(values: readonly T[], size: number): T[][] => {
    const output: T[][] = [];
    for (let index = 0; index < values.length; index += size)
      output.push(values.slice(index, index + size));
    return output;
  };
  return [
    ...chunks(actions, 1_000).map(
      (
        rows,
      ) => `INSERT INTO actions (id, owner_id, title, state, capture_origin, sort_key, completed_at,
        created_at, updated_at, client_updated_at) VALUES ${rows.join(',')};`,
    ),
    ...chunks(placements, 1_000).map(
      (rows) => `INSERT INTO planning_placements (id, owner_id, action_id, horizon, period_key,
        period_start_date, period_end_date, week_start, sort_key, created_at, updated_at,
        client_updated_at) VALUES ${rows.join(',')};`,
    ),
    ...chunks(blocks, 1_000).map(
      (rows) => `INSERT INTO time_blocks (id, owner_id, action_id, commitment_id, custom_title,
        starts_at_utc, ends_at_utc, time_zone, state, created_at, updated_at, client_updated_at)
        VALUES ${rows.join(',')};`,
    ),
    `INSERT INTO commitments (id, owner_id, title, strength, state, created_at, updated_at,
      client_updated_at) VALUES ${commitments.join(',')};`,
    `INSERT INTO time_blocks (id, owner_id, commitment_id, starts_at_utc, ends_at_utc, time_zone,
      state, created_at, updated_at, client_updated_at) VALUES ${commitmentBlocks.join(',')};`,
  ];
}

async function timed<Value>(operation: () => Promise<Value>) {
  const started = performance.now();
  const value = await operation();
  return { value, duration: performance.now() - started };
}

async function samples<Value>(count: number, operation: () => Promise<Value>) {
  const durations = [];
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const result = await timed(operation);
    durations.push(result.duration);
    values.push(result.value);
  }
  return { durations, values };
}

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    runs: values.length,
    medianMs: rounded(sorted[Math.floor(sorted.length / 2)] ?? 0),
    worstMs: rounded(Math.max(...values)),
  };
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function browserHeap(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory?.usedJSHeapSize ?? null;
}
function report(status: 'failed' | 'passed', value: unknown): void {
  output.dataset['status'] = status;
  output.textContent = JSON.stringify(value, null, 2);
}
