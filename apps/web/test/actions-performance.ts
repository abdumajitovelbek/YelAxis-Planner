import { createActionApplication, type ApplicationDependencies } from '@yelaxis/application';
import {
  createSqliteApplicationAdapters,
  runMigrations,
  schemaMigrations,
  SqliteActionPlanningQueries,
} from '@yelaxis/data';
import { BrowserSqliteDriver } from '@yelaxis/data/browser';
import type { Instant, OwnerId, UUID } from '@yelaxis/domain';

const ownerId = '71000000-0000-4000-8000-000000000001' as OwnerId;
const profileId = '72000000-0000-4000-8000-000000000001';
const now = '2026-08-06T10:00:00.000Z' as Instant;
const datasetSize = 10_000;
const thresholds = Object.freeze({
  initialInboxWorstMs: 250,
  selectAllWorstMs: 750,
  detailWorstMs: 250,
  quickCaptureWorstMs: 500,
  reorderWorstMs: 1_500,
  singleTriageWorstMs: 1_000,
  bulkArchiveMs: 120_000,
  groupedUndoMs: 120_000,
  reopenInboxMs: 1_500,
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
      return `a0000000-0000-4000-8000-${suffix}` as UUID;
    },
  };
  const applicationFor = () => {
    const adapters = createSqliteApplicationAdapters(driver);
    const dependencies: ApplicationDependencies = {
      ...adapters,
      ids,
      clock: { now: () => now },
      projections: { notifyCommitted() {} },
    };
    return createActionApplication(dependencies, new SqliteActionPlanningQueries(driver));
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
       ) VALUES (?, ?, 'UTC', 'monday', '24_hour', 'en', 'completed', 'handbook', ?, ?);`,
      [profileId, ownerId, now, now],
    );
    const seedStarted = performance.now();
    await driver.executeScript(seedSql());
    const seedMs = performance.now() - seedStarted;
    let application = applicationFor();

    const initialRuns = await samples(5, () => application.listInbox({ limit: 50 }));
    assert(
      initialRuns.values.every((page) => page.items.length === 50 && page.total === datasetSize),
      'Inbox query must return a bounded 50-row page from 10,000 rows.',
    );
    const initialInbox = summarize(initialRuns.durations);
    assert(
      initialInbox.worstMs <= thresholds.initialInboxWorstMs,
      'Initial Inbox query exceeded threshold.',
    );

    const selectionRuns = await samples(3, () => application.listAllInbox());
    assert(
      selectionRuns.values.every((items) => items.length === datasetSize),
      'Select-all must resolve exactly 10,000 current Inbox rows.',
    );
    const selectAll = summarize(selectionRuns.durations);
    assert(
      selectAll.worstMs <= thresholds.selectAllWorstMs,
      'Select-all query exceeded threshold.',
    );

    const middle = selectionRuns.values[0]?.[5_000];
    if (middle === undefined) throw new Error('Missing middle Action fixture.');
    const detailRuns = await samples(5, () => application.getAction(middle.ref.id));
    assert(
      detailRuns.values.every((value) => value !== null),
      'Action detail must open.',
    );
    const detail = summarize(detailRuns.durations);
    assert(detail.worstMs <= thresholds.detailWorstMs, 'Action detail exceeded threshold.');

    const quickRuns = [];
    for (let index = 0; index < 3; index += 1) {
      const intent = application.newCaptureIntent('global_capture');
      const measured = await timed(() =>
        application.capture(intent, { title: `Synthetic quick capture ${String(index + 1)}` }),
      );
      assert(measured.value.ok, 'Quick capture failed.');
      quickRuns.push(measured.duration);
    }
    const quickCapture = summarize(quickRuns);
    assert(
      quickCapture.worstMs <= thresholds.quickCaptureWorstMs,
      'Quick capture exceeded threshold.',
    );

    const current = await application.listInbox({ limit: 50 });
    const reorderItem = current.items[1];
    if (reorderItem === undefined) throw new Error('Missing reorder fixture.');
    const reorder = await timed(() =>
      application.reorder(reorderItem.id, reorderItem.localRevision, 'up'),
    );
    assert(reorder.value.ok, 'Reorder failed.');
    assert(reorder.duration <= thresholds.reorderWorstMs, 'Reorder exceeded threshold.');
    if (reorder.value.ok && reorder.value.value.undo.available) {
      assert((await application.undo(reorder.value.value.undo.undoId)).ok, 'Reorder undo failed.');
    }

    const singlePage = await application.listInbox({ limit: 50 });
    const single = singlePage.items[0];
    if (single === undefined) throw new Error('Missing triage fixture.');
    const singleTriage = await timed(() =>
      application.triage(single.id, single.localRevision, { kind: 'archive' }),
    );
    assert(singleTriage.value.ok, 'Single triage failed.');
    assert(
      singleTriage.duration <= thresholds.singleTriageWorstMs,
      'Single triage exceeded threshold.',
    );
    if (!singleTriage.value.ok || !singleTriage.value.value.undo.available)
      throw new Error('Single triage undo missing.');
    assert(
      (await application.undo(singleTriage.value.value.undo.undoId)).ok,
      'Single triage undo failed.',
    );

    const allForBulk = await application.listAllInbox();
    let heartbeatCount = 0;
    const heartbeat = window.setInterval(() => {
      heartbeatCount += 1;
    }, 10);
    const bulk = await timed(() =>
      application.bulk(
        allForBulk.map(({ ref, revision }) => ({ id: ref.id, revision })),
        { kind: 'archive' },
      ),
    );
    window.clearInterval(heartbeat);
    assert(bulk.value.ok, '10,000-row bulk archive failed.');
    assert(bulk.duration <= thresholds.bulkArchiveMs, 'Bulk archive exceeded threshold.');
    assert(heartbeatCount >= 5, 'Bulk persistence blocked the browser main thread.');
    assert(
      (await application.listInbox({ limit: 50 })).total === 0,
      'Bulk archive must remove every selected Inbox row.',
    );
    if (!bulk.value.ok || !bulk.value.value.undo.available) throw new Error('Bulk undo missing.');
    const undoId = bulk.value.value.undo.undoId;
    const undo = await timed(() => application.undo(undoId));
    assert(undo.value.ok, '10,000-row grouped undo failed.');
    assert(undo.duration <= thresholds.groupedUndoMs, 'Grouped undo exceeded threshold.');
    assert(
      (await application.listInbox({ limit: 50 })).total === datasetSize + 3,
      'Grouped undo must restore every row.',
    );

    const memoryBefore = browserHeap();
    for (let index = 0; index < 20; index += 1) {
      await application.listInbox({ limit: 50 });
      await application.getAction(middle.ref.id);
    }
    const memoryAfter = browserHeap();
    if (memoryBefore !== null && memoryAfter !== null) {
      assert(
        memoryAfter - memoryBefore < 64 * 1024 * 1024,
        'Repeated navigation grew heap beyond the 64 MiB guardrail.',
      );
    }

    await driver.close();
    const reopenStarted = performance.now();
    const reopened = await BrowserSqliteDriver.open({ databaseName });
    driver = reopened.driver;
    await runMigrations(driver, schemaMigrations, () => now);
    application = applicationFor();
    const reopenedPage = await application.listInbox({ limit: 50 });
    const reopenInboxMs = performance.now() - reopenStarted;
    assert(
      reopenedPage.items.length === 50 && reopenedPage.total === datasetSize + 3,
      'Reopen must preserve the large Inbox.',
    );
    assert(reopenInboxMs <= thresholds.reopenInboxMs, 'Reopen query exceeded threshold.');

    return {
      datasetSize,
      renderedRowBound: 50,
      storage: opened.storage.durability,
      runtime: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: 'deviceMemory' in navigator ? navigator.deviceMemory : 'unavailable',
      thresholds,
      results: {
        seedMs: rounded(seedMs),
        initialInbox,
        selectAll,
        detail,
        quickCapture,
        reorderMs: rounded(reorder.duration),
        singleTriageMs: rounded(singleTriage.duration),
        bulkArchiveMs: rounded(bulk.duration),
        groupedUndoMs: rounded(undo.duration),
        reopenInboxMs: rounded(reopenInboxMs),
        mainThreadHeartbeatsDuringBulk: heartbeatCount,
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

function seedSql(): string {
  const rows = [];
  for (let index = 0; index < datasetSize; index += 1) {
    const suffix = (index + 1).toString(16).padStart(12, '0');
    const id = `73000000-0000-4000-8000-${suffix}`;
    const sortKey = String(500_000_000_000_000 + index).padStart(15, '0');
    rows.push(
      `('${id}','${ownerId}','Synthetic Action ${String(index + 1).padStart(5, '0')}','inbox','global_capture','${sortKey}','${now}','${now}','${now}')`,
    );
  }
  return `INSERT INTO actions (
    id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at, client_updated_at
  ) VALUES ${rows.join(',')};`;
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
