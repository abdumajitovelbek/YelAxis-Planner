import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import {
  accountDelete,
  accountStatus,
  adminClient,
  anonClient,
  auditEntriesNaming,
  authUserExists,
  create,
  createTestUser,
  deleteTestUsers,
  documents,
  group,
  mintAccessToken,
  openConflicts,
  ownerRowCounts,
  passwordSignIn,
  pull,
  pullAll,
  pushAccepted,
  pushConflict,
  pushRejected,
  remove,
  rpc,
  signedInClient,
  tokenClaims,
  tokenClient,
  update,
} from './stack';

afterAll(async () => {
  await deleteTestUsers();
});

describe('account_status', () => {
  it('counts the live records of the owner by entity type', async () => {
    const user = await createTestUser('account-status');
    const deletedId = randomUUID();
    const action = documents.action();
    await pushAccepted(
      user.client,
      group([
        create('axis', randomUUID(), documents.axis()),
        create('axis', randomUUID(), documents.axis()),
        create('action', randomUUID(), action),
        create('action', randomUUID(), action),
        create('action', deletedId, action),
      ]),
    );
    await pushAccepted(
      user.client,
      group([remove('action', deletedId, { revision: 1, document: action })]),
    );
    expect(await accountStatus(user.client)).toEqual({
      recordCounts: { axis: 2, action: 2 },
      recordCount: 4,
      deletion: 'none',
    });
  });
});

describe('account_delete', () => {
  it('deletes every row of the owner and the sign-in account, idempotently, and nothing comes back', async () => {
    const user = await createTestUser('account-delete');
    const bystander = await createTestUser('account-bystander');
    const axisId = randomUUID();
    const axis = documents.axis();
    const accepted = group([
      create('axis', axisId, axis),
      create('action', randomUUID(), documents.action()),
    ]);
    await pushAccepted(user.client, accepted);
    await pushAccepted(
      user.client,
      group([
        update('axis', axisId, { revision: 1, document: axis }, { ...axis, title: 'Edited' }),
      ]),
    );
    await pushConflict(
      user.client,
      group([update('axis', axisId, { revision: 1, document: axis }, { ...axis, title: 'Stale' })]),
    );
    const { cursor } = await pullAll(user.client);
    await pushAccepted(bystander.client, group([create('axis', randomUUID(), documents.axis())]));

    const before = ownerRowCounts(user.id);
    for (const table of [
      'records',
      'change_log',
      'idempotency_receipts',
      'conflicts',
      'replicas',
    ] as const) {
      expect(before[table], table).toBeGreaterThan(0);
    }

    expect(await accountDelete(signedInClient(user.id))).toEqual({ status: 'deleted' });
    expect(ownerRowCounts(user.id)).toEqual({
      records: 0,
      change_log: 0,
      idempotency_receipts: 0,
      conflicts: 0,
      replicas: 0,
      account_deletions: 1,
      auth_users: 0,
    });
    expect(await authUserExists(user.id)).toBe(false);

    // The access token stays valid until it expires; every call now sees a deleted account. A
    // retry only confirms the deletion, so it needs no new sign-in.
    expect(await accountDelete(user.client)).toEqual({ status: 'already_deleted' });
    expect(await accountStatus(user.client)).toEqual({
      recordCounts: {},
      recordCount: 0,
      deletion: 'pending',
    });
    expect(
      await pushRejected(user.client, group([create('axis', randomUUID(), axis)])),
    ).toMatchObject({
      code: 'deletion_pending',
    });
    // A queued retry of an accepted group cannot recreate anything either.
    expect(await pushRejected(user.client, accepted)).toMatchObject({ code: 'deletion_pending' });
    expect(await pull(user.client, null)).toEqual({
      status: 'page',
      changes: [],
      nextCursor: '0',
      hasMore: false,
    });
    // Its change-log positions are gone with it, so an old checkpoint restarts reconciliation.
    expect(await pull(user.client, cursor)).toEqual({ status: 'cursor_expired' });
    expect(await openConflicts(user.client)).toEqual([]);
    expect(ownerRowCounts(user.id)).toMatchObject({ records: 0, change_log: 0, auth_users: 0 });

    // Nobody else's data is touched.
    expect((await accountStatus(bystander.client)).recordCount).toBe(1);
    expect(await authUserExists(bystander.id)).toBe(true);
  });

  it('refuses pushes for an account removed outside the app', async () => {
    const user = await createTestUser('account-removed');
    await pushAccepted(user.client, group([create('axis', randomUUID(), documents.axis())]));
    const { error } = await adminClient().auth.admin.deleteUser(user.id);
    expect(error).toBeNull();
    expect(ownerRowCounts(user.id)).toMatchObject({ records: 0, change_log: 0, auth_users: 0 });
    expect(
      await pushRejected(user.client, group([create('axis', randomUUID(), documents.axis())])),
    ).toMatchObject({ code: 'deletion_pending' });
    expect((await accountStatus(user.client)).deletion).toBe('pending');
    expect(await accountDelete(user.client)).toEqual({ status: 'already_deleted' });
    expect(ownerRowCounts(user.id)).toMatchObject({
      records: 0,
      account_deletions: 1,
      auth_users: 0,
    });
  });

  it('deletes the account only for a password sign-in from the last five minutes', async () => {
    const user = await createTestUser('account-recent');
    await pushAccepted(user.client, group([create('axis', randomUUID(), documents.axis())]));
    const now = Math.floor(Date.now() / 1000);
    const refused: readonly (readonly [string, Record<string, unknown>])[] = [
      ['no sign-in methods', {}],
      ['no methods in the list', { amr: [] }],
      ['methods that are not a list', { amr: { method: 'password', timestamp: now } }],
      ['a password sign-in over five minutes ago', passwordSignIn(301)],
      ['another method', { amr: [{ method: 'otp', timestamp: now }] }],
      [
        'a sign-in time that is not a number',
        { amr: [{ method: 'password', timestamp: `${now}` }] },
      ],
      ['a sign-in time in the future', { amr: [{ method: 'password', timestamp: now + 120 }] }],
    ];
    for (const [label, claims] of refused) {
      const session = tokenClient(mintAccessToken(user.id, { claims }));
      expect(await rpc(session, 'account_delete'), label).toEqual({
        data: null,
        status: 403,
        code: '42501',
        message: 'reauthentication_required',
      });
    }
    expect(ownerRowCounts(user.id)).toMatchObject({
      records: 1,
      account_deletions: 0,
      auth_users: 1,
    });
    expect((await accountStatus(user.client)).deletion).toBe('none');

    // A password sign-in among the session's methods counts until it is five minutes old.
    const [password] = passwordSignIn(290).amr;
    const recent = tokenClient(
      mintAccessToken(user.id, {
        claims: { amr: [{ method: 'totp', timestamp: now }, password] },
      }),
    );
    expect(await accountDelete(recent)).toEqual({ status: 'deleted' });
    expect(ownerRowCounts(user.id)).toMatchObject({
      records: 0,
      account_deletions: 1,
      auth_users: 0,
    });
  });

  it('accepts a real password session and removes the audit trail that names the account', async () => {
    const user = await createTestUser('account-session');
    const session = anonClient();
    const signedIn = await session.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    });
    expect(signedIn.error).toBeNull();
    const signInClaims = tokenClaims(signedIn.data.session?.access_token ?? '');
    const [method] = signInClaims['amr'] as readonly { method: string; timestamp: number }[];
    expect(method?.method).toBe('password');
    expect(Math.abs((method?.timestamp ?? 0) - Date.now() / 1000)).toBeLessThan(60);

    // A refreshed token keeps the time of the sign-in it came from.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const refreshed = await session.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    const refreshedClaims = tokenClaims(refreshed.data.session?.access_token ?? '');
    expect(refreshedClaims['iat']).not.toBe(signInClaims['iat']);
    expect(refreshedClaims['amr']).toEqual(signInClaims['amr']);

    await pushAccepted(session, group([create('axis', randomUUID(), documents.axis())]));
    expect(auditEntriesNaming(user)).toBeGreaterThan(0);
    expect(await accountDelete(session)).toEqual({ status: 'deleted' });
    expect(auditEntriesNaming(user)).toBe(0);
    expect(ownerRowCounts(user.id)).toMatchObject({ records: 0, auth_users: 0 });
  });
});
