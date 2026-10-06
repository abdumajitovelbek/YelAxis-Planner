import {
  accountLinkPhase,
  type AccountDeletionEvent,
  type AccountDeletionStatus,
} from '@yelaxis/application';

import type {
  AccountResult,
  AccountService,
  ExportFile,
  SignInOutcome,
  SignOutFacts,
} from '../account/account-service';
import { accountMessages, type AccountMessageCode } from './account-messages';
import type { AccountIdentityEntry } from './identity-index';
import {
  IdentityStoreError,
  type IdentityStore,
  type IdentityStores,
  type StoreTarget,
} from './identity-stores';
import { countsByKind } from './record-kinds';
import type { AccountBackend, BackendFailure } from './supabase-backend';

/*
 * The identity part of the account contract (identity contract). Every
 * operation runs alone, in order. A session exists only while its account's replica is open, or
 * while a first-upload choice waits; every other path clears it. Messages are calm and never carry
 * planning content, credentials, or an email address.
 */

export interface WebAccountServiceDependencies {
  /** Null for a build without account configuration. */
  readonly backend: AccountBackend | null;
  readonly stores: IdentityStores;
  /** The build's account service is the local test stack. Defaults to false. */
  readonly localTestService?: boolean;
}

export interface WebAccountService extends AccountService {
  /**
   * At launch, after the active store opens: clears a session that has no open replica (a sign-in
   * choice interrupted by a restart, or a sign-out cut short) and finishes a confirmed deletion.
   */
  start(): Promise<void>;
  /**
   * For the sync coordinator after each cycle: marks a first upload linked once its initial groups
   * are acknowledged and a pull checkpoint exists. Resolves whether the store is linked.
   */
  completeLinkIfReady(): Promise<boolean>;
}

interface PendingChoice {
  readonly subjectId: string;
  readonly email: string;
}

type AccountStore = IdentityStore & { readonly entry: AccountIdentityEntry };

function isAccountStore(store: IdentityStore): store is AccountStore {
  return store.entry.kind === 'account';
}

function failure<Value = void>(code: AccountMessageCode): AccountResult<Value> {
  return { ok: false, code, message: accountMessages[code] };
}

function success<Value>(value: Value): AccountResult<Value> {
  return { ok: true, value };
}

function backendCode(reason: BackendFailure): AccountMessageCode {
  switch (reason) {
    case 'offline':
      return 'offline';
    case 'unauthorized':
      return 'session_expired';
    case 'unavailable':
    case 'invalid_response':
      return 'unavailable';
  }
}

function sameEmail(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function exportFile(
  kind: 'backup' | 'export',
  text: string,
  recordCount: number,
  syncWasPending: boolean,
  at: string,
): ExportFile {
  return {
    fileName: `yelaxis-${kind}-${at.slice(0, 10)}.json`,
    blob: new Blob([text], { type: 'application/json' }),
    recordCount,
    syncWasPending,
  };
}

export function createWebAccountService(
  dependencies: WebAccountServiceDependencies,
): WebAccountService {
  const { backend, stores } = dependencies;
  let pending: PendingChoice | null = null;
  let sessionEmail: string | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  const serial = <Value>(work: () => Promise<Value>): Promise<Value> => {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const guarded = <Value>(
    work: () => Promise<AccountResult<Value>>,
  ): Promise<AccountResult<Value>> =>
    serial(async () => {
      try {
        return await work();
      } catch (error) {
        return failure<Value>(
          error instanceof IdentityStoreError && error.code === 'database_busy'
            ? 'database_busy'
            : 'storage',
        );
      }
    });

  const active = (): IdentityStore => {
    const store = stores.current();
    if (store === null) throw new IdentityStoreError('storage');
    return store;
  };

  const signOutSession = async (): Promise<void> => {
    pending = null;
    sessionEmail = null;
    if (backend !== null) await backend.signOut();
  };

  const prepareLocal = (): Promise<IdentityStore> => {
    const fallback = stores.localFallback();
    return stores.prepare(
      fallback === null ? { kind: 'new_local' } : { kind: 'entry', entry: fallback },
    );
  };

  /** Opens an account's replica and makes it active; a failure leaves the local plan open. */
  const openAccountStore = async (
    target: StoreTarget,
    email: string,
  ): Promise<AccountResult<SignInOutcome>> => {
    let prepared: IdentityStore;
    try {
      prepared = await stores.prepare(target);
    } catch (error) {
      await signOutSession();
      throw error;
    }
    await stores.activate(prepared);
    pending = null;
    sessionEmail = email;
    return success({ kind: 'opened_account' });
  };

  const openReplica = async (
    current: IdentityStore,
    choice: PendingChoice,
    accountIsEmpty: boolean,
  ): Promise<AccountResult<SignInOutcome>> => {
    let profileSeed = null;
    if (accountIsEmpty) {
      // A new account starts from this device's confirmed setup choices.
      const seed = await current.accounts.profileSeed();
      if (!seed.ok) {
        await signOutSession();
        return failure('storage');
      }
      profileSeed = seed.value;
    }
    return openAccountStore(
      {
        kind: 'account',
        accountSubjectId: choice.subjectId,
        email: choice.email,
        profileSeed,
      },
      choice.email,
    );
  };

  const afterAuthentication = async (
    account: AccountBackend,
    current: IdentityStore,
    choice: PendingChoice,
  ): Promise<AccountResult<SignInOutcome>> => {
    pending = null;
    const existing = stores.findAccount(choice.subjectId);
    if (existing !== null && existing.kind === 'account') {
      // Signing in again reopens this account's own copy and resumes its queued work.
      return openAccountStore(
        { kind: 'entry', entry: { ...existing, email: choice.email } },
        choice.email,
      );
    }
    const status = await account.accountStatus();
    if (!status.ok) {
      await signOutSession();
      return failure(backendCode(status.reason));
    }
    if (status.value.deletion === 'pending') {
      await signOutSession();
      return failure('account_being_deleted');
    }
    const meaningful = await current.accounts.hasMeaningfulLocalData();
    const counts = await current.accounts.recordCounts();
    if (!meaningful.ok || !counts.ok) {
      await signOutSession();
      return failure('storage');
    }
    if (!meaningful.value) {
      return openReplica(current, choice, status.value.recordCount === 0);
    }
    pending = choice;
    sessionEmail = choice.email;
    return success({
      kind: 'choose_first_upload',
      preview: {
        accountEmail: choice.email,
        local: countsByKind(counts.value.byType),
        cloudRecordCount: status.value.recordCount,
        sensitiveContextCount: counts.value.sensitiveContextCount,
      },
    });
  };

  /** Signs in again as the open account after the session ended. */
  const reauthenticateAccount = async (
    account: AccountBackend,
    current: AccountStore,
    password: string,
  ): Promise<AccountResult> => {
    if (current.entry.email === null) return failure('email_unknown');
    if (password.length === 0) return failure('invalid_input');
    const attempt = await account.signIn(current.entry.email, password);
    if (!attempt.ok) return failure(attempt.reason);
    if (attempt.subjectId !== current.entry.accountSubjectId) {
      await signOutSession();
      return failure('different_account');
    }
    sessionEmail = current.entry.email;
    return success(undefined);
  };

  const authenticate = (
    mode: 'sign_in' | 'sign_up',
    email: string,
    password: string,
  ): Promise<AccountResult<SignInOutcome>> =>
    guarded(async () => {
      if (backend === null) return failure('not_configured');
      const address = email.trim();
      if (address.length === 0 || password.length === 0) return failure('invalid_input');
      const current = active();
      if (isAccountStore(current)) {
        if (
          mode === 'sign_in' &&
          current.entry.email !== null &&
          sameEmail(current.entry.email, address)
        ) {
          const result = await reauthenticateAccount(backend, current, password);
          return result.ok ? success({ kind: 'opened_account' }) : result;
        }
        return failure('account_active');
      }
      const attempt =
        mode === 'sign_in'
          ? await backend.signIn(address, password)
          : await backend.signUp(address, password);
      if (!attempt.ok) return failure(attempt.reason);
      if (!attempt.hasSession) return failure('confirmation_required');
      return afterAuthentication(backend, current, {
        subjectId: attempt.subjectId,
        email: attempt.email ?? address,
      });
    });

  /**
   * Removes an account's copy after the local plan opened in its place. The copy was marked for
   * removal before anything switched, so a removal that fails here happens at the next launch.
   */
  const removeMarkedCopy = async (
    current: AccountStore,
    failed: AccountMessageCode,
  ): Promise<AccountResult> => {
    try {
      await stores.remove(current.entry);
    } catch {
      return failure(failed);
    }
    return success(undefined);
  };

  const finishConfirmedDeletion = async (current: AccountStore): Promise<AccountResult> => {
    const status = await current.accounts.deletionStatus();
    if (!status.ok || status.value.phase !== 'confirmed') return failure('deletion_finish_failed');
    await signOutSession();
    // Without a recorded choice, nothing is removed.
    if (status.value.localCopy !== 'delete') {
      const detached = await current.accounts.detachToLocalPlan();
      if (!detached.ok) return failure('deletion_finish_failed');
      await stores.reload();
      return success(undefined);
    }
    const local = await prepareLocal();
    stores.markForRemoval(current.entry);
    await stores.activate(local);
    return removeMarkedCopy(current, 'deleted_copy_remove_failed');
  };

  const runDeletion = async (
    account: AccountBackend,
    current: AccountStore,
  ): Promise<AccountResult> => {
    const started = await current.accounts.recordDeletion({ kind: 'start' });
    if (!started.ok) return failure('storage');
    const response = await account.deleteAccount();
    if (!response.ok) {
      await current.accounts.recordDeletion({ kind: 'fail', errorCode: response.reason });
      return failure(response.reason === 'unauthorized' ? 'session_expired' : 'deletion_failed');
    }
    const confirmed = await current.accounts.recordDeletion({ kind: 'confirm' });
    if (!confirmed.ok) return failure('deletion_finish_failed');
    return finishConfirmedDeletion(current);
  };

  /**
   * The server already deleted the account (on another device, or a call whose answer was lost):
   * this device records the deletion, with the choice made or keeping its copy when none was made,
   * and finishes it.
   */
  const confirmServerDeletion = async (
    current: AccountStore,
    status: AccountDeletionStatus,
  ): Promise<AccountResult> => {
    const steps: AccountDeletionEvent[] = [
      ...(status.phase === 'none' ? [{ kind: 'request', localCopy: 'keep' } as const] : []),
      ...(status.phase === 'pending' || status.phase === 'confirmed'
        ? []
        : [{ kind: 'start' } as const]),
      ...(status.phase === 'confirmed' ? [] : [{ kind: 'confirm' } as const]),
    ];
    for (const step of steps) {
      const recorded = await current.accounts.recordDeletion(step);
      if (!recorded.ok) return failure('deletion_finish_failed');
    }
    return finishConfirmedDeletion(current);
  };

  /** Whether the server already deleted the account, asked with the current session. */
  const serverDeletion = async (
    account: AccountBackend,
  ): Promise<
    | { readonly ok: true; readonly deleted: boolean }
    | { readonly ok: false; readonly reason: BackendFailure }
  > => {
    const status = await account.accountStatus();
    return status.ok
      ? { ok: true, deleted: status.value.deletion === 'pending' }
      : { ok: false, reason: status.reason };
  };

  const checkFailed = (reason: BackendFailure): AccountResult =>
    failure(reason === 'unauthorized' ? 'deletion_check_signed_out' : 'deletion_check_unavailable');

  /** Recent authentication: the password signs in again as the open account. Null when it did. */
  const verifyPassword = async (
    account: AccountBackend,
    current: AccountStore,
    password: string,
  ): Promise<AccountResult | null> => {
    if (current.entry.email === null) return failure('email_unknown');
    if (password.length === 0) return failure('password_required');
    const attempt = await account.signIn(current.entry.email, password);
    if (!attempt.ok) {
      return failure(attempt.reason === 'invalid_credentials' ? 'wrong_password' : attempt.reason);
    }
    if (attempt.subjectId !== current.entry.accountSubjectId) {
      await signOutSession();
      return failure('different_account');
    }
    return null;
  };

  /** A cancel that came too late: the deletion was finished instead, with the choice made. */
  const finishedInsteadOfCanceled = (
    finished: AccountResult,
    status: AccountDeletionStatus,
  ): AccountResult => {
    if (!finished.ok) return finished;
    return failure(
      status.localCopy === 'delete' ? 'deletion_done_copy_removed' : 'deletion_done_copy_kept',
    );
  };

  const withAccount = <Value>(
    work: (account: AccountBackend, current: AccountStore) => Promise<AccountResult<Value>>,
  ): Promise<AccountResult<Value>> =>
    guarded(async () => {
      if (backend === null) return failure('not_configured');
      const current = active();
      if (!isAccountStore(current)) return failure('not_signed_in');
      return work(backend, current);
    });

  return {
    configured: backend !== null,
    localTestService: backend !== null && dependencies.localTestService === true,

    currentAccount() {
      const current = stores.current();
      if (current !== null && isAccountStore(current)) {
        const email = current.entry.email ?? sessionEmail;
        return email === null ? null : { email };
      }
      return pending === null ? null : { email: pending.email };
    },

    signUp: (email, password) => authenticate('sign_up', email, password),
    signIn: (email, password) => authenticate('sign_in', email, password),

    startFirstUpload: () =>
      guarded(async () => {
        if (backend === null) return failure('not_configured');
        const choice = pending;
        const current = active();
        if (choice === null || current.identity.kind !== 'local') {
          return failure('no_pending_choice');
        }
        const backup = await current.accounts.createVerifiedBackup();
        if (!backup.ok) return failure('backup_failed');
        const linked = await current.accounts.linkToAccount({
          accountSubjectId: choice.subjectId,
          backupId: backup.value.bundleId,
        });
        if (!linked.ok) {
          // No link needs the backup (a copy of the plan with its sensitive Context); a retry
          // makes a new one.
          await current.accounts.discardBackup();
          return failure('link_failed');
        }
        pending = null;
        sessionEmail = choice.email;
        await stores.reload({ email: choice.email });
        return success(undefined);
      }),

    declineFirstUpload: () =>
      guarded(async () => {
        if (backend === null) return failure('not_configured');
        const choice = pending;
        if (choice === null) return failure('no_pending_choice');
        const status = await backend.accountStatus();
        if (!status.ok) return failure(backendCode(status.reason));
        if (status.value.deletion === 'pending') {
          await signOutSession();
          return failure('account_being_deleted');
        }
        const opened = await openReplica(active(), choice, status.value.recordCount === 0);
        return opened.ok ? success(undefined) : opened;
      }),

    cancelFirstUpload: () =>
      guarded(async () => {
        if (pending !== null) {
          await signOutSession();
          return success(undefined);
        }
        const current = active();
        if (accountLinkPhase(current.identity) !== 'linking') return failure('nothing_to_cancel');
        const canceled = await current.accounts.cancelLink();
        if (!canceled.ok) return failure('cancel_failed');
        await signOutSession();
        await stores.reload();
        return success(undefined);
      }),

    latestBackup: () =>
      serial(async () => {
        try {
          const backup = await active().accounts.latestBackup();
          if (!backup.ok || backup.value === null) return null;
          const { text, recordCount, syncWasPending, createdAt } = backup.value;
          return exportFile('backup', text, recordCount, syncWasPending, createdAt);
        } catch {
          return null;
        }
      }),

    exportAccount: () =>
      guarded(async () => {
        const exported = await active().accounts.exportBundle();
        if (!exported.ok) return failure('export_failed');
        const { text, recordCount, manifest, exportedAt } = exported.value;
        return success(
          exportFile('export', text, recordCount, manifest.syncWasPending, exportedAt),
        );
      }),

    signOutFacts: () =>
      serial(async (): Promise<SignOutFacts | null> => {
        // Facts that cannot be read are unknown, never "nothing waits": the dialogs fail closed.
        try {
          const current = active();
          if (current.identity.kind !== 'account') return { pendingChanges: 0, openConflicts: 0 };
          const facts = await current.accounts.syncFacts();
          if (!facts.ok) return null;
          return {
            pendingChanges: facts.value.pendingOperations,
            openConflicts: facts.value.openConflicts,
            ...(facts.value.lastSyncedAt === null
              ? {}
              : { lastSyncedAt: facts.value.lastSyncedAt }),
          };
        } catch {
          return null;
        }
      }),

    signOut: () =>
      guarded(async () => {
        const current = active();
        if (pending !== null || !isAccountStore(current)) {
          await signOutSession();
          return success(undefined);
        }
        // The local plan opens before anything changes; the replica stays for signing in again.
        const local = await prepareLocal();
        await signOutSession();
        await stores.activate(local);
        return success(undefined);
      }),

    reauthenticate: (password) =>
      withAccount((account, current) => reauthenticateAccount(account, current, password)),

    removeFromDevice: ({ deleteLocalCopy, acceptUnsyncedLoss }) =>
      withAccount(async (_account, current) => {
        if (deleteLocalCopy) {
          const facts = await current.accounts.syncFacts();
          if (!facts.ok) return failure('storage');
          if (facts.value.pendingOperations > 0 && !acceptUnsyncedLoss) {
            return failure('unsynced_changes');
          }
        }
        const local = await prepareLocal();
        // The choice to delete the copy is recorded before the session or the store changes.
        if (deleteLocalCopy) stores.markForRemoval(current.entry);
        await signOutSession();
        await stores.activate(local);
        return deleteLocalCopy ? removeMarkedCopy(current, 'remove_failed') : success(undefined);
      }),

    deletionPreview: () =>
      withAccount(async (account, current) => {
        const status = await account.accountStatus();
        if (!status.ok) return failure(backendCode(status.reason));
        const counts = await current.accounts.recordCounts();
        const facts = await current.accounts.syncFacts();
        if (!counts.ok || !facts.ok) return failure('storage');
        return success({
          accountEmail: current.entry.email ?? sessionEmail ?? '',
          cloud: countsByKind(status.value.recordCounts),
          local: countsByKind(counts.value.byType),
          pendingChanges: facts.value.pendingOperations,
        });
      }),

    deleteAccount: ({ password, keepLocalCopy }) =>
      withAccount(async (account, current) => {
        if (current.entry.email === null) return failure('email_unknown');
        const local = await current.accounts.deletionStatus();
        if (!local.ok) return failure('storage');
        if (local.value.phase !== 'none') return failure('deletion_in_progress');
        const localCopy = keepLocalCopy ? 'keep' : 'delete';
        // Deleted on another device: this device records it with this choice, without a password.
        const server = await serverDeletion(account);
        if (server.ok && server.deleted) {
          const requested = await current.accounts.recordDeletion({ kind: 'request', localCopy });
          if (!requested.ok) return failure('storage');
          return confirmServerDeletion(current, requested.value);
        }
        // Recent authentication: the password is checked by signing in again.
        const refused = await verifyPassword(account, current, password);
        if (refused !== null) return refused;
        const requested = await current.accounts.recordDeletion({ kind: 'request', localCopy });
        if (!requested.ok) {
          return failure(
            requested.error.code === 'deletion_state_invalid' ? 'deletion_in_progress' : 'storage',
          );
        }
        return runDeletion(account, current);
      }),

    retryDeletion: (password) =>
      withAccount(async (account, current) => {
        const local = await current.accounts.deletionStatus();
        if (!local.ok) return failure('storage');
        if (local.value.phase === 'confirmed') return finishConfirmedDeletion(current);
        // The server is asked first: an account it already deleted needs no password.
        let server = await serverDeletion(account);
        let verified = false;
        if (!server.ok && server.reason === 'unauthorized' && password.length > 0) {
          // The session ended: the password signs in again before the server is asked.
          const refused = await verifyPassword(account, current, password);
          if (refused !== null) {
            return refused.ok || refused.code !== 'wrong_password'
              ? refused
              : failure('deletion_password_unverified');
          }
          verified = true;
          server = await serverDeletion(account);
        }
        if (!server.ok) return checkFailed(server.reason);
        if (server.deleted) return confirmServerDeletion(current, local.value);
        if (local.value.phase === 'none') return failure('no_deletion');
        if (!verified) {
          const refused = await verifyPassword(account, current, password);
          if (refused !== null) return refused;
        }
        return runDeletion(account, current);
      }),

    cancelDeletion: () =>
      withAccount(async (account, current) => {
        const local = await current.accounts.deletionStatus();
        if (!local.ok) return failure('storage');
        if (local.value.phase === 'confirmed') {
          return finishedInsteadOfCanceled(await finishConfirmedDeletion(current), local.value);
        }
        // Only an account the server still has can stay.
        const server = await serverDeletion(account);
        if (!server.ok) return checkFailed(server.reason);
        if (server.deleted) {
          return finishedInsteadOfCanceled(
            await confirmServerDeletion(current, local.value),
            local.value,
          );
        }
        const canceled = await current.accounts.recordDeletion({ kind: 'cancel' });
        if (!canceled.ok) {
          return failure(
            canceled.error.code === 'deletion_state_invalid' ? 'no_deletion' : 'storage',
          );
        }
        return success(undefined);
      }),

    start: () =>
      serial(async () => {
        try {
          const current = stores.current();
          if (current === null) return;
          if (!isAccountStore(current)) {
            // No first-upload choice survives a restart: a stored session belongs to nothing open,
            // and is cleared even when it expired and the client no longer reports it. A backup
            // made for a link that never happened is not kept either.
            if (backend?.hasStoredSession() === true) await signOutSession();
            await current.accounts.discardBackup();
          } else {
            const session = backend === null ? null : await backend.session();
            if (session !== null && current.entry.accountSubjectId !== session.subjectId) {
              await signOutSession();
            } else if (session !== null) {
              sessionEmail = session.email;
              if (current.entry.email === null && session.email !== null) {
                stores.rememberEmail(session.email);
              }
            }
            const status = await current.accounts.deletionStatus();
            if (status.ok && status.value.phase === 'confirmed') {
              await finishConfirmedDeletion(current);
            }
          }
        } catch {
          // Launch continues with the open store; the person can retry from the Account page.
        }
        // Copies the person chose to delete, whose removal failed or was cut short.
        await stores.removePending();
      }),

    completeLinkIfReady: () =>
      serial(async () => {
        try {
          const current = stores.current();
          if (current === null || current.identity.kind !== 'account') return false;
          if (accountLinkPhase(current.identity) === 'linked') return true;
          const result = await current.accounts.completeLinkIfReady();
          if (!result.ok || !result.value.linked) return false;
          await stores.refreshIdentity();
          return true;
        } catch {
          return false;
        }
      }),
  };
}
