import type { AccountClient } from '../supabase-backend';
import type { AccountStatusResponse } from '@yelaxis/sync';

import type { KeyValueStorage } from '../identity-index';

type Network = 'online' | 'offline' | 'down';

interface FakeUser {
  readonly id: string;
  readonly email: string;
  password: string;
}

interface AuthError {
  readonly name: string;
  readonly code?: string;
  readonly status: number;
  readonly message: string;
}

/**
 * A Supabase client stand-in with the auth and RPC surface the account backend uses. Users,
 * sessions, and server answers are in memory; the session is stored under `yelaxis.auth` like the
 * real client, so tests can see it cleared. Every value is synthetic.
 */
export class FakeSupabase {
  readonly users = new Map<string, FakeUser>();
  readonly calls: string[] = [];
  network: Network = 'online';
  confirmEmail = false;
  status: AccountStatusResponse = { recordCounts: {}, recordCount: 0, deletion: 'none' };
  /** The next `account_delete` answer. */
  deleteAnswer: 'deleted' | 'already_deleted' | 'server_error' | 'unauthorized' = 'deleted';
  statusAnswer: 'ok' | 'server_error' | 'invalid' = 'ok';
  /**
   * Offline with an expired access token: like auth-js, `getSession()` reports no session while the
   * session stays stored under `yelaxis.auth`.
   */
  expiredOffline = false;
  #session: { readonly user: { readonly id: string; readonly email: string } } | null = null;
  #counter = 0;

  constructor(private readonly storage: KeyValueStorage) {}

  /** Adds an account and returns its subject. */
  addUser(email: string, password: string): string {
    this.#counter += 1;
    const id = `d0000000-0000-4000-8000-${this.#counter.toString(16).padStart(12, '0')}`;
    this.users.set(email, { id, email, password });
    return id;
  }

  get signedIn(): string | null {
    return this.#session?.user.id ?? null;
  }

  asClient(): AccountClient {
    return this as unknown as AccountClient;
  }

  /** The loader the backend takes; counts how often the client was requested. */
  loader(): () => Promise<AccountClient> {
    return () => {
      this.calls.push('load');
      return Promise.resolve(this.asClient());
    };
  }

  #networkError(): AuthError | null {
    if (this.network === 'online') return null;
    return { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };
  }

  #startSession(user: FakeUser): { readonly user: { id: string; email: string } } {
    this.#session = { user: { id: user.id, email: user.email } };
    this.storage.setItem(
      'yelaxis.auth',
      JSON.stringify({ access_token: 'synthetic-access', user: { id: user.id } }),
    );
    return this.#session;
  }

  readonly auth = {
    signUp: ({ email, password }: { email: string; password: string }) => {
      this.calls.push('signUp');
      const offline = this.#networkError();
      if (offline !== null) return Promise.resolve(this.#authFailure(offline));
      if (this.users.has(email)) {
        return Promise.resolve(
          this.#authFailure({
            name: 'AuthApiError',
            code: 'user_already_exists',
            status: 422,
            message: 'User already registered',
          }),
        );
      }
      if (password.length < 6) {
        return Promise.resolve(
          this.#authFailure({
            name: 'AuthWeakPasswordError',
            code: 'weak_password',
            status: 422,
            message: 'Password should be at least 6 characters.',
          }),
        );
      }
      this.addUser(email, password);
      const user = this.users.get(email)!;
      const session = this.confirmEmail ? null : this.#startSession(user);
      return Promise.resolve({
        data: { user: { id: user.id, email: user.email }, session },
        error: null,
      });
    },
    signInWithPassword: ({ email, password }: { email: string; password: string }) => {
      this.calls.push('signInWithPassword');
      const offline = this.#networkError();
      if (offline !== null) return Promise.resolve(this.#authFailure(offline));
      const user = this.users.get(email);
      if (user === undefined || user.password !== password) {
        return Promise.resolve(
          this.#authFailure({
            name: 'AuthApiError',
            code: 'invalid_credentials',
            status: 400,
            message: 'Invalid login credentials',
          }),
        );
      }
      const session = this.#startSession(user);
      return Promise.resolve({ data: { user: session.user, session }, error: null });
    },
    signOut: (options?: { scope?: string }) => {
      this.calls.push(`signOut:${options?.scope ?? 'global'}`);
      // Like the real client: the local session goes even when the server cannot be reached.
      this.#session = null;
      this.storage.removeItem('yelaxis.auth');
      return Promise.resolve({ error: this.#networkError() });
    },
    getSession: () =>
      Promise.resolve({
        data: { session: this.expiredOffline ? null : this.#session },
        error: null,
      }),
  };

  rpc(name: string): Promise<{ data: unknown; error: unknown; status: number }> {
    this.calls.push(`rpc:${name}`);
    if (this.network !== 'online') {
      return Promise.resolve({
        data: null,
        error: { message: 'TypeError: Failed to fetch', code: '' },
        status: 0,
      });
    }
    if (this.#session === null) {
      return Promise.resolve({
        data: null,
        error: { message: 'JWT expired', code: 'PGRST301' },
        status: 401,
      });
    }
    if (name === 'account_status') {
      if (this.statusAnswer === 'server_error') {
        return Promise.resolve({
          data: null,
          error: { message: 'Internal', code: 'XX000' },
          status: 500,
        });
      }
      return Promise.resolve({
        data: this.statusAnswer === 'invalid' ? { recordCount: 'many' } : this.status,
        error: null,
        status: 200,
      });
    }
    if (name === 'account_delete') {
      switch (this.deleteAnswer) {
        case 'server_error':
          return Promise.resolve({
            data: null,
            error: { message: 'Internal', code: 'XX000' },
            status: 500,
          });
        case 'unauthorized':
          return Promise.resolve({
            data: null,
            error: { message: 'JWT expired', code: 'PGRST301' },
            status: 401,
          });
        case 'deleted':
        case 'already_deleted': {
          const answer = this.deleteAnswer;
          for (const [email, user] of this.users) {
            if (user.id === this.#session.user.id) this.users.delete(email);
          }
          return Promise.resolve({ data: { status: answer }, error: null, status: 200 });
        }
      }
    }
    return Promise.resolve({
      data: null,
      error: { message: 'Not found', code: 'PGRST202' },
      status: 404,
    });
  }

  #authFailure(error: AuthError) {
    return { data: { user: null, session: null }, error };
  }
}
