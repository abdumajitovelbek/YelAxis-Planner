import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createActionApplication, type ApplicationDependencies } from '@yelaxis/application';
import type { Instant, OwnerId, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteActionPlanningQueries } from '../queries/action-planning';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { createSqliteApplicationAdapters } from './sqlite-adapters';
import { SqliteOnboardingPersistence } from './onboarding-adapter';

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
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-actions-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  let now = '2026-08-06T09:00:00.000Z' as Instant;
  let idCounter = 1;
  const ids = {
    next() {
      const suffix = idCounter.toString(16).padStart(12, '0');
      idCounter += 1;
      return `90000000-0000-4000-8000-${suffix}` as UUID;
    },
  };
  await runMigrations(driver, schemaMigrations, () => now);
  await driver.run(
    `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
     VALUES (?, 'local', ?, ?);`,
    [ownerId, now, now],
  );
  await driver.run(
    `INSERT INTO profiles (
       id, owner_id, planning_time_zone, week_start, time_format, locale_override,
       onboarding_status, onboarding_step, created_at, updated_at
     ) VALUES (?, ?, 'America/New_York', 'monday', '24_hour', 'en',
               'completed', 'handbook', ?, ?);`,
    [profileId, ownerId, now, now],
  );
  const adapters = createSqliteApplicationAdapters(driver, { ownerId });
  const dependencies: ApplicationDependencies = {
    ...adapters,
    ids,
    clock: { now: () => now },
    projections: { notifyCommitted() {} },
  };
  return {
    driver,
    application: createActionApplication(dependencies, new SqliteActionPlanningQueries(driver)),
    setNow: (value: Instant) => {
      now = value;
    },
  };
}

describe('Action application with SQLite', () => {
  it('captures exactly once across retry, keeps capture metadata, and creates newest-first order', async () => {
    const { application, driver, setNow } = await fixture();
    const firstIntent = application.newCaptureIntent('today');
    const first = await application.capture(firstIntent, { title: '  Draft outline  ' });
    expect(first.ok).toBe(true);
    expect(await application.capture(firstIntent, { title: 'Duplicate attempt' })).toEqual(first);
    setNow('2026-08-06T09:01:00.000Z' as Instant);
    const second = await application.capture(application.newCaptureIntent('inbox'), {
      title: 'Second',
      note: 'Useful context',
      estimateMinutes: 25,
      energy: 'focused',
    });
    expect(second.ok).toBe(true);

    const inbox = await application.listInbox({ limit: 10 });
    expect(inbox.items.map(({ title }) => title)).toEqual(['Second', 'Draft outline']);
    expect(inbox.items[1]).toMatchObject({ createdAt: '2026-08-06T09:00:00.000Z' });
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM actions;'),
    ).resolves.toEqual({ count: 2 });
    await driver.close();
  });

  it('plans, persists a grouped receipt, and undoes Action plus placement exactly', async () => {
    const { application, driver } = await fixture();
    const intent = application.newCaptureIntent('global_capture');
    await application.capture(intent, { title: 'Choose venue' });
    const item = (await application.listInbox()).items[0]!;
    const planned = await application.triage(item.id, item.localRevision, {
      kind: 'plan',
      period: { kind: 'week', date: '2026-08-12' },
    });
    expect(planned).toMatchObject({ ok: true, value: { undo: { available: true } } });
    if (!planned.ok || !planned.value.undo.available) throw new Error('Expected undo receipt');
    expect(planned.value.canonical.map(({ ref }) => ref.type).sort()).toEqual([
      'action',
      'planning_placement',
    ]);
    expect((await application.getAction(item.id))?.action.document).toMatchObject({
      state: 'planned',
    });

    const undone = await application.undo(planned.value.undo.undoId);
    expect(undone.ok).toBe(true);
    expect((await application.getAction(item.id))?.action.document).toMatchObject({
      state: 'inbox',
    });
    await expect(
      driver.get<{ archived_at: string | null }>(
        'SELECT archived_at FROM planning_placements WHERE action_id = ?;',
        [item.id],
      ),
    ).resolves.toMatchObject({ archived_at: '2026-08-06T09:00:00.000Z' });
    expect(await application.undo(planned.value.undo.undoId)).toMatchObject({
      ok: false,
      error: { code: 'undo_unavailable' },
    });
    const restored = await application.getAction(item.id);
    expect(
      await application.deletePermanently(item.id, restored!.action.localRevision, 'Choose venue'),
    ).toMatchObject({ ok: true });
    await driver.close();
  });

  it('persists expanded dates, scheduling, reminder definition, edits, and clearing', async () => {
    const { application, driver } = await fixture();
    const saved = await application.capture(application.newCaptureIntent('plan'), {
      title: 'Prepare brief',
      note: 'Synthetic fixture',
      plannedDate: '2026-11-01',
      dueDate: '2026-11-01',
      dueTime: '09:00',
      estimateMinutes: 45,
      energy: 'high',
      priority: 'normal',
      schedule: { date: '2026-11-01', startTime: '08:00', endTime: '08:45' },
      reminder: { enabled: true, kind: 'relative', offsetMinutes: 15 },
    });
    expect(saved.ok).toBe(true);
    const id = saved.ok
      ? saved.value.canonical.find(({ ref }) => ref.type === 'action')!.ref.id
      : '';
    const detail = await application.getAction(id);
    expect(detail?.action.document).toMatchObject({
      state: 'scheduled',
      estimateMinutes: 45,
      energy: 'high',
    });
    expect(detail?.reminder?.document).toMatchObject({
      state: 'scheduled',
      schedule: { kind: 'relative', offsetMinutes: -15 },
    });

    const edited = await application.edit(id, detail!.action.localRevision, {
      title: 'Prepare concise brief',
      note: '',
      plannedDate: '',
      dueDate: '',
      energy: '',
      priority: '',
      reminder: { enabled: false, kind: 'at' },
    });
    expect(edited.ok).toBe(true);
    const after = await application.getAction(id);
    expect(after?.action.document).not.toHaveProperty('note');
    expect(after?.action.document).not.toHaveProperty('due');
    expect(after?.action.document).not.toHaveProperty('energy');
    expect(after?.action.document).toMatchObject({
      title: 'Prepare concise brief',
      state: 'planned',
    });
    expect(after?.reminder?.document).toMatchObject({ state: 'canceled' });
    await driver.close();
  });

  it('converts Keep to a canonical Note and grouped undo archives the Note', async () => {
    const { application, driver } = await fixture();
    await application.capture(application.newCaptureIntent('inbox'), {
      title: 'Museum thought',
      note: 'Synthetic note body',
    });
    const item = (await application.listInbox()).items[0]!;
    const kept = await application.triage(item.id, item.localRevision, { kind: 'keep_note' });
    expect(kept.ok).toBe(true);
    const noteId = kept.ok
      ? kept.value.canonical.find(({ ref }) => ref.type === 'note')!.ref.id
      : '';
    await expect(
      driver.get<{ title: string; state: string }>('SELECT title, state FROM notes WHERE id = ?;', [
        noteId,
      ]),
    ).resolves.toEqual({ title: 'Museum thought', state: 'active' });
    if (!kept.ok || !kept.value.undo.available) throw new Error('Expected undo');
    expect((await application.undo(kept.value.undo.undoId)).ok).toBe(true);
    await expect(
      driver.get<{ state: string }>('SELECT state FROM notes WHERE id = ?;', [noteId]),
    ).resolves.toEqual({ state: 'archived' });
    expect((await application.getAction(item.id))?.action.document).toMatchObject({
      state: 'inbox',
    });
    await driver.close();
  });

  it('converts Keep to a canonical Project idea and undo archives the Project', async () => {
    const { application, driver } = await fixture();
    await application.capture(application.newCaptureIntent('inbox'), {
      title: 'Synthetic project thought',
      note: 'A bounded fixture description',
    });
    const item = (await application.listInbox()).items[0]!;
    const kept = await application.triage(item.id, item.localRevision, {
      kind: 'keep_project',
    });
    expect(kept.ok).toBe(true);
    const projectId = kept.ok
      ? kept.value.canonical.find(({ ref }) => ref.type === 'project')!.ref.id
      : '';
    await expect(
      driver.get<{ title: string; state: string }>(
        'SELECT title, state FROM projects WHERE id = ?;',
        [projectId],
      ),
    ).resolves.toEqual({ title: 'Synthetic project thought', state: 'idea' });
    if (!kept.ok || !kept.value.undo.available) throw new Error('Expected undo');
    expect((await application.undo(kept.value.undo.undoId)).ok).toBe(true);
    await expect(
      driver.get<{ state: string }>('SELECT state FROM projects WHERE id = ?;', [projectId]),
    ).resolves.toEqual({ state: 'archived' });
    await driver.close();
  });

  it('accepts only active, same-owner Axis and Project relationships', async () => {
    const { application, driver } = await fixture();
    const activeAxis = '41000000-0000-4000-8000-000000000001';
    const archivedAxis = '41000000-0000-4000-8000-000000000002';
    const archivedProject = '42000000-0000-4000-8000-000000000001';
    const foreignOwner = '43000000-0000-4000-8000-000000000001';
    const foreignAxis = '41000000-0000-4000-8000-000000000003';
    const now = '2026-08-06T09:00:00.000Z';
    await driver.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
       VALUES (?, 'local', ?, ?);`,
      [foreignOwner, now, now],
    );
    for (const [id, relationshipOwner, state, archivedAt] of [
      [activeAxis, ownerId, 'active', null],
      [archivedAxis, ownerId, 'archived', now],
      [foreignAxis, foreignOwner, 'active', null],
    ] as const) {
      await driver.run(
        `INSERT INTO axes (
           id, owner_id, title, state, state_before_archive, sort_key, archived_at, created_at,
           updated_at
         ) VALUES (?, ?, 'Synthetic Axis', ?, ?, 'a', ?, ?, ?);`,
        [
          id,
          relationshipOwner,
          state,
          state === 'archived' ? 'active' : null,
          archivedAt,
          now,
          now,
        ],
      );
    }
    await driver.run(
      `INSERT INTO projects (
         id, owner_id, title, state, state_before_archive, sort_key, archived_at, created_at,
         updated_at
       ) VALUES (?, ?, 'Synthetic Project', 'archived', 'idea', 'a', ?, ?, ?);`,
      [archivedProject, ownerId, now, now, now],
    );

    expect(
      await application.capture(application.newCaptureIntent('global_capture'), {
        title: 'Valid relationship',
        axisId: activeAxis,
      }),
    ).toMatchObject({ ok: true });
    for (const input of [
      { axisId: archivedAxis },
      { axisId: foreignAxis },
      { axisId: '41000000-0000-4000-8000-000000000099' },
      { projectId: archivedProject },
    ]) {
      expect(
        await application.capture(application.newCaptureIntent('global_capture'), {
          title: 'Rejected relationship',
          ...input,
        }),
      ).toMatchObject({ ok: false, error: { code: 'domain_rejected' } });
    }
    await driver.close();
  });

  it('applies bulk archive atomically, restores it as one undo, and rejects stale selection', async () => {
    const { application, driver } = await fixture();
    for (const title of ['One', 'Two', 'Three']) {
      await application.capture(application.newCaptureIntent('global_capture'), { title });
    }
    const all = await application.listAllInbox();
    const bulk = await application.bulk(
      all.map(({ ref, revision }) => ({ id: ref.id, revision })),
      { kind: 'archive' },
    );
    expect(bulk.ok).toBe(true);
    expect((await application.listInbox()).total).toBe(0);
    if (!bulk.ok || !bulk.value.undo.available) throw new Error('Expected grouped undo');
    expect(bulk.value.canonical).toHaveLength(3);
    expect((await application.undo(bulk.value.undo.undoId)).ok).toBe(true);
    expect((await application.listInbox()).total).toBe(3);
    expect(
      await application.bulk(
        all.map(({ ref, revision }) => ({ id: ref.id, revision })),
        { kind: 'complete' },
      ),
    ).toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    await driver.close();
  });

  it('permanently deletes only after exact confirmation and prevents ID resurrection', async () => {
    const { application, driver } = await fixture();
    const intent = application.newCaptureIntent('global_capture');
    await application.capture(intent, { title: 'Disposable fixture' });
    const detail = await application.getAction(intent.actionId);
    expect(
      await application.deletePermanently(intent.actionId, detail!.action.localRevision, 'wrong'),
    ).toMatchObject({ ok: false, error: { code: 'domain_rejected' } });
    expect(
      await application.deletePermanently(
        intent.actionId,
        detail!.action.localRevision,
        'Disposable fixture',
      ),
    ).toMatchObject({ ok: true });
    expect(await application.getAction(intent.actionId)).toBeNull();
    expect(await application.capture(intent, { title: 'Resurrect' })).toMatchObject({ ok: true });
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM actions WHERE id = ?;', [
        intent.actionId,
      ]),
    ).resolves.toEqual({ count: 0 });
    await driver.close();
  });

  it('keeps a completed onboarding profile loadable after its onboarding Action is explicitly deleted', async () => {
    const { application, driver } = await fixture();
    const action = '21000000-0000-4000-8000-000000000001';
    const placement = '22000000-0000-4000-8000-000000000001';
    const focus = '23000000-0000-4000-8000-000000000001';
    const week = '24000000-0000-4000-8000-000000000001';
    await driver.run(
      `INSERT INTO actions (
         id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at
       ) VALUES (?, ?, 'Onboarding Action', 'planned', 'onboarding', 'a', ?, ?);`,
      [action, ownerId, '2026-08-06T09:00:00.000Z', '2026-08-06T09:00:00.000Z'],
    );
    await driver.run(
      `INSERT INTO planning_placements (
         id, owner_id, action_id, horizon, period_key, period_start_date, period_end_date,
         sort_key, created_at, updated_at
       ) VALUES (?, ?, ?, 'day', '2026-08-06', '2026-08-06', '2026-08-06', 'a', ?, ?);`,
      [placement, ownerId, action, '2026-08-06T09:00:00.000Z', '2026-08-06T09:00:00.000Z'],
    );
    await driver.run(
      `INSERT INTO focus_selections (
         id, owner_id, profile_id, action_id, local_date, sort_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '2026-08-06', 'a', ?, ?);`,
      [focus, ownerId, profileId, action, '2026-08-06T09:00:00.000Z', '2026-08-06T09:00:00.000Z'],
    );
    await driver.run(
      `INSERT INTO week_selections (
         id, owner_id, profile_id, action_id, period_start_date, period_end_date, week_start,
         sort_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '2026-08-03', '2026-08-09', 'monday', 'a', ?, ?);`,
      [week, ownerId, profileId, action, '2026-08-06T09:00:00.000Z', '2026-08-06T09:00:00.000Z'],
    );
    await driver.run('UPDATE profiles SET onboarding_artifacts_json = ? WHERE id = ?;', [
      JSON.stringify({
        axisIds: [],
        commitments: [],
        actionId: action,
        placementId: placement,
        focusId: focus,
        weekSelectionId: week,
      }),
      profileId,
    ]);
    const detail = await application.getAction(action);
    expect(
      await application.deletePermanently(
        action,
        detail!.action.localRevision,
        'Onboarding Action',
      ),
    ).toMatchObject({ ok: true });
    const onboarding = await new SqliteOnboardingPersistence(driver).load();
    expect(onboarding?.status).toBe('completed');
    expect(onboarding?.artifacts.actionId).toBeUndefined();
    expect(onboarding?.today.action).toBeUndefined();
    await driver.close();
  });

  it('permanently deletes after the complete capture, triage, bulk, edit, and undo sequence', async () => {
    const { application, driver } = await fixture();
    const alphaIntent = application.newCaptureIntent('today');
    await application.capture(alphaIntent, { title: 'Inbox alpha' });
    let alpha = await application.getAction(alphaIntent.actionId);
    const did = await application.triage(alphaIntent.actionId, alpha!.action.localRevision, {
      kind: 'do',
    });
    if (!did.ok || !did.value.undo.available) throw new Error('Do undo missing');
    await application.undo(did.value.undo.undoId);
    alpha = await application.getAction(alphaIntent.actionId);
    const kept = await application.triage(alphaIntent.actionId, alpha!.action.localRevision, {
      kind: 'keep_note',
    });
    if (!kept.ok || !kept.value.undo.available) throw new Error('Keep undo missing');
    await application.undo(kept.value.undo.undoId);
    for (const title of ['Bulk one', 'Bulk two']) {
      await application.capture(application.newCaptureIntent('today'), { title });
    }
    const all = await application.listAllInbox();
    const bulk = await application.bulk(
      all.map(({ ref, revision }) => ({ id: ref.id, revision })),
      { kind: 'complete' },
    );
    if (!bulk.ok || !bulk.value.undo.available) throw new Error('Bulk undo missing');
    await application.undo(bulk.value.undo.undoId);
    alpha = await application.getAction(alphaIntent.actionId);
    await application.edit(alphaIntent.actionId, alpha!.action.localRevision, {
      title: 'Inbox alpha',
      estimateMinutes: 20,
      energy: 'medium',
    });
    alpha = await application.getAction(alphaIntent.actionId);
    const completed = await application.transition(
      alphaIntent.actionId,
      alpha!.action.localRevision,
      'completed',
    );
    if (!completed.ok || !completed.value.undo.available) throw new Error('Complete undo missing');
    await application.undo(completed.value.undo.undoId);
    alpha = await application.getAction(alphaIntent.actionId);
    expect(
      await application.deletePermanently(
        alphaIntent.actionId,
        alpha!.action.localRevision,
        'Inbox alpha',
      ),
    ).toMatchObject({ ok: true });
    await driver.close();
  });
});
