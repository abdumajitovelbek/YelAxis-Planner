import type { EntityType, Instant, OwnerId, UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import { createAccountApplication, seededAccountProfileId } from './account-application';
import {
  accountLinkPhase,
  type AccountStorePort,
  type AccountStoreReader,
  type AccountTransaction,
  type CanonicalBundlePort,
  type PlanningIdentity,
  type PlanRecordCounts,
  type StoredAccountBackup,
} from './account-contracts';
import { noAccountDeletion } from './account-deletion';
import type { OutboxMutationGroup } from './contracts';

const now = '2026-10-01T09:00:00.000Z' as Instant;
const localId = '10000000-0000-4000-8000-000000000001' as OwnerId;

function identity(overrides: Partial<PlanningIdentity> = {}): PlanningIdentity {
  return {
    id: localId,
    kind: 'local',
    accountSubjectId: null,
    replicaId: null,
    linkId: null,
    linkSourceIdentityId: null,
    linkSourceProfileId: null,
    linkStartedAt: null,
    linkedAt: null,
    createdAt: now,
    ...overrides,
  };
}

function ids() {
  let counter = 0;
  return {
    next: () => {
      counter += 1;
      return `20000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as UUID;
    },
  };
}

const unused = (): never => {
  throw new Error('Not used by this test');
};

/** A store whose reads and transactions see a fixed identity list and record counts. */
function fakeStore(input: {
  readonly identities: readonly PlanningIdentity[];
  readonly counts?: PlanRecordCounts;
  readonly failTransactions?: boolean;
  /** Owners whose backups were cleared, in order. */
  readonly backupClears?: OwnerId[];
  /** The kept pre-link backup, if any. */
  readonly backup?: StoredAccountBackup;
  /** Counts the write transactions started. */
  readonly writes?: { count: number };
}): AccountStorePort {
  const capabilities: AccountTransaction = {
    identities: {
      listActive: () => Promise.resolve(input.identities),
      find: (id) => Promise.resolve(input.identities.find((item) => item.id === id) ?? null),
      insertLocal: unused,
      insertAccount: unused,
      retire: unused,
      restore: unused,
      markLinked: unused,
      remove: unused,
    },
    ownership: { remap: unused, remapProfile: unused },
    records: {
      counts: () =>
        Promise.resolve(input.counts ?? { byType: {}, total: 0, sensitiveContextCount: 0 }),
      snapshot: (ownerId) => Promise.resolve({ ownerId, records: [] }),
      supplement: () => Promise.resolve({ profileSettings: null, openConflicts: [] }),
    },
    sync: {
      facts: () => Promise.resolve({ pendingOperations: 0, openConflicts: 0, lastSyncedAt: null }),
      firstUpload: unused,
      appendGroup: unused,
      clear: unused,
    },
    deletion: { read: () => Promise.resolve(noAccountDeletion), write: unused, clear: unused },
    backups: {
      latest: () => Promise.resolve(input.backup ?? null),
      save: unused,
      clear: (ownerId) => {
        input.backupClears?.push(ownerId);
        return Promise.resolve();
      },
    },
    profiles: { readId: unused, readSeed: () => Promise.resolve(null), seed: unused },
  };
  return {
    read: <Result>(work: (reader: AccountStoreReader) => Promise<Result>) => work(capabilities),
    runInTransaction: <Result>(work: (transaction: AccountTransaction) => Promise<Result>) => {
      if (input.writes !== undefined) input.writes.count += 1;
      return input.failTransactions === true
        ? Promise.reject(new Error('Storage failed'))
        : work(capabilities);
    },
  };
}

function bundles(verified: boolean): CanonicalBundlePort {
  return {
    encode: (input) =>
      Promise.resolve({
        bundleId: input.bundleId,
        exportedAt: input.exportedAt,
        recordCount: input.snapshot.records.length,
        text: '{}',
        manifest: {
          sections: [],
          recordCounts: {},
          sourceMode: input.sourceMode,
          containsSensitiveContext: false,
          syncWasPending: input.syncWasPending,
          dataSha256: 'a'.repeat(64),
        },
      }),
    verify: () =>
      Promise.resolve(
        verified
          ? {
              ok: true,
              bundleId: '20000000-0000-4000-8000-000000000002' as UUID,
              recordCount: 0,
              manifest: {
                sections: [],
                recordCounts: {},
                sourceMode: 'local',
                containsSensitiveContext: false,
                syncWasPending: false,
                dataSha256: 'a'.repeat(64),
              },
            }
          : { ok: false, reason: 'digest_mismatch' },
      ),
  };
}

function application(store: AccountStorePort, verified = true) {
  return createAccountApplication({
    store,
    bundles: bundles(verified),
    clock: { now: () => now },
    ids: ids(),
    appVersion: 'test',
  });
}

/** One canonical record of the in-memory store. */
interface MemoryRecord {
  readonly type: EntityType;
  readonly id: UUID;
  readonly ownerId: OwnerId;
  readonly document: Readonly<Record<string, unknown>>;
}

interface MemoryState {
  identities: { readonly identity: PlanningIdentity; retired: boolean }[];
  records: MemoryRecord[];
  groups: OutboxMutationGroup[];
  /** Every Profile rename, in order. */
  readonly profileRenames: { readonly from: UUID; readonly to: UUID }[];
  /** Owners whose kept backup was cleared, in order. */
  readonly backupClears: OwnerId[];
}

/**
 * An in-memory store of identities, canonical records, and queued groups. Its remaps change
 * records as the SQLite store does: an owner remap moves them, a Profile remap renames the Profile
 * and every `profileId` that names it. A rejected transaction leaves the state unchanged.
 */
function memoryStore(initial: {
  readonly identities: readonly PlanningIdentity[];
  readonly records: readonly MemoryRecord[];
}) {
  let state: MemoryState = {
    identities: initial.identities.map((item) => ({ identity: item, retired: false })),
    records: [...initial.records],
    groups: [],
    profileRenames: [],
    backupClears: [],
  };
  const capabilities = (current: MemoryState): AccountTransaction => {
    const entry = (id: OwnerId) => {
      const found = current.identities.find((item) => item.identity.id === id);
      if (found === undefined) throw new Error('No such identity');
      return found;
    };
    const profileOf = (ownerId: OwnerId) =>
      current.records.find((record) => record.ownerId === ownerId && record.type === 'profile');
    return {
      identities: {
        listActive: () =>
          Promise.resolve(
            current.identities.filter((item) => !item.retired).map((item) => item.identity),
          ),
        find: (id) =>
          Promise.resolve(
            current.identities.find((item) => item.identity.id === id)?.identity ?? null,
          ),
        insertLocal: unused,
        insertAccount: ({ id, accountSubjectId, replicaId, at, link }) => {
          current.identities.push({
            identity: identity({
              id,
              kind: 'account',
              accountSubjectId,
              replicaId,
              linkId: link?.linkId ?? null,
              linkSourceIdentityId: link?.sourceIdentityId ?? null,
              linkSourceProfileId: link?.sourceProfileId ?? null,
              linkStartedAt: link === null ? null : at,
              linkedAt: link === null ? at : null,
              createdAt: at,
            }),
            retired: false,
          });
          return Promise.resolve();
        },
        retire: (id) => {
          entry(id).retired = true;
          return Promise.resolve();
        },
        restore: (id) => {
          entry(id).retired = false;
          return Promise.resolve();
        },
        markLinked: unused,
        remove: (id) => {
          current.identities = current.identities.filter((item) => item.identity.id !== id);
          return Promise.resolve();
        },
      },
      ownership: {
        remap: ({ from, to }) => {
          current.records = current.records.map((record) =>
            record.ownerId === from ? { ...record, ownerId: to } : record,
          );
          return Promise.resolve({ rowsByTable: {} });
        },
        remapProfile: ({ ownerId, from, to }) => {
          if (from === to || profileOf(ownerId)?.id !== from) {
            return Promise.reject(new Error('The owner has no such Profile'));
          }
          current.records = current.records.map((record) => {
            if (record.ownerId !== ownerId) return record;
            const named = record.document['profileId'] === from;
            return {
              ...record,
              id: record.type === 'profile' ? to : record.id,
              document: named ? { ...record.document, profileId: to } : record.document,
            };
          });
          current.profileRenames.push({ from, to });
          return Promise.resolve({ rowsByTable: {} });
        },
      },
      records: {
        counts: unused,
        snapshot: (ownerId) =>
          Promise.resolve({
            ownerId,
            records: current.records
              .filter((record) => record.ownerId === ownerId)
              .map(({ type, id, document }) => ({ type, id, localRevision: 1, document })),
          }),
        supplement: unused,
      },
      sync: {
        facts: unused,
        firstUpload: unused,
        appendGroup: (group) => {
          current.groups.push(group);
          return Promise.resolve();
        },
        clear: (ownerId) => {
          current.groups = current.groups.filter((group) => group.ownerId !== ownerId);
          return Promise.resolve();
        },
      },
      deletion: { read: unused, write: unused, clear: () => Promise.resolve() },
      backups: {
        latest: () => Promise.resolve(null),
        save: unused,
        clear: (ownerId) => {
          current.backupClears.push(ownerId);
          return Promise.resolve();
        },
      },
      profiles: {
        readId: (ownerId) => Promise.resolve(profileOf(ownerId)?.id ?? null),
        readSeed: unused,
        seed: unused,
      },
    };
  };
  const store: AccountStorePort = {
    read: <Result>(work: (reader: AccountStoreReader) => Promise<Result>) =>
      work(capabilities(state)),
    runInTransaction: async <Result>(
      work: (transaction: AccountTransaction) => Promise<Result>,
    ) => {
      const draft = structuredClone(state);
      const result = await work(capabilities(draft));
      state = draft;
      return result;
    },
  };
  return { store, state: () => state };
}

describe('account application', () => {
  it('names the link phase from the identity row', () => {
    expect(accountLinkPhase(identity())).toBe('local');
    expect(
      accountLinkPhase(identity({ kind: 'account', accountSubjectId: 's', linkStartedAt: now })),
    ).toBe('linking');
    expect(
      accountLinkPhase(
        identity({ kind: 'account', accountSubjectId: 's', linkStartedAt: now, linkedAt: now }),
      ),
    ).toBe('linked');
    expect(
      accountLinkPhase(identity({ kind: 'account', accountSubjectId: 's', linkedAt: now })),
    ).toBe('linked');
  });

  it('counts only records beyond the profile as meaningful', async () => {
    const onlyProfile = application(
      fakeStore({
        identities: [identity()],
        counts: { byType: { profile: 1 }, total: 1, sensitiveContextCount: 0 },
      }),
    );
    await expect(onlyProfile.hasMeaningfulLocalData()).resolves.toEqual({ ok: true, value: false });
    const withContext = application(
      fakeStore({
        identities: [identity()],
        counts: { byType: { profile: 1, context: 1 }, total: 2, sensitiveContextCount: 1 },
      }),
    );
    await expect(withContext.hasMeaningfulLocalData()).resolves.toEqual({ ok: true, value: true });
  });

  it('refuses an ambiguous or missing identity instead of guessing', async () => {
    const ambiguous = application(
      fakeStore({
        identities: [
          identity(),
          identity({ id: '10000000-0000-4000-8000-000000000002' as OwnerId }),
        ],
      }),
    );
    await expect(ambiguous.identity()).resolves.toEqual({
      ok: false,
      error: { code: 'identity_unavailable' },
    });
    await expect(ambiguous.recordCounts()).resolves.toEqual({
      ok: false,
      error: { code: 'identity_unavailable' },
    });
    const none = application(fakeStore({ identities: [] }));
    await expect(none.identity()).resolves.toEqual({ ok: true, value: null });
    await expect(
      none.linkToAccount({ accountSubjectId: localId, backupId: null }),
    ).resolves.toEqual({ ok: false, error: { code: 'identity_unavailable' } });
  });

  it('never offers an export or backup that does not verify', async () => {
    const store = fakeStore({ identities: [identity()] });
    await expect(application(store, false).exportBundle()).resolves.toEqual({
      ok: false,
      error: { code: 'export_verification_failed' },
    });
    await expect(application(store, false).createVerifiedBackup()).resolves.toEqual({
      ok: false,
      error: { code: 'backup_verification_failed' },
    });
  });

  it('reports a failed transaction as a rolled-back store failure', async () => {
    const failing = application(fakeStore({ identities: [identity()], failTransactions: true }));
    await expect(failing.ensureLocalIdentity()).resolves.toEqual({
      ok: false,
      error: { code: 'store_failed' },
    });
    await expect(failing.cancelLink()).resolves.toEqual({
      ok: false,
      error: { code: 'store_failed' },
    });
  });

  it('derives one profile id per account for a seeded replica', () => {
    const first = seededAccountProfileId('5a000000-0000-4000-8000-000000000001');
    expect(first).toBe(seededAccountProfileId('5a000000-0000-4000-8000-000000000001'));
    expect(first).not.toBe(seededAccountProfileId('5a000000-0000-4000-8000-000000000002'));
  });
});

describe('the account Profile id across a link', () => {
  const subject = '5a000000-0000-4000-8000-000000000001';
  const accountId = subject as OwnerId;
  const accountProfileId = seededAccountProfileId(subject);
  const localProfileId = '30000000-0000-4000-8000-000000000001' as UUID;

  /** A local plan: its Profile (when it has one), two records that name it, and an Action. */
  function localPlan(profileId: UUID | null) {
    const record = (type: EntityType, index: number, document: MemoryRecord['document']) => ({
      type,
      id: `30000000-0000-4000-8000-00000000000${String(index)}` as UUID,
      ownerId: localId,
      document,
    });
    const named =
      profileId === null
        ? []
        : [
            {
              type: 'profile' as const,
              id: profileId,
              ownerId: localId,
              document: { planningTimeZone: 'Asia/Tashkent', weekStart: 'monday' },
            },
            record('theme', 2, { profileId, month: '2026-10', text: 'Fewer things' }),
            record('review', 3, { profileId, reviewType: 'daily', periodKey: '2026-10-01' }),
          ];
    return memoryStore({
      identities: [identity()],
      records: [...named, record('action', 4, { title: 'Draft the outline' })],
    });
  }

  const uploaded = (groups: readonly OutboxMutationGroup[]) =>
    groups.flatMap((group) => group.operations.map(({ mutation }) => mutation));
  const profileIdsNamed = (state: MemoryState) =>
    state.records.flatMap((record) => [
      ...(record.type === 'profile' ? [record.id] : []),
      ...(typeof record.document['profileId'] === 'string' ? [record.document['profileId']] : []),
    ]);

  it('uploads the Profile and every record naming it under the account Profile id', async () => {
    const memory = localPlan(localProfileId);
    const linked = await application(memory.store).linkToAccount({
      accountSubjectId: subject,
      backupId: null,
    });

    expect(linked).toMatchObject({
      ok: true,
      value: { ownerId: accountId, sourceIdentityId: localId, groups: 1, operations: 4 },
    });
    expect(memory.state().profileRenames).toEqual([{ from: localProfileId, to: accountProfileId }]);
    const mutations = uploaded(memory.state().groups);
    // The Profile travels first, as a create of the account's own Profile id.
    expect(mutations[0]).toMatchObject({
      operation: 'create',
      ref: { type: 'profile', id: accountProfileId, ownerId: accountId },
      baseServerRevision: 0,
    });
    expect(mutations.filter((mutation) => mutation.ref.type === 'profile')).toHaveLength(1);
    // Every uploaded record that names a Profile names the account's.
    expect(
      mutations.flatMap((mutation) =>
        mutation.operation !== 'delete' && 'profileId' in mutation.document
          ? [mutation.document['profileId']]
          : [],
      ),
    ).toEqual([accountProfileId, accountProfileId]);
    expect(JSON.stringify(memory.state().groups)).not.toContain(localProfileId);
    expect(new Set(profileIdsNamed(memory.state()))).toEqual(new Set([accountProfileId]));
    // The link remembers the local Profile id, so cancel can give it back.
    await expect(application(memory.store).identity()).resolves.toMatchObject({
      ok: true,
      value: {
        id: accountId,
        linkSourceIdentityId: localId,
        linkSourceProfileId: localProfileId,
      },
    });
  });

  it('cancel gives the local Profile back its own id in every record', async () => {
    const memory = localPlan(localProfileId);
    const accounts = application(memory.store);
    await accounts.linkToAccount({ accountSubjectId: subject, backupId: null });

    await expect(accounts.cancelLink()).resolves.toEqual({ ok: true, value: { ownerId: localId } });

    expect(memory.state().profileRenames).toEqual([
      { from: localProfileId, to: accountProfileId },
      { from: accountProfileId, to: localProfileId },
    ]);
    expect(new Set(profileIdsNamed(memory.state()))).toEqual(new Set([localProfileId]));
    const { identities, records, groups } = memory.state();
    expect(JSON.stringify({ identities, records, groups })).not.toContain(accountProfileId);
    expect(memory.state().records.every((record) => record.ownerId === localId)).toBe(true);
    expect(memory.state().groups).toEqual([]);
    // The pre-link backup goes in the same transaction: no link needs it any more.
    expect(memory.state().backupClears).toEqual([accountId]);
    await expect(accounts.identity()).resolves.toMatchObject({
      ok: true,
      value: { id: localId, kind: 'local' },
    });
  });

  it('discards a kept backup that no link needs, and keeps the backup of a linking plan', async () => {
    const backup: StoredAccountBackup = {
      bundleId: '30000000-0000-4000-8000-0000000000b1' as UUID,
      createdAt: now,
      recordCount: 4,
      syncWasPending: false,
      dataSha256: 'b'.repeat(64),
      text: '{}',
    };
    const localClears: OwnerId[] = [];
    await expect(
      application(
        fakeStore({ identities: [identity()], backupClears: localClears, backup }),
      ).discardBackup(),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(localClears).toEqual([localId]);
    // Without a backup nothing is written (a launch starts no write).
    const writes = { count: 0 };
    await expect(
      application(fakeStore({ identities: [identity()], writes })).discardBackup(),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(writes.count).toBe(0);
    const linkingClears: OwnerId[] = [];
    const linking = identity({
      id: accountId,
      kind: 'account',
      accountSubjectId: subject,
      linkStartedAt: now,
    });
    await expect(
      application(
        fakeStore({ identities: [linking], backupClears: linkingClears, backup }),
      ).discardBackup(),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(linkingClears).toEqual([]);
  });

  it('keeps a Profile with the account Profile id, and links a plan without one', async () => {
    const already = localPlan(accountProfileId);
    const accounts = application(already.store);
    await expect(
      accounts.linkToAccount({ accountSubjectId: subject, backupId: null }),
    ).resolves.toMatchObject({ ok: true, value: { operations: 4 } });
    await expect(accounts.identity()).resolves.toMatchObject({
      ok: true,
      value: { linkSourceProfileId: null },
    });
    expect(uploaded(already.state().groups)[0]?.ref).toMatchObject({ id: accountProfileId });
    await expect(accounts.cancelLink()).resolves.toMatchObject({ ok: true });
    expect(already.state().profileRenames).toEqual([]);
    expect(new Set(profileIdsNamed(already.state()))).toEqual(new Set([accountProfileId]));

    const withoutProfile = localPlan(null);
    await expect(
      application(withoutProfile.store).linkToAccount({
        accountSubjectId: subject,
        backupId: null,
      }),
    ).resolves.toMatchObject({ ok: true, value: { operations: 1 } });
    expect(withoutProfile.state().profileRenames).toEqual([]);
    expect(uploaded(withoutProfile.state().groups).map((mutation) => mutation.ref.type)).toEqual([
      'action',
    ]);
  });

  it('links nothing when the Profile cannot be renamed', async () => {
    const memory = localPlan(localProfileId);
    const failing: AccountStorePort = {
      read: (work) => memory.store.read(work),
      runInTransaction: (work) =>
        memory.store.runInTransaction((transaction) =>
          work({
            ...transaction,
            ownership: {
              remap: (input) => transaction.ownership.remap(input),
              remapProfile: () => Promise.reject(new Error('Injected storage failure')),
            },
          }),
        ),
    };
    await expect(
      application(failing).linkToAccount({ accountSubjectId: subject, backupId: null }),
    ).resolves.toEqual({ ok: false, error: { code: 'store_failed' } });
    expect(memory.state().groups).toEqual([]);
    expect(new Set(profileIdsNamed(memory.state()))).toEqual(new Set([localProfileId]));
    await expect(application(memory.store).identity()).resolves.toMatchObject({
      ok: true,
      value: { id: localId, kind: 'local' },
    });
  });
});
