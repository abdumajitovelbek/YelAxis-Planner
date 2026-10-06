import type { Instant, OwnerId } from '@yelaxis/domain';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createAlignmentApplication } from './alignment';
import type {
  AlignmentApplication,
  AlignmentLifecycleMethods,
  AlignmentLinkMethods,
  AlignmentObjectMethods,
  AlignmentProjectionMethods,
} from './alignment-contracts';
import { createAlignmentKit } from './alignment-kit';
import { createAlignmentLifecycleCommands } from './alignment-lifecycle';
import { createAlignmentLinkCommands } from './alignment-links';
import { createAlignmentObjectCommands } from './alignment-objects';
import { createAlignmentProjections } from './alignment-projections';
import type { SerialQueue } from './planning-kit';
import { createAlignmentTestQueries } from './testing/alignment-test-queries';
import { createInMemoryHarness } from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const now = '2026-09-28T13:00:00.000Z' as Instant;

const methodSets = {
  projections: [
    'listAxes',
    'listUnassigned',
    'getAxis',
    'getOutcome',
    'getProject',
    'getMilestone',
    'getNeighborhood',
    'listLinkCandidates',
    'listChoices',
  ],
  objects: [
    'createAxis',
    'editAxis',
    'createOutcome',
    'editOutcome',
    'setOutcomeProgress',
    'transitionOutcome',
    'createProject',
    'editProject',
    'transitionProject',
    'createMilestone',
    'editMilestone',
    'transitionMilestone',
    'reorder',
  ],
  links: ['previewLink', 'link', 'unlink', 'reparentMilestone'],
  lifecycle: [
    'previewArchive',
    'previewRestore',
    'previewDelete',
    'archive',
    'restore',
    'deletePermanently',
  ],
} as const;

const setup = () => {
  const harness = createInMemoryHarness(ownerId, now);
  const queries = createAlignmentTestQueries(harness.unitOfWork);
  return { harness, queries, kit: createAlignmentKit(harness.dependencies, queries) };
};

describe('createAlignmentApplication', () => {
  it('splits the facade into four disjoint method sets that cover it exactly', () => {
    expectTypeOf<keyof AlignmentApplication>().toEqualTypeOf<
      | keyof AlignmentProjectionMethods
      | keyof AlignmentObjectMethods
      | keyof AlignmentLinkMethods
      | keyof AlignmentLifecycleMethods
    >();
    const { kit } = setup();
    const factories = {
      projections: createAlignmentProjections(kit),
      objects: createAlignmentObjectCommands(kit),
      links: createAlignmentLinkCommands(kit),
      lifecycle: createAlignmentLifecycleCommands(kit),
    };
    for (const [name, methods] of Object.entries(methodSets)) {
      expect(Object.keys(factories[name as keyof typeof factories]).sort(), name).toEqual(
        [...methods].sort(),
      );
    }
    const all = Object.values(methodSets).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(32);
  });

  it('exposes every method as a function', () => {
    const { harness, queries } = setup();
    const application = createAlignmentApplication(harness.dependencies, queries);
    const names = Object.values(methodSets).flat();
    expect(Object.keys(application).sort()).toEqual([...names].sort());
    for (const name of names) expect(typeof application[name]).toBe('function');
  });

  it('runs every call through the shared queue', async () => {
    const { harness, queries } = setup();
    const queued: string[] = [];
    const queue: SerialQueue = {
      run: <Result>(): Promise<Result> => {
        queued.push('call');
        return Promise.resolve('queued' as Result);
      },
    };
    const application = createAlignmentApplication(harness.dependencies, queries, { queue });
    for (const name of Object.values(methodSets).flat()) {
      // Serialized façade methods are plain closures; call through the object regardless.
      const call = (): Promise<unknown> =>
        (application[name] as (this: void, ...args: unknown[]) => Promise<unknown>)();
      await expect(call()).resolves.toBe('queued');
    }
    expect(queued).toHaveLength(32);
    expect(harness.unitOfWork.state.events).toEqual([]);
  });
});
