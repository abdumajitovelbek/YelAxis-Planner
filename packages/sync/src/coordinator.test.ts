/**
 * Coordinator behaviour with a fake transport and a manual clock: triggers and single flight over a
 * fake application, retry timing that never spins on a time already past, stopping, then backoff,
 * outage and recovery, expired session pause and resume without duplicate upload
 * restart with a `sending` group, and rejected groups (dead letter)
 * over real SQLite replicas.
 */
import type {
  SyncApplication,
  SyncFacts,
  SyncOutgoingGroup,
  SyncPullApplyResult,
} from '@yelaxis/application';
import type { Instant, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { actionDocument, ManualTime, Replica, removeReplicaFiles } from './__fixtures__/replica';
import { createSyncCoordinator } from './coordinator';
import type { PullResponse, SyncTransport, TransportResult } from './protocol';
import { FakeSyncServer, type FakeTransport } from './testing';

const replicaId = 'a1000000-0000-4000-8000-000000000001' as UUID;

/* ───────────────────────── Fakes ───────────────────────── */

const linkedFacts: SyncFacts = {
  link: 'linked',
  ownerId: '0a000000-0000-4000-8000-000000000001' as NonNullable<SyncFacts['ownerId']>,
  replicaId,
  deletion: 'none',
  pending: 0,
  sending: 0,
  waiting: 0,
  blocked: 0,
  rejected: 0,
  unconfirmed: 0,
  openConflicts: 0,
  cursor: null,
};

function fakeApplication(calls: string[]): SyncApplication {
  let cursor: string | null = null;
  let lastSuccessAt: string | undefined;
  return {
    facts: () =>
      Promise.resolve({
        ...linkedFacts,
        cursor,
        ...(lastSuccessAt === undefined
          ? {}
          : { lastSuccessAt: lastSuccessAt as SyncFacts['nextAttemptAt'] & string }),
      }),
    recoverStranded: () => {
      calls.push('recoverStranded');
      return Promise.resolve(0);
    },
    retryNow: () => {
      calls.push('retryNow');
      return Promise.resolve(0);
    },
    retryRejected: () => Promise.resolve(0),
    claimNextGroup: () => {
      calls.push('claim');
      return Promise.resolve(null);
    },
    recordPushOutcome: () => Promise.resolve({ status: 'stale' }),
    applyPulledPages: (pages): Promise<SyncPullApplyResult> => {
      calls.push('apply');
      const last = pages.at(-1);
      cursor = last?.nextCursor ?? cursor;
      if (last?.hasMore !== true) lastSuccessAt = '2026-10-01T09:00:00.000Z';
      return Promise.resolve({
        status: 'applied',
        cursor: last?.nextCursor ?? '0',
        caughtUp: last?.hasMore !== true,
        applied: 0,
        merged: 0,
        conflicts: 0,
        unchanged: 0,
        queuedPushes: false,
      });
    },
    restartFromBeginning: () => Promise.resolve(),
    mergeServerConflicts: () => Promise.resolve(0),
    pendingServerClosures: () => Promise.resolve([]),
    confirmServerClosure: () => Promise.resolve(),
    listConflicts: () => Promise.resolve([]),
    getConflict: () => Promise.resolve(null),
    resolveConflict: () => Promise.resolve({ ok: false, code: 'not_found' }),
  };
}

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function countingTransport(calls: string[], hold?: Gate): SyncTransport {
  const page: PullResponse = { status: 'page', changes: [], nextCursor: '0', hasMore: false };
  return {
    push: () => Promise.resolve({ ok: false, failure: { kind: 'unavailable' } }),
    async pull(): Promise<TransportResult<PullResponse>> {
      calls.push('pull');
      if (hold !== undefined) await hold.promise;
      return { ok: true, value: page };
    },
    openConflicts: () => {
      calls.push('openConflicts');
      return Promise.resolve({ ok: true, value: [] });
    },
    closeConflict: () => Promise.resolve({ ok: true, value: { closed: true } }),
  };
}

function signal() {
  const listeners = new Set<(value: boolean) => void>();
  let value = true;
  return {
    get: () => value,
    set(next: boolean) {
      value = next;
      for (const listener of listeners) listener(next);
    },
    subscribe: (listener: (value: boolean) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeCoordinator(options: { hold?: Gate } = {}) {
  const calls: string[] = [];
  const time = new ManualTime();
  const online = signal();
  const visible = signal();
  const coordinator = createSyncCoordinator({
    application: fakeApplication(calls),
    transport: countingTransport(calls, options.hold),
    now: () => time.now,
    scheduler: time.scheduler,
    network: { isOnline: () => online.get(), subscribe: (listener) => online.subscribe(listener) },
    visibility: {
      isVisible: () => visible.get(),
      subscribe: (listener) => visible.subscribe(listener),
    },
    random: () => 0.5,
  });
  return { calls, time, online, visible, coordinator };
}

describe('coordinator triggers', () => {
  it('bounds normal pull transactions, keeps first-upload capacity and honors explicit pages', async () => {
    for (const [configured, linking, expected] of [
      [undefined, true, 500],
      [undefined, false, 250],
      [50, true, 50],
      [50, false, 50],
      [900, false, 500],
    ] as const) {
      const calls: string[] = [];
      const limits: number[] = [];
      const transport = countingTransport(calls);
      const time = new ManualTime();
      const application = fakeApplication(calls);
      const coordinator = createSyncCoordinator({
        application: {
          ...application,
          facts: async () => ({
            ...(await application.facts()),
            link: linking ? 'linking' : 'linked',
          }),
        },
        transport: {
          ...transport,
          pull: (request) => {
            limits.push(request.limit);
            return transport.pull(request);
          },
        },
        now: () => time.now,
        scheduler: time.scheduler,
        network: { isOnline: () => true, subscribe: () => () => undefined },
        visibility: { isVisible: () => true, subscribe: () => () => undefined },
        ...(configured === undefined ? {} : { pullPageSize: configured }),
      });
      coordinator.start();
      await coordinator.syncNow();
      expect(limits.length).toBeGreaterThan(0);
      expect(limits.every((limit) => limit === expected)).toBe(true);
      expect(calls).toContain('apply');
      await coordinator.stop();
    }
  });
  it('recovers stranded groups at launch, then pushes and pulls', async () => {
    const { calls, coordinator } = fakeCoordinator();
    coordinator.start();
    await coordinator.syncNow();
    expect(calls.slice(0, 5)).toEqual([
      'recoverStranded',
      'retryNow',
      'claim',
      'openConflicts',
      'pull',
    ]);
    await coordinator.stop();
  });

  it('runs one cycle at a time and coalesces concurrent requests into one more', async () => {
    const hold = gate();
    const { calls, coordinator } = fakeCoordinator({ hold });
    const first = coordinator.syncNow();
    await flush();
    const second = coordinator.syncNow();
    const third = coordinator.syncNow();
    expect(calls.filter((call) => call === 'pull')).toHaveLength(1);
    hold.open();
    await Promise.all([first, second, third]);
    expect(calls.filter((call) => call === 'pull')).toHaveLength(2);
    expect(coordinator.getStatus().state).toBe('synced');
  });

  it('syncs once after a burst of committed changes (debounced)', async () => {
    const { calls, coordinator, time } = fakeCoordinator();
    coordinator.notifyLocalChange();
    time.advance(500);
    coordinator.notifyLocalChange();
    time.advance(500);
    coordinator.notifyLocalChange();
    time.advance(1_999);
    await flush();
    expect(calls.filter((call) => call === 'pull')).toHaveLength(0);
    time.advance(1);
    await flush();
    expect(calls.filter((call) => call === 'pull')).toHaveLength(1);
  });

  it('syncs every 60 seconds while visible, and not while hidden', async () => {
    const { calls, coordinator, time, visible } = fakeCoordinator();
    coordinator.start();
    await flush();
    const pulls = () => calls.filter((call) => call === 'pull').length;
    expect(pulls()).toBe(1);
    time.advance(60_000);
    await flush();
    expect(pulls()).toBe(2);
    visible.set(false);
    await flush();
    time.advance(5 * 60_000);
    await flush();
    expect(pulls()).toBe(2);
    visible.set(true);
    await flush();
    expect(pulls()).toBe(3);
    await coordinator.stop();
  });

  it('syncs when the browser comes back online', async () => {
    const { calls, coordinator, online } = fakeCoordinator();
    coordinator.start();
    await flush();
    online.set(false);
    await flush();
    expect(coordinator.getStatus().state).toBe('synced');
    online.set(true);
    await flush();
    expect(calls.filter((call) => call === 'pull')).toHaveLength(2);
    await coordinator.stop();
  });

  it('never rejects, even when the application fails', async () => {
    const application = fakeApplication([]);
    const coordinator = createSyncCoordinator({
      application: { ...application, claimNextGroup: () => Promise.reject(new Error('disk')) },
      transport: countingTransport([]),
      now: () => 0,
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
      network: { isOnline: () => true, subscribe: () => () => undefined },
      visibility: { isVisible: () => false, subscribe: () => () => undefined },
    });
    await expect(coordinator.syncNow()).resolves.toBeUndefined();
    expect(coordinator.getStatus().state).toBe('server_unavailable');
    await expect(
      createSyncCoordinator({
        application: { ...application, retryRejected: () => Promise.reject(new Error('disk')) },
        transport: countingTransport([]),
        now: () => 0,
        scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
        network: { isOnline: () => true, subscribe: () => () => undefined },
        visibility: { isVisible: () => false, subscribe: () => () => undefined },
      }).retryRejected(),
    ).resolves.toBeUndefined();
  });
});

/* ───────────────────────── Retry timing ───────────────────────── */

const groupId = 'a2000000-0000-4000-8000-000000000001' as UUID;
const operationId = 'a3000000-0000-4000-8000-000000000001' as UUID;
const entityId = 'a4000000-0000-4000-8000-000000000001' as UUID;

/**
 * One group whose first push fails transiently; it then waits `groupBackoffMs` (its own backoff,
 * independent of the coordinator's jitter). Every later server call answers.
 */
function oneGroupCoordinator(groupBackoffMs: number, coordinatorRandom: number) {
  const time = new ManualTime();
  const calls: string[] = [];
  let state: 'pending' | 'sending' | 'retry_wait' | 'acknowledged' = 'pending';
  let attempts = 0;
  let due = time.now;
  const outgoing = (): SyncOutgoingGroup => ({
    mutationGroupId: groupId,
    replicaId,
    attempt: attempts,
    operations: [
      {
        operationId,
        sequence: 0,
        entityType: 'action',
        entityId,
        kind: 'create',
        baseServerRevision: 0,
        baseSnapshotHash: null,
        document: { title: 'Call' },
      },
    ],
  });
  const application: SyncApplication = {
    ...fakeApplication(calls),
    facts: () =>
      Promise.resolve({
        ...linkedFacts,
        pending: state === 'pending' ? 1 : 0,
        waiting: state === 'retry_wait' ? 1 : 0,
        unconfirmed: attempts > 0 && state !== 'acknowledged' ? 1 : 0,
        ...(state === 'retry_wait'
          ? { nextAttemptAt: new Date(due).toISOString() as Instant }
          : {}),
      }),
    claimNextGroup: () => {
      calls.push('claim');
      if (state === 'pending' || (state === 'retry_wait' && time.now >= due)) {
        state = 'sending';
        attempts += 1;
        return Promise.resolve(outgoing());
      }
      return Promise.resolve(null);
    },
    recordPushOutcome: (_group, outcome) => {
      if (outcome.kind === 'transient') {
        state = 'retry_wait';
        due = time.now + groupBackoffMs;
        return Promise.resolve({
          status: 'retry_wait',
          nextAttemptAt: new Date(due).toISOString() as Instant,
        });
      }
      state = 'acknowledged';
      return Promise.resolve({ status: 'acknowledged' });
    },
  };
  let pushes = 0;
  const transport: SyncTransport = {
    push: (request) => {
      calls.push('push');
      pushes += 1;
      if (pushes === 1) {
        return Promise.resolve({ ok: false, failure: { kind: 'unavailable', status: 503 } });
      }
      return Promise.resolve({
        ok: true,
        value: {
          status: 'accepted',
          mutationGroupId: request.mutationGroupId,
          acknowledgments: [{ operationId, entityType: 'action', entityId, serverRevision: 1 }],
          cursor: '1',
        },
      });
    },
    pull: () => {
      calls.push('pull');
      return Promise.resolve({
        ok: true,
        value: { status: 'page', changes: [], nextCursor: '1', hasMore: false },
      });
    },
    openConflicts: () => {
      calls.push('openConflicts');
      return Promise.resolve({ ok: true, value: [] });
    },
    closeConflict: () => Promise.resolve({ ok: true, value: { closed: true } }),
  };
  const coordinator = createSyncCoordinator({
    application,
    transport,
    now: () => time.now,
    scheduler: time.scheduler,
    network: { isOnline: () => true, subscribe: () => () => undefined },
    visibility: { isVisible: () => true, subscribe: () => () => undefined },
    random: () => coordinatorRandom,
  });
  return { time, calls, coordinator, state: () => state };
}

/** Move the clock to the earliest timer, fire it, and let the cycle it starts finish. */
async function fireNextTimer(time: ManualTime): Promise<void> {
  const at = time.nextTimerAt();
  if (at === null) throw new Error('A timer is set.');
  time.advance(at - time.now);
  await flush();
}

describe('retry timing (no timer storm on a time already past)', () => {
  it('waits for the coordinator retry when the group is due first, then pushes and pulls', async () => {
    // The group's own backoff ends at 4.0 s; the coordinator retries at 5.98 s.
    const { time, calls, coordinator, state } = oneGroupCoordinator(4_000, 0.99);
    coordinator.start();
    await flush();
    expect(calls.filter((call) => call === 'push')).toHaveLength(1);
    const started = time.now;
    time.delays.length = 0;
    calls.length = 0;
    await fireNextTimer(time);
    expect(time.now - started).toBe(5_980);
    expect(state()).toBe('acknowledged');
    expect(calls).toEqual([
      'recoverStranded',
      'claim',
      'push',
      'claim',
      'openConflicts',
      'pull',
      'apply',
    ]);
    expect(coordinator.getStatus().state).toBe('synced');
    // Only the regular interval is left; no timer ever asked for less than a second.
    expect(time.delays).toEqual([60_000]);
    await coordinator.stop();
  });

  it('runs one cycle at the coordinator retry, then waits for the group instead of spinning', async () => {
    // The coordinator retries at 4.0 s; the group's own backoff ends at 5.98 s.
    const { time, calls, coordinator, state } = oneGroupCoordinator(5_980, 0);
    coordinator.start();
    await flush();
    const started = time.now;
    time.delays.length = 0;
    calls.length = 0;
    await fireNextTimer(time);
    expect(time.now - started).toBe(4_000);
    // Nothing to push yet; the server answered, so the outage is over, and pulls wait for the
    // group that was sent without an answer.
    expect(calls.filter((call) => call === 'openConflicts')).toHaveLength(1);
    expect(calls).not.toContain('pull');
    expect(coordinator.getStatus().state).not.toBe('server_unavailable');
    expect(time.delays).toEqual([1_980]);
    await fireNextTimer(time);
    expect(time.now - started).toBe(5_980);
    expect(state()).toBe('acknowledged');
    expect(calls.filter((call) => call === 'push')).toHaveLength(1);
    expect(calls.filter((call) => call === 'pull')).toHaveLength(1);
    expect(calls.filter((call) => call === 'openConflicts')).toHaveLength(2);
    expect(coordinator.getStatus().state).toBe('synced');
    expect(time.delays).toEqual([1_980, 60_000]);
    await coordinator.stop();
  });

  it('never sets a timer for a time already past, whatever the facts say', async () => {
    const time = new ManualTime();
    const calls: string[] = [];
    const past = new Date(time.now - 60_000).toISOString() as Instant;
    const coordinator = createSyncCoordinator({
      application: {
        ...fakeApplication(calls),
        // A group due long ago that cannot be claimed (held), and a group sent without an answer.
        facts: () =>
          Promise.resolve({ ...linkedFacts, waiting: 1, unconfirmed: 1, nextAttemptAt: past }),
      },
      transport: countingTransport(calls),
      now: () => time.now,
      scheduler: time.scheduler,
      network: { isOnline: () => true, subscribe: () => () => undefined },
      visibility: { isVisible: () => false, subscribe: () => () => undefined },
      random: () => 0.5,
    });
    coordinator.start();
    await flush();
    expect(time.pendingTimers()).toBe(0);
    expect(calls.filter((call) => call === 'openConflicts')).toHaveLength(1);
    expect(calls).not.toContain('pull');
    await coordinator.stop();
  });
});

/* ───────────────────────── Stopping ───────────────────────── */

describe('stopping', () => {
  it('resolves once the running cycle has ended, which stops at its next step', async () => {
    const hold = gate();
    const { calls, coordinator } = fakeCoordinator({ hold });
    const running = coordinator.syncNow();
    await flush();
    expect(calls.at(-1)).toBe('pull');
    let stopped = false;
    const stopping = coordinator.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    hold.open();
    await stopping;
    // The page that arrived while stopping is not applied: the next coordinator pulls it again.
    expect(calls).not.toContain('apply');
    await running;
    const after = calls.length;
    await coordinator.syncNow();
    coordinator.notifyLocalChange();
    await coordinator.retryRejected();
    await flush();
    expect(calls).toHaveLength(after);
  });

  it('also waits for a retry a person started, and runs no cycle after it', async () => {
    const hold = gate();
    const calls: string[] = [];
    const coordinator = createSyncCoordinator({
      application: {
        ...fakeApplication(calls),
        retryRejected: async () => {
          calls.push('retryRejected');
          await hold.promise;
          return 1;
        },
      },
      transport: countingTransport(calls),
      now: () => 0,
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
      network: { isOnline: () => true, subscribe: () => () => undefined },
      visibility: { isVisible: () => false, subscribe: () => () => undefined },
    });
    const retrying = coordinator.retryRejected();
    await flush();
    let stopped = false;
    const stopping = coordinator.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    hold.open();
    await Promise.all([stopping, retrying]);
    expect(calls).toEqual(['retryRejected']);
  });

  it('resolves at once with nothing running, and from inside its own settle hook', async () => {
    const { coordinator } = fakeCoordinator();
    await expect(coordinator.stop()).resolves.toBeUndefined();
    const time = new ManualTime();
    let stopping: Promise<void> | null = null;
    const settling = createSyncCoordinator({
      application: fakeApplication([]),
      transport: countingTransport([]),
      now: () => time.now,
      scheduler: time.scheduler,
      network: { isOnline: () => true, subscribe: () => () => undefined },
      visibility: { isVisible: () => true, subscribe: () => () => undefined },
      onCycleSettled: async () => {
        stopping = settling.stop();
        await stopping;
      },
    });
    settling.start();
    await settling.syncNow();
    expect(stopping).not.toBeNull();
    expect(time.pendingTimers()).toBe(0);
  });
});

/* ───────────────────────── Pages this device cannot hold ───────────────────────── */

describe('pulled pages that can be neither applied nor kept', () => {
  it('need attention instead of reporting the server unavailable, and retry with backoff', async () => {
    const time = new ManualTime();
    const calls: string[] = [];
    let refuse = true;
    const application = fakeApplication(calls);
    const coordinator = createSyncCoordinator({
      application: {
        ...application,
        applyPulledPages: (pages, options) =>
          refuse
            ? Promise.resolve({ status: 'refused' })
            : application.applyPulledPages(pages, options),
      },
      transport: countingTransport(calls),
      now: () => time.now,
      scheduler: time.scheduler,
      network: { isOnline: () => true, subscribe: () => () => undefined },
      visibility: { isVisible: () => true, subscribe: () => () => undefined },
      random: () => 0.5,
    });
    coordinator.start();
    await flush();
    expect(coordinator.getStatus()).toMatchObject({
      state: 'needs_attention',
      openConflicts: 0,
      rejectedChanges: 0,
    });
    expect(time.delays).toEqual([5_000]);
    // A local change meanwhile does not retry before the backoff ends.
    coordinator.notifyLocalChange();
    time.advance(2_000);
    await flush();
    expect(calls.filter((call) => call === 'pull')).toHaveLength(1);
    await fireNextTimer(time);
    expect(calls.filter((call) => call === 'pull')).toHaveLength(2);
    expect(time.delays.at(-1)).toBe(10_000);
    refuse = false;
    await fireNextTimer(time);
    expect(coordinator.getStatus().state).toBe('synced');
    await coordinator.stop();
  });
});

/* ───────────────────────── Real replicas ───────────────────────── */

const replicas: Replica[] = [];

async function replicaWithServer() {
  const server = new FakeSyncServer();
  const transport = server.transport();
  const replica = await Replica.open({ name: 'A', replicaId, transport, withProfile: true });
  replicas.push(replica);
  await replica.coordinator.syncNow();
  return { server, transport, replica };
}

async function outbox(replica: Replica) {
  return replica.driver.all<{
    state: string;
    attempt_count: number;
    next_attempt_at: string | null;
  }>('SELECT state, attempt_count, next_attempt_at FROM sync_outbox ORDER BY rowid;');
}

/** Wait (in real time) until the condition holds; replicas hash with Web Crypto off the main loop. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let round = 0; round < 500; round += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('The condition never held.');
}

/** A started coordinator over a replica's application, counting the cycles that settle. */
function countingCoordinator(replica: Replica, transport: SyncTransport, random: () => number) {
  let cycles = 0;
  const coordinator = createSyncCoordinator({
    application: replica.application,
    transport,
    now: () => replica.time.now,
    scheduler: replica.time.scheduler,
    network: { isOnline: () => true, subscribe: () => () => undefined },
    visibility: { isVisible: () => true, subscribe: () => () => undefined },
    random,
    onCycleSettled: () => {
      cycles += 1;
    },
  });
  return { coordinator, cycles: () => cycles };
}

const projectDocument = (title: string) => ({ title, orderKey: 'a0', state: 'idea' });

/** Another device renames a Project on the server (revision 2). */
async function renamedElsewhere(server: FakeSyncServer, projectId: UUID, title: string) {
  const record = server.records.get(`project:${projectId}`);
  const pushed = await server.transport().push({
    protocolVersion: 1,
    replicaId: 'b1000000-0000-4000-8000-000000000001',
    mutationGroupId: 'b2000000-0000-4000-8000-000000000001',
    operations: [
      {
        operationId: 'b3000000-0000-4000-8000-000000000001',
        sequence: 0,
        entityType: 'project',
        entityId: projectId,
        kind: 'update',
        baseServerRevision: record?.revision ?? 0,
        baseSnapshotHash: record?.hash ?? null,
        document: projectDocument(title),
      },
    ],
  });
  expect(pushed).toMatchObject({ ok: true, value: { status: 'accepted' } });
}

async function actionOperation(replica: Replica, actionId: UUID) {
  const row = await replica.driver.get<{ operation_id: string; mutation_group_id: string }>(
    `SELECT operation_id, mutation_group_id FROM sync_outbox
     WHERE entity_type = 'action' AND entity_id = ?;`,
    [actionId],
  );
  if (row === undefined) throw new Error('The Action is queued.');
  return row;
}

afterEach(async () => {
  for (const replica of replicas.splice(0)) await replica.close();
  removeReplicaFiles();
});

describe('backoff and outage', () => {
  it('backs off from 5 seconds, keeps the outbox, and recovers when the server returns', async () => {
    const { server, transport, replica } = await replicaWithServer();
    transport.mode = 'unavailable';
    const ref = await replica.create('action', actionDocument('During the outage'));
    await replica.coordinator.syncNow();
    const started = replica.time.now;
    expect(replica.coordinator.getStatus()).toMatchObject({
      state: 'server_unavailable',
      pendingChanges: 1,
      nextAttemptAt: new Date(started + 5_000).toISOString(),
    });
    expect(await outbox(replica)).toEqual([
      {
        state: 'retry_wait',
        attempt_count: 1,
        next_attempt_at: new Date(started + 5_000).toISOString(),
      },
    ]);
    // Local work continues during the outage.
    await replica.create('action', actionDocument('Still works offline'));
    const delays: number[] = [];
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const before = await outbox(replica);
      const next = Date.parse(before[0]?.next_attempt_at ?? '');
      delays.push(next - replica.time.now);
      replica.time.advance(next - replica.time.now);
      await flush();
      await replica.coordinator.syncNow();
    }
    expect(delays).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 900_000,
    ]);
    expect((await outbox(replica)).map((row) => row.state)).toContain('retry_wait');
    transport.mode = 'online';
    await replica.coordinator.syncNow();
    expect(replica.coordinator.getStatus()).toMatchObject({ state: 'synced', pendingChanges: 0 });
    expect(server.liveDocuments().get(`action:${ref.id}`)?.['title']).toBe('During the outage');
    expect(server.records.get(`action:${ref.id}`)?.revision).toBe(1);
  });

  it('shows queued offline while the browser is offline and sends nothing', async () => {
    const { transport, replica } = await replicaWithServer();
    replica.online = false;
    await replica.create('action', actionDocument('Offline edit'));
    const before = { ...transport.calls };
    await replica.coordinator.syncNow();
    expect(transport.calls).toEqual(before);
    expect(replica.coordinator.getStatus()).toMatchObject({
      state: 'queued_offline',
      pendingChanges: 1,
    });
    replica.online = true;
    await replica.coordinator.syncNow();
    expect(replica.coordinator.getStatus()).toMatchObject({ state: 'synced', pendingChanges: 0 });
  });
});

describe('a group sent without an answer, and a conflict on the record it needs', () => {
  it('keeps local order: the later edit waits for the unanswered group, then conflicts, and pulls resume', async () => {
    const { server, transport, replica } = await replicaWithServer();
    const project = await replica.create('project', projectDocument('Plan'));
    await replica.coordinator.syncNow();
    await renamedElsewhere(server, project.id, 'Theirs');
    // G2 files an Action under the Project; G3 renames the Project here too.
    const filed = await replica.create('action', actionDocument('Call', { projectId: project.id }));
    await replica.update(project, { title: 'Mine' });
    const sent = await actionOperation(replica, filed.id);
    // The coordinator retries at 4.0 s; the unanswered group's own backoff ends at 5.0 s.
    const { coordinator, cycles } = countingCoordinator(replica, transport, () => 0);
    replica.time.delays.length = 0;
    transport.mode = 'unavailable';
    coordinator.start();
    await until(() => cycles() >= 1);
    transport.mode = 'online';
    const pushes = transport.calls.push;
    for (let fired = 0; fired < 2; fired += 1) {
      const at = replica.time.nextTimerAt();
      if (at === null) throw new Error('A timer is set.');
      const settled = cycles();
      replica.time.advance(at - replica.time.now);
      await until(() => cycles() > settled);
    }
    // At 4.0 s nothing was pushed (the rename waits behind the group that needs the Project);
    // at 5.0 s the unanswered group went first with the same ids, then the rename conflicted.
    expect(transport.calls.push - pushes).toBe(2);
    expect(server.accepted.filter((id) => id === sent.operation_id)).toHaveLength(1);
    expect(server.records.get(`action:${filed.id}`)?.revision).toBe(1);
    expect(coordinator.getStatus()).toMatchObject({ state: 'needs_attention', openConflicts: 1 });
    expect((await replica.application.facts()).cursor).toBe(String(server.sequence));
    expect(Math.min(...replica.time.delays)).toBeGreaterThanOrEqual(1_000);
    await coordinator.stop();
  });

  it('sends it again with the same ids even while that record has a conflict, so pulls resume', async () => {
    const { server, transport, replica } = await replicaWithServer();
    const project = await replica.create('project', projectDocument('Plan'));
    await replica.coordinator.syncNow();
    await renamedElsewhere(server, project.id, 'Theirs');
    await replica.update(project, { title: 'Mine' });
    const filed = await replica.create('action', actionDocument('Call', { projectId: project.id }));
    await replica.coordinator.syncNow();
    expect(await replica.application.listConflicts()).toMatchObject([{ entityType: 'project' }]);
    // A store left by an earlier version: the Action's group was sent once and never answered.
    const sent = await actionOperation(replica, filed.id);
    await replica.driver.run(
      `UPDATE sync_outbox SET state = 'retry_wait', attempt_count = 1, next_attempt_at = ?
       WHERE mutation_group_id = ?;`,
      [new Date(replica.time.now + 5_000).toISOString(), sent.mutation_group_id],
    );
    expect((await replica.application.facts()).unconfirmed).toBe(1);
    const { coordinator, cycles } = countingCoordinator(replica, transport, () => 0.5);
    replica.time.delays.length = 0;
    coordinator.start();
    await until(() => cycles() >= 1);
    expect(server.accepted.filter((id) => id === sent.operation_id)).toHaveLength(1);
    expect((await replica.application.facts()).unconfirmed).toBe(0);
    expect((await replica.application.facts()).cursor).toBe(String(server.sequence));
    expect(coordinator.getStatus()).toMatchObject({ state: 'needs_attention', openConflicts: 1 });
    expect(Math.min(...replica.time.delays)).toBeGreaterThanOrEqual(1_000);
    await coordinator.stop();
  });
});

describe('expired session', () => {
  it('pauses network work, keeps local work, and resumes without a duplicate upload', async () => {
    const { server, transport, replica } = await replicaWithServer();
    transport.mode = 'auth_expired';
    const first = await replica.create('action', actionDocument('Before expiry'));
    await replica.coordinator.syncNow();
    expect(replica.coordinator.getStatus()).toMatchObject({
      state: 'auth_expired',
      pendingChanges: 1,
    });
    expect(await outbox(replica)).toEqual([
      expect.objectContaining({ state: 'pending', attempt_count: 0 }),
    ]);
    const calls = { ...transport.calls };
    const second = await replica.create('action', actionDocument('While expired'));
    replica.coordinator.notifyLocalChange();
    replica.time.advance(120_000);
    await flush();
    await replica.coordinator.syncNow();
    expect(transport.calls).toEqual(calls);
    transport.mode = 'online';
    await replica.coordinator.resume();
    expect(replica.coordinator.getStatus()).toMatchObject({ state: 'synced', pendingChanges: 0 });
    expect(server.records.get(`action:${first.id}`)?.revision).toBe(1);
    expect(server.records.get(`action:${second.id}`)?.revision).toBe(1);
    expect(new Set(server.accepted).size).toBe(server.accepted.length);
  });
});

describe('interrupted cycles', () => {
  it('never strand a group: the next cycle resends it with the same ids', async () => {
    const { server, transport, replica } = await replicaWithServer();
    const ref = await replica.create('action', actionDocument('Interrupted mid-push'));
    let thrown = false;
    const throwing: SyncTransport = {
      push: (request) => {
        if (!thrown) {
          thrown = true;
          return Promise.reject(new Error('unexpected'));
        }
        return transport.push(request);
      },
      pull: (request) => transport.pull(request),
      openConflicts: () => transport.openConflicts(),
      closeConflict: (request) => transport.closeConflict(request),
    };
    const coordinator = createSyncCoordinator({
      application: replica.application,
      transport: throwing,
      now: () => replica.time.now,
      scheduler: replica.time.scheduler,
      network: { isOnline: () => true, subscribe: () => () => undefined },
      visibility: { isVisible: () => false, subscribe: () => () => undefined },
    });
    await coordinator.syncNow();
    expect(await outbox(replica)).toEqual([expect.objectContaining({ state: 'sending' })]);
    await coordinator.syncNow();
    expect(server.records.get(`action:${ref.id}`)?.revision).toBe(1);
    expect(coordinator.getStatus()).toMatchObject({ state: 'synced', pendingChanges: 0 });
  });

  it('let the settle hook ask for another cycle without waiting on itself', async () => {
    const { replica, transport } = await replicaWithServer();
    let asked = 0;
    const coordinator = createSyncCoordinator({
      application: replica.application,
      transport,
      now: () => replica.time.now,
      scheduler: replica.time.scheduler,
      network: { isOnline: () => true, subscribe: () => () => undefined },
      visibility: { isVisible: () => false, subscribe: () => () => undefined },
      onCycleSettled: async () => {
        asked += 1;
        if (asked === 1) await coordinator.syncNow();
      },
    });
    await coordinator.syncNow();
    expect(asked).toBe(2);
  });
});

describe('account deletion pending on the server', () => {
  it('freezes pushes with the group unchanged until sync resumes', async () => {
    const { server, transport, replica } = await replicaWithServer();
    server.deletionPending = true;
    const ref = await replica.create('action', actionDocument('Not uploaded'));
    await replica.coordinator.syncNow();
    expect(replica.coordinator.getStatus()).toMatchObject({
      state: 'deletion_pending',
      pendingChanges: 1,
    });
    expect(await outbox(replica)).toEqual([
      expect.objectContaining({ state: 'pending', attempt_count: 0 }),
    ]);
    const calls = { ...transport.calls };
    await replica.coordinator.syncNow();
    replica.time.advance(10 * 60_000);
    await flush();
    expect(transport.calls).toEqual(calls);
    expect(server.records.has(`action:${ref.id}`)).toBe(false);
    // The deletion was cancelled: sync resumes with the same group.
    server.deletionPending = false;
    await replica.coordinator.resume();
    expect(server.records.get(`action:${ref.id}`)?.revision).toBe(1);
    expect(replica.coordinator.getStatus()).toMatchObject({ state: 'synced', pendingChanges: 0 });
  });
});

describe('restart', () => {
  it('returns a stranded sending group to pending and resends it with the same ids', async () => {
    const { server, transport, replica } = await replicaWithServer();
    const ref = await replica.create('action', actionDocument('Interrupted'));
    // The app stops after sending: the server applied the group, the answer never arrived.
    const group = await replica.application.claimNextGroup();
    if (group === null) throw new Error('A group is ready.');
    const operationId = group.operations[0]?.operationId;
    transport.loseNextPushAnswer = true;
    const pushed = await transport.push({
      protocolVersion: 1,
      replicaId,
      mutationGroupId: group.mutationGroupId,
      operations: group.operations.map((operation) => ({ ...operation })),
    });
    expect(pushed.ok).toBe(false);
    expect(await outbox(replica)).toEqual([
      expect.objectContaining({ state: 'sending', attempt_count: 1 }),
    ]);
    // A new coordinator (a relaunch) over the same store.
    const relaunched = createSyncCoordinator({
      application: replica.application,
      transport,
      now: () => replica.time.now,
      scheduler: replica.time.scheduler,
      network: { isOnline: () => true, subscribe: () => () => undefined },
      visibility: { isVisible: () => false, subscribe: () => () => undefined },
    });
    relaunched.start();
    await relaunched.syncNow();
    expect(relaunched.getStatus()).toMatchObject({ state: 'synced', pendingChanges: 0 });
    expect(server.accepted.filter((id) => id === operationId)).toHaveLength(1);
    expect(server.records.get(`action:${ref.id}`)?.revision).toBe(1);
    const row = await replica.read(ref);
    expect(row?.serverRevision).toBe(1);
    await relaunched.stop();
  });
});

describe('first upload', () => {
  it('shows progress while linking and lets the identity part finish linking after a cycle', async () => {
    const server = new FakeSyncServer();
    const transport = server.transport();
    const replica = await Replica.open({ name: 'A', replicaId, transport });
    replicas.push(replica);
    // Migration 14: linking starts with `link_started_at`; `linked_at` stays empty until it ends.
    await replica.driver.run(
      `UPDATE planning_identities
       SET link_id = ?, link_source_identity_id = ?, link_started_at = ?;`,
      [crypto.randomUUID(), crypto.randomUUID(), replica.time.instant()],
    );
    await replica.seedProfile();
    const ids = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push(await replica.create('action', actionDocument(`Linked ${String(index)}`)));
    }
    const statuses: string[] = [];
    const settled: SyncFacts[] = [];
    const coordinator = createSyncCoordinator({
      application: replica.application,
      transport,
      now: () => replica.time.now,
      scheduler: replica.time.scheduler,
      network: { isOnline: () => true, subscribe: () => () => undefined },
      visibility: { isVisible: () => false, subscribe: () => () => undefined },
      onCycleSettled: async (facts) => {
        settled.push(facts);
        const waiting = facts.pending + facts.sending + facts.waiting + facts.blocked;
        if (facts.link === 'linking' && waiting === 0 && facts.lastSuccessAt !== undefined) {
          await replica.driver.run('UPDATE planning_identities SET linked_at = ?;', [
            replica.time.instant(),
          ]);
          await coordinator.refresh();
        }
      },
    });
    await coordinator.refresh();
    expect(coordinator.getStatus()).toMatchObject({
      state: 'first_upload',
      firstUpload: { uploaded: 0, total: 4 },
      pendingChanges: 4,
    });
    coordinator.subscribe(() => statuses.push(coordinator.getStatus().state));
    await coordinator.syncNow();
    expect(settled.at(-1)).toMatchObject({
      link: 'linking',
      pending: 0,
      firstUpload: { uploaded: 4, total: 4 },
    });
    expect(coordinator.getStatus()).toMatchObject({ state: 'synced', pendingChanges: 0 });
    expect(coordinator.getStatus()).not.toHaveProperty('firstUpload');
    expect(statuses.at(-1)).toBe('synced');
    expect(ids.every((ref) => server.records.get(`action:${ref.id}`)?.revision === 1)).toBe(true);
  });
});

describe('rejected groups', () => {
  it('wait for a person and are never retried blindly; unrelated groups continue', async () => {
    const { server, transport, replica } = await replicaWithServer();
    server.rejectNextPush = 'schema_mismatch';
    const rejected = await replica.create('action', actionDocument('Refused'));
    await replica.coordinator.syncNow();
    expect(replica.coordinator.getStatus()).toMatchObject({
      state: 'needs_attention',
      rejectedChanges: 1,
      pendingChanges: 0,
    });
    const pushes = transport.calls.push;
    await replica.coordinator.syncNow();
    replica.time.advance(30 * 60_000);
    await replica.coordinator.syncNow();
    expect(transport.calls.push).toBe(pushes);
    const other = await replica.create('action', actionDocument('Unrelated'));
    await replica.coordinator.syncNow();
    expect(server.records.get(`action:${other.id}`)?.revision).toBe(1);
    expect(server.records.has(`action:${rejected.id}`)).toBe(false);
    // A person retries explicitly, with the same operation ids; the call ends with its cycle.
    const { operation_id: operationId } = await actionOperation(replica, rejected.id);
    await replica.coordinator.retryRejected();
    expect(server.records.get(`action:${rejected.id}`)?.revision).toBe(1);
    expect(server.accepted.filter((id) => id === operationId)).toHaveLength(1);
    expect(replica.coordinator.getStatus()).toMatchObject({ state: 'synced', rejectedChanges: 0 });
  });
});

export type { FakeTransport };
