import {
  createSearchApplication,
  parseSearchRequest,
  type SearchRequest,
} from '@yelaxis/application';
import {
  buildSearchSql,
  createSqliteApplicationAdapters,
  runMigrations,
  schemaMigrations,
  SqliteSearchQueries,
} from '@yelaxis/data';
import { BrowserSqliteDriver } from '@yelaxis/data/browser';
import type { OwnerId, UUID } from '@yelaxis/domain';

const owner = 'a1000000-0000-4000-8000-000000000001' as OwnerId;
const profile = 'a2000000-0000-4000-8000-000000000001';
const axis = 'a3000000-0000-4000-8000-000000000001';
const project = 'a4000000-0000-4000-8000-000000000001';
const now = '2026-10-03T10:00:00.000Z';
const actionCount = 10_000;
const thresholds = Object.freeze({ queryWorstMs: 300, detailWorstMs: 300, mainThreadGapMs: 100 });
const output = document.querySelector('#result');
if (!(output instanceof HTMLElement)) throw new Error('Missing output');
void verify().then(
  (result) => report('passed', result),
  (error: unknown) =>
    report('failed', {
      message: error instanceof Error ? error.message : 'Search verification failed',
    }),
);

async function verify() {
  const databaseName = new URLSearchParams(location.search).get('database') ?? '/yelaxis.sqlite3';
  const { driver } = await BrowserSqliteDriver.open({ databaseName });
  try {
    await runMigrations(driver, schemaMigrations, () => now);
    await driver.run(
      "INSERT INTO planning_identities(id,identity_kind,created_at,updated_at) VALUES(?,'local',?,?)",
      [owner, now, now],
    );
    await driver.run(
      `INSERT INTO profiles(id,owner_id,planning_time_zone,week_start,time_format,locale_override,defaults_confirmed_at,onboarding_status,onboarding_step,onboarding_completed_at,onboarding_artifacts_json,created_at,updated_at)
      VALUES(?,?,'Asia/Tashkent','monday','24_hour','en',?,'completed','handbook',?,'{"axisIds":[],"commitments":[]}',?,?)`,
      [profile, owner, now, now, now, now],
    );
    const seedStarted = performance.now();
    for (const sql of seedStatements()) await driver.executeScript(sql);
    const seedMs = rounded(performance.now() - seedStarted);
    const queries = new SqliteSearchQueries(driver);
    const app = createSearchApplication(
      createSqliteApplicationAdapters(driver).identityContext,
      queries,
    );
    const shapes: Readonly<Record<string, SearchRequest>> = {
      prefix: request({ text: 'synthetic' }),
      unicode: request({ text: 'CAFÉ сло' }),
      prose: request({ text: 'recovery receipt' }),
      state: request({ state: 'inbox' }),
      axis: request({ axisId: axis }),
      project: request({ projectId: project }),
      type: request({ kind: 'note' }),
      archive: request({ archive: 'only' }),
      created: request({ dateBasis: 'created', from: '2026-10-03', to: '2026-10-03' }),
      due: request({ dateBasis: 'due', from: '2026-10-09', to: '2026-10-09' }),
      planned: request({ dateBasis: 'planned', from: '2026-10-06', to: '2026-10-06' }),
    };
    let last = performance.now();
    let gap = 0;
    const ticker = setInterval(() => {
      const current = performance.now();
      gap = Math.max(gap, current - last);
      last = current;
    }, 10);
    const timings: Record<string, { medianMs: number; worstMs: number }> = {};
    const plans: Record<string, readonly string[]> = {};
    try {
      for (const [name, filters] of Object.entries(shapes)) {
        const query = buildSearchSql(owner, filters, 40);
        const plan = await driver.all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${query.sql}`,
          query.parameters,
        );
        const joined = plan.map((row) => row.detail).join('\n');
        assert(
          /SEARCH (?:d|search_tokens|p) USING (?:INDEX|COVERING INDEX|PRIMARY KEY)/u.test(joined),
          `${name}: index lookup missing`,
        );
        assert(
          !/SCAN (?:actions|notes|projects|outcomes|review_items|review_checkpoints|d|search_tokens|p)(?:\s|$)/u.test(
            joined,
          ),
          `${name}: forbidden source scan`,
        );
        plans[name] = plan.map((row) => row.detail);
        const durations: number[] = [];
        for (let index = 0; index < 5; index += 1) {
          const started = performance.now();
          const result = await app.search(filters);
          durations.push(performance.now() - started);
          assert(
            result.items.length > 0 && result.items.length <= 40,
            `${name}: page must be bounded and populated`,
          );
        }
        timings[name] = summarize(durations);
        assert(
          timings[name].worstMs <= thresholds.queryWorstMs,
          `${name}: query exceeded ${thresholds.queryWorstMs}ms (${timings[name].worstMs}ms)`,
        );
      }
      const details: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const start = performance.now();
        const record = await app.detail('action', hex('a6000000', 1));
        details.push(performance.now() - start);
        assert(record?.text.includes('receipt') === true, 'Full detail missing');
      }
      timings['detail'] = summarize(details);
      assert(timings['detail'].worstMs <= thresholds.detailWorstMs, 'Detail exceeded threshold');
    } finally {
      clearInterval(ticker);
    }
    assert(
      gap <= thresholds.mainThreadGapMs,
      `Main thread gap exceeded threshold (${rounded(gap)}ms)`,
    );
    const counts = await driver.get<{
      actions: number;
      notes: number;
      reviews: number;
      decisions: number;
      blocks: number;
    }>(
      `SELECT (SELECT COUNT(*) FROM actions) actions,(SELECT COUNT(*) FROM notes) notes,(SELECT COUNT(*) FROM review_checkpoints) reviews,(SELECT COUNT(*) FROM review_items) decisions,(SELECT COUNT(*) FROM time_blocks) blocks`,
    );
    assert(counts?.actions === actionCount, '10,000 Actions are required');
    const sqliteVersion = await driver.get<{ version: string }>(
      'SELECT sqlite_version() AS version',
    );
    const fts = await driver.get<{ fts4: number; fts5: number }>(
      "SELECT sqlite_compileoption_used('ENABLE_FTS4') fts4,sqlite_compileoption_used('ENABLE_FTS5') fts5",
    );
    return {
      counts,
      seedMs,
      sqliteVersion: sqliteVersion?.version,
      fts,
      index: 'owner/token B-tree prefix-word intersection',
      thresholds,
      timings,
      plans,
      mainThreadGapMs: rounded(gap),
    };
  } finally {
    await driver.close();
  }
}
function request(fields: Record<string, unknown>): SearchRequest {
  return parseSearchRequest({ text: '', archive: 'exclude', dateBasis: 'updated', ...fields });
}
function hex(prefix: string, index: number): UUID {
  return `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, '0')}` as UUID;
}
function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function seedStatements(): string[] {
  const sql: string[] = [];
  sql.push(
    `INSERT INTO axes(id,owner_id,title,purpose,state,sort_key,created_at,updated_at) VALUES(${q(axis)},${q(owner)},'Synthetic Axis','Steady synthetic direction','active','a',${q(now)},${q(now)});`,
  );
  sql.push(
    `INSERT INTO outcomes(id,owner_id,axis_id,title,success_definition,state,progress_mode,sort_key,created_at,updated_at) VALUES(${q(hex('a5000000', 1))},${q(owner)},${q(axis)},'Synthetic Outcome','Recovery criteria visible','active','none','a',${q(now)},${q(now)});`,
  );
  sql.push(
    `INSERT INTO projects(id,owner_id,axis_id,title,desired_result,notes,state,sort_key,created_at,updated_at) VALUES(${q(project)},${q(owner)},${q(axis)},'Synthetic Project','Finished safely','Synthetic related project prose','active','a',${q(now)},${q(now)});`,
  );
  sql.push(
    `INSERT INTO milestones(id,owner_id,outcome_id,title,measurable_checkpoint,state,sort_key,created_at,updated_at) VALUES(${q(hex('a7000000', 1))},${q(owner)},${q(hex('a5000000', 1))},'Synthetic Milestone','Recovery boundary proved','active','a',${q(now)},${q(now)});`,
  );
  sql.push(
    `INSERT INTO routines(id,owner_id,axis_id,title,description,state,sort_key,created_at,updated_at) VALUES(${q(hex('a8000000', 1))},${q(owner)},${q(axis)},'Synthetic Routine','Repeat manually','active','a',${q(now)},${q(now)});`,
  );
  const actions: string[] = [];
  const placements: string[] = [];
  const notes: string[] = [];
  const reviews: string[] = [];
  const decisions: string[] = [];
  const blocks: string[] = [];
  for (let n = 1; n <= actionCount; n += 1) {
    const archived = n % 10 === 0;
    actions.push(
      `(${q(hex('a6000000', n))},${q(owner)},${q(axis)},${q(project)},${q(`Synthetic Search Action ${String(n).padStart(5, '0')}`)},'CAFÉ СЛОН recovery receipt and synthetic plan prose. ${'A steady manual plan. '.repeat(8)}',${q(archived ? 'archived' : 'inbox')},${archived ? "'inbox'" : 'NULL'},${archived ? q(now) : 'NULL'},'2026-10-09',${q(String(n).padStart(8, '0'))},${q(now)},${q(now)})`,
    );
    if (!archived)
      placements.push(
        `(${q(hex('b1000000', n))},${q(owner)},${q(hex('a6000000', n))},'day','2026-10-06','2026-10-06','2026-10-06',${q(String(n))},${q(now)},${q(now)})`,
      );
  }
  sql.push(
    `INSERT INTO actions(id,owner_id,axis_id,project_id,title,note_text,state,state_before_archive,archived_at,due_date,sort_key,created_at,updated_at) VALUES ${actions.join(',')};`,
  );
  sql.push(
    `INSERT INTO planning_placements(id,owner_id,action_id,horizon,period_key,period_start_date,period_end_date,sort_key,created_at,updated_at) VALUES ${placements.join(',')};`,
  );
  for (let n = 1; n <= 500; n += 1)
    notes.push(
      `(${q(hex('b2000000', n))},${q(owner)},${q(axis)},${q(project)},${q(`Synthetic Search Note ${n}`)},'Related recovery prose remains fully available in Notes.','active',${q(String(n))},${q(now)},${q(now)})`,
    );
  sql.push(
    `INSERT INTO notes(id,owner_id,axis_id,project_id,title,body,state,sort_key,created_at,updated_at) VALUES ${notes.join(',')};`,
  );
  for (let n = 1; n <= 100; n += 1) {
    const date = new Date(Date.UTC(2024, 0, n)).toISOString().slice(0, 10);
    reviews.push(
      `(${q(hex('b3000000', n))},${q(owner)},${q(profile)},'daily',${q(date)},${q(date)},${q(date)},'Synthetic reflective recovery prose','draft',${q(now)},${q(now)})`,
    );
    decisions.push(
      `(${q(hex('b4000000', n))},${q(owner)},${q(hex('b3000000', n))},'action',${q(hex('a6000000', n))},'carry','Synthetic recovery decision note',${q(String(n))},${q(now)},${q(now)})`,
    );
  }
  sql.push(
    `INSERT INTO review_checkpoints(id,owner_id,profile_id,review_type,period_key,period_start_date,period_end_date,notes,state,created_at,updated_at) VALUES ${reviews.join(',')};`,
  );
  sql.push(
    `INSERT INTO review_items(id,owner_id,review_id,target_kind,action_id,decision,decision_note,sort_key,created_at,updated_at) VALUES ${decisions.join(',')};`,
  );
  for (let n = 1; n <= 12000; n += 1) {
    const start = new Date(Date.UTC(2023, 0, 1) + n * 3 * 3600000);
    const end = new Date(start.getTime() + 3600000);
    blocks.push(
      `(${q(hex('b5000000', n))},${q(owner)},${q(`Synthetic history block ${n}`)},${q(start.toISOString())},${q(end.toISOString())},'UTC','completed',${q(now)},${q(now)})`,
    );
  }
  sql.push(
    `INSERT INTO time_blocks(id,owner_id,custom_title,starts_at_utc,ends_at_utc,time_zone,state,created_at,updated_at) VALUES ${blocks.join(',')};`,
  );
  return sql;
}
function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}
function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}
function summarize(values: readonly number[]): { medianMs: number; worstMs: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: rounded(sorted[Math.floor(sorted.length / 2)] ?? 0),
    worstMs: rounded(sorted.at(-1) ?? 0),
  };
}
function report(status: string, value: unknown): void {
  if (output instanceof HTMLElement) {
    output.dataset['status'] = status;
    output.textContent = JSON.stringify(value, null, 2);
  }
}
