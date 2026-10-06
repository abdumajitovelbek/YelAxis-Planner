import { describe, expect, it } from 'vitest';

import type { SyncStateName, SyncStatus } from './account-service';
import {
  accountOpenedText,
  accountOutcomes,
  choiceHelp,
  choiceLabels,
  conflictKindText,
  fieldSideText,
  formatSyncTime,
  notConfiguredText,
  resolvedText,
  syncShortText,
  syncStateSentence,
  todaySyncNotice,
} from './sync-text';

const status = (overrides: Partial<SyncStatus> = {}): SyncStatus => ({
  state: 'local_only',
  configured: true,
  pendingChanges: 0,
  openConflicts: 0,
  rejectedChanges: 0,
  ...overrides,
});

const allStates: readonly SyncStateName[] = [
  'local_only',
  'signing_in',
  'first_upload',
  'syncing',
  'queued_offline',
  'synced',
  'needs_attention',
  'auth_expired',
  'server_unavailable',
  'deletion_pending',
];

/** Calm copy: no score, pressure, blame, loss framing, notification promise, or AI wording. */
const forbidden =
  /\b(streak|score|grade|productivity|behind|fail(ed|ure)?|missed|penalty|lost|AI|notif\w*|urgent|warning)\b/iu;

describe('sync state words', () => {
  it('gives the app frame a short state, and nothing for a local-only identity', () => {
    expect(syncShortText(status())).toBeNull();
    expect(syncShortText(status({ state: 'signing_in' }))).toBe('Signing in…');
    expect(syncShortText(status({ state: 'first_upload' }))).toBe('Uploading this plan');
    expect(
      syncShortText(status({ state: 'first_upload', firstUpload: { uploaded: 4, total: 20 } })),
    ).toBe('Uploading this plan: 4 of 20');
    expect(syncShortText(status({ state: 'syncing' }))).toBe('Syncing…');
    expect(syncShortText(status({ state: 'queued_offline' }))).toBe('Offline');
    expect(syncShortText(status({ state: 'queued_offline', pendingChanges: 1 }))).toBe(
      'Offline: 1 change waiting',
    );
    expect(syncShortText(status({ state: 'queued_offline', pendingChanges: 3 }))).toBe(
      'Offline: 3 changes waiting',
    );
    expect(syncShortText(status({ state: 'synced' }))).toBe('Synced');
    expect(syncShortText(status({ state: 'needs_attention' }))).toBe('Sync needs attention');
    expect(syncShortText(status({ state: 'auth_expired' }))).toBe('Sign in again to sync');
    expect(syncShortText(status({ state: 'server_unavailable' }))).toBe('Sync server unavailable');
    expect(syncShortText(status({ state: 'deletion_pending' }))).toBe('Account deletion pending');
  });

  it('says each state in a sentence that names the next safe action', () => {
    expect(syncStateSentence(status())).toBe('This plan is only on this device.');
    expect(syncStateSentence(status({ state: 'synced' }))).toBe(
      'Everything on this device is synced.',
    );
    expect(syncStateSentence(status({ state: 'queued_offline', pendingChanges: 1 }))).toBe(
      'You are offline. 1 change is saved on this device and waits to sync until you are back online.',
    );
    expect(syncStateSentence(status({ state: 'queued_offline', pendingChanges: 2 }))).toBe(
      'You are offline. 2 changes are saved on this device and wait to sync until you are back online.',
    );
    expect(syncStateSentence(status({ state: 'queued_offline' }))).toBe(
      'You are offline. Sync continues when you are back online.',
    );
    expect(syncStateSentence(status({ state: 'auth_expired' }))).toMatch(
      /^Your session ended\. Sign in again to keep syncing\./u,
    );
    expect(syncStateSentence(status({ state: 'server_unavailable' }))).toBe(
      'The sync server cannot be reached right now. Your changes are saved on this device, and sync tries again later.',
    );
    expect(syncStateSentence(status({ state: 'deletion_pending' }))).toBe(
      'Account deletion is pending. Changes on this device are not sent while it is pending.',
    );
  });

  it('names what needs attention: conflicts, changes not accepted, or both', () => {
    // Neither: pulled changes could not be applied or kept here (never "conflicts" or "rejected").
    expect(syncStateSentence(status({ state: 'needs_attention' }))).toBe(
      'Sync needs your attention: changes from your account could not be applied on this device yet. Your plan here keeps working, and Sync now tries again.',
    );
    expect(todaySyncNotice(status({ state: 'needs_attention' }))).toEqual({
      text: 'Sync needs your attention. Your plan on this device keeps working.',
      link: { to: '/account', label: 'Open Account' },
    });
    expect(syncStateSentence(status({ state: 'needs_attention', openConflicts: 1 }))).toBe(
      'Sync needs your attention: 1 conflict needs your choice.',
    );
    expect(
      syncStateSentence(status({ state: 'needs_attention', openConflicts: 2, rejectedChanges: 1 })),
    ).toBe(
      'Sync needs your attention: 2 conflicts need your choice, and 1 change could not be synced.',
    );
  });

  it('keeps every state calm', () => {
    for (const state of allStates) {
      const value = status({ state, pendingChanges: 2, openConflicts: 1, rejectedChanges: 1 });
      expect(syncStateSentence(value)).not.toMatch(forbidden);
      expect(syncShortText(value) ?? '').not.toMatch(forbidden);
      expect(todaySyncNotice(value)?.text ?? '').not.toMatch(forbidden);
    }
    expect(notConfiguredText).toBe(
      'Account sync is not available in this build. Your plan stays on this device.',
    );
  });

  it('says what an account operation did in calm words, never an email beyond the open one', () => {
    for (const text of Object.values(accountOutcomes)) {
      expect(text).not.toMatch(forbidden);
      expect(text).not.toContain('@');
    }
    expect(accountOpenedText('sam@example.test')).toBe(
      'Signed in as sam@example.test. Your account’s plan is open.',
    );
  });
});

describe('the Today sync line', () => {
  it('stays silent unless something waits or needs an action', () => {
    for (const state of ['local_only', 'signing_in', 'first_upload', 'syncing', 'synced'] as const)
      expect(todaySyncNotice(status({ state, pendingChanges: 3, openConflicts: 0 }))).toBeNull();
    expect(todaySyncNotice(status({ state: 'queued_offline', pendingChanges: 0 }))).toBeNull();
  });

  it('names what waits, with a link to the next step', () => {
    expect(todaySyncNotice(status({ state: 'queued_offline', pendingChanges: 1 }))).toEqual({
      text: '1 change waits to sync. It is saved on this device.',
      link: { to: '/account', label: 'Open Account' },
    });
    expect(todaySyncNotice(status({ state: 'queued_offline', pendingChanges: 4 }))?.text).toBe(
      '4 changes wait to sync. They are saved on this device.',
    );
    expect(todaySyncNotice(status({ state: 'needs_attention', openConflicts: 2 }))).toEqual({
      text: 'Sync needs your choice on 2 conflicts.',
      link: { to: '/account/conflicts', label: 'Review conflicts' },
    });
    // Rejected changes stay here; Account offers to try sending them again.
    expect(todaySyncNotice(status({ state: 'needs_attention', rejectedChanges: 1 }))).toEqual({
      text: 'Your account did not accept some changes. They stay on this device.',
      link: { to: '/account', label: 'Open Account' },
    });
    expect(todaySyncNotice(status({ state: 'server_unavailable' }))).toEqual({
      text: 'Sync is paused because the server cannot be reached. Your changes are saved on this device.',
      link: { to: '/account', label: 'Open Account' },
    });
    expect(todaySyncNotice(status({ state: 'auth_expired' }))).toEqual({
      text: 'Your session ended. Your changes are saved on this device.',
      link: { to: '/account', label: 'Sign in again' },
    });
    expect(todaySyncNotice(status({ state: 'deletion_pending' }))).toEqual({
      text: 'Account deletion is pending.',
      link: { to: '/account', label: 'Open Account' },
    });
  });
});

describe('conflict words', () => {
  it('describes each kind from this device’s side', () => {
    expect(conflictKindText('stale_base')).toBe('Changed on this device and on the other device.');
    expect(conflictKindText('merge_conflict')).toBe(
      'Changed on this device and on the other device.',
    );
    expect(conflictKindText('edit_versus_delete')).toBe(
      'Edited on this device and deleted on the other device.',
    );
    expect(conflictKindText('delete_versus_edit')).toBe(
      'Deleted on this device and edited on the other device.',
    );
    expect(conflictKindText('create_collision')).toBe(
      'Created on this device and on the other device as different versions.',
    );
  });

  it('labels every choice and its result', () => {
    expect(choiceLabels).toEqual({
      keep_local: 'Keep this device’s version',
      keep_remote: 'Keep the other version',
      merge: 'Merge details',
      keep_deleted: 'Keep it deleted',
      restore_edited: 'Restore the edited version',
    });
    for (const help of Object.values(choiceHelp)) expect(help).not.toMatch(forbidden);
    expect(resolvedText('keep_local', 'Plan the trip')).toBe(
      'Conflict resolved for Plan the trip: kept this device’s version.',
    );
    expect(resolvedText('keep_remote', 'Plan the trip')).toBe(
      'Conflict resolved for Plan the trip: kept the other version.',
    );
    expect(resolvedText('merge', 'Plan the trip')).toBe(
      'Conflict resolved for Plan the trip: saved the merged version.',
    );
    expect(resolvedText('keep_deleted', 'Plan the trip')).toBe(
      'Conflict resolved for Plan the trip: it stays deleted.',
    );
    expect(resolvedText('restore_edited', 'Plan the trip')).toBe(
      'Conflict resolved for Plan the trip: restored the edited version.',
    );
  });

  it('shows a deleted side as Deleted and a missing value as Not set', () => {
    const field = { field: 'title', label: 'Title', base: 'Before', local: 'Mine' } as const;
    expect(fieldSideText(field, 'local', 'stale_base')).toBe('Mine');
    expect(fieldSideText(field, 'remote', 'stale_base')).toBe('Not set');
    expect(fieldSideText(field, 'remote', 'edit_versus_delete')).toBe('Deleted');
    expect(fieldSideText({ field: 'title', label: 'Title' }, 'local', 'delete_versus_edit')).toBe(
      'Deleted',
    );
    expect(fieldSideText({ field: 'title', label: 'Title' }, 'base', 'create_collision')).toBe(
      'Not set',
    );
  });
});

describe('sync times', () => {
  it('formats an instant in the planning zone and time format', () => {
    const iso = '2026-10-01T16:05:00.000Z';
    const twentyFour = formatSyncTime(iso, { timeZone: 'UTC', timeFormat: '24_hour' });
    const twelve = formatSyncTime(iso, { timeZone: 'UTC', timeFormat: '12_hour' });
    expect(twentyFour).toContain('16:05');
    expect(twelve).toMatch(/4:05\s?PM/u);
    expect(formatSyncTime(iso, { timeZone: 'Asia/Tashkent', timeFormat: '24_hour' })).toContain(
      '21:05',
    );
  });

  it('never throws: an unreadable instant is null and an unknown zone uses the device zone', () => {
    expect(formatSyncTime('not a time')).toBeNull();
    expect(formatSyncTime('2026-10-01T16:05:00.000Z', { timeZone: 'Nowhere/Unknown' })).toBe(
      formatSyncTime('2026-10-01T16:05:00.000Z'),
    );
  });
});
