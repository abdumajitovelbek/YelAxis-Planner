/**
 * `SyncTransport` over the Supabase database functions. Every call is one
 * `rpc` with a single JSON argument named `request`; every response is parsed with the protocol
 * schemas before use. Failures map to `offline`, `unavailable`, `auth_expired`, or
 * `invalid_response` and never carry server messages, planning content, or credentials. A call
 * the server does not answer in time is aborted and counts as `unavailable`, so a stalled request
 * never holds the coordinator's one cycle.
 */
import { z } from 'zod';

import {
  closeConflictRequestSchema,
  pullRequestSchema,
  pullResponseSchema,
  pushRequestSchema,
  pushResponseSchema,
  serverConflictSchema,
  type CloseConflictRequest,
  type PullRequest,
  type PushRequest,
  type SyncTransport,
  type TransportFailure,
  type TransportResult,
} from './protocol';

/** The function names the backend exposes through PostgREST. */
export const syncRpcNames = Object.freeze({
  push: 'sync_push',
  pull: 'sync_pull',
  openConflicts: 'sync_open_conflicts',
  closeConflict: 'sync_close_conflict',
});

/** The single named argument every function with a request takes. */
export const syncRpcArgument = 'request';

/** How long one call may wait for the server before it counts as unavailable. */
export const syncRequestTimeoutMs = 30_000;

interface RpcResponse {
  readonly data: unknown;
  readonly error: { readonly code?: string | null } | null;
  readonly status: number;
}

/** One started `rpc` call; a PostgREST builder also takes an abort signal (`.abortSignal`). */
export interface SupabaseRpcCall extends PromiseLike<RpcResponse> {
  abortSignal?(signal: AbortSignal): PromiseLike<RpcResponse>;
}

/** The part of a `SupabaseClient` the transport uses (`client.rpc`). */
export interface SupabaseRpcClient {
  rpc(fn: string, args?: Record<string, unknown>): SupabaseRpcCall;
}

export interface SupabaseSyncTransportOptions {
  /** Per-call timeout in milliseconds (default `syncRequestTimeoutMs`). */
  readonly timeoutMs?: number;
}

const openConflictsResponseSchema = z.array(serverConflictSchema).max(1_000);
const closeConflictResponseSchema = z.strictObject({ closed: z.literal(true) });

/** PostgREST JWT errors and permission failures mean the session has to be renewed. */
const authCodes = new Set(['PGRST301', 'PGRST302', 'PGRST303', '42501']);

function classify(status: number, code: string | null | undefined): TransportFailure {
  if (status === 0) return { kind: 'offline' };
  if (
    status === 401 ||
    status === 403 ||
    (code !== null && code !== undefined && authCodes.has(code))
  ) {
    return { kind: 'auth_expired' };
  }
  return { kind: 'unavailable', status };
}

/** An error status a function gives a protocol meaning to (null: classify it as usual). */
type ErrorAnswer<T> = (status: number, code: string | undefined) => TransportResult<T> | null;

/** `22023` (invalid parameter): the server could not read the request. */
const malformedRequest = '22023';
/** `PT404`: the conflict candidate does not exist (any more). */
const unknownConflict = 'PT404';

const timedOut = { ok: false, failure: { kind: 'unavailable' } } as const;

export function createSupabaseSyncTransport(
  client: SupabaseRpcClient,
  options: SupabaseSyncTransportOptions = {},
): SyncTransport {
  const timeoutMs = options.timeoutMs ?? syncRequestTimeoutMs;

  /** The call's response, or null when it took longer than the timeout (it is then aborted). */
  async function answer(
    fn: string,
    args: Record<string, unknown> | undefined,
  ): Promise<RpcResponse | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    try {
      const started = client.rpc(fn, args);
      const pending = started.abortSignal?.(controller.signal) ?? started;
      // The race also covers a client that ignores the signal: the cycle never waits longer.
      const response = await Promise.race([Promise.resolve(pending), late]);
      return controller.signal.aborted ? null : response;
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<T>(
    fn: string,
    args: Record<string, unknown> | undefined,
    schema: z.ZodType<T>,
    errorAnswer?: ErrorAnswer<T>,
  ): Promise<TransportResult<T>> {
    let response: RpcResponse | null;
    try {
      response = await answer(fn, args);
    } catch {
      return { ok: false, failure: { kind: 'offline' } };
    }
    if (response === null) return timedOut;
    if (response.status === 0 || response.status >= 400) {
      const code = response.error?.code ?? undefined;
      const answered = errorAnswer?.(response.status, code) ?? null;
      if (answered !== null) return answered;
      return { ok: false, failure: classify(response.status, code) };
    }
    // A success status whose body is not JSON is an answer this device cannot use.
    if (response.error !== null) return { ok: false, failure: { kind: 'invalid_response' } };
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) return { ok: false, failure: { kind: 'invalid_response' } };
    return { ok: true, value: parsed.data };
  }

  /** A request this device cannot form never leaves it (the server would refuse it anyway). */
  function prepared<T>(schema: z.ZodType<T>, request: unknown): Record<string, unknown> | null {
    const parsed = schema.safeParse(request);
    return parsed.success ? { [syncRpcArgument]: parsed.data } : null;
  }

  const unformed = { ok: false, failure: { kind: 'invalid_response' } } as const;

  return {
    async push(request: PushRequest) {
      const args = prepared(pushRequestSchema, request);
      if (args === null) return unformed;
      // A request the server cannot read is a client defect: the group waits for a person
      // (dead letter) instead of being retried blindly.
      return call(syncRpcNames.push, args, pushResponseSchema, (status, code) =>
        status === 400 && code === malformedRequest
          ? {
              ok: true,
              value: {
                status: 'rejected',
                mutationGroupId: request.mutationGroupId,
                code: 'invalid_payload',
              },
            }
          : null,
      );
    },
    async pull(request: PullRequest) {
      const args = prepared(pullRequestSchema, request);
      return args === null ? unformed : call(syncRpcNames.pull, args, pullResponseSchema);
    },
    openConflicts() {
      return call(syncRpcNames.openConflicts, undefined, openConflictsResponseSchema);
    },
    async closeConflict(request: CloseConflictRequest) {
      const args = prepared(closeConflictRequestSchema, request);
      if (args === null) return unformed;
      // Closing is idempotent: a candidate the server no longer knows is closed.
      return call(syncRpcNames.closeConflict, args, closeConflictResponseSchema, (status, code) =>
        status === 404 && code === unknownConflict
          ? { ok: true, value: { closed: true as const } }
          : null,
      );
    },
  };
}
