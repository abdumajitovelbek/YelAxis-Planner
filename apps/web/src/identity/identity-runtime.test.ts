import { describe, expect, it } from 'vitest';

import { FakeIdentityHost, MemoryStorage } from './__fixtures__/fake-identity-host';
import { FakeSupabase } from './__fixtures__/fake-supabase';
import { defaultLocalDatabaseName } from './identity-index';
import { createIdentityRuntime } from './identity-runtime';
import { createSupabaseAccountBackend } from './supabase-backend';

describe('identity runtime', () => {
  it('is local-only without account configuration', async () => {
    const host = new FakeIdentityHost();
    const runtime = createIdentityRuntime({
      env: {},
      host,
      storage: new MemoryStorage() as unknown as Storage,
    });
    expect(runtime.account.configured).toBe(false);
    expect(runtime.accountClient).toBeNull();
    const store = await runtime.ready();
    expect(store.opened.databaseName).toBe(defaultLocalDatabaseName);
    await expect(runtime.ready()).resolves.toBe(store);
    await runtime.close();
    expect(host.database(defaultLocalDatabaseName).open).toBe(false);
  });

  it('retries opening after a failure, and clears a leftover session at launch', async () => {
    const host = new FakeIdentityHost();
    const storage = new MemoryStorage();
    const fake = new FakeSupabase(storage);
    fake.addUser('person@example.test', 'synthetic-password');
    await fake.auth.signInWithPassword({
      email: 'person@example.test',
      password: 'synthetic-password',
    });
    const runtime = createIdentityRuntime({
      host,
      storage: storage as unknown as Storage,
      backend: createSupabaseAccountBackend(fake.loader(), { storage }),
    });
    host.busy.add(defaultLocalDatabaseName);
    await expect(runtime.ready()).rejects.toMatchObject({ code: 'database_busy' });
    host.busy.clear();
    const store = await runtime.ready();
    expect(store.identity.kind).toBe('local');
    expect(runtime.account.configured).toBe(true);
    // The session had no open replica, so the launch signed it out.
    expect(fake.signedIn).toBeNull();
  });
});
