import { describe, expect, it } from 'vitest';

import { FakeIdentityHost, MemoryStorage, sampleSeed } from './__fixtures__/fake-identity-host';
import {
  accountDatabaseName,
  defaultLocalDatabaseName,
  identityIndexKey,
  localDatabaseName,
  preservedIdentityIndexKey,
  readIdentityIndex,
  writeIdentityIndex,
} from './identity-index';
import { IdentityStoreError, IdentityStores, type IdentityStoreEvent } from './identity-stores';

const subject = 'd0000000-0000-4000-8000-0000000000a1';

function setup() {
  const host = new FakeIdentityHost();
  const storage = new MemoryStorage();
  let token = 0;
  const stores = new IdentityStores(host, storage, () => {
    token += 1;
    return `e0000000-0000-4000-8000-${token.toString(16).padStart(12, '0')}`;
  });
  const events: string[] = [];
  stores.subscribe((event: IdentityStoreEvent) => {
    events.push(event.type === 'ready' ? `ready ${event.store.opened.databaseName}` : 'switching');
  });
  return { host, storage, stores, events };
}

describe('identity stores', () => {
  it('opens the original local database at first launch and writes the index', async () => {
    const { host, storage, stores } = setup();
    const store = await stores.open();
    expect(store.opened.databaseName).toBe(defaultLocalDatabaseName);
    expect(store.identity.kind).toBe('local');
    expect(host.database(defaultLocalDatabaseName).identity?.id).toBe(store.identity.id);
    expect(readIdentityIndex(storage)).toEqual({
      version: 1,
      activeId: store.identity.id,
      identities: [
        { id: store.identity.id, kind: 'local', databaseName: defaultLocalDatabaseName },
      ],
    });
    // Opening again returns the same store.
    await expect(stores.open()).resolves.toBe(store);
  });

  it('keeps an existing local plan in its original database when the index is missing', async () => {
    const { host, storage, stores } = setup();
    const plan = host.localPlan(defaultLocalDatabaseName, { profile: 1, action: 3 });
    storage.setItem(identityIndexKey, '{"version":1,"broken":');
    const store = await stores.open();
    expect(store.identity.id).toBe(plan.identity?.id);
    expect(readIdentityIndex(storage)?.activeId).toBe(plan.identity?.id);
    // The unreadable index was kept before the new one replaced it.
    expect(storage.getItem(preservedIdentityIndexKey)).toBe('{"version":1,"broken":');
  });

  it('keeps the valid entries of a damaged index, and its text, before writing again', async () => {
    const { host, storage, stores } = setup();
    const plan = host.localPlan(localDatabaseName('e0000000-0000-4000-8000-0000000000ff'));
    const valid = {
      id: plan.identity!.id,
      kind: 'local',
      databaseName: plan.name,
    };
    const damaged = JSON.stringify({
      version: 1,
      activeId: plan.identity!.id,
      identities: [{ id: 'not-a-uuid', kind: 'local', databaseName: '/a.sqlite3' }, valid],
    });
    storage.setItem(identityIndexKey, damaged);
    const store = await stores.open();
    // The random-named plan stays reachable instead of the index starting over.
    expect(store.opened.databaseName).toBe(plan.name);
    expect(storage.getItem(preservedIdentityIndexKey)).toBe(damaged);
    expect(readIdentityIndex(storage)).toEqual({
      version: 1,
      activeId: plan.identity!.id,
      identities: [valid],
    });
  });

  it('never overwrites a damaged index it cannot keep, and works in memory instead', async () => {
    const { storage, stores } = setup();
    storage.setItem(preservedIdentityIndexKey, 'an earlier damaged index');
    storage.setItem(identityIndexKey, '[]');
    const store = await stores.open();
    expect(store.opened.databaseName).toBe(defaultLocalDatabaseName);
    expect(storage.getItem(identityIndexKey)).toBe('[]');
    expect(storage.getItem(preservedIdentityIndexKey)).toBe('an earlier damaged index');
    // The session still knows what it opened.
    expect(stores.index().activeId).toBe(store.identity.id);
    const fresh = await stores.prepare({ kind: 'new_local' });
    await stores.activate(fresh);
    expect(stores.index().identities.map(({ databaseName }) => databaseName)).toEqual([
      defaultLocalDatabaseName,
      fresh.opened.databaseName,
    ]);
    expect(storage.getItem(identityIndexKey)).toBe('[]');
  });

  it('returns to the local plan used most recently', async () => {
    const { host, stores } = setup();
    host.localPlan(defaultLocalDatabaseName);
    await stores.open();
    const second = await stores.prepare({ kind: 'new_local' });
    await stores.activate(second);
    const account = await stores.prepare({
      kind: 'account',
      accountSubjectId: subject,
      email: 'person@example.test',
      profileSeed: null,
    });
    await stores.activate(account);
    expect(stores.localFallback()?.databaseName).toBe(second.opened.databaseName);
    // Using the original plan again makes it the most recent one.
    const original = await stores.prepare({
      kind: 'entry',
      entry: stores.index().identities.find((entry) => entry.databaseName === '/yelaxis.sqlite3')!,
    });
    await stores.activate(original);
    await stores.activate(
      await stores.prepare({ kind: 'entry', entry: stores.findAccount(subject)! }),
    );
    expect(stores.localFallback()?.databaseName).toBe(defaultLocalDatabaseName);
  });

  it('never opens a copy that waits to be removed, and removes it at launch', async () => {
    const { host, storage, stores } = setup();
    host.localPlan(defaultLocalDatabaseName);
    await stores.open();
    const account = await stores.prepare({
      kind: 'account',
      accountSubjectId: subject,
      email: 'person@example.test',
      profileSeed: null,
    });
    await stores.activate(account);
    // The choice to delete the copy was written, and the tab closed before anything switched.
    stores.markForRemoval(account.entry);
    expect(stores.findAccount(subject)).toBeNull();
    await stores.close();

    host.busy.add(accountDatabaseName(subject));
    const restarted = new IdentityStores(
      host,
      storage,
      () => 'f0000000-0000-4000-8000-000000000001',
    );
    const store = await restarted.open();
    expect(store.opened.databaseName).toBe(defaultLocalDatabaseName);
    // Another tab holds the copy: it stays marked for the next launch.
    await restarted.removePending();
    expect(host.databases.has(accountDatabaseName(subject))).toBe(true);
    expect(readIdentityIndex(storage)?.identities).toContainEqual({
      ...account.entry,
      removalPending: true,
    });
    host.busy.clear();
    await restarted.removePending();
    expect(host.databases.has(accountDatabaseName(subject))).toBe(false);
    expect(readIdentityIndex(storage)?.identities.map(({ kind }) => kind)).toEqual(['local']);
  });

  it('opens a new local plan when the only plan waits to be removed', async () => {
    const { storage, stores } = setup();
    writeIdentityIndex(storage, {
      version: 1,
      activeId: subject,
      identities: [
        {
          id: subject,
          kind: 'account',
          databaseName: defaultLocalDatabaseName,
          accountSubjectId: subject,
          email: null,
          removalPending: true,
        },
      ],
    });
    const store = await stores.open();
    expect(store.identity.kind).toBe('local');
    expect(store.opened.databaseName).toBe(
      localDatabaseName('e0000000-0000-4000-8000-000000000001'),
    );
  });

  it('removes a marked copy before the account’s new copy takes its name', async () => {
    const { host, stores } = setup();
    host.localPlan(defaultLocalDatabaseName);
    await stores.open();
    const account = await stores.prepare({
      kind: 'account',
      accountSubjectId: subject,
      email: 'person@example.test',
      profileSeed: sampleSeed,
    });
    await stores.activate(account);
    stores.markForRemoval(account.entry);
    await stores.activate(await stores.prepare({ kind: 'entry', entry: stores.localFallback()! }));
    host.busy.add(accountDatabaseName(subject));
    await expect(
      stores.prepare({
        kind: 'account',
        accountSubjectId: subject,
        email: 'person@example.test',
        profileSeed: null,
      }),
    ).rejects.toMatchObject({ code: 'database_busy' });
    host.busy.clear();
    const fresh = await stores.prepare({
      kind: 'account',
      accountSubjectId: subject,
      email: 'person@example.test',
      profileSeed: null,
    });
    // A new, empty copy: nothing of the copy the person chose to delete.
    expect(host.database(accountDatabaseName(subject)).seededFrom).toBeNull();
    expect(host.events).toContain(`remove ${accountDatabaseName(subject)}`);
    await stores.discard(fresh);
  });

  it('reconciles the index with the identity a database holds', async () => {
    const { host, storage, stores } = setup();
    const plan = host.localPlan(defaultLocalDatabaseName, { profile: 1, action: 1 });
    writeIdentityIndex(storage, {
      version: 1,
      activeId: plan.identity!.id,
      identities: [
        { id: plan.identity!.id, kind: 'local', databaseName: defaultLocalDatabaseName },
      ],
    });
    // A link committed in the database, but the index write was interrupted.
    plan.identity = {
      ...plan.identity!,
      id: subject as never,
      kind: 'account',
      accountSubjectId: subject,
      linkStartedAt: plan.identity!.createdAt,
    };
    const store = await stores.open();
    expect(store.entry).toEqual({
      id: subject,
      kind: 'account',
      databaseName: defaultLocalDatabaseName,
      accountSubjectId: subject,
      email: null,
    });
    expect(readIdentityIndex(storage)?.identities).toEqual([store.entry]);
  });

  it('switches stores: closes the current one first and announces the change', async () => {
    const { host, storage, stores, events } = setup();
    host.localPlan(defaultLocalDatabaseName);
    await stores.open();
    const prepared = await stores.prepare({
      kind: 'account',
      accountSubjectId: subject,
      email: 'person@example.test',
      profileSeed: sampleSeed,
    });
    expect(prepared.opened.databaseName).toBe(accountDatabaseName(subject));
    expect(host.database(accountDatabaseName(subject)).seededFrom).toEqual(sampleSeed);
    await stores.activate(prepared);
    expect(events).toEqual(['switching', `ready ${accountDatabaseName(subject)}`]);
    expect(host.events).toEqual([
      `open ${defaultLocalDatabaseName}`,
      `open ${accountDatabaseName(subject)}`,
      `close ${defaultLocalDatabaseName}`,
    ]);
    expect(stores.current()).toBe(prepared);
    const index = readIdentityIndex(storage);
    expect(index?.activeId).toBe(subject);
    expect(index?.identities.map(({ kind }) => kind)).toEqual(['local', 'account']);
    expect(stores.findAccount(subject)).toMatchObject({ email: 'person@example.test' });
    expect(stores.localFallback()).toMatchObject({ databaseName: defaultLocalDatabaseName });
  });

  it('fails closed when another tab holds a database, changing nothing', async () => {
    const { host, storage, stores } = setup();
    host.busy.add(defaultLocalDatabaseName);
    await expect(stores.open()).rejects.toMatchObject({
      code: 'database_busy',
      message: 'The plan is already open in another tab.',
    });
    expect(storage.entries()).toEqual([]);

    host.busy.clear();
    await stores.open();
    host.busy.add(accountDatabaseName(subject));
    const before = readIdentityIndex(storage);
    await expect(
      stores.prepare({
        kind: 'account',
        accountSubjectId: subject,
        email: 'a@b.test',
        profileSeed: null,
      }),
    ).rejects.toBeInstanceOf(IdentityStoreError);
    expect(readIdentityIndex(storage)).toEqual(before);
    expect(stores.current()?.opened.databaseName).toBe(defaultLocalDatabaseName);
  });

  it('refuses to open a replica database that holds a different account', async () => {
    const { host, stores } = setup();
    await stores.open();
    host.database(accountDatabaseName(subject)).identity = {
      id: 'd0000000-0000-4000-8000-0000000000b2' as never,
      kind: 'account',
      accountSubjectId: 'd0000000-0000-4000-8000-0000000000b2',
      replicaId: null,
      linkId: null,
      linkSourceIdentityId: null,
      linkSourceProfileId: null,
      linkStartedAt: null,
      linkedAt: null,
      createdAt: '2026-10-01T09:00:00.000Z' as never,
    };
    await expect(
      stores.prepare({
        kind: 'account',
        accountSubjectId: subject,
        email: 'a@b.test',
        profileSeed: null,
      }),
    ).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(host.database(accountDatabaseName(subject)).open).toBe(false);
  });

  it('creates a new local identity in its own database', async () => {
    const { host, stores } = setup();
    await stores.open();
    const fresh = await stores.prepare({ kind: 'new_local' });
    expect(fresh.opened.databaseName).toBe(
      localDatabaseName('e0000000-0000-4000-8000-000000000001'),
    );
    expect(fresh.identity.kind).toBe('local');
    await stores.discard(fresh);
    expect(host.database(fresh.opened.databaseName).open).toBe(false);
  });

  it('recreates a cleared account replica empty instead of turning it into a local plan', async () => {
    const { storage, stores } = setup();
    writeIdentityIndex(storage, {
      version: 1,
      activeId: subject,
      identities: [
        {
          id: subject,
          kind: 'account',
          databaseName: accountDatabaseName(subject),
          accountSubjectId: subject,
          email: 'person@example.test',
        },
      ],
    });
    const store = await stores.open();
    expect(store.identity).toMatchObject({ kind: 'account', accountSubjectId: subject });
    expect(store.entry).toMatchObject({ email: 'person@example.test' });
  });

  it('reloads the open store after its owner changed and removes other stores', async () => {
    const { host, storage, stores, events } = setup();
    const plan = host.localPlan(defaultLocalDatabaseName);
    const store = await stores.open();
    await expect(stores.remove(store.entry)).rejects.toMatchObject({ code: 'identity_mismatch' });
    plan.identity = {
      ...plan.identity!,
      id: subject as never,
      kind: 'account',
      accountSubjectId: subject,
    };
    const reloaded = await stores.reload({ email: 'person@example.test' });
    expect(reloaded.entry).toMatchObject({ kind: 'account', email: 'person@example.test' });
    expect(events).toEqual(['switching', `ready ${defaultLocalDatabaseName}`]);

    const other = await stores.prepare({ kind: 'new_local' });
    await stores.activate(other);
    await stores.remove(reloaded.entry);
    expect(host.databases.has(defaultLocalDatabaseName)).toBe(false);
    expect(readIdentityIndex(storage)?.identities.map(({ databaseName }) => databaseName)).toEqual([
      other.opened.databaseName,
    ]);
  });

  it('keeps working in memory when the browser refuses storage', async () => {
    const { storage, stores } = setup();
    storage.refuse = true;
    const store = await stores.open();
    expect(store.opened.databaseName).toBe(defaultLocalDatabaseName);
    expect(stores.index().activeId).toBe(store.identity.id);
  });
});
