import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPlanningApplication,
  type ApplicationDependencies,
  type ApplicationResult,
  type CommandReceipt,
} from '@yelaxis/application';
import type { Instant, OwnerId, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { SqlitePlanningQueries } from '../queries/planning-queries';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { SqliteOnboardingPersistence } from './onboarding-adapter';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

/**
 * / evidence: the composed planning application changes only the Profile
 * planning zone in real SQLite; fixed Time Blocks keep their instants, onboarding state stays
 * readable, undo restores the prior zone, and the change survives a restart.
 */
const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const profileId = '11000000-0000-4000-8000-000000000001';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-planning-zone-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'plan.sqlite');
  const state = { now: '2026-10-05T12:00:00.000Z' as Instant, idCounter: 1 };
  const ids = {
    next() {
      const suffix = state.idCounter.toString(16).padStart(12, '0');
      state.idCounter += 1;
      return `90000000-0000-4000-8000-${suffix}` as UUID;
    },
  };
  const first = new NodeSqliteDriver(path);
  await runMigrations(first, schemaMigrations, () => state.now);
  await first.run(
    `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
     VALUES (?, 'local', ?, ?);`,
    [ownerId, state.now, state.now],
  );
  await first.run(
    `INSERT INTO profiles (
       id, owner_id, preferred_name, planning_time_zone, week_start, time_format, locale_override,
       onboarding_status, onboarding_step, defaults_confirmed_at, created_at, updated_at
     ) VALUES (?, ?, 'Sam', 'America/New_York', 'monday', '24_hour', 'en',
               'completed', 'handbook', ?, ?, ?);`,
    [profileId, ownerId, state.now, state.now, state.now],
  );
  const open = (driver: NodeSqliteDriver) => {
    const adapters = createSqliteApplicationAdapters(driver, { ownerId });
    const dependencies: ApplicationDependencies = {
      ...adapters,
      ids,
      clock: { now: () => state.now },
      projections: { notifyCommitted() {} },
    };
    return {
      driver,
      planning: createPlanningApplication(dependencies, new SqlitePlanningQueries(driver)),
      onboarding: new SqliteOnboardingPersistence(driver),
    };
  };
  let current = open(first);
  return {
    get: () => current,
    async restart() {
      await current.driver.close();
      const reopened = new NodeSqliteDriver(path);
      await runMigrations(reopened, schemaMigrations, () => state.now);
      current = open(reopened);
      return current;
    },
  };
}

function receipt(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

const profileRow = (driver: NodeSqliteDriver) =>
  driver.get<{
    planning_time_zone: string;
    week_start: string;
    time_format: string;
    preferred_name: string;
    onboarding_status: string;
    local_revision: number;
  }>(
    `SELECT planning_time_zone, week_start, time_format, preferred_name, onboarding_status,
            local_revision
     FROM profiles WHERE id = ?;`,
    [profileId],
  );

const blockRows = (driver: NodeSqliteDriver) =>
  driver.all<{ starts_at_utc: string; ends_at_utc: string; time_zone: string }>(
    'SELECT starts_at_utc, ends_at_utc, time_zone FROM time_blocks ORDER BY id;',
  );

describe('planning-zone change on real SQLite', () => {
  it('previews, changes only the Profile zone, survives restart, and undoes', async () => {
    const context = await fixture();
    const { planning, driver } = context.get();
    receipt(
      await planning.createCustomBlock({
        title: 'Dentist',
        date: '2026-10-07',
        startTime: '09:00',
        durationMinutes: 60,
        overlapAcknowledged: false,
      }),
    );
    receipt(
      await planning.createRoutine({
        title: 'Morning run',
        rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-10-05' },
        schedulingMode: {
          kind: 'time_specific',
          wallTime: '07:00',
          durationMinutes: 30,
          zonePolicy: { kind: 'follow_profile' },
          gapPolicy: 'shift_forward',
          overlapPolicy: 'earlier_offset',
        },
      }),
    );
    const blocksBefore = await blockRows(driver);
    expect(blocksBefore).toEqual([
      {
        starts_at_utc: '2026-10-07T13:00:00.000Z',
        ends_at_utc: '2026-10-07T14:00:00.000Z',
        time_zone: 'America/New_York',
      },
    ]);
    const before = await planning.getCapacitySettings();
    expect(before.profile).toMatchObject({
      planningTimeZone: 'America/New_York',
      localRevision: 1,
    });

    const preview = await planning.previewPlanningZoneChange('Europe/London');
    if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    expect(preview.value.profileRevision).toBe(1);
    expect(preview.value.routines[0]).toMatchObject({
      title: 'Morning run',
      policy: { kind: 'follow_profile' },
    });
    expect(preview.value.routines[0]?.occurrences[0]).toMatchObject({
      date: '2026-10-06',
      instantChanges: true,
      after: { startsAt: '2026-10-06T06:00:00.000Z', localTime: '07:00' },
    });
    // The preview writes nothing.
    await expect(profileRow(driver)).resolves.toMatchObject({ local_revision: 1 });

    const stale = await planning.changePlanningZone({ zone: 'Europe/London', revision: 9 });
    expect(stale).toMatchObject({ ok: false, error: { code: 'revision_conflict' } });

    const changed = receipt(
      await planning.changePlanningZone({ zone: 'Europe/London', revision: 1 }),
    );
    expect(changed.undo.available).toBe(true);
    await expect(profileRow(driver)).resolves.toEqual({
      planning_time_zone: 'Europe/London',
      week_start: 'monday',
      time_format: '24_hour',
      preferred_name: 'Sam',
      onboarding_status: 'completed',
      local_revision: 2,
    });
    await expect(blockRows(driver)).resolves.toEqual(blocksBefore);
    const events = await driver.all<{ event_type: string; payload_json: string }>(
      `SELECT event_type, payload_json FROM domain_events
       WHERE entity_type = 'profile' ORDER BY rowid;`,
    );
    expect(events).toEqual([
      { event_type: 'profile.planning_zone_changed', payload_json: '{"operation":"update"}' },
    ]);

    // onboarding persistence still reads the Profile it owns.
    const onboarding = await context.get().onboarding.load();
    expect(onboarding).toMatchObject({ status: 'completed', profileRevision: 2 });

    const reopened = await context.restart();
    await expect(reopened.planning.getCapacitySettings()).resolves.toMatchObject({
      profile: { planningTimeZone: 'Europe/London', localRevision: 2 },
    });
    await expect(blockRows(reopened.driver)).resolves.toEqual(blocksBefore);

    if (!changed.undo.available) throw new Error('Expected undo.');
    receipt(await reopened.planning.undo(changed.undo.undoId));
    await expect(profileRow(reopened.driver)).resolves.toMatchObject({
      planning_time_zone: 'America/New_York',
      local_revision: 3,
    });
    await expect(reopened.onboarding.load()).resolves.toMatchObject({
      status: 'completed',
      profileRevision: 3,
    });
    await reopened.driver.close();
  });

  it('rejects an invalid zone without touching the Profile', async () => {
    const context = await fixture();
    const { planning, driver } = context.get();
    const result = await planning.changePlanningZone({ zone: 'Not/AZone', revision: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: 'domain_rejected' } });
    await expect(profileRow(driver)).resolves.toMatchObject({
      planning_time_zone: 'America/New_York',
      local_revision: 1,
    });
    await driver.close();
  });
});
