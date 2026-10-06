import { runMigrations, schemaMigrations } from '@yelaxis/data';
import { BrowserSqliteDriver } from '@yelaxis/data/browser';

/*
 * account sync large-sync seed (acceptance criterion 11): a completed local plan
 * with 10,000 synthetic inbox Actions in the original local database, for the first upload and the
 * second client's pull in `scripts/verify-sync-performance.mjs`.
 */

const ownerId = '74000000-0000-4000-8000-000000000001';
const profileId = '75000000-0000-4000-8000-000000000001';
const now = '2026-10-01T09:00:00.000Z';

const outputNode = document.querySelector('#result');
if (!(outputNode instanceof HTMLElement)) throw new Error('Missing result element.');
const output: HTMLElement = outputNode;

void seed().then(
  (result) => report('passed', result),
  (error: unknown) =>
    report('failed', { message: error instanceof Error ? error.message : String(error) }),
);

async function seed() {
  const parameters = new URLSearchParams(window.location.search);
  const databaseName = parameters.get('database') ?? '/yelaxis.sqlite3';
  const size = Number(parameters.get('size') ?? '10000');
  if (!Number.isSafeInteger(size) || size < 1 || size > 20_000) throw new Error('Bad size.');
  const { driver } = await BrowserSqliteDriver.open({ databaseName });
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
         defaults_confirmed_at, onboarding_status, onboarding_step, onboarding_completed_at,
         onboarding_artifacts_json, created_at, updated_at
       ) VALUES (?, ?, 'Asia/Tashkent', 'monday', '24_hour', 'en', ?, 'completed', 'handbook', ?,
                 '{"axisIds":[],"commitments":[]}', ?, ?);`,
      [profileId, ownerId, now, now, now, now],
    );
    const started = performance.now();
    await driver.executeScript(actionsSql(size));
    return { size, seedMs: Math.round(performance.now() - started) };
  } finally {
    await driver.close();
  }
}

function actionsSql(size: number): string {
  const rows = [];
  for (let index = 0; index < size; index += 1) {
    const suffix = (index + 1).toString(16).padStart(12, '0');
    const id = `76000000-0000-4000-8000-${suffix}`;
    const sortKey = String(500_000_000_000_000 + index).padStart(15, '0');
    rows.push(
      `('${id}','${ownerId}','Large sync Action ${String(index + 1).padStart(5, '0')}','inbox','global_capture','${sortKey}','${now}','${now}','${now}')`,
    );
  }
  return `INSERT INTO actions (
    id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at, client_updated_at
  ) VALUES ${rows.join(',')};`;
}

function report(status: 'passed' | 'failed', value: unknown) {
  output.dataset['status'] = status;
  output.textContent = JSON.stringify(value, null, 2);
}
