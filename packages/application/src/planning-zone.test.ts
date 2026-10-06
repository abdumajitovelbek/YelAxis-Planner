import {
  createEntityRef,
  entityRefKey,
  occurrenceLogicalKey,
  routineOccurrenceId,
  type CalendarDate,
  type EntityType,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import type {
  PlanProfile,
  PlanningApplication,
  PlanningQueryPort,
  RoutineDocument,
  RoutineOccurrenceDocument,
  TimeBlockDocument,
} from './planning-contracts';
import { createPlanningApplication } from './planning';
import { createTestPlanningQueries } from './planning-routines-test-queries';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
// Monday 2026-10-05, 09:00 in London.
const now = '2026-10-05T08:00:00.000Z' as Instant;
const london = 'Europe/London' as IanaTimeZone;
const newYork = 'America/New_York' as IanaTimeZone;
const profileId = '10000000-0000-4000-8000-0000000000aa' as UUID;
const followId = '60000000-0000-4000-8000-000000000001' as UUID;
const fixedId = '60000000-0000-4000-8000-000000000002' as UUID;
const flexibleId = '60000000-0000-4000-8000-000000000003' as UUID;
const blockId = '50000000-0000-4000-8000-000000000001' as UUID;

const profileDocument = { planningTimeZone: london, weekStart: 'monday', timeFormat: '24_hour' };
const daily = { version: 1, kind: 'daily', intervalDays: 1, startsOn: '2026-10-01' };
const timed = (wallTime: string, zonePolicy: Readonly<Record<string, unknown>>) => ({
  kind: 'time_specific',
  wallTime,
  durationMinutes: 30,
  zonePolicy,
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
});
const routine = (title: string, schedulingMode: unknown): RoutineDocument =>
  ({
    title,
    orderKey: '500000000000000',
    state: 'active',
    generations: [{ generation: 1, rule: daily, schedulingMode }],
  }) as unknown as RoutineDocument;

const completedPeriod = { kind: 'date', date: '2026-10-05' as CalendarDate } as const;
const completedOccurrenceId = routineOccurrenceId(
  occurrenceLogicalKey(followId, 1, completedPeriod),
);
const blockDocument: TimeBlockDocument = {
  target: { kind: 'custom', title: 'Dentist' },
  startsAt: '2026-10-07T13:00:00.000Z' as Instant,
  endsAt: '2026-10-07T14:00:00.000Z' as Instant,
  timeZone: london,
  state: 'planned',
  overlapAcknowledged: false,
};

let harness: InMemoryHarness;
let planning: PlanningApplication;
let syncEnabled: boolean;

function seed(type: EntityType, id: UUID, document: Readonly<Record<string, unknown>>): void {
  harness.unitOfWork.seed({
    ref: createEntityRef(type, id, ownerId),
    localRevision: 1,
    serverRevision: 0,
    baseSnapshotHash: null,
    document,
  });
}

function record(type: EntityType, id: UUID): CanonicalRecordState | undefined {
  return harness.unitOfWork.get(entityRefKey(createEntityRef(type, id, ownerId)));
}

function accepted(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function rejection(result: ApplicationResult<unknown>): unknown {
  if (result.ok) throw new Error('Expected a rejection.');
  if (result.error.code !== 'domain_rejected') return result.error.code;
  return result.error.domainError.details?.['reason'] ?? result.error.domainError.code;
}

/** The test query port, reading the Profile from the in-memory canonical record. */
function queries(): PlanningQueryPort {
  const base = createTestPlanningQueries(harness.unitOfWork, {
    profileId,
    planningTimeZone: london,
    weekStart: 'monday',
    timeFormat: '24_hour',
  });
  return {
    ...base,
    getPlanProfile: () => {
      const current = record('profile', profileId);
      if (current === undefined) return Promise.reject(new Error('No profile.'));
      const profile: PlanProfile = {
        profileId,
        planningTimeZone: current.document['planningTimeZone'] as IanaTimeZone,
        weekStart: 'monday',
        timeFormat: '24_hour',
        localRevision: current.localRevision,
      };
      return Promise.resolve(profile);
    },
  };
}

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  syncEnabled = false;
  planning = createPlanningApplication(
    {
      ...harness.dependencies,
      identityContext: {
        getActiveIdentity: () => Promise.resolve({ ownerId, syncEnabled }),
      },
    },
    queries(),
  );
  seed('profile', profileId, profileDocument);
  seed('routine', followId, routine('Morning run', timed('07:00', { kind: 'follow_profile' })));
  seed(
    'routine',
    fixedId,
    routine('Team call', timed('09:00', { kind: 'fixed_zone', timeZone: london })),
  );
  seed('routine', flexibleId, routine('Stretch', { kind: 'day_flexible' }));
  seed('routine_occurrence', completedOccurrenceId, {
    routineId: followId,
    generation: 1,
    periodKey: '2026-10-05',
    period: completedPeriod,
    state: 'completed',
    completedAt: '2026-10-05T06:30:00.000Z' as Instant,
  } satisfies RoutineOccurrenceDocument);
  seed('time_block', blockId, blockDocument);
});

describe('previewPlanningZoneChange', () => {
  it('previews follow-profile, fixed-zone, and day-flexible Routines without writing', async () => {
    const result = await planning.previewPlanningZoneChange('America/New_York');
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const preview = result.value;
    expect(preview).toMatchObject({
      from: london,
      to: newYork,
      window: { start: '2026-10-05', end: '2026-11-01' },
      profileRevision: 1,
      dateOnlyRoutineCount: 1,
    });
    const [follow, fixed] = preview.routines;
    expect(follow?.title).toBe('Morning run');
    expect(follow?.policy).toEqual({ kind: 'follow_profile' });
    // The completed 2026-10-05 run is history and is never listed.
    expect(follow?.occurrences.map((item) => item.date)).toEqual([
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ]);
    expect(follow?.occurrences[0]).toMatchObject({
      instantChanges: true,
      before: { startsAt: '2026-10-06T06:00:00.000Z', localTime: '02:00' },
      after: { startsAt: '2026-10-06T11:00:00.000Z', localTime: '07:00' },
    });
    expect(fixed?.policy).toEqual({ kind: 'fixed_zone', timeZone: london });
    expect(fixed?.occurrences[0]).toMatchObject({
      date: '2026-10-05',
      instantChanges: false,
      after: { startsAt: '2026-10-05T08:00:00.000Z', wallTime: '09:00', localTime: '04:00' },
    });
    expect(harness.unitOfWork.state.events).toEqual([]);
    expect(record('profile', profileId)?.localRevision).toBe(1);
  });

  it('rejects an invalid IANA zone', async () => {
    const result = await planning.previewPlanningZoneChange('Mars/Olympus');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('domain_rejected');
  });
});

describe('changePlanningZone', () => {
  it('writes only the Profile zone with a minimized event, receipt, and outbox', async () => {
    syncEnabled = true;
    const receipt = accepted(
      await planning.changePlanningZone({ zone: 'America/New_York', revision: 1 }),
    );
    expect(receipt.canonical).toEqual([
      { ref: createEntityRef('profile', profileId, ownerId), localRevision: 2 },
    ]);
    expect(receipt.undo.available).toBe(true);
    expect(receipt.sync.queued).toBe(true);
    expect(record('profile', profileId)?.document).toEqual({
      ...profileDocument,
      planningTimeZone: newYork,
    });
    const events = harness.unitOfWork.state.events;
    expect(events).toHaveLength(1);
    expect(events[0]?.event.eventType).toBe('profile.planning_zone_changed');
    expect(events[0]?.event.payload).toEqual({ operation: 'update' });
    expect(harness.unitOfWork.state.outbox).toHaveLength(1);
    // Fixed Time Blocks keep their instants; completed history is unchanged.
    expect(record('time_block', blockId)?.document).toEqual(blockDocument);
    expect(record('time_block', blockId)?.localRevision).toBe(1);
    expect(record('routine_occurrence', completedOccurrenceId)?.localRevision).toBe(1);
    expect(record('routine_occurrence', completedOccurrenceId)?.document['state']).toBe(
      'completed',
    );
    expect(record('routine', followId)?.localRevision).toBe(1);
  });

  it('undo restores the prior planning zone', async () => {
    const receipt = accepted(
      await planning.changePlanningZone({ zone: 'America/New_York', revision: 1 }),
    );
    if (!receipt.undo.available) throw new Error('Undo unavailable.');
    accepted(await planning.undo(receipt.undo.undoId));
    const restored = record('profile', profileId);
    expect(restored?.document).toEqual(profileDocument);
    expect(restored?.localRevision).toBe(3);
  });

  it('rejects a stale revision and changes nothing', async () => {
    const result = await planning.changePlanningZone({ zone: 'America/New_York', revision: 7 });
    expect(rejection(result)).toBe('revision_conflict');
    expect(record('profile', profileId)?.document).toEqual(profileDocument);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });

  it('rejects an invalid zone and the current zone without writing', async () => {
    const invalidZone = await planning.changePlanningZone({ zone: '+03:00', revision: 1 });
    expect(invalidZone.ok).toBe(false);
    if (!invalidZone.ok) expect(invalidZone.error.code).toBe('domain_rejected');
    const same = await planning.changePlanningZone({ zone: 'Europe/London', revision: 1 });
    expect(rejection(same)).toBe('no_change');
    expect(record('profile', profileId)?.localRevision).toBe(1);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });
});
