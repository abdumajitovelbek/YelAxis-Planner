import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLocalTestStack } from '../../../../scripts/lib/local-test-stack.mjs';
import {
  catalogQueryArguments,
  parseCatalogRows,
} from '../../../../packages/sync/src/testing/catalog-query.ts';

/*
 * The selected local Supabase stack for account journeys: synthetic users
 * and data only. Keys are read from `supabase status` in memory and never printed, logged, or
 * written; the browser build receives only the API URL and the public anon key. The service-role
 * key stays in this Node process (test-user cleanup and verification queries).
 */

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const webRoot = fileURLToPath(new URL('../../', import.meta.url));

export const stackNotRunningMessage =
  'The selected local test stack is unavailable or does not match its configuration. ' +
  'Start a disposable stack with `pnpm run supabase:start` ' +
  '(Docker required) and apply migrations with `pnpm run supabase:reset`.';

let environment;

/** The running stack's API URL and keys (never printed). */
export function stackEnvironment() {
  if (environment !== undefined) return environment;
  try {
    environment = readLocalTestStack(repositoryRoot);
  } catch {
    throw new Error(stackNotRunningMessage);
  }
  return environment;
}

/** Hides every key of the stack in text that is about to be shown. */
export function redact(text) {
  const { anonKey, serviceRoleKey, jwtSecret } = stackEnvironment();
  return String(text)
    .split(anonKey)
    .join('[anon key]')
    .split(serviceRoleKey)
    .join('[service key]')
    .split(jwtSecret)
    .join('[signing material]');
}

/** Builds the web app with the public account configuration of the local stack. */
export async function buildWithAccount() {
  const { apiUrl, anonKey } = stackEnvironment();
  const child = spawn('pnpm', ['exec', 'vite', 'build'], {
    cwd: webRoot,
    env: {
      ...process.env,
      VITE_YELAXIS_SUPABASE_URL: apiUrl,
      VITE_YELAXIS_SUPABASE_ANON_KEY: anonKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(`The account build failed:\n${redact(output)}`);
}

/** Runs one read-only SQL statement on the local stack's database and returns its rows. */
export function queryDatabase(
  sql,
  { execute = spawnSync, readEnvironment = stackEnvironment } = {},
) {
  const { binary, workdir } = readEnvironment();
  const result = execute(binary, catalogQueryArguments(workdir, sql), {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error('A database query on the local stack failed.');
  return parseCatalogRows(result.stdout);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The account subject of a synthetic email, or null when no such account exists. */
export function accountIdOf(email) {
  if (!/^[a-z0-9.+-]+@example\.test$/u.test(email)) throw new Error('Not a synthetic email.');
  const [row] = queryDatabase(`select id::text as id from auth.users where email = '${email}'`);
  return row?.id ?? null;
}

/** Live and deleted cloud records of one owner by entity type, and its other owner rows. */
export function cloudRows(ownerId) {
  if (!uuidPattern.test(ownerId)) throw new Error('Not an owner id.');
  const [counts] = queryDatabase(
    `select
       (select count(*) from yelaxis_sync.records
         where owner_id = '${ownerId}' and document is not null)::int as live,
       (select count(*) from yelaxis_sync.records
         where owner_id = '${ownerId}' and document is null)::int as tombstones,
       (select count(*) from yelaxis_sync.change_log where owner_id = '${ownerId}')::int as changes,
       (select count(*) from yelaxis_sync.conflicts where owner_id = '${ownerId}')::int as conflicts,
       (select count(*) from yelaxis_sync.replicas where owner_id = '${ownerId}')::int as replicas,
       (select count(*) from auth.users where id = '${ownerId}')::int as users`,
  );
  const byType = Object.fromEntries(
    queryDatabase(
      `select entity_type, count(*)::int as count from yelaxis_sync.records
        where owner_id = '${ownerId}' and document is not null group by entity_type`,
    ).map((row) => [row.entity_type, row.count]),
  );
  return { ...counts, byType };
}

/** Live cloud documents of one owner and type (verification only). */
export function cloudDocuments(ownerId, entityType) {
  if (!uuidPattern.test(ownerId) || !/^[a-z_]+$/u.test(entityType)) throw new Error('Bad query.');
  return queryDatabase(
    `select entity_id::text as id, server_revision::int as revision, document
       from yelaxis_sync.records
      where owner_id = '${ownerId}' and entity_type = '${entityType}' and document is not null
      order by entity_id`,
  );
}

/** Deletes synthetic test accounts through the auth admin API (their cloud rows cascade). */
export async function deleteAccounts(ids) {
  const { apiUrl, serviceRoleKey } = stackEnvironment();
  for (const id of ids) {
    if (!uuidPattern.test(id)) continue;
    await fetch(`${apiUrl}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
    }).catch(() => undefined);
  }
}
