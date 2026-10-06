import {
  deriveNameBasedUuid,
  parseUUID,
  yelaxisDerivedIdNamespace,
  type Clock,
  type IdProvider,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import {
  accountLinkPhase,
  type AccountApplicationResult,
  type AccountDeletionEvent,
  type AccountDeletionStatus,
  type AccountErrorCode,
  type AccountLinkReceipt,
  type AccountProfileSeed,
  type AccountStorePort,
  type AccountStoreReader,
  type AccountSyncFacts,
  type CanonicalBundlePort,
  type EncodedBundle,
  type FirstUploadProgress,
  type PlanningIdentity,
  type PlanRecordCounts,
  type StoredAccountBackup,
} from './account-contracts';
import { nextAccountDeletionStatus } from './account-deletion';
import { planInitialUpload } from './account-upload-plan';

export interface AccountApplicationDependencies {
  readonly store: AccountStorePort;
  readonly bundles: CanonicalBundlePort;
  readonly clock: Clock;
  readonly ids: IdProvider;
  /** Informational version written into exported bundles. */
  readonly appVersion: string;
}

/**
 * Identity, linking, export, and account lifecycle use cases over one planning store.
 * Every write is one transaction; a failed step rolls the whole use case back.
 */
export interface AccountApplication {
  /** The store's identity: null when it has none yet, an error when it has more than one. */
  identity(): Promise<AccountApplicationResult<PlanningIdentity | null>>;
  /** The store's identity, creating a local one in a store that has none. */
  ensureLocalIdentity(): Promise<AccountApplicationResult<PlanningIdentity>>;
  /**
   * Makes an empty store the replica of an account, linked from its creation. A seed (for an
   * account with no records yet) creates its profile and queues the profile's upload. Opening the
   * same account's existing replica returns it unchanged.
   */
  createAccountReplica(input: {
    readonly accountSubjectId: string;
    readonly profileSeed: AccountProfileSeed | null;
  }): Promise<AccountApplicationResult<PlanningIdentity>>;
  recordCounts(): Promise<AccountApplicationResult<PlanRecordCounts>>;
  /** Any live planning record beyond the setup defaults (the identity and its profile). */
  hasMeaningfulLocalData(): Promise<AccountApplicationResult<boolean>>;
  profileSeed(): Promise<AccountApplicationResult<AccountProfileSeed | null>>;
  /** A verified canonical JSON bundle of every record, including queued local changes. */
  exportBundle(): Promise<AccountApplicationResult<EncodedBundle>>;
  /** Exports, verifies, and keeps the backup that precedes linking. */
  createVerifiedBackup(): Promise<AccountApplicationResult<StoredAccountBackup>>;
  latestBackup(): Promise<AccountApplicationResult<StoredAccountBackup | null>>;
  /**
   * Removes a kept pre-link backup that no link needs: after a link that failed, or at launch for
   * a local plan (a first-upload choice never survives a restart). The plan itself is unchanged.
   */
  discardBackup(): Promise<AccountApplicationResult<void>>;
  /**
   * One transaction: create the linking account identity, remap every owned row to it, give the
   * Profile the account's Profile id, enable sync, and queue the initial upload. `backupId` names
   * the verified backup that must still be kept.
   */
  linkToAccount(input: {
    readonly accountSubjectId: string;
    readonly backupId: UUID | null;
  }): Promise<AccountApplicationResult<AccountLinkReceipt>>;
  /** Progress of a link's initial upload, or null when the store is not linking. */
  firstUploadProgress(): Promise<AccountApplicationResult<FirstUploadProgress | null>>;
  /** Marks the store linked once every initial group is acknowledged and a pull checkpoint exists. */
  completeLinkIfReady(): Promise<AccountApplicationResult<{ readonly linked: boolean }>>;
  /**
   * Before linkage: reverse the remap, including the Profile id, and keep every record, including
   * later edits. The pre-link backup is removed in the same transaction: no link needs it.
   */
  cancelLink(): Promise<AccountApplicationResult<{ readonly ownerId: OwnerId }>>;
  syncFacts(): Promise<AccountApplicationResult<AccountSyncFacts>>;
  deletionStatus(): Promise<AccountApplicationResult<AccountDeletionStatus>>;
  recordDeletion(
    event: AccountDeletionEvent,
  ): Promise<AccountApplicationResult<AccountDeletionStatus>>;
  /** After confirmed account deletion: keep this device's copy as a new local-only plan. */
  detachToLocalPlan(): Promise<AccountApplicationResult<{ readonly ownerId: OwnerId }>>;
}

/** Aborts a use case (and rolls its transaction back) with a specific error. */
class AccountRuleError extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(code);
    this.name = 'AccountRuleError';
  }
}

type IdentityReader = Pick<AccountStoreReader['identities'], 'listActive'>;

async function singleIdentity(identities: IdentityReader): Promise<PlanningIdentity> {
  const active = await identities.listActive();
  const identity = active[0];
  if (active.length !== 1 || identity === undefined) {
    throw new AccountRuleError('identity_unavailable');
  }
  return identity;
}

function accountSubject(value: string): OwnerId {
  const parsed = parseUUID(value);
  if (!parsed.ok || parsed.value !== value) throw new AccountRuleError('invalid_account_subject');
  return parsed.value;
}

/**
 * The Profile id of an account: the same on every device and every link of that account. A seeded
 * replica creates its Profile with it, and linking renames the local Profile to it, so replicas
 * meet as one Profile record: an identical one is accepted as is, and a different one is an
 * explicit same-id create collision, never a second Profile.
 */
export function seededAccountProfileId(accountSubjectId: string): UUID {
  return deriveNameBasedUuid(yelaxisDerivedIdNamespace, `account-profile:${accountSubjectId}`);
}

export function createAccountApplication(
  dependencies: AccountApplicationDependencies,
): AccountApplication {
  const { store, bundles, clock, ids } = dependencies;

  const run = async <Value>(
    work: () => Promise<Value>,
  ): Promise<AccountApplicationResult<Value>> => {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      return {
        ok: false,
        error: { code: error instanceof AccountRuleError ? error.code : 'store_failed' },
      };
    }
  };

  const exportWithOwner = async (): Promise<{
    readonly ownerId: OwnerId;
    readonly bundle: EncodedBundle;
  }> => {
    const exportedAt = clock.now();
    const bundleId = ids.next();
    const captured = await store.runInTransaction(async (transaction) => {
      const identity = await singleIdentity(transaction.identities);
      const snapshot = await transaction.records.snapshot(identity.id);
      const supplement = await transaction.records.supplement(identity.id);
      const facts =
        identity.kind === 'account' ? await transaction.sync.facts(identity.id) : undefined;
      return {
        identity,
        snapshot,
        supplement,
        syncWasPending: (facts?.pendingOperations ?? 0) > 0,
      };
    });
    const bundle = await bundles.encode({
      snapshot: captured.snapshot,
      supplement: captured.supplement,
      bundleId,
      exportedAt,
      appVersion: dependencies.appVersion,
      sourceMode: captured.identity.kind,
      syncWasPending: captured.syncWasPending,
    });
    const verification = await bundles.verify(bundle.text);
    if (
      !verification.ok ||
      verification.bundleId !== bundleId ||
      verification.recordCount !== captured.snapshot.records.length ||
      verification.manifest.dataSha256 !== bundle.manifest.dataSha256
    ) {
      throw new AccountRuleError('export_verification_failed');
    }
    return { ownerId: captured.identity.id, bundle };
  };

  return {
    identity: () =>
      run(() =>
        store.read(async ({ identities }) => {
          const active = await identities.listActive();
          if (active.length > 1) throw new AccountRuleError('identity_unavailable');
          return active[0] ?? null;
        }),
      ),

    ensureLocalIdentity: () =>
      run(() =>
        store.runInTransaction(async ({ identities }) => {
          const active = await identities.listActive();
          if (active.length > 1) throw new AccountRuleError('identity_unavailable');
          const existing = active[0];
          if (existing !== undefined) return existing;
          const id = ids.next();
          await identities.insertLocal({ id, at: clock.now() });
          return required(await identities.find(id));
        }),
      ),

    createAccountReplica: ({ accountSubjectId, profileSeed }) =>
      run(() => {
        const id = accountSubject(accountSubjectId);
        const now = clock.now();
        return store.runInTransaction(async (transaction) => {
          const active = await transaction.identities.listActive();
          const existing = active[0];
          if (
            active.length === 1 &&
            existing?.kind === 'account' &&
            existing.accountSubjectId === accountSubjectId
          ) {
            return existing;
          }
          if (active.length > 0 || (await transaction.identities.find(id)) !== null) {
            throw new AccountRuleError('identity_exists');
          }
          await transaction.identities.insertAccount({
            id,
            accountSubjectId,
            replicaId: ids.next(),
            at: now,
            link: null,
          });
          if (profileSeed !== null) {
            await transaction.profiles.seed({
              ownerId: id,
              profileId: seededAccountProfileId(accountSubjectId),
              seed: profileSeed,
              at: now,
            });
            const snapshot = await transaction.records.snapshot(id);
            for (const group of planInitialUpload({
              snapshot,
              commandId: ids.next(),
              now,
              ids,
            })) {
              await transaction.sync.appendGroup(group);
            }
          }
          return required(await transaction.identities.find(id));
        });
      }),

    recordCounts: () =>
      run(() =>
        store.read(async (reader) =>
          reader.records.counts((await singleIdentity(reader.identities)).id),
        ),
      ),

    hasMeaningfulLocalData: () =>
      run(() =>
        store.read(async (reader) => {
          const counts = await reader.records.counts((await singleIdentity(reader.identities)).id);
          return counts.total - (counts.byType.profile ?? 0) > 0;
        }),
      ),

    profileSeed: () =>
      run(() =>
        store.read(async (reader) =>
          reader.profiles.readSeed((await singleIdentity(reader.identities)).id),
        ),
      ),

    exportBundle: () => run(async () => (await exportWithOwner()).bundle),

    createVerifiedBackup: () =>
      run(async () => {
        let exported: Awaited<ReturnType<typeof exportWithOwner>>;
        try {
          exported = await exportWithOwner();
        } catch {
          throw new AccountRuleError('backup_verification_failed');
        }
        const at = clock.now();
        return store.runInTransaction(async (transaction) => {
          const identity = await singleIdentity(transaction.identities);
          if (identity.id !== exported.ownerId) throw new AccountRuleError('identity_unavailable');
          await transaction.backups.save({ ownerId: identity.id, bundle: exported.bundle, at });
          return required(await transaction.backups.latest(identity.id));
        });
      }),

    latestBackup: () =>
      run(() =>
        store.read(async (reader) =>
          reader.backups.latest((await singleIdentity(reader.identities)).id),
        ),
      ),

    discardBackup: () =>
      run(async () => {
        // A linking plan keeps its backup until linkage. Nothing is written when
        // no backup is kept, so a launch does not start a write.
        const kept = await store.read(async (reader) => {
          const identity = await singleIdentity(reader.identities);
          return (
            accountLinkPhase(identity) !== 'linking' &&
            (await reader.backups.latest(identity.id)) !== null
          );
        });
        if (!kept) return;
        await store.runInTransaction(async (transaction) => {
          const identity = await singleIdentity(transaction.identities);
          if (accountLinkPhase(identity) === 'linking') return;
          await transaction.backups.clear(identity.id);
        });
      }),

    linkToAccount: ({ accountSubjectId, backupId }) =>
      run(() => {
        const accountId = accountSubject(accountSubjectId);
        const now = clock.now();
        const linkId = ids.next();
        const replicaId = ids.next();
        return store.runInTransaction(async (transaction) => {
          const source = await singleIdentity(transaction.identities);
          if (source.kind !== 'local') throw new AccountRuleError('not_local');
          if ((await transaction.identities.find(accountId)) !== null) {
            throw new AccountRuleError('identity_exists');
          }
          if (backupId !== null) {
            const backup = await transaction.backups.latest(source.id);
            if (backup?.bundleId !== backupId) throw new AccountRuleError('backup_missing');
          }
          // The account's Profile id replaces the local one, so this plan's Profile meets the
          // account's as the same record; the link remembers the local id for cancel.
          const profileId = seededAccountProfileId(accountSubjectId);
          const localProfileId = await transaction.profiles.readId(source.id);
          const renamedProfileId =
            localProfileId !== null && localProfileId !== profileId ? localProfileId : null;
          // A local identity never synchronizes: nothing stale may travel with the upload.
          await transaction.sync.clear(source.id);
          await transaction.identities.insertAccount({
            id: accountId,
            accountSubjectId,
            replicaId,
            at: now,
            link: { linkId, sourceIdentityId: source.id, sourceProfileId: renamedProfileId },
          });
          await transaction.ownership.remap({ from: source.id, to: accountId, at: now });
          if (renamedProfileId !== null) {
            await transaction.ownership.remapProfile({
              ownerId: accountId,
              from: renamedProfileId,
              to: profileId,
              at: now,
            });
          }
          await transaction.identities.retire(source.id, now);
          const snapshot = await transaction.records.snapshot(accountId);
          const groups = planInitialUpload({ snapshot, commandId: linkId, now, ids });
          for (const group of groups) await transaction.sync.appendGroup(group);
          return {
            ownerId: accountId,
            sourceIdentityId: source.id,
            linkId,
            replicaId,
            groups: groups.length,
            operations: snapshot.records.length,
          } satisfies AccountLinkReceipt;
        });
      }),

    firstUploadProgress: () =>
      run(() =>
        store.read(async (reader) => {
          const identity = await singleIdentity(reader.identities);
          return linkingProgress(reader, identity);
        }),
      ),

    completeLinkIfReady: () =>
      run(async () => {
        const checked = await store.read(async (reader) => {
          const identity = await singleIdentity(reader.identities);
          return { identity, progress: await linkingProgress(reader, identity) };
        });
        if (checked.progress === null) {
          return { linked: accountLinkPhase(checked.identity) === 'linked' };
        }
        if (!linkReady(checked.progress)) return { linked: false };
        const now = clock.now();
        return store.runInTransaction(async (transaction) => {
          const identity = await singleIdentity(transaction.identities);
          const progress = await linkingProgress(transaction, identity);
          if (identity.id !== checked.identity.id || progress === null || !linkReady(progress)) {
            return { linked: accountLinkPhase(identity) === 'linked' };
          }
          await transaction.identities.markLinked(identity.id, now);
          const source =
            identity.linkSourceIdentityId === null
              ? null
              : await transaction.identities.find(identity.linkSourceIdentityId);
          if (source !== null) await transaction.identities.remove(source.id);
          // The backup was kept until linkage.
          await transaction.backups.clear(identity.id);
          return { linked: true };
        });
      }),

    cancelLink: () =>
      run(() => {
        const now = clock.now();
        return store.runInTransaction(async (transaction) => {
          const identity = await singleIdentity(transaction.identities);
          if (accountLinkPhase(identity) !== 'linking' || identity.linkSourceIdentityId === null) {
            throw new AccountRuleError('not_linking');
          }
          const source = await transaction.identities.find(identity.linkSourceIdentityId);
          if (source === null || source.kind !== 'local') {
            throw new AccountRuleError('identity_unavailable');
          }
          const profileRename = canceledProfileRename(identity);
          // Queued and acknowledged uploads, conflicts, and checkpoints belong to the canceled
          // link; every record, including edits made since linking, stays. So does the plan the
          // backup was made of: the backup (with its sensitive Context) is not kept.
          await transaction.sync.clear(identity.id);
          await transaction.deletion.clear(identity.id);
          await transaction.backups.clear(identity.id);
          await transaction.identities.restore(source.id, now);
          await transaction.ownership.remap({ from: identity.id, to: source.id, at: now });
          if (profileRename !== null) {
            await transaction.ownership.remapProfile({
              ownerId: source.id,
              ...profileRename,
              at: now,
            });
          }
          await transaction.identities.remove(identity.id);
          return { ownerId: source.id };
        });
      }),

    syncFacts: () =>
      run(() =>
        store.read(async (reader) =>
          reader.sync.facts((await singleIdentity(reader.identities)).id),
        ),
      ),

    deletionStatus: () =>
      run(() =>
        store.read(async (reader) => {
          const identity = await singleIdentity(reader.identities);
          if (identity.kind !== 'account') throw new AccountRuleError('not_account');
          return reader.deletion.read(identity.id);
        }),
      ),

    recordDeletion: (event) =>
      run(() => {
        const now = clock.now();
        return store.runInTransaction(async (transaction) => {
          const identity = await singleIdentity(transaction.identities);
          if (identity.kind !== 'account') throw new AccountRuleError('not_account');
          const current = await transaction.deletion.read(identity.id);
          const next = nextAccountDeletionStatus(current, event, {
            now,
            requestId: ids.next(),
          });
          if (next === null) throw new AccountRuleError('deletion_state_invalid');
          await transaction.deletion.write({
            ownerId: identity.id,
            rowId: ids.next(),
            status: next,
            at: now,
          });
          return next;
        });
      }),

    detachToLocalPlan: () =>
      run(() => {
        const now = clock.now();
        return store.runInTransaction(async (transaction) => {
          const identity = await singleIdentity(transaction.identities);
          if (identity.kind !== 'account') throw new AccountRuleError('not_account');
          const deletion = await transaction.deletion.read(identity.id);
          if (deletion.phase !== 'confirmed') throw new AccountRuleError('deletion_not_confirmed');
          const localId = ids.next();
          await transaction.identities.insertLocal({ id: localId, at: now });
          await transaction.sync.clear(identity.id);
          await transaction.deletion.clear(identity.id);
          // The kept copy keeps the deleted account's Profile id: no other account derives it, and
          // linking this plan to another account later renames it to that account's Profile id.
          await transaction.ownership.remap({ from: identity.id, to: localId, at: now });
          const source =
            identity.linkSourceIdentityId === null
              ? null
              : await transaction.identities.find(identity.linkSourceIdentityId);
          if (source !== null) await transaction.identities.remove(source.id);
          await transaction.identities.remove(identity.id);
          return { ownerId: localId };
        });
      }),
  };
}

async function linkingProgress(
  reader: Pick<AccountStoreReader, 'sync'>,
  identity: PlanningIdentity,
): Promise<FirstUploadProgress | null> {
  if (
    accountLinkPhase(identity) !== 'linking' ||
    identity.linkId === null ||
    identity.replicaId === null
  ) {
    return null;
  }
  return reader.sync.firstUpload({
    ownerId: identity.id,
    linkId: identity.linkId,
    replicaId: identity.replicaId,
  });
}

function linkReady(progress: FirstUploadProgress): boolean {
  return progress.openGroups === 0 && progress.pullCheckpoint;
}

/**
 * What a canceled link renames back: the link gave the local Profile the account's Profile id, and
 * the Profile takes its own id again. Null when the link kept the Profile id.
 */
function canceledProfileRename(
  identity: PlanningIdentity,
): { readonly from: UUID; readonly to: UUID } | null {
  const localProfileId = identity.linkSourceProfileId;
  if (localProfileId === null) return null;
  if (identity.accountSubjectId === null) throw new AccountRuleError('identity_unavailable');
  return { from: seededAccountProfileId(identity.accountSubjectId), to: localProfileId };
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new AccountRuleError('store_failed');
  return value;
}
