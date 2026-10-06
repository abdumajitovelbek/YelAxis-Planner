import { describe, expect, it } from 'vitest';

import { MemoryStorage } from './__fixtures__/fake-identity-host';
import {
  accountDatabaseName,
  defaultLocalDatabaseName,
  emptyIdentityIndex,
  identityIndexKey,
  inspectIdentityIndex,
  isDatabaseName,
  isRemovalPending,
  localDatabaseName,
  parseIdentityIndex,
  preserveIdentityIndex,
  preservedIdentityIndexKey,
  readIdentityIndex,
  readStoredIdentityIndex,
  withEntry,
  withoutDatabase,
  writeIdentityIndex,
  type AccountIdentityEntry,
  type IdentityIndex,
} from './identity-index';

const localId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';

const index: IdentityIndex = {
  version: 1,
  activeId: accountId,
  identities: [
    { id: localId, kind: 'local', databaseName: defaultLocalDatabaseName },
    {
      id: accountId,
      kind: 'account',
      databaseName: accountDatabaseName(accountId),
      accountSubjectId: accountId,
      email: 'person@example.test',
    },
  ],
};

describe('identity index', () => {
  it('round-trips ids, kinds, database names, the active id, and an account email', () => {
    const storage = new MemoryStorage();
    expect(writeIdentityIndex(storage, index)).toBe(true);
    expect(readIdentityIndex(storage)).toEqual(index);
    expect(storage.entries().map(([key]) => key)).toEqual([identityIndexKey]);
  });

  it('names one database per identity and keeps the original local name', () => {
    expect(defaultLocalDatabaseName).toBe('/yelaxis.sqlite3');
    expect(localDatabaseName(localId)).toBe(
      `/yelaxis-local-${localId.replaceAll('-', '')}.sqlite3`,
    );
    expect(accountDatabaseName(accountId)).toBe(
      `/yelaxis-acct-${accountId.replaceAll('-', '')}.sqlite3`,
    );
    for (const name of [
      defaultLocalDatabaseName,
      localDatabaseName(localId),
      accountDatabaseName(accountId),
    ]) {
      expect(isDatabaseName(name)).toBe(true);
      // SQLite opens a database only when its name plus `-journal` fits the VFS's 64 characters.
      expect(`${name}-journal`.length).toBeLessThanOrEqual(64);
    }
    expect(isDatabaseName(`/yelaxis-account-${accountId}.sqlite3`)).toBe(false);
    expect(isDatabaseName('relative.sqlite3')).toBe(false);
    expect(isDatabaseName('/../escape.sqlite3')).toBe(false);
  });

  it('treats an index that is not a version-1 object as missing', () => {
    const cases: (string | null)[] = [
      null,
      '',
      '{not json',
      '[]',
      JSON.stringify({ ...index, version: 2 }),
      JSON.stringify({ version: 1, activeId: null }),
      JSON.stringify({ version: 1, activeId: null, identities: {} }),
    ];
    for (const text of cases) expect(parseIdentityIndex(text), String(text)).toBeNull();
    expect(inspectIdentityIndex(null)).toEqual({ index: null, intact: true });
    expect(inspectIdentityIndex('{not json')).toEqual({ index: null, intact: false });
    expect(inspectIdentityIndex(JSON.stringify(index))).toEqual({ index, intact: true });
  });

  it('keeps the valid entries when others are not valid, and says it was not intact', () => {
    const local = index.identities[0]!;
    const account = index.identities[1]!;
    const cases: { readonly text: string; readonly kept: IdentityIndex }[] = [
      {
        text: JSON.stringify({ ...index, activeId: '30000000-0000-4000-8000-000000000001' }),
        kept: { ...index, activeId: null },
      },
      { text: JSON.stringify({ ...index, extra: true }), kept: index },
      {
        text: JSON.stringify({ ...index, identities: [...index.identities, local] }),
        kept: index,
      },
      {
        text: JSON.stringify({
          ...index,
          identities: [
            { id: '30000000-0000-4000-8000-000000000001', kind: 'local', databaseName: 'plan.db' },
            local,
            { id: 'not-a-uuid', kind: 'local', databaseName: '/a.sqlite3' },
            { id: localId, kind: 'local', databaseName: '/b.sqlite3', note: 'planning text' },
            account,
          ],
        }),
        kept: index,
      },
      {
        text: JSON.stringify({
          ...index,
          identities: [local, { ...account, email: 'x'.repeat(321) }],
        }),
        kept: { version: 1, activeId: null, identities: [local] },
      },
      {
        // A removal flag is only ever `true`.
        text: JSON.stringify({ ...index, identities: [local, { ...account, removalPending: 1 }] }),
        kept: { version: 1, activeId: null, identities: [local] },
      },
    ];
    for (const { text, kept } of cases) {
      expect(inspectIdentityIndex(text), text).toEqual({ index: kept, intact: false });
    }
  });

  it('keeps at most 32 entries, never leaving out the active or the newest', () => {
    const entries = Array.from({ length: 34 }, (_, position) => ({
      id: `10000000-0000-4000-8000-${position.toString(16).padStart(12, '0')}`,
      kind: 'local' as const,
      databaseName: `/plan-${String(position)}.sqlite3`,
    }));
    const activeId = entries[1]!.id;
    const read = inspectIdentityIndex(
      JSON.stringify({ version: 1, activeId, identities: entries }),
    );
    expect(read.intact).toBe(false);
    expect(read.index?.identities.map(({ id }) => id)).toEqual([
      activeId,
      ...entries.slice(3).map(({ id }) => id),
    ]);

    const full: IdentityIndex = { version: 1, activeId, identities: entries.slice(0, 32) };
    const added = withEntry(full, entries[33]!, false);
    expect(added.identities).toHaveLength(32);
    expect(added.activeId).toBe(activeId);
    expect(added.identities.map(({ id }) => id)).toEqual([
      activeId,
      ...entries.slice(2, 32).map(({ id }) => id),
      entries[33]!.id,
    ]);
  });

  it('round-trips the removal flag of an account’s copy', () => {
    const account = index.identities[1] as AccountIdentityEntry;
    const flagged: IdentityIndex = {
      ...index,
      identities: [index.identities[0]!, { ...account, removalPending: true }],
    };
    expect(parseIdentityIndex(JSON.stringify(flagged))).toEqual(flagged);
    expect(isRemovalPending(flagged.identities[1]!)).toBe(true);
    expect(isRemovalPending(index.identities[1]!)).toBe(false);
    expect(isRemovalPending(index.identities[0]!)).toBe(false);
  });

  it('keeps one damaged index text, and never replaces a different one', () => {
    const storage = new MemoryStorage();
    storage.setItem(identityIndexKey, '{"version":1,"broken":');
    expect(readStoredIdentityIndex(storage)).toEqual({
      index: null,
      intact: false,
      text: '{"version":1,"broken":',
    });
    expect(preserveIdentityIndex(storage, '{"version":1,"broken":')).toBe(true);
    expect(storage.getItem(preservedIdentityIndexKey)).toBe('{"version":1,"broken":');
    // Keeping the same text again is fine; a different damaged text is never written over it.
    expect(preserveIdentityIndex(storage, '{"version":1,"broken":')).toBe(true);
    expect(preserveIdentityIndex(storage, '[]')).toBe(false);
    expect(storage.getItem(preservedIdentityIndexKey)).toBe('{"version":1,"broken":');
    storage.refuse = true;
    expect(preserveIdentityIndex(storage, '[]')).toBe(false);
    expect(readStoredIdentityIndex(storage)).toBeNull();
  });

  it('reads and writes defensively when storage refuses', () => {
    const storage = new MemoryStorage();
    writeIdentityIndex(storage, index);
    storage.refuse = true;
    expect(readIdentityIndex(storage)).toBeNull();
    expect(writeIdentityIndex(storage, emptyIdentityIndex)).toBe(false);
    expect(readIdentityIndex(null)).toBeNull();
    expect(writeIdentityIndex(null, index)).toBe(false);
  });

  it('replaces the entry of the same database and moves the active id with it', () => {
    const linked = withEntry(
      { version: 1, activeId: localId, identities: [index.identities[0]!] },
      {
        id: accountId,
        kind: 'account',
        databaseName: defaultLocalDatabaseName,
        accountSubjectId: accountId,
        email: null,
      },
      true,
    );
    expect(linked).toEqual({
      version: 1,
      activeId: accountId,
      identities: [
        {
          id: accountId,
          kind: 'account',
          databaseName: defaultLocalDatabaseName,
          accountSubjectId: accountId,
          email: null,
        },
      ],
    });
    const added = withEntry(linked, index.identities[0]! /* same database */, false);
    expect(added.activeId).toBeNull();
    expect(withoutDatabase(index, accountDatabaseName(accountId))).toEqual({
      version: 1,
      activeId: null,
      identities: [index.identities[0]],
    });
  });
});
