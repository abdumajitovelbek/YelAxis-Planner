import type {
  AccountNotice,
  AccountNotices,
  AccountResult,
  AccountService,
} from '../account/account-service';
import { accountOpenedText, accountOutcomes } from '../account/sync-text';
import type { IdentityStores } from './identity-stores';
import type { SyncSwitch } from './store-sync';

/*
 * The AccountService the account UI uses: the identity part's service, with the sync status kept
 * honest around each operation. Store switches (sign-in to a new replica,
 * linking, sign-out, removal) rebuild the coordinator through the identity stores' events; here
 * only the operations that keep the open store tell its coordinator what changed.
 *
 * A store switch also rebuilds every view, so the view that started an operation is gone when the
 * operation settles. The outcome of an operation during which the open store switched (success or
 * failure) is therefore held here, outside those views, as a one-shot notice that the new views
 * show once. Without a switch the view is still there and shows the outcome itself: no notice.
 */

export interface SyncedAccountService extends AccountService {
  readonly notices: AccountNotices;
}

/** When an operation that switched the plan ends without an answer at all. */
const unfinishedText = 'An account action did not finish. Open Account to see where it stands.';

export function createSyncedAccountService(
  account: AccountService,
  sync: SyncSwitch,
  stores: Pick<IdentityStores, 'subscribe' | 'current'>,
): SyncedAccountService {
  let switches = 0;
  stores.subscribe((event) => {
    if (event.type === 'switching') switches += 1;
  });

  let notice: AccountNotice | null = null;
  let counter = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const announce = (text: string, tone: AccountNotice['tone']): void => {
    counter += 1;
    notice = { key: counter, text, tone };
    notify();
  };
  const notices: AccountNotices = {
    current: () => notice,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    consume(key) {
      if (notice?.key !== key) return;
      notice = null;
      notify();
    },
  };

  const openDatabase = (): string | null => stores.current()?.opened.databaseName ?? null;

  /**
   * Runs an operation; when the open store switched meanwhile, its outcome becomes the notice:
   * `succeeded` words a success (null for none), a failure keeps its own calm message.
   */
  const noticed = async <Value>(
    work: () => Promise<AccountResult<Value>>,
    succeeded: (value: Value, databaseBefore: string | null) => string | null,
  ): Promise<AccountResult<Value>> => {
    const switchesBefore = switches;
    const databaseBefore = openDatabase();
    let result: AccountResult<Value>;
    try {
      result = await work();
    } catch (error) {
      if (switches !== switchesBefore) announce(unfinishedText, 'alert');
      throw error;
    }
    if (switches === switchesBefore) return result;
    if (!result.ok) {
      announce(result.message, 'alert');
      return result;
    }
    const text = succeeded(result.value, databaseBefore);
    if (text !== null) announce(text, 'status');
    return result;
  };

  /**
   * After a retry or cancel: a canceled deletion, or none left to retry or cancel (the server and
   * this device agree the account stays), lets queued work resume; anything else re-reads facts.
   */
  const afterDeletionAnswer = async (result: AccountResult): Promise<void> => {
    if (result.ok || result.code === 'no_deletion') await sync.resume();
    else await sync.refresh();
  };

  const signedIn = (
    work: () => ReturnType<AccountService['signIn']>,
    email: string,
  ): ReturnType<AccountService['signIn']> =>
    noticed(
      async () => {
        const result = await sync.whileSigningIn(work);
        // Signing in again to the open account reopens nothing: queued work resumes at once.
        if (result.ok) await sync.resume();
        return result;
      },
      (outcome) =>
        outcome.kind === 'opened_account'
          ? accountOpenedText(account.currentAccount()?.email ?? email.trim())
          : null,
    );

  return {
    notices,
    get configured() {
      return account.configured;
    },
    get localTestService() {
      return account.localTestService;
    },
    currentAccount: () => account.currentAccount(),
    signUp: (email, password) => signedIn(() => account.signUp(email, password), email),
    signIn: (email, password) => signedIn(() => account.signIn(email, password), email),
    startFirstUpload: () =>
      noticed(
        () => account.startFirstUpload(),
        () => accountOutcomes.uploadStarted,
      ),
    declineFirstUpload: () =>
      noticed(
        () => account.declineFirstUpload(),
        () => accountOutcomes.planKept,
      ),
    // Only a running upload's cancel switches the plan; a waiting choice's cancel does not.
    cancelFirstUpload: () =>
      noticed(
        () => account.cancelFirstUpload(),
        () => accountOutcomes.uploadCanceled,
      ),
    latestBackup: () => account.latestBackup(),
    exportAccount: () => account.exportAccount(),
    signOutFacts: () => account.signOutFacts(),
    signOut: () =>
      noticed(
        () => account.signOut(),
        () => accountOutcomes.signedOut,
      ),
    reauthenticate: async (password) => {
      const result = await sync.whileSigningIn(() => account.reauthenticate(password));
      if (result.ok) await sync.resume();
      return result;
    },
    removeFromDevice: (input) =>
      noticed(
        () => account.removeFromDevice(input),
        () =>
          input.deleteLocalCopy
            ? accountOutcomes.removedDeletedCopy
            : accountOutcomes.removedKeptCopy,
      ),
    deletionPreview: () => account.deletionPreview(),
    // A pending deletion freezes pushes; the status shows it before the result returns.
    deleteAccount: (input) =>
      noticed(
        async () => {
          const result = await account.deleteAccount(input);
          await sync.refresh();
          return result;
        },
        () =>
          input.keepLocalCopy ? accountOutcomes.deletedKeptCopy : accountOutcomes.deletedWithCopy,
      ),
    // A kept copy stays open in the same database, as a local plan; a deleted one is gone.
    retryDeletion: (password) =>
      noticed(
        async () => {
          const result = await account.retryDeletion(password);
          await afterDeletionAnswer(result);
          return result;
        },
        (_value, databaseBefore) =>
          openDatabase() === databaseBefore
            ? accountOutcomes.deletedKeptCopy
            : accountOutcomes.deletedWithCopy,
      ),
    cancelDeletion: () =>
      noticed(
        async () => {
          const result = await account.cancelDeletion();
          await afterDeletionAnswer(result);
          return result;
        },
        () => accountOutcomes.deletionCanceled,
      ),
  };
}
