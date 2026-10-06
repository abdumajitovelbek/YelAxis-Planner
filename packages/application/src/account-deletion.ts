import type { Instant, UUID } from '@yelaxis/domain';

import type { AccountDeletionEvent, AccountDeletionStatus } from './account-contracts';

/** No deletion was requested. */
export const noAccountDeletion: AccountDeletionStatus = Object.freeze({
  phase: 'none',
  requestId: null,
  requestedAt: null,
  confirmedAt: null,
  localCopy: null,
  errorCode: null,
});

const errorCodePattern = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * Account deletion transitions:
 *
 * - `none` → `requested` once the password is verified and this device's copy is chosen;
 * - `requested`, `pending` (a resumed call), or `failed_recoverable` (retry) → `pending` while the
 * server deletion runs;
 * - `pending` → `confirmed` or `failed_recoverable`; `requested` → `failed_recoverable`;
 * - `requested`, `pending`, or `failed_recoverable` → `none` on cancel;
 * - `confirmed` is final: the session is cleared and the local-copy choice applies.
 *
 * Returns null for any other transition.
 */
export function nextAccountDeletionStatus(
  current: AccountDeletionStatus,
  event: AccountDeletionEvent,
  context: { readonly now: Instant; readonly requestId: UUID },
): AccountDeletionStatus | null {
  switch (event.kind) {
    case 'request':
      return current.phase === 'none'
        ? {
            phase: 'requested',
            requestId: context.requestId,
            requestedAt: context.now,
            confirmedAt: null,
            localCopy: event.localCopy,
            errorCode: null,
          }
        : null;
    case 'start':
      return current.phase === 'requested' ||
        current.phase === 'pending' ||
        current.phase === 'failed_recoverable'
        ? { ...current, phase: 'pending', errorCode: null }
        : null;
    case 'confirm':
      return current.phase === 'pending'
        ? { ...current, phase: 'confirmed', confirmedAt: context.now, errorCode: null }
        : null;
    case 'fail':
      return (current.phase === 'pending' || current.phase === 'requested') &&
        errorCodePattern.test(event.errorCode)
        ? { ...current, phase: 'failed_recoverable', errorCode: event.errorCode }
        : null;
    case 'cancel':
      return current.phase === 'requested' ||
        current.phase === 'pending' ||
        current.phase === 'failed_recoverable'
        ? noAccountDeletion
        : null;
  }
}

/** Pushes stay frozen from the request until a cancel, so queued work cannot recreate data. */
export function accountDeletionFreezesPushes(status: AccountDeletionStatus): boolean {
  return status.phase !== 'none';
}
