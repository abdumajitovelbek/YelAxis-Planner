/**
 * The Supabase transport through the real `supabase-js` client with an injected fetch (no network):
 * function names, the `request` argument, parsing of every answer, and failure mapping that never
 * carries server messages or content.
 */
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { PushRequest } from './protocol';
import {
  createSupabaseSyncTransport,
  syncRequestTimeoutMs,
  type SupabaseRpcClient,
} from './supabase-transport';

const url = 'http://127.0.0.1:55421';
const publicKey = 'public-test-key';
const replicaId = 'a1000000-0000-4000-8000-000000000001';
const groupId = 'a2000000-0000-4000-8000-000000000001';
const operationId = 'a3000000-0000-4000-8000-000000000001';
const entityId = 'a4000000-0000-4000-8000-000000000001';

const pushRequest: PushRequest = {
  protocolVersion: 1,
  replicaId,
  mutationGroupId: groupId,
  operations: [
    {
      operationId,
      sequence: 0,
      entityType: 'action',
      entityId,
      kind: 'create',
      baseServerRevision: 0,
      baseSnapshotHash: null,
      document: { title: 'A private title' },
    },
  ],
};

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function transportWith(answer: (captured: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const text = await request.text();
    const captured = {
      url: request.url,
      method: request.method,
      body: text === '' ? null : (JSON.parse(text) as unknown),
    };
    calls.push(captured);
    return answer(captured);
  };
  const client = createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchStub },
  });
  return { transport: createSupabaseSyncTransport(client), calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('Supabase sync transport', () => {
  it('pushes one group through sync_push with a single request argument and parses the answer', async () => {
    const accepted = {
      status: 'accepted',
      mutationGroupId: groupId,
      acknowledgments: [{ operationId, entityType: 'action', entityId, serverRevision: 1 }],
      cursor: '7',
    };
    const { transport, calls } = transportWith(() => json(200, accepted));
    await expect(transport.push(pushRequest)).resolves.toEqual({ ok: true, value: accepted });
    expect(calls).toEqual([
      { url: `${url}/rest/v1/rpc/sync_push`, method: 'POST', body: { request: pushRequest } },
    ]);
  });

  it('pulls, lists open conflicts, and closes one', async () => {
    const page = { status: 'page', changes: [], nextCursor: '0', hasMore: false };
    const { transport, calls } = transportWith(({ url: called }) => {
      if (called.endsWith('/sync_pull')) return json(200, page);
      if (called.endsWith('/sync_open_conflicts')) return json(200, []);
      return json(200, { closed: true });
    });
    await expect(
      transport.pull({ protocolVersion: 1, replicaId, afterCursor: null, limit: 200 }),
    ).resolves.toEqual({ ok: true, value: page });
    await expect(transport.openConflicts()).resolves.toEqual({ ok: true, value: [] });
    await expect(
      transport.closeConflict({ conflictId: groupId, resolution: 'keep_local' }),
    ).resolves.toEqual({ ok: true, value: { closed: true } });
    expect(calls.map((call) => call.url.slice(url.length))).toEqual([
      '/rest/v1/rpc/sync_pull',
      '/rest/v1/rpc/sync_open_conflicts',
      '/rest/v1/rpc/sync_close_conflict',
    ]);
    expect(calls[0]?.body).toEqual({
      request: { protocolVersion: 1, replicaId, afterCursor: null, limit: 200 },
    });
    expect(calls[2]?.body).toEqual({ request: { conflictId: groupId, resolution: 'keep_local' } });
  });

  it.each([
    [401, { code: 'PGRST301', message: 'JWT expired' }, { kind: 'auth_expired' }],
    [403, { code: '42501', message: 'permission denied' }, { kind: 'auth_expired' }],
    [503, { message: 'Service Unavailable' }, { kind: 'unavailable', status: 503 }],
    [
      404,
      { code: 'PGRST202', message: 'function not found' },
      { kind: 'unavailable', status: 404 },
    ],
    [
      500,
      { code: 'P0001', message: 'A private title leaked?' },
      { kind: 'unavailable', status: 500 },
    ],
  ])('maps HTTP %i to a content-free failure', async (status, body, failure) => {
    const { transport } = transportWith(() => json(status, body));
    const result = await transport.push(pushRequest);
    expect(result).toEqual({ ok: false, failure });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([
    [401, '42501'],
    [401, 'PGRST303'],
    [403, '42501'],
  ])('maps HTTP %i with %s to an expired session', async (status, code) => {
    const { transport } = transportWith(() => json(status, { code, message: 'denied' }));
    await expect(
      transport.pull({ protocolVersion: 1, replicaId, afterCursor: '3', limit: 10 }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'auth_expired' } });
  });

  it('turns a request the server cannot read into a rejection (dead letter, never retried)', async () => {
    const { transport } = transportWith(() => json(400, { code: '22023', message: 'bad input' }));
    await expect(transport.push(pushRequest)).resolves.toEqual({
      ok: true,
      value: { status: 'rejected', mutationGroupId: groupId, code: 'invalid_payload' },
    });
  });

  it('treats closing a candidate the server no longer knows as closed', async () => {
    const { transport } = transportWith(() => json(404, { code: 'PT404', message: 'unknown' }));
    await expect(
      transport.closeConflict({ conflictId: groupId, resolution: 'merge' }),
    ).resolves.toEqual({ ok: true, value: { closed: true } });
    const missing = transportWith(() => json(404, { code: 'PGRST202', message: 'no function' }));
    await expect(
      missing.transport.closeConflict({ conflictId: groupId, resolution: 'merge' }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'unavailable', status: 404 } });
  });

  it('aborts a call the server never answers and reports the server unavailable', async () => {
    let aborted = false;
    const client = createClient(url, publicKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        // A stalled request: it settles only when its signal aborts it.
        fetch: (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      },
    });
    const transport = createSupabaseSyncTransport(client, { timeoutMs: 20 });
    await expect(transport.push(pushRequest)).resolves.toEqual({
      ok: false,
      failure: { kind: 'unavailable' },
    });
    expect(aborted).toBe(true);
    await expect(
      transport.pull({ protocolVersion: 1, replicaId, afterCursor: null, limit: 10 }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'unavailable' } });
  });

  it('stops waiting at the timeout even for a client that ignores the abort signal', async () => {
    const stalled: SupabaseRpcClient = { rpc: () => new Promise(() => undefined) };
    const transport = createSupabaseSyncTransport(stalled, { timeoutMs: 20 });
    await expect(transport.openConflicts()).resolves.toEqual({
      ok: false,
      failure: { kind: 'unavailable' },
    });
    expect(syncRequestTimeoutMs).toBe(30_000);
  });

  it('maps a network failure to offline', async () => {
    const { transport } = transportWith(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(transport.push(pushRequest)).resolves.toEqual({
      ok: false,
      failure: { kind: 'offline' },
    });
  });

  it('refuses answers that do not match the protocol', async () => {
    const { transport } = transportWith(() => json(200, { status: 'accepted', extra: true }));
    await expect(transport.push(pushRequest)).resolves.toEqual({
      ok: false,
      failure: { kind: 'invalid_response' },
    });
    const text = transportWith(
      () => new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    await expect(text.transport.openConflicts()).resolves.toEqual({
      ok: false,
      failure: { kind: 'invalid_response' },
    });
  });

  it('never sends a request this device cannot form', async () => {
    const { transport, calls } = transportWith(() => json(200, {}));
    await expect(
      transport.pull({ protocolVersion: 1, replicaId, afterCursor: null, limit: 0 }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'invalid_response' } });
    expect(calls).toEqual([]);
  });
});
