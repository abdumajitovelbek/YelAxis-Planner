/**
 * Support for backend tests: an explicitly selected local Supabase stack only, with
 * synthetic users and data. Keys are read from `supabase status` in code and never printed,
 * logged, or written anywhere.
 */
import { spawnSync } from 'node:child_process';
import { catalogQueryArguments, parseCatalogRows } from '../testing/catalog-query';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  readLocalTestStack,
  type LocalTestStack,
} from '../../../../scripts/lib/local-test-stack.mjs';

import { createClient } from '@supabase/supabase-js';

import {
  accountDeleteResponseSchema,
  accountStatusResponseSchema,
  pullResponseSchema,
  pushResponseSchema,
  serverConflictSchema,
  type AccountDeleteResponse,
  type AccountStatusResponse,
  type CloseConflictRequest,
  type PulledChange,
  type PullResponse,
  type PushOperation,
  type PushRequest,
  type PushResponse,
  type ServerConflict,
  type SyncEntityType,
} from '../protocol';

export const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export const stackNotRunningMessage =
  'The selected local test stack is unavailable or does not match its configuration. Start it with ' +
  '`pnpm run supabase:start` (Docker required), apply migrations with `pnpm run supabase:reset`, ' +
  'then run `pnpm run test:backend`.';

let environment: LocalTestStack | undefined;

/** Reads the running stack's API URL and keys; throws a clear error when it is not running. */
export function stackEnvironment(): LocalTestStack {
  if (environment !== undefined) return environment;
  try {
    environment = readLocalTestStack(repositoryRoot);
  } catch {
    throw new Error(stackNotRunningMessage);
  }
  return environment;
}

/** A supabase-js client as the browser creates it (no generated database types). */
export type Client = ReturnType<typeof anonClient>;

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

/** Service-role client for the auth admin API only (test setup and verification). */
export function adminClient() {
  const { apiUrl, serviceRoleKey } = stackEnvironment();
  return createClient(apiUrl, serviceRoleKey, clientOptions);
}

/** A client with only the public anon key: the anonymous browser. */
export function anonClient() {
  const { apiUrl, anonKey } = stackEnvironment();
  return createClient(apiUrl, anonKey, clientOptions);
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * An access token for `subject` signed like the stack's auth service signs sessions. Tests mint
 * tokens instead of signing in for every user, so the local sign-in rate limit is never reached;
 * one test signs in with a password to cover the real session.
 */
export function mintAccessToken(
  subject: string,
  options: { readonly expiresInSeconds?: number; readonly claims?: Record<string, unknown> } = {},
): string {
  const { jwtSecret } = stackEnvironment();
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      aud: 'authenticated',
      role: 'authenticated',
      sub: subject,
      iat: issuedAt - 5,
      exp: issuedAt + (options.expiresInSeconds ?? 600),
      ...options.claims,
    }),
  );
  const signature = createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64Url(signature)}`;
}

/** A client that sends `accessToken` as the session, like the browser after sign-in. */
export function tokenClient(accessToken: string) {
  const { apiUrl, anonKey } = stackEnvironment();
  return createClient(apiUrl, anonKey, {
    ...clientOptions,
    accessToken: () => Promise.resolve(accessToken),
  });
}

/**
 * The `amr` claim the auth service writes for a password sign-in `secondsAgo` seconds ago. A
 * refreshed token keeps the time of the sign-in it came from.
 */
export function passwordSignIn(secondsAgo = 0): { readonly amr: readonly unknown[] } {
  return { amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - secondsAgo }] };
}

/** A session of `subject` that signed in with the password `secondsAgo` seconds ago. */
export function signedInClient(subject: string, secondsAgo = 0): Client {
  return tokenClient(mintAccessToken(subject, { claims: passwordSignIn(secondsAgo) }));
}

/** The claims of an access token (its payload), never logged. */
export function tokenClaims(accessToken: string): Record<string, unknown> {
  const payload = accessToken.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/**
 * Calls a client function with `body` as the exact JSON text of its arguments, so a test can send
 * number forms that `JSON.stringify` never writes (`30.0`, `1E2`).
 */
export async function rawRpc(
  accessToken: string,
  name: string,
  body: string,
): Promise<{ readonly status: number; readonly data: unknown }> {
  const { apiUrl, anonKey } = stackEnvironment();
  const response = await fetch(`${apiUrl.replace(/\/$/u, '')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body,
  });
  return { status: response.status, data: (await response.json()) as unknown };
}

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  /** A minted session without `amr`: enough for everything except deleting the account. */
  readonly accessToken: string;
  readonly client: Client;
}

const createdUsers = new Set<string>();

/** A synthetic account created through the admin API, acting through its own session. */
export async function createTestUser(label: string): Promise<TestUser> {
  const email = `sync-${label}-${randomUUID()}@example.test`;
  const password = randomBytes(24).toString('base64url');
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error !== null || data.user === null) {
    throw new Error(`Creating a test user failed: ${error?.code ?? 'unknown'}`);
  }
  createdUsers.add(data.user.id);
  const accessToken = mintAccessToken(data.user.id);
  return { id: data.user.id, email, password, accessToken, client: tokenClient(accessToken) };
}

/** Removes every account a test file created (their rows cascade). */
export async function deleteTestUsers(): Promise<void> {
  const admin = adminClient();
  for (const id of createdUsers) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUsers.clear();
}

export async function authUserExists(id: string): Promise<boolean> {
  const { data, error } = await adminClient().auth.admin.getUserById(id);
  if (error !== null) {
    if (error.status === 404) return false;
    throw new Error(`Reading a test user failed: ${error.code ?? 'unknown'}`);
  }
  return data.user !== null;
}

/**
 * Waits until the API gateway, the REST service (with the sync functions loaded), and the auth
 * service answer; right after `supabase db reset` they restart and briefly answer 503.
 */
export async function waitForStack(timeoutMs = 90_000): Promise<void> {
  const { apiUrl, anonKey } = stackEnvironment();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const functions = await rpc(anonClient(), 'account_status');
      const auth = await fetch(`${apiUrl.replace(/\/$/u, '')}/auth/v1/health`, {
        headers: { apikey: anonKey },
      });
      // Anonymous callers are refused by the function itself: the API is up and loaded.
      if (functions.status === 401 && functions.code === '42501' && auth.ok) return;
    } catch {
      // Not reachable yet.
    }
    if (Date.now() > deadline) throw new Error(stackNotRunningMessage);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/* ───────────────────────── Database queries (catalog and verification) ───────────────────────── */

/**
 * Runs one read-only SQL statement on the local stack's database through the Supabase CLI and
 * returns its rows. Used to verify catalog security and that deleted owners leave no rows.
 */
export function queryDatabase<Row extends Record<string, unknown>>(sql: string): Row[] {
  const { binary, workdir } = stackEnvironment();
  const result = spawnSync(binary, catalogQueryArguments(workdir, sql), {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error('A database query on the local stack failed.');
  return parseCatalogRows(result.stdout) as Row[];
}

/* ───────────────────────── Protocol helpers ───────────────────────── */

export interface RpcOutcome {
  readonly data: unknown;
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
}

export async function rpc(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<RpcOutcome> {
  const response = await client.rpc(name, args);
  const data: unknown = response.data;
  return {
    data,
    status: response.status,
    code: response.error?.code ?? null,
    message: response.error?.message ?? null,
  };
}

function succeeded(name: string, outcome: RpcOutcome): unknown {
  if (outcome.code !== null) {
    throw new Error(`${name} failed with HTTP ${String(outcome.status)} (${outcome.code}).`);
  }
  return outcome.data;
}

/** `sync_push`, parsed with the protocol schema. */
export async function push(client: Client, request: unknown): Promise<PushResponse> {
  return pushResponseSchema.parse(
    succeeded('sync_push', await rpc(client, 'sync_push', { request })),
  );
}

export type AcceptedPush = Extract<PushResponse, { status: 'accepted' }>;
export type ConflictPush = Extract<PushResponse, { status: 'conflict' }>;
export type RejectedPush = Extract<PushResponse, { status: 'rejected' }>;

export async function pushAccepted(client: Client, request: unknown): Promise<AcceptedPush> {
  const response = await push(client, request);
  if (response.status !== 'accepted') {
    throw new Error(`Expected an accepted push, got ${JSON.stringify(response)}.`);
  }
  return response;
}

export async function pushConflict(client: Client, request: unknown): Promise<ConflictPush> {
  const response = await push(client, request);
  if (response.status !== 'conflict') {
    throw new Error(`Expected a conflict, got ${JSON.stringify(response)}.`);
  }
  return response;
}

export async function pushRejected(client: Client, request: unknown): Promise<RejectedPush> {
  const response = await push(client, request);
  if (response.status !== 'rejected') {
    throw new Error(`Expected a rejection, got ${JSON.stringify(response)}.`);
  }
  return response;
}

/** `sync_pull`, parsed with the protocol schema. */
export async function pull(
  client: Client,
  afterCursor: string | null,
  limit = 500,
  replicaId: string = randomUUID(),
): Promise<PullResponse> {
  return pullResponseSchema.parse(
    succeeded(
      'sync_pull',
      await rpc(client, 'sync_pull', {
        request: { protocolVersion: 1, replicaId, afterCursor, limit },
      }),
    ),
  );
}

export type PulledPage = Extract<PullResponse, { status: 'page' }>;

export async function pullPage(
  client: Client,
  afterCursor: string | null,
  limit = 500,
): Promise<PulledPage> {
  const response = await pull(client, afterCursor, limit);
  if (response.status !== 'page') throw new Error('Expected a page, got cursor_expired.');
  return response;
}

/** Every change after `afterCursor`, following pages until caught up. */
export async function pullAll(
  client: Client,
  afterCursor: string | null = null,
  limit = 500,
): Promise<{ readonly changes: PulledChange[]; readonly cursor: string; readonly pages: number }> {
  const changes: PulledChange[] = [];
  let cursor = afterCursor;
  let pages = 0;
  for (;;) {
    const page = await pullPage(client, cursor, limit);
    pages += 1;
    changes.push(...page.changes);
    cursor = page.nextCursor;
    if (!page.hasMore) return { changes, cursor, pages };
  }
}

export async function openConflicts(client: Client): Promise<ServerConflict[]> {
  return serverConflictSchema
    .array()
    .parse(succeeded('sync_open_conflicts', await rpc(client, 'sync_open_conflicts')));
}

export async function closeConflict(
  client: Client,
  request: CloseConflictRequest,
): Promise<{ readonly closed: true }> {
  const data = succeeded(
    'sync_close_conflict',
    await rpc(client, 'sync_close_conflict', { request }),
  );
  if (JSON.stringify(data) !== '{"closed":true}') throw new Error('Unexpected close response.');
  return { closed: true };
}

export async function accountStatus(client: Client): Promise<AccountStatusResponse> {
  return accountStatusResponseSchema.parse(
    succeeded('account_status', await rpc(client, 'account_status')),
  );
}

export async function accountDelete(client: Client): Promise<AccountDeleteResponse> {
  return accountDeleteResponseSchema.parse(
    succeeded('account_delete', await rpc(client, 'account_delete')),
  );
}

export interface OwnerRowCounts {
  readonly records: number;
  readonly change_log: number;
  readonly idempotency_receipts: number;
  readonly conflicts: number;
  readonly replicas: number;
  readonly account_deletions: number;
  readonly auth_users: number;
}

/** Rows of one owner in every owner table (and its sign-in account), counted in the database. */
export function ownerRowCounts(ownerId: string): OwnerRowCounts {
  if (!/^[0-9a-f-]{36}$/u.test(ownerId)) throw new Error('Not an owner id.');
  const [row] = queryDatabase<OwnerRowCounts & Record<string, unknown>>(
    `select
       (select count(*) from yelaxis_sync.records where owner_id = '${ownerId}')::int as records,
       (select count(*) from yelaxis_sync.change_log where owner_id = '${ownerId}')::int as change_log,
       (select count(*) from yelaxis_sync.idempotency_receipts where owner_id = '${ownerId}')::int
         as idempotency_receipts,
       (select count(*) from yelaxis_sync.conflicts where owner_id = '${ownerId}')::int as conflicts,
       (select count(*) from yelaxis_sync.replicas where owner_id = '${ownerId}')::int as replicas,
       (select count(*) from yelaxis_sync.account_deletions where owner_id = '${ownerId}')::int
         as account_deletions,
       (select count(*) from auth.users where id = '${ownerId}')::int as auth_users`,
  );
  if (row === undefined) throw new Error('No counts returned.');
  return row;
}

/** Audit entries of the auth service whose payload names this test user's id or email. */
export function auditEntriesNaming(user: Pick<TestUser, 'id' | 'email'>): number {
  if (!/^[0-9a-f-]{36}$/u.test(user.id) || !/^[a-z0-9.@-]+$/u.test(user.email)) {
    throw new Error('Not a test user.');
  }
  const [row] = queryDatabase<{ entries: number }>(
    `select count(*)::int as entries from auth.audit_log_entries
      where strpos(payload::text, '${user.id}') > 0
         or strpos(lower(payload::text), '${user.email}') > 0`,
  );
  if (row === undefined) throw new Error('No count returned.');
  return row.entries;
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit (JavaScript's default sort), no
 * whitespace, values serialized by JSON.stringify, undefined members dropped. The server's
 * `yelaxis_sync.canonical_json` produces the same text for every document.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const members = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${members.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

/** The base snapshot hash: lowercase hex SHA-256 of the UTF-8 canonical JSON of the document. */
export function documentHash(document: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
}

export type Document = Record<string, unknown>;

export function create(
  entityType: SyncEntityType,
  entityId: string,
  document: Document,
): Omit<PushOperation, 'sequence'> {
  return {
    operationId: randomUUID(),
    entityType,
    entityId,
    kind: 'create',
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document,
  };
}

export function update(
  entityType: SyncEntityType,
  entityId: string,
  base: { readonly revision: number; readonly document: Document },
  document: Document,
): Omit<PushOperation, 'sequence'> {
  return {
    operationId: randomUUID(),
    entityType,
    entityId,
    kind: 'update',
    baseServerRevision: base.revision,
    baseSnapshotHash: documentHash(base.document),
    document,
  };
}

export function remove(
  entityType: SyncEntityType,
  entityId: string,
  base: { readonly revision: number; readonly document: Document },
): Omit<PushOperation, 'sequence'> {
  return {
    operationId: randomUUID(),
    entityType,
    entityId,
    kind: 'delete',
    baseServerRevision: base.revision,
    baseSnapshotHash: documentHash(base.document),
    document: null,
  };
}

export function group(
  operations: readonly Omit<PushOperation, 'sequence'>[],
  options: { readonly replicaId?: string; readonly mutationGroupId?: string } = {},
): PushRequest {
  return {
    protocolVersion: 1,
    replicaId: options.replicaId ?? randomUUID(),
    mutationGroupId: options.mutationGroupId ?? randomUUID(),
    operations: operations.map((operation, sequence) => ({ ...operation, sequence })),
  };
}

/* ───────────────────────── Synthetic documents ───────────────────────── */

export const documents = {
  profile: (): Document => ({
    planningTimeZone: 'Europe/Berlin',
    weekStart: 'monday',
    timeFormat: '24_hour',
  }),
  axis: (title = 'Synthetic axis'): Document => ({ title, orderKey: 'a0', state: 'active' }),
  outcome: (title = 'Synthetic outcome'): Document => ({
    title,
    successDefinition: 'Synthetic success',
    progress: { mode: 'none' },
    orderKey: 'a0',
    state: 'active',
  }),
  milestone: (outcomeId: string): Document => ({
    title: 'Synthetic milestone',
    measurableCheckpoint: 'Synthetic checkpoint',
    outcomeId,
    orderKey: 'a0',
    state: 'active',
  }),
  project: (title = 'Synthetic project', extra: Document = {}): Document => ({
    title,
    orderKey: 'a0',
    state: 'idea',
    ...extra,
  }),
  action: (title = 'Synthetic action', extra: Document = {}): Document => ({
    title,
    captureOrigin: 'inbox',
    orderKey: 'a0',
    state: 'inbox',
    ...extra,
  }),
  milestoneAction: (milestoneId: string, actionId: string): Document => ({ milestoneId, actionId }),
  context: (): Document => ({
    category: 'boundaries',
    contextKey: 'protected_boundary',
    value: 'Synthetic boundary',
    source: 'user',
    sensitivity: 'sensitive',
    strength: 'hard',
    futureSharing: 'not_shared',
    state: 'active',
  }),
  constraint: (contextId?: string): Document => ({
    ...(contextId === undefined ? {} : { contextId }),
    constraintKind: 'capacity',
    strength: 'soft',
    value: { kind: 'capacity', period: 'day', minutes: 240 },
    state: 'active',
  }),
};
