import {
  createActionApplication,
  createPlanningApplication,
  createTodayApplication,
  createSerialQueue,
  type ApplicationDependencies,
} from '@yelaxis/application';
import {
  createSqliteApplicationAdapters,
  runMigrations,
  schemaMigrations,
  SqliteActionPlanningQueries,
  SqlitePlanningQueries,
  SqliteTodayQueries,
  planningQuerySql,
} from '@yelaxis/data';
import { BrowserSqliteDriver } from '@yelaxis/data/browser';
import type { CalendarDate, Instant, OwnerId, UUID } from '@yelaxis/domain';

/** Test-only maintenance fixture; never included in the shipped application or its service worker. */
const owner = 'd1100000-0000-4000-8000-000000000001' as OwnerId;
const profile = 'd1200000-0000-4000-8000-000000000001';
const now = '2026-10-04T09:00:00.000Z' as Instant;
const date = now.slice(0, 10) as CalendarDate;
const budgets = Object.freeze({
  queryMs: 300,
  acknowledgedWriteMs: 1500,
  queuedEightWritesMs: 12000,
  workerReopenMs: 2500,
  mainThreadGapMs: 100,
});
const output = document.querySelector<HTMLElement>('#result');
if (output === null) throw new Error('Missing result.');
void verify().then(
  (result) => report('passed', result),
  (error: unknown) =>
    report('failed', {
      message: error instanceof Error ? error.message : 'Release storage benchmark failed.',
    }),
);

async function verify() {
  phase('initialize');
  const databaseName = new URLSearchParams(location.search).get('database');
  if (databaseName === null) throw new Error('Synthetic database required.');
  let driver = (await BrowserSqliteDriver.open({ databaseName })).driver;
  let sequence = 1;
  const applicationFor = () => {
    const dependencies: ApplicationDependencies = {
      ...createSqliteApplicationAdapters(driver),
      ids: { next: () => id('d1900000', sequence++) },
      clock: { now: () => now },
      projections: { notifyCommitted() {} },
    };
    const queue = createSerialQueue();
    return {
      actions: createActionApplication(dependencies, new SqliteActionPlanningQueries(driver), {
        queue,
      }),
      planning: createPlanningApplication(dependencies, new SqlitePlanningQueries(driver), {
        queue,
      }),
      today: createTodayApplication(dependencies, new SqliteTodayQueries(driver), { queue }),
    };
  };
  let last = performance.now();
  let gapMs = 0;
  const heartbeat = setInterval(() => {
    const at = performance.now();
    gapMs = Math.max(gapMs, at - last);
    last = at;
  }, 10);
  try {
    await runMigrations(driver, schemaMigrations, () => now);
    await driver.run(
      "INSERT INTO planning_identities(id,identity_kind,created_at,updated_at) VALUES(?,'local',?,?);",
      [owner, now, now],
    );
    await driver.run(
      `INSERT INTO profiles(id,owner_id,planning_time_zone,week_start,time_format,locale_override,defaults_confirmed_at,onboarding_status,onboarding_step,onboarding_completed_at,onboarding_artifacts_json,created_at,updated_at)
      VALUES(?,?,'UTC','monday','24_hour','en',?,'completed','handbook',?,'{"axisIds":[],"commitments":[]}',?,?);`,
      [profile, owner, now, now, now, now],
    );
    const stages = [];
    let captures = 0;
    for (const [start, end] of [
      [1, 1000],
      [1001, 10000],
    ] as const) {
      phase(`bulk-seed-${end}`);
      const seed = await timed(() =>
        driver.transaction(async (tx) => {
          for (let first = start; first <= end; first += 250) {
            const rows = [];
            for (let n = first; n <= Math.min(end, first + 249); n++)
              rows.push(
                `(${q(id('d1300000', n))},${q(owner)},${q(`Synthetic Release Action ${String(n).padStart(5, '0')}`)},${q('Synthetic release prose retained locally. '.repeat(20))},'planned','plan',${q(String(n).padStart(15, '0'))},${q(now)},${q(now)})`,
              );
            await tx.run(
              `INSERT INTO actions(id,owner_id,title,note_text,state,capture_origin,sort_key,created_at,updated_at) VALUES ${rows.join(',')};`,
            );
          }
          if (end === 10000)
            for (let first = 1; first <= 12000; first += 250) {
              const rows = [];
              for (let n = first; n < first + 250; n++) {
                const day = new Date(Date.UTC(2020, 0, 1 + Math.floor(n / 5)))
                  .toISOString()
                  .slice(0, 10);
                rows.push(
                  `(${q(id('d1400000', n))},${q(owner)},'Synthetic history block',${q(`${day}T08:00:00.000Z`)},${q(`${day}T08:30:00.000Z`)},'UTC','completed',${q(now)},${q(now)})`,
                );
              }
              await tx.run(
                `INSERT INTO time_blocks(id,owner_id,custom_title,starts_at_utc,ends_at_utc,time_zone,state,created_at,updated_at) VALUES ${rows.join(',')};`,
              );
            }
        }),
      );
      const apps = applicationFor();
      const queries = [];
      phase(`backlog-${end}`);
      for (let n = 0; n < 5; n++) {
        const read = await timed(() => new SqlitePlanningQueries(driver).listBacklog(owner, 50));
        assert(
          read.value.total === end && read.value.items.length === 50,
          'Backlog completeness/page boundary.',
        );
        assert(read.duration <= budgets.queryMs, 'Backlog query budget.');
        queries.push(read.duration);
      }
      const writes = [];
      for (let n = 0; n < 3; n++) {
        phase(`capture-${end}-${n + 1}`);
        const intent = apps.actions.newCaptureIntent('global_capture');
        const write = await timed(() =>
          apps.actions.capture(intent, { title: `Synthetic acknowledged capture ${end}-${n}` }),
        );
        assert(write.value.ok, 'Acknowledged capture.');
        assert(
          write.duration <= budgets.acknowledgedWriteMs,
          'Whole-image acknowledged write budget.',
        );
        captures++;
        writes.push(write.duration);
        phase(`edit-${end}-${n + 1}`);
        const edit = await timed(() =>
          apps.actions.edit(intent.actionId, 1, {
            title: `Synthetic acknowledged capture ${end}-${n} saved`,
          }),
        );
        assert(
          edit.value.ok && edit.value.value.undo.available,
          'An ordinary edit must atomically retain its supported Undo.',
        );
        assert(
          edit.duration <= budgets.acknowledgedWriteMs,
          'Whole-image acknowledged edit budget.',
        );
        writes.push(edit.duration);
      }
      phase(`measure-image-${end}`);
      const imageBytes = await databaseBytes(driver);
      const before = await driver.get<{
        actions: number;
        events: number;
        receipts: number;
        undo: number;
        outbox: number;
      }>(
        'SELECT (SELECT COUNT(*) FROM actions) actions,(SELECT COUNT(*) FROM domain_events) events,(SELECT COUNT(*) FROM command_receipts) receipts,(SELECT COUNT(*) FROM undo_records) undo,(SELECT COUNT(*) FROM sync_outbox) outbox;',
      );
      assert(
        before?.events === captures * 2 &&
          before.receipts === captures * 2 &&
          before.undo === captures &&
          before.outbox === 0,
        `Captures and supported edits retain the exact minimized events, command receipts, edit Undo and local-only outbox: ${JSON.stringify(before)}.`,
      );
      phase(`close-stage-${end}`);
      await driver.close();
      phase(`reopen-stage-${end}`);
      const reopen = await timed(
        async () => (await BrowserSqliteDriver.open({ databaseName })).driver,
      );
      driver = reopen.value;
      assert(reopen.duration <= budgets.workerReopenMs, 'Whole-image worker reopen budget.');
      const after = await driver.get(
        'SELECT (SELECT COUNT(*) FROM actions) actions,(SELECT COUNT(*) FROM domain_events) events,(SELECT COUNT(*) FROM command_receipts) receipts,(SELECT COUNT(*) FROM undo_records) undo,(SELECT COUNT(*) FROM sync_outbox) outbox;',
      );
      assert(
        JSON.stringify(after) === JSON.stringify(before),
        'Acknowledged rows/events/receipts/undo/outbox survive reopen.',
      );
      assert(before?.actions === end + captures, 'Complete canonical row count.');
      const plan = await driver.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${planningQuerySql.listBlocks}`,
        [owner, `${date}T23:59:59.999Z`, `${date}T00:00:00.000Z`],
      );
      assert(
        plan.some((row) => row.detail.includes('SEARCH b USING INDEX idx_time_blocks_overlap_end')),
        'End-index overlap lookup.',
      );
      assert(
        plan.every((row) => !/\bSCAN b\b/u.test(row.detail)),
        'No history scan.',
      );
      stages.push({
        actions: end,
        historyBlocks: end === 10000 ? 12000 : 0,
        seedMs: round(seed.duration),
        imageBytes,
        backlog: summarize(queries),
        acknowledgedWrites: summarize(writes),
        reopenMs: round(reopen.duration),
        durableCounts: after,
        overlapPlan: plan.map((row) => row.detail),
        mainPageHeapBytes: heap(),
      });
    }
    phase('seed-dense-day');
    await driver.transaction(async (tx) => {
      for (let first = 1; first <= 1003; first += 250) {
        const rows = [];
        for (let n = first; n <= Math.min(1003, first + 249); n++)
          rows.push(
            `(${q(id('d1500000', n))},${q(owner)},${q(id('d1300000', n))},'day',${q(date)},${q(date)},${q(date)},${q(String(n).padStart(15, '0'))},${q(now)},${q(now)})`,
          );
        await tx.run(
          `INSERT INTO planning_placements(id,owner_id,action_id,horizon,period_key,period_start_date,period_end_date,sort_key,created_at,updated_at) VALUES ${rows.join(',')};`,
        );
      }
      const rows = [];
      for (let n = 1; n <= 64; n++)
        rows.push(
          `(${q(id('d1600000', n))},${q(owner)},${q(`Synthetic dense block ${String(n).padStart(3, '0')}`)},${q(`${date}T08:00:00.000Z`)},${q(`${date}T09:00:00.000Z`)},'UTC','planned',${q(now)},${q(now)})`,
        );
      rows.push(
        `(${q(id('d1600000', 65))},${q(owner)},'Synthetic long imported interval','2026-07-01T08:00:00.000Z','2026-12-31T09:00:00.000Z','UTC','planned',${q(now)},${q(now)})`,
      );
      await tx.run(
        `INSERT INTO time_blocks(id,owner_id,custom_title,starts_at_utc,ends_at_utc,time_zone,state,created_at,updated_at) VALUES ${rows.join(',')};`,
      );
      await tx.run('UPDATE actions SET note_text=? WHERE id=?;', [
        'Synthetic long prose. '.repeat(500).slice(0, 10000),
        id('d1300000', 1),
      ]);
    });
    const apps = applicationFor();
    const selectedDay = [];
    const selectedToday = [];
    for (let run = 0; run < 5; run++) {
      phase(`dense-day-${run + 1}`);
      const day = await timed(() => apps.planning.getDayPlan(date));
      assert(
        day.value.day.flexibleActions.length === 1003 && day.value.day.timed.length === 65,
        'Day must retain all 1003 flexible Actions and 65 overlapping intervals.',
      );
      assert(day.duration <= budgets.queryMs, 'Dense selected Day query budget.');
      selectedDay.push(day.duration);
      phase(`dense-today-${run + 1}`);
      const today = await timed(() => apps.today.getToday(date));
      assert(
        today.value.flexible.open.length === 1003 && today.value.timeline.entries.length === 65,
        'Today must retain all 1003 flexible Actions and 65 overlapping intervals.',
      );
      assert(today.duration <= budgets.queryMs, 'Dense selected Today query budget.');
      selectedToday.push(today.duration);
    }
    const intents = Array.from({ length: 8 }, () =>
      apps.actions.newCaptureIntent('global_capture'),
    );
    phase('queued-eight-writes');
    const queued = await timed(() =>
      Promise.all(
        intents.map((intent, n) =>
          apps.actions.capture(intent, { title: `Synthetic queued release capture ${n}` }),
        ),
      ),
    );
    assert(
      queued.value.every((result) => result.ok),
      'Queued ordinary command acknowledgements.',
    );
    assert(queued.duration <= budgets.queuedEightWritesMs, 'Queued writes budget.');
    const endCounts = await driver.get<{
      actions: number;
      events: number;
      receipts: number;
      undo: number;
      outbox: number;
    }>(
      'SELECT (SELECT COUNT(*) FROM actions) actions,(SELECT COUNT(*) FROM domain_events) events,(SELECT COUNT(*) FROM command_receipts) receipts,(SELECT COUNT(*) FROM undo_records) undo,(SELECT COUNT(*) FROM sync_outbox) outbox;',
    );
    assert(endCounts?.actions === 10014, 'Every queued acknowledged capture persisted.');
    assert(
      endCounts.events === 20 &&
        endCounts.receipts === 20 &&
        endCounts.undo === 6 &&
        endCounts.outbox === 0,
      'Every queued capture atomically records its operational receipt set.',
    );
    phase('close-final');
    await driver.close();
    phase('reopen-final');
    driver = (await BrowserSqliteDriver.open({ databaseName })).driver;
    assert(
      JSON.stringify(
        await driver.get(
          'SELECT (SELECT COUNT(*) FROM actions) actions,(SELECT COUNT(*) FROM domain_events) events,(SELECT COUNT(*) FROM command_receipts) receipts,(SELECT COUNT(*) FROM undo_records) undo,(SELECT COUNT(*) FROM sync_outbox) outbox;',
        ),
      ) === JSON.stringify(endCounts),
      'Queued rows, events, receipts, undo and local-only outbox survive final restart.',
    );
    phase('measure-final-image');
    const expectedFinalImageBytes = await databaseBytes(driver);
    phase('final-export');
    const finalExport = await driver.exportDatabase();
    const finalImageBytes = finalExport.byteLength;
    assert(
      finalImageBytes === expectedFinalImageBytes,
      'Actual export matches the exact worker page bytes.',
    );
    const sqliteHeader = 'SQLite format 3\0';
    assert(
      Array.from(sqliteHeader).every(
        (character, index) => finalExport[index] === character.charCodeAt(0),
      ),
      'Actual export retains the standard SQLite file header.',
    );
    // Yield once so the heartbeat includes the preceding snapshot/export round trips.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      gapMs <= budgets.mainThreadGapMs,
      'Worker storage/canonical application writes blocked input.',
    );
    return {
      runtime: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      budgets,
      stages,
      selectedDay: summarize(selectedDay),
      selectedToday: summarize(selectedToday),
      denseFlexibleActions: 1003,
      denseTimedEntries: 65,
      longNoteCharacters: 'Synthetic long prose. '.repeat(500).slice(0, 10000).length,
      queuedEightWritesMs: round(queued.duration),
      finalImageBytes,
      finalActions: endCounts?.actions,
      finalDurableCounts: endCounts,
      mainThreadGapMs: round(gapMs),
      testClock: now,
      canonicalSource: 'worker SQLite; acknowledged whole image IndexedDB snapshot',
    };
  } finally {
    phase('worker-close');
    clearInterval(heartbeat);
    await driver.close().catch(() => undefined);
  }
}

function phase(value: string) {
  if (output !== null) output.dataset['phase'] = value;
}
async function databaseBytes(driver: BrowserSqliteDriver): Promise<number> {
  const pages = await driver.get<{ page_count: number }>('PRAGMA page_count;');
  const size = await driver.get<{ page_size: number }>('PRAGMA page_size;');
  assert(
    pages !== undefined &&
      size !== undefined &&
      Number.isSafeInteger(pages.page_count) &&
      Number.isSafeInteger(size.page_size),
    'Worker database page byte metrics are numeric.',
  );
  return pages.page_count * size.page_size;
}

function id(prefix: string, n: number): UUID {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as UUID;
}
function q(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
async function timed<T>(operation: () => Promise<T>) {
  const start = performance.now();
  return { value: await operation(), duration: performance.now() - start };
}
function round(value: number) {
  return Math.round(value * 10) / 10;
}
function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    runs: values.length,
    medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    worstMs: round(Math.max(...values)),
  };
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function heap(): number | 'unavailable' {
  return (
    (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
    'unavailable'
  );
}
function report(status: 'passed' | 'failed', value: unknown) {
  if (output === null) return;
  output.dataset['status'] = status;
  output.textContent = JSON.stringify(value, null, 2);
}
