import { initialUploadLimits } from '@yelaxis/application';
import { syncLimits } from '@yelaxis/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryStorage } from './__fixtures__/fake-identity-host';
import { FakeSupabase } from './__fixtures__/fake-supabase';
import {
  accountClientLoader,
  clearStoredSession,
  createAccountClient,
  createSupabaseAccountBackend,
  isLocalTestStack,
  readAccountConfiguration,
  sessionStorageKey,
} from './supabase-backend';

const createClient = vi.hoisted(() => vi.fn(() => ({ synthetic: true })));
vi.mock('@supabase/supabase-js', () => ({ createClient }));

afterEach(() => {
  createClient.mockClear();
});

const email = 'person@example.test';
const password = 'synthetic-password';

function backendFor(fake: FakeSupabase, storage: MemoryStorage) {
  return createSupabaseAccountBackend(fake.loader(), {
    storage,
    online: () => fake.network !== 'offline',
  });
}

describe('account configuration', () => {
  it('is local-only without both public values or with an invalid URL', () => {
    expect(readAccountConfiguration({})).toBeNull();
    expect(
      readAccountConfiguration({ VITE_YELAXIS_SUPABASE_URL: 'http://127.0.0.1:55421' }),
    ).toBeNull();
    expect(readAccountConfiguration({ VITE_YELAXIS_SUPABASE_ANON_KEY: 'public-anon' })).toBeNull();
    expect(
      readAccountConfiguration({
        VITE_YELAXIS_SUPABASE_URL: 'not a url',
        VITE_YELAXIS_SUPABASE_ANON_KEY: 'public-anon',
      }),
    ).toBeNull();
    expect(
      readAccountConfiguration({
        VITE_YELAXIS_SUPABASE_URL: 'javascript:alert(1)',
        VITE_YELAXIS_SUPABASE_ANON_KEY: 'public-anon',
      }),
    ).toBeNull();
    expect(
      readAccountConfiguration({
        VITE_YELAXIS_SUPABASE_URL: ' http://127.0.0.1:55421 ',
        VITE_YELAXIS_SUPABASE_ANON_KEY: 'public-anon',
      }),
    ).toEqual({ url: 'http://127.0.0.1:55421', anonKey: 'public-anon' });
  });

  it('keeps the session in this site’s localStorage under yelaxis.auth with PKCE', async () => {
    const storage = {} as Storage;
    await createAccountClient({ url: 'http://127.0.0.1:55421', anonKey: 'public-anon' }, storage);
    expect(createClient).toHaveBeenCalledWith('http://127.0.0.1:55421', 'public-anon', {
      auth: {
        storageKey: 'yelaxis.auth',
        storage,
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  });

  it('creates one client on first use and retries a failed load', async () => {
    const load = accountClientLoader(
      { url: 'http://127.0.0.1:55421', anonKey: 'public-anon' },
      {} as Storage,
    );
    expect(createClient).not.toHaveBeenCalled();
    createClient.mockImplementationOnce(() => {
      throw new Error('Could not load');
    });
    await expect(load()).rejects.toThrow('Could not load');
    const first = await load();
    await expect(load()).resolves.toBe(first);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('mirrors the sync protocol limits in the initial upload plan', () => {
    expect(initialUploadLimits.operationsPerGroup).toBe(syncLimits.operationsPerGroup);
    expect(initialUploadLimits.documentBytes).toBe(syncLimits.documentBytes);
    expect(initialUploadLimits.groupDocumentBytes).toBeLessThan(syncLimits.requestBytes);
  });
});

describe('the local test stack', () => {
  it('is this machine on the stack’s own ports, and nothing else', () => {
    const at = (url: string) => isLocalTestStack({ url, anonKey: 'public-anon' });
    expect(at('http://127.0.0.1:57421')).toBe(true);
    expect(at('http://localhost:57421/')).toBe(true);
    expect(at('http://[::1]:57429')).toBe(true);
    expect(at('http://127.0.0.1:60123')).toBe(false);
    expect(at('https://127.0.0.1:57421')).toBe(false);
    expect(at('http://user:synthetic@127.0.0.1:57421')).toBe(false);
    expect(at('http://127.0.0.1:57421/rest/v1')).toBe(false);
    expect(at('http://127.0.0.1:57421/?')).toBe(false);
    expect(at('http://127.0.0.1:57421/#')).toBe(false);
    expect(at('http://127.0.0.1:54321')).toBe(false);
    expect(at('http://127.0.0.1')).toBe(false);
    expect(at('https://project.supabase.co')).toBe(false);
    expect(at('https://55421.example.test:55421')).toBe(false);
    expect(at('not a url')).toBe(false);
  });
});

describe('Supabase account backend', () => {
  it('does not load the account client to learn there is no session', async () => {
    const storage = new MemoryStorage();
    const fake = new FakeSupabase(storage);
    const backend = backendFor(fake, storage);
    await expect(backend.session()).resolves.toBeNull();
    expect(backend.hasStoredSession()).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('sees a stored session the client no longer reports, without loading anything', async () => {
    const storage = new MemoryStorage();
    const fake = new FakeSupabase(storage);
    fake.addUser(email, password);
    const backend = backendFor(fake, storage);
    await backend.signIn(email, password);
    fake.expiredOffline = true;
    await expect(backend.session()).resolves.toBeNull();
    const calls = fake.calls.length;
    expect(backend.hasStoredSession()).toBe(true);
    expect(fake.calls).toHaveLength(calls);
    storage.refuse = true;
    expect(backend.hasStoredSession()).toBe(false);
    expect(createSupabaseAccountBackend(fake.loader(), { storage: null }).hasStoredSession()).toBe(
      false,
    );
  });

  it('signs in and out, reporting only the account subject and email', async () => {
    const storage = new MemoryStorage();
    const fake = new FakeSupabase(storage);
    const subject = fake.addUser(email, password);
    const backend = backendFor(fake, storage);

    await expect(backend.signIn(email, password)).resolves.toEqual({
      ok: true,
      subjectId: subject,
      email,
      hasSession: true,
    });
    await expect(backend.session()).resolves.toEqual({ subjectId: subject, email });
    storage.setItem(`${sessionStorageKey}-code-verifier`, 'synthetic-verifier');
    await backend.signOut();
    expect(fake.calls).toContain('signOut:local');
    expect(storage.entries()).toEqual([]);
    await expect(backend.session()).resolves.toBeNull();
  });

  it('maps every refusal to a reason without content', async () => {
    const storage = new MemoryStorage();
    const fake = new FakeSupabase(storage);
    fake.addUser(email, password);
    const backend = backendFor(fake, storage);

    await expect(backend.signIn(email, 'wrong-password')).resolves.toEqual({
      ok: false,
      reason: 'invalid_credentials',
    });
    await expect(backend.signUp(email, password)).resolves.toEqual({
      ok: false,
      reason: 'user_exists',
    });
    await expect(backend.signUp('new@example.test', '123')).resolves.toEqual({
      ok: false,
      reason: 'weak_password',
    });
    fake.confirmEmail = true;
    await expect(backend.signUp('confirm@example.test', password)).resolves.toMatchObject({
      ok: true,
      hasSession: false,
    });
    fake.network = 'offline';
    await expect(backend.signIn(email, password)).resolves.toEqual({
      ok: false,
      reason: 'offline',
    });
    fake.network = 'down';
    await expect(backend.signIn(email, password)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('parses account_status and account_delete, and refuses an invalid answer', async () => {
    const storage = new MemoryStorage();
    const fake = new FakeSupabase(storage);
    fake.addUser(email, password);
    const backend = backendFor(fake, storage);

    await expect(backend.accountStatus()).resolves.toEqual({ ok: false, reason: 'unauthorized' });
    await backend.signIn(email, password);
    fake.status = { recordCounts: { action: 3, profile: 1 }, recordCount: 4, deletion: 'none' };
    await expect(backend.accountStatus()).resolves.toEqual({ ok: true, value: fake.status });
    fake.statusAnswer = 'invalid';
    await expect(backend.accountStatus()).resolves.toEqual({
      ok: false,
      reason: 'invalid_response',
    });
    fake.statusAnswer = 'server_error';
    await expect(backend.accountStatus()).resolves.toEqual({ ok: false, reason: 'unavailable' });
    fake.network = 'offline';
    await expect(backend.accountStatus()).resolves.toEqual({ ok: false, reason: 'offline' });
    fake.network = 'online';
    await expect(backend.deleteAccount()).resolves.toEqual({
      ok: true,
      value: { status: 'deleted' },
    });
  });

  it('clears the stored session even when the client cannot sign out', async () => {
    const storage = new MemoryStorage();
    storage.setItem(sessionStorageKey, '{"access_token":"synthetic-access"}');
    const throwing = {
      auth: {
        signOut: () => Promise.reject(new Error('offline')),
      },
    };
    const backend = createSupabaseAccountBackend(() => Promise.resolve(throwing as never), {
      storage,
    });
    await backend.signOut();
    expect(storage.getItem(sessionStorageKey)).toBeNull();
    storage.refuse = true;
    expect(() => clearStoredSession(storage)).not.toThrow();
  });
});
