import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import {
  create,
  createTestUser,
  deleteTestUsers,
  documents,
  group,
  pull,
  pullAll,
  pullPage,
  pushAccepted,
  queryDatabase,
  remove,
  rpc,
  update,
} from './stack';

afterAll(async () => {
  await deleteTestUsers();
});

describe('sync_pull', () => {
  it('pages changes in cursor order, without gaps or duplicates, when timestamps are equal', async () => {
    const user = await createTestUser('pull-equal');
    const ids = Array.from({ length: 7 }, () => randomUUID());
    const accepted = await pushAccepted(
      user.client,
      group(ids.map((id) => create('axis', id, documents.axis()))),
    );
    // One transaction: every change carries the same server timestamp.
    const [timestamps] = queryDatabase<{ times: number; changes: number }>(
      `select count(distinct created_at)::int as times, count(*)::int as changes
         from yelaxis_sync.change_log where owner_id = '${user.id}'`,
    );
    expect(timestamps).toEqual({ times: 1, changes: 7 });

    const seen: string[] = [];
    const cursors: bigint[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await pullPage(user.client, cursor, 1);
      pages += 1;
      expect(page.changes.length).toBeLessThanOrEqual(1);
      for (const change of page.changes) {
        seen.push(change.entityId);
        cursors.push(BigInt(change.cursor));
        expect(page.nextCursor).toBe(change.cursor);
      }
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(pages).toBe(7);
    expect(seen).toEqual(ids);
    expect(cursors.every((value, index) => index === 0 || value > (cursors[index - 1] ?? 0n))).toBe(
      true,
    );
    expect(cursor).toBe(accepted.cursor);
  });

  it('issues strictly increasing cursors across groups', async () => {
    const user = await createTestUser('pull-monotonic');
    const cursors: bigint[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await pushAccepted(
        user.client,
        group([create('axis', randomUUID(), documents.axis())]),
      );
      cursors.push(BigInt(response.cursor));
    }
    expect(cursors.every((value, index) => index === 0 || value > (cursors[index - 1] ?? 0n))).toBe(
      true,
    );
    const { changes, cursor } = await pullAll(user.client);
    expect(changes.map((change) => BigInt(change.cursor))).toEqual(cursors);
    expect(BigInt(cursor)).toBe(cursors.at(-1));
  });

  it('never skips a change while groups commit concurrently with an advancing pull', async () => {
    const user = await createTestUser('pull-concurrent');
    const ids = Array.from({ length: 24 }, () => randomUUID());
    const seen = new Set<string>();
    let checkpoint: string | null = null;
    let pushing = true;
    const puller = (async () => {
      while (pushing) {
        const page = await pullPage(user.client, checkpoint, 5);
        for (const change of page.changes) seen.add(change.entityId);
        checkpoint = page.nextCursor;
      }
    })();
    await Promise.all(
      ids.map((id) => pushAccepted(user.client, group([create('axis', id, documents.axis())]))),
    );
    pushing = false;
    await puller;
    // Catch up from the last checkpoint only, as a client does.
    const rest = await pullAll(user.client, checkpoint);
    for (const change of rest.changes) seen.add(change.entityId);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('returns one entry per record with its latest state, tombstones included', async () => {
    const user = await createTestUser('pull-latest');
    const [x, y, z] = [randomUUID(), randomUUID(), randomUUID()];
    const document = documents.action('Original');
    await pushAccepted(
      user.client,
      group([
        create('action', x, document),
        create('action', y, document),
        create('action', z, document),
      ]),
    );
    const second = { ...document, title: 'Second' };
    const third = { ...document, title: 'Third' };
    await pushAccepted(
      user.client,
      group([update('action', x, { revision: 1, document }, second)]),
    );
    await pushAccepted(user.client, group([remove('action', y, { revision: 1, document })]));
    await pushAccepted(
      user.client,
      group([update('action', x, { revision: 2, document: second }, third)]),
    );
    const { changes } = await pullAll(user.client);
    expect(
      changes.map(({ entityId, serverRevision, deleted, document: current }) => ({
        entityId,
        serverRevision,
        deleted,
        document: current,
      })),
    ).toEqual([
      { entityId: z, serverRevision: 1, deleted: false, document },
      { entityId: y, serverRevision: 2, deleted: true, document: null },
      { entityId: x, serverRevision: 3, deleted: false, document: third },
    ]);
  });

  it('continues without gaps when records change between pages', async () => {
    const user = await createTestUser('pull-moving');
    const [a, b, c, d, e] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const axis = documents.axis();
    await pushAccepted(user.client, group([a, b, c, d].map((id) => create('axis', id, axis))));
    const first = await pullPage(user.client, null, 2);
    expect(first.changes.map((change) => change.entityId)).toEqual([a, b]);
    expect(first.hasMore).toBe(true);
    const edited = { ...axis, title: 'Edited between pages' };
    await pushAccepted(
      user.client,
      group([update('axis', a, { revision: 1, document: axis }, edited)]),
    );
    await pushAccepted(user.client, group([create('axis', e, axis)]));
    const second = await pullPage(user.client, first.nextCursor, 2);
    expect(second.changes.map((change) => change.entityId)).toEqual([c, d]);
    expect(second.hasMore).toBe(true);
    const third = await pullPage(user.client, second.nextCursor, 2);
    expect(third.changes.map((change) => [change.entityId, change.serverRevision])).toEqual([
      [a, 2],
      [e, 1],
    ]);
    expect(third.hasMore).toBe(false);
    expect(third.changes[0]?.document).toEqual(edited);
  });

  it('never returns another owner’s rows', async () => {
    const one = await createTestUser('pull-owner-one');
    const two = await createTestUser('pull-owner-two');
    const ones: string[] = [];
    const twos: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const oneId = randomUUID();
      const twoId = randomUUID();
      ones.push(oneId);
      twos.push(twoId);
      await pushAccepted(one.client, group([create('axis', oneId, documents.axis('One'))]));
      await pushAccepted(two.client, group([create('axis', twoId, documents.axis('Two'))]));
    }
    expect((await pullAll(one.client)).changes.map((change) => change.entityId)).toEqual(ones);
    expect((await pullAll(two.client)).changes.map((change) => change.entityId)).toEqual(twos);
    expect((await pullAll(one.client, null, 1)).changes.map((change) => change.entityId)).toEqual(
      ones,
    );
  });

  it('answers an empty page with the same cursor and restarts reconciliation for a cursor it never issued', async () => {
    const user = await createTestUser('pull-cursor');
    expect(await pull(user.client, null)).toEqual({
      status: 'page',
      changes: [],
      nextCursor: '0',
      hasMore: false,
    });
    const accepted = await pushAccepted(
      user.client,
      group([create('axis', randomUUID(), documents.axis())]),
    );
    expect(await pull(user.client, accepted.cursor)).toEqual({
      status: 'page',
      changes: [],
      nextCursor: accepted.cursor,
      hasMore: false,
    });
    expect((await pullPage(user.client, '0')).changes).toHaveLength(1);
    expect(await pull(user.client, String(BigInt(accepted.cursor) + 1n))).toEqual({
      status: 'cursor_expired',
    });
    // Reconciliation from the start always works.
    expect((await pullAll(user.client, null)).changes).toHaveLength(1);
  });

  it('expires any cursor that is not one of this owner’s positions, even below its head, and skips nothing', async () => {
    const user = await createTestUser('pull-foreign-cursor');
    const other = await createTestUser('pull-foreign-other');
    const [early, late] = [randomUUID(), randomUUID()];
    const first = await pushAccepted(
      user.client,
      group([create('axis', early, documents.axis('Early'))]),
    );
    const foreign = await pushAccepted(
      other.client,
      group([create('axis', randomUUID(), documents.axis('Other owner'))]),
    );
    const head = await pushAccepted(
      user.client,
      group([create('axis', late, documents.axis('Late'))]),
    );
    // Below this owner's head, but accepting it would skip the change before it.
    expect(BigInt(first.cursor)).toBeLessThan(BigInt(foreign.cursor));
    expect(BigInt(foreign.cursor)).toBeLessThan(BigInt(head.cursor));
    expect(await pull(user.client, foreign.cursor)).toEqual({ status: 'cursor_expired' });

    // Reconciliation from the start returns everything, and every issued cursor stays valid.
    const { changes, cursor } = await pullAll(user.client, null);
    expect(changes.map((change) => change.entityId)).toEqual([early, late]);
    expect(cursor).toBe(head.cursor);
    for (const issued of [first.cursor, head.cursor, '0']) {
      expect((await pull(user.client, issued)).status, issued).toBe('page');
    }
    const afterFirst = await pullPage(user.client, first.cursor);
    expect(afterFirst.changes.map((change) => change.entityId)).toEqual([late]);
  });

  it('records the replica checkpoint of each pulled page', async () => {
    const user = await createTestUser('pull-replica');
    const accepted = await pushAccepted(
      user.client,
      group([create('axis', randomUUID(), documents.axis())]),
    );
    const replicaId = randomUUID();
    await pull(user.client, null, 10, replicaId);
    const [replica] = queryDatabase<{ cursor: string }>(
      `select last_pulled_cursor::text as cursor from yelaxis_sync.replicas
        where owner_id = '${user.id}' and replica_id = '${replicaId}'`,
    );
    expect(replica?.cursor).toBe(accepted.cursor);
  });

  it('rejects malformed pull requests', async () => {
    const user = await createTestUser('pull-malformed');
    const valid = { protocolVersion: 1, replicaId: randomUUID(), afterCursor: null, limit: 10 };
    const requests: readonly unknown[] = [
      null,
      [],
      { ...valid, protocolVersion: 2 },
      { ...valid, replicaId: 'replica-1' },
      { ...valid, limit: 0 },
      { ...valid, limit: 501 },
      { ...valid, limit: 1.5 },
      { ...valid, limit: '10' },
      { ...valid, afterCursor: 5 },
      { ...valid, afterCursor: '-1' },
      { ...valid, afterCursor: 'abc' },
      { ...valid, afterCursor: '12345678901234567890' },
      { ...valid, extra: true },
      { protocolVersion: 1, replicaId: valid.replicaId, limit: 10 },
    ];
    for (const request of requests) {
      const outcome = await rpc(user.client, 'sync_pull', { request });
      expect(outcome, JSON.stringify(request)).toMatchObject({
        status: 400,
        code: '22023',
        data: null,
      });
    }
  });
});
