import type { Instant, OwnerId } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import { createActionApplication, type ActionPlanningQueryPort } from './actions';
import { createSerialQueue } from './planning-kit';
import { createInMemoryHarness } from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-0000000000aa' as OwnerId;
const now = '2026-09-27T12:00:00.000Z' as Instant;

function queriesRecording(order: string[]): ActionPlanningQueryPort {
  const unused = (): Promise<never> => Promise.reject(new Error('Not used in this test'));
  return {
    getProfileContext: unused,
    getInboxEdge: unused,
    listInbox: unused,
    listAllInbox: unused,
    getActionWorkspace: unused,
    getActionDeleteImpact: unused,
    listAxes: () => {
      order.push('actions:listAxes');
      return Promise.resolve([]);
    },
    listProjects: unused,
    listMilestones: unused,
    findMilestoneActionLink: unused,
  };
}

describe('Action application serialization', () => {
  it('waits for work already running on an injected shared queue', async () => {
    const harness = createInMemoryHarness(ownerId, now);
    const order: string[] = [];
    const queue = createSerialQueue();
    const actions = createActionApplication(harness.dependencies, queriesRecording(order), {
      queue,
    });

    let release: () => void = () => undefined;
    const planningCommand = queue.run(async () => {
      order.push('planning:start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push('planning:end');
    });
    const actionRead = actions.listAxes();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['planning:start']);

    release();
    await Promise.all([planningCommand, actionRead]);
    expect(order).toEqual(['planning:start', 'planning:end', 'actions:listAxes']);
  });

  it('keeps its own queue when none is injected', async () => {
    const harness = createInMemoryHarness(ownerId, now);
    const order: string[] = [];
    const actions = createActionApplication(harness.dependencies, queriesRecording(order));
    await expect(actions.listAxes()).resolves.toEqual([]);
    expect(order).toEqual(['actions:listAxes']);
  });
});
