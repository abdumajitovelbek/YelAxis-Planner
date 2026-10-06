import type { Instant, UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import type { AccountDeletionEvent, AccountDeletionStatus } from './account-contracts';
import {
  accountDeletionFreezesPushes,
  nextAccountDeletionStatus,
  noAccountDeletion,
} from './account-deletion';

const now = '2026-10-01T10:00:00.000Z' as Instant;
const later = '2026-10-01T10:05:00.000Z' as Instant;
const requestId = '50000000-0000-4000-8000-000000000001' as UUID;

const requested: AccountDeletionStatus = {
  phase: 'requested',
  requestId,
  requestedAt: now,
  confirmedAt: null,
  localCopy: 'delete',
  errorCode: null,
};
const pending: AccountDeletionStatus = { ...requested, phase: 'pending' };
const failed: AccountDeletionStatus = {
  ...requested,
  phase: 'failed_recoverable',
  errorCode: 'server_unavailable',
};
const confirmed: AccountDeletionStatus = { ...requested, phase: 'confirmed', confirmedAt: later };

const next = (current: AccountDeletionStatus, event: AccountDeletionEvent, at: Instant = now) =>
  nextAccountDeletionStatus(current, event, { now: at, requestId });

describe('account deletion transitions', () => {
  it('requests, runs, and confirms a deletion with the chosen local copy', () => {
    expect(next(noAccountDeletion, { kind: 'request', localCopy: 'delete' })).toEqual(requested);
    expect(next(requested, { kind: 'start' })).toEqual(pending);
    expect(next(pending, { kind: 'confirm' }, later)).toEqual(confirmed);
  });

  it('keeps a recoverable failure with retry and cancel', () => {
    expect(next(pending, { kind: 'fail', errorCode: 'server_unavailable' })).toEqual(failed);
    expect(next(requested, { kind: 'fail', errorCode: 'offline' })).toMatchObject({
      phase: 'failed_recoverable',
      errorCode: 'offline',
    });
    expect(next(failed, { kind: 'start' })).toEqual({ ...pending, errorCode: null });
    // A call interrupted by a restart can run again.
    expect(next(pending, { kind: 'start' })).toEqual(pending);
    for (const status of [requested, pending, failed]) {
      expect(next(status, { kind: 'cancel' })).toEqual(noAccountDeletion);
    }
  });

  it('refuses every other transition, and content as an error code', () => {
    expect(next(requested, { kind: 'request', localCopy: 'keep' })).toBeNull();
    expect(next(noAccountDeletion, { kind: 'start' })).toBeNull();
    expect(next(noAccountDeletion, { kind: 'confirm' })).toBeNull();
    expect(next(requested, { kind: 'confirm' })).toBeNull();
    expect(next(noAccountDeletion, { kind: 'cancel' })).toBeNull();
    expect(next(failed, { kind: 'fail', errorCode: 'again' })).toBeNull();
    for (const event of [
      { kind: 'request', localCopy: 'keep' },
      { kind: 'start' },
      { kind: 'confirm' },
      { kind: 'fail', errorCode: 'late' },
      { kind: 'cancel' },
    ] as const) {
      expect(next(confirmed, event)).toBeNull();
    }
    expect(next(pending, { kind: 'fail', errorCode: 'Private plan title' })).toBeNull();
    expect(next(pending, { kind: 'fail', errorCode: '' })).toBeNull();
  });

  it('freezes pushes from the request until a cancel', () => {
    expect(accountDeletionFreezesPushes(noAccountDeletion)).toBe(false);
    for (const status of [requested, pending, failed, confirmed]) {
      expect(accountDeletionFreezesPushes(status)).toBe(true);
    }
  });
});
