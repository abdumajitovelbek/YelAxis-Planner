import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  fieldGroupsFor,
  mergeWithChoices,
  sameDocument,
  syncFieldGroups,
  threeWayMerge,
} from './sync-merge';

const base = {
  title: 'Draft',
  captureOrigin: 'global_capture',
  orderKey: 'a0',
  state: 'inbox',
};

describe('canonical JSON and equality', () => {
  it('sorts keys at every depth and drops undefined members', () => {
    expect(canonicalJson({ b: { d: 1, c: [2, { f: undefined, e: 'x' }] }, a: true })).toBe(
      '{"a":true,"b":{"c":[2,{"e":"x"}],"d":1}}',
    );
    expect(sameDocument({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameDocument(null, null)).toBe(true);
    expect(sameDocument({ a: 1 }, null)).toBe(false);
  });
});

describe('field groups', () => {
  it('cover every entity type; fields outside a group stand alone in a stable order', () => {
    expect(Object.keys(syncFieldGroups)).toHaveLength(25);
    expect(
      fieldGroupsFor('action', [
        { ...base, note: 'n', due: { kind: 'date', date: '2026-10-05' } },
      ]).map((group) => group.key),
    ).toEqual(['lifecycle', 'placement', 'captureOrigin', 'due', 'note', 'title']);
    expect(fieldGroupsFor('context', [{ key: 'a', value: 'b' }])).toEqual([
      { key: 'record', fields: ['key', 'value'] },
    ]);
  });
});

describe('three-way merge', () => {
  it('converges equal sides and takes one-sided changes', () => {
    expect(
      threeWayMerge('action', base, { ...base, title: 'Same' }, { ...base, title: 'Same' }),
    ).toEqual({ status: 'equal' });
    expect(threeWayMerge('action', base, base, { ...base, title: 'Remote' })).toEqual({
      status: 'remote',
    });
    expect(threeWayMerge('action', base, { ...base, title: 'Local' }, base)).toEqual({
      status: 'local',
    });
  });

  it('merges disjoint fields and groups', () => {
    expect(
      threeWayMerge(
        'action',
        base,
        { ...base, title: 'Local title' },
        { ...base, note: 'Remote note', priority: 'high' },
      ),
    ).toEqual({
      status: 'merged',
      document: { ...base, title: 'Local title', note: 'Remote note', priority: 'high' },
    });
    // A field removed on one side and untouched on the other is removed.
    expect(
      threeWayMerge('action', { ...base, note: 'Old' }, { ...base, title: 'Local' }, { ...base }),
    ).toEqual({ status: 'merged', document: { ...base, title: 'Local' } });
  });

  it('conflicts on the same field and on coupled fields of one group', () => {
    expect(
      threeWayMerge('action', base, { ...base, title: 'Local' }, { ...base, title: 'Remote' }),
    ).toEqual({ status: 'conflict', groups: ['title'] });
    // Completing on one device and archiving on the other touch the same lifecycle group.
    expect(
      threeWayMerge(
        'action',
        base,
        { ...base, state: 'completed', completedAt: '2026-10-01T10:00:00.000Z' },
        {
          ...base,
          state: 'archived',
          stateBeforeArchive: 'inbox',
          archivedAt: '2026-10-01T11:00:00.000Z',
        },
      ),
    ).toEqual({ status: 'conflict', groups: ['lifecycle'] });
    // Reordering on one device and moving to a Project on the other: ordering with its parent.
    expect(
      threeWayMerge(
        'action',
        base,
        { ...base, orderKey: 'a5' },
        { ...base, projectId: '10000000-0000-4000-8000-000000000001' },
      ),
    ).toEqual({ status: 'conflict', groups: ['placement'] });
    // An interval moves as one: start on one side, end on the other.
    const block = {
      startsAt: '2026-10-05T04:00:00.000Z',
      endsAt: '2026-10-05T05:00:00.000Z',
      timeZone: 'Asia/Tashkent',
      state: 'planned',
      overlapAcknowledged: false,
    };
    expect(
      threeWayMerge(
        'time_block',
        block,
        { ...block, startsAt: '2026-10-05T03:00:00.000Z' },
        { ...block, endsAt: '2026-10-05T06:00:00.000Z' },
      ),
    ).toEqual({ status: 'conflict', groups: ['interval'] });
  });

  it('keeps Review notes with their decisions and Context whole', () => {
    const review = { profileId: 'p', reviewType: 'yearly', notes: 'Base', state: 'draft' };
    expect(
      threeWayMerge(
        'review',
        review,
        { ...review, notes: 'Local notes' },
        { ...review, directionChoice: 'continue' },
      ),
    ).toEqual({ status: 'conflict', groups: ['notes'] });
    expect(
      threeWayMerge(
        'review',
        { ...review, reviewType: 'daily' },
        { ...review, reviewType: 'daily', notes: 'Local notes' },
        { ...review, reviewType: 'daily', energy: 'high' },
      ),
    ).toMatchObject({ status: 'merged' });
    const context = { key: 'quiet', value: 'After 21:00', strength: 'soft' };
    expect(
      threeWayMerge(
        'context',
        context,
        { ...context, value: 'After 22:00' },
        { ...context, strength: 'hard' },
      ),
    ).toEqual({ status: 'conflict', groups: ['record'] });
  });

  it('treats every difference as a conflict without a common base', () => {
    expect(threeWayMerge('action', null, { ...base, title: 'A' }, { ...base, note: 'B' })).toEqual({
      status: 'conflict',
      groups: ['note', 'title'],
    });
  });
});

describe('merge details', () => {
  it('takes the chosen side for each conflicting group and the changed side elsewhere', () => {
    const local = { ...base, title: 'Local title', note: 'Local note' };
    const remote = { ...base, title: 'Remote title', note: 'Remote note', priority: 'high' };
    expect(
      mergeWithChoices('action', base, local, remote, { title: 'local', note: 'remote' }),
    ).toEqual({ ...base, title: 'Local title', note: 'Remote note', priority: 'high' });
    expect(mergeWithChoices('action', base, local, remote, { title: 'local' })).toBeNull();
  });
});
