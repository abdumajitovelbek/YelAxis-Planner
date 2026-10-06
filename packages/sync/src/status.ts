/**
 * Visible sync state (sync and conflict contract, user-visible aggregate states). One
 * state at a time, most actionable first; no state ever blocks a control.
 */
import type { SyncFacts } from '@yelaxis/application';

import type { SyncStateName, SyncStatus } from './controller-contract';

export interface SyncStatusInput {
  readonly configured: boolean;
  readonly account: { readonly email: string } | null;
  /** The identity part is signing in (the identity is still local meanwhile). */
  readonly signingIn: boolean;
  readonly facts: SyncFacts | null;
  /** A push/pull cycle is running. */
  readonly syncing: boolean;
  /** Network work is paused until the person signs in again. */
  readonly authExpired: boolean;
  /** Why the last network work stopped, when it did not finish. */
  readonly lastFailure: 'offline' | 'unavailable' | null;
  readonly online: boolean;
  /** The coordinator's own retry time (pull or conflict calls) after a transient failure. */
  readonly retryAt: string | null;
  /**
   * Pulled changes can be neither applied nor kept as conflicts on this device, so the cursor
   * cannot move: sync needs attention (it is not a server outage).
   */
  readonly pullRefused?: boolean;
}

function earliest(left: string | undefined, right: string | null): string | undefined {
  if (left === undefined) return right ?? undefined;
  if (right === null) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

export function aggregateSyncStatus(input: SyncStatusInput): SyncStatus {
  const facts = input.facts;
  const pendingChanges =
    facts === null ? 0 : facts.pending + facts.sending + facts.waiting + facts.blocked;
  const openConflicts = facts?.openConflicts ?? 0;
  const rejectedChanges = facts?.rejected ?? 0;
  const nextAttemptAt = earliest(facts?.nextAttemptAt, input.retryAt);
  const state = stateOf(input, pendingChanges);
  const showsRetry = state === 'server_unavailable' || state === 'queued_offline';
  return {
    state,
    configured: input.configured,
    ...(input.account === null || state === 'local_only' ? {} : { account: input.account }),
    pendingChanges,
    openConflicts,
    rejectedChanges,
    ...(facts?.lastSuccessAt === undefined ? {} : { lastSyncedAt: facts.lastSuccessAt }),
    ...(showsRetry && nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
    ...(facts?.link === 'linking' && facts.firstUpload !== undefined
      ? { firstUpload: facts.firstUpload }
      : {}),
  };
}

function stateOf(input: SyncStatusInput, pendingChanges: number): SyncStateName {
  const facts = input.facts;
  if (!input.configured) return 'local_only';
  if (input.signingIn) return 'signing_in';
  if (facts === null || facts.link === 'none' || facts.link === 'local') return 'local_only';
  if (facts.deletion === 'pending') return 'deletion_pending';
  if (input.authExpired) return 'auth_expired';
  if (facts.openConflicts > 0 || facts.rejected > 0 || input.pullRefused === true) {
    return 'needs_attention';
  }
  if (facts.link === 'linking') return 'first_upload';
  if (input.syncing) return 'syncing';
  if (!input.online || input.lastFailure === 'offline') {
    return pendingChanges > 0 || facts.lastSuccessAt === undefined ? 'queued_offline' : 'synced';
  }
  if (input.lastFailure === 'unavailable') return 'server_unavailable';
  if (pendingChanges > 0) return 'syncing';
  return 'synced';
}
