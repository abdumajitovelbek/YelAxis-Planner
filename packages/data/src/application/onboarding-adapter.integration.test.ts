import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOnboardingApplication } from '@yelaxis/application';
import type { Instant, OnboardingDraft, UUID } from '@yelaxis/domain';

import { runMigrations } from '../sqlite/migrations/migration';
import { schemaMigrations } from '../sqlite/migrations';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { SqliteOnboardingPersistence } from './onboarding-adapter';

const now = '2026-08-06T07:00:00.000Z' as Instant;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-onboarding-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(driver, schemaMigrations, () => now);
  let id = 1;
  const application = createOnboardingApplication(new SqliteOnboardingPersistence(driver), {
    clock: { now: () => now },
    ids: {
      next: () => {
        const suffix = id.toString(16).padStart(12, '0');
        id += 1;
        return `10000000-0000-4000-8000-${suffix}` as UUID;
      },
    },
  });
  return { application, driver };
}

const defaults = {
  planningTimeZone: 'Asia/Tashkent',
  weekStart: 'sunday' as const,
  timeFormat: '12_hour' as const,
  locale: 'uz-Latn-UZ',
};

function usefulDraft(): OnboardingDraft {
  return {
    identity: { preferredName: 'Sam', locale: 'uz-Latn-UZ' },
    defaults,
    context: {
      awakeWindow: { start: '07:00', end: '23:00' },
      availability: {
        label: 'Study time',
        weekdays: ['monday', 'wednesday'],
        start: '09:00',
        end: '12:00',
        strength: 'soft',
      },
      boundary: { text: 'Keep the evening unscheduled', strength: 'hard' },
    },
    axes: ['Study'],
    outcome: {
      title: 'Submit a clear proposal',
      successDefinition: 'The reviewer can decide without asking for missing information.',
      axisIndex: 0,
    },
    week: {
      commitments: [
        {
          title: 'Planning session',
          date: '2026-08-06',
          start: '13:00',
          end: '14:00',
          strength: 'hard',
          confirmed: true,
        },
      ],
      actionTitle: 'Draft the proposal outline',
    },
  };
}

describe('onboarding SQLite onboarding adapter', () => {
  it('reopens an existing owned Profile without starting a durable transaction', async () => {
    const { application, driver } = await setup();
    try {
      const initialized = await application.initialize(defaults);
      const transaction = vi.spyOn(driver, 'transaction').mockImplementation(() => {
        throw new Error('An existing Profile must open through reads only');
      });
      expect(await application.initialize(defaults)).toEqual(initialized);
      expect(transaction).not.toHaveBeenCalled();
      transaction.mockRestore();
    } finally {
      await driver.close();
    }
  });

  it('rejects ambiguous active identities before a bootstrap write', async () => {
    const { application, driver } = await setup();
    try {
      await application.initialize(defaults);
      await driver.run(
        `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
         VALUES (?, 'local', ?, ?);`,
        ['20000000-0000-4000-8000-000000000001', now, now],
      );
      const transaction = vi.spyOn(driver, 'transaction');
      await expect(application.initialize(defaults)).rejects.toMatchObject({
        code: 'identity_ambiguous',
      });
      expect(transaction).not.toHaveBeenCalled();
      transaction.mockRestore();
    } finally {
      await driver.close();
    }
  });

  it('initializes offline, atomically creates a useful Today, and reruns without duplicates', async () => {
    const { application, driver } = await setup();
    const initial = await application.initialize(defaults);
    expect(initial.status).toBe('not_started');
    expect(initial.step).toBe('welcome');

    const completed = await application.execute({
      kind: 'complete',
      draft: usefulDraft(),
      handbookStatus: 'skipped',
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.status).toBe('completed');
    expect(completed.value.today).toMatchObject({
      date: '2026-08-06',
      weekStartDate: '2026-08-02',
      action: { title: 'Draft the proposal outline' },
      outcome: { title: 'Submit a clear proposal', axisTitle: 'Study' },
    });
    expect(completed.value.today.commitments).toHaveLength(1);
    const fixedBlockBefore = await driver.get<{
      starts_at_utc: string;
      ends_at_utc: string;
      time_zone: string;
    }>(`SELECT starts_at_utc, ends_at_utc, time_zone FROM time_blocks;`);
    expect(fixedBlockBefore).toEqual({
      starts_at_utc: '2026-08-06T08:00:00.000Z',
      ends_at_utc: '2026-08-06T09:00:00.000Z',
      time_zone: 'Asia/Tashkent',
    });
    const firstReceiptRow = await driver.get<{ receipt_payload_json: string }>(
      `SELECT receipt_payload_json FROM command_receipts ORDER BY rowid DESC LIMIT 1;`,
    );
    const firstReceipt = JSON.parse(firstReceiptRow?.receipt_payload_json ?? '{}') as {
      canonical?: { ref: { type: string; id: string }; localRevision: number }[];
      eventIds?: string[];
    };
    expect(firstReceipt.canonical).toHaveLength(13);
    expect(firstReceipt.eventIds).toHaveLength(13);
    expect(firstReceipt.canonical?.[0]).toMatchObject({
      ref: { type: 'profile' },
      localRevision: 2,
    });
    expect(firstReceipt.canonical?.every(({ localRevision }) => localRevision > 0)).toBe(true);
    expect(new Set(firstReceipt.canonical?.map(({ ref }) => ref.id)).size).toBe(13);
    expect(await counts(driver)).toMatchObject({
      profiles: 1,
      axes: 1,
      outcomes: 1,
      actions: 1,
      commitments: 1,
      time_blocks: 1,
      planning_placements: 1,
      focus_selections: 1,
      week_selections: 1,
      contexts: 3,
      constraints: 1,
    });

    await application.execute({ kind: 'rerun' });
    const resumed = await application.load();
    expect(resumed?.draft.week.commitments[0]?.timeZone).toBe('Asia/Tashkent');
    if (resumed === null || resumed.draft.defaults === null) return;
    const replay = await application.execute({
      kind: 'complete',
      draft: {
        ...resumed.draft,
        defaults: {
          ...resumed.draft.defaults,
          planningTimeZone: 'Europe/London',
          timeFormat: '24_hour',
        },
      },
      handbookStatus: 'completed',
    });
    expect(replay.ok).toBe(true);
    expect(await driver.get(`SELECT planning_time_zone, time_format FROM profiles;`)).toEqual({
      planning_time_zone: 'Europe/London',
      time_format: '24_hour',
    });
    expect(
      await driver.get(`SELECT starts_at_utc, ends_at_utc, time_zone FROM time_blocks;`),
    ).toEqual(fixedBlockBefore);
    expect(await counts(driver)).toMatchObject({
      profiles: 1,
      axes: 1,
      outcomes: 1,
      actions: 1,
      commitments: 1,
      time_blocks: 1,
      planning_placements: 1,
      focus_selections: 1,
      week_selections: 1,
      contexts: 3,
      constraints: 1,
    });

    const reset = await application.execute({ kind: 'reset_onboarding' });
    expect(reset.ok && reset.value.status).toBe('not_started');
    expect(await counts(driver)).toMatchObject({
      axes: 1,
      outcomes: 1,
      actions: 1,
      commitments: 1,
    });
    await driver.close();
  });

  it('rolls back the final profile and every first-plan row if audit persistence fails', async () => {
    const { application, driver } = await setup();
    await application.initialize(defaults);
    await driver.executeScript(`
      CREATE TRIGGER fail_onboarding_audit BEFORE INSERT ON domain_events
      BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;
    `);
    const result = await application.execute({
      kind: 'complete',
      draft: usefulDraft(),
      handbookStatus: 'skipped',
    });
    expect(result.ok).toBe(false);
    expect(await counts(driver)).toMatchObject({
      profiles: 1,
      axes: 0,
      outcomes: 0,
      actions: 0,
      commitments: 0,
      domain_events: 0,
    });
    const state = await application.load();
    expect(state?.status).toBe('not_started');
    await driver.close();
  });

  it('fails closed and rolls back if a generated artifact ID belongs to another owner', async () => {
    const { application, driver } = await setup();
    await application.initialize(defaults);
    const otherOwner = '20000000-0000-4000-8000-000000000001';
    const collidingAxis = '10000000-0000-4000-8000-000000000003';
    await driver.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
       VALUES (?, 'local', ?, ?);`,
      [otherOwner, now, now],
    );
    await driver.run(
      `INSERT INTO axes (
         id, owner_id, title, state, sort_key, created_at, updated_at, client_updated_at
       ) VALUES (?, ?, 'Other plan axis', 'active', 'other-01', ?, ?, ?);`,
      [collidingAxis, otherOwner, now, now, now],
    );

    const result = await application.execute({
      kind: 'complete',
      draft: usefulDraft(),
      handbookStatus: 'skipped',
    });

    expect(result.ok).toBe(false);
    expect(
      await driver.get<{ owner_id: string; title: string }>(
        `SELECT owner_id, title FROM axes WHERE id = ?;`,
        [collidingAxis],
      ),
    ).toEqual({ owner_id: otherOwner, title: 'Other plan axis' });
    expect(
      await driver.get<{ onboarding_status: string; local_revision: number }>(
        `SELECT onboarding_status, local_revision FROM profiles;`,
      ),
    ).toEqual({ onboarding_status: 'not_started', local_revision: 1 });
    expect(await counts(driver)).toMatchObject({
      axes: 1,
      outcomes: 0,
      actions: 0,
      commitments: 0,
      domain_events: 0,
      command_receipts: 0,
    });
    await driver.close();
  });

  it('reruns setup after alignment reorder, relink, archive, and delete without undoing or resurrecting', async () => {
    const { application, driver } = await setup();
    await application.initialize(defaults);
    const completed = await application.execute({
      kind: 'complete',
      draft: { ...usefulDraft(), axes: ['Study', 'Health', 'Home'] },
      handbookStatus: 'skipped',
    });
    if (!completed.ok) throw new Error(completed.message);
    const owner = completed.value.ownerId;
    const [study, health, home] = completed.value.artifacts.axisIds;
    const outcome = completed.value.artifacts.outcomeId;
    const action = completed.value.artifacts.actionId;
    // What the alignment commands leave behind: spaced order keys, a relinked and archived Outcome, an
    // archived starter Axis, and a permanently deleted one with its ledger entry.
    const craft = '30000000-0000-4000-8000-000000000001';
    await driver.run(
      `INSERT INTO axes (id, owner_id, title, state, sort_key, created_at, updated_at)
       VALUES (?, ?, 'Craft', 'active', '000004000000000', ?, ?);`,
      [craft, owner, now, now],
    );
    for (const [axis, key] of [
      [study, '000002000000000'],
      [health, '000003000000000'],
      [home, '000001000000000'],
    ] as const) {
      await driver.run('UPDATE axes SET sort_key = ? WHERE id = ?;', [key, axis ?? '']);
    }
    await driver.run(
      `UPDATE outcomes SET axis_id = ?, sort_key = '000001000000000', state = 'archived',
         state_before_archive = 'active', archived_at = ? WHERE id = ?;`,
      [craft, now, outcome ?? ''],
    );
    await driver.run(
      `UPDATE axes SET state = 'archived', state_before_archive = 'active', archived_at = ?
       WHERE id = ?;`,
      [now, health ?? ''],
    );
    await driver.run('DELETE FROM axes WHERE id = ?;', [home ?? '']);
    await driver.run(
      `INSERT INTO deletion_ledger (id, owner_id, entity_type, entity_id, local_revision,
         deleted_at, created_at, updated_at)
       VALUES (?, ?, 'axis', ?, 2, ?, ?, ?);`,
      [`${owner}:axis:${home ?? ''}`, owner, home ?? '', now, now, now],
    );

    const loaded = await application.load();
    expect(loaded?.artifacts.axisIds).toEqual([study, health]);
    expect(loaded?.draft.axes).toEqual(['Study', 'Health']);
    // Today shows neither the archived starter Axis nor the archived Outcome.
    expect(loaded?.today.axes).toEqual([{ id: study, title: 'Study' }]);
    expect(loaded?.today.outcome).toBeUndefined();

    expect((await application.execute({ kind: 'rerun' })).ok).toBe(true);
    const resumed = await application.load();
    if (resumed === null) throw new Error('Missing onboarding state');
    const replay = await application.execute({
      kind: 'complete',
      draft: { ...resumed.draft, axes: ['Study hard', 'Health'] },
      handbookStatus: 'skipped',
    });
    if (!replay.ok) throw new Error(replay.message);
    expect(replay.value.status).toBe('completed');
    expect(replay.value.artifacts.axisIds).toEqual([study, health]);
    await expect(
      driver.all(`SELECT id, title, state, sort_key FROM axes ORDER BY sort_key;`),
    ).resolves.toEqual([
      { id: study, title: 'Study hard', state: 'active', sort_key: '000002000000000' },
      { id: health, title: 'Health', state: 'archived', sort_key: '000003000000000' },
      { id: craft, title: 'Craft', state: 'active', sort_key: '000004000000000' },
    ]);
    await expect(
      driver.get(`SELECT axis_id, sort_key, state FROM outcomes WHERE id = ?;`, [outcome ?? '']),
    ).resolves.toEqual({ axis_id: craft, sort_key: '000001000000000', state: 'archived' });
    await expect(
      driver.get(`SELECT axis_id, sort_key FROM actions WHERE id = ?;`, [action ?? '']),
    ).resolves.toEqual({ axis_id: study, sort_key: 'onboarding-01' });
    expect(await counts(driver)).toMatchObject({ axes: 3, outcomes: 1, actions: 1 });
    await driver.close();
  });

  it('drops a starter Axis and Outcome deleted after a rerun draft was saved', async () => {
    const { application, driver } = await setup();
    await application.initialize(defaults);
    const base = usefulDraft();
    const completed = await application.execute({
      kind: 'complete',
      draft: {
        ...base,
        axes: ['Study', 'Health', 'Home'],
        outcome: base.outcome === null ? null : { ...base.outcome, axisIndex: 2 },
      },
      handbookStatus: 'skipped',
    });
    if (!completed.ok) throw new Error(completed.message);
    const owner = completed.value.ownerId;
    const [study, health, home] = completed.value.artifacts.axisIds;
    const outcome = completed.value.artifacts.outcomeId ?? '';
    expect((await application.execute({ kind: 'rerun' })).ok).toBe(true);
    const forget = async (type: 'axis' | 'outcome', table: string, entityId: string) => {
      await driver.run(`DELETE FROM ${table} WHERE id = ?;`, [entityId]);
      await driver.run(
        `INSERT INTO deletion_ledger (id, owner_id, entity_type, entity_id, local_revision,
           deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 2, ?, ?, ?);`,
        [`${owner}:${type}:${entityId}`, owner, type, entityId, now, now, now],
      );
    };

    await forget('axis', 'axes', health ?? '');
    const withoutAxis = await application.load();
    expect(withoutAxis?.artifacts.axisIds).toEqual([study, home]);
    expect(withoutAxis?.draft.axes).toEqual(['Study', 'Home']);
    expect(withoutAxis?.draft.outcome?.axisIndex).toBe(1);

    // The first-plan Action names the Outcome's Axis, not the Outcome itself.
    await forget('outcome', 'outcomes', outcome);
    const withoutOutcome = await application.load();
    expect(withoutOutcome?.artifacts.outcomeId).toBeUndefined();
    expect(withoutOutcome?.draft.outcome).toBeNull();
    if (withoutOutcome === null) throw new Error('Missing onboarding state');

    const replay = await application.execute({
      kind: 'complete',
      draft: withoutOutcome.draft,
      handbookStatus: 'skipped',
    });
    if (!replay.ok) throw new Error(replay.message);
    await expect(driver.all('SELECT id, title FROM axes ORDER BY sort_key;')).resolves.toEqual([
      { id: study, title: 'Study' },
      { id: home, title: 'Home' },
    ]);
    expect(await counts(driver)).toMatchObject({ axes: 2, outcomes: 0, actions: 1 });
    await driver.close();
  });

  it('fails closed instead of writing a first-plan identity that was permanently deleted', async () => {
    const { application, driver } = await setup();
    const initial = await application.initialize(defaults);
    const owner = initial.ownerId;
    const plannedAxis = '10000000-0000-4000-8000-000000000003';
    await driver.run(
      `INSERT INTO deletion_ledger (id, owner_id, entity_type, entity_id, local_revision,
         deleted_at, created_at, updated_at)
       VALUES (?, ?, 'axis', ?, 2, ?, ?, ?);`,
      [`${owner}:axis:${plannedAxis}`, owner, plannedAxis, now, now, now],
    );
    const result = await application.execute({
      kind: 'complete',
      draft: usefulDraft(),
      handbookStatus: 'skipped',
    });
    expect(result.ok).toBe(false);
    expect(await counts(driver)).toMatchObject({
      axes: 0,
      outcomes: 0,
      actions: 0,
      domain_events: 0,
      command_receipts: 0,
    });
    await expect(
      driver.get(`SELECT onboarding_status, local_revision FROM profiles;`),
    ).resolves.toEqual({ onboarding_status: 'not_started', local_revision: 1 });
    await driver.close();
  });

  it('keeps the plan loadable after later edits exceed setup limits and asks for changes on rerun', async () => {
    const { application, driver } = await setup();
    await application.initialize(defaults);
    const completed = await application.execute({
      kind: 'complete',
      draft: { ...usefulDraft(), axes: ['Study', 'Health'] },
      handbookStatus: 'skipped',
    });
    if (!completed.ok) throw new Error(completed.message);
    const [, health] = completed.value.artifacts.axisIds;
    // alignment allows a 2,000-character success definition and two Axes with the same name.
    await driver.run('UPDATE outcomes SET success_definition = ?;', ['x'.repeat(600)]);
    await driver.run(`UPDATE axes SET title = 'Study' WHERE id = ?;`, [health ?? '']);

    const loaded = await application.load();
    expect(loaded?.draft.axes).toEqual(['Study', 'Study']);
    expect(loaded?.draft.outcome?.successDefinition).toHaveLength(600);
    expect((await application.execute({ kind: 'rerun' })).ok).toBe(true);
    const resumed = await application.load();
    if (resumed?.draft.outcome == null) throw new Error('Missing onboarding draft');
    const refused = await application.execute({
      kind: 'complete',
      draft: resumed.draft,
      handbookStatus: 'skipped',
    });
    expect(refused.ok).toBe(false);
    await expect(
      driver.get('SELECT length(success_definition) AS length FROM outcomes;'),
    ).resolves.toEqual({ length: 600 });

    const fixed = await application.execute({
      kind: 'complete',
      draft: {
        ...resumed.draft,
        axes: ['Study', 'Health'],
        outcome: { ...resumed.draft.outcome, successDefinition: 'A clear decision.' },
      },
      handbookStatus: 'skipped',
    });
    expect(fixed.ok).toBe(true);
    await expect(driver.get('SELECT success_definition FROM outcomes;')).resolves.toEqual({
      success_definition: 'A clear decision.',
    });
    await driver.close();
  });

  it('rejects invalid persisted progress without resetting or rewriting the Profile', async () => {
    const { application, driver } = await setup();
    await application.initialize(defaults);
    await driver.run(`UPDATE profiles SET onboarding_step = 'week', onboarding_draft_json = ?;`, [
      JSON.stringify({ invalid: 'synthetic fixture' }),
    ]);

    await expect(application.load()).rejects.toMatchObject({
      code: 'invalid_persisted_record',
    });
    await expect(
      driver.get<{ onboarding_step: string; onboarding_draft_json: string }>(
        `SELECT onboarding_step, onboarding_draft_json FROM profiles;`,
      ),
    ).resolves.toEqual({
      onboarding_step: 'week',
      onboarding_draft_json: JSON.stringify({ invalid: 'synthetic fixture' }),
    });
    expect(await counts(driver)).toMatchObject({
      profiles: 1,
      axes: 0,
      outcomes: 0,
      actions: 0,
      commitments: 0,
    });
    await driver.close();
  });
});

async function counts(driver: NodeSqliteDriver): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of [
    'profiles',
    'axes',
    'outcomes',
    'actions',
    'commitments',
    'time_blocks',
    'planning_placements',
    'focus_selections',
    'week_selections',
    'contexts',
    'constraints',
    'domain_events',
    'command_receipts',
  ]) {
    result[table] =
      (await driver.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table};`))?.count ?? -1;
  }
  return result;
}
