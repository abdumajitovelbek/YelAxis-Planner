import type { SyncApplication, SyncConflictView, SyncResolution } from '@yelaxis/application';
import type { Instant, UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import { createConflictService } from './conflict-service';

const createdAt = '2026-10-01T09:00:00.000Z' as Instant;

function view(overrides: Partial<SyncConflictView>): SyncConflictView {
  return {
    conflictId: 'c1000000-0000-4000-8000-000000000001' as UUID,
    entityType: 'action',
    entityId: 'a1000000-0000-4000-8000-000000000001' as UUID,
    kind: 'stale_base',
    origin: 'this_device',
    createdAt,
    base: null,
    local: { deleted: false, document: null },
    remote: { deleted: false, document: null },
    fields: [],
    choices: ['keep_local', 'keep_remote', 'merge'],
    ...overrides,
  };
}

function service(views: readonly SyncConflictView[], resolutions: SyncResolution[] = []) {
  let resolved = 0;
  const application = {
    listConflicts: () => Promise.resolve(views),
    getConflict: (id: UUID) =>
      Promise.resolve(views.find((item) => item.conflictId === id) ?? null),
    resolveConflict: (_id: UUID, resolution: SyncResolution) => {
      resolutions.push(resolution);
      return Promise.resolve(
        resolution.choice === 'keep_deleted'
          ? ({ ok: false, code: 'still_referenced' } as const)
          : ({ ok: true, value: { queued: true } } as const),
      );
    },
  } as unknown as SyncApplication;
  return {
    conflicts: createConflictService({
      application,
      onResolved: () => {
        resolved += 1;
      },
    }),
    resolved: () => resolved,
  };
}

const base = {
  title: 'Draft',
  captureOrigin: 'global_capture',
  orderKey: 'a0',
  state: 'inbox',
  due: { kind: 'date', date: '2026-10-05' },
};

describe('conflict service', () => {
  it('lists conflicts with the record kind and the record title', async () => {
    const { conflicts } = service([
      view({ local: { deleted: false, document: { ...base, title: 'Local title' } } }),
      view({
        conflictId: 'c1000000-0000-4000-8000-000000000002' as UUID,
        entityType: 'planning_placement',
        kind: 'edit_versus_delete',
        local: { deleted: false, document: { orderKey: 'a0' } },
        remote: { deleted: true, document: null },
      }),
      view({
        conflictId: 'c1000000-0000-4000-8000-000000000003' as UUID,
        entityType: 'outcome',
        origin: 'other_device',
        local: { deleted: false, document: { orderKey: 'a0' } },
      }),
    ]);
    // The kind label names the record; what happened to it is `kind`.
    expect(await conflicts.list()).toEqual([
      {
        conflictId: 'c1000000-0000-4000-8000-000000000001',
        kindLabel: 'Action',
        title: 'Local title',
        kind: 'stale_base',
        createdAt,
      },
      {
        conflictId: 'c1000000-0000-4000-8000-000000000002',
        kindLabel: 'Placement',
        title: 'A Placement',
        kind: 'edit_versus_delete',
        createdAt,
      },
      {
        conflictId: 'c1000000-0000-4000-8000-000000000003',
        kindLabel: 'Outcome',
        title: 'An Outcome',
        kind: 'stale_base',
        createdAt,
      },
    ]);
  });

  it('shows every conflicting field group as labelled text, never JSON', async () => {
    const local = {
      ...base,
      title: 'Title here',
      orderKey: 'a5',
      state: 'completed',
      completedAt: '2026-10-02T08:30:00.000Z',
      estimateMinutes: 30,
      priority: 'high',
      due: {
        kind: 'instant',
        instant: '2026-10-06T13:00:00.000Z',
        authoredTimeZone: 'Asia/Tashkent',
      },
    };
    const remote = {
      ...base,
      title: 'Title there',
      projectId: 'b1000000-0000-4000-8000-000000000001',
    };
    const { conflicts } = service([
      view({
        base,
        local: { deleted: false, document: local },
        remote: { deleted: false, document: remote },
        fields: ['title', 'placement', 'lifecycle', 'due', 'estimateMinutes', 'priority'],
      }),
    ]);
    const detail = await conflicts.get('c1000000-0000-4000-8000-000000000001');
    expect(detail?.fields).toEqual([
      { field: 'title', label: 'Title', base: 'Draft', local: 'Title here', remote: 'Title there' },
      {
        field: 'placement',
        label: 'Place and order',
        base: 'Original place',
        local: 'Moved in the list',
        // Without the linked records (a list view), a link is still never an id.
        remote: 'Moved to a linked record',
      },
      { field: 'lifecycle', label: 'Status', base: 'Inbox', local: 'Completed', remote: 'Inbox' },
      {
        field: 'due',
        label: 'Due',
        base: '2026-10-05',
        local: '2026-10-06 13:00 UTC (Asia/Tashkent)',
        remote: '2026-10-05',
      },
      {
        field: 'estimateMinutes',
        label: 'Estimate',
        base: 'Not set',
        local: '30 min',
        remote: 'Not set',
      },
      { field: 'priority', label: 'Priority', base: 'Not set', local: 'High', remote: 'Not set' },
    ]);
    expect(detail?.choices).toEqual(['keep_local', 'keep_remote', 'merge']);
    const texts = (detail?.fields ?? []).flatMap((field) => [
      field.base,
      field.local,
      field.remote,
    ]);
    for (const text of texts) expect(text).not.toMatch(/[{}[\]"]/u);
  });

  it('shows a time interval and a deleted side', async () => {
    const block = {
      target: { kind: 'custom', title: 'Deep work' },
      startsAt: '2026-10-05T04:00:00.000Z',
      endsAt: '2026-10-05T05:30:00.000Z',
      timeZone: 'Asia/Tashkent',
      state: 'planned',
      overlapAcknowledged: false,
    };
    const { conflicts } = service([
      view({
        entityType: 'time_block',
        base: block,
        local: {
          deleted: false,
          document: {
            ...block,
            startsAt: '2026-10-05T06:00:00.000Z',
            endsAt: '2026-10-05T07:00:00.000Z',
          },
        },
        remote: {
          deleted: false,
          document: {
            ...block,
            startsAt: '2026-10-05T08:00:00.000Z',
            endsAt: '2026-10-05T09:00:00.000Z',
          },
        },
        fields: ['interval'],
      }),
      view({
        conflictId: 'c1000000-0000-4000-8000-000000000002' as UUID,
        kind: 'delete_versus_edit',
        local: { deleted: true, document: null },
        remote: { deleted: false, document: base },
        choices: ['keep_deleted', 'restore_edited'],
      }),
    ]);
    expect((await conflicts.get('c1000000-0000-4000-8000-000000000001'))?.fields).toEqual([
      {
        field: 'interval',
        label: 'Time',
        base: '2026-10-05 04:00 UTC – 2026-10-05 05:30 UTC (Asia/Tashkent)',
        local: '2026-10-05 06:00 UTC – 2026-10-05 07:00 UTC (Asia/Tashkent)',
        remote: '2026-10-05 08:00 UTC – 2026-10-05 09:00 UTC (Asia/Tashkent)',
      },
    ]);
    // Without a base, the edited version shows everything it holds; the other side is deleted.
    const deleted = await conflicts.get('c1000000-0000-4000-8000-000000000002');
    expect(deleted).toMatchObject({
      kindLabel: 'Action',
      kind: 'delete_versus_edit',
      title: 'Draft',
      choices: ['keep_deleted', 'restore_edited'],
    });
    expect(deleted?.fields).toEqual([
      { field: 'lifecycle', label: 'Status', local: 'Deleted', remote: 'Inbox' },
      {
        field: 'placement',
        label: 'Place and order',
        local: 'Deleted',
        remote: 'Not placed under anything',
      },
      {
        field: 'captureOrigin',
        label: 'Captured from',
        local: 'Deleted',
        remote: 'Global capture',
      },
      { field: 'due', label: 'Due', local: 'Deleted', remote: '2026-10-05' },
      { field: 'title', label: 'Title', local: 'Deleted', remote: 'Draft' },
    ]);
    expect(await conflicts.get('c1000000-0000-4000-8000-000000000009')).toBeNull();
  });

  it('shows what the edit changed when the other device deleted the record', async () => {
    const { conflicts } = service([
      view({
        kind: 'edit_versus_delete',
        base,
        local: { deleted: false, document: { ...base, title: 'Edited here', priority: 'high' } },
        remote: { deleted: true, document: null },
        choices: ['keep_deleted', 'restore_edited'],
      }),
    ]);
    expect((await conflicts.get('c1000000-0000-4000-8000-000000000001'))?.fields).toEqual([
      { field: 'priority', label: 'Priority', base: 'Not set', local: 'High', remote: 'Deleted' },
      {
        field: 'title',
        label: 'Title',
        base: 'Draft',
        local: 'Edited here',
        remote: 'Deleted',
      },
    ]);
  });

  it('names the record each version links to, and never shows two different versions alike', async () => {
    const id = (n: number) => `b1000000-0000-4000-8000-00000000000${String(n)}`;
    const links: SyncConflictView['links'] = {
      [id(1)]: { entityType: 'project', presence: 'here', title: 'Launch' },
      [id(2)]: { entityType: 'project', presence: 'here', title: 'Website' },
      [id(3)]: { entityType: 'project', presence: 'missing' },
      [id(4)]: { entityType: 'action', presence: 'here', title: 'Call the venue' },
      [id(5)]: { entityType: 'action', presence: 'deleted' },
      [id(6)]: { entityType: 'milestone', presence: 'here', title: 'Beta' },
      [id(7)]: { entityType: 'milestone', presence: 'here', title: 'Beta' },
      [id(8)]: { entityType: 'axis', presence: 'here' },
    };
    const { conflicts } = service([
      view({
        conflictId: 'c1000000-0000-4000-8000-000000000001' as UUID,
        base: { ...base, projectId: id(1) },
        local: { deleted: false, document: { ...base, projectId: id(2) } },
        remote: { deleted: false, document: { ...base, projectId: id(3), axisId: id(8) } },
        fields: ['placement'],
        links,
      }),
      view({
        conflictId: 'c1000000-0000-4000-8000-000000000002' as UUID,
        entityType: 'reminder',
        base: { actionId: id(4), schedule: { kind: 'relative', offsetMinutes: 10 } },
        local: { deleted: false, document: { actionId: id(4), schedule: { kind: 'relative' } } },
        remote: { deleted: false, document: { actionId: id(5), schedule: { kind: 'relative' } } },
        fields: ['target'],
        links,
      }),
      view({
        conflictId: 'c1000000-0000-4000-8000-000000000003' as UUID,
        entityType: 'milestone_action',
        base: null,
        local: { deleted: false, document: { milestoneId: id(6), actionId: id(4) } },
        remote: { deleted: false, document: { milestoneId: id(7), actionId: id(4) } },
        fields: ['endpoints'],
        links,
      }),
      view({
        conflictId: 'c1000000-0000-4000-8000-000000000004' as UUID,
        entityType: 'time_block',
        base: null,
        local: { deleted: false, document: { target: { kind: 'action', actionId: id(4) } } },
        remote: { deleted: false, document: { target: { kind: 'custom', title: 'Deep work' } } },
        fields: ['target'],
        links,
      }),
    ]);
    const fields = async (n: number) =>
      (await conflicts.get(`c1000000-0000-4000-8000-00000000000${String(n)}`))?.fields ?? [];
    expect(await fields(1)).toEqual([
      {
        field: 'placement',
        label: 'Place and order',
        base: 'Original place',
        local: 'Moved to Project “Website”',
        remote: 'Moved to an Axis, to a Project not on this device',
      },
    ]);
    expect(await fields(2)).toEqual([
      {
        field: 'target',
        label: 'Linked to',
        base: 'Action “Call the venue”',
        local: 'Action “Call the venue”',
        remote: 'A deleted Action',
      },
    ]);
    // Two Milestones with the same title: the other version still reads differently.
    expect(await fields(3)).toEqual([
      {
        field: 'endpoints',
        label: 'Link',
        local: 'Milestone “Beta” · Action “Call the venue”',
        remote: 'Milestone “Beta” · Action “Call the venue” (different)',
      },
    ]);
    expect(await fields(4)).toEqual([
      {
        field: 'target',
        label: 'Linked to',
        local: 'Action “Call the venue”',
        remote: 'Deep work',
      },
    ]);
    for (const n of [1, 2, 3, 4]) {
      for (const field of await fields(n)) {
        expect(field.local).not.toBe(field.remote);
        expect(`${field.local ?? ''} ${field.remote ?? ''}`).not.toMatch(/b1000000|[{}[\]"]/u);
      }
    }
  });

  it('resolves through the application and syncs afterwards', async () => {
    const resolutions: SyncResolution[] = [];
    const { conflicts, resolved } = service([view({})], resolutions);
    await expect(
      conflicts.resolve('c1000000-0000-4000-8000-000000000001', {
        choice: 'merge',
        fields: { title: 'remote' },
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(resolutions).toEqual([{ choice: 'merge', fields: { title: 'remote' } }]);
    expect(resolved()).toBe(1);
    const refused = await conflicts.resolve('c1000000-0000-4000-8000-000000000001', {
      choice: 'keep_deleted',
    });
    expect(refused).toMatchObject({ ok: false, code: 'still_referenced' });
    expect(resolved()).toBe(1);
  });
});
