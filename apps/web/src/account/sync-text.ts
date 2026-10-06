import { message as uiMessage } from '../messages';
/**
 * Calm words for account and sync states (the sync and conflict contract). Pure
 * functions only: counts and states in words, never a score, a deadline, or a promise that
 * something happens at a given time.
 */
import type {
  ConflictChoice,
  ConflictDetailView,
  ConflictFieldView,
  ConflictSummaryView,
  SyncStatus,
} from './account-service';
import { accountPath, conflictsPath } from './routes';

export function countText(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

export const changesText = (count: number): string => countText(count, 'change', 'changes');
export const conflictsText = (count: number): string => countText(count, 'conflict', 'conflicts');
export const recordsText = (count: number): string => countText(count, 'record', 'records');

/** The account copy shown wherever a build has no account configuration. */
export const notConfiguredText = uiMessage('account.onboarding-sign-in.196');

/**
 * What an account operation did. The Account page and the onboarding dialog show these, and so
 * does the notice shown after an operation switched the open plan (the view that started it is
 * gone by then).
 */
export const accountOutcomes = Object.freeze({
  signedOut: uiMessage('account.sync-text.2341'),
  removedKeptCopy: uiMessage('account.sync-text.2342'),
  removedDeletedCopy: uiMessage('account.sync-text.2343'),
  deletedKeptCopy: uiMessage('account.sync-text.2344'),
  deletedWithCopy: uiMessage('account.sync-text.2345'),
  deletionRetried: uiMessage('account.sync-text.2346'),
  deletionCanceled: uiMessage('account.sync-text.2347'),
  uploadStarted: uiMessage('account.sync-text.2348'),
  planKept: uiMessage('account.sync-text.2349'),
  uploadCanceled: uiMessage('account.sync-text.2350'),
  signInCanceled: uiMessage('account.sync-text.2351'),
  signedInAgain: uiMessage('account.sync-text.2352'),
} as const);

/** After signing in to an account whose own plan opened. */
export const accountOpenedText = (email: string): string =>
  uiMessage('account.sync-text.2353', { value0: email });

/** Short state for the app frame; null for a local-only identity, which shows nothing. */
export function syncShortText(status: SyncStatus): string | null {
  switch (status.state) {
    case 'local_only':
      return null;
    case 'signing_in':
      return uiMessage('account.credentials-form.153');
    case 'first_upload':
      return status.firstUpload === undefined
        ? uiMessage('account.first-upload.186')
        : uiMessage('account.sync-text.2354', {
            value0: String(status.firstUpload.uploaded),
            value1: String(status.firstUpload.total),
          });
    case 'syncing':
      return uiMessage('account.account-page.94');
    case 'queued_offline':
      return status.pendingChanges > 0
        ? uiMessage('account.sync-text.2355', { value0: changesText(status.pendingChanges) })
        : uiMessage('account.sync-text.2356');
    case 'synced':
      return uiMessage('account.sync-text.2357');
    case 'needs_attention':
      return uiMessage('account.sync-text.2358');
    case 'auth_expired':
      return uiMessage('account.sync-text.2359');
    case 'server_unavailable':
      return uiMessage('account.sync-text.2360');
    case 'deletion_pending':
      return uiMessage('account.sync-text.2361');
  }
}

/**
 * Needs attention with neither a conflict nor a change the account did not accept: changes pulled
 * from the account could be neither applied nor kept here, so sync cannot move on yet.
 */
const pullAttentionSentence = uiMessage('account.sync-text.2362');

function attentionSentence(status: SyncStatus): string {
  const parts = [
    ...(status.openConflicts > 0
      ? [
          uiMessage('account.sync-text.2363', {
            value0: conflictsText(status.openConflicts),
            value1: status.openConflicts === 1 ? 'needs' : 'need',
          }),
        ]
      : []),
    ...(status.rejectedChanges > 0
      ? [uiMessage('account.sync-text.2364', { value0: changesText(status.rejectedChanges) })]
      : []),
  ];
  return parts.length === 0
    ? pullAttentionSentence
    : uiMessage('account.sync-text.2365', { value0: parts.join(', and ') });
}

/** The sync state in a sentence, for the Account page. */
export function syncStateSentence(status: SyncStatus): string {
  switch (status.state) {
    case 'local_only':
      return uiMessage('account.sync-text.2366');
    case 'signing_in':
      return uiMessage('account.credentials-form.153');
    case 'first_upload':
      return uiMessage('account.sync-text.2367');
    case 'syncing':
      return uiMessage('account.sync-text.2368');
    case 'queued_offline': {
      const count = status.pendingChanges;
      if (count === 0) return uiMessage('account.sync-text.2369');
      return count === 1
        ? uiMessage('account.sync-text.2370')
        : uiMessage('account.sync-text.2371', { value0: changesText(count) });
    }
    case 'synced':
      return uiMessage('account.sync-text.2372');
    case 'needs_attention':
      return attentionSentence(status);
    case 'auth_expired':
      return uiMessage('account.sync-text.2373');
    case 'server_unavailable':
      return uiMessage('account.sync-text.2374');
    case 'deletion_pending':
      return uiMessage('account.sync-text.2375');
  }
}

export interface SyncNotice {
  readonly text: string;
  readonly link: { readonly to: string; readonly label: string };
}

const openAccount = { to: accountPath(), label: uiMessage('account.account-routes.111') } as const;

/**
 * The Today header line: only when something waits or needs an action, never for a
 * quiet state such as Synced or Syncing.
 */
export function todaySyncNotice(status: SyncStatus): SyncNotice | null {
  switch (status.state) {
    case 'queued_offline': {
      const count = status.pendingChanges;
      if (count === 0) return null;
      return {
        text: uiMessage('account.sync-text.2376', {
          value0: changesText(count),
          value1: count === 1 ? 'waits' : 'wait',
          value2: count === 1 ? 'It is' : 'They are',
        }),
        link: openAccount,
      };
    }
    case 'needs_attention':
      if (status.openConflicts > 0) {
        return {
          text: uiMessage('account.sync-text.2377', {
            value0: conflictsText(status.openConflicts),
          }),
          link: { to: conflictsPath(), label: uiMessage('account.account-page.91') },
        };
      }
      // Account offers "Try sending again"; the changes stay here meanwhile.
      if (status.rejectedChanges > 0) {
        return {
          text: uiMessage('account.sync-text.2378'),
          link: openAccount,
        };
      }
      return {
        text: uiMessage('account.sync-text.2379'),
        link: openAccount,
      };
    case 'server_unavailable':
      return {
        text: uiMessage('account.sync-text.2380'),
        link: openAccount,
      };
    case 'auth_expired':
      return {
        text: uiMessage('account.sync-text.2381'),
        link: { to: accountPath(), label: uiMessage('account.account-page.98') },
      };
    case 'deletion_pending':
      return { text: uiMessage('account.sync-text.2382'), link: openAccount };
    case 'local_only':
    case 'signing_in':
    case 'first_upload':
    case 'syncing':
    case 'synced':
      return null;
  }
}

/* ───────────────────────── Conflicts ───────────────────────── */

export type ConflictChoiceName = ConflictDetailView['choices'][number];

export function conflictKindText(kind: ConflictSummaryView['kind']): string {
  switch (kind) {
    case 'stale_base':
    case 'merge_conflict':
      return uiMessage('account.sync-text.2383');
    case 'edit_versus_delete':
      return uiMessage('account.sync-text.2384');
    case 'delete_versus_edit':
      return uiMessage('account.sync-text.2385');
    case 'create_collision':
      return uiMessage('account.sync-text.2386');
  }
}

export const choiceLabels: Readonly<Record<ConflictChoiceName, string>> = {
  keep_local: uiMessage('account.sync-text.2387'),
  keep_remote: uiMessage('account.sync-text.2388'),
  merge: uiMessage('account.conflicts-page.140'),
  keep_deleted: uiMessage('account.sync-text.2389'),
  restore_edited: uiMessage('account.sync-text.2390'),
};

export const choiceHelp: Readonly<Record<ConflictChoiceName, string>> = {
  keep_local: uiMessage('account.sync-text.2391'),
  keep_remote: uiMessage('account.sync-text.2392'),
  merge: uiMessage('account.sync-text.2393'),
  keep_deleted: uiMessage('account.sync-text.2394'),
  restore_edited: uiMessage('account.sync-text.2395'),
};

/** The status shown on the list after a resolution. */
export function resolvedText(choice: ConflictChoice['choice'], title: string): string {
  switch (choice) {
    case 'keep_local':
      return uiMessage('account.sync-text.2396', { value0: title });
    case 'keep_remote':
      return uiMessage('account.sync-text.2397', { value0: title });
    case 'merge':
      return uiMessage('account.sync-text.2398', { value0: title });
    case 'keep_deleted':
      return uiMessage('account.sync-text.2399', { value0: title });
    case 'restore_edited':
      return uiMessage('account.sync-text.2400', { value0: title });
  }
}

/** One side of a field in words: a deleted side says so, a missing value is "Not set". */
export function fieldSideText(
  field: ConflictFieldView,
  side: 'base' | 'local' | 'remote',
  kind: ConflictSummaryView['kind'],
): string {
  const value = field[side];
  if (value !== undefined) return value;
  if (side === 'local' && kind === 'delete_versus_edit')
    return uiMessage('import.import-panel.972');
  if (side === 'remote' && kind === 'edit_versus_delete')
    return uiMessage('import.import-panel.972');
  return uiMessage('account.sync-text.2401');
}

/* ───────────────────────── Times ───────────────────────── */

export interface TimeDisplay {
  readonly timeZone?: string;
  readonly timeFormat?: '12_hour' | '24_hour';
}

/** An instant as a date and time, in the planning zone and time format when they are known. */
export function formatSyncTime(iso: string, display: TimeDisplay = {}): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const base: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(display.timeFormat === undefined ? {} : { hour12: display.timeFormat === '12_hour' }),
  };
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...base,
      ...(display.timeZone === undefined ? {} : { timeZone: display.timeZone }),
    }).format(date);
  } catch {
    // An unknown zone falls back to the device's own.
    return new Intl.DateTimeFormat(undefined, base).format(date);
  }
}
