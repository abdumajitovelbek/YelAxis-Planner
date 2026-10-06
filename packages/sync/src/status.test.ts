import type { SyncFacts } from '@yelaxis/application';
import type { Instant } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import { aggregateSyncStatus, type SyncStatusInput } from './status';

const facts: SyncFacts = {
  link: 'linked',
  deletion: 'none',
  pending: 0,
  sending: 0,
  waiting: 0,
  blocked: 0,
  rejected: 0,
  unconfirmed: 0,
  openConflicts: 0,
  cursor: '4',
  lastSuccessAt: '2026-10-01T09:00:00.000Z' as Instant,
};

const input: SyncStatusInput = {
  configured: true,
  account: { email: 'person@example.test' },
  signingIn: false,
  facts,
  syncing: false,
  authExpired: false,
  lastFailure: null,
  online: true,
  retryAt: null,
};

const state = (overrides: Partial<SyncStatusInput>, factOverrides: Partial<SyncFacts> = {}) =>
  aggregateSyncStatus({ ...input, ...overrides, facts: { ...facts, ...factOverrides } }).state;

describe('visible sync state', () => {
  it('is local only without configuration or an account identity', () => {
    expect(state({ configured: false })).toBe('local_only');
    expect(state({}, { link: 'local' })).toBe('local_only');
    expect(state({}, { link: 'none' })).toBe('local_only');
    expect(
      aggregateSyncStatus({ ...input, facts: { ...facts, link: 'local' } }),
    ).not.toHaveProperty('account');
  });

  it('shows signing in, deletion pending, and an expired session before anything else', () => {
    expect(state({ signingIn: true }, { link: 'local' })).toBe('signing_in');
    expect(state({ authExpired: true }, { deletion: 'pending', openConflicts: 2 })).toBe(
      'deletion_pending',
    );
    expect(state({ authExpired: true }, { openConflicts: 2 })).toBe('auth_expired');
  });

  it('needs attention for open conflicts or rejected groups', () => {
    expect(state({}, { openConflicts: 1 })).toBe('needs_attention');
    expect(state({ syncing: true }, { rejected: 1 })).toBe('needs_attention');
  });

  it('shows the first upload with its progress', () => {
    const status = aggregateSyncStatus({
      ...input,
      syncing: true,
      facts: {
        ...facts,
        link: 'linking',
        firstUpload: { uploaded: 120, total: 400 },
        pending: 280,
      },
    });
    expect(status).toMatchObject({
      state: 'first_upload',
      firstUpload: { uploaded: 120, total: 400 },
      pendingChanges: 280,
    });
  });

  it('distinguishes syncing, queued offline, server unavailable, and synced', () => {
    expect(state({ syncing: true })).toBe('syncing');
    expect(state({ online: false }, { pending: 2 })).toBe('queued_offline');
    expect(state({ lastFailure: 'offline' }, { waiting: 1 })).toBe('queued_offline');
    expect(state({ online: false })).toBe('synced');
    const { lastSuccessAt, ...neverSynced } = facts;
    expect(lastSuccessAt).toBeDefined();
    expect(aggregateSyncStatus({ ...input, online: false, facts: neverSynced }).state).toBe(
      'queued_offline',
    );
    expect(state({ lastFailure: 'unavailable' }, { waiting: 1 })).toBe('server_unavailable');
    expect(state({}, { pending: 1 })).toBe('syncing');
    expect(state({})).toBe('synced');
  });

  it('counts pending changes and shows the next retry only while waiting', () => {
    const waiting = aggregateSyncStatus({
      ...input,
      lastFailure: 'unavailable',
      retryAt: '2026-10-01T09:10:00.000Z',
      facts: {
        ...facts,
        pending: 1,
        sending: 1,
        waiting: 2,
        blocked: 3,
        rejected: 4,
        nextAttemptAt: '2026-10-01T09:05:00.000Z' as Instant,
      },
    });
    expect(waiting).toEqual({
      state: 'needs_attention',
      configured: true,
      account: { email: 'person@example.test' },
      pendingChanges: 7,
      openConflicts: 0,
      rejectedChanges: 4,
      lastSyncedAt: '2026-10-01T09:00:00.000Z',
    });
    const unavailable = aggregateSyncStatus({
      ...input,
      lastFailure: 'unavailable',
      retryAt: '2026-10-01T09:10:00.000Z',
      facts: { ...facts, waiting: 1, nextAttemptAt: '2026-10-01T09:05:00.000Z' as Instant },
    });
    expect(unavailable).toMatchObject({
      state: 'server_unavailable',
      nextAttemptAt: '2026-10-01T09:05:00.000Z',
    });
  });
});
