import {
  accountLinkPhase,
  nextAccountDeletionStatus,
  noAccountDeletion,
  type AccountApplication,
  type AccountApplicationResult,
  type AccountDeletionStatus,
  type AccountErrorCode,
  type AccountProfileSeed,
  type EncodedBundle,
  type PlanningIdentity,
  type StoredAccountBackup,
} from '@yelaxis/application';
import type { SqliteDriver } from '@yelaxis/data';
import type { EntityType, Instant, OwnerId, UUID } from '@yelaxis/domain';

import type { KeyValueStorage } from '../identity-index';
import type { OpenedPlanningStore, StoreHost } from '../identity-stores';

export const fixtureNow = '2026-10-01T09:00:00.000Z' as Instant;

/** One in-memory planning database: just the facts the identity layer reads and changes. */
export interface FakeDatabase {
  readonly name: string;
  identity: PlanningIdentity | null;
  /** The local identity a link retired (cancel restores it). */
  retired: PlanningIdentity | null;
  counts: Partial<Record<EntityType, number>>;
  sensitiveContextCount: number;
  profileSeed: AccountProfileSeed | null;
  /** The setup choices a seeded replica started from. */
  seededFrom: AccountProfileSeed | null;
  pendingOperations: number;
  openConflicts: number;
  lastSyncedAt: Instant | null;
  backup: StoredAccountBackup | null;
  deletion: AccountDeletionStatus;
  /** Initial upload acknowledged and a pull checkpoint present. */
  linkReady: boolean;
  open: boolean;
  /** Operations that fail: 'backup', 'link', 'export', 'cancel', 'detach', 'seed', 'facts'. */
  readonly failures: Set<string>;
}

export const sampleSeed: AccountProfileSeed = {
  preferredName: 'Sam',
  planningTimeZone: 'Asia/Tashkent',
  weekStart: 'monday',
  timeFormat: '24_hour',
  localeOverride: 'en',
  defaultsConfirmedAt: fixtureNow,
  onboarding: {
    status: 'completed',
    step: 'handbook',
    completedSteps: ['welcome', 'defaults', 'context', 'axes', 'outcome', 'week', 'handbook'],
    skippedSteps: [],
    completedAt: fixtureNow,
  },
  handbook: { status: 'skipped', lesson: 0, completedLessons: [] },
};

function emptyDatabase(name: string): FakeDatabase {
  return {
    name,
    identity: null,
    retired: null,
    counts: {},
    sensitiveContextCount: 0,
    profileSeed: null,
    seededFrom: null,
    pendingOperations: 0,
    openConflicts: 0,
    lastSyncedAt: null,
    backup: null,
    deletion: noAccountDeletion,
    linkReady: false,
    open: false,
    failures: new Set(),
  };
}

const ok = <Value>(value: Value): AccountApplicationResult<Value> => ({ ok: true, value });
const fail = <Value>(code: AccountErrorCode): AccountApplicationResult<Value> => ({
  ok: false,
  error: { code },
});

function total(database: FakeDatabase): number {
  return Object.values(database.counts).reduce((sum, count) => sum + count, 0);
}

function identity(id: string, overrides: Partial<PlanningIdentity> = {}): PlanningIdentity {
  return {
    id: id as OwnerId,
    kind: 'local',
    accountSubjectId: null,
    replicaId: null,
    linkId: null,
    linkSourceIdentityId: null,
    linkSourceProfileId: null,
    linkStartedAt: null,
    linkedAt: null,
    createdAt: fixtureNow,
    ...overrides,
  };
}

export function fakeAccountApplication(
  database: FakeDatabase,
  nextId: () => string,
): AccountApplication {
  const bundle = (): EncodedBundle => ({
    bundleId: nextId() as UUID,
    exportedAt: fixtureNow,
    recordCount: total(database),
    text: `{"format":"yelaxis.backup","records":${String(total(database))}}`,
    manifest: {
      sections: [],
      recordCounts: {},
      sourceMode: database.identity?.kind ?? 'local',
      containsSensitiveContext: database.sensitiveContextCount > 0,
      syncWasPending: database.identity?.kind === 'account' && database.pendingOperations > 0,
      dataSha256: 'a'.repeat(64),
    },
  });
  const linking = () =>
    database.identity !== null && accountLinkPhase(database.identity) === 'linking';

  return {
    identity: () => Promise.resolve(ok(database.identity)),
    ensureLocalIdentity: () => {
      database.identity ??= identity(nextId());
      return Promise.resolve(ok(database.identity));
    },
    createAccountReplica: ({ accountSubjectId, profileSeed }) => {
      const current = database.identity;
      if (current !== null) {
        return Promise.resolve(
          current.kind === 'account' && current.accountSubjectId === accountSubjectId
            ? ok(current)
            : fail('identity_exists'),
        );
      }
      if (profileSeed !== null && database.failures.has('seed')) {
        return Promise.resolve(fail('store_failed'));
      }
      database.identity = identity(accountSubjectId, {
        kind: 'account',
        accountSubjectId,
        replicaId: nextId() as UUID,
        linkedAt: fixtureNow,
      });
      if (profileSeed !== null) {
        database.seededFrom = profileSeed;
        database.counts = { profile: 1 };
        database.pendingOperations += 1;
      }
      return Promise.resolve(ok(database.identity));
    },
    recordCounts: () =>
      Promise.resolve(
        ok({
          byType: { ...database.counts },
          total: total(database),
          sensitiveContextCount: database.sensitiveContextCount,
        }),
      ),
    hasMeaningfulLocalData: () =>
      Promise.resolve(ok(total(database) - (database.counts.profile ?? 0) > 0)),
    profileSeed: () => Promise.resolve(ok(database.profileSeed)),
    exportBundle: () =>
      Promise.resolve(
        database.failures.has('export') ? fail('export_verification_failed') : ok(bundle()),
      ),
    createVerifiedBackup: () => {
      if (database.failures.has('backup'))
        return Promise.resolve(fail('backup_verification_failed'));
      const made = bundle();
      database.backup = {
        bundleId: made.bundleId,
        createdAt: fixtureNow,
        recordCount: made.recordCount,
        syncWasPending: made.manifest.syncWasPending,
        dataSha256: made.manifest.dataSha256,
        text: made.text,
      };
      return Promise.resolve(ok(database.backup));
    },
    latestBackup: () => Promise.resolve(ok(database.backup)),
    discardBackup: () => {
      if (!linking()) database.backup = null;
      return Promise.resolve(ok(undefined));
    },
    linkToAccount: ({ accountSubjectId, backupId }) => {
      const source = database.identity;
      if (database.failures.has('link')) return Promise.resolve(fail('store_failed'));
      if (source?.kind !== 'local') return Promise.resolve(fail('not_local'));
      if (backupId !== null && database.backup?.bundleId !== backupId) {
        return Promise.resolve(fail('backup_missing'));
      }
      const linkId = nextId() as UUID;
      const replicaId = nextId() as UUID;
      database.retired = source;
      database.identity = identity(accountSubjectId, {
        kind: 'account',
        accountSubjectId,
        replicaId,
        linkId,
        linkSourceIdentityId: source.id,
        linkStartedAt: fixtureNow,
      });
      database.pendingOperations += total(database);
      return Promise.resolve(
        ok({
          ownerId: accountSubjectId as OwnerId,
          sourceIdentityId: source.id,
          linkId,
          replicaId,
          groups: 1,
          operations: total(database),
        }),
      );
    },
    firstUploadProgress: () =>
      Promise.resolve(
        ok(
          linking()
            ? {
                totalOperations: total(database),
                acknowledgedOperations: database.linkReady ? total(database) : 0,
                totalGroups: 1,
                openGroups: database.linkReady ? 0 : 1,
                pullCheckpoint: database.linkReady,
              }
            : null,
        ),
      ),
    completeLinkIfReady: () => {
      const current = database.identity;
      if (current === null) return Promise.resolve(fail('identity_unavailable'));
      if (!linking())
        return Promise.resolve(ok({ linked: accountLinkPhase(current) === 'linked' }));
      if (!database.linkReady) return Promise.resolve(ok({ linked: false }));
      database.identity = { ...current, linkedAt: fixtureNow };
      database.retired = null;
      database.backup = null;
      return Promise.resolve(ok({ linked: true }));
    },
    cancelLink: () => {
      if (database.failures.has('cancel')) return Promise.resolve(fail('store_failed'));
      if (!linking() || database.retired === null) return Promise.resolve(fail('not_linking'));
      const restored = database.retired;
      database.identity = restored;
      database.retired = null;
      database.pendingOperations = 0;
      database.deletion = noAccountDeletion;
      database.backup = null;
      return Promise.resolve(ok({ ownerId: restored.id }));
    },
    syncFacts: () =>
      Promise.resolve(
        database.failures.has('facts')
          ? fail('store_failed')
          : ok({
              pendingOperations: database.pendingOperations,
              openConflicts: database.openConflicts,
              lastSyncedAt: database.lastSyncedAt,
            }),
      ),
    deletionStatus: () =>
      Promise.resolve(
        database.identity?.kind === 'account' ? ok(database.deletion) : fail('not_account'),
      ),
    recordDeletion: (event) => {
      if (database.identity?.kind !== 'account') return Promise.resolve(fail('not_account'));
      const next = nextAccountDeletionStatus(database.deletion, event, {
        now: fixtureNow,
        requestId: nextId() as UUID,
      });
      if (next === null) return Promise.resolve(fail('deletion_state_invalid'));
      database.deletion = next;
      return Promise.resolve(ok(next));
    },
    detachToLocalPlan: () => {
      if (database.failures.has('detach')) return Promise.resolve(fail('store_failed'));
      if (database.identity?.kind !== 'account') return Promise.resolve(fail('not_account'));
      if (database.deletion.phase !== 'confirmed') {
        return Promise.resolve(fail('deletion_not_confirmed'));
      }
      database.identity = identity(nextId());
      database.retired = null;
      database.deletion = noAccountDeletion;
      database.pendingOperations = 0;
      database.openConflicts = 0;
      return Promise.resolve(ok({ ownerId: database.identity.id }));
    },
  };
}

class BusyError extends Error {
  readonly code = 'database_busy';
  constructor() {
    super('The plan is already open in another tab.');
  }
}

/** Browser persistence stand-in: databases by name, each with its own lock and identity. */
export class FakeIdentityHost implements StoreHost {
  readonly databases = new Map<string, FakeDatabase>();
  /** Databases another tab holds open. */
  readonly busy = new Set<string>();
  readonly events: string[] = [];
  readonly #drivers = new WeakMap<object, FakeDatabase>();
  #counter = 0;

  readonly nextId = (): string => {
    this.#counter += 1;
    return `c0000000-0000-4000-8000-${this.#counter.toString(16).padStart(12, '0')}`;
  };

  database(name: string): FakeDatabase {
    let database = this.databases.get(name);
    if (database === undefined) {
      database = emptyDatabase(name);
      this.databases.set(name, database);
    }
    return database;
  }

  /** A local plan with setup defaults, and optionally planning records. */
  localPlan(
    name: string,
    counts: Partial<Record<EntityType, number>> = { profile: 1 },
    sensitiveContextCount = 0,
  ): FakeDatabase {
    const database = this.database(name);
    database.identity = identity(this.nextId());
    database.counts = counts;
    database.sensitiveContextCount = sensitiveContextCount;
    database.profileSeed = sampleSeed;
    return database;
  }

  open(databaseName: string): Promise<OpenedPlanningStore> {
    if (this.busy.has(databaseName)) return Promise.reject(new BusyError());
    const database = this.database(databaseName);
    if (database.open) return Promise.reject(new BusyError());
    database.open = true;
    this.events.push(`open ${databaseName}`);
    const driver = { databaseName } as unknown as SqliteDriver;
    this.#drivers.set(driver, database);
    return Promise.resolve({
      databaseName,
      driver,
      durability: 'persistent',
      close: () => {
        database.open = false;
        this.events.push(`close ${databaseName}`);
        return Promise.resolve();
      },
    });
  }

  remove(databaseName: string): Promise<void> {
    const database = this.databases.get(databaseName);
    if (this.busy.has(databaseName) || database?.open === true) {
      return Promise.reject(new BusyError());
    }
    this.databases.delete(databaseName);
    this.events.push(`remove ${databaseName}`);
    return Promise.resolve();
  }

  accounts(driver: SqliteDriver): AccountApplication {
    const database = this.#drivers.get(driver);
    if (database === undefined) throw new Error('Unknown fake driver');
    return fakeAccountApplication(database, this.nextId);
  }
}

/** A `localStorage` stand-in; `refuse` makes every access throw, like blocked site data. */
export class MemoryStorage implements KeyValueStorage {
  readonly #values = new Map<string, string>();
  refuse = false;

  getItem(key: string): string | null {
    if (this.refuse) throw new Error('Storage is blocked');
    return this.#values.get(key) ?? null;
  }

  removeItem(key: string): void {
    if (this.refuse) throw new Error('Storage is blocked');
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.refuse) throw new Error('Storage is blocked');
    this.#values.set(key, value);
  }

  entries(): [string, string][] {
    return [...this.#values.entries()];
  }
}
