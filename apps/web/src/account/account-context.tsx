import { message as uiMessage } from '../messages';
/**
 * account and sync context. It carries the three services the account UI
 * renders (AccountService, SyncController, ConflictService), the live sync status, the first-upload
 * choice that waits after sign-in, and the one-shot notice of an operation that switched the open
 * plan. It holds no planning data: every change runs through the services, which run application
 * commands; React keeps presentation state only.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type {
  AccountNotice,
  AccountNotices,
  AccountService,
  ConflictService,
  FirstUploadPreview,
  SyncController,
  SyncStatus,
} from './account-service';

/**
 * The first upload of a local plan: the preview while the person chooses, then a
 * short "started" phase until the sync status reports the upload.
 */
export type FirstUploadFlow =
  | { readonly phase: 'choose'; readonly preview: FirstUploadPreview }
  | { readonly phase: 'started' };

export interface AccountContextValue {
  readonly account: AccountService;
  readonly sync: SyncController;
  readonly conflicts: ConflictService;
  /** The live status; it changes with every `SyncController` notification. */
  readonly status: SyncStatus;
  readonly firstUpload: FirstUploadFlow | null;
  readonly setFirstUpload: (flow: FirstUploadFlow | null) => void;
  /** The outcome of an operation that switched the open plan, until it is shown. */
  readonly notice: AccountNotice | null;
  /** The notice was shown where the person is; it is not shown again. */
  readonly consumeNotice: (key: number) => void;
}

const AccountContext = createContext<AccountContextValue | null>(null);

const noNotices: AccountNotices = {
  current: () => null,
  subscribe: () => () => undefined,
  consume: () => undefined,
};

function useNotice(notices: AccountNotices): AccountNotice | null {
  const subscribe = useCallback((listener: () => void) => notices.subscribe(listener), [notices]);
  const snapshot = useCallback(() => notices.current(), [notices]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  return (
    a.state === b.state &&
    a.configured === b.configured &&
    a.account?.email === b.account?.email &&
    a.pendingChanges === b.pendingChanges &&
    a.openConflicts === b.openConflicts &&
    a.rejectedChanges === b.rejectedChanges &&
    a.lastSyncedAt === b.lastSyncedAt &&
    a.nextAttemptAt === b.nextAttemptAt &&
    a.firstUpload?.uploaded === b.firstUpload?.uploaded &&
    a.firstUpload?.total === b.firstUpload?.total
  );
}

/**
 * The controller's status as a React store. An equal status keeps the previous object, so a
 * controller that builds a new object on every `getStatus()` call never re-renders in a loop.
 */
function useStatus(sync: SyncController): SyncStatus {
  const cache = useRef<{ readonly sync: SyncController; readonly status: SyncStatus } | null>(null);
  const subscribe = useCallback((listener: () => void) => sync.subscribe(listener), [sync]);
  const snapshot = useCallback((): SyncStatus => {
    const next = sync.getStatus();
    const cached = cache.current;
    if (cached !== null && cached.sync === sync && sameStatus(cached.status, next))
      return cached.status;
    cache.current = { sync, status: next };
    return next;
  }, [sync]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function AccountProvider({
  account,
  children,
  conflicts,
  notices = noNotices,
  sync,
}: {
  readonly account: AccountService;
  readonly sync: SyncController;
  readonly conflicts: ConflictService;
  /** Held by the app outside the views a store switch replaces. */
  readonly notices?: AccountNotices;
  readonly children: ReactNode;
}): ReactNode {
  const status = useStatus(sync);
  const notice = useNotice(notices);
  const consumeNotice = useCallback((key: number) => notices.consume(key), [notices]);
  // A flow belongs to the account service it started with; another service forgets it.
  const [flow, setFlow] = useState<{
    readonly account: AccountService;
    readonly flow: FirstUploadFlow;
  } | null>(null);
  const current = flow !== null && flow.account === account ? flow.flow : null;
  // "Started" lasts only until the status catches up (first upload, or what followed it).
  const caughtUp =
    current?.phase === 'started' && status.state !== 'local_only' && status.state !== 'signing_in';
  useEffect(() => {
    if (caughtUp) setFlow(null);
  }, [caughtUp]);
  const setFirstUpload = useCallback(
    (next: FirstUploadFlow | null) => setFlow(next === null ? null : { account, flow: next }),
    [account],
  );
  const firstUpload = caughtUp ? null : current;
  const value = useMemo<AccountContextValue>(
    () => ({
      account,
      sync,
      conflicts,
      status,
      firstUpload,
      setFirstUpload,
      notice,
      consumeNotice,
    }),
    [account, conflicts, consumeNotice, firstUpload, notice, setFirstUpload, status, sync],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/** The account services; only inside `AccountProvider`. */
export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (value === null) throw new Error(uiMessage('account.account-context.1'));
  return value;
}

/** Account services when the provider is mounted; null otherwise (and in isolated tests). */
export function useAccountOptional(): AccountContextValue | null {
  return useContext(AccountContext);
}

/** The live sync status; only inside `AccountProvider`. */
export function useSyncStatus(): SyncStatus {
  return useAccount().status;
}

/** Whether this build offers accounts at all. */
export function accountsOffered(value: AccountContextValue | null): boolean {
  return value !== null && value.account.configured;
}

/** The signed-in account's email for display, when one is known. */
export function accountEmail(value: AccountContextValue): string | null {
  return value.status.account?.email ?? value.account.currentAccount()?.email ?? null;
}
