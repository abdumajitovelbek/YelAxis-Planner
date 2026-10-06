import type { createClient } from '@supabase/supabase-js';
import {
  accountDeleteResponseSchema,
  accountStatusResponseSchema,
  type AccountDeleteResponse,
  type AccountStatusResponse,
} from '@yelaxis/sync';

import type { KeyValueStorage } from './identity-index';

/*
 * The authentication adapter (ADR 0015 §§1–2): email and password through supabase-js with PKCE.
 * The session lives only in this site's localStorage under `yelaxis.auth`, never in SQLite,
 * service-worker caches, URLs, logs, or exports. Email and provider claims stay here; the rest of
 * the app sees only the account subject. Nothing here logs. supabase-js loads only when an account
 * is first used, so a local plan never pays for it.
 */

export const sessionStorageKey = 'yelaxis.auth';

/** The supabase-js client this build creates (no generated database types). */
export type AccountClient = ReturnType<typeof createClient>;

/** Resolves the one account client, loading supabase-js on first use. */
export type AccountClientLoader = () => Promise<AccountClient>;

export interface AccountConfiguration {
  readonly url: string;
  readonly anonKey: string;
}

/** Build-time public configuration; null for a local-only build. */
export function readAccountConfiguration(env: {
  readonly VITE_YELAXIS_SUPABASE_URL?: string | undefined;
  readonly VITE_YELAXIS_SUPABASE_ANON_KEY?: string | undefined;
}): AccountConfiguration | null {
  const url = env.VITE_YELAXIS_SUPABASE_URL?.trim() ?? '';
  const anonKey = env.VITE_YELAXIS_SUPABASE_ANON_KEY?.trim() ?? '';
  if (url.length === 0 || anonKey.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return { url, anonKey };
}

/**
 * Whether configuration names the standalone disposable test stack on its reserved local ports.
 * Other loopback/self-hosted services receive generic retention wording.
 */
export function isLocalTestStack(configuration: AccountConfiguration): boolean {
  try {
    const url = new URL(configuration.url);
    const port = Number(url.port);
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.protocol === 'http:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (configuration.url === url.origin || configuration.url === `${url.origin}/`) &&
      port >= 57420 &&
      port <= 57429
    );
  } catch {
    return false;
  }
}

export async function createAccountClient(
  configuration: AccountConfiguration,
  storage: Storage,
): Promise<AccountClient> {
  const supabase = await import('@supabase/supabase-js');
  return supabase.createClient(configuration.url, configuration.anonKey, {
    auth: {
      storageKey: sessionStorageKey,
      storage,
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}

/** One client for the app, created on first use; a failed load is retried next time. */
export function accountClientLoader(
  configuration: AccountConfiguration,
  storage: Storage,
): AccountClientLoader {
  let client: Promise<AccountClient> | null = null;
  return () => {
    client ??= createAccountClient(configuration, storage).catch((error: unknown) => {
      client = null;
      throw error;
    });
    return client;
  };
}

export type AuthFailure =
  | 'invalid_input'
  | 'invalid_credentials'
  | 'user_exists'
  | 'weak_password'
  | 'email_not_confirmed'
  | 'rate_limited'
  | 'offline'
  | 'unavailable';

export type AuthAttempt =
  | {
      readonly ok: true;
      readonly subjectId: string;
      readonly email: string | null;
      /** False when the account must be confirmed by email before it can sign in. */
      readonly hasSession: boolean;
    }
  | { readonly ok: false; readonly reason: AuthFailure };

export type BackendFailure = 'offline' | 'unauthorized' | 'unavailable' | 'invalid_response';

export type BackendResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: BackendFailure };

export interface SessionFacts {
  readonly subjectId: string;
  readonly email: string | null;
}

/** What the identity layer needs from the account service. */
export interface AccountBackend {
  signUp(email: string, password: string): Promise<AuthAttempt>;
  signIn(email: string, password: string): Promise<AuthAttempt>;
  /** Clears this device's session, even when the server cannot be reached. */
  signOut(): Promise<void>;
  session(): Promise<SessionFacts | null>;
  /**
   * Whether this site's storage holds a session, valid or not. It loads nothing and asks no server:
   * an expired session that `session()` no longer reports is still stored until it is cleared.
   */
  hasStoredSession(): boolean;
  /** `account_status()`: the account's record counts and deletion state. */
  accountStatus(): Promise<BackendResult<AccountStatusResponse>>;
  /** `account_delete()`: deletes every row of the account and the sign-in account. */
  deleteAccount(): Promise<BackendResult<AccountDeleteResponse>>;
}

interface AuthErrorLike {
  readonly name?: string;
  readonly code?: string | undefined;
  readonly status?: number | undefined;
}

interface AuthUserLike {
  readonly id: string;
  readonly email?: string | undefined;
}

function isOffline(online: () => boolean): boolean {
  try {
    return !online();
  } catch {
    return false;
  }
}

function authFailure(error: AuthErrorLike, online: () => boolean): AuthFailure {
  switch (error.code ?? '') {
    case 'invalid_credentials':
      return 'invalid_credentials';
    case 'user_already_exists':
    case 'email_exists':
      return 'user_exists';
    case 'weak_password':
      return 'weak_password';
    case 'email_not_confirmed':
      return 'email_not_confirmed';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'rate_limited';
    case 'validation_failed':
    case 'email_address_invalid':
      return 'invalid_input';
    default:
      if (error.name === 'AuthRetryableFetchError' || error.status === 0) {
        return isOffline(online) ? 'offline' : 'unavailable';
      }
      return error.status === 400 ? 'invalid_credentials' : 'unavailable';
  }
}

function backendFailure(status: number, online: () => boolean): BackendFailure {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 0) return isOffline(online) ? 'offline' : 'unavailable';
  return 'unavailable';
}

/** Removes every stored session value of this site, including the PKCE verifier. */
export function clearStoredSession(storage: KeyValueStorage | null): void {
  if (storage === null) return;
  for (const key of [
    sessionStorageKey,
    `${sessionStorageKey}-code-verifier`,
    `${sessionStorageKey}-user`,
  ]) {
    try {
      storage.removeItem(key);
    } catch {
      // Storage refused; the client's own sign-out already cleared what it could.
    }
  }
}

export interface SupabaseBackendOptions {
  readonly storage: KeyValueStorage | null;
  /** Defaults to `navigator.onLine`. */
  readonly online?: () => boolean;
}

export function createSupabaseAccountBackend(
  loadClient: AccountClientLoader,
  options: SupabaseBackendOptions,
): AccountBackend {
  const online = options.online ?? (() => navigator.onLine);

  const attempt = async (
    operation: (client: AccountClient) => Promise<{
      readonly data: { readonly user: AuthUserLike | null; readonly session: unknown };
      readonly error: AuthErrorLike | null;
    }>,
  ): Promise<AuthAttempt> => {
    try {
      const { data, error } = await operation(await loadClient());
      if (error !== null) return { ok: false, reason: authFailure(error, online) };
      if (data.user === null) return { ok: false, reason: 'unavailable' };
      return {
        ok: true,
        subjectId: data.user.id,
        email: data.user.email ?? null,
        hasSession: data.session !== null,
      };
    } catch {
      return { ok: false, reason: isOffline(online) ? 'offline' : 'unavailable' };
    }
  };

  const call = async <Value>(
    name: 'account_status' | 'account_delete',
    parse: (data: unknown) => Value | null,
  ): Promise<BackendResult<Value>> => {
    try {
      const client = await loadClient();
      const response = await client.rpc(name);
      if (response.error !== null) {
        return { ok: false, reason: backendFailure(response.status, online) };
      }
      const data: unknown = response.data;
      const value = parse(data);
      return value === null ? { ok: false, reason: 'invalid_response' } : { ok: true, value };
    } catch {
      return { ok: false, reason: isOffline(online) ? 'offline' : 'unavailable' };
    }
  };

  return {
    signUp: (email, password) => attempt((client) => client.auth.signUp({ email, password })),
    signIn: (email, password) =>
      attempt((client) => client.auth.signInWithPassword({ email, password })),
    async signOut() {
      try {
        const client = await loadClient();
        await client.auth.signOut({ scope: 'local' });
      } catch {
        // Offline, refused, or not loaded: the stored session is cleared below either way.
      }
      clearStoredSession(options.storage);
    },
    hasStoredSession() {
      if (options.storage === null) return false;
      try {
        return options.storage.getItem(sessionStorageKey) !== null;
      } catch {
        return false;
      }
    },
    async session() {
      try {
        // Without a stored session there is nothing to load the client for.
        if (options.storage !== null && options.storage.getItem(sessionStorageKey) === null) {
          return null;
        }
        const client = await loadClient();
        const { data } = await client.auth.getSession();
        const user = data.session?.user;
        return user === undefined ? null : { subjectId: user.id, email: user.email ?? null };
      } catch {
        return null;
      }
    },
    accountStatus: () =>
      call('account_status', (data) => {
        const parsed = accountStatusResponseSchema.safeParse(data);
        return parsed.success ? parsed.data : null;
      }),
    deleteAccount: () =>
      call('account_delete', (data) => {
        const parsed = accountDeleteResponseSchema.safeParse(data);
        return parsed.success ? parsed.data : null;
      }),
  };
}
