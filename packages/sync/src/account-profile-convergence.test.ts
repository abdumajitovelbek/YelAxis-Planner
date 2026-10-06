/**
 * Two devices of one account meet on ONE Profile through the in-memory protocol server:
 * a replica seeded for an empty account creates the account's Profile under the id derived from
 * the account subject, and a device that links its local plan later renames its own Profile (and
 * every record that names it) to that id. An identical planning Profile is accepted as the same
 * record; different planning preferences are exactly one explicit same-id create collision that
 * waits for a person, never a second Profile and never the last write.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAccountApplication,
  createOnboardingApplication,
  createSerialQueue,
  createSyncApplication,
  executeCommand,
  seededAccountProfileId,
  type AccountApplication,
  type OnboardingApplication,
  type SyncApplication,
} from '@yelaxis/application';
import {
  createSqliteAccountAdapters,
  createSqliteApplicationAdapters,
  runMigrations,
  schemaMigrations,
  SqliteOnboardingPersistence,
  SqliteSyncStore,
} from '@yelaxis/data';
import {
  ok,
  type EntityRef,
  type OnboardingDefaults,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeSqliteTestDriver } from './__fixtures__/node-sqlite-driver';
import { ManualTime } from './__fixtures__/replica';
import { createSyncCoordinator, type SyncCoordinator } from './coordinator';
import { createSnapshotHasher } from './hasher';
import { FakeSyncServer } from './testing';

const subject = '5a000000-0000-4000-8000-000000000001';
const accountId = subject as OwnerId;
const accountProfileId = seededAccountProfileId(subject);

/** The planning preferences: the whole synchronized Profile document. */
type Preferences = Omit<OnboardingDefaults, 'locale'>;
const seeded: Preferences = {
  planningTimeZone: 'Asia/Tashkent',
  weekStart: 'monday',
  timeFormat: '24_hour',
};

interface Device {
  readonly driver: NodeSqliteTestDriver;
  readonly onboarding: OnboardingApplication;
  readonly accounts: AccountApplication;
  readonly sync: SyncApplication;
  readonly coordinator: SyncCoordinator;
  /** Creates a month Theme that names `profileId`, through the command pipeline. */
  createTheme(ownerId: OwnerId, profileId: UUID): Promise<UUID>;
  profiles(): Promise<readonly object[]>;
}

const directories: string[] = [];
const devices: Device[] = [];

afterEach(async () => {
  for (const device of devices.splice(0)) {
    await device.coordinator.stop();
    await device.driver.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function openDevice(name: 'aa' | 'bb', server: FakeSyncServer, time: ManualTime) {
  const directory = mkdtempSync(join(tmpdir(), 'yelaxis-profile-'));
  directories.push(directory);
  const driver = new NodeSqliteTestDriver(join(directory, `${name}.sqlite`));
  await runMigrations(driver, schemaMigrations, () => time.instant());
  let counter = 0;
  const ids = {
    next: () => {
      counter += 1;
      return `${name}000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as UUID;
    },
  };
  const clock = { now: () => time.instant() };
  const { store, bundles } = createSqliteAccountAdapters(driver);
  const accounts = createAccountApplication({ store, bundles, clock, ids, appVersion: 'test' });
  const sync = createSyncApplication(
    { store: new SqliteSyncStore(driver), clock, ids, hasher: createSnapshotHasher() },
    { queue: createSerialQueue() },
  );
  const coordinator = createSyncCoordinator({
    application: sync,
    transport: server.transport(),
    now: () => time.now,
    scheduler: time.scheduler,
    network: { isOnline: () => true, subscribe: () => () => undefined },
    visibility: { isVisible: () => false, subscribe: () => () => undefined },
    random: () => 0.5,
  });
  const device: Device = {
    driver,
    onboarding: createOnboardingApplication(new SqliteOnboardingPersistence(driver), {
      clock,
      ids,
    }),
    accounts,
    sync,
    coordinator,
    async createTheme(ownerId, profileId) {
      const ref: EntityRef = { type: 'theme', id: ids.next(), ownerId };
      const result = await executeCommand(
        {
          ...createSqliteApplicationAdapters(driver),
          clock,
          ids,
          projections: { notifyCommitted: () => undefined },
        },
        { commandId: ids.next(), ownerId, actor: 'user', expectedRevisions: [], input: {} },
        ({ context }) =>
          ok({
            value: [
              {
                operation: 'create',
                ref,
                expectedRevision: null,
                baseServerRevision: 0,
                baseSnapshotHash: null,
                document: { profileId, month: '2026-10', text: 'Fewer things' },
              },
            ],
            touched: [ref],
            events: [
              {
                aggregate: ref,
                eventType: 'test.create',
                version: 1,
                actor: context.actor,
                commandId: context.commandId,
                occurredAt: context.now,
                payload: { operation: 'create' },
              },
            ],
          }),
      );
      if (!result.ok) throw new Error(`Theme not created: ${result.error.code}`);
      return ref.id;
    },
    profiles: () =>
      driver.all<object>(
        `SELECT id, owner_id, planning_time_zone, week_start, time_format FROM profiles
         ORDER BY id;`,
      ),
  };
  devices.push(device);
  return device;
}

/**
 * Device A seeded the account and uploaded its Profile; device B has a local plan with its own
 * Profile (`preferences`) and a month Theme that names it, and links it to the same account.
 */
async function accountWithLinkingDevice(preferences: Preferences) {
  const server = new FakeSyncServer();
  const time = new ManualTime();
  const a = await openDevice('aa', server, time);
  const created = await a.accounts.createAccountReplica({
    accountSubjectId: subject,
    profileSeed: {
      ...seeded,
      preferredName: null,
      localeOverride: null,
      defaultsConfirmedAt: null,
      onboarding: {
        status: 'not_started',
        step: 'welcome',
        completedSteps: [],
        skippedSteps: [],
        completedAt: null,
      },
      handbook: { status: 'not_started', lesson: 0, completedLessons: [] },
    },
  });
  if (!created.ok) throw new Error(created.error.code);
  await a.coordinator.syncNow();

  const b = await openDevice('bb', server, time);
  const local = await b.onboarding.initialize({ ...preferences, locale: 'en' });
  expect(local.profileId).not.toBe(accountProfileId);
  const themeId = await b.createTheme(local.ownerId, local.profileId);
  const linked = await b.accounts.linkToAccount({ accountSubjectId: subject, backupId: null });
  if (!linked.ok) throw new Error(linked.error.code);
  return { server, a, b, local, themeId };
}

function serverProfiles(server: FakeSyncServer) {
  return [...server.records.values()].filter((record) => record.entityType === 'profile');
}

describe('one Profile per account across devices', () => {
  it('accepts an identical planning Profile from a linked plan as the same record', async () => {
    const { server, a, b, themeId } = await accountWithLinkingDevice(seeded);

    await b.coordinator.syncNow();
    await a.coordinator.syncNow();

    expect(server.openConflictList()).toEqual([]);
    expect(serverProfiles(server)).toMatchObject([
      { entityId: accountProfileId, revision: 1, document: seeded },
    ]);
    // The Theme refers to the account's Profile on the server and on both devices.
    expect(server.liveDocuments().get(`theme:${themeId}`)).toMatchObject({
      profileId: accountProfileId,
    });
    for (const device of [a, b]) {
      await expect(device.profiles()).resolves.toEqual([
        {
          id: accountProfileId,
          owner_id: accountId,
          planning_time_zone: 'Asia/Tashkent',
          week_start: 'monday',
          time_format: '24_hour',
        },
      ]);
      await expect(
        device.driver.get<object>('SELECT profile_id FROM month_themes WHERE id = ?;', [themeId]),
      ).resolves.toEqual({ profile_id: accountProfileId });
      await expect(device.sync.listConflicts()).resolves.toEqual([]);
      expect(device.coordinator.getStatus()).toMatchObject({ pendingChanges: 0, openConflicts: 0 });
    }
    await expect(b.accounts.completeLinkIfReady()).resolves.toEqual({
      ok: true,
      value: { linked: true },
    });
  });

  it('makes different preferences one create collision, never a second Profile', async () => {
    const { server, a, b, themeId } = await accountWithLinkingDevice({
      ...seeded,
      timeFormat: '12_hour',
    });

    await b.coordinator.syncNow();
    await a.coordinator.syncNow();

    // One candidate on the server; the account's Profile and the waiting group stay as they were.
    expect(server.openConflictList()).toMatchObject([
      { entityType: 'profile', entityId: accountProfileId, kind: 'create_collision' },
    ]);
    expect(serverProfiles(server)).toMatchObject([
      { entityId: accountProfileId, revision: 1, document: seeded },
    ]);
    expect(server.liveDocuments().has(`theme:${themeId}`)).toBe(false);
    const conflicts = await b.sync.listConflicts();
    expect(conflicts).toMatchObject([
      {
        entityType: 'profile',
        entityId: accountProfileId,
        kind: 'create_collision',
        origin: 'this_device',
        local: { deleted: false, document: { ...seeded, timeFormat: '12_hour' } },
        remote: { deleted: false, document: seeded },
      },
    ]);
    expect(b.coordinator.getStatus()).toMatchObject({ state: 'needs_attention', openConflicts: 1 });
    // The seeding device shows the same single candidate as another device's version.
    await expect(a.sync.listConflicts()).resolves.toMatchObject([
      {
        entityType: 'profile',
        entityId: accountProfileId,
        kind: 'create_collision',
        origin: 'other_device',
        local: { deleted: false, document: seeded },
        remote: { deleted: false, document: { ...seeded, timeFormat: '12_hour' } },
      },
    ]);
    // Nothing silently won, and no device holds a second Profile.
    await expect(b.profiles()).resolves.toMatchObject([
      { id: accountProfileId, owner_id: accountId, time_format: '12_hour' },
    ]);
    await expect(a.profiles()).resolves.toMatchObject([
      { id: accountProfileId, owner_id: accountId, time_format: '24_hour' },
    ]);
    await expect(b.accounts.completeLinkIfReady()).resolves.toEqual({
      ok: true,
      value: { linked: false },
    });

    // The person keeps this device's preferences: both devices and the server converge on them.
    const conflict = conflicts[0];
    if (conflict === undefined) throw new Error('A conflict is open.');
    await expect(
      b.sync.resolveConflict(conflict.conflictId, { choice: 'keep_local' }),
    ).resolves.toMatchObject({ ok: true });
    for (let round = 0; round < 3; round += 1) {
      await b.coordinator.syncNow();
      await a.coordinator.syncNow();
    }
    expect(server.openConflictList()).toEqual([]);
    expect(serverProfiles(server)).toMatchObject([
      { entityId: accountProfileId, document: { ...seeded, timeFormat: '12_hour' } },
    ]);
    expect(server.liveDocuments().get(`theme:${themeId}`)).toMatchObject({
      profileId: accountProfileId,
    });
    for (const device of [a, b]) {
      await expect(device.profiles()).resolves.toMatchObject([
        { id: accountProfileId, time_format: '12_hour' },
      ]);
      await expect(device.sync.listConflicts()).resolves.toEqual([]);
    }
    await expect(b.accounts.completeLinkIfReady()).resolves.toEqual({
      ok: true,
      value: { linked: true },
    });
  });
});
