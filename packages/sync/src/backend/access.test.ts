import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  accountStatus,
  anonClient,
  closeConflict,
  create,
  createTestUser,
  deleteTestUsers,
  documentHash,
  documents,
  group,
  mintAccessToken,
  openConflicts,
  pull,
  pullAll,
  pushAccepted,
  pushConflict,
  pushRejected,
  queryDatabase,
  rpc,
  tokenClient,
  update,
  type TestUser,
} from './stack';

const clientFunctions: readonly (readonly [string, Record<string, unknown> | undefined])[] = [
  ['sync_push', { request: {} }],
  ['sync_pull', { request: {} }],
  ['sync_open_conflicts', undefined],
  ['sync_close_conflict', { request: {} }],
  ['account_status', undefined],
  ['account_delete', undefined],
];

const syncTables = [
  'account_deletions',
  'change_log',
  'conflicts',
  'document_schemas',
  'idempotency_receipts',
  'records',
  'reference_map',
  'replicas',
];

const ownerTables = syncTables.filter(
  (table) => table !== 'document_schemas' && table !== 'reference_map',
);

describe('sync backend access control', () => {
  let owner: TestUser;
  let other: TestUser;
  const axisId = randomUUID();
  const actionId = randomUUID();
  const axisDocument = documents.axis('Owner axis');
  const actionDocument = documents.action('Owner action', { axisId });
  let ownerConflictId = '';

  beforeAll(async () => {
    owner = await createTestUser('access-owner');
    other = await createTestUser('access-other');
    await pushAccepted(
      owner.client,
      group([create('axis', axisId, axisDocument), create('action', actionId, actionDocument)]),
    );
    await pushAccepted(
      owner.client,
      group([
        update(
          'action',
          actionId,
          { revision: 1, document: actionDocument },
          { ...actionDocument, title: 'Owner edit' },
        ),
      ]),
    );
    const conflict = await pushConflict(
      owner.client,
      group([
        update(
          'action',
          actionId,
          { revision: 1, document: actionDocument },
          { ...actionDocument, title: 'Stale edit' },
        ),
      ]),
    );
    ownerConflictId = conflict.conflicts[0]?.conflictId ?? '';
  });

  afterAll(async () => {
    await deleteTestUsers();
  });

  it('enables and forces row level security on every sync table, with no client privilege', () => {
    const rows = queryDatabase<Record<string, unknown>>(
      `select c.relname as table_name,
              c.relrowsecurity as rls,
              c.relforcerowsecurity as forced,
              has_table_privilege('anon', c.oid,
                'select, insert, update, delete, truncate, references, trigger') as anon,
              has_table_privilege('authenticated', c.oid,
                'select, insert, update, delete, truncate, references, trigger') as authenticated,
              has_table_privilege('service_role', c.oid,
                'select, insert, update, delete, truncate, references, trigger') as service_role,
              exists (
                select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as acl
                 where acl.grantee = 0
              ) as public_grant
         from pg_class as c
         join pg_namespace as n on n.oid = c.relnamespace
        where n.nspname = 'yelaxis_sync' and c.relkind = 'r'
        order by c.relname`,
    );
    expect(rows.map((row) => row['table_name'])).toEqual(syncTables);
    for (const row of rows) {
      expect(row).toEqual({
        table_name: row['table_name'],
        rls: true,
        forced: true,
        anon: false,
        authenticated: false,
        service_role: false,
        public_grant: false,
      });
    }
    const [schema] = queryDatabase<Record<string, unknown>>(
      `select has_schema_privilege('anon', 'yelaxis_sync', 'usage') as anon,
              has_schema_privilege('authenticated', 'yelaxis_sync', 'usage') as authenticated,
              has_schema_privilege('service_role', 'yelaxis_sync', 'usage') as service_role`,
    );
    expect(schema).toEqual({ anon: false, authenticated: false, service_role: false });
  });

  it('binds every owner table to the authenticated subject through policies the implementation obeys', () => {
    const policies = queryDatabase<{
      table_name: string;
      roles: string;
      qual: string;
      check: string;
    }>(
      `select tablename as table_name, roles::text as roles, qual, with_check as check
         from pg_policies where schemaname = 'yelaxis_sync' order by tablename`,
    );
    for (const table of ownerTables) {
      const policy = policies.find((row) => row.table_name === table);
      expect(policy, table).toBeDefined();
      expect(policy?.roles).toBe('{yelaxis_sync_api}');
      expect(policy?.qual).toContain('request_owner()');
      expect(policy?.check).toContain('request_owner()');
    }
    const [role] = queryDatabase<Record<string, unknown>>(
      `select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'yelaxis_sync_api'`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    const implementations = queryDatabase<{ name: string; owner: string; definer: boolean }>(
      `select p.proname as name, pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer
         from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
        where n.nspname = 'yelaxis_sync'
          and p.proname in ('push', 'pull', 'open_conflicts', 'close_conflict', 'account_status',
                            'account_delete')
        order by p.proname`,
    );
    expect(implementations).toHaveLength(6);
    for (const implementation of implementations) {
      expect(implementation).toMatchObject({ owner: 'yelaxis_sync_api', definer: true });
    }
  });

  it('exposes only the six client functions, SECURITY DEFINER with an empty search path, to authenticated only', () => {
    const functions = queryDatabase<Record<string, unknown>>(
      `select p.proname as name,
              p.prosecdef as definer,
              p.proconfig::text as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service_role,
              exists (
                select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
                 where acl.grantee = 0
              ) as public_grant
         from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('sync_push', 'sync_pull', 'sync_open_conflicts', 'sync_close_conflict',
                            'account_status', 'account_delete')
        order by p.proname`,
    );
    expect(functions.map((row) => row['name'])).toEqual([
      'account_delete',
      'account_status',
      'sync_close_conflict',
      'sync_open_conflicts',
      'sync_pull',
      'sync_push',
    ]);
    for (const row of functions) {
      expect(row).toMatchObject({
        definer: true,
        config: '{"search_path=\\"\\""}',
        anon: false,
        authenticated: true,
        service_role: false,
        public_grant: false,
      });
    }
    const internal = queryDatabase<{ name: string }>(
      `select p.proname as name
         from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
        where n.nspname = 'yelaxis_sync'
          and (has_function_privilege('anon', p.oid, 'execute')
               or has_function_privilege('authenticated', p.oid, 'execute')
               or has_function_privilege('service_role', p.oid, 'execute'))`,
    );
    expect(internal).toEqual([]);
  });

  it('refuses every client function to the anonymous client', async () => {
    for (const [name, args] of clientFunctions) {
      const outcome = await rpc(anonClient(), name, args);
      expect(outcome, name).toMatchObject({ status: 401, code: '42501', data: null });
    }
  });

  it('keeps the sync schema, its tables, and its internal functions out of the API', async () => {
    for (const client of [anonClient(), owner.client]) {
      for (const table of syncTables) {
        const exposed = await client.schema('yelaxis_sync').from(table).select('*');
        expect(exposed.error?.code, table).toBe('PGRST106');
        expect(exposed.data).toBeNull();
        const inPublic = await client.from(table).select('*');
        expect(inPublic.error, table).not.toBeNull();
        expect(inPublic.data).toBeNull();
        const insert = await client
          .schema('yelaxis_sync')
          .from(table)
          .insert({ owner_id: owner.id });
        expect(insert.error, table).not.toBeNull();
      }
      const internal = await client.schema('yelaxis_sync').rpc('push', { request: {} });
      expect(internal.error?.code).toBe('PGRST106');
      const helper = await client.rpc('canonical_json', { value: {} });
      expect(helper.error).not.toBeNull();
      expect(helper.data).toBeNull();
    }
    const ownerRows = await pullAll(owner.client);
    expect(ownerRows.changes.map((change) => change.entityId).sort()).toEqual(
      [axisId, actionId].sort(),
    );
  });

  it('fails closed for a session without a subject', async () => {
    const client = tokenClient(mintAccessToken(owner.id, { claims: { sub: undefined } }));
    for (const [name, args] of clientFunctions) {
      const outcome = await rpc(client, name, args);
      expect(outcome, name).toMatchObject({ status: 403, code: '42501', data: null });
    }
  });

  it('surfaces an expired session as 401 and changes nothing', async () => {
    const expired = tokenClient(mintAccessToken(owner.id, { expiresInSeconds: -60 }));
    const outcome = await rpc(expired, 'sync_push', {
      request: group([create('axis', randomUUID(), documents.axis('Expired'))]),
    });
    expect(outcome).toMatchObject({ status: 401, code: 'PGRST303', data: null });
    const forged = tokenClient(`${mintAccessToken(owner.id).slice(0, -4)}AAAA`);
    const tampered = await rpc(forged, 'account_status');
    expect(tampered.status).toBe(401);
    expect((await accountStatus(owner.client)).recordCount).toBe(2);
  });

  it('never shows or changes another owner’s records, conflicts, or status', async () => {
    expect((await pullAll(other.client)).changes).toEqual([]);
    expect(await accountStatus(other.client)).toEqual({
      recordCounts: {},
      recordCount: 0,
      deletion: 'none',
    });
    expect(await openConflicts(other.client)).toEqual([]);

    const closing = await rpc(other.client, 'sync_close_conflict', {
      request: { conflictId: ownerConflictId, resolution: 'keep_remote' },
    });
    expect(closing).toMatchObject({ status: 404, code: 'PT404', data: null });
    expect((await openConflicts(owner.client)).map((conflict) => conflict.conflictId)).toEqual([
      ownerConflictId,
    ]);

    const edited = { ...actionDocument, title: 'Owner edit' };
    const foreignUpdate = await pushRejected(
      other.client,
      group([update('action', actionId, { revision: 2, document: edited }, actionDocument)]),
    );
    expect(foreignUpdate.code).toBe('invalid_payload');
    const foreignLink = await pushRejected(
      other.client,
      group([create('action', randomUUID(), documents.action('Foreign link', { axisId }))]),
    );
    expect(foreignLink.code).toBe('missing_reference');

    // The same id in another owner's namespace is that owner's own record.
    const sameId = await pushAccepted(
      other.client,
      group([create('action', actionId, documents.action('Other owner'))]),
    );
    expect(sameId.acknowledgments[0]?.serverRevision).toBe(1);
    const ownerAction = (await pullAll(owner.client)).changes.find(
      (change) => change.entityId === actionId,
    );
    expect(ownerAction).toMatchObject({ serverRevision: 2, document: edited });
    const otherChanges = (await pullAll(other.client)).changes;
    expect(otherChanges.map((change) => change.document?.['title'])).toEqual(['Other owner']);
  });

  it('ignores forged owners, timestamps, revisions, and cursors', async () => {
    const forgedOwner = await pushRejected(owner.client, {
      ...group([create('axis', randomUUID(), documents.axis())]),
      ownerId: other.id,
    });
    expect(forgedOwner.code).toBe('invalid_payload');
    const operation = create('axis', randomUUID(), documents.axis());
    const forgedOperationOwner = await pushRejected(owner.client, {
      ...group([operation]),
      operations: [{ ...operation, sequence: 0, ownerId: other.id }],
    });
    expect(forgedOperationOwner).toMatchObject({
      code: 'invalid_payload',
      operationId: operation.operationId,
    });
    for (const forged of [
      { ownerId: other.id },
      { owner_id: other.id },
      { createdAt: '2001-01-01T00:00:00Z' },
      { updatedAt: '2001-01-01T00:00:00Z' },
      { serverRevision: 40 },
    ]) {
      const response = await pushRejected(
        owner.client,
        group([create('axis', randomUUID(), { ...documents.axis(), ...forged })]),
      );
      expect(response.code, Object.keys(forged).join()).toBe('schema_mismatch');
    }

    const [timestamps] = queryDatabase<{ oldest_seconds: number }>(
      `select extract(epoch from now() - min(created_at))::int as oldest_seconds
         from yelaxis_sync.records where owner_id = '${owner.id}'`,
    );
    expect(timestamps?.oldest_seconds).toBeLessThan(600);

    const edited = { ...actionDocument, title: 'Owner edit' };
    const forgedRevision = await pushConflict(
      owner.client,
      group([
        {
          ...update('action', actionId, { revision: 2, document: edited }, actionDocument),
          baseServerRevision: 99,
        },
      ]),
    );
    expect(forgedRevision.conflicts[0]).toMatchObject({
      kind: 'stale_base',
      baseServerRevision: 99,
      remote: { serverRevision: 2, deleted: false, document: edited },
    });
    const real = await pushAccepted(
      owner.client,
      group([
        update('action', actionId, { revision: 2, document: edited }, { ...edited, title: 'Next' }),
      ]),
    );
    expect(real.acknowledgments[0]?.serverRevision).toBe(3);
    expect(documentHash(edited)).toMatch(/^[0-9a-f]{64}$/u);

    for (const cursor of [
      '9223372036854775807',
      '9999999999999999999',
      String(Number(real.cursor) + 1),
    ]) {
      expect(await pull(owner.client, cursor), cursor).toEqual({ status: 'cursor_expired' });
    }
    // Another owner's cursor positions nothing in this owner's data.
    const otherCursor = (await pullAll(other.client)).cursor;
    expect(otherCursor).not.toBe('0');
    expect(await pull(owner.client, otherCursor)).toEqual({ status: 'cursor_expired' });
  });

  it('accepts a real password session from the auth service', async () => {
    const user = await createTestUser('access-session');
    const signedIn = anonClient();
    const { error } = await signedIn.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    });
    expect(error).toBeNull();
    expect(await accountStatus(signedIn)).toEqual({
      recordCounts: {},
      recordCount: 0,
      deletion: 'none',
    });
    await pushAccepted(signedIn, group([create('axis', randomUUID(), documents.axis('Session'))]));
    expect((await accountStatus(user.client)).recordCount).toBe(1);
    await signedIn.auth.signOut();
  });

  it('lets only the owner close its conflicts', async () => {
    const open = await openConflicts(owner.client);
    expect(open.map((conflict) => conflict.conflictId)).toContain(ownerConflictId);
    for (const conflict of open) {
      const foreign = await rpc(other.client, 'sync_close_conflict', {
        request: { conflictId: conflict.conflictId, resolution: 'keep_local' },
      });
      expect(foreign).toMatchObject({ status: 404, code: 'PT404' });
      await closeConflict(owner.client, {
        conflictId: conflict.conflictId,
        resolution: 'keep_remote',
      });
    }
    expect(await openConflicts(owner.client)).toEqual([]);
  });
});
